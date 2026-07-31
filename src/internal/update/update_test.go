package update

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestNewerComparesNumerically(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"1.5.0", "1.4.9", true},
		{"1.4.9", "1.5.0", false},
		{"1.5.0", "1.5.0", false},
		// The bug a string compare has: "10" sorts before "9" lexically.
		{"0.10.0", "0.9.0", true},
		{"0.9.0", "0.10.0", false},
		{"2.0.0", "1.99.99", true},
		// A shorter version is padded with zeros, not treated as smaller.
		{"1.5", "1.5.0", false},
		{"1.5.1", "1.5", true},
		// Pre-release suffixes are ignored, so an rc does not beat its release.
		{"1.5.0-rc1", "1.5.0", false},
		// An unstamped build (`go build` with no ldflags) takes any release.
		{"1.0.0", "dev", true},
		{"1.0.0", "", true},
	}
	for _, c := range cases {
		if got := newer(c.a, c.b); got != c.want {
			t.Errorf("newer(%q, %q) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}

func TestAssetTargetMatchesTheReleaseNames(t *testing.T) {
	got, err := assetTarget()
	if err != nil {
		t.Fatalf("assetTarget: %v", err)
	}
	// These are exactly the names release.yml publishes.
	valid := map[string]bool{
		"darwin-arm64": true, "darwin-x64": true,
		"linux-x64": true, "linux-arm64": true, "windows-x64": true,
	}
	if !valid[got] {
		t.Errorf("assetTarget() = %q, which no release asset is named after", got)
	}
}

// tarball builds a release tarball in the layout release.yml produces.
func tarball(t *testing.T, target, binName string, payload []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)

	write := func(name string, mode int64, body []byte) {
		if err := tw.WriteHeader(&tar.Header{
			Name: name, Mode: mode, Size: int64(len(body)), Typeflag: tar.TypeReg,
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write(body); err != nil {
			t.Fatal(err)
		}
	}
	write(target+"/"+binName, 0o755, payload)
	write(target+"/package.json", 0o644, []byte(`{"name":"digg","version":"9.9.9"}`))

	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestExtractBinaryFindsTheExecutable(t *testing.T) {
	name := "digg"
	if runtime.GOOS == "windows" {
		name = "digg.exe"
	}
	blob := tarball(t, "linux-x64", name, []byte("#!/bin/sh\necho hi\n"))

	got, err := extractBinary(blob, "linux-x64")
	if err != nil {
		t.Fatalf("extractBinary: %v", err)
	}
	if string(got) != "#!/bin/sh\necho hi\n" {
		t.Errorf("got %q", got)
	}
	// package.json must not be mistaken for the binary.
	if bytes.Contains(got, []byte("9.9.9")) {
		t.Error("extracted the wrong member")
	}
}

func TestExtractBinaryRejectsATarballWithoutOne(t *testing.T) {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	body := []byte("{}")
	tw.WriteHeader(&tar.Header{Name: "linux-x64/package.json", Mode: 0o644,
		Size: int64(len(body)), Typeflag: tar.TypeReg})
	tw.Write(body)
	tw.Close()
	gz.Close()

	if _, err := extractBinary(buf.Bytes(), "linux-x64"); err == nil {
		t.Error("expected an error for a tarball with no binary")
	}
}

// The swap is the dangerous part: get it wrong and the user is left with no
// digg on PATH at all.
func TestReplaceSwapsTheFileAndKeepsItExecutable(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "digg")
	if err := os.WriteFile(target, []byte("OLD"), 0o755); err != nil {
		t.Fatal(err)
	}

	if err := replace(target, []byte("NEW")); err != nil {
		t.Fatalf("replace: %v", err)
	}

	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "NEW" {
		t.Errorf("content = %q, want NEW", got)
	}
	info, err := os.Stat(target)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o111 == 0 {
		t.Errorf("mode = %v — the new binary is not executable", info.Mode().Perm())
	}
	// No litter left behind for the next run to trip over.
	for _, junk := range []string{".digg.new", ".digg.old"} {
		if _, err := os.Stat(filepath.Join(dir, junk)); err == nil {
			t.Errorf("%s was left behind", junk)
		}
	}
}

// install.sh puts the real binary in ~/.digg-bin and symlinks it onto PATH.
// Updating through the link must replace the TARGET, not turn the link into a
// regular file and orphan the install.
func TestSelfPathResolvesTheInstallSymlink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink semantics differ on Windows")
	}
	dir := t.TempDir()
	home := filepath.Join(dir, ".digg-bin")
	binDir := filepath.Join(dir, "bin")
	os.MkdirAll(home, 0o755)
	os.MkdirAll(binDir, 0o755)

	real := filepath.Join(home, "digg")
	link := filepath.Join(binDir, "digg")
	if err := os.WriteFile(real, []byte("OLD"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}

	resolved, err := filepath.EvalSymlinks(link)
	if err != nil {
		t.Fatal(err)
	}
	// macOS reports /private/var for /var, so compare resolved forms.
	wantReal, _ := filepath.EvalSymlinks(real)
	if resolved != wantReal {
		t.Fatalf("resolved to %q, want %q", resolved, wantReal)
	}

	if err := replace(resolved, []byte("NEW")); err != nil {
		t.Fatalf("replace: %v", err)
	}

	// The link must still be a link, and must still point at the real file.
	info, err := os.Lstat(link)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode()&os.ModeSymlink == 0 {
		t.Error("the symlink was replaced by a regular file — the install is orphaned")
	}
	got, err := os.ReadFile(link)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "NEW" {
		t.Errorf("reading through the link gives %q, want NEW", got)
	}
}

// A failed swap must leave the working binary in place rather than nothing.
func TestReplaceRestoresTheOldBinaryIfInstallFails(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("needs a non-root user and unix permissions")
	}
	dir := t.TempDir()
	target := filepath.Join(dir, "digg")
	if err := os.WriteFile(target, []byte("OLD"), 0o755); err != nil {
		t.Fatal(err)
	}
	// A read-only directory makes the write fail before anything is moved.
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(dir, 0o700)

	if err := replace(target, []byte("NEW")); err == nil {
		t.Fatal("expected replace to fail in a read-only directory")
	}
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("the original binary is gone: %v", err)
	}
	if string(got) != "OLD" {
		t.Errorf("content = %q — the original was not preserved", got)
	}
}
