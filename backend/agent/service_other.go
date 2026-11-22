//go:build !windows

package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"
)

// runService: on macOS launchd keeps the process alive; stop on SIGTERM.
func runService() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	runLoop(ctx)
}
