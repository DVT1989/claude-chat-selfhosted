package main

// Desktop helper ("claude-agent desktop --session S --key K"): capture loop + input loop for one
// remote session. Frames go to /api/devices/remote/agent/S/frame, input comes from a long-poll on
// /api/devices/remote/agent/S/input. The helper ends when the server says stop or stops answering.

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"image"
	"image/jpeg"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"time"
)

type capturer interface {
	grab() (pix []byte, w, h, cx, cy int, err error)
	close()
}

type injector interface {
	begin()
	apply(ev inputEvent)
	close()
}

type inputEvent struct {
	T    string `json:"t"`           // m move, d/u button, w wheel, k key, text
	X    int    `json:"x,omitempty"` // 0..65535 over the whole virtual screen
	Y    int    `json:"y,omitempty"`
	B    int    `json:"b,omitempty"` // 0 left, 1 middle, 2 right
	DX   int    `json:"dx,omitempty"`
	DY   int    `json:"dy,omitempty"`
	C    string `json:"c,omitempty"` // KeyboardEvent.code
	Down bool   `json:"down,omitempty"`
	S    string `json:"s,omitempty"`
	By   string `json:"by,omitempty"` // "claude" when Claude sent it
}

type remoteCtl struct {
	Stop     bool         `json:"stop"`
	Key      bool         `json:"key"`
	Quality  int          `json:"quality"`
	Scale    int          `json:"scale"`
	Name     string       `json:"name"`     // shown next to the on-screen cursor
	Notice   bool         `json:"notice"`   // show "<name> kijkt mee" on the PC
	Accent   string       `json:"accent"`   // operator's accent colour, for the pill background
	Initials string       `json:"initials"` // shown when there is no photo
	Claude   bool         `json:"claude"`   // a session Claude started: the island says "Claude werkt mee"
	Avatar   bool         `json:"avatar"`   // the operator has a photo: fetch it once from /avatar
	Shot     int          `json:"shot"`     // screenshot for Claude, max width in pixels
	Events   []inputEvent `json:"events"`
}

type desktop struct {
	base        string
	key         string
	quality     atomic.Int32
	scale       atomic.Int32
	wantKey     atomic.Bool
	editing     atomic.Bool // a text field has keyboard focus on the device
	shotReq     atomic.Int32
	cursor      *nameCursor
	banner      *banner
	avatarAsked atomic.Bool
	stop        atomic.Bool
	client      *http.Client
}

const tile = 64

func runDesktop(args []string) {
	fs := flag.NewFlagSet("desktop", flag.ExitOnError)
	session := fs.String("session", "", "sessie")
	server := fs.String("server", "", "server-URL (macOS: de helper draait als gebruiker en kan de config niet lezen)")
	key := fs.String("key", "", "sleutel")
	_ = fs.Parse(args)
	p := desktopLogPath()
	if st, err := os.Stat(p); err == nil && st.Size() > 2<<20 {
		_ = os.Remove(p)
	}
	if f, err := os.OpenFile(p, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600); err == nil {
		log.SetOutput(f)
	}
	cfg := &Config{Server: normalizeServer(*server)}
	var err error
	if *server == "" {
		cfg, err = loadConfig()
	}
	if err != nil || cfg.Server == "" || *session == "" || *key == "" {
		log.Printf("desktop: geen config of sessie: %v", err)
		os.Exit(1)
	}
	setDPIAware()
	d := &desktop{base: cfg.Server + "/api/devices/remote/agent/" + *session, key: *key, client: &http.Client{Timeout: 60 * time.Second}}
	d.quality.Store(55)
	d.scale.Store(1)
	d.wantKey.Store(true)
	log.Printf("desktop %s gestart", *session)
	d.cursor = startOverlay()
	defer d.cursor.close()
	d.banner = startBanner()
	// the red button on the island: the person at the PC ends the session
	d.banner.setHangup(func() {
		_, _ = d.call("/hangup", "application/json", []byte("{}"), 10*time.Second)
		d.stop.Store(true)
	})
	defer d.banner.close()
	go d.inputLoop()
	go watchEditable(&d.editing, &d.stop)
	if err := d.captureLoop(); err != nil {
		log.Printf("desktop %s: %v", *session, err)
	}
	d.stop.Store(true)
	log.Printf("desktop %s gestopt", *session)
}

func (d *desktop) applyCtl(c *remoteCtl) {
	if c.Stop {
		d.stop.Store(true)
	}
	if c.Name != "" && d.cursor != nil {
		d.cursor.setName(c.Name)
	}
	if d.banner != nil {
		d.banner.look(c.Accent, c.Initials, nil)
		d.banner.set(c.Notice, c.Name)
		if c.Claude {
			d.banner.claude()
		}
		if c.Avatar && !d.avatarAsked.Swap(true) {
			go func() {
				if b, err := d.fetch("/avatar"); err == nil && len(b) > 0 {
					d.banner.look("", "", b)
				}
			}()
		}
	}
	if c.Shot >= 320 && c.Shot <= 4096 {
		d.shotReq.Store(int32(c.Shot))
	}
	if c.Key {
		d.wantKey.Store(true)
	}
	if c.Quality >= 10 && c.Quality <= 95 {
		d.quality.Store(int32(c.Quality))
	}
	if (c.Scale == 1 || c.Scale == 2) && int32(c.Scale) != d.scale.Load() {
		d.scale.Store(int32(c.Scale))
		d.wantKey.Store(true)
	}
}

func (d *desktop) call(path, ctype string, body []byte, timeout time.Duration) (*remoteCtl, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, d.base+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", ctype)
	req.Header.Set("X-Remote-Key", d.key)
	req.Header.Set("User-Agent", "ClaudeAgent/"+version)
	res, err := d.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if res.StatusCode == http.StatusNotFound || res.StatusCode == http.StatusGone || res.StatusCode == http.StatusForbidden {
		return &remoteCtl{Stop: true}, nil
	}
	if res.StatusCode >= 300 {
		return nil, fmt.Errorf("HTTP %d", res.StatusCode)
	}
	var c remoteCtl
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, err
	}
	return &c, nil
}

func (d *desktop) inputLoop() {
	inj := newInjector()
	if inj == nil {
		return
	}
	defer inj.close()
	fails := 0
	for !d.stop.Load() {
		c, err := d.call("/input", "application/json", []byte("{}"), 40*time.Second)
		if err != nil {
			fails++
			if fails > 20 {
				d.stop.Store(true)
				return
			}
			time.Sleep(time.Second)
			continue
		}
		fails = 0
		d.applyCtl(c)
		if len(c.Events) > 0 {
			inj.begin()
			for _, ev := range c.Events {
				inj.apply(ev)
			}
			if f, ok := inj.(interface{ end() }); ok {
				f.end() // injectors that batch (macOS) send everything now
			}
			for i := len(c.Events) - 1; i >= 0; i-- {
				if ev := c.Events[i]; ev.T == "m" || ev.T == "d" || ev.T == "u" {
					d.cursor.show(ev.X, ev.Y, ev.By == "claude")
					if ev.By == "claude" {
						d.banner.claude()
					}
					break
				}
			}
		}
	}
}

type rect struct{ x, y, w, h int }

// changedRects compares cur with prev per 64x64 tile and merges changed tiles into rectangles:
// runs within a tile row, extended downwards while the next row has the same run.
func changedRects(prev, cur []byte, w, h int) []rect {
	stride := w * 4
	cols, rows := (w+tile-1)/tile, (h+tile-1)/tile
	var out []rect
	open := map[[2]int]int{} // run (col0, col1) -> index in out, for the previous tile row
	changed := 0
	for ty := 0; ty < rows; ty++ {
		y0, y1 := ty*tile, min((ty+1)*tile, h)
		next := map[[2]int]int{}
		run := -1
		flushRun := func(c0, c1 int) {
			x0, x1 := c0*tile, min(c1*tile, w)
			k := [2]int{c0, c1}
			if i, ok := open[k]; ok && out[i].y+out[i].h == y0 {
				out[i].h += y1 - y0
				next[k] = i
			} else {
				out = append(out, rect{x0, y0, x1 - x0, y1 - y0})
				next[k] = len(out) - 1
			}
		}
		for tx := 0; tx < cols; tx++ {
			x0, x1 := tx*tile*4, min((tx+1)*tile, w)*4
			diff := false
			for y := y0; y < y1; y++ {
				o := y * stride
				if !bytes.Equal(prev[o+x0:o+x1], cur[o+x0:o+x1]) {
					diff = true
					break
				}
			}
			if diff {
				changed++
				if run < 0 {
					run = tx
				}
			} else if run >= 0 {
				flushRun(run, tx)
				run = -1
			}
		}
		if run >= 0 {
			flushRun(run, cols)
		}
		open = next
	}
	if changed*2 > cols*rows || len(out) > 80 {
		return []rect{{0, 0, w, h}}
	}
	return out
}

// toRGBA copies a BGRA rectangle into an RGBA image, optionally halving it (2x2 average).
func toRGBA(pix []byte, w int, r rect, scale int) *image.RGBA {
	stride := w * 4
	ow, oh := r.w/scale, r.h/scale
	if ow < 1 {
		ow = 1
	}
	if oh < 1 {
		oh = 1
	}
	img := image.NewRGBA(image.Rect(0, 0, ow, oh))
	if scale == 1 {
		for y := 0; y < r.h; y++ {
			src := pix[(r.y+y)*stride+r.x*4:]
			dst := img.Pix[y*img.Stride:]
			for x := 0; x < r.w; x++ {
				s, t := x*4, x*4
				dst[t], dst[t+1], dst[t+2], dst[t+3] = src[s+2], src[s+1], src[s], 255
			}
		}
		return img
	}
	for y := 0; y < oh; y++ {
		a := pix[(r.y+2*y)*stride+r.x*4:]
		b := a
		if r.y+2*y+1 < r.y+r.h {
			b = pix[(r.y+2*y+1)*stride+r.x*4:]
		}
		dst := img.Pix[y*img.Stride:]
		for x := 0; x < ow; x++ {
			s := x * 8
			t := x * 4
			for c := 0; c < 3; c++ {
				v := int(a[s+c]) + int(a[s+4+c]) + int(b[s+c]) + int(b[s+4+c])
				dst[t+2-c] = byte(v / 4)
			}
			dst[t+3] = 255
		}
	}
	return img
}

// Frame message (little endian): u8 version=1, u8 flags (1 = key frame), u16 width, u16 height,
// (2 = a text field has focus), u16 scale, i32 cursorX, i32 cursorY, u16 rect count, then per rect u16 x,y,w,h, u32 len, JPEG.
// Sizes and positions are in output pixels (after scaling).
func encodeFrame(pix []byte, w, h, cx, cy, scale, quality int, rects []rect, key, editing bool) []byte {
	var buf bytes.Buffer
	hdr := make([]byte, 18)
	hdr[0] = 1
	if key {
		hdr[1] = 1
	}
	if editing {
		hdr[1] |= 2 // text input focused: the phone opens its keyboard
	}
	binary.LittleEndian.PutUint16(hdr[2:], uint16(w/scale))
	binary.LittleEndian.PutUint16(hdr[4:], uint16(h/scale))
	binary.LittleEndian.PutUint16(hdr[6:], uint16(scale))
	if cx >= 0 {
		cx, cy = cx/scale, cy/scale
	}
	binary.LittleEndian.PutUint32(hdr[8:], uint32(int32(cx)))
	binary.LittleEndian.PutUint32(hdr[12:], uint32(int32(cy)))
	binary.LittleEndian.PutUint16(hdr[16:], uint16(len(rects)))
	buf.Write(hdr)
	var jb bytes.Buffer
	rh := make([]byte, 12)
	for _, r := range rects {
		jb.Reset()
		img := toRGBA(pix, w, r, scale)
		if err := jpeg.Encode(&jb, img, &jpeg.Options{Quality: quality}); err != nil {
			continue
		}
		binary.LittleEndian.PutUint16(rh[0:], uint16(r.x/scale))
		binary.LittleEndian.PutUint16(rh[2:], uint16(r.y/scale))
		binary.LittleEndian.PutUint16(rh[4:], uint16(img.Rect.Dx()))
		binary.LittleEndian.PutUint16(rh[6:], uint16(img.Rect.Dy()))
		binary.LittleEndian.PutUint32(rh[8:], uint32(jb.Len()))
		buf.Write(rh)
		buf.Write(jb.Bytes())
	}
	return buf.Bytes()
}

func (d *desktop) captureLoop() error {
	cp, err := newCapturer()
	if err != nil {
		return err
	}
	defer cp.close()
	const minGap = 66 * time.Millisecond // ~15 fps at most
	var prev []byte
	pedit := false
	pw, ph, pcx, pcy := 0, 0, -2, -2
	lastSent := time.Time{}
	fails := 0
	started := time.Now()
	for !d.stop.Load() {
		if time.Since(started) > 8*time.Hour {
			return errors.New("maximale sessieduur bereikt")
		}
		t0 := time.Now()
		pix, w, h, cx, cy, err := cp.grab()
		if err != nil {
			time.Sleep(300 * time.Millisecond)
			continue
		}
		if mw := int(d.shotReq.Swap(0)); mw > 0 {
			go d.sendShot(shotJPEG(pix, w, h, mw))
		}
		key := d.wantKey.Swap(false) || w != pw || h != ph || prev == nil
		var rects []rect
		if key {
			rects = []rect{{0, 0, w, h}}
		} else {
			rects = changedRects(prev, pix, w, h)
		}
		edit := d.editing.Load()
		if len(rects) == 0 && cx == pcx && cy == pcy && edit == pedit && time.Since(lastSent) < 5*time.Second {
			time.Sleep(minGap)
			continue
		}
		scale := int(d.scale.Load())
		msg := encodeFrame(pix, w, h, cx, cy, scale, int(d.quality.Load()), rects, key, edit)
		if cap(prev) < len(pix) {
			prev = make([]byte, len(pix))
		}
		prev = prev[:len(pix)]
		copy(prev, pix)
		pw, ph, pcx, pcy, pedit = w, h, cx, cy, edit
		c, err := d.call("/frame", "application/octet-stream", msg, 30*time.Second)
		if err != nil {
			fails++
			if fails > 10 {
				return fmt.Errorf("server onbereikbaar: %v", err)
			}
			d.wantKey.Store(true) // the viewer may have missed this frame
			time.Sleep(time.Second)
			continue
		}
		fails = 0
		lastSent = time.Now()
		d.applyCtl(c)
		if gap := minGap - time.Since(t0); gap > 0 {
			time.Sleep(gap)
		}
	}
	return nil
}

// shotJPEG: the whole screen, scaled down (box filter) to at most maxW wide, as u16 width, u16 height + JPEG.
func shotJPEG(pix []byte, w, h, maxW int) []byte {
	ow := w
	if ow > maxW {
		ow = maxW
	}
	oh := h * ow / w
	img := image.NewRGBA(image.Rect(0, 0, ow, oh))
	stride := w * 4
	for oy := 0; oy < oh; oy++ {
		y0, y1 := oy*h/oh, (oy+1)*h/oh
		if y1 <= y0 {
			y1 = y0 + 1
		}
		for ox := 0; ox < ow; ox++ {
			x0, x1 := ox*w/ow, (ox+1)*w/ow
			if x1 <= x0 {
				x1 = x0 + 1
			}
			var r, g, b, n int
			for y := y0; y < y1; y++ {
				row := pix[y*stride:]
				for x := x0; x < x1; x++ {
					b += int(row[x*4])
					g += int(row[x*4+1])
					r += int(row[x*4+2])
					n++
				}
			}
			t := oy*img.Stride + ox*4
			img.Pix[t], img.Pix[t+1], img.Pix[t+2], img.Pix[t+3] = byte(r/n), byte(g/n), byte(b/n), 255
		}
	}
	var buf bytes.Buffer
	hdr := make([]byte, 4)
	binary.LittleEndian.PutUint16(hdr[0:], uint16(ow))
	binary.LittleEndian.PutUint16(hdr[2:], uint16(oh))
	buf.Write(hdr)
	_ = jpeg.Encode(&buf, img, &jpeg.Options{Quality: 75})
	return buf.Bytes()
}

func (d *desktop) sendShot(b []byte) {
	if c, err := d.call("/shot", "application/octet-stream", b, 30*time.Second); err == nil {
		d.applyCtl(c)
	}
}

// fetch: raw bytes from the server for this session (the operator's photo)
func (d *desktop) fetch(path string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, d.base+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Remote-Key", d.key)
	res, err := d.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", res.StatusCode)
	}
	return io.ReadAll(io.LimitReader(res.Body, 2<<20))
}

// desktopLogPath: on macOS the helper runs as the logged-in user, who cannot write in the (root-only) config dir.
func desktopLogPath() string {
	if runtime.GOOS == "darwin" {
		return filepath.Join(os.TempDir(), fmt.Sprintf("claude-agent-desktop-%d.log", os.Getuid()))
	}
	return filepath.Join(configDir(), "desktop.log")
}
