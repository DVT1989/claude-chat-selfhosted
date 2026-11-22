//go:build windows

package main

// On-screen name label: while someone works remotely, the real Windows pointer is coloured
// (cursor_windows.go) and a small pill with the name sits beside it ("Sam" blue, "Claude" orange).
// Pills are drawn with per-pixel alpha (UpdateLayeredWindow): soft rounded edges, a faint rim and
// anti-aliased text, in the style of the app. Click-through, top-most, excluded from screen capture.

import (
	"math"
	"runtime"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	pRegisterClassExW         = modUser32.NewProc("RegisterClassExW")
	pCreateWindowExW          = modUser32.NewProc("CreateWindowExW")
	pDestroyWindow            = modUser32.NewProc("DestroyWindow")
	pDefWindowProcW           = modUser32.NewProc("DefWindowProcW")
	pGetMessageW              = modUser32.NewProc("GetMessageW")
	pTranslateMessage         = modUser32.NewProc("TranslateMessage")
	pDispatchMessageW         = modUser32.NewProc("DispatchMessageW")
	pPostMessageW             = modUser32.NewProc("PostMessageW")
	pPostQuitMessage          = modUser32.NewProc("PostQuitMessage")
	pShowWindow               = modUser32.NewProc("ShowWindow")
	pUpdateLayeredWindow      = modUser32.NewProc("UpdateLayeredWindow")
	pFillRect                 = modUser32.NewProc("FillRect")
	pSetTimer                 = modUser32.NewProc("SetTimer")
	pKillTimer                = modUser32.NewProc("KillTimer")
	pGetDpiForSystem          = modUser32.NewProc("GetDpiForSystem")
	pSetWindowDisplayAffinity = modUser32.NewProc("SetWindowDisplayAffinity")
	pOpenDesktopW             = modUser32.NewProc("OpenDesktopW")
	pCreateSolidBrush         = modGdi32.NewProc("CreateSolidBrush")
	pSetBkMode                = modGdi32.NewProc("SetBkMode")
	pSetTextColor             = modGdi32.NewProc("SetTextColor")
	pCreateFontW              = modGdi32.NewProc("CreateFontW")
	pTextOutW                 = modGdi32.NewProc("TextOutW")
	pGetTextExtentPoint32W    = modGdi32.NewProc("GetTextExtentPoint32W")
)

const (
	wmDestroy, wmClose, wmTimer, wmApp = 0x0002, 0x0010, 0x0113, 0x8000
	colorWhite                         = 0x00FFFFFF
)

var (
	rgbUser   = [3]byte{0x25, 0x63, 0xEB} // #2563EB
	rgbClaude = [3]byte{0xD9, 0x77, 0x57} // #D97757
)

// ── pill renderer (shared with the banner) ──────────────────

type pillImg struct {
	dc, bmp, old uintptr
	w, h         int
}

func (p *pillImg) free() {
	if p == nil || p.dc == 0 {
		return
	}
	pSelectObject.Call(p.dc, p.old)
	pDeleteObject.Call(p.bmp)
	pDeleteDC.Call(p.dc)
	p.dc = 0
}

var fontCache = map[int]uintptr{}

// font: Segoe UI Variable (Windows 11) or Segoe UI, semibold, with ClearType-quality smoothing
func pillFont(height int) uintptr {
	if f, ok := fontCache[height]; ok {
		return f
	}
	faces := []string{"Segoe UI Variable Text", "Segoe UI"}
	if loadInter() {
		faces = append([]string{"Inter SemiBold", "Inter"}, faces...)
	}
	var f uintptr
	for _, face := range faces {
		fp, _ := windows.UTF16PtrFromString(face)
		f, _, _ = pCreateFontW.Call(uintptr(int32(-height)), 0, 0, 0, 600, 0, 0, 0, 1, 0, 0, 5, 0, uintptr(unsafe.Pointer(fp)))
		if f != 0 && fontIs(f, face) {
			break
		}
	}
	fontCache[height] = f
	return f
}

// renderPill draws a fully rounded pill: background colour bg (alpha bgA), a faint light rim,
// optional dot on the left, white text. Returns a memory DC holding premultiplied BGRA.
func renderPill(text string, scale float64, fontPx, padX, height int, bg [3]byte, bgA float64, dot *[3]byte) *pillImg {
	return renderPillEx(text, scale, fontPx, padX, height, bg, bgA, dot, 0, 1)
}

// renderPillEx: width > 0 forces the pill width (content stays centred, clipped at the edges);
// content (0..1) fades the text and the dot, for the Dynamic-Island-style unfolding.
func renderPillEx(text string, scale float64, fontPx, padX, height int, bg [3]byte, bgA float64, dot *[3]byte, width int, content float64) *pillImg {
	px := func(v float64) int { return int(math.Round(v * scale)) }
	font := pillFont(px(float64(fontPx)))
	sdc, _, _ := pGetDC.Call(0)
	dc, _, _ := pCreateCompatibleDC.Call(sdc)
	pReleaseDC.Call(0, sdc)
	pSelectObject.Call(dc, font)
	u, _ := windows.UTF16FromString(text)
	var sz struct{ CX, CY int32 }
	pGetTextExtentPoint32W.Call(dc, uintptr(unsafe.Pointer(&u[0])), uintptr(len(u)-1), uintptr(unsafe.Pointer(&sz)))
	h := px(float64(height))
	pad := px(float64(padX))
	dotD, gap := 0, 0
	if dot != nil {
		dotD, gap = px(8), px(7)
	}
	w := pad + dotD + gap + int(sz.CX) + pad
	off := 0
	if width > 0 {
		off = (width - w) / 2
		w = width
	}
	bi := bitmapInfoHeader{Size: 40, Width: int32(w), Height: -int32(h), Planes: 1, BitCount: 32}
	var bits unsafe.Pointer
	bmp, _, _ := pCreateDIBSection.Call(dc, uintptr(unsafe.Pointer(&bi)), 0, uintptr(unsafe.Pointer(&bits)), 0, 0)
	if bmp == 0 {
		pDeleteDC.Call(dc)
		return nil
	}
	old, _, _ := pSelectObject.Call(dc, bmp)
	// text first, anti-aliased against the opaque background colour
	brush, _, _ := pCreateSolidBrush.Call(uintptr(bg[0]) | uintptr(bg[1])<<8 | uintptr(bg[2])<<16)
	rc := [4]int32{0, 0, int32(w), int32(h)}
	pFillRect.Call(dc, uintptr(unsafe.Pointer(&rc)), brush)
	pDeleteObject.Call(brush)
	pSetBkMode.Call(dc, 1)
	pSetTextColor.Call(dc, colorWhite)
	if content > 0 {
		pTextOutW.Call(dc, uintptr(int32(pad+dotD+gap+off)), uintptr((h-int(sz.CY))/2), uintptr(unsafe.Pointer(&u[0])), uintptr(len(u)-1))
	}
	pGdiFlush.Call()
	pix := unsafe.Slice((*byte)(bits), w*h*4)
	// shape: rounded rect (radius h/2), 4x4 supersampled; rim = 1 px band inside the edge
	r := float64(h) / 2
	rim := math.Max(1, scale)
	dcx, dcy, dr := float64(pad+off)+float64(dotD)/2, float64(h)/2, float64(dotD)/2
	const ss = 4
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			var cov, rimCov, dotCov float64
			for sy := 0; sy < ss; sy++ {
				for sx := 0; sx < ss; sx++ {
					fx := float64(x) + (float64(sx)+0.5)/ss
					fy := float64(y) + (float64(sy)+0.5)/ss
					cx := math.Max(r, math.Min(float64(w)-r, fx))
					d := r - math.Hypot(fx-cx, fy-r) // distance inside the edge
					if d >= 0 {
						cov++
						if d < rim {
							rimCov++
						}
					}
					if dot != nil && math.Hypot(fx-dcx, fy-dcy) <= dr {
						dotCov++
					}
				}
			}
			o := (y*w + x) * 4
			if cov == 0 {
				pix[o], pix[o+1], pix[o+2], pix[o+3] = 0, 0, 0, 0
				continue
			}
			n := float64(ss * ss)
			b, g, rr := float64(pix[o]), float64(pix[o+1]), float64(pix[o+2])
			if content < 1 { // text fades in: mix towards the plain background
				b = float64(bg[2]) + (b-float64(bg[2]))*content
				g = float64(bg[1]) + (g-float64(bg[1]))*content
				rr = float64(bg[0]) + (rr-float64(bg[0]))*content
			}
			if rimCov > 0 { // faint light rim, like the cards in the app
				t := 0.16 * rimCov / cov
				b, g, rr = b+(255-b)*t, g+(255-g)*t, rr+(255-rr)*t
			}
			if dotCov > 0 {
				t := dotCov / n * content
				b, g, rr = b+(float64(dot[2])-b)*t, g+(float64(dot[1])-g)*t, rr+(float64(dot[0])-rr)*t
			}
			a := cov / n * bgA
			pix[o] = byte(b * a)
			pix[o+1] = byte(g * a)
			pix[o+2] = byte(rr * a)
			pix[o+3] = byte(255 * a)
		}
	}
	return &pillImg{dc: dc, bmp: bmp, old: old, w: w, h: h}
}

// place shows img at screen position x,y with overall opacity alpha (0..255)
func placePill(hwnd uintptr, img *pillImg, x, y int, alpha byte) {
	if img == nil {
		return
	}
	pt := struct{ X, Y int32 }{int32(x), int32(y)}
	size := struct{ CX, CY int32 }{int32(img.w), int32(img.h)}
	src := struct{ X, Y int32 }{0, 0}
	blend := uint32(0) | uint32(0)<<8 | uint32(alpha)<<16 | uint32(1)<<24 // AC_SRC_OVER, AC_SRC_ALPHA
	pUpdateLayeredWindow.Call(hwnd, 0, uintptr(unsafe.Pointer(&pt)), uintptr(unsafe.Pointer(&size)), img.dc,
		uintptr(unsafe.Pointer(&src)), 0, uintptr(unsafe.Pointer(&blend)), 2)
}

// layeredWindow: a click-through, top-most popup on the Default desktop (call on a locked thread)
// clickable: receives mouse clicks (the hang-up button); exclude: kept out of screen captures.
// Excluded windows flicker on every GDI capture, so the island is not excluded (the operator then
// sees exactly what the person at the PC sees); only the small name label is.
func layeredWindow(class string, proc func(hwnd, msg, wp, lp uintptr) uintptr, clickable, exclude bool) uintptr {
	name, _ := windows.UTF16PtrFromString("Default")
	if h, _, _ := pOpenDesktopW.Call(uintptr(unsafe.Pointer(name)), 0, 0, 0x10000000); h != 0 {
		pSetThreadDesktop.Call(h)
	}
	cls, _ := windows.UTF16PtrFromString(class)
	wc := struct {
		Size, Style                        uint32
		WndProc                            uintptr
		ClsExtra, WndExtra                 int32
		Instance, Icon, Cursor, Background uintptr
		MenuName, ClassName                *uint16
		IconSm                             uintptr
	}{WndProc: windows.NewCallback(proc), ClassName: cls}
	wc.Size = uint32(unsafe.Sizeof(wc))
	pRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))
	exStyle := uintptr(0x00080000 | 0x00000008 | 0x00000080 | 0x08000000) // layered, topmost, toolwindow, noactivate
	if !clickable {
		exStyle |= 0x00000020 // transparent: clicks go through
	}
	const wsPopup = 0x80000000
	hwnd, _, _ := pCreateWindowExW.Call(exStyle, uintptr(unsafe.Pointer(cls)), uintptr(unsafe.Pointer(cls)), wsPopup, 0, 0, 1, 1, 0, 0, 0, 0)
	if hwnd != 0 && exclude {
		pSetWindowDisplayAffinity.Call(hwnd, 0x11) // WDA_EXCLUDEFROMCAPTURE
	}
	return hwnd
}

func pumpMessages() {
	var msg struct {
		Hwnd    uintptr
		Message uint32
		WParam  uintptr
		LParam  uintptr
		Time    uint32
		Pt      [2]int32
		Private uint32
	}
	for {
		r, _, _ := pGetMessageW.Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0)
		if int32(r) <= 0 {
			return
		}
		pTranslateMessage.Call(uintptr(unsafe.Pointer(&msg)))
		pDispatchMessageW.Call(uintptr(unsafe.Pointer(&msg)))
	}
}

// ── name label beside the pointer ───────────────────────────

type nameCursor struct {
	mu      sync.Mutex
	hwnd    uintptr
	x, y    int // normalized 0..65535
	claude  bool
	name    string
	last    time.Time
	pending bool
	done    chan struct{}
	// UI thread only
	scale   float64
	img     *pillImg
	shown   string
	shownCl bool
	alpha   int
	visible bool
	cur     cursorSet
	lastPos [2]int
}

func startOverlay() *nameCursor {
	n := &nameCursor{name: "Beheerder", scale: 1, done: make(chan struct{})}
	ready := make(chan struct{}, 1)
	go n.loop(ready)
	select {
	case <-ready:
	case <-time.After(3 * time.Second):
	}
	return n
}

func (n *nameCursor) setName(name string) {
	if name == "" {
		return
	}
	n.mu.Lock()
	n.name = name
	n.mu.Unlock()
}

// show: the remote mouse is at x,y (0..65535 over the virtual screen).
func (n *nameCursor) show(x, y int, claude bool) {
	n.mu.Lock()
	n.x, n.y, n.claude, n.last = x, y, claude, time.Now()
	h := n.hwnd
	post := !n.pending
	n.pending = true
	n.mu.Unlock()
	if h != 0 && post {
		pPostMessageW.Call(h, wmApp, 0, 0)
	}
}

// close restores the user's pointers and waits until that is done (the process exits right after).
func (n *nameCursor) close() {
	n.mu.Lock()
	h := n.hwnd
	n.mu.Unlock()
	if h == 0 {
		return
	}
	pPostMessageW.Call(h, wmClose, 0, 0)
	select {
	case <-n.done:
	case <-time.After(3 * time.Second):
	}
}

func (n *nameCursor) wndProc(hwnd, msg, wp, lp uintptr) uintptr {
	switch msg {
	case wmApp:
		n.mu.Lock()
		x, y, claude, name := n.x, n.y, n.claude, n.name
		n.pending = false
		n.mu.Unlock()
		color := rgbUser
		text := name
		if claude {
			color, text = rgbClaude, "Claude"
			n.cur.set("orange")
		} else {
			n.cur.set("blue")
		}
		if n.img == nil || text != n.shown || claude != n.shownCl {
			n.img.free()
			n.img = renderPill(text, n.scale, 12, 9, 22, color, 1, nil)
			n.shown, n.shownCl = text, claude
		}
		cs := sysMetric(13)
		if cs < 32 {
			cs = 32
		}
		vx, vy, vw, vh := sysMetric(76), sysMetric(77), sysMetric(78), sysMetric(79)
		sx, sy := vx+x*vw/65535+cs*55/100, vy+y*vh/65535+cs*70/100
		if !n.visible || n.alpha != 255 || n.lastPos != [2]int{sx, sy} {
			n.alpha = 255
			placePill(hwnd, n.img, sx, sy, 255)
			if !n.visible {
				pShowWindow.Call(hwnd, 4) // SW_SHOWNOACTIVATE
				n.visible = true
			}
			n.lastPos = [2]int{sx, sy}
		}
		pSetTimer.Call(hwnd, 1, 40, 0)
		return 0
	case wmTimer:
		n.mu.Lock()
		idle := time.Since(n.last)
		n.mu.Unlock()
		if idle < 2500*time.Millisecond {
			return 0
		}
		if idle >= 3*time.Second {
			n.cur.restore() // the user's own pointers come back
		}
		if n.alpha > 0 {
			n.alpha -= 25
			if n.alpha <= 0 {
				n.alpha = 0
				pShowWindow.Call(hwnd, 0)
				n.visible = false
			} else {
				placePill(hwnd, n.img, n.lastPos[0], n.lastPos[1], byte(n.alpha))
			}
		}
		if n.alpha == 0 && n.cur.current == "" {
			pKillTimer.Call(hwnd, 1)
		}
		return 0
	case wmClose:
		n.cur.restore()
		pDestroyWindow.Call(hwnd)
		return 0
	case wmDestroy:
		n.cur.restore()
		pPostQuitMessage.Call(0)
		return 0
	}
	r, _, _ := pDefWindowProcW.Call(hwnd, msg, wp, lp)
	return r
}

func (n *nameCursor) loop(ready chan struct{}) {
	runtime.LockOSThread()
	defer close(n.done)
	if r, _, _ := pGetDpiForSystem.Call(); r >= 96 {
		n.scale = float64(r) / 96
	}
	hwnd := layeredWindow("ClaudeAgentNameCursor", n.wndProc, false, true)
	if hwnd == 0 {
		ready <- struct{}{}
		return
	}
	n.mu.Lock()
	n.hwnd = hwnd
	n.mu.Unlock()
	ready <- struct{}{}
	pumpMessages()
	n.cur.restore()
	n.img.free()
	n.mu.Lock()
	n.hwnd = 0
	n.mu.Unlock()
}

var pGetTextFaceW = modGdi32.NewProc("GetTextFaceW")

// fontIs: GDI always returns some font; check it is really the one asked for
func fontIs(f uintptr, face string) bool {
	sdc, _, _ := pGetDC.Call(0)
	dc, _, _ := pCreateCompatibleDC.Call(sdc)
	pReleaseDC.Call(0, sdc)
	defer pDeleteDC.Call(dc)
	pSelectObject.Call(dc, f)
	buf := make([]uint16, 64)
	pGetTextFaceW.Call(dc, 64, uintptr(unsafe.Pointer(&buf[0])))
	return windows.UTF16ToString(buf) == face
}

// placePillHere: new content at the window's current position (so a drag in progress is not undone)
func placePillHere(hwnd uintptr, img *pillImg, alpha byte) {
	if img == nil {
		return
	}
	size := struct{ CX, CY int32 }{int32(img.w), int32(img.h)}
	src := struct{ X, Y int32 }{0, 0}
	blend := uint32(alpha)<<16 | uint32(1)<<24
	pUpdateLayeredWindow.Call(hwnd, 0, 0, uintptr(unsafe.Pointer(&size)), img.dc,
		uintptr(unsafe.Pointer(&src)), 0, uintptr(unsafe.Pointer(&blend)), 2)
}
