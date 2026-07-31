//go:build windows

package kube

import "errors"

// PTY does not exist on Windows; the shell tab hides itself via PTYAvailable().
type PTY struct{}

func PTYAvailable() bool { return false }

func StartPTY(string, []string, []string, uint16, uint16) (*PTY, error) {
	return nil, errors.New("no pty support on this platform")
}

func (p *PTY) Read([]byte) (int, error)  { return 0, errors.New("no pty") }
func (p *PTY) Write([]byte) (int, error) { return 0, errors.New("no pty") }
func (p *PTY) Resize(uint16, uint16)     {}
func (p *PTY) Wait() int                 { return 1 }
func (p *PTY) Close() error              { return nil }
