//go:build !windows

package kube

import (
	"os"
	"os/exec"
	"sync"

	"github.com/creack/pty"
)

// Port of src/pty.ts — 240 lines of bun:ffi that opened a pty by hand, wrote a
// C shim for the variadic ioctl to a temp file at runtime and compiled it with
// Bun's bundled TinyCC, because a .c next to the source cannot be read from
// inside a compiled binary and Bun's FFI reads starve stdin.
//
// None of that is needed here. Go's os/exec plus creack/pty is the whole thing,
// resize included, and it works identically in a compiled binary because there
// is nothing to compile at runtime.

// PTY is a local pseudo-terminal running a child process.
type PTY struct {
	cmd  *exec.Cmd
	file *os.File
	once sync.Once
}

// PTYAvailable reports whether this platform can open a pty. Port of
// ptyAvailable(): the shell tab is hidden rather than broken where it cannot.
//
// creack/pty builds on unix; on Windows there is no pty here.
func PTYAvailable() bool { return true }

// StartPTY runs command under a new pty sized cols×rows.
func StartPTY(command string, args []string, env []string, cols, rows uint16) (*PTY, error) {
	cmd := exec.Command(command, args...)
	cmd.Env = env
	f, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: cols, Rows: rows})
	if err != nil {
		return nil, err
	}
	return &PTY{cmd: cmd, file: f}, nil
}

func (p *PTY) Read(b []byte) (int, error)  { return p.file.Read(b) }
func (p *PTY) Write(b []byte) (int, error) { return p.file.Write(b) }

// Resize degrades to a no-op on failure, as the Bun build did when cc failed.
func (p *PTY) Resize(cols, rows uint16) {
	_ = pty.Setsize(p.file, &pty.Winsize{Cols: cols, Rows: rows})
}

// Wait blocks until the child exits and returns its exit code.
func (p *PTY) Wait() int {
	err := p.cmd.Wait()
	if err == nil {
		return 0
	}
	if ee, ok := err.(*exec.ExitError); ok {
		return ee.ExitCode()
	}
	return 1
}

func (p *PTY) Close() error {
	p.once.Do(func() {
		if p.cmd.Process != nil {
			_ = p.cmd.Process.Kill()
		}
		_ = p.file.Close()
	})
	return nil
}
