//go:build windows

package main

// Screen capture with DXGI Desktop Duplication (what TeamViewer and AnyDesk use): the picture comes
// straight from the GPU. GDI BitBlt from the screen forced Windows to rebuild the desktop for every
// read and made top-most layered windows (the island) flicker. Falls back to GDI when duplication is
// not available (old drivers, remote/virtual displays, the secure desktop on some systems).
// Interface ids and vtable slots are taken from the Windows SDK headers (dxgi.h, dxgi1_2.h, d3d11.h).

import (
	"errors"
	"log"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	modD3D11           = windows.NewLazySystemDLL("d3d11.dll")
	pD3D11CreateDevice = modD3D11.NewProc("D3D11CreateDevice")

	iidIDXGIDevice     = windows.GUID{Data1: 0x54ec77fa, Data2: 0x1377, Data3: 0x44e6, Data4: [8]byte{0x8c, 0x32, 0x88, 0xfd, 0x5f, 0x44, 0xc8, 0x4c}}
	iidIDXGIOutput1    = windows.GUID{Data1: 0x00cddea8, Data2: 0x939b, Data3: 0x4b83, Data4: [8]byte{0xa3, 0x40, 0xa6, 0x85, 0x22, 0x66, 0x66, 0xcc}}
	iidID3D11Texture2D = windows.GUID{Data1: 0x6f15aaf2, Data2: 0xd208, Data3: 0x4e89, Data4: [8]byte{0x9a, 0xb4, 0x48, 0x95, 0x35, 0xd3, 0x4f, 0x9c}}
)

const (
	dxgiErrNotFound    = 0x887A0002
	dxgiErrWaitTimeout = 0x887A0027
	dxgiErrAccessLost  = 0x887A0026

	// vtable slots
	vQueryInterface        = 0
	vRelease               = 2
	vDXGIDeviceGetAdapter  = 7
	vAdapterEnumOutputs    = 7
	vOutputGetDesc         = 7
	vOutput1DuplicateOut   = 22
	vDuplAcquireNextFrame  = 8
	vDuplReleaseFrame      = 14
	vDeviceCreateTexture2D = 5
	vDeviceGetImmContext   = 40
	vCtxMap                = 14
	vCtxUnmap              = 15
	vCtxCopyResource       = 47
)

type ddaOutput struct {
	dup     uintptr // IDXGIOutputDuplication
	staging uintptr // ID3D11Texture2D (CPU readable)
	x, y    int     // desktop coordinates of this monitor
	got     bool    // a full picture of this monitor is in the buffer
	w, h    int
}

// ddaScratch holds every out-parameter handed to Windows. It lives on the heap, which Go never moves;
// stack variables can move while a call is running and Windows would write to the old place.
type ddaScratch struct {
	level                                      uint32
	dxgiDev, adapter, out, out1, dup, res, tex uintptr
	desc                                       [96]byte // DXGI_OUTPUT_DESC
	info                                       [64]byte // DXGI_OUTDUPL_FRAME_INFO
	td                                         [11]uint32
	mapped                                     struct {
		Data       uintptr
		RowPitch   uint32
		DepthPitch uint32
	}
}

type ddaCapturer struct {
	sc      *ddaScratch
	gdi     *winCapturer // fallback (secure desktop, lost access)
	device  uintptr
	ctx     uintptr
	outs    []ddaOutput
	buf     []byte
	vx, vy  int
	w, h    int
	desk    uintptr
	ok      bool
	logged  string
	retryAt time.Time // after a failed setup: wait before trying again (lock screen, UAC)
}

func hr(r uintptr) uint32 { return uint32(r) }

func release(p uintptr) {
	if p != 0 {
		comCall(p, vRelease)
	}
}

func (c *ddaCapturer) note(method string) {
	if c.logged != method {
		log.Printf("schermopname: %s", method)
		c.logged = method
	}
}

func (c *ddaCapturer) teardown() {
	for _, o := range c.outs {
		release(o.staging)
		release(o.dup)
	}
	c.outs = nil
	release(c.ctx)
	release(c.device)
	c.ctx, c.device, c.ok = 0, 0, false
}

// setup creates the D3D11 device and one duplication per monitor of the first adapter.
func (c *ddaCapturer) setup() error {
	c.teardown()
	attachInputDesktop(&c.desk)
	if err := pD3D11CreateDevice.Find(); err != nil {
		return err
	}
	if c.sc == nil {
		c.sc = new(ddaScratch)
	}
	sc := c.sc
	if r, _, _ := pD3D11CreateDevice.Call(0, 1 /*HARDWARE*/, 0, 0, 0, 0, 7 /*SDK*/, uintptr(unsafe.Pointer(&c.device)), uintptr(unsafe.Pointer(&sc.level)), uintptr(unsafe.Pointer(&c.ctx))); hr(r) != 0 || c.device == 0 {
		return errors.New("D3D11CreateDevice mislukt")
	}
	sc.dxgiDev, sc.adapter = 0, 0
	if hr(comCall(c.device, vQueryInterface, uintptr(unsafe.Pointer(&iidIDXGIDevice)), uintptr(unsafe.Pointer(&sc.dxgiDev)))) != 0 {
		return errors.New("geen IDXGIDevice")
	}
	dxgiDev := sc.dxgiDev
	defer release(dxgiDev)
	if hr(comCall(dxgiDev, vDXGIDeviceGetAdapter, uintptr(unsafe.Pointer(&sc.adapter)))) != 0 {
		return errors.New("geen adapter")
	}
	adapter := sc.adapter
	defer release(adapter)
	for i := 0; ; i++ {
		sc.out = 0
		r := hr(comCall(adapter, vAdapterEnumOutputs, uintptr(i), uintptr(unsafe.Pointer(&sc.out))))
		out := sc.out
		if r == dxgiErrNotFound {
			break
		}
		if r != 0 {
			return errors.New("EnumOutputs mislukt")
		}
		comCall(out, vOutputGetDesc, uintptr(unsafe.Pointer(&sc.desc[0])))
		desc := sc.desc
		rect := (*[4]int32)(unsafe.Pointer(&desc[64]))
		attached := *(*int32)(unsafe.Pointer(&desc[80]))
		rotation := *(*int32)(unsafe.Pointer(&desc[84]))
		sc.out1 = 0
		qi := hr(comCall(out, vQueryInterface, uintptr(unsafe.Pointer(&iidIDXGIOutput1)), uintptr(unsafe.Pointer(&sc.out1))))
		out1 := sc.out1
		release(out)
		if qi != 0 {
			return errors.New("geen IDXGIOutput1")
		}
		if attached == 0 {
			release(out1)
			continue
		}
		if rotation > 1 { // rotated screens: leave it to GDI
			release(out1)
			return errors.New("gedraaid scherm")
		}
		sc.dup = 0
		r = hr(comCall(out1, vOutput1DuplicateOut, c.device, uintptr(unsafe.Pointer(&sc.dup))))
		dup := sc.dup
		release(out1)
		if r != 0 || dup == 0 {
			return errors.New("DuplicateOutput mislukt")
		}
		o := ddaOutput{dup: dup, x: int(rect[0]), y: int(rect[1]), w: int(rect[2] - rect[0]), h: int(rect[3] - rect[1])}
		sc.td = [11]uint32{uint32(o.w), uint32(o.h), 1, 1, 87 /*B8G8R8A8_UNORM*/, 1, 0, 3 /*STAGING*/, 0, 0x20000 /*CPU_ACCESS_READ*/, 0}
		sc.tex = 0
		if hr(comCall(c.device, vDeviceCreateTexture2D, uintptr(unsafe.Pointer(&sc.td[0])), 0, uintptr(unsafe.Pointer(&sc.tex)))) != 0 || sc.tex == 0 {
			release(dup)
			return errors.New("CreateTexture2D mislukt")
		}
		o.staging = sc.tex
		c.outs = append(c.outs, o)
	}
	if len(c.outs) == 0 {
		return errors.New("geen scherm voor duplicatie")
	}
	c.ok = true
	return nil
}

// frame copies new pictures of every monitor into the virtual-screen buffer.
func (c *ddaCapturer) frame() error {
	vx, vy, w, h := sysMetric(76), sysMetric(77), sysMetric(78), sysMetric(79)
	if w != c.w || h != c.h || vx != c.vx || vy != c.vy || c.buf == nil {
		c.w, c.h, c.vx, c.vy = w, h, vx, vy
		c.buf = make([]byte, w*h*4)
		for i := range c.outs {
			c.outs[i].got = false
		}
	}
	for i := range c.outs {
		o := &c.outs[i]
		sc := c.sc
		sc.res = 0
		wait := uintptr(0)
		if !o.got {
			wait = 300 // the first frame after setup holds the whole screen
		}
		r := hr(comCall(o.dup, vDuplAcquireNextFrame, wait, uintptr(unsafe.Pointer(&sc.info[0])), uintptr(unsafe.Pointer(&sc.res))))
		if r == dxgiErrWaitTimeout {
			continue // nothing new on this monitor
		}
		if r != 0 || sc.res == 0 {
			return errors.New("toegang tot het beeld verloren")
		}
		res := sc.res
		// LastPresentTime 0: only the mouse moved, the frame holds no new picture (the very first one
		// after setup can be like that, its texture then is black)
		if *(*int64)(unsafe.Pointer(&sc.info[0])) == 0 {
			release(res)
			comCall(o.dup, vDuplReleaseFrame)
			continue
		}
		sc.tex = 0
		if hr(comCall(res, vQueryInterface, uintptr(unsafe.Pointer(&iidID3D11Texture2D)), uintptr(unsafe.Pointer(&sc.tex)))) == 0 && sc.tex != 0 {
			tex := sc.tex
			comCall(c.ctx, vCtxCopyResource, o.staging, tex)
			if hr(comCall(c.ctx, vCtxMap, o.staging, 0, 1 /*READ*/, 0, uintptr(unsafe.Pointer(&sc.mapped)))) == 0 {
				mapped := sc.mapped
				ox, oy := o.x-vx, o.y-vy
				for y := 0; y < o.h; y++ {
					ty := oy + y
					if ty < 0 || ty >= h {
						continue
					}
					src := unsafe.Slice((*byte)(unsafe.Pointer(mapped.Data+uintptr(y)*uintptr(mapped.RowPitch))), o.w*4)
					x0, n := ox, o.w
					if x0 < 0 {
						src = src[-x0*4:]
						n += x0
						x0 = 0
					}
					if x0+n > w {
						n = w - x0
					}
					if n > 0 {
						copy(c.buf[(ty*w+x0)*4:], src[:n*4])
					}
				}
				comCall(c.ctx, vCtxUnmap, o.staging, 0)
				o.got = true
			}
			release(tex)
		}
		release(res)
		comCall(o.dup, vDuplReleaseFrame)
	}
	return nil
}

func (c *ddaCapturer) grab() ([]byte, int, int, int, int, error) {
	if !c.ok && time.Now().Before(c.retryAt) {
		return c.gdi.grab()
	}
	if !c.ok {
		if err := c.setup(); err != nil {
			c.teardown()
			c.retryAt = time.Now().Add(2 * time.Second)
			c.note("GDI (" + err.Error() + ")")
			return c.gdi.grab()
		}
	}
	if err := c.frame(); err != nil {
		// desktop switch (lock screen, UAC) or display change: rebuild; GDI for this frame
		c.teardown()
		c.note("GDI (" + err.Error() + ")")
		return c.gdi.grab()
	}
	// a monitor that has not delivered its first picture (nothing changed on it): fill that part once
	// with GDI, then duplication carries on (one GDI read, not one per frame)
	for i := range c.outs {
		o := &c.outs[i]
		if o.got {
			continue
		}
		gp, gw, gh, _, _, err := c.gdi.grab()
		if err != nil || gw != c.w || gh != c.h {
			return c.gdi.grab()
		}
		ox, oy := o.x-c.vx, o.y-c.vy
		for y := 0; y < o.h; y++ {
			ty := oy + y
			if ty < 0 || ty >= c.h || ox < 0 || ox+o.w > c.w {
				continue
			}
			off := (ty*c.w + ox) * 4
			copy(c.buf[off:off+o.w*4], gp[off:off+o.w*4])
		}
		o.got = true
	}
	c.note("DXGI Desktop Duplication")
	cx, cy := -1, -1
	var ci struct {
		Size, Flags uint32
		Cursor      uintptr
		X, Y        int32
	}
	ci.Size = uint32(unsafe.Sizeof(ci))
	if okc, _, _ := pGetCursorInfo.Call(uintptr(unsafe.Pointer(&ci))); okc != 0 && ci.Flags&1 != 0 {
		cx, cy = int(ci.X)-c.vx, int(ci.Y)-c.vy
	}
	return c.buf, c.w, c.h, cx, cy, nil
}

func (c *ddaCapturer) close() {
	c.teardown()
	c.gdi.close()
}
