//go:build windows

package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// detach: the update must outlive this service process.
func detach(cmd *exec.Cmd) {
	const detachedProcess = 0x00000008
	const createNewProcessGroup = 0x00000200
	const createBreakawayFromJob = 0x01000000
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: detachedProcess | createNewProcessGroup | createBreakawayFromJob, HideWindow: true}
}

var runDirACL sync.Once

// userTempDir: scripts for "as signed-in user" live here. The agent folder itself is locked to SYSTEM
// and Administrators (the installer sets that), so the users group gets read access to this subfolder only.
func userTempDir() string {
	d := filepath.Join(os.Getenv("ProgramData"), "ClaudeAgent", "run")
	_ = os.MkdirAll(d, 0o755)
	runDirACL.Do(func() {
		cmd := exec.Command("icacls.exe", d, "/grant", "*S-1-5-32-545:(OI)(CI)RX")
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
		_ = cmd.Run()
	})
	return d
}

var (
	modWtsapi32       = windows.NewLazySystemDLL("wtsapi32.dll")
	procWTSQueryToken = modWtsapi32.NewProc("WTSQueryUserToken")
)

// runAsUser: start het proces in de actieve console-sessie van de ingelogde gebruiker.
// elevated: gebruik het gekoppelde (admin) token als de gebruiker lid is van Administrators.
func runAsUser(ctx context.Context, exe string, args []string, elevated bool, timeout time.Duration) (string, int, error) {
	sid := windows.WTSGetActiveConsoleSessionId()
	if sid == 0xFFFFFFFF {
		return "", -1, errors.New("geen gebruiker ingelogd")
	}
	var tok windows.Token
	if r, _, e := procWTSQueryToken.Call(uintptr(sid), uintptr(unsafe.Pointer(&tok))); r == 0 {
		return "", -1, fmt.Errorf("geen gebruiker ingelogd (WTSQueryUserToken: %v)", e)
	}
	defer tok.Close()
	use := tok
	if elevated {
		linked, err := tok.GetLinkedToken()
		if err != nil {
			return "", -1, errors.New("elevated niet mogelijk: gebruiker is geen administrator")
		}
		defer linked.Close()
		var prim windows.Token
		if err := windows.DuplicateTokenEx(linked, windows.MAXIMUM_ALLOWED, nil, windows.SecurityImpersonation, windows.TokenPrimary, &prim); err != nil {
			return "", -1, err
		}
		defer prim.Close()
		use = prim
	}
	var env *uint16
	if err := windows.CreateEnvironmentBlock(&env, use, false); err != nil {
		return "", -1, err
	}
	defer windows.DestroyEnvironmentBlock(env)

	sa := &windows.SecurityAttributes{InheritHandle: 1}
	sa.Length = uint32(unsafe.Sizeof(*sa))
	var rd, wr windows.Handle
	if err := windows.CreatePipe(&rd, &wr, sa, 0); err != nil {
		return "", -1, err
	}
	_ = windows.SetHandleInformation(rd, windows.HANDLE_FLAG_INHERIT, 0)
	nul, err := windows.CreateFile(windows.StringToUTF16Ptr("NUL"), windows.GENERIC_READ, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, sa, windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		windows.CloseHandle(rd)
		windows.CloseHandle(wr)
		return "", -1, err
	}
	defer windows.CloseHandle(nul)

	if p, err := exec.LookPath(exe); err == nil {
		exe = p
	}
	cmdline, err := windows.UTF16PtrFromString(windows.ComposeCommandLine(append([]string{exe}, args...)))
	if err != nil {
		return "", -1, err
	}
	si := &windows.StartupInfo{
		Desktop:    windows.StringToUTF16Ptr(`winsta0\default`),
		Flags:      windows.STARTF_USESTDHANDLES | windows.STARTF_USESHOWWINDOW,
		ShowWindow: windows.SW_HIDE,
		StdInput:   nul, StdOutput: wr, StdErr: wr,
	}
	si.Cb = uint32(unsafe.Sizeof(*si))
	var pi windows.ProcessInformation
	err = windows.CreateProcessAsUser(use, nil, cmdline, nil, nil, true,
		windows.CREATE_UNICODE_ENVIRONMENT|windows.CREATE_NO_WINDOW, env, nil, si, &pi)
	windows.CloseHandle(wr) // alleen het kind houdt de schrijfkant nog open
	if err != nil {
		windows.CloseHandle(rd)
		return "", -1, err
	}
	defer windows.CloseHandle(pi.Process)
	defer windows.CloseHandle(pi.Thread)

	var out capBuffer
	done := make(chan struct{})
	go func() {
		f := os.NewFile(uintptr(rd), "pipe")
		_, _ = io.Copy(&out, f)
		f.Close()
		close(done)
	}()
	ev, _ := windows.WaitForSingleObject(pi.Process, uint32(timeout.Milliseconds()))
	if ev == uint32(windows.WAIT_TIMEOUT) {
		_ = windows.TerminateProcess(pi.Process, 1)
		select {
		case <-done:
		case <-time.After(5 * time.Second):
		}
		return out.String(), -1, fmt.Errorf("time-out na %s", timeout)
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
	}
	var code uint32
	_ = windows.GetExitCodeProcess(pi.Process, &code)
	return out.String(), int(code), nil
}
