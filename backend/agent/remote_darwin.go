//go:build darwin

package main

// macOS: screen capture and input for "meekijken" without cgo and without extra installs.
//   - The root daemon starts the desktop helper as the logged-in user through a launchd job in
//     that user's GUI domain (gui/<uid>), so the helper (and its children) are one TCC "responsible
//     process": the user grants Schermopname and Toegankelijkheid once to "Claude Agent" (/Applications/Claude Agent.app).
//   - Capture: /usr/sbin/screencapture (JPEG, Retina scaled down to points).
//   - Input: JXA (osascript) posting CGEvents; one call per batch of events.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	_ "image/jpeg"
	"log"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const remoteSupported = true

const permsJS = `ObjC.import('ApplicationServices');
ObjC.import('CoreGraphics');
ObjC.import('Foundation');
ObjC.import('AppKit');
ObjC.bindFunction('CGPreflightScreenCaptureAccess', ['bool', []]);
ObjC.bindFunction('CGRequestScreenCaptureAccess', ['bool', []]);
function run(argv) {
  if (argv[0] === 'request') {
    $.CGRequestScreenCaptureAccess();
    $.AXIsProcessTrustedWithOptions($({ AXTrustedCheckOptionPrompt: true }));
  }
  var f = $.NSScreen.mainScreen.backingScaleFactor;
  var b = $.CGDisplayBounds($.CGMainDisplayID());
  return JSON.stringify({ screen: !!$.CGPreflightScreenCaptureAccess(), accessibility: !!$.AXIsProcessTrusted(), w: b.size.width, h: b.size.height, scale: f });
}
`

const inputJS = `ObjC.import('ApplicationServices');
ObjC.import('CoreGraphics');
ObjC.import('Foundation');
ObjC.import('AppKit');
function run(argv) {
  var ops = JSON.parse(argv[0]);
  var nch = 0;
  var b = $.CGDisplayBounds($.CGMainDisplayID());
  var W = b.size.width, H = b.size.height;
  var BTN = [0, 2, 1], DOWN = [1, 25, 3], UP = [2, 26, 4], DRAG = [6, 27, 7];
  function pt(o) { return { x: b.origin.x + o.x / 65535 * (W - 1), y: b.origin.y + o.y / 65535 * (H - 1) }; }
  function post(ev, fl) { $.CGEventSetFlags(ev, fl || 0); $.CGEventPost(0, ev); }
  var errs = [];
  ops.forEach(function (o) {
    try {
      if (o.t === 'move') {
        var drag = o.drag >= 0;
        post($.CGEventCreateMouseEvent(null, drag ? DRAG[o.drag] : 5, pt(o), drag ? BTN[o.drag] : 0), o.fl);
      } else if (o.t === 'down' || o.t === 'up') {
        var ev = $.CGEventCreateMouseEvent(null, (o.t === 'down' ? DOWN : UP)[o.b], pt(o), BTN[o.b]);
        $.CGEventSetIntegerValueField(ev, 1, o.n || 1);
        post(ev, o.fl);
      } else if (o.t === 'scroll') {
        post($.CGEventCreateScrollWheelEvent2(null, 0, 2, o.dy | 0, o.dx | 0, 0), o.fl);
      } else if (o.t === 'key') {
        post($.CGEventCreateKeyboardEvent(null, o.kc, o.down), o.fl);
      } else if (o.t === 'ch') {
        // one character: NSEvent with explicit characters (layout-independent), keycode+shift as fallback
        var fl = o.sh ? 131072 : 0;
        [true, false].forEach(function (down) {
          var ev = null;
          try {
            var ne = $.NSEvent.keyEventWithTypeLocationModifierFlagsTimestampWindowNumberContextCharactersCharactersIgnoringModifiersIsARepeatKeyCode(down ? 10 : 11, { x: 0, y: 0 }, fl, 0, 0, $(), $(o.c), $(o.c), false, o.kc);
            if (ne && !ne.isNil()) ev = ne.CGEvent;
          } catch (e) {}
          if (!ev) ev = $.CGEventCreateKeyboardEvent(null, o.kc, down);
          post(ev, fl);
        });
        if (++nch % 20 === 0) delay(0.01);
      }
    } catch (e) { errs.push(o.t + ': ' + e); }
  });
  return errs.join('; ');
}
`

const (
	appBin    = "/Applications/Claude Agent.app/Contents/MacOS/claude-agent"
	oldBin    = "/usr/local/claude-agent/claude-agent"
	jobPrefix = "nl.claudechat.agent.job."
	permsHelp = "Open Systeeminstellingen > Privacy en beveiliging. Zet bij Schermopname en bij Toegankelijkheid 'Claude Agent' aan. Staat hij er al en blijft dit staan: selecteer 'Claude Agent', klik op - om hem te verwijderen, klik op + en kies Programma's > Claude Agent, zet de schakelaar aan en doe dit bij beide lijsten. Start daarna opnieuw."
	permsNotice = "Claude Agent mist toestemming voor Schermopname/Toegankelijkheid. Zet 'Claude Agent' aan in Systeeminstellingen > Privacy en beveiliging."
)

// agentBin: the binary inside "Claude Agent.app" (name + icon in Privacy & Security), or the old loose binary.
var agentBin = func() string {
	if _, err := os.Stat(appBin); err == nil {
		return appBin
	}
	return oldBin
}()

var errNoRemote = errors.New("Ctrl+Alt+Del bestaat niet op een Mac")

func sendSAS() error                               { return errNoRemote }
func setDPIAware()                                 {}
func watchEditable(_ *atomic.Bool, _ *atomic.Bool) {}

// ── Console user and launchd jobs ───────────────────────────

func consoleUser() (*user.User, error) {
	b, err := exec.Command("/usr/bin/stat", "-f", "%Su", "/dev/console").Output()
	name := strings.TrimSpace(string(b))
	if err != nil || name == "" || name == "root" || name == "loginwindow" {
		return nil, errors.New("er is niemand ingelogd op de Mac")
	}
	return user.Lookup(name)
}

var jobSeq atomic.Int64

// userJob runs claude-agent <args> as the console user in the GUI session, via a one-off launchd job.
// With wait > 0 it waits for the job to finish and returns what it printed.
func userJob(label string, args []string, wait time.Duration) (string, error) {
	u, err := consoleUser()
	if err != nil {
		return "", err
	}
	uid, _ := strconv.Atoi(u.Uid)
	gid, _ := strconv.Atoi(u.Gid)
	domain := "gui/" + u.Uid
	full := jobPrefix + label
	_ = exec.Command("/bin/launchctl", "bootout", domain+"/"+full).Run()
	dir := filepath.Join(configDir(), "jobs")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	out := filepath.Join("/private/tmp", fmt.Sprintf("claude-agent-%s-%d.out", label, jobSeq.Add(1)))
	if err := os.WriteFile(out, nil, 0o600); err != nil {
		return "", err
	}
	_ = os.Chown(out, uid, gid)
	defer os.Remove(out)
	var pa strings.Builder
	for _, a := range append([]string{agentBin}, args...) {
		var x bytes.Buffer
		_ = xmlEscape(&x, a)
		pa.WriteString("<string>" + x.String() + "</string>")
	}
	plist := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>%s</string>
<key>ProgramArguments</key><array>%s</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><false/>
<key>ProcessType</key><string>Interactive</string>
<key>StandardOutPath</key><string>%s</string>
<key>StandardErrorPath</key><string>%s</string>
</dict></plist>`, full, pa.String(), out, out)
	pp := filepath.Join(dir, label+".plist")
	if err := os.WriteFile(pp, []byte(plist), 0o600); err != nil {
		return "", err
	}
	defer os.Remove(pp)
	if b, err := exec.Command("/bin/launchctl", "bootstrap", domain, pp).CombinedOutput(); err != nil {
		return "", fmt.Errorf("launchctl bootstrap: %v %s", err, strings.TrimSpace(string(b)))
	}
	if wait <= 0 {
		return "", nil
	}
	deadline := time.Now().Add(wait)
	for time.Now().Before(deadline) {
		time.Sleep(150 * time.Millisecond)
		// the job is gone from launchd when it has finished and is not kept alive
		if exec.Command("/bin/launchctl", "print", domain+"/"+full).Run() != nil || jobDone(domain+"/"+full) {
			break
		}
	}
	b, _ := os.ReadFile(out)
	_ = exec.Command("/bin/launchctl", "bootout", domain+"/"+full).Run()
	return strings.TrimSpace(string(b)), nil
}

func jobDone(target string) bool {
	b, err := exec.Command("/bin/launchctl", "print", target).Output()
	return err == nil && bytes.Contains(b, []byte("state = not running")) && bytes.Contains(b, []byte("last exit code"))
}

func xmlEscape(w *bytes.Buffer, s string) error {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;")
	_, err := w.WriteString(r.Replace(s))
	return err
}

// ── Permissions ─────────────────────────────────────────────

type permState struct {
	Screen        bool    `json:"screen"`
	Accessibility bool    `json:"accessibility"`
	W             float64 `json:"w"`
	H             float64 `json:"h"`
	Scale         float64 `json:"scale"`
}

var (
	permMu   sync.Mutex
	permLast *permState
)

// runMacPerms is the "mac-perms [check|request]" subcommand: runs as the user in the GUI session.
func runMacPerms(args []string) {
	mode := "check"
	if len(args) > 0 {
		mode = args[0]
	}
	p := filepath.Join(os.TempDir(), fmt.Sprintf("claude-agent-perms-%d.js", os.Getuid()))
	if err := os.WriteFile(p, []byte(permsJS), 0o600); err != nil {
		fmt.Println(`{"error":"` + err.Error() + `"}`)
		return
	}
	defer os.Remove(p)
	out, err := exec.Command("/usr/bin/osascript", "-l", "JavaScript", p, mode).CombinedOutput()
	if err != nil {
		fmt.Printf(`{"error":%q}`+"\n", strings.TrimSpace(string(out)))
		return
	}
	fmt.Println(strings.TrimSpace(string(out)))
}

func checkPerms(mode string) (*permState, error) {
	out, err := userJob("perms", []string{"mac-perms", mode}, 20*time.Second)
	if err != nil {
		return nil, err
	}
	var st permState
	if i := strings.LastIndex(out, "{"); i >= 0 {
		out = out[i:]
	}
	if err := json.Unmarshal([]byte(out), &st); err != nil {
		return nil, fmt.Errorf("toestemmingen controleren mislukt: %s", firstLine(out))
	}
	permMu.Lock()
	permLast = &st
	permMu.Unlock()
	return &st, nil
}

// remotePerms: last known state, sent to the server with every poll (nil = unknown).
func remotePerms() map[string]bool {
	permMu.Lock()
	defer permMu.Unlock()
	if permLast == nil {
		return nil
	}
	return map[string]bool{"screen": permLast.Screen, "accessibility": permLast.Accessibility}
}

func startPlatformLoops(ctx context.Context) {
	sleepCtx(ctx, 10*time.Second)
	asked := false
	for ctx.Err() == nil {
		st, err := checkPerms("check")
		if err != nil {
			log.Printf("toestemmingen: %v", err)
		} else if !asked && (!st.Screen || !st.Accessibility) {
			asked = true // once per start of the agent (also after an update that reset the permissions)
			go requestPermsOnce()
		}
		sleepCtx(ctx, 90*time.Second)
	}
}

// ── Starting the helper ─────────────────────────────────────

func startRemote(session, key string) error {
	st, err := checkPerms("check")
	if err != nil {
		return err
	}
	if !st.Screen || !st.Accessibility {
		var miss []string
		if !st.Screen {
			miss = append(miss, "Schermopname")
		}
		if !st.Accessibility {
			miss = append(miss, "Toegankelijkheid")
		}
		go requestPermsOnce()
		return errors.New("Toestemming ontbreekt op de Mac: " + strings.Join(miss, " en ") + ". " + permsHelp)
	}
	server := ""
	if cfg, err := loadConfig(); err == nil {
		server = cfg.Server
	}
	_, err = userJob("desktop", []string{"desktop", "--session", session, "--key", key, "--server", server}, 0)
	return err
}

var lastAsk atomic.Int64

// requestPermsOnce opens the system prompts and the settings panes (at most once per 10 minutes).
func requestPermsOnce() {
	now := time.Now().Unix()
	if old := lastAsk.Load(); now-old < 600 || !lastAsk.CompareAndSwap(old, now) {
		return
	}
	_, _ = checkPerms("request")
	_ = openPane("Privacy_ScreenCapture")
	_ = openPane("Privacy_Accessibility")
	// Typical after an update: the switch stays on but the permission no longer applies; explain what to do.
	if u, err := consoleUser(); err == nil {
		_ = exec.Command("/bin/launchctl", "asuser", u.Uid, "/usr/bin/osascript", "-e", `display notification "`+permsNotice+`" with title "Claude Agent"`).Run()
	}
}

func openPane(name string) error {
	u, err := consoleUser()
	if err != nil {
		return err
	}
	return exec.Command("/bin/launchctl", "asuser", u.Uid, "/usr/bin/open", "x-apple.systempreferences:com.apple.preference.security?"+name).Run()
}

// ── Capture ─────────────────────────────────────────────────

type macCapturer struct {
	file string
	ptsW int
	pxW  int
	buf  []byte
}

func newCapturer() (capturer, error) {
	return &macCapturer{file: filepath.Join(os.TempDir(), fmt.Sprintf("claude-agent-shot-%d.jpg", os.Getpid()))}, nil
}

func (c *macCapturer) close() { _ = os.Remove(c.file) }

// pointsWidth asks the display size in points (once per pixel width).
func (c *macCapturer) pointsWidth(pxW int) int {
	if c.pxW == pxW && c.ptsW > 0 {
		return c.ptsW
	}
	c.pxW = pxW
	c.ptsW = pxW
	p := filepath.Join(os.TempDir(), fmt.Sprintf("claude-agent-perms-%d.js", os.Getpid()))
	if os.WriteFile(p, []byte(permsJS), 0o600) == nil {
		defer os.Remove(p)
		if out, err := exec.Command("/usr/bin/osascript", "-l", "JavaScript", p, "check").Output(); err == nil {
			var st permState
			if json.Unmarshal(bytes.TrimSpace(out), &st) == nil && st.W > 0 {
				c.ptsW = int(st.W)
			}
		}
	}
	return c.ptsW
}

func (c *macCapturer) grab() ([]byte, int, int, int, int, error) {
	if out, err := exec.Command("/usr/sbin/screencapture", "-x", "-C", "-t", "jpg", c.file).CombinedOutput(); err != nil {
		return nil, 0, 0, 0, 0, fmt.Errorf("screencapture: %v %s", err, strings.TrimSpace(string(out)))
	}
	f, err := os.Open(c.file)
	if err != nil {
		return nil, 0, 0, 0, 0, err
	}
	defer f.Close()
	img, _, err := image.Decode(f)
	if err != nil {
		return nil, 0, 0, 0, 0, err
	}
	b := img.Bounds()
	pw, ph := b.Dx(), b.Dy()
	f1 := 1
	if pts := c.pointsWidth(pw); pts > 0 && pw/pts >= 2 {
		f1 = pw / pts
	}
	w, h := pw/f1, ph/f1
	if cap(c.buf) < w*h*4 {
		c.buf = make([]byte, w*h*4)
	}
	c.buf = c.buf[:w*h*4]
	yc, isYC := img.(*image.YCbCr)
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			var r, g, bl, n uint32
			for dy := 0; dy < f1; dy++ {
				for dx := 0; dx < f1; dx++ {
					sx, sy := b.Min.X+x*f1+dx, b.Min.Y+y*f1+dy
					var cr, cg, cb uint8
					if isYC {
						cr, cg, cb = color.YCbCrToRGB(yc.Y[yc.YOffset(sx, sy)], yc.Cb[yc.COffset(sx, sy)], yc.Cr[yc.COffset(sx, sy)])
					} else {
						r16, g16, b16, _ := img.At(sx, sy).RGBA()
						cr, cg, cb = uint8(r16>>8), uint8(g16>>8), uint8(b16>>8)
					}
					r += uint32(cr)
					g += uint32(cg)
					bl += uint32(cb)
					n++
				}
			}
			o := (y*w + x) * 4
			c.buf[o], c.buf[o+1], c.buf[o+2], c.buf[o+3] = byte(bl/n), byte(g/n), byte(r/n), 255
		}
	}
	return c.buf, w, h, -1, -1, nil
}

// ── Input ───────────────────────────────────────────────────

const (
	flShift = 0x20000
	flCtrl  = 0x40000
	flAlt   = 0x80000
	flCmd   = 0x100000
)

var macKeys = map[string]int{
	"KeyA": 0, "KeyS": 1, "KeyD": 2, "KeyF": 3, "KeyH": 4, "KeyG": 5, "KeyZ": 6, "KeyX": 7, "KeyC": 8, "KeyV": 9, "IntlBackslash": 10,
	"KeyB": 11, "KeyQ": 12, "KeyW": 13, "KeyE": 14, "KeyR": 15, "KeyY": 16, "KeyT": 17,
	"Digit1": 18, "Digit2": 19, "Digit3": 20, "Digit4": 21, "Digit6": 22, "Digit5": 23, "Equal": 24, "Digit9": 25, "Digit7": 26,
	"Minus": 27, "Digit8": 28, "Digit0": 29, "BracketRight": 30, "KeyO": 31, "KeyU": 32, "BracketLeft": 33, "KeyI": 34, "KeyP": 35,
	"Enter": 36, "KeyL": 37, "KeyJ": 38, "Quote": 39, "KeyK": 40, "Semicolon": 41, "Backslash": 42, "Comma": 43, "Slash": 44,
	"KeyN": 45, "KeyM": 46, "Period": 47, "Tab": 48, "Space": 49, "Backquote": 50, "Backspace": 51, "Escape": 53,
	"MetaRight": 54, "MetaLeft": 55, "ShiftLeft": 56, "CapsLock": 57, "AltLeft": 58, "ControlLeft": 59,
	"ShiftRight": 60, "AltRight": 61, "ControlRight": 62, "NumpadEnter": 76,
	"F5": 96, "F6": 97, "F7": 98, "F3": 99, "F8": 100, "F9": 101, "F11": 103, "F10": 109, "F12": 111, "F4": 118, "F2": 120, "F1": 122,
	"Home": 115, "PageUp": 116, "Delete": 117, "End": 119, "PageDown": 121, "ArrowLeft": 123, "ArrowRight": 124, "ArrowDown": 125, "ArrowUp": 126,
}

var macMods = map[string]int{
	"ShiftLeft": flShift, "ShiftRight": flShift, "ControlLeft": flCtrl, "ControlRight": flCtrl,
	"AltLeft": flAlt, "AltRight": flAlt, "MetaLeft": flCmd, "MetaRight": flCmd,
}

type macInjector struct {
	script    string
	ops       []map[string]any
	mask      int
	held      int // button held (web numbering), -1 none
	clicks    int
	lastClick time.Time
	lastX     int
	lastY     int
	lastB     int
}

func newInjector() injector {
	p := filepath.Join(os.TempDir(), fmt.Sprintf("claude-agent-input-%d.js", os.Getpid()))
	if err := os.WriteFile(p, []byte(inputJS), 0o600); err != nil {
		log.Printf("invoer: %v", err)
		return nil
	}
	return &macInjector{script: p, held: -1}
}

func (m *macInjector) begin() { m.ops = m.ops[:0] }

func (m *macInjector) apply(ev inputEvent) {
	switch ev.T {
	case "m":
		if n := len(m.ops); n > 0 && m.ops[n-1]["t"] == "move" && m.ops[n-1]["drag"] == m.held {
			m.ops = m.ops[:n-1] // only the last position of a run of moves matters
		}
		m.ops = append(m.ops, map[string]any{"t": "move", "x": ev.X, "y": ev.Y, "drag": m.held, "fl": m.mask})
	case "d":
		near := abs(ev.X-m.lastX) < 400 && abs(ev.Y-m.lastY) < 400
		if time.Since(m.lastClick) < 450*time.Millisecond && near && ev.B == m.lastB {
			m.clicks++
		} else {
			m.clicks = 1
		}
		m.lastClick, m.lastX, m.lastY, m.lastB = time.Now(), ev.X, ev.Y, ev.B
		m.held = ev.B
		m.ops = append(m.ops, map[string]any{"t": "down", "b": ev.B, "x": ev.X, "y": ev.Y, "n": m.clicks, "fl": m.mask})
	case "u":
		m.held = -1
		m.ops = append(m.ops, map[string]any{"t": "up", "b": ev.B, "x": ev.X, "y": ev.Y, "n": m.clicks, "fl": m.mask})
	case "w":
		// viewer: 120 per notch, positive = down; pixel scroll on the Mac: positive = up
		m.ops = append(m.ops, map[string]any{"t": "scroll", "dy": -ev.DY / 2, "dx": -ev.DX / 2, "fl": m.mask})
	case "k":
		kc, ok := macKeys[ev.C]
		if !ok {
			return
		}
		if f, isMod := macMods[ev.C]; isMod {
			if ev.Down {
				m.mask |= f
			} else {
				m.mask &^= f
			}
		}
		m.ops = append(m.ops, map[string]any{"t": "key", "kc": kc, "down": ev.Down, "fl": m.mask})
	case "text":
		m.ops = append(m.ops, map[string]any{"t": "text", "s": strings.ReplaceAll(ev.S, "\r", ""), "fl": 0})
	}
}

func abs(a int) int {
	if a < 0 {
		return -a
	}
	return a
}

// end sends the batch: one osascript call.
func (m *macInjector) end() {
	if len(m.ops) == 0 {
		return
	}
	// "\n" in text becomes Return
	var ops []map[string]any
	for _, o := range m.ops {
		if o["t"] == "text" {
			parts := strings.Split(o["s"].(string), "\n")
			for i, p := range parts {
				if i > 0 {
					ops = append(ops, map[string]any{"t": "key", "kc": 36, "down": true, "fl": 0}, map[string]any{"t": "key", "kc": 36, "down": false, "fl": 0})
				}
				for _, r := range p {
					kc, sh := macCharKey(r)
					ops = append(ops, map[string]any{"t": "ch", "c": string(r), "kc": kc, "sh": sh})
				}
			}
			continue
		}
		ops = append(ops, o)
	}
	b, _ := json.Marshal(ops)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if out, err := exec.CommandContext(ctx, "/usr/bin/osascript", "-l", "JavaScript", m.script, string(b)).CombinedOutput(); err != nil || len(bytes.TrimSpace(out)) > 0 {
		log.Printf("invoer: %v %s", err, strings.TrimSpace(string(out)))
	}
	m.ops = m.ops[:0]
}

func (m *macInjector) close() { _ = os.Remove(m.script) }

// ── Notices ──
// The island and the name cursor: overlay_darwin.go.

func notify(text string) {
	s := strings.NewReplacer(`\`, ``, `"`, `'`).Replace(text)
	_ = exec.Command("/usr/bin/osascript", "-e", `display notification "`+s+`" with title "Claude Agent"`).Run()
}

// macCharKey: US-layout keycode and shift for a character (keycode 0 + characters for the rest)
func macCharKey(r rune) (int, bool) {
	const lower = "asdfhgzxcv\x00bqweryt123465=97-80]ou[ip\x00lj'k;\\,/nm.\t `"
	const upper = "ASDFHGZXCV\x00BQWERYT!@#$^%+(&_*)}OU{IP\x00LJ\"K:|<?NM>\t ~"
	if r < 128 && r != 0 {
		if i := strings.IndexRune(lower, r); i >= 0 {
			return i, false
		}
		if i := strings.IndexRune(upper, r); i >= 0 {
			return i, true
		}
	}
	return 0, false
}
