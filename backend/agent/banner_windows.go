//go:build windows

package main

// "Sam kijkt mee" as a Dynamic Island at the top of the main screen for the whole remote session:
// the operator's photo (or initials) on the left, "kijkt mee" small with a breathing green dot and the
// name large, a red hang-up button on the right that ends the session from the PC. It drops in from
// the top as a small circle and unfolds with a spring, morphs when Claude takes over ("Claude",
// "werkt mee"), folds away at the end. It can be dragged aside and stays there for the session.
// It is not excluded from screen capture (excluded windows flicker on every capture), so the
// operator sees exactly what the person at the PC sees.

import (
	"image"
	"log"
	"math"
	"runtime"
	"strings"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	wmBanner        = 0x8001
	wmMouseMove     = 0x0200
	wmLButtonUp     = 0x0202
	wmMouseLeave    = 0x02A3
	wmNcHitTest     = 0x0084
	wmSetCursor     = 0x0020
	wmMouseActivate = 0x0021
	wmExitSizeMove  = 0x0232
)

var (
	rgbDotUser = [3]byte{0x30, 0xD1, 0x58} // Apple green
	rgbHangup  = [3]byte{0xFF, 0x45, 0x3A} // Apple red
	rgbHangHov = [3]byte{0xFF, 0x69, 0x61}

	pTrackMouseEvent = modUser32.NewProc("TrackMouseEvent")
	pSetWindowPosB   = modUser32.NewProc("SetWindowPos")
	pSetWindowRgn    = modUser32.NewProc("SetWindowRgn")
	pUpdateWindow    = modUser32.NewProc("UpdateWindow")
	pInvalidateRectB = modUser32.NewProc("InvalidateRect")
	pBeginPaintB     = modUser32.NewProc("BeginPaint")
	pEndPaintB       = modUser32.NewProc("EndPaint")
	pRoundRectRgn    = modGdi32.NewProc("CreateRoundRectRgn")
	pSetCursor       = modUser32.NewProc("SetCursor")
	pGetWindowRect   = modUser32.NewProc("GetWindowRect")
	pGetCursorPosB   = modUser32.NewProc("GetCursorPos")
)

// sizes in px at 100 % (scaled by DPI)
const (
	islandH    = 64
	islandHC   = 40 // compact height
	islandTop  = 10
	islandIn   = 10 // inset of the avatar and the button
	islandAv   = 44
	islandGap  = 12
	islandMinW = 300
)

type banner struct {
	mu       sync.Mutex
	hwnd     uintptr
	on       bool
	name     string
	claudeAt time.Time
	done     chan struct{}
	accent   [3]byte
	initials string
	avatar   []byte
	onHangup func()
	// UI thread only
	scale       float64
	img         *pillImg
	shownText   string
	shownOn     bool
	curW        int
	anim        bannerAnim
	closing     bool
	avImg       *image.RGBA
	claudeAv    *image.RGBA
	pulseT0     time.Time
	hoverBtn    bool      // mouse over the red button
	hover       bool      // mouse over the island: it opens
	leaveAt     time.Time // when the mouse left (it closes a moment later)
	expandUntil time.Time // briefly open after it appears or changes, like Apple's island
	compact     bool      // shown small: photo and dot only
	curH        int
	tracking    bool
	btn         [4]int // hang-up button in window coordinates
	cx, top     int    // where the island sits (centre x, top); dragging moves it
	placed      bool
	dotRect     [4]int32 // the breathing dot, the only part repainted between animations
	rgnW        int      // size the rounded window region was made for
	rgnH        int
}

type bannerAnim struct {
	kind       string // "in", "out", "size" or "" (idle)
	start      time.Time
	fromW, toW int
	fromH, toH int
	compact    bool // layout at the end of the animation
	text       string
}

func startBanner() *banner {
	b := &banner{scale: 1, name: "Beheerder", done: make(chan struct{})}
	ready := make(chan struct{}, 1)
	go b.loop(ready)
	select {
	case <-ready:
	case <-time.After(3 * time.Second):
	}
	return b
}

func (b *banner) post() {
	b.mu.Lock()
	h := b.hwnd
	b.mu.Unlock()
	if h != 0 {
		pPostMessageW.Call(h, wmBanner, 0, 0)
	}
}

// set: notice on or off and the operator's name (from every control reply of the server)
func (b *banner) set(on bool, name string) {
	b.mu.Lock()
	changed := b.on != on || (name != "" && name != b.name)
	b.on = on
	if name != "" {
		b.name = name
	}
	b.mu.Unlock()
	if changed {
		b.post()
	}
}

// look: accent colour and initials of the operator, and the photo when there is one
func (b *banner) look(accent, initials string, avatar []byte) {
	b.mu.Lock()
	if c, ok := parseHex(accent); ok {
		b.accent = c
	}
	if initials != "" {
		b.initials = initials
	}
	if avatar != nil {
		b.avatar = avatar
		b.avImg = nil
	}
	b.mu.Unlock()
}

// hangup: called (once) when the person at the PC clicks the red button
func (b *banner) setHangup(f func()) {
	b.mu.Lock()
	b.onHangup = f
	b.mu.Unlock()
}

// claude: Claude acted just now; the island says so for a few seconds
func (b *banner) claude() {
	b.mu.Lock()
	was := time.Since(b.claudeAt) < 4*time.Second
	b.claudeAt = time.Now()
	b.mu.Unlock()
	if !was {
		b.post()
	}
}

func (b *banner) close() {
	b.mu.Lock()
	h := b.hwnd
	b.mu.Unlock()
	if h == 0 {
		return
	}
	pPostMessageW.Call(h, wmClose, 0, 0)
	select {
	case <-b.done:
	case <-time.After(3 * time.Second):
	}
}

func spring(t float64) float64 {
	if t >= 1 {
		return 1
	}
	return 1 - math.Exp(-6*t)*math.Cos(9*t)
}

func easeOut(t float64) float64 {
	if t >= 1 {
		return 1
	}
	return 1 - math.Pow(1-t, 3)
}

// target: what the island should show now ("" = hidden). Key: "user:<name>" or "claude".
func (b *banner) target() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	if !b.on {
		return ""
	}
	if time.Since(b.claudeAt) < 4*time.Second {
		return "claude"
	}
	return "user:" + b.name
}

func (b *banner) px(v float64) int { return int(math.Round(v * b.scale)) }

func (b *banner) natural(text string, compact bool) int {
	img := b.render(text, 0, 0, compact, 1, 1)
	if img == nil {
		return b.px(islandMinW)
	}
	w := img.w
	img.free()
	return w
}

func (b *banner) pos(w int) (int, int) {
	if !b.placed {
		b.cx, b.top = sysMetric(0)/2, b.px(islandTop)
		b.placed = true
	}
	return b.cx - w/2, b.top
}

// checkHover: the mouse left the island (also when it left via the drag area)
func (b *banner) checkHover(hwnd uintptr) {
	if !b.hover {
		return
	}
	var pt [2]int32
	var r [4]int32
	pGetCursorPosB.Call(uintptr(unsafe.Pointer(&pt)))
	pGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&r)))
	if pt[0] < r[0] || pt[0] >= r[2] || pt[1] < r[1] || pt[1] >= r[3] {
		b.hover, b.hoverBtn = false, false
		b.leaveAt = time.Now()
	}
}

// wantCompact: small unless the mouse is on it (or just left), or it briefly opened for a change
func (b *banner) wantCompact() bool {
	now := time.Now()
	return !b.hover && now.After(b.expandUntil) && now.Sub(b.leaveAt) > 500*time.Millisecond
}

func (b *banner) update(hwnd uintptr) {
	text := b.target()
	if b.anim.kind != "" {
		return // the running animation re-checks when it ends
	}
	hFull, hC := b.px(islandH), b.px(islandHC)
	switch {
	case text == "" && b.shownOn:
		b.startAnim(hwnd, bannerAnim{kind: "out", fromW: b.curW, toW: b.curH, fromH: b.curH, toH: b.curH, compact: b.compact, text: b.shownText})
	case text != "" && !b.shownOn:
		// appears open for a few seconds, then folds to the small island
		b.expandUntil = time.Now().Add(3 * time.Second)
		b.startAnim(hwnd, bannerAnim{kind: "in", fromW: hC, toW: b.natural(text, false), fromH: hC, toH: hFull, text: text})
	case text != "" && text != b.shownText:
		// someone else took over: open briefly with the new text
		b.expandUntil = time.Now().Add(2500 * time.Millisecond)
		b.startAnim(hwnd, bannerAnim{kind: "size", fromW: b.curW, toW: b.natural(text, false), fromH: b.curH, toH: hFull, text: text})
	case text != "" && b.wantCompact() != b.compact:
		c := b.wantCompact()
		toH := hFull
		if c {
			toH = hC
		}
		b.startAnim(hwnd, bannerAnim{kind: "size", fromW: b.curW, toW: b.natural(text, c), fromH: b.curH, toH: toH, compact: c, text: text})
	}
}

func (b *banner) startAnim(hwnd uintptr, a bannerAnim) {
	log.Printf("eiland: %s %q compact=%v", a.kind, a.text, a.compact)
	pKillTimer.Call(hwnd, 3)
	a.start = time.Now()
	b.anim = a
	if a.kind == "in" {
		pShowWindow.Call(hwnd, 4)
		b.shownOn = true
	}
	pSetTimer.Call(hwnd, 2, 15, 0)
	b.frame(hwnd)
}

// frame: one animation step. Width springs, height eases; text fades in when opening, out when closing.
func (b *banner) frame(hwnd uintptr) {
	a := b.anim
	dur := map[string]float64{"in": 0.6, "out": 0.34, "size": 0.42}[a.kind]
	t := math.Min(1, time.Since(a.start).Seconds()/dur)
	_, top := b.pos(0)
	w := a.fromW + int(float64(a.toW-a.fromW)*spring(t))
	h := a.fromH + int(float64(a.toH-a.fromH)*easeOut(t))
	y := top
	content := 1.0
	switch a.kind {
	case "in":
		y = -h + int(float64(top+h)*easeOut(math.Min(1, t*1.6)))
		content = math.Max(0, math.Min(1, (t-0.45)/0.4))
	case "out":
		w = a.fromW + int(float64(a.toW-a.fromW)*easeOut(t))
		y = top - int(float64(top+h)*easeOut(math.Max(0, (t-0.35)/0.65)))
		content = math.Max(0, 1-t*2.5)
	default:
		if !a.compact { // opening: text and button come in once there is room
			content = math.Max(0, math.Min(1, (t-0.35)/0.45))
		}
	}
	if w < h {
		w = h
	}
	img := b.render(a.text, w, h, a.compact, content, 1)
	x, _ := b.pos(w)
	b.present(hwnd, img, x, y, true, false)
	b.curW, b.curH = w, h
	if t < 1 {
		return
	}
	pKillTimer.Call(hwnd, 2)
	b.anim = bannerAnim{}
	if a.kind == "out" {
		pShowWindow.Call(hwnd, 0)
		b.shownOn, b.shownText = false, ""
		if b.closing {
			pDestroyWindow.Call(hwnd)
			return
		}
	} else {
		b.shownText, b.compact = a.text, a.compact
		b.pulseT0 = time.Now()
		pSetTimer.Call(hwnd, 3, 60, 0) // only the dot breathes
	}
	b.update(hwnd)
}

// pulse: the dot breathes softly; nothing else moves
func (b *banner) pulse(hwnd uintptr) {
	if !b.shownOn || b.anim.kind != "" {
		pKillTimer.Call(hwnd, 3)
		return
	}
	t := time.Since(b.pulseT0).Seconds()
	a := 0.35 + 0.65*(0.5+0.5*math.Cos(2*math.Pi*t/1.6))
	img := b.render(b.shownText, b.curW, b.curH, b.compact, 1, a)
	b.present(hwnd, img, 0, 0, false, true)
}

// present shows a new picture. A plain top-most window with a rounded region (no layered window:
// re-uploading a layered window made it blink on some PCs). move: new position and size (animations);
// dotOnly: repaint just the dot (the rest of the island is not touched between animations).
func (b *banner) present(hwnd uintptr, img *pillImg, x, y int, move, dotOnly bool) {
	if img == nil {
		return
	}
	old := b.img
	b.img = img
	if move {
		const noZOrder, noActivate, noRedraw = 0x0004, 0x0010, 0x0008
		pSetWindowPosB.Call(hwnd, 0, uintptr(int32(x)), uintptr(int32(y)), uintptr(img.w), uintptr(img.h), noZOrder|noActivate|noRedraw)
		if img.w != b.rgnW || img.h != b.rgnH {
			rgn, _, _ := pRoundRectRgn.Call(0, 0, uintptr(img.w+1), uintptr(img.h+1), uintptr(img.h), uintptr(img.h))
			pSetWindowRgn.Call(hwnd, rgn, 0) // the system owns rgn from here
			b.rgnW, b.rgnH = img.w, img.h
		}
	}
	if dotOnly {
		pInvalidateRectB.Call(hwnd, uintptr(unsafe.Pointer(&b.dotRect)), 0)
	} else {
		pInvalidateRectB.Call(hwnd, 0, 0)
	}
	pUpdateWindow.Call(hwnd)
	old.free()
}

func (b *banner) paint(hwnd uintptr) {
	var ps struct {
		Hdc                uintptr
		Erase              int32
		Rc                 [4]int32
		Restore, IncUpdate int32
		Reserved           [32]byte
	}
	dc, _, _ := pBeginPaintB.Call(hwnd, uintptr(unsafe.Pointer(&ps)))
	if b.img != nil {
		pBitBlt.Call(dc, 0, 0, uintptr(b.img.w), uintptr(b.img.h), b.img.dc, 0, 0, 0x00CC0020)
	}
	pEndPaintB.Call(hwnd, uintptr(unsafe.Pointer(&ps)))
}

func (b *banner) inButton(lp uintptr, screen bool) bool {
	x, y := int(int16(lp&0xFFFF)), int(int16((lp>>16)&0xFFFF))
	if screen {
		var r [4]int32
		pGetWindowRect.Call(b.hwnd, uintptr(unsafe.Pointer(&r)))
		x, y = x-int(r[0]), y-int(r[1])
	}
	return x >= b.btn[0] && x < b.btn[2] && y >= b.btn[1] && y < b.btn[3]
}

func (b *banner) wndProc(hwnd, msg, wp, lp uintptr) uintptr {
	switch msg {
	case wmBanner:
		b.update(hwnd)
		return 0
	case 0x000F: // WM_PAINT
		b.paint(hwnd)
		return 0
	case 0x0014: // WM_ERASEBKGND: the picture covers everything, no flash of background
		return 1
	case wmTimer:
		switch wp {
		case 2:
			b.frame(hwnd)
		case 3:
			b.pulse(hwnd)
		default:
			b.checkHover(hwnd)
			b.update(hwnd)
		}
		return 0
	case 0x00A0: // WM_NCMOUSEMOVE: the island itself is a drag handle, so moves arrive here
		if !b.hover {
			b.hover = true
			b.update(hwnd)
		}
		return 0
	case wmNcHitTest:
		// the red button is a button; the rest of the island is a handle to drag it aside
		if b.inButton(lp, true) {
			return 1 // HTCLIENT
		}
		return 2 // HTCAPTION
	case wmMouseActivate:
		return 3 // MA_NOACTIVATE: never take focus from the user's window
	case wmSetCursor:
		if int(lp&0xFFFF) == 1 { // over the button
			h, _, _ := pLoadCursorW.Call(0, 32649) // hand
			pSetCursor.Call(h)
			return 1
		}
	case wmMouseMove:
		b.hoverBtn = b.inButton(lp, false)
		if !b.hover {
			b.hover = true
			b.update(hwnd)
		}
		if !b.tracking {
			tme := struct {
				Size, Flags uint32
				Hwnd        uintptr
				Hover       uint32
			}{Flags: 2, Hwnd: hwnd} // TME_LEAVE
			tme.Size = uint32(unsafe.Sizeof(tme))
			pTrackMouseEvent.Call(uintptr(unsafe.Pointer(&tme)))
			b.tracking = true
		}
		return 0
	case wmMouseLeave:
		b.hover, b.hoverBtn, b.tracking = false, false, false
		b.leaveAt = time.Now()
		return 0
	case wmLButtonUp:
		if b.inButton(lp, false) {
			b.mu.Lock()
			f := b.onHangup
			b.onHangup = nil
			b.mu.Unlock()
			if f != nil {
				go f()
			}
		}
		return 0
	case wmExitSizeMove:
		// dragged aside: remember where, for the rest of the session
		var r [4]int32
		pGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&r)))
		b.cx, b.top = int(r[0]+r[2])/2, int(r[1])
		return 0
	case wmClose:
		b.closing = true
		if b.shownOn && b.anim.kind != "out" {
			b.anim = bannerAnim{}
			b.startAnim(hwnd, bannerAnim{kind: "out", fromW: b.curW, toW: b.curH, fromH: b.curH, toH: b.curH, compact: b.compact, text: b.shownText})
			return 0
		}
		if b.anim.kind == "" {
			pDestroyWindow.Call(hwnd)
		}
		return 0
	case wmDestroy:
		pPostQuitMessage.Call(0)
		return 0
	}
	r, _, _ := pDefWindowProcW.Call(hwnd, msg, wp, lp)
	return r
}

type circle struct {
	cx, cy, r float64
	img       *image.RGBA // nil: take what GDI drew there
	x0, y0    int
}

// render: the island at width w (0 = natural); content fades photo, text and button; dotA = dot opacity
func (b *banner) render(text string, width, height int, compact bool, content, dotA float64) *pillImg {
	b.mu.Lock()
	accent, initials, avatar := b.accent, b.initials, b.avatar
	b.mu.Unlock()
	if accent == ([3]byte{}) {
		accent = [3]byte{0xCC, 0x78, 0x5C}
	}
	claude := text == "claude"
	name, small, dot := strings.TrimPrefix(text, "user:"), "kijkt mee", rgbDotUser
	if claude {
		name, small, dot = "Claude", "werkt mee", rgbClaude
	}
	h := height
	if h <= 0 {
		h = b.px(islandH)
		if compact {
			h = b.px(islandHC)
		}
	}
	// inset and photo size follow the height, so a growing island grows its photo along
	in := h * islandIn / islandH
	av, gap := h-2*in, b.px(islandGap)
	var avImg *image.RGBA
	if claude {
		if b.claudeAv == nil || b.claudeAv.Rect.Dx() != av {
			b.claudeAv = claudeMark(av)
		}
		avImg = b.claudeAv
	} else if avatar != nil {
		if b.avImg == nil || b.avImg.Rect.Dx() != av {
			b.avImg = decodeAvatar(avatar, av)
		}
		avImg = b.avImg
	}
	bigF, smallF := pillFont(b.px(16)), pillFont(b.px(12))
	sdc, _, _ := pGetDC.Call(0)
	dc, _, _ := pCreateCompatibleDC.Call(sdc)
	pReleaseDC.Call(0, sdc)
	measure := func(f uintptr, s string) (int, int) {
		pSelectObject.Call(dc, f)
		u, _ := windows.UTF16FromString(s)
		var sz struct{ CX, CY int32 }
		pGetTextExtentPoint32W.Call(dc, uintptr(unsafe.Pointer(&u[0])), uintptr(len(u)-1), uintptr(unsafe.Pointer(&sz)))
		return int(sz.CX), int(sz.CY)
	}
	dotD, dotGap := b.px(7), b.px(6)
	bw, bh := measure(bigF, name)
	sw, sh := measure(smallF, small)
	textW := bw
	if sw+dotD+dotGap > textW {
		textW = sw + dotD + dotGap
	}
	natural := in + av + gap + textW + gap*2 + av + in
	if natural < b.px(islandMinW) {
		natural = b.px(islandMinW)
	}
	if compact { // photo left, dot right
		natural = in + av + b.px(14) + dotD + b.px(16)
	}
	w, off := natural, 0
	if width > 0 {
		w, off = width, (width-natural)/2
	}
	base := [3]byte{0x05, 0x04, 0x07}
	bg := [3]byte{}
	for i := range bg {
		bg[i] = byte(float64(base[i])*0.9 + float64(accent[i])*0.1)
	}
	bi := bitmapInfoHeader{Size: 40, Width: int32(w), Height: -int32(h), Planes: 1, BitCount: 32}
	var bits unsafe.Pointer
	bmp, _, _ := pCreateDIBSection.Call(dc, uintptr(unsafe.Pointer(&bi)), 0, uintptr(unsafe.Pointer(&bits)), 0, 0)
	if bmp == 0 {
		pDeleteDC.Call(dc)
		return nil
	}
	old, _, _ := pSelectObject.Call(dc, bmp)
	fill := func(c [3]byte, x0, y0, x1, y1 int) {
		br, _, _ := pCreateSolidBrush.Call(uintptr(c[0]) | uintptr(c[1])<<8 | uintptr(c[2])<<16)
		rc := [4]int32{int32(x0), int32(y0), int32(x1), int32(y1)}
		pFillRect.Call(dc, uintptr(unsafe.Pointer(&rc)), br)
		pDeleteObject.Call(br)
	}
	out := func(f uintptr, s string, x, y int, col uint32) {
		pSelectObject.Call(dc, f)
		pSetTextColor.Call(dc, uintptr(col))
		u, _ := windows.UTF16FromString(s)
		pTextOutW.Call(dc, uintptr(int32(x)), uintptr(int32(y)), uintptr(unsafe.Pointer(&u[0])), uintptr(len(u)-1))
	}
	fill(bg, 0, 0, w, h)
	pSetBkMode.Call(dc, 1)
	// avatar on the left
	axX, axY := in+off, (h-av)/2
	if avImg == nil {
		fill(accent, axX, axY, axX+av, axY+av)
		ini := initials
		if ini == "" {
			ini = "?"
		}
		f := pillFont(b.px(17))
		iw, ih := measure(f, ini)
		out(f, ini, axX+(av-iw)/2, axY+(av-ih)/2, colorWhite)
	}
	// two lines: small grey label with the dot, the name large
	tx := axX + av + gap
	block := sh + b.px(1) + bh
	ty := (h - block) / 2
	bx, by := off+natural-in-av, (h-av)/2
	b.btn = [4]int{}
	if !compact {
		out(smallF, small, tx+dotD+dotGap, ty, 0x009A9AA0)
		out(bigF, name, tx, ty+sh+b.px(1), colorWhite)
		// red hang-up button on the right
		b.btn = [4]int{bx, by, bx + av, by + av}
		btnCol := rgbHangup
		if b.hoverBtn {
			btnCol = rgbHangHov
		}
		fill(btnCol, bx, by, bx+av, by+av)
	}
	if !compact {
		icon := pillIconFont(b.px(20))
		iw, ih := measure(icon, "")
		out(icon, "", bx+(av-iw)/2, by+(av-ih)/2, colorWhite)
	}
	pGdiFlush.Call()

	pix := unsafe.Slice((*byte)(bits), w*h*4)
	r := float64(h) / 2
	rim := math.Max(1, b.scale)
	dcx, dcy, dr := float64(tx)+float64(dotD)/2, float64(ty)+float64(sh)/2, float64(dotD)/2
	if compact {
		dcx, dcy = float64(off+natural-b.px(16))-float64(dotD)/2, float64(h)/2
	}
	b.dotRect = [4]int32{int32(dcx-dr) - 2, int32(dcy-dr) - 2, int32(dcx+dr) + 3, int32(dcy+dr) + 3}
	circles := []circle{
		{float64(axX) + float64(av)/2, float64(axY) + float64(av)/2, float64(av) / 2, avImg, axX, axY},
	}
	if !compact {
		circles = append(circles, circle{float64(bx) + float64(av)/2, float64(by) + float64(av)/2, float64(av) / 2, nil, bx, by})
	}
	const ss = 3
	n := float64(ss * ss)
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			var cov, rimCov, dotCov float64
			var cc [2]float64
			for sy := 0; sy < ss; sy++ {
				for sx := 0; sx < ss; sx++ {
					fx := float64(x) + (float64(sx)+0.5)/ss
					fy := float64(y) + (float64(sy)+0.5)/ss
					cx := math.Max(r, math.Min(float64(w)-r, fx))
					d := r - math.Hypot(fx-cx, fy-r)
					if d >= 0 {
						cov++
						if d < rim {
							rimCov++
						}
					}
					if math.Hypot(fx-dcx, fy-dcy) <= dr {
						dotCov++
					}
					for i, c := range circles {
						if math.Hypot(fx-c.cx, fy-c.cy) <= c.r {
							cc[i]++
						}
					}
				}
			}
			o := (y*w + x) * 4
			if cov == 0 {
				pix[o], pix[o+1], pix[o+2], pix[o+3] = 0, 0, 0, 0
				continue
			}
			gb, gg, gr := float64(pix[o]), float64(pix[o+1]), float64(pix[o+2]) // what GDI drew
			pb, pg, pr := float64(bg[2]), float64(bg[1]), float64(bg[0])
			inSquare := false
			for i, c := range circles {
				if x >= c.x0 && x < c.x0+av && y >= c.y0 && y < c.y0+av {
					inSquare = true
					if cc[i] > 0 {
						var ab, ag, ar float64
						if c.img != nil {
							col := c.img.RGBAAt(x-c.x0, y-c.y0)
							ab, ag, ar = float64(col.B), float64(col.G), float64(col.R)
						} else {
							ab, ag, ar = gb, gg, gr
						}
						t := cc[i] / n * content
						pb, pg, pr = pb+(ab-pb)*t, pg+(ag-pg)*t, pr+(ar-pr)*t
					}
				}
			}
			if !inSquare { // text: what GDI drew, faded with content
				pb, pg, pr = pb+(gb-pb)*content, pg+(gg-pg)*content, pr+(gr-pr)*content
			}
			if rimCov > 0 {
				t := 0.10 * rimCov / cov
				pb, pg, pr = pb+(255-pb)*t, pg+(255-pg)*t, pr+(255-pr)*t
			}
			if dotCov > 0 {
				t := dotCov / n * content * dotA
				pb, pg, pr = pb+(float64(dot[2])-pb)*t, pg+(float64(dot[1])-pg)*t, pr+(float64(dot[0])-pr)*t
			}
			a := cov / n
			pix[o], pix[o+1], pix[o+2], pix[o+3] = byte(pb*a), byte(pg*a), byte(pr*a), byte(255*a)
		}
	}
	return &pillImg{dc: dc, bmp: bmp, old: old, w: w, h: h}
}

var iconFontCache = map[int]uintptr{}

// pillIconFont: the Windows icon font (Segoe Fluent Icons on 11, Segoe MDL2 Assets on 10)
func pillIconFont(height int) uintptr {
	if f, ok := iconFontCache[height]; ok {
		return f
	}
	var f uintptr
	for _, face := range []string{"Segoe Fluent Icons", "Segoe MDL2 Assets"} {
		fp, _ := windows.UTF16PtrFromString(face)
		f, _, _ = pCreateFontW.Call(uintptr(int32(-height)), 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 5, 0, uintptr(unsafe.Pointer(fp)))
		if f != 0 && fontIs(f, face) {
			break
		}
	}
	iconFontCache[height] = f
	return f
}

func (b *banner) loop(ready chan struct{}) {
	runtime.LockOSThread()
	defer close(b.done)
	if r, _, _ := pGetDpiForSystem.Call(); r >= 96 {
		b.scale = float64(r) / 96
	}
	hwnd := plainWindow("ClaudeAgentBanner", b.wndProc)
	if hwnd == 0 {
		ready <- struct{}{}
		return
	}
	pSetTimer.Call(hwnd, 1, 250, 0) // state: fold small again, Claude's text back to the name
	b.mu.Lock()
	b.hwnd = hwnd
	b.mu.Unlock()
	ready <- struct{}{}
	pumpMessages()
	b.img.free()
	b.mu.Lock()
	b.hwnd = 0
	b.mu.Unlock()
}

// plainWindow: a normal top-most popup on the Default desktop that never takes focus (no layered window)
func plainWindow(class string, proc func(hwnd, msg, wp, lp uintptr) uintptr) uintptr {
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
	const exStyle = 0x00000008 | 0x00000080 | 0x08000000 // topmost, toolwindow, noactivate
	const wsPopup = 0x80000000
	hwnd, _, _ := pCreateWindowExW.Call(exStyle, uintptr(unsafe.Pointer(cls)), uintptr(unsafe.Pointer(cls)), wsPopup, 0, 0, 1, 1, 0, 0, 0, 0)
	return hwnd
}
