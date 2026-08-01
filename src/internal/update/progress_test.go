package update

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// countBars is how many redraws landed in the output: one carriage return each.
func countBars(s string) int { return strings.Count(s, "\r") }

func TestProgressDrawsPercentAndSize(t *testing.T) {
	var out bytes.Buffer
	p := newProgressTo(&out, 1000)
	p.Write(make([]byte, 500))
	got := out.String()
	if !strings.Contains(got, " 50%") {
		t.Fatalf("no 50%%: %q", got)
	}
	if !strings.Contains(got, strings.Repeat("■", 21)) {
		t.Errorf("half the bar should be filled: %q", got)
	}
	if !strings.Contains(got, cursorHide) {
		t.Error("cursor not hidden on first draw")
	}
}

// Ten redraws a second, not one per chunk. A 4KB read loop over 80MB is twenty
// thousand writes, and drawing them all is slower than the download.
func TestProgressThrottlesRedraws(t *testing.T) {
	var out bytes.Buffer
	p := newProgressTo(&out, 1000)
	for i := 0; i < 50; i++ {
		p.Write(make([]byte, 10))
	}
	if n := countBars(out.String()); n != 1 {
		t.Fatalf("got %d redraws in a tight loop, want 1", n)
	}
	if p.written != 500 {
		t.Errorf("counted %d bytes, want 500", p.written)
	}
}

// The last redraw lands wherever it lands; a finished download that stops the
// bar at 97% reads as a download that stopped.
func TestProgressDoneLandsOn100(t *testing.T) {
	var out bytes.Buffer
	p := newProgressTo(&out, 1000)
	p.Write(make([]byte, 970))
	p.done()
	lines := strings.Split(out.String(), "\r")
	last := lines[len(lines)-1]
	if !strings.Contains(last, "100%") {
		t.Fatalf("final draw was %q", last)
	}
	if !strings.HasSuffix(out.String(), cursorShow+"\n") {
		t.Error("cursor not restored")
	}
}

// A server that under-reports Content-Length must not leave the bar at 103%.
func TestProgressNeverExceeds100(t *testing.T) {
	var out bytes.Buffer
	p := newProgressTo(&out, 100)
	p.Write(make([]byte, 250))
	if strings.Contains(out.String(), "250%") {
		t.Fatalf("got %q", out.String())
	}
	if !strings.Contains(out.String(), "100%") {
		t.Fatalf("got %q", out.String())
	}
}

// No Content-Length is not an error: the bar counts up rather than inventing a
// denominator.
func TestProgressWithoutATotalCountsUp(t *testing.T) {
	var out bytes.Buffer
	p := newProgressTo(&out, 0)
	p.Write(make([]byte, 3*bytesInMebibyte))
	got := out.String()
	if !strings.Contains(got, "3.0 MB") {
		t.Fatalf("no byte count: %q", got)
	}
	if !strings.Contains(got, "  0%") {
		t.Errorf("percent should stay at 0 with no total: %q", got)
	}
}

// A nil bar is the redirected-output case, and every method has to take it —
// the caller must never branch on whether there is a terminal.
func TestNilProgressIsAWorkingBar(t *testing.T) {
	var p *progress
	n, err := p.Write(make([]byte, 10))
	if n != 10 || err != nil {
		t.Fatalf("write through nil: %d %v", n, err)
	}
	p.draw()
	p.done()
	p.abort()
}

func TestAbortClearsTheLineWithoutClaimingSuccess(t *testing.T) {
	var out bytes.Buffer
	p := newProgressTo(&out, 1000)
	p.Write(make([]byte, 100))
	out.Reset()
	p.abort()
	got := out.String()
	if !strings.Contains(got, "\033[K") || !strings.Contains(got, cursorShow) {
		t.Fatalf("got %q", got)
	}
	if strings.Contains(got, "100%") {
		t.Error("abort must not draw a finished bar")
	}
}

// The whole point: `digg update` must report bytes as they arrive, and end up
// with exactly the bytes the server sent.
func TestDownloadReportsProgressAndReturnsTheBody(t *testing.T) {
	body := bytes.Repeat([]byte("x"), 3*bytesInMebibyte)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "3145728")
		w.WriteHeader(http.StatusOK)
		// Written in slices with a pause, so the bar has something to redraw
		// against rather than a single instant write.
		for i := 0; i < 3; i++ {
			w.Write(body[i*bytesInMebibyte : (i+1)*bytesInMebibyte])
			w.(http.Flusher).Flush()
			time.Sleep(120 * time.Millisecond)
		}
	}))
	defer srv.Close()

	got, err := download(srv.URL + "/digg-darwin-arm64.tar.gz")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != len(body) {
		t.Fatalf("got %d bytes, want %d", len(got), len(body))
	}
	if !bytes.Equal(got, body) {
		t.Error("body does not round-trip")
	}
}

func TestDownloadReportsAnHTTPError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "nope", http.StatusNotFound)
	}))
	defer srv.Close()

	if _, err := download(srv.URL + "/missing.tar.gz"); err == nil {
		t.Fatal("a 404 should be an error")
	} else if !strings.Contains(err.Error(), "404") {
		t.Errorf("unhelpful error: %v", err)
	}
}

// The bar rides in a MultiWriter beside the buffer that keeps the download; if
// it ever reported short or errored, io.Copy would abort a good transfer.
func TestProgressNeverShortWrites(t *testing.T) {
	p := newProgressTo(io.Discard, 10)
	n, err := p.Write(make([]byte, 7))
	if n != 7 || err != nil {
		t.Fatalf("got %d, %v", n, err)
	}
}
