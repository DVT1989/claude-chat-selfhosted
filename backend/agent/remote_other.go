//go:build !windows && !darwin

package main

import (
	"context"
	"errors"
	"sync/atomic"
)

const remoteSupported = false

var errNoRemote = errors.New("meekijken is nog niet beschikbaar op dit besturingssysteem")

func startRemote(server, session, key string) error        { return errNoRemote }
func sendSAS() error                               { return errNoRemote }
func setDPIAware()                                 {}
func newCapturer() (capturer, error)               { return nil, errNoRemote }
func newInjector() injector                        { return nil }
func watchEditable(_ *atomic.Bool, _ *atomic.Bool) {}

type nameCursor struct{}

func startOverlay() *nameCursor         { return &nameCursor{} }
func (*nameCursor) setName(string)      {}
func (*nameCursor) show(int, int, bool) {}
func (*nameCursor) close()              {}

type banner struct{}

func startBanner() *banner                  { return &banner{} }
func (*banner) set(bool, string)            {}
func (*banner) claude()                     {}
func (*banner) close()                      {}
func (*banner) look(string, string, []byte) {}
func (*banner) setHangup(func())            {}

func remotePerms() map[string]bool        { return nil }
func startPlatformLoops(_ context.Context) {}

func runMacPerms(_ []string) {}
