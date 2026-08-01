package update

import (
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

// The download bar for `digg update`.
//
// install.sh has drawn one since v1.4.2 and `digg update` drew nothing at all —
// so the command that is meant to be the easy path was the one that sat silent
// for ten seconds on an 80MB binary, which on a slow link is indistinguishable
// from a hang. This is the same bar, glyph for glyph, because the two are the
// same act and should not look like different programs.
//
// It measures bytes that have actually arrived, never a proxy for them: the
// installer learned that the hard way parsing curl's trace, where socket-read
// records made the bar hit 100% while the transfer was still running.

const (
	barWidth        = 42
	barColor        = "\033[38;5;215m"
	barReset        = "\033[0m"
	cursorHide      = "\033[?25l"
	cursorShow      = "\033[?25h"
	redrawEvery     = 100 * time.Millisecond
	bytesInMebibyte = 1 << 20
)

// progress draws a download bar to stderr. A zero total is not an error — some
// servers will not say — and the bar then just counts up, exactly as the shell
// one does.
type progress struct {
	out     io.Writer
	total   int64
	written int64
	start   time.Time
	last    time.Time
	drawn   bool
}

// newProgress returns a bar, or nil when there is no terminal to draw on.
//
// Nil is a working bar: every method takes a nil receiver, so the caller never
// branches on it. Redirected output gets a clean log rather than a screenful of
// carriage returns, which is what a CI job or `digg update > log` wants.
func newProgress(total int64) *progress {
	if !isTerminal(os.Stderr) {
		return nil
	}
	return newProgressTo(os.Stderr, total)
}

// newProgressTo is the testable constructor: no TTY check, explicit sink.
func newProgressTo(out io.Writer, total int64) *progress {
	now := time.Now()
	return &progress{out: out, total: total, start: now, last: now.Add(-redrawEvery)}
}

func isTerminal(f *os.File) bool {
	info, err := f.Stat()
	if err != nil {
		return false
	}
	return info.Mode()&os.ModeCharDevice != 0
}

// Write counts the bytes and redraws at most ten times a second. It is an
// io.Writer so it can ride along in an io.MultiWriter beside the buffer that
// actually keeps the download.
func (p *progress) Write(b []byte) (int, error) {
	if p == nil {
		return len(b), nil
	}
	p.written += int64(len(b))
	if time.Since(p.last) >= redrawEvery {
		p.draw()
	}
	return len(b), nil
}

func (p *progress) draw() {
	if p == nil {
		return
	}
	p.last = time.Now()
	if !p.drawn {
		fmt.Fprint(p.out, cursorHide)
		p.drawn = true
	}

	percent := 0
	if p.total > 0 {
		percent = int(p.written * 100 / p.total)
		if percent > 100 {
			percent = 100
		}
	}
	on := percent * barWidth / 100
	bar := strings.Repeat("■", on) + strings.Repeat("･", barWidth-on)

	mb := float64(p.written) / bytesInMebibyte
	rate := ""
	if secs := time.Since(p.start).Seconds(); secs > 0 {
		rate = fmt.Sprintf("  %.1f MB/s", mb/secs)
	}
	fmt.Fprintf(p.out, "\r%s%s%s %3d%%  %.1f MB%s ", barColor, bar, barReset, percent, mb, rate)
}

// done lands the bar on the real total and restores the cursor.
//
// The last redraw can fall anywhere, so a finished download that stopped at 97%
// reads as a download that stopped. The total is corrected to what actually
// arrived first, because a server that under-reported Content-Length must not
// leave the bar reading 103%.
func (p *progress) done() {
	if p == nil {
		return
	}
	p.total = p.written
	p.draw()
	fmt.Fprint(p.out, cursorShow+"\n")
}

// abort clears the line without claiming the download finished.
func (p *progress) abort() {
	if p == nil {
		return
	}
	if p.drawn {
		fmt.Fprint(p.out, "\r\033[K"+cursorShow)
	}
}
