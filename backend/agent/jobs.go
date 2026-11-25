package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"
)

const (
	maxOutput   = 256 << 10 // per command
	maxFileRead = 10 << 20
)

// capBuffer keeps the first maxOutput bytes and counts the rest.
type capBuffer struct {
	buf     bytes.Buffer
	dropped int
}

func (c *capBuffer) Write(p []byte) (int, error) {
	room := maxOutput - c.buf.Len()
	if room > 0 {
		if len(p) <= room {
			c.buf.Write(p)
		} else {
			c.buf.Write(p[:room])
			c.dropped += len(p) - room
		}
	} else {
		c.dropped += len(p)
	}
	return len(p), nil
}

func (c *capBuffer) String() string {
	if c.dropped > 0 {
		return c.buf.String() + fmt.Sprintf("\n[... %d bytes afgekapt]", c.dropped)
	}
	return c.buf.String()
}

func handleJob(ctx context.Context, cfg *Config, j Job) {
	start := time.Now()
	r := Result{ID: j.ID}
	defer func() {
		if p := recover(); p != nil {
			r.OK, r.Error = false, fmt.Sprint("agent-fout: ", p)
		}
		r.DurationMs = time.Since(start).Milliseconds()
		sendResult(ctx, cfg, r)
	}()

	switch j.Type {
	case "exec":
		timeout := time.Duration(j.TimeoutSec) * time.Second
		if timeout <= 0 {
			timeout = 120 * time.Second
		}
		out, code, err := runCommand(ctx, j.Shell, j.Command, timeout, j.RunAs == "user", j.Elevated)
		r.Output, r.ExitCode = out, code
		r.OK = err == nil && code == 0
		if err != nil {
			r.Error = err.Error()
		}
	case "read":
		st, err := os.Stat(j.Path)
		if err != nil {
			r.Error = err.Error()
			return
		}
		if st.IsDir() {
			r.Error = "is een map; gebruik een commando om de inhoud te tonen"
			return
		}
		if st.Size() > maxFileRead {
			r.Error = fmt.Sprintf("bestand te groot (%d bytes, max %d)", st.Size(), maxFileRead)
			return
		}
		b, err := os.ReadFile(j.Path)
		if err != nil {
			r.Error = err.Error()
			return
		}
		r.OK, r.DataB64 = true, base64.StdEncoding.EncodeToString(b)
	case "write":
		b, err := base64.StdEncoding.DecodeString(j.DataB64)
		if err != nil {
			r.Error = "ongeldige data"
			return
		}
		if err := os.MkdirAll(filepath.Dir(j.Path), 0o755); err != nil {
			r.Error = err.Error()
			return
		}
		if err := os.WriteFile(j.Path, b, 0o644); err != nil {
			r.Error = err.Error()
			return
		}
		r.OK, r.Output = true, fmt.Sprintf("%d bytes geschreven naar %s", len(b), j.Path)
	case "upload":
		size, err := startUpload(ctx, cfg, j.Xfer, j.Path)
		if err != nil {
			r.Error = err.Error()
			return
		}
		r.OK, r.Data = true, map[string]any{"size": size}
	case "download":
		if err := startDownload(ctx, cfg, j.Xfer, j.Path, j.Overwrite); err != nil {
			r.Error = err.Error()
			return
		}
		r.OK, r.Output = true, "download gestart"
	case "update":
		// j.Path = download URL of the installer (Windows) or install script (Mac)
		if err := startUpdate(j.Path); err != nil {
			r.Error = err.Error()
			return
		}
		r.OK, r.Output = true, "update gestart; de agent herstart over enkele seconden"
	case "remote":
		if err := startRemote(cfg.Server, j.Session, j.Key); err != nil {
			r.Error = err.Error()
			return
		}
		r.OK, r.Output = true, "meekijken gestart"
	case "sas":
		if err := sendSAS(); err != nil {
			r.Error = err.Error()
			return
		}
		r.OK, r.Output = true, "Ctrl+Alt+Del verstuurd"
	case "inventory":
		inv, err := collectInventory(ctx)
		if err != nil {
			r.Error = err.Error()
			return
		}
		r.OK, r.Data = true, inv
	default:
		r.Error = "onbekend jobtype: " + j.Type
	}
}

// runCommand runs a script in the requested shell. Windows: PowerShell (default) or cmd.
// Mac: zsh (default) or bash. Returns combined output and exit code.
func runCommand(ctx context.Context, shell, command string, timeout time.Duration, asUser, elevated bool) (string, int, error) {
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	var cmd *exec.Cmd
	var cleanup func()
	if runtime.GOOS == "windows" {
		switch shell {
		case "cmd":
			if asUser {
				return runAsUser(cctx, "cmd.exe", []string{"/d", "/c", "chcp 65001>nul & " + command}, elevated, timeout)
			}
			cmd = exec.CommandContext(cctx, "cmd.exe", "/d", "/c", "chcp 65001>nul & "+command)
		default:
			// A UTF-8 file with BOM, so Windows PowerShell 5.1 reads non-ASCII correctly
			tmpDir := ""
			if asUser {
				tmpDir = userTempDir() // leesbaar voor de gebruiker
			}
			f, err := os.CreateTemp(tmpDir, "claude-agent-*.ps1")
			if err != nil {
				return "", -1, err
			}
			script := "\ufeff$ProgressPreference='SilentlyContinue'\r\n[Console]::OutputEncoding=[System.Text.Encoding]::UTF8\r\n" + command
			_, _ = f.WriteString(script)
			_ = f.Close()
			cleanup = func() { _ = os.Remove(f.Name()) }
			exe := "powershell.exe"
			if shell == "pwsh" {
				exe = "pwsh.exe"
			}
			args := []string{"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", f.Name()}
			if asUser {
				defer cleanup()
				return runAsUser(cctx, exe, args, elevated, timeout)
			}
			cmd = exec.CommandContext(cctx, exe, args...)
		}
	} else {
		sh := "/bin/zsh"
		if shell == "bash" || shell == "sh" {
			sh = "/bin/bash"
		}
		if asUser {
			return runAsUser(cctx, sh, []string{"-c", command}, elevated, timeout)
		}
		cmd = exec.CommandContext(cctx, sh, "-c", command)
		cmd.Env = append(os.Environ(), "PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")
	}
	if cleanup != nil {
		defer cleanup()
	}
	var out capBuffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	cmd.WaitDelay = 5 * time.Second
	err := cmd.Run()
	if cctx.Err() == context.DeadlineExceeded {
		return out.String(), -1, fmt.Errorf("time-out na %s", timeout)
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return out.String(), ee.ExitCode(), nil
	}
	if err != nil {
		return out.String(), -1, err
	}
	return out.String(), 0, nil
}
