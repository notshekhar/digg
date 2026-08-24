package kube

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// These tests are hermetic: each writes its own kubeconfig and its own stand-in
// for `aws` into a temp dir and points KUBECONFIG at it. Nothing here touches a
// real cluster or a real AWS login, which is the point — the failures being
// diagnosed are exactly the ones you cannot reproduce on a machine where
// everything works.

// fakePlugin writes an executable that behaves like a credential plugin: it
// prints `stderr` and exits with `code`, or prints a valid ExecCredential when
// code is 0.
func fakePlugin(t *testing.T, dir, stderr string, code int) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the fake plugin is a shell script")
	}
	path := filepath.Join(dir, "fake-aws")
	body := "#!/bin/sh\n"
	if stderr != "" {
		body += fmt.Sprintf("printf '%%s\\n' %q >&2\n", stderr)
	}
	if code == 0 {
		body += `printf '%s' '{"kind":"ExecCredential","apiVersion":"client.authentication.k8s.io/v1beta1","status":{"token":"t"}}'` + "\n"
	}
	body += fmt.Sprintf("exit %d\n", code)
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

// writeKubeconfig points KUBECONFIG at a single-context config using the given
// exec command and apiVersion.
func writeKubeconfig(t *testing.T, dir, contextName, command, apiVersion, interactive string) {
	t.Helper()
	extra := ""
	if interactive != "" {
		extra = "\n      interactiveMode: " + interactive
	}
	body := fmt.Sprintf(`apiVersion: v1
kind: Config
current-context: %[1]s
clusters:
- name: %[1]s
  cluster: {server: "https://example.invalid"}
contexts:
- name: %[1]s
  context: {cluster: %[1]s, user: %[1]s}
users:
- name: %[1]s
  user:
    exec:
      apiVersion: %[3]s
      command: %[2]s
      args: ["eks","get-token","--cluster-name","prod"]%[4]s
`, contextName, command, apiVersion, extra)
	path := filepath.Join(dir, "config")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("KUBECONFIG", path)
}

// The headline case: the AWS CLI knows exactly what is wrong and says so on
// stderr, and client-go throws that away in favour of an exit code. The
// diagnosis has to put it back.
func TestDiagnoseSurfacesThePluginsOwnStderr(t *testing.T) {
	dir := t.TempDir()
	const awsSays = "Error loading SSO Token: Token for https://acme.awsapps.com/start has expired " +
		"and refresh failed, please log in again by running 'aws sso login --profile prod'."
	plugin := fakePlugin(t, dir, awsSays, 255)
	writeKubeconfig(t, dir, "sso-expired", plugin, "client.authentication.k8s.io/v1beta1", "")

	err := Diagnose("sso-expired", errors.New(
		`Get "https://example.invalid/api": getting credentials: exec: executable aws failed with exit code 255`))
	if err == nil {
		t.Fatal("expected a diagnosis")
	}
	got := err.Error()
	if !strings.Contains(got, awsSays) {
		t.Fatalf("the plugin's own message did not survive:\n%s", got)
	}
	if !strings.Contains(got, "aws sso login") {
		t.Fatalf("no fix offered:\n%s", got)
	}
	// The bare exit code is not an explanation and must not be the whole story.
	if got == "exec: executable aws failed with exit code 255" {
		t.Fatal("diagnosis passed the useless message straight through")
	}
}

// A plugin that wants a terminal must never be run by the diagnosis: doing so
// either blocks on a read or fires an MFA prompt at someone who did not ask for
// one. The tell is that the fake plugin's stderr does NOT appear.
func TestDiagnoseNeverRunsAnInteractivePlugin(t *testing.T) {
	dir := t.TempDir()
	plugin := fakePlugin(t, dir, "SHOULD-NOT-RUN", 255)
	writeKubeconfig(t, dir, "mfa", plugin, "client.authentication.k8s.io/v1beta1", "Always")

	err := Diagnose("mfa", errors.New(
		"getting credentials: exec plugin cannot support interactive mode: standard input is not a terminal"))
	got := err.Error()
	if strings.Contains(got, "SHOULD-NOT-RUN") {
		t.Fatal("the diagnosis executed an interactive plugin")
	}
	if !strings.Contains(got, "no terminal to prompt on") {
		t.Fatalf("interactive failure not explained:\n%s", got)
	}
}

func TestDiagnoseExplainsTheRetiredExecAPIVersion(t *testing.T) {
	dir := t.TempDir()
	plugin := fakePlugin(t, dir, "", 0)
	writeKubeconfig(t, dir, "old", plugin, "client.authentication.k8s.io/v1alpha1", "")

	err := Diagnose("old", errors.New(`exec plugin: invalid apiVersion "client.authentication.k8s.io/v1alpha1"`))
	got := err.Error()
	if !strings.Contains(got, "aws eks update-kubeconfig") {
		t.Fatalf("no rewrite command offered:\n%s", got)
	}
}

func TestDiagnoseNamesTheMissingPlugin(t *testing.T) {
	dir := t.TempDir()
	writeKubeconfig(t, dir, "gone", "definitely-not-installed", "client.authentication.k8s.io/v1beta1", "")

	err := Diagnose("gone", errors.New(
		`Get "https://example.invalid/api": getting credentials: exec: executable definitely-not-installed not found`))
	got := err.Error()
	if !strings.Contains(got, "not on digg's PATH") {
		t.Fatalf("PATH problem not named:\n%s", got)
	}
	if !strings.Contains(got, "definitely-not-installed") {
		t.Fatalf("the missing command is not quoted back:\n%s", got)
	}
}

// A diagnosis that fires on ordinary errors trains people to stop reading error
// text, so the classifier has to stay narrow.
func TestDiagnoseLeavesUnrelatedErrorsAlone(t *testing.T) {
	for _, msg := range []string{
		`pods "api-7d9f" not found`,
		`Operation cannot be fulfilled on deployments.apps "web": the object has been modified`,
		`admission webhook "validate.example.com" denied the request`,
		`unknown kind "widgets"`,
		`etcdserver: request timed out`,
	} {
		in := errors.New(msg)
		if out := Diagnose("whatever", in); out.Error() != msg {
			t.Errorf("Diagnose rewrote an unrelated error\n  in:  %s\n  out: %s", msg, out.Error())
		}
	}
}

// UnreachableCluster is the discriminator that stopped an expired login from
// reaching the UI as `unknown kind "pods"`.
func TestUnreachableClusterSeparatesNoSuchKindFromNoConnection(t *testing.T) {
	noResource := &meta.NoResourceMatchError{
		PartialResource: schema.GroupVersionResource{Resource: "widgets"},
	}
	noKind := &meta.NoKindMatchError{
		GroupKind: schema.GroupKind{Kind: "Widget"},
	}
	if UnreachableCluster(noResource) {
		t.Error("a genuinely unknown resource was called a connection failure")
	}
	if UnreachableCluster(noKind) {
		t.Error("a genuinely unknown kind was called a connection failure")
	}
	if UnreachableCluster(fmt.Errorf("wrapped: %w", noResource)) {
		t.Error("wrapping hid a NoResourceMatchError")
	}
	if !UnreachableCluster(errors.New(`Get "https://x/api": getting credentials: exec: ...`)) {
		t.Error("a credentials failure was not called a connection failure")
	}
	if UnreachableCluster(nil) {
		t.Error("nil is not a failure")
	}
}

// Each of these is a real AWS CLI message. The mapping from what it says to
// what to run is the whole value of the feature, so it is worth pinning.
func TestFixForRecognisesTheRealAWSMessages(t *testing.T) {
	cases := map[string]string{
		"Error loading SSO Token: Token for https://x/start has expired and refresh failed":                                         "aws sso login",
		"The config profile (prod) could not be found":                                                                              "AWS_PROFILE",
		`Unable to locate credentials. You can configure credentials by running "aws configure".`:                                   "aws configure",
		"An error occurred (ExpiredToken) when calling the AssumeRole operation":                                                    "expired",
		"An error occurred (AccessDenied) when calling the AssumeRole operation: User is not authorized to perform: sts:AssumeRole": "eks:DescribeCluster",
	}
	for stderr, want := range cases {
		if got := fixFor(stderr); !strings.Contains(got, want) {
			t.Errorf("fixFor(%q)\n  got:  %q\n  want it to mention %q", stderr, got, want)
		}
	}
	// Something nobody has a canned answer for gets no invented advice — the
	// plugin's output is already on screen above it.
	if got := fixFor("Segmentation fault"); got != "" {
		t.Errorf("invented advice for an unrecognised message: %q", got)
	}
}

// The diagnosis runs the plugin, and a page build fans out into a dozen
// concurrent reads that all fail together. Running the plugin a dozen times in
// one second is a stampede against whatever the plugin talks to.
func TestDiagnoseDoesNotRerunThePluginPerFailedRead(t *testing.T) {
	dir := t.TempDir()
	counter := filepath.Join(dir, "runs")
	plugin := filepath.Join(dir, "counting-aws")
	body := "#!/bin/sh\necho x >> " + counter + "\necho 'Unable to locate credentials.' >&2\nexit 255\n"
	if runtime.GOOS == "windows" {
		t.Skip("the fake plugin is a shell script")
	}
	if err := os.WriteFile(plugin, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	writeKubeconfig(t, dir, "stampede", plugin, "client.authentication.k8s.io/v1beta1", "")

	fail := errors.New(`Get "https://example.invalid/api": getting credentials: exec: executable aws failed with exit code 255`)
	for i := 0; i < 12; i++ {
		Diagnose("stampede", fail)
	}

	data, err := os.ReadFile(counter)
	if err != nil {
		t.Fatalf("the plugin never ran at all: %v", err)
	}
	if runs := strings.Count(string(data), "x"); runs != 1 {
		t.Fatalf("plugin ran %d times for 12 failed reads; the diagnosis is not memoised", runs)
	}
}
