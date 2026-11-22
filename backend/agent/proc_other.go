//go:build !windows

package main

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"os/user"
	"strings"
	"syscall"
	"time"
)

// detach: own session, so launchd does not take it down with the agent's process group.
func detach(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}

func userTempDir() string { return "" }

// runAsUser (macOS): voer uit in de GUI-sessie van de ingelogde console-gebruiker.
func runAsUser(ctx context.Context, exe string, args []string, elevated bool, timeout time.Duration) (string, int, error) {
	if elevated {
		return "", -1, errors.New("elevated wordt op macOS niet ondersteund; gebruik runas=system")
	}
	b, err := exec.Command("/usr/bin/stat", "-f", "%Su", "/dev/console").Output()
	name := strings.TrimSpace(string(b))
	if err != nil || name == "" || name == "root" || name == "loginwindow" {
		return "", -1, errors.New("geen gebruiker ingelogd")
	}
	u, err := user.Lookup(name)
	if err != nil {
		return "", -1, err
	}
	full := append([]string{"asuser", u.Uid, "/usr/bin/sudo", "-u", name, "-H", "/usr/bin/env",
		"PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", exe}, args...)
	cmd := exec.CommandContext(ctx, "/bin/launchctl", full...)
	var out capBuffer
	cmd.Stdout, cmd.Stderr, cmd.WaitDelay = &out, &out, 5*time.Second
	err = cmd.Run()
	if ctx.Err() == context.DeadlineExceeded {
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
