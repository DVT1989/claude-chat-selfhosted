//go:build windows

package main

// Remote desktop (Meekijken / Overnemen). The service starts a helper ("claude-agent desktop") as SYSTEM
// in the console session. SYSTEM may open whatever desktop has the input (the normal desktop, the lock
// screen, UAC prompts), so the helper follows those switches. It grabs the virtual screen with GDI,
// sends only changed 64x64 tiles as JPEG over HTTPS and replays mouse and keyboard with SendInput.

import (
	"errors"
	"fmt"
	"os"
	"runtime"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

var (
	modUser32 = windows.NewLazySystemDLL("user32.dll")
	modGdi32  = windows.NewLazySystemDLL("gdi32.dll")
	modSas    = windows.NewLazySystemDLL("sas.dll")

	pOpenInputDesktop       = modUser32.NewProc("OpenInputDesktop")
	pSetThreadDesktop       = modUser32.NewProc("SetThreadDesktop")
	pCloseDesktop           = modUser32.NewProc("CloseDesktop")
	pGetDC                  = modUser32.NewProc("GetDC")
	pReleaseDC              = modUser32.NewProc("ReleaseDC")
	pGetSystemMetrics       = modUser32.NewProc("GetSystemMetrics")
	pGetCursorInfo          = modUser32.NewProc("GetCursorInfo")
	pSendInput              = modUser32.NewProc("SendInput")
	pSetProcessDpiAwareness = modUser32.NewProc("SetProcessDpiAwarenessContext")
	pSetProcessDPIAware     = modUser32.NewProc("SetProcessDPIAware")
	pCreateCompatibleDC     = modGdi32.NewProc("CreateCompatibleDC")
	pCreateDIBSection       = modGdi32.NewProc("CreateDIBSection")
	pSelectObject           = modGdi32.NewProc("SelectObject")
	pBitBlt                 = modGdi32.NewProc("BitBlt")
	pDeleteObject           = modGdi32.NewProc("DeleteObject")
	pDeleteDC               = modGdi32.NewProc("DeleteDC")
	pGdiFlush               = modGdi32.NewProc("GdiFlush")
	pSendSAS                = modSas.NewProc("SendSAS")
)

const remoteSupported = true

// startRemote launches the desktop helper as SYSTEM in the active console session and returns at once.
func startRemote(session, key string) error {
	resetUserCursors() // a previous session that did not finish cleanly
	sid := windows.WTSGetActiveConsoleSessionId()
	if sid == 0xFFFFFFFF {
		return errors.New("geen console-sessie actief")
	}
	var self windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_ALL_ACCESS, &self); err != nil {
		return fmt.Errorf("OpenProcessToken: %w", err)
	}
	defer self.Close()
	var dup windows.Token
	if err := windows.DuplicateTokenEx(self, windows.MAXIMUM_ALLOWED, nil, windows.SecurityImpersonation, windows.TokenPrimary, &dup); err != nil {
		return fmt.Errorf("DuplicateTokenEx: %w", err)
	}
	defer dup.Close()
	if err := windows.SetTokenInformation(dup, windows.TokenSessionId, (*byte)(unsafe.Pointer(&sid)), 4); err != nil {
		return fmt.Errorf("sessie instellen: %w", err)
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	cmdline, err := windows.UTF16PtrFromString(windows.ComposeCommandLine([]string{exe, "desktop", "--session", session, "--key", key}))
	if err != nil {
		return err
	}
	si := &windows.StartupInfo{Desktop: windows.StringToUTF16Ptr(`winsta0\default`), Flags: windows.STARTF_USESHOWWINDOW, ShowWindow: windows.SW_HIDE}
	si.Cb = uint32(unsafe.Sizeof(*si))
	var pi windows.ProcessInformation
	if err := windows.CreateProcessAsUser(dup, nil, cmdline, nil, nil, false, windows.CREATE_NO_WINDOW, nil, nil, si, &pi); err != nil {
		return fmt.Errorf("hulpproces starten: %w", err)
	}
	windows.CloseHandle(pi.Thread)
	windows.CloseHandle(pi.Process)
	return nil
}

// sendSAS presses Ctrl+Alt+Del. Only a service may do this, and only when the policy allows it.
func sendSAS() error {
	k, _, err := registry.CreateKey(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System`, registry.QUERY_VALUE|registry.SET_VALUE)
	if err != nil {
		return fmt.Errorf("beleid openen: %w", err)
	}
	if v, _, e := k.GetIntegerValue("SoftwareSASGeneration"); e != nil || (v != 1 && v != 3) {
		_ = k.SetDWordValue("SoftwareSASGeneration", 1) // 1 = services may generate the SAS
	}
	k.Close()
	if err := pSendSAS.Find(); err != nil {
		return errors.New("sas.dll niet gevonden")
	}
	pSendSAS.Call(0)
	return nil
}

func setDPIAware() {
	if pSetProcessDpiAwareness.Find() == nil {
		const perMonitorV2 = ^uintptr(3) // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4
		if r, _, _ := pSetProcessDpiAwareness.Call(perMonitorV2); r != 0 {
			return
		}
	}
	pSetProcessDPIAware.Call()
}

// attachInputDesktop switches the calling (locked) thread to the desktop that currently gets input.
func attachInputDesktop(cur *uintptr) {
	const genericAll = 0x10000000
	h, _, _ := pOpenInputDesktop.Call(0, 0, genericAll)
	if h == 0 {
		return
	}
	if r, _, _ := pSetThreadDesktop.Call(h); r == 0 {
		pCloseDesktop.Call(h)
		return
	}
	if *cur != 0 {
		pCloseDesktop.Call(*cur)
	}
	*cur = h
}

type winCapturer struct {
	desk       uintptr
	memDC, bmp uintptr
	old        uintptr
	bits       unsafe.Pointer
	w, h       int
	vx, vy     int
}

func newCapturer() (capturer, error) {
	runtime.LockOSThread() // the desktop binding is per thread
	dc, _, _ := pCreateCompatibleDC.Call(0)
	if dc == 0 {
		return nil, errors.New("CreateCompatibleDC mislukt")
	}
	// DXGI Desktop Duplication first, GDI as fallback (capture_dda_windows.go)
	return &ddaCapturer{gdi: &winCapturer{memDC: dc}}, nil
}

type bitmapInfoHeader struct {
	Size          uint32
	Width         int32
	Height        int32
	Planes        uint16
	BitCount      uint16
	Compression   uint32
	SizeImage     uint32
	XPelsPerMeter int32
	YPelsPerMeter int32
	ClrUsed       uint32
	ClrImportant  uint32
}

func sysMetric(i int) int {
	r, _, _ := pGetSystemMetrics.Call(uintptr(i))
	return int(int32(r))
}

func (c *winCapturer) ensure(w, h int) error {
	if w == c.w && h == c.h && c.bmp != 0 {
		return nil
	}
	if c.bmp != 0 {
		pSelectObject.Call(c.memDC, c.old)
		pDeleteObject.Call(c.bmp)
		c.bmp = 0
	}
	bi := bitmapInfoHeader{Size: 40, Width: int32(w), Height: -int32(h), Planes: 1, BitCount: 32}
	var bits unsafe.Pointer
	bmp, _, _ := pCreateDIBSection.Call(c.memDC, uintptr(unsafe.Pointer(&bi)), 0, uintptr(unsafe.Pointer(&bits)), 0, 0)
	if bmp == 0 || bits == nil {
		return errors.New("CreateDIBSection mislukt")
	}
	c.old, _, _ = pSelectObject.Call(c.memDC, bmp)
	c.bmp, c.bits, c.w, c.h = bmp, bits, w, h
	return nil
}

// grab returns the virtual screen as BGRA (top-down), its size and the cursor position (x = -1: hidden).
func (c *winCapturer) grab() ([]byte, int, int, int, int, error) {
	attachInputDesktop(&c.desk)
	vx, vy, w, h := sysMetric(76), sysMetric(77), sysMetric(78), sysMetric(79)
	if w <= 0 || h <= 0 {
		return nil, 0, 0, 0, 0, errors.New("geen scherm")
	}
	if err := c.ensure(w, h); err != nil {
		return nil, 0, 0, 0, 0, err
	}
	c.vx, c.vy = vx, vy
	sdc, _, _ := pGetDC.Call(0)
	if sdc == 0 {
		return nil, 0, 0, 0, 0, errors.New("GetDC mislukt")
	}
	// no CAPTUREBLT: with it Windows hides the pointer during every capture (it flickered constantly);
	// with DWM the plain copy already holds every window, layered ones included
	const srccopy = 0x00CC0020
	r, _, _ := pBitBlt.Call(c.memDC, 0, 0, uintptr(w), uintptr(h), sdc, uintptr(vx), uintptr(vy), srccopy)
	pReleaseDC.Call(0, sdc)
	pGdiFlush.Call()
	if r == 0 {
		return nil, 0, 0, 0, 0, errors.New("BitBlt mislukt")
	}
	cx, cy := -1, -1
	var ci struct {
		Size, Flags uint32
		Cursor      uintptr
		X, Y        int32
	}
	ci.Size = uint32(unsafe.Sizeof(ci))
	if ok, _, _ := pGetCursorInfo.Call(uintptr(unsafe.Pointer(&ci))); ok != 0 && ci.Flags&1 != 0 {
		cx, cy = int(ci.X)-vx, int(ci.Y)-vy
	}
	return unsafe.Slice((*byte)(c.bits), w*h*4), w, h, cx, cy, nil
}

func (c *winCapturer) close() {
	if c.bmp != 0 {
		pSelectObject.Call(c.memDC, c.old)
		pDeleteObject.Call(c.bmp)
	}
	pDeleteDC.Call(c.memDC)
	if c.desk != 0 {
		pCloseDesktop.Call(c.desk)
	}
}

// ── Input ───────────────────────────────────────────────────

type winInput struct {
	Type uint32
	_    uint32
	Data [32]byte // MOUSEINPUT (32 bytes on amd64) or KEYBDINPUT
}

type mouseInput struct {
	Dx, Dy    int32
	MouseData uint32
	Flags     uint32
	Time      uint32
	_         uint32
	Extra     uintptr
}

type keybdInput struct {
	Vk, Scan uint16
	Flags    uint32
	Time     uint32
	_        uint32
	Extra    uintptr
}

type winInjector struct{ desk uintptr }

func newInjector() injector {
	runtime.LockOSThread()
	return &winInjector{}
}

func (in *winInjector) begin() { attachInputDesktop(&in.desk) }

func send(items []winInput) {
	if len(items) == 0 {
		return
	}
	pSendInput.Call(uintptr(len(items)), uintptr(unsafe.Pointer(&items[0])), unsafe.Sizeof(items[0]))
}

func mouse(dx, dy int32, data, flags uint32) winInput {
	var w winInput
	w.Type = 0
	*(*mouseInput)(unsafe.Pointer(&w.Data)) = mouseInput{Dx: dx, Dy: dy, MouseData: data, Flags: flags}
	return w
}

func key(vk, scan uint16, flags uint32) winInput {
	var w winInput
	w.Type = 1
	*(*keybdInput)(unsafe.Pointer(&w.Data)) = keybdInput{Vk: vk, Scan: scan, Flags: flags}
	return w
}

const (
	mMove, mAbs, mVirt         = 0x0001, 0x8000, 0x4000
	mWheel, mHWheel            = 0x0800, 0x1000
	kExt, kUp, kUnicode, kScan = 0x0001, 0x0002, 0x0004, 0x0008
)

var buttonFlags = [3][2]uint32{{0x0002, 0x0004}, {0x0020, 0x0040}, {0x0008, 0x0010}} // left, middle, right: down, up

func (in *winInjector) apply(ev inputEvent) {
	abs := func() (int32, int32) { return int32(clamp(ev.X, 0, 65535)), int32(clamp(ev.Y, 0, 65535)) }
	switch ev.T {
	case "m":
		x, y := abs()
		send([]winInput{mouse(x, y, 0, mMove|mAbs|mVirt)})
	case "d", "u":
		if ev.B < 0 || ev.B > 2 {
			return
		}
		x, y := abs()
		f := buttonFlags[ev.B][0]
		if ev.T == "u" {
			f = buttonFlags[ev.B][1]
		}
		send([]winInput{mouse(x, y, 0, mMove|mAbs|mVirt), mouse(x, y, 0, f|mAbs|mVirt)})
	case "w":
		if ev.DY != 0 {
			send([]winInput{mouse(0, 0, uint32(int32(-ev.DY)), mWheel)})
		}
		if ev.DX != 0 {
			send([]winInput{mouse(0, 0, uint32(int32(ev.DX)), mHWheel)})
		}
	case "k":
		up := uint32(0)
		if !ev.Down {
			up = kUp
		}
		if vk, ok := vkKeys[ev.C]; ok {
			send([]winInput{key(vk, 0, kExt|up)})
			return
		}
		sc, ok := scanCodes[ev.C]
		if !ok {
			return
		}
		f := kScan | up
		if sc&0xE000 != 0 {
			f |= kExt
		}
		send([]winInput{key(0, sc&0xFF, f)})
	case "text":
		var items []winInput
		for _, r := range ev.S {
			if r == '\n' {
				items = append(items, key(0, 0x1C, kScan), key(0, 0x1C, kScan|kUp))
				continue
			}
			if r == '\r' {
				continue
			}
			for _, u := range windows.StringToUTF16(string(r)) {
				if u == 0 {
					continue
				}
				items = append(items, key(0, u, kUnicode), key(0, u, kUnicode|kUp))
			}
		}
		send(items)
	}
}

func (in *winInjector) close() {
	if in.desk != 0 {
		pCloseDesktop.Call(in.desk)
	}
}

func clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// NumLock and Pause are odd in scan code set 1; send them as virtual keys.
var vkKeys = map[string]uint16{"NumLock": 0x90, "Pause": 0x13}

// KeyboardEvent.code -> scan code set 1 (0xE0xx = extended key)
var scanCodes = map[string]uint16{
	"Escape": 0x01, "Digit1": 0x02, "Digit2": 0x03, "Digit3": 0x04, "Digit4": 0x05, "Digit5": 0x06, "Digit6": 0x07,
	"Digit7": 0x08, "Digit8": 0x09, "Digit9": 0x0A, "Digit0": 0x0B, "Minus": 0x0C, "Equal": 0x0D, "Backspace": 0x0E,
	"Tab": 0x0F, "KeyQ": 0x10, "KeyW": 0x11, "KeyE": 0x12, "KeyR": 0x13, "KeyT": 0x14, "KeyY": 0x15, "KeyU": 0x16,
	"KeyI": 0x17, "KeyO": 0x18, "KeyP": 0x19, "BracketLeft": 0x1A, "BracketRight": 0x1B, "Enter": 0x1C,
	"ControlLeft": 0x1D, "KeyA": 0x1E, "KeyS": 0x1F, "KeyD": 0x20, "KeyF": 0x21, "KeyG": 0x22, "KeyH": 0x23,
	"KeyJ": 0x24, "KeyK": 0x25, "KeyL": 0x26, "Semicolon": 0x27, "Quote": 0x28, "Backquote": 0x29,
	"ShiftLeft": 0x2A, "Backslash": 0x2B, "KeyZ": 0x2C, "KeyX": 0x2D, "KeyC": 0x2E, "KeyV": 0x2F, "KeyB": 0x30,
	"KeyN": 0x31, "KeyM": 0x32, "Comma": 0x33, "Period": 0x34, "Slash": 0x35, "ShiftRight": 0x36,
	"NumpadMultiply": 0x37, "AltLeft": 0x38, "Space": 0x39, "CapsLock": 0x3A, "F1": 0x3B, "F2": 0x3C, "F3": 0x3D,
	"F4": 0x3E, "F5": 0x3F, "F6": 0x40, "F7": 0x41, "F8": 0x42, "F9": 0x43, "F10": 0x44, "ScrollLock": 0x46,
	"Numpad7": 0x47, "Numpad8": 0x48, "Numpad9": 0x49, "NumpadSubtract": 0x4A, "Numpad4": 0x4B, "Numpad5": 0x4C,
	"Numpad6": 0x4D, "NumpadAdd": 0x4E, "Numpad1": 0x4F, "Numpad2": 0x50, "Numpad3": 0x51, "Numpad0": 0x52,
	"NumpadDecimal": 0x53, "IntlBackslash": 0x56, "F11": 0x57, "F12": 0x58,
	"NumpadEnter": 0xE01C, "ControlRight": 0xE01D, "NumpadDivide": 0xE035, "PrintScreen": 0xE037, "AltRight": 0xE038,
	"Home": 0xE047, "ArrowUp": 0xE048, "PageUp": 0xE049, "ArrowLeft": 0xE04B, "ArrowRight": 0xE04D, "End": 0xE04F,
	"ArrowDown": 0xE050, "PageDown": 0xE051, "Insert": 0xE052, "Delete": 0xE053, "MetaLeft": 0xE05B,
	"MetaRight": 0xE05C, "ContextMenu": 0xE05D,
}

// ── Text focus (for the phone keyboard) ─────────────────────

var (
	modOle32          = windows.NewLazySystemDLL("ole32.dll")
	pCoInitializeEx   = modOle32.NewProc("CoInitializeEx")
	pCoCreateInstance = modOle32.NewProc("CoCreateInstance")
	pGetGUIThreadInfo = modUser32.NewProc("GetGUIThreadInfo")

	clsidCUIAutomation = windows.GUID{Data1: 0xff48dba4, Data2: 0x60ef, Data3: 0x4201, Data4: [8]byte{0xaa, 0x87, 0x54, 0x10, 0x3e, 0xef, 0x59, 0x4e}}
	iidIUIAutomation   = windows.GUID{Data1: 0x30cbe57d, Data2: 0xd9d0, Data3: 0x452a, Data4: [8]byte{0xab, 0x13, 0x7a, 0xc5, 0xac, 0x48, 0x25, 0xee}}
)

// comCall calls method idx of a COM interface pointer (vtable index, IUnknown = 0..2).
// uintptrescapes: pointers converted to uintptr in the arguments are moved to the heap, so Go cannot
// move them while Windows writes the result (a stack variable could move inside this function).
//
//go:uintptrescapes
func comCall(obj uintptr, idx int, args ...uintptr) uintptr {
	vtbl := *(*uintptr)(unsafe.Pointer(obj))
	fn := *(*uintptr)(unsafe.Pointer(vtbl + uintptr(idx)*unsafe.Sizeof(uintptr(0))))
	r, _, _ := syscall.SyscallN(fn, append([]uintptr{obj}, args...)...)
	return r
}

// caretShown: the foreground thread shows a system caret (classic edit controls, many Win32 apps).
func caretShown() bool {
	var gi struct {
		Size, Flags                                        uint32
		Active, Focus, Capture, MenuOwner, MoveSize, Caret uintptr
		Rect                                               [4]int32
	}
	gi.Size = uint32(unsafe.Sizeof(gi))
	r, _, _ := pGetGUIThreadInfo.Call(0, uintptr(unsafe.Pointer(&gi)))
	return r != 0 && gi.Caret != 0
}

// uiaBool reads a boolean UI Automation property; ok is false when it is not available.
func uiaBool(el uintptr, prop int) (val, ok bool) {
	var v [24]byte                                                           // VARIANT
	if comCall(el, 10, uintptr(prop), uintptr(unsafe.Pointer(&v[0]))) != 0 { // GetCurrentPropertyValue
		return false, false
	}
	if *(*uint16)(unsafe.Pointer(&v[0])) != 11 { // VT_BOOL
		return false, false
	}
	return *(*int16)(unsafe.Pointer(&v[8])) != 0, true
}

// uiaEditable: the focused element is a writable text box (browsers, UWP, WPF report it here).
func uiaEditable(uia uintptr) bool {
	var el uintptr
	if comCall(uia, 8, uintptr(unsafe.Pointer(&el))) != 0 || el == 0 { // GetFocusedElement
		return false
	}
	defer comCall(el, 2) // Release
	var ct int32
	if comCall(el, 21, uintptr(unsafe.Pointer(&ct))) != 0 { // get_CurrentControlType
		return false
	}
	const edit, document = 50004, 50030
	if ct != edit && ct != document {
		return false
	}
	const valuePatternAvailable, valueIsReadOnly = 30043, 30046
	if has, ok := uiaBool(el, valuePatternAvailable); !ok || !has {
		return ct == edit // a document without a value pattern is usually a web page or viewer
	}
	ro, ok := uiaBool(el, valueIsReadOnly)
	return ok && !ro
}

func watchEditable(flag *atomic.Bool, stop *atomic.Bool) {
	runtime.LockOSThread()
	var desk uintptr
	attachInputDesktop(&desk)
	pCoInitializeEx.Call(0, 0) // COINIT_MULTITHREADED: no hidden window on this thread
	var uia uintptr
	const clsctxInproc = 1
	if hr, _, _ := pCoCreateInstance.Call(uintptr(unsafe.Pointer(&clsidCUIAutomation)), 0, clsctxInproc,
		uintptr(unsafe.Pointer(&iidIUIAutomation)), uintptr(unsafe.Pointer(&uia))); hr != 0 {
		uia = 0
	}
	for !stop.Load() {
		ed := caretShown()
		if !ed && uia != 0 {
			ed = uiaEditable(uia)
		}
		flag.Store(ed)
		time.Sleep(250 * time.Millisecond)
	}
}
