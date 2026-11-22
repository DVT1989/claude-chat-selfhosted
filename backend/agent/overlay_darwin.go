//go:build darwin

package main

// macOS: "Sam kijkt mee" as a Dynamic Island at the top of the screen and a coloured halo with a name
// pill at the pointer ("Sam" blue, "Claude" orange), like on Windows. The agent is built without cgo,
// so the windows live in one long-running osascript (JXA/AppKit) process started by the desktop helper
// in the user's GUI session. Go writes the state as JSON to a file; the script polls it, follows the
// real pointer itself at 60 fps and prints "hangup" when the red button on the island is clicked.

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

type ovState struct {
	On        bool   `json:"on"`
	Name      string `json:"name,omitempty"`
	Accent    string `json:"accent,omitempty"`
	Initials  string `json:"initials,omitempty"`
	Avatar    string `json:"avatar,omitempty"`
	ClaudeAt  int64  `json:"claudeAt,omitempty"`
	Act       int64  `json:"act,omitempty"`
	ActClaude bool   `json:"actClaude,omitempty"`
}

type macOverlay struct {
	mu      sync.Mutex
	st      ovState
	base    string
	cmd     *exec.Cmd
	last    []byte
	hangup  func()
	stopped bool
}

var (
	ovOnce  sync.Once
	ovInst  *macOverlay
	hexRe   = regexp.MustCompile(`^#?[0-9a-fA-F]{6}$`)
)

func theOverlay() *macOverlay {
	ovOnce.Do(func() {
		ovInst = &macOverlay{base: filepath.Join(os.TempDir(), fmt.Sprintf("claude-agent-ov-%d", os.Getpid()))}
		if err := ovInst.start(); err != nil {
			log.Printf("overlay: %v", err)
		}
	})
	return ovInst
}

func (o *macOverlay) start() error {
	if err := os.WriteFile(o.base+".js", []byte(strings.Replace(overlayJS, "__CLAUDE_PATH__", claudePath, 1)), 0o600); err != nil {
		return err
	}
	o.mu.Lock()
	o.writeLocked()
	o.mu.Unlock()
	cmd := exec.Command("/usr/bin/osascript", "-l", "JavaScript", o.base+".js", o.base+".json")
	out, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	cmd.Stderr = log.Writer()
	if err := cmd.Start(); err != nil {
		return err
	}
	o.cmd = cmd
	go func() {
		sc := bufio.NewScanner(out)
		for sc.Scan() {
			if strings.TrimSpace(sc.Text()) == "hangup" {
				o.mu.Lock()
				f := o.hangup
				o.hangup = nil
				o.mu.Unlock()
				if f != nil {
					log.Printf("overlay: opgehangen vanaf de Mac")
					go f()
				}
			}
		}
		_ = cmd.Wait()
	}()
	return nil
}

// writeLocked writes the state atomically when it changed (o.mu held).
func (o *macOverlay) writeLocked() {
	if o.stopped {
		return
	}
	b, _ := json.Marshal(o.st)
	if string(b) == string(o.last) {
		return
	}
	o.last = b
	tmp := o.base + ".tmp"
	if os.WriteFile(tmp, b, 0o600) == nil {
		_ = os.Rename(tmp, o.base+".json")
	}
}

func (o *macOverlay) update(f func(*ovState)) {
	o.mu.Lock()
	f(&o.st)
	o.writeLocked()
	o.mu.Unlock()
}

func (o *macOverlay) stop() {
	o.mu.Lock()
	if o.stopped {
		o.mu.Unlock()
		return
	}
	o.st.On, o.st.Act = false, 0
	o.writeLocked()
	o.stopped = true
	cmd := o.cmd
	o.mu.Unlock()
	time.Sleep(450 * time.Millisecond) // let the island fold away
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
	for _, ext := range []string{".json", ".js", ".tmp", ".avatar"} {
		_ = os.Remove(o.base + ext)
	}
}

// ── name cursor ──

type nameCursor struct{ o *macOverlay }

func startOverlay() *nameCursor { return &nameCursor{o: theOverlay()} }

func (n *nameCursor) setName(name string) {
	n.o.update(func(s *ovState) { s.Name = name })
}

// show: the operator (or Claude) moved or clicked just now; the script follows the real pointer itself.
func (n *nameCursor) show(_, _ int, claude bool) {
	n.o.update(func(s *ovState) { s.Act, s.ActClaude = time.Now().UnixMilli(), claude })
}

func (n *nameCursor) close() { n.o.stop() }

// ── island ──

type banner struct{ o *macOverlay }

func startBanner() *banner { return &banner{o: theOverlay()} }

func (b *banner) set(on bool, name string) {
	b.o.update(func(s *ovState) {
		s.On = on
		if name != "" {
			s.Name = name
		}
	})
}

func (b *banner) look(accent, initials string, avatar []byte) {
	path := ""
	if len(avatar) > 0 && os.WriteFile(b.o.base+".avatar", avatar, 0o600) == nil {
		path = b.o.base + ".avatar"
	}
	b.o.update(func(s *ovState) {
		if hexRe.MatchString(accent) {
			s.Accent = "#" + strings.TrimPrefix(accent, "#")
		}
		if initials != "" {
			s.Initials = initials
		}
		if path != "" {
			s.Avatar = path
		}
	})
}

func (b *banner) claude() {
	b.o.update(func(s *ovState) { s.ClaudeAt = time.Now().UnixMilli() })
}

func (b *banner) setHangup(f func()) {
	b.o.mu.Lock()
	b.o.hangup = f
	b.o.mu.Unlock()
}

func (b *banner) close() { b.o.stop() }

const overlayJS = `ObjC.import('Cocoa');
ObjC.bindFunction('getppid', ['int', []]);

function run(argv) {
  var statePath = argv[0];
  var app = $.NSApplication.sharedApplication;
  app.setActivationPolicy(1); // accessory: no Dock icon, no menu bar
  var out = $.NSFileHandle.fileHandleWithStandardOutput;
  function send(s) { out.writeData($(s + '\n').dataUsingEncoding($.NSUTF8StringEncoding)); }

  function rgb(hex, a) {
    var n = parseInt(String(hex || '').replace('#', ''), 16);
    if (isNaN(n)) n = 0xCC785C;
    return $.NSColor.colorWithSRGBRedGreenBlueAlpha(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a == null ? 1 : a);
  }
  var GREEN = '#30D158', RED = '#FF453A', CLAUDE = '#D97757', BLUE = '#2563EB';
  var BEHAVIOR = 1 | 16 | 64 | 256; // all spaces, stationary, ignores cycle, full-screen auxiliary

  function panel(w, h, level) {
    var p = $.NSPanel.alloc.initWithContentRectStyleMaskBackingDefer($.NSMakeRect(0, 0, w, h), 128, 2, false); // borderless + nonactivating
    p.opaque = false;
    p.backgroundColor = $.NSColor.clearColor;
    p.level = level;
    p.collectionBehavior = BEHAVIOR;
    p.hidesOnDeactivate = false;
    p.releasedWhenClosed = false;
    p.contentView.wantsLayer = true;
    return p;
  }
  function label(size, weight, color) {
    var t = $.NSTextField.labelWithString($(''));
    t.font = $.NSFont.systemFontOfSizeWeight(size, weight);
    t.textColor = color;
    t.wantsLayer = true;
    return t;
  }
  // NSBox instead of CALayer colours: CGColor does not survive the JXA bridge
  function shape(parent) {
    var v = $.NSBox.alloc.initWithFrame($.NSMakeRect(0, 0, 1, 1));
    v.boxType = 4; // custom
    v.titlePosition = 0; // no title
    v.borderWidth = 0;
    v.contentViewMargins = $.NSMakeSize(0, 0);
    v.wantsLayer = true;
    parent.addSubview(v);
    return v;
  }
  function symbol(name, pt, color) {
    var iv = $.NSImageView.alloc.initWithFrame($.NSMakeRect(0, 0, 1, 1));
    var img = $.NSImage.imageWithSystemSymbolNameAccessibilityDescription($(name), $());
    if (img && !img.isNil()) {
      var cfg = $.NSImageSymbolConfiguration.configurationWithPointSizeWeight(pt, 0.3);
      iv.image = img.imageWithSymbolConfiguration(cfg);
    }
    iv.contentTintColor = color;
    iv.wantsLayer = true;
    return iv;
  }
  function setFrame(v, x, y, w, h) { v.frame = $.NSMakeRect(x, y, w, h); }

  // ── Island ──
  var isl = panel(300, 64, 25 + 1);
  isl.movableByWindowBackground = true;
  isl.hasShadow = true;
  var root = isl.contentView;
  var bg = shape(root);
  bg.fillColor = $.NSColor.colorWithSRGBRedGreenBlueAlpha(0, 0, 0, 0.96);
  bg.borderColor = $.NSColor.colorWithSRGBRedGreenBlueAlpha(1, 1, 1, 0.12);
  bg.borderWidth = 0.5;
  var av = shape(root);
  var avTxt = label(17, 0.4, $.NSColor.whiteColor);
  avTxt.alignment = 1; // center
  av.contentView.addSubview(avTxt);
  var avImg = $.NSImageView.alloc.initWithFrame($.NSMakeRect(0, 0, 1, 1));
  avImg.imageScaling = 3; // proportionally up or down
  avImg.wantsLayer = true;
  av.contentView.addSubview(avImg);
  // Official Claude logo (coral starburst on a dark tile, like Windows). Never a generic star/sparkle.
  function claudeLogo(px) {
    var img = $.NSImage.alloc.initWithSize($.NSMakeSize(px, px));
    img.lockFocus;
    var bp = $.NSBezierPath.bezierPath, k = px / 248;
    var toks = '__CLAUDE_PATH__'.match(/[MLHVCZ]|-?[0-9.]+/g), i = 0, cmd = '', x = 0, y = 0;
    function n() { return parseFloat(toks[i++]); }
    function P(px_, py_) { return $.NSMakePoint(px_ * k, (248 - py_) * k); }
    while (i < toks.length) {
      if (/[MLHVCZ]/.test(toks[i])) cmd = toks[i++];
      if (cmd === 'M') { x = n(); y = n(); bp.moveToPoint(P(x, y)); cmd = 'L'; }
      else if (cmd === 'L') { x = n(); y = n(); bp.lineToPoint(P(x, y)); }
      else if (cmd === 'H') { x = n(); bp.lineToPoint(P(x, y)); }
      else if (cmd === 'V') { y = n(); bp.lineToPoint(P(x, y)); }
      else if (cmd === 'C') { var a1 = n(), b1 = n(), a2 = n(), b2 = n(); x = n(); y = n(); bp.curveToPointControlPoint1ControlPoint2(P(x, y), P(a1, b1), P(a2, b2)); }
      else if (cmd === 'Z') { bp.closePath; }
      else i++;
    }
    rgb(CLAUDE).setFill;
    bp.fill;
    img.unlockFocus;
    return img;
  }
  var claudeSym = $.NSImageView.alloc.initWithFrame($.NSMakeRect(0, 0, 1, 1));
  claudeSym.imageScaling = 3;
  try { claudeSym.image = claudeLogo(96); } catch (e) { console.log('logo: ' + e); }
  av.contentView.addSubview(claudeSym);
  var small = label(12, 0.2, rgb('#9A9AA0'));
  var name = label(17, 0.4, $.NSColor.whiteColor);
  root.addSubview(small);
  root.addSubview(name);
  var dot = shape(root);
  var btn = shape(root);
  btn.fillColor = rgb(RED);
  var btnSym = symbol('phone.down.fill', 17, $.NSColor.whiteColor);
  btn.contentView.addSubview(btnSym);

  // ── Cursor label ──
  var cur = panel(200, 80, 2147483631 - 1);
  cur.ignoresMouseEvents = true;
  cur.sharingType = 0; // not in screen captures: the viewer has a pointer of their own
  var halo = shape(cur.contentView);
  var pill = shape(cur.contentView);
  pill.borderColor = $.NSColor.colorWithSRGBRedGreenBlueAlpha(1, 1, 1, 0.35);
  pill.borderWidth = 1;
  var pillTxt = label(12, 0.4, $.NSColor.whiteColor);
  cur.contentView.addSubview(pillTxt);

  // ── State ──
  var st = { on: false }, stRaw = '', missing = 0, avPath = '';
  function readState() {
    var s = $.NSString.stringWithContentsOfFileEncodingError($(statePath), $.NSUTF8StringEncoding, $());
    if (!s || s.isNil()) { missing++; return; }
    missing = 0;
    var raw = s.js;
    if (raw === stRaw) return;
    stRaw = raw;
    try { st = JSON.parse(raw); } catch (e) {}
    if ((st.avatar || '') !== avPath) {
      avPath = st.avatar || '';
      avImg.image = avPath ? $.NSImage.alloc.initWithContentsOfFile($(avPath)) : $();
    }
  }

  function spring(t) { return t >= 1 ? 1 : 1 - Math.exp(-6 * t) * Math.cos(9 * t); }
  function easeOut(t) { return t >= 1 ? 1 : 1 - Math.pow(1 - t, 3); }
  function now() { return Date.now(); }

  var scr = $.NSScreen.mainScreen;
  var vf = scr.visibleFrame;
  var cx = vf.origin.x + vf.size.width / 2, topY = vf.origin.y + vf.size.height - 8;
  var H = 64, HC = 40, MINW = 300;

  function target() {
    if (!st.on) return '';
    if (now() - (st.claudeAt || 0) < 4000) return 'claude';
    return 'user:' + (st.name || 'Beheerder');
  }
  function naturalW(text, compact) {
    var h = compact ? HC : H;
    var inset = h * 10 / 64, a = h - 2 * inset;
    if (compact) return Math.round(a + 2 * inset + 70);
    setTexts(text);
    var tw = Math.max(name.fittingSize.width, small.fittingSize.width + 12);
    return Math.max(MINW, Math.round(inset + a + 12 + tw + 16 + a + inset));
  }
  var textsFor = null;
  function setTexts(text) {
    if (textsFor === text + '|' + (st.initials || '') + '|' + (st.accent || '') + '|' + avPath) return;
    textsFor = text + '|' + (st.initials || '') + '|' + (st.accent || '') + '|' + avPath;
    var cl = text === 'claude';
    name.stringValue = $(cl ? 'Claude' : text.replace(/^user:/, ''));
    small.stringValue = $(cl ? 'werkt mee' : 'kijkt mee');
    av.fillColor = rgb(cl ? '#2A2338' : (st.accent || '#CC785C'));
    avTxt.stringValue = $(st.initials || (text.replace(/^user:/, '').charAt(0) || '?').toUpperCase());
    avImg.hidden = cl || !avPath;
    avTxt.hidden = cl || !!avPath;
    claudeSym.hidden = !cl;
    dot.fillColor = rgb(cl ? CLAUDE : GREEN);
  }

  // shown state
  var shownText = '', shownOn = false, compact = false, curW = HC, curH = HC;
  var anim = null, expandUntil = 0, hover = false, leaveAt = 0, lastOrigin = null;

  function layout(w, h, cmp, content, dotA) {
    var x = cx - w / 2, y = topY - h;
    var fr = isl.frame;
    if (lastOrigin && (Math.abs(fr.origin.x - lastOrigin[0]) > 0.5 || Math.abs(fr.origin.y + fr.size.height - lastOrigin[1]) > 0.5)) {
      // dragged aside by the user: keep the new spot for the rest of the session
      cx = fr.origin.x + fr.size.width / 2; topY = fr.origin.y + fr.size.height;
      x = cx - w / 2; y = topY - h;
    }
    isl.setFrameDisplay($.NSMakeRect(x, y, w, h), true);
    lastOrigin = [x, y + h];
    setFrame(bg, 0, 0, w, h);
    bg.cornerRadius = h / 2;
    var inset = h * 10 / 64, a = h - 2 * inset;
    setFrame(av, inset, inset, a, a);
    av.cornerRadius = a / 2;
    av.alphaValue = Math.min(1, content * 1.6);
    avTxt.font = $.NSFont.systemFontOfSizeWeight(Math.max(9, a * 0.38), 0.4);
    var th = avTxt.fittingSize.height;
    setFrame(avTxt, 0, (a - th) / 2, a, th);
    setFrame(avImg, 0, 0, a, a);
    avImg.layer.cornerRadius = a / 2; avImg.layer.masksToBounds = true;
    var ss = a * 0.64;
    setFrame(claudeSym, (a - ss) / 2, (a - ss) / 2, ss, ss);
    var d = 7;
    if (cmp) {
      small.alphaValue = 0; name.alphaValue = 0; btn.alphaValue = 0;
      d = 9;
      setFrame(dot, w - inset - a / 2 - d / 2 - 2, (h - d) / 2, d, d);
    } else {
      var tx = inset + a + 12;
      var nh = name.fittingSize.height, sh = small.fittingSize.height;
      var blockH = nh + sh - 2, by = (h - blockH) / 2;
      setFrame(name, tx, by, w - tx - a - inset - 12, nh);
      setFrame(small, tx + d + 5, by + nh - 2, w - tx - a - inset - 12, sh);
      setFrame(dot, tx + 1, by + nh - 2 + (sh - d) / 2, d, d);
      small.alphaValue = content; name.alphaValue = content;
      setFrame(btn, w - inset - a, inset, a, a);
      btn.cornerRadius = a / 2;
      btn.alphaValue = content;
      var bs = a * 0.42;
      setFrame(btnSym, (a - bs * 1.3) / 2, (a - bs) / 2, bs * 1.3, bs);
    }
    dot.cornerRadius = d / 2;
    dot.alphaValue = content * dotA;
  }

  function start(kind, toW, toH, cmp, text) {
    anim = { kind: kind, t0: now(), fromW: curW, fromH: curH, toW: toW, toH: toH, cmp: cmp, text: text };
    if (kind === 'in') {
      anim.fromW = HC; anim.fromH = HC;
      shownOn = true;
      isl.orderFrontRegardless;
    }
    if (kind === 'out') { anim.toW = curH; anim.toH = curH; }
  }

  function islandFrame() {
    var mouse = $.NSEvent.mouseLocation, fr = isl.frame;
    var inside = shownOn && mouse.x >= fr.origin.x && mouse.x <= fr.origin.x + fr.size.width && mouse.y >= fr.origin.y && mouse.y <= fr.origin.y + fr.size.height;
    if (inside !== hover) { hover = inside; if (!inside) leaveAt = now(); }
    var text = target();
    var wantC = !hover && now() > expandUntil && now() - leaveAt > 500;
    if (!anim) {
      if (text === '' && shownOn) start('out', 0, 0, compact, shownText);
      else if (text !== '' && !shownOn) { expandUntil = now() + 3000; start('in', naturalW(text, false), H, false, text); }
      else if (text !== '' && text !== shownText) { expandUntil = now() + 2500; start('size', naturalW(text, false), H, false, text); }
      else if (text !== '' && wantC !== compact) start('size', naturalW(text, wantC), wantC ? HC : H, wantC, text);
    }
    var pulse = 0.55 + 0.45 * (0.5 + 0.5 * Math.cos(now() / 1000 * Math.PI * 2 / 1.8));
    if (anim) {
      var dur = anim.kind === 'out' ? 300 : 550;
      var t = Math.min(1, (now() - anim.t0) / dur);
      var k = anim.kind === 'out' ? easeOut(t) : spring(t);
      var w = anim.fromW + (anim.toW - anim.fromW) * k, h = anim.fromH + (anim.toH - anim.fromH) * k;
      setTexts(anim.text);
      var content = anim.kind === 'out' ? Math.max(0, 1 - t * 2.5) : anim.kind === 'in' ? Math.max(0, (t - 0.3) / 0.5) : 1;
      if (anim.kind === 'size' && anim.cmp !== compact) content = Math.abs(t - 0.5) * 2; // cross-fade at the halfway point
      var cmpNow = anim.kind === 'size' && anim.cmp !== compact ? (t > 0.5 ? anim.cmp : compact) : anim.cmp;
      layout(Math.max(h, w), Math.max(4, h), cmpNow, Math.min(1, content), pulse);
      if (anim.kind === 'out') isl.alphaValue = 1 - Math.max(0, (t - 0.6) / 0.4);
      else isl.alphaValue = 1;
      curW = Math.max(h, w); curH = h;
      if (t >= 1) {
        if (anim.kind === 'out') { isl.orderOut($()); shownOn = false; shownText = ''; curW = HC; curH = HC; lastOrigin = null; }
        else { shownText = anim.text; compact = anim.cmp; curW = anim.toW; curH = anim.toH; isl.invalidateShadow; }
        anim = null;
      }
    } else if (shownOn) {
      dot.alphaValue = pulse;
    }
    // red button: press and release on it ends the session
    if (shownOn && !compact && !anim) {
      var m = $.NSEvent.mouseLocation, f = isl.frame;
      var inset = curH * 10 / 64, a = curH - 2 * inset;
      var bx = f.origin.x + f.size.width - inset - a, by = f.origin.y + inset;
      var onBtn = m.x >= bx && m.x <= bx + a && m.y >= by && m.y <= by + a;
      var down = ($.NSEvent.pressedMouseButtons & 1) !== 0;
      if (onBtn !== btnHot) { btnHot = onBtn; btn.fillColor = rgb(onBtn ? '#FF6961' : RED); }
      if (down && !btnWasDown) btnPress = onBtn;
      if (!down && btnWasDown && btnPress && onBtn) { send('hangup'); st.on = false; }
      btnWasDown = down;
    }
  }
  var btnWasDown = false, btnPress = false, btnHot = false;

  // cursor label
  var curShown = '', curVisible = false;
  function cursorFrame() {
    var idle = now() - (st.act || 0);
    var a = idle < 2500 ? 1 : idle < 3000 ? 1 - (idle - 2500) / 500 : 0;
    if (a <= 0) { if (curVisible) { cur.orderOut($()); curVisible = false; } return; }
    var cl = !!st.actClaude;
    var text = cl ? 'Claude' : (st.name || 'Beheerder');
    var col = cl ? CLAUDE : BLUE;
    if (text + cl !== curShown) {
      curShown = text + cl;
      pillTxt.stringValue = $(text);
      pill.fillColor = rgb(col);
      halo.fillColor = rgb(col, 0.22);
      halo.borderColor = rgb(col, 0.9);
      halo.borderWidth = 2;
    }
    var tw = Math.ceil(pillTxt.fittingSize.width), th = Math.ceil(pillTxt.fittingSize.height);
    var R = 15, ph = 22, pw = tw + 18, ox = 18, oy = 20; // pill sits right-below the pointer tip
    var W = R + ox + pw + 8, Hh = R + oy + ph + 8;
    var m = $.NSEvent.mouseLocation;
    cur.setFrameDisplay($.NSMakeRect(m.x - R, m.y - Hh + R, W, Hh), false);
    setFrame(halo, 0, Hh - 2 * R, 2 * R, 2 * R);
    halo.cornerRadius = R;
    setFrame(pill, R + ox - 6, Hh - R - oy - ph, pw, ph);
    pill.cornerRadius = ph / 2;
    setFrame(pillTxt, R + ox - 6 + 9, Hh - R - oy - ph + (ph - th) / 2, tw + 2, th);
    cur.alphaValue = a;
    if (!curVisible) { cur.orderFrontRegardless; curVisible = true; }
  }

  var lastRead = 0;
  while (true) {
    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(1 / 60));
    var ev;
    while ((ev = app.nextEventMatchingMaskUntilDateInModeDequeue(-1, $(), $.NSDefaultRunLoopMode, true)) && !ev.isNil()) app.sendEvent(ev);
    if (now() - lastRead > 100) {
      lastRead = now();
      readState();
      if (missing > 20 || $.getppid() === 1) break; // the helper is gone
    }
    islandFrame();
    cursorFrame();
  }
}
`
