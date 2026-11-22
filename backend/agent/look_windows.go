//go:build windows

package main

// Look of the on-screen pills: the Inter font (closest free match to Apple's SF Pro, SIL OFL, shipped
// with the agent), the operator's avatar or initials, and Claude's mark, drawn from the same SVG path
// the app uses.

import (
	"bytes"
	_ "embed"
	"image"
	"image/color"
	"image/draw"
	_ "image/jpeg"
	_ "image/png"
	"math"
	"strconv"
	"strings"
	"sync"
	"unsafe"
)

//go:embed fonts/Inter-SemiBold.ttf
var interTTF []byte

var (
	pAddFontMemResourceEx = modGdi32.NewProc("AddFontMemResourceEx")
	interOnce             sync.Once
	interOK               bool
)

// loadInter registers the embedded font for this process only (no install on the PC).
func loadInter() bool {
	interOnce.Do(func() {
		var n uint32
		h, _, _ := pAddFontMemResourceEx.Call(uintptr(unsafe.Pointer(&interTTF[0])), uintptr(len(interTTF)), 0, uintptr(unsafe.Pointer(&n)))
		interOK = h != 0
	})
	return interOK
}

// decodeAvatar turns the operator's photo into a square RGBA image of size d (centre crop).
func decodeAvatar(data []byte, d int) *image.RGBA {
	src, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil
	}
	b := src.Bounds()
	side := b.Dx()
	if b.Dy() < side {
		side = b.Dy()
	}
	x0, y0 := b.Min.X+(b.Dx()-side)/2, b.Min.Y+(b.Dy()-side)/2
	out := image.NewRGBA(image.Rect(0, 0, d, d))
	// box filter down to d x d
	for y := 0; y < d; y++ {
		for x := 0; x < d; x++ {
			sx0, sx1 := x0+x*side/d, x0+(x+1)*side/d
			sy0, sy1 := y0+y*side/d, y0+(y+1)*side/d
			if sx1 <= sx0 {
				sx1 = sx0 + 1
			}
			if sy1 <= sy0 {
				sy1 = sy0 + 1
			}
			var r, g, bl, n uint32
			for yy := sy0; yy < sy1; yy++ {
				for xx := sx0; xx < sx1; xx++ {
					cr, cg, cb, _ := src.At(xx, yy).RGBA()
					r, g, bl, n = r+cr>>8, g+cg>>8, bl+cb>>8, n+1
				}
			}
			out.Set(x, y, color.RGBA{uint8(r / n), uint8(g / n), uint8(bl / n), 255})
		}
	}
	return out
}


var (
	claudePolyOnce sync.Once
	claudePolys    [][]pt
)

// parsePath flattens an SVG path (absolute M, L, H, V, C, Z) into polygons.
func parsePath(d string) [][]pt {
	var tokens []string
	cur := strings.Builder{}
	flush := func() {
		if cur.Len() > 0 {
			tokens = append(tokens, cur.String())
			cur.Reset()
		}
	}
	for _, r := range d {
		switch {
		case strings.ContainsRune("MLHVCZ", r):
			flush()
			tokens = append(tokens, string(r))
		case r == ' ' || r == ',':
			flush()
		case r == '-' && cur.Len() > 0:
			flush()
			cur.WriteRune(r)
		default:
			cur.WriteRune(r)
		}
	}
	flush()
	var polys [][]pt
	var poly []pt
	var x, y float64
	cmd := ""
	i := 0
	num := func() float64 { v, _ := strconv.ParseFloat(tokens[i], 64); i++; return v }
	for i < len(tokens) {
		t := tokens[i]
		if len(t) == 1 && strings.Contains("MLHVCZ", t) {
			cmd = t
			i++
			if cmd == "Z" {
				if len(poly) > 2 {
					polys = append(polys, poly)
				}
				poly = nil
				continue
			}
		}
		switch cmd {
		case "M":
			if len(poly) > 2 {
				polys = append(polys, poly)
			}
			x, y = num(), num()
			poly = []pt{{x, y}}
			cmd = "L"
		case "L":
			x, y = num(), num()
			poly = append(poly, pt{x, y})
		case "H":
			x = num()
			poly = append(poly, pt{x, y})
		case "V":
			y = num()
			poly = append(poly, pt{x, y})
		case "C":
			x1, y1, x2, y2, x3, y3 := num(), num(), num(), num(), num(), num()
			for s := 1; s <= 8; s++ {
				t := float64(s) / 8
				u := 1 - t
				px := u*u*u*x + 3*u*u*t*x1 + 3*u*t*t*x2 + t*t*t*x3
				py := u*u*u*y + 3*u*u*t*y1 + 3*u*t*t*y2 + t*t*t*y3
				poly = append(poly, pt{px, py})
			}
			x, y = x3, y3
		default:
			i++
		}
	}
	if len(poly) > 2 {
		polys = append(polys, poly)
	}
	return polys
}

// claudeMark: Claude's coral starburst on a dark round tile (like the app's splash), size d.
func claudeMark(d int) *image.RGBA {
	claudePolyOnce.Do(func() { claudePolys = parsePath(claudePath) })
	out := image.NewRGBA(image.Rect(0, 0, d, d))
	draw.Draw(out, out.Bounds(), &image.Uniform{color.RGBA{0x2a, 0x23, 0x38, 255}}, image.Point{}, draw.Src)
	const ss = 3
	inset := float64(d) * 0.18
	k := (float64(d) - 2*inset) / 248
	for y := 0; y < d; y++ {
		for x := 0; x < d; x++ {
			cov := 0
			for sy := 0; sy < ss; sy++ {
				for sx := 0; sx < ss; sx++ {
					fx := ((float64(x) + (float64(sx)+0.5)/ss) - inset) / k
					fy := ((float64(y) + (float64(sy)+0.5)/ss) - inset) / k
					for _, p := range claudePolys {
						if inside(p, fx, fy) {
							cov++
							break
						}
					}
				}
			}
			if cov > 0 {
				t := float64(cov) / (ss * ss)
				bg := out.RGBAAt(x, y)
				mix := func(a, b uint8) uint8 { return uint8(float64(a) + (float64(b)-float64(a))*t) }
				out.SetRGBA(x, y, color.RGBA{mix(bg.R, 0xD9), mix(bg.G, 0x77), mix(bg.B, 0x57), 255})
			}
		}
	}
	return out
}

// initialsImage: initials in white on the accent colour, size d (text drawn by GDI later).
func initialsOf(name string) string {
	f := strings.Fields(name)
	if len(f) == 0 {
		return "?"
	}
	s := strings.ToUpper(string([]rune(f[0])[:1]))
	if len(f) > 1 {
		s += strings.ToUpper(string([]rune(f[len(f)-1])[:1]))
	}
	return s
}

func parseHex(h string) ([3]byte, bool) {
	h = strings.TrimPrefix(h, "#")
	if len(h) != 6 {
		return [3]byte{}, false
	}
	v, err := strconv.ParseUint(h, 16, 32)
	if err != nil {
		return [3]byte{}, false
	}
	return [3]byte{byte(v >> 16), byte(v >> 8), byte(v)}, true
}

var _ = math.Pi
