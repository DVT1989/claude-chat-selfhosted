//go:build windows

package main

// Coloured system pointers while someone works remotely: the real Windows arrow, hand and text cursor
// turn blue (operator) or orange (Claude), so there is no second arrow on top of the real one. The user's
// own pointers (including a custom colour or size) are copied first and put back exactly, a few seconds
// after the last remote input. Safety net: a flag file; when it is still there at the next start the
// service reloads the user's pointer scheme (SPI_SETCURSORS in the user's own context).

import (
	"context"
	"math"
	"os"
	"path/filepath"
	"time"
	"unsafe"
)

var (
	pLoadCursorW        = modUser32.NewProc("LoadCursorW")
	pCopyIcon           = modUser32.NewProc("CopyIcon")
	pSetSystemCursor    = modUser32.NewProc("SetSystemCursor")
	pCreateIconIndirect = modUser32.NewProc("CreateIconIndirect")
	pCreateBitmap       = modGdi32.NewProc("CreateBitmap")
)

const (
	ocrNormal = 32512
	ocrIBeam  = 32513
	ocrHand   = 32649
)

func cursorFlag() string { return filepath.Join(configDir(), "cursor-changed") }

type cursorSet struct {
	saved   map[int]uintptr // copies of the user's own cursors
	current string          // "", "blue" or "orange"
}

// grab the user's current cursors once, before the first change
func (c *cursorSet) save() {
	if c.saved != nil {
		return
	}
	c.saved = map[int]uintptr{}
	for _, id := range []int{ocrNormal, ocrIBeam, ocrHand} {
		h, _, _ := pLoadCursorW.Call(0, uintptr(id))
		if h == 0 {
			continue
		}
		if cp, _, _ := pCopyIcon.Call(h); cp != 0 {
			c.saved[id] = cp
		}
	}
}

func (c *cursorSet) set(color string) {
	if color == c.current {
		return
	}
	if color == "" {
		c.restore()
		return
	}
	c.save()
	if len(c.saved) == 0 {
		return
	}
	_ = os.WriteFile(cursorFlag(), []byte("1"), 0o644)
	rgb := [3]byte{0x25, 0x63, 0xEB} // blue #2563EB
	if color == "orange" {
		rgb = [3]byte{0xD9, 0x77, 0x57} // Claude #D97757
	}
	size := sysMetric(13) // SM_CXCURSOR: follows the user's pointer size and DPI
	if size < 32 {
		size = 32
	}
	for _, id := range []int{ocrNormal, ocrIBeam, ocrHand} {
		if _, ok := c.saved[id]; !ok {
			continue
		}
		if h := makeCursor(id, size, rgb); h != 0 {
			pSetSystemCursor.Call(h, uintptr(id)) // takes ownership of h
		}
	}
	c.current = color
}

func (c *cursorSet) restore() {
	if c.current == "" {
		return
	}
	for id, h := range c.saved {
		if cp, _, _ := pCopyIcon.Call(h); cp != 0 {
			pSetSystemCursor.Call(cp, uintptr(id))
		}
	}
	c.current = ""
	_ = os.Remove(cursorFlag())
}

// ── drawing ─────────────────────────────────────────────────

type pt struct{ x, y float64 }

// shapes on a 32x32 grid, with their hot spot
var shapes = map[int]struct {
	poly [][]pt
	hot  pt
}{
	ocrNormal: {[][]pt{{{1, 1}, {1, 24}, {6.5, 19}, {10.5, 28}, {13.5, 26.7}, {9.6, 18}, {16.8, 18}}}, pt{1, 1}},
	ocrHand: {[][]pt{{{11, 3.5}, {13, 1.5}, {15, 3.5}, {15, 12}, {17, 11}, {19, 12.2}, {20.5, 11.6}, {22.5, 12.8}, {24, 12.6}, {26, 14.2},
		{26, 22.5}, {23.5, 29}, {13.5, 29}, {6, 20.5}, {6.2, 18.2}, {8.4, 17.4}, {11, 19.5}}}, pt{13, 1.5}},
	ocrIBeam: {[][]pt{{{9, 2}, {19, 2}, {19, 4.2}, {15.2, 4.2}, {15.2, 25.8}, {19, 25.8}, {19, 28}, {9, 28}, {9, 25.8}, {12.8, 25.8}, {12.8, 4.2}, {9, 4.2}}}, pt{14, 15}},
}

func inside(poly []pt, x, y float64) bool {
	in := false
	for i, j := 0, len(poly)-1; i < len(poly); j, i = i, i+1 {
		a, b := poly[i], poly[j]
		if (a.y > y) != (b.y > y) && x < (b.x-a.x)*(y-a.y)/(b.y-a.y)+a.x {
			in = !in
		}
	}
	return in
}

// makeCursor renders a filled shape with a white rim and a soft dark edge (4x supersampled).
func makeCursor(id, size int, rgb [3]byte) uintptr {
	sh := shapes[id]
	const ss = 4
	n := size * ss
	k := float64(size) / 32
	fill := make([]bool, n*n)
	for y := 0; y < n; y++ {
		for x := 0; x < n; x++ {
			fx, fy := (float64(x)+0.5)/ss/k, (float64(y)+0.5)/ss/k
			for _, p := range sh.poly {
				if inside(p, fx, fy) {
					fill[y*n+x] = true
					break
				}
			}
		}
	}
	// distance (in hi-res pixels) to the nearest filled sample, for the rim
	rimW := 1.6 * k * ss
	edgeW := rimW + 1.0*k*ss
	r := int(math.Ceil(edgeW))
	dist := make([]float64, n*n)
	for i := range dist {
		dist[i] = math.Inf(1)
	}
	for y := 0; y < n; y++ {
		for x := 0; x < n; x++ {
			if !fill[y*n+x] {
				continue
			}
			for dy := -r; dy <= r; dy++ {
				yy := y + dy
				if yy < 0 || yy >= n {
					continue
				}
				for dx := -r; dx <= r; dx++ {
					xx := x + dx
					if xx < 0 || xx >= n {
						continue
					}
					d := math.Hypot(float64(dx), float64(dy))
					if d < dist[yy*n+xx] {
						dist[yy*n+xx] = d
					}
				}
			}
		}
	}
	// downsample to straight-alpha BGRA
	pix := make([]byte, size*size*4)
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			var cr, cg, cb, ca float64
			for sy := 0; sy < ss; sy++ {
				for sx := 0; sx < ss; sx++ {
					i := (y*ss+sy)*n + x*ss + sx
					switch {
					case fill[i]:
						cr += float64(rgb[0])
						cg += float64(rgb[1])
						cb += float64(rgb[2])
						ca += 255
					case dist[i] <= rimW:
						cr += 255
						cg += 255
						cb += 255
						ca += 255
					case dist[i] <= edgeW:
						ca += 90 // soft dark edge, readable on white
					}
				}
			}
			cnt := float64(ss * ss)
			a := ca / cnt
			o := (y*size + x) * 4
			if a > 0 {
				// colour channels: average over the covered samples only
				cov := ca / 255
				pix[o+2], pix[o+1], pix[o] = byte(cr/math.Max(cov, 1e-6)), byte(cg/math.Max(cov, 1e-6)), byte(cb/math.Max(cov, 1e-6))
			}
			pix[o+3] = byte(a)
		}
	}
	bi := bitmapInfoHeader{Size: 40, Width: int32(size), Height: -int32(size), Planes: 1, BitCount: 32}
	var bits unsafe.Pointer
	color, _, _ := pCreateDIBSection.Call(0, uintptr(unsafe.Pointer(&bi)), 0, uintptr(unsafe.Pointer(&bits)), 0, 0)
	if color == 0 || bits == nil {
		return 0
	}
	copy(unsafe.Slice((*byte)(bits), len(pix)), pix)
	mask, _, _ := pCreateBitmap.Call(uintptr(size), uintptr(size), 1, 1, 0)
	ii := struct {
		Icon        int32
		HotX, HotY  uint32
		Mask, Color uintptr
	}{Icon: 0, HotX: uint32(sh.hot.x * k), HotY: uint32(sh.hot.y * k), Mask: mask, Color: color}
	h, _, _ := pCreateIconIndirect.Call(uintptr(unsafe.Pointer(&ii)))
	pDeleteObject.Call(color)
	pDeleteObject.Call(mask)
	return h
}

// resetUserCursors reloads the signed-in user's pointer scheme when a session ended without restoring.
func resetUserCursors() {
	if _, err := os.Stat(cursorFlag()); err != nil {
		return
	}
	const script = `Add-Type -Namespace CC -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint a, uint b, System.IntPtr c, uint d);'; [void][CC.U]::SystemParametersInfo(0x57, 0, [System.IntPtr]::Zero, 0)`
	if _, code, err := runCommand(context.Background(), "powershell", script, 30*time.Second, true, false); err == nil && code == 0 {
		_ = os.Remove(cursorFlag())
	}
}
