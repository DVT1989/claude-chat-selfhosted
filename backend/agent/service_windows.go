//go:build windows

package main

import (
	"context"
	"os"
	"os/signal"
	"time"

	"golang.org/x/sys/windows/svc"
)

type agentService struct{}

func (agentService) Execute(_ []string, r <-chan svc.ChangeRequest, st chan<- svc.Status) (bool, uint32) {
	st <- svc.Status{State: svc.StartPending}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { runLoop(ctx); close(done) }()
	go func() { time.Sleep(20 * time.Second); resetUserCursors() }() // after a crash or power loss mid-session
	st <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown | svc.AcceptPreShutdown | svc.AcceptPowerEvent}
	for c := range r {
		switch c.Cmd {
		case svc.Interrogate:
			st <- c.CurrentStatus
		case svc.PowerEvent:
			// PBT_APMSUSPEND: going to sleep. Tell the server so a remote session ends right away.
			if c.EventType == 4 {
				reportState("sleep")
			}
		case svc.PreShutdown:
			reportState("shutdown")
			st <- svc.Status{State: svc.StopPending}
			cancel()
			select {
			case <-done:
			case <-time.After(5 * time.Second):
			}
			return false, 0
		case svc.Stop, svc.Shutdown:
			if c.Cmd == svc.Shutdown {
				reportState("shutdown")
			}
			st <- svc.Status{State: svc.StopPending}
			cancel()
			select {
			case <-done:
			case <-time.After(5 * time.Second):
			}
			return false, 0
		}
	}
	cancel()
	return false, 0
}

// runService runs under the Windows service manager, or in the foreground when started by hand.
func runService() {
	if isSvc, err := svc.IsWindowsService(); err == nil && isSvc {
		_ = svc.Run("ClaudeAgent", agentService{})
		return
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	runLoop(ctx)
}

// reportState tells the server the device is going away (shutdown or sleep), briefly and best effort.
func reportState(state string) {
	cfg, err := loadConfig()
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = post(ctx, cfg.Server, cfg.Token, "state", map[string]string{"state": state}, nil)
}
