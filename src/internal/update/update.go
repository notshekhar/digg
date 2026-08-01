// Package update implements `digg update` / `digg upgrade`.
//
// Port of runUpgrade() in src/commands.ts, but a real self-updater rather than
// a `curl … | bash` of install.sh. The Bun build had two paths — git pull for a
// checkout, the installer otherwise — because a compiled Bun binary could not
// replace itself. This one can:
//
//	resolve the latest tag → compare → download → verify sha256 → swap in place
//
// Two details make the swap safe.
//
// The binary on PATH is usually a SYMLINK: install.sh puts the real file in
// ~/.digg-bin/digg and links /usr/local/bin/digg at it. Writing to the link
// path would replace the link with a regular file and orphan the install, so
// the link is resolved first and the real file is what gets replaced.
//
// A running executable cannot be overwritten in place — POSIX gives ETXTBSY,
// Windows locks the file — but it CAN be renamed, because the running image is
// held by inode, not by name. So: move the old one aside, move the new one in,
// then delete the old. If the second move fails the old name is restored, and
// the user is never left without a working binary.
package update

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const (
	repoSlug = "notshekhar/digg"
	// latestURL redirects to the newest release; the tag is the last path
	// segment of wherever it lands. This is the same trick install.sh uses,
	// and it needs no API token or rate limit.
	latestURL = "https://github.com/" + repoSlug + "/releases/latest"
	assetBase = "https://github.com/" + repoSlug + "/releases/download"
)

// Options configures one update run.
type Options struct {
	// Force reinstalls even when the installed version is already current.
	Force bool
	// Check reports what would happen without downloading anything.
	Check bool
	// Version pins a tag instead of resolving the latest.
	Version string
}

// client is for the small requests — the latest-release redirect, the sums
// file. One minute is generous for both.
var client = &http.Client{Timeout: 60 * time.Second}

// blobClient is for the tarball, which is ~80MB.
//
// Client.Timeout covers reading the body too, so the one-minute cap was a
// deadline on the user's bandwidth: any link slower than about 11 Mbit killed
// the download partway through — which, before there was a bar, looked like a
// mysterious failure rather than a timeout. The header timeout still catches a
// server that never answers; after that, a slow link is allowed to be slow.
var blobClient = &http.Client{
	Timeout: 30 * time.Minute,
	Transport: &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		ResponseHeaderTimeout: 30 * time.Second,
	},
}

// Run performs the update and reports whether the binary changed.
func Run(current string, opts Options) error {
	fmt.Printf("▶ digg %s\n", display(current))

	target, err := assetTarget()
	if err != nil {
		return err
	}

	latest := opts.Version
	if latest == "" {
		latest, err = resolveLatest()
		if err != nil {
			return err
		}
	}
	if !strings.HasPrefix(latest, "v") {
		latest = "v" + latest
	}

	switch {
	case opts.Force:
		// Asked for explicitly; say so rather than silently reinstalling.
		fmt.Printf("  reinstalling %s (--force)\n", latest)
	case !newer(strings.TrimPrefix(latest, "v"), strings.TrimPrefix(current, "v")):
		fmt.Printf("✓ Up to date (installed %s, latest %s)\n", display(current), latest)
		fmt.Printf("  --force to reinstall\n")
		return nil
	default:
		fmt.Printf("  %s → %s\n", display(current), latest)
	}

	if opts.Check {
		fmt.Printf("  (--check: nothing downloaded)\n")
		return nil
	}

	self, err := selfPath()
	if err != nil {
		return err
	}

	url := fmt.Sprintf("%s/%s/digg-%s.tar.gz", assetBase, latest, target)
	fmt.Printf("▶ Downloading %s\n", filepath.Base(url))

	blob, err := download(url)
	if err != nil {
		return err
	}
	if err := verify(blob, url+".sha256"); err != nil {
		return err
	}

	bin, err := extractBinary(blob, target)
	if err != nil {
		return err
	}

	fmt.Printf("▶ Installing to %s\n", self)
	if err := replace(self, bin); err != nil {
		return err
	}

	fmt.Printf("✓ Updated digg to %s\n", latest)
	return nil
}

func display(v string) string {
	if v == "" || v == "dev" {
		return "dev"
	}
	return "v" + strings.TrimPrefix(v, "v")
}

// assetTarget is the os-arch string in the release asset names. It must match
// what the release workflow publishes, and what install.sh detects.
func assetTarget() (string, error) {
	var os string
	switch runtime.GOOS {
	case "darwin":
		os = "darwin"
	case "linux":
		os = "linux"
	case "windows":
		os = "windows"
	default:
		return "", fmt.Errorf("unsupported OS: %s", runtime.GOOS)
	}
	var arch string
	switch runtime.GOARCH {
	case "amd64":
		arch = "x64"
	case "arm64":
		arch = "arm64"
	default:
		return "", fmt.Errorf("unsupported architecture: %s", runtime.GOARCH)
	}
	return os + "-" + arch, nil
}

// resolveLatest follows the /releases/latest redirect and takes the tag off the
// end of the final URL.
func resolveLatest() (string, error) {
	req, err := http.NewRequest(http.MethodHead, latestURL, nil)
	if err != nil {
		return "", err
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("could not reach GitHub: %w", err)
	}
	defer resp.Body.Close()

	tag := path(resp.Request.URL.Path)
	if !strings.HasPrefix(tag, "v") {
		return "", fmt.Errorf("could not resolve the latest release of %s "+
			"(set --version=vX.Y.Z to pin one)", repoSlug)
	}
	return tag, nil
}

func path(p string) string {
	if i := strings.LastIndex(p, "/"); i >= 0 {
		return p[i+1:]
	}
	return p
}

// newer reports whether a is a higher version than b, comparing numerically
// segment by segment so v0.10.0 beats v0.9.0 (a string compare does not).
func newer(a, b string) bool {
	if b == "" || b == "dev" {
		// Running from source or an unstamped build: any release is an update.
		return true
	}
	as, bs := segments(a), segments(b)
	for i := 0; i < len(as) || i < len(bs); i++ {
		x, y := at(as, i), at(bs, i)
		if x != y {
			return x > y
		}
	}
	return false
}

func segments(v string) []int {
	// Drop any pre-release suffix: 1.2.3-rc1 compares as 1.2.3.
	if i := strings.IndexAny(v, "-+"); i >= 0 {
		v = v[:i]
	}
	parts := strings.Split(v, ".")
	out := make([]int, 0, len(parts))
	for _, p := range parts {
		n, err := strconv.Atoi(strings.TrimSpace(p))
		if err != nil {
			return out
		}
		out = append(out, n)
	}
	return out
}

func at(s []int, i int) int {
	if i < len(s) {
		return s[i]
	}
	return 0
}

// selfPath is the real file backing this process, with symlinks resolved.
func selfPath() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("could not locate the running binary: %w", err)
	}
	// EvalSymlinks is what keeps an install.sh symlink intact: the link keeps
	// pointing at ~/.digg-bin/digg, and that file is what we swap.
	resolved, err := filepath.EvalSymlinks(exe)
	if err != nil {
		return exe, nil
	}
	return resolved, nil
}

// download fetches the release tarball, drawing a bar while it does.
//
// ContentLength is the honest denominator and GitHub always sends one for a
// release asset; -1 means the server would not say, and the bar counts up
// instead of guessing a total.
func download(url string) ([]byte, error) {
	resp, err := blobClient.Get(url)
	if err != nil {
		return nil, fmt.Errorf("download failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download failed: %s returned %s", url, resp.Status)
	}

	total := resp.ContentLength
	if total < 0 {
		total = 0
	}
	bar := newProgress(total)

	var buf bytes.Buffer
	buf.Grow(int(total))
	if _, err := io.Copy(io.MultiWriter(&buf, bar), resp.Body); err != nil {
		bar.abort()
		return nil, fmt.Errorf("download failed: %w", err)
	}
	bar.done()
	return buf.Bytes(), nil
}

// verify checks the published sha256 when there is one. A missing sums file is
// not fatal — older releases have none — but a MISMATCH always is.
func verify(blob []byte, sumURL string) error {
	resp, err := client.Get(sumURL)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil
	}
	raw, err := io.ReadAll(resp.Body)
	if err != nil || len(raw) == 0 {
		return nil
	}
	want := strings.Fields(string(raw))
	if len(want) == 0 {
		return nil
	}
	sum := sha256.Sum256(blob)
	got := hex.EncodeToString(sum[:])
	if !strings.EqualFold(want[0], got) {
		return fmt.Errorf("sha256 mismatch: expected %s, got %s — refusing to install", want[0], got)
	}
	fmt.Printf("  sha256 ok\n")
	return nil
}

// extractBinary pulls the digg executable out of the release tarball. The
// layout is <target>/digg[.exe], which is what install.sh and the release
// workflow both produce.
func extractBinary(blob []byte, target string) ([]byte, error) {
	gz, err := gzip.NewReader(strings.NewReader(string(blob)))
	if err != nil {
		return nil, fmt.Errorf("bad tarball: %w", err)
	}
	defer gz.Close()

	name := "digg"
	if runtime.GOOS == "windows" {
		name = "digg.exe"
	}
	wanted := target + "/" + name

	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("bad tarball: %w", err)
		}
		if h.Typeflag != tar.TypeReg {
			continue
		}
		if h.Name == wanted || filepath.Base(h.Name) == name {
			// Cap the read: a hostile tarball should not be able to exhaust
			// memory just because we trusted its header.
			data, err := io.ReadAll(io.LimitReader(tr, 512<<20))
			if err != nil {
				return nil, err
			}
			if len(data) == 0 {
				return nil, errors.New("the release tarball contains an empty binary")
			}
			return data, nil
		}
	}
	return nil, fmt.Errorf("the release tarball has no %s", wanted)
}

// replace swaps the running binary for a new one.
//
// The new file is written NEXT TO the target, never to a temp dir: /tmp is
// often a different filesystem, and a cross-device rename is not atomic (it
// falls back to copy, which can leave a half-written executable).
func replace(target string, data []byte) error {
	dir := filepath.Dir(target)

	mode := os.FileMode(0o755)
	if info, err := os.Stat(target); err == nil {
		mode = info.Mode().Perm()
	}

	next := filepath.Join(dir, ".digg.new")
	if err := os.WriteFile(next, data, mode); err != nil {
		return fmt.Errorf("cannot write to %s: %w\n"+
			"  (is the install owned by another user? try sudo, or re-run install.sh)", dir, err)
	}
	// WriteFile honours umask on an existing file, so set the bits explicitly.
	if err := os.Chmod(next, mode); err != nil {
		os.Remove(next)
		return err
	}

	// A running executable cannot be overwritten, but it can be renamed.
	old := filepath.Join(dir, ".digg.old")
	os.Remove(old)
	if err := os.Rename(target, old); err != nil {
		os.Remove(next)
		return fmt.Errorf("cannot replace %s: %w", target, err)
	}
	if err := os.Rename(next, target); err != nil {
		// Put the working binary back rather than leaving nothing on PATH.
		os.Rename(old, target)
		os.Remove(next)
		return fmt.Errorf("cannot install the new binary: %w", err)
	}
	// Windows will refuse while the image is mapped; it is only litter, and
	// the next run clears it.
	os.Remove(old)
	return nil
}
