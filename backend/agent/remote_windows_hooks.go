//go:build windows

package main

import "context"

// Windows has no permission prompts for screen capture and input.
func remotePerms() map[string]bool        { return nil }
func startPlatformLoops(_ context.Context) {}

func runMacPerms(_ []string) {}
