package kube

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"k8s.io/apimachinery/pkg/api/meta"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

// Why this file exists.
//
// digg's help text promises that "every auth method works — client certs,
// tokens, and exec plugins like aws/gcp/oidc", and it is true: client-go runs
// the exec plugin exactly as kubectl does. What was NOT true is that you could
// find out when it did not.
//
// client-go builds the exec Authenticator with `stderr: os.Stderr` hardcoded
// and no way to inject a writer, and when the plugin exits non-zero it reports
//
//	exec: executable aws failed with exit code 255
//
// That sentence is the same sentence for every way an AWS login can be wrong:
// an expired SSO session, an AWS_PROFILE that does not exist, credentials never
// configured, a role that cannot assume. The one line that actually tells you
// which — "Token for https://…/start has expired and refresh failed, please log
// in again by running 'aws sso login --profile prod'" — goes to the terminal
// digg happens to be running in, where nobody looking at the browser will see
// it. Worse, it arrives at the UI wrapped as `unknown kind "pods"`, because the
// RESTMapper could not reach discovery and the caller assumed the only reason
// for that was a kind it had never heard of.
//
// So: when a call fails for a credentials-shaped reason, digg re-runs the
// plugin itself, keeps the stderr client-go threw away, and says what the AWS
// CLI said — plus the command to fix it.

// diagTTL is how long one context's verdict is reused.
//
// A single page build fans out into a dozen concurrent reads, and every one of
// them fails together when credentials are bad. Diagnosing each would run the
// credential plugin a dozen times in the same second — which for a plugin that
// hits a network endpoint (SSO refresh, an IdP round trip) is a small stampede
// against someone else's rate limit.
const diagTTL = 5 * time.Second

// probeTimeout bounds the re-run. A credential plugin that hangs must not take
// the request with it; the diagnosis is a nicety, the failure is already known.
const probeTimeout = 10 * time.Second

type diagEntry struct {
	at     time.Time
	stderr string
}

var (
	diagMu    sync.Mutex
	diagCache = map[string]diagEntry{}
)

// Diagnose replaces a credentials-shaped failure with one that names the cause
// and the fix. Anything else is returned untouched — a diagnosis that fires on
// ordinary errors is worse than none, because it teaches people to skip the
// error text.
func Diagnose(contextName string, err error) error {
	if err == nil {
		return nil
	}
	msg := err.Error()
	if !looksLikeAuth(msg) {
		return err
	}

	execCfg := execConfigFor(contextName)

	switch {
	// client-go 1.30 removed client.authentication.k8s.io/v1alpha1. A kubeconfig
	// written by an older `aws eks update-kubeconfig` still names it, and every
	// call fails before the plugin is ever run.
	case strings.Contains(msg, "invalid apiVersion") && strings.Contains(msg, "client.authentication.k8s.io"):
		return errf("%s\n\nThis context's kubeconfig entry uses an exec plugin apiVersion that "+
			"Kubernetes removed in 1.30, so digg never gets as far as running it. Rewrite the "+
			"entry:\n\n    aws eks update-kubeconfig --name <cluster> --region <region>\n\n"+
			"(kubectl still works because older kubectl builds kept the old version alive.)", msg)

	// interactiveMode: Always, or an assume-role profile with mfa_serial: the
	// plugin wants to prompt, and a server has no terminal to prompt on.
	case strings.Contains(msg, "interactive mode"):
		return errf("This context's credential plugin wants to prompt for input (an MFA code, "+
			"or a browser login), and `digg serve` has no terminal to prompt on.\n\n"+
			"Get a session in your shell first, then reload:\n\n"+
			"    aws sso login --profile <profile>      # SSO\n"+
			"    aws sts get-session-token …            # assume-role with MFA\n\n"+
			"Underlying error: %s", msg)

	// The plugin is named in the kubeconfig but is not on digg's PATH.
	case strings.Contains(msg, "not found"):
		hint := ""
		if execCfg != nil {
			hint = "\n\nkubeconfig asks for: " + strings.Join(append([]string{execCfg.Command}, execCfg.Args...), " ")
		}
		return errf("The credential plugin for this context is not on digg's PATH.%s\n\n"+
			"Install it, or start digg from a shell where `%s` resolves — a launcher or "+
			"desktop entry does not inherit your shell's PATH.\n\nUnderlying error: %s",
			hint, commandOf(execCfg), msg)
	}

	// Everything else worth explaining needs the plugin's own words, which
	// means running it.
	if execCfg != nil && strings.Contains(msg, "getting credentials") {
		if out := probeExec(contextName, execCfg); out != "" {
			return errf("The credential plugin for this context failed.\n\n%s says:\n\n    %s\n%s",
				commandOf(execCfg), indent(out), fixFor(out))
		}
	}

	// A token was minted and the apiserver rejected it, or the endpoint is not
	// reachable at all. Different problems, both worth naming.
	switch {
	case strings.Contains(msg, "Unauthorized") || strings.Contains(msg, "the server has asked for the client to provide credentials"):
		return errf("The cluster rejected these credentials. They were issued — so the login "+
			"worked — but this identity is not mapped to a Kubernetes user.\n\n"+
			"On EKS that is the access entry (or the aws-auth ConfigMap):\n\n"+
			"    aws eks list-access-entries --cluster-name <cluster>\n\n"+
			"Check which identity you are with `aws sts get-caller-identity`.\n\n"+
			"Underlying error: %s", msg)
	case strings.Contains(msg, "no such host"), strings.Contains(msg, "connection refused"),
		strings.Contains(msg, "i/o timeout"), strings.Contains(msg, "context deadline exceeded"):
		return errf("The cluster's API endpoint is not reachable from this machine. If it is an "+
			"EKS cluster with a private endpoint, you need to be on the VPN or in the VPC.\n\n"+
			"Underlying error: %s", msg)
	}

	return err
}

// looksLikeAuth keeps the diagnosis off errors that have nothing to do with
// getting in — a 404 on a kind, a conflict on a write.
func looksLikeAuth(msg string) bool {
	for _, needle := range []string{
		"getting credentials", "exec plugin", "invalid apiVersion", "interactive mode",
		"Unauthorized", "the server has asked for the client to provide credentials",
		"no such host", "connection refused", "i/o timeout", "context deadline exceeded",
	} {
		if strings.Contains(msg, needle) {
			return true
		}
	}
	return false
}

// UnreachableCluster reports whether a RESTMapper error means "digg could not
// reach the cluster" rather than "this cluster has no such kind".
//
// The distinction is the whole difference between a message that sends someone
// to `aws sso login` and one that sends them looking for a typo in "pods".
func UnreachableCluster(err error) bool {
	if err == nil {
		return false
	}
	var noResource *meta.NoResourceMatchError
	var noKind *meta.NoKindMatchError
	if errors.As(err, &noResource) || errors.As(err, &noKind) {
		return false
	}
	return true
}

func commandOf(cfg *clientcmdapi.ExecConfig) string {
	if cfg == nil || cfg.Command == "" {
		return "the credential plugin"
	}
	return cfg.Command
}

// execConfigFor reads the merged exec block for a context, or nil when the
// context authenticates some other way.
func execConfigFor(contextName string) *clientcmdapi.ExecConfig {
	cfg, err := loader(contextName).ClientConfig()
	if err != nil {
		return nil
	}
	return cfg.ExecProvider
}

// probeExec runs the credential plugin the way client-go would and returns what
// it printed to stderr — the half client-go drops on the floor.
//
// It deliberately does NOT run a plugin that declares itself interactive: that
// one wants a terminal, and running it here would either block on a read or
// fire off an MFA prompt nobody asked for. That case is handled above without
// touching the plugin.
func probeExec(contextName string, cfg *clientcmdapi.ExecConfig) string {
	if cfg == nil || cfg.Command == "" || cfg.InteractiveMode == clientcmdapi.AlwaysExecInteractiveMode {
		return ""
	}

	diagMu.Lock()
	if e, ok := diagCache[contextName]; ok && time.Since(e.at) < diagTTL {
		diagMu.Unlock()
		return e.stderr
	}
	diagMu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, cfg.Command, cfg.Args...)
	cmd.Env = os.Environ()
	for _, kv := range cfg.Env {
		cmd.Env = append(cmd.Env, kv.Name+"="+kv.Value)
	}
	// Some plugins branch on this being present. The contents do not matter to
	// `aws eks get-token`, which takes the cluster from its own arguments.
	cmd.Env = append(cmd.Env, `KUBERNETES_EXEC_INFO={"apiVersion":"`+cfg.APIVersion+
		`","kind":"ExecCredential","spec":{"interactive":false}}`)

	var stderr bytes.Buffer
	cmd.Stdout = nil
	cmd.Stderr = &stderr
	runErr := cmd.Run()

	out := strings.TrimSpace(stderr.String())
	if out == "" && runErr != nil {
		out = runErr.Error()
	}

	diagMu.Lock()
	diagCache[contextName] = diagEntry{at: time.Now(), stderr: out}
	diagMu.Unlock()
	return out
}

// fixFor turns the plugin's own words into the command that fixes them. Every
// pattern here is a real AWS CLI message; when none match, the plugin's output
// is already on screen above and inventing advice would only add noise.
func fixFor(stderr string) string {
	low := strings.ToLower(stderr)
	switch {
	case strings.Contains(low, "sso") && (strings.Contains(low, "expired") || strings.Contains(low, "refresh failed")):
		return "\nYour SSO session has expired. Log in again, then reload digg:\n\n    aws sso login --profile <profile>\n"
	case strings.Contains(low, "could not be found") && strings.Contains(low, "profile"):
		return "\nThat profile is not in ~/.aws/config. Either name one that is, or point digg at " +
			"it before starting:\n\n    AWS_PROFILE=<profile> digg\n\n" +
			"`aws configure list-profiles` shows what you have.\n"
	case strings.Contains(low, "unable to locate credentials"):
		return "\nThe AWS CLI has no credentials for this profile. Depending on how you sign in:\n\n" +
			"    aws sso login --profile <profile>    # IAM Identity Center\n" +
			"    aws configure --profile <profile>    # long-lived keys\n\n" +
			"If you use aws-vault or saml2aws, digg must be started from inside that session.\n"
	case strings.Contains(low, "expiredtoken") || strings.Contains(low, "security token included in the request is expired"):
		return "\nThe session token has expired. Refresh it and reload digg.\n"
	case strings.Contains(low, "accessdenied") || strings.Contains(low, "not authorized to perform"):
		return "\nThis identity is not allowed to mint a token for that cluster — it needs " +
			"eks:DescribeCluster. `aws sts get-caller-identity` shows who you are.\n"
	}
	return ""
}

// indent keeps a multi-line plugin message inside the block quote it is
// introduced with, so a stack of AWS output does not read as digg's own prose.
func indent(s string) string {
	return strings.ReplaceAll(strings.TrimSpace(s), "\n", "\n    ")
}

// ── the connection check behind `digg doctor` ───────────────────────────────

// Health is one context's verdict.
type Health struct {
	Context string
	// Auth is how this context proves who it is, in one phrase.
	Auth string
	// Server is the apiserver's version when the check got through.
	Server string
	// Err is the diagnosed failure, already carrying the fix.
	Err error
}

// OK reports whether digg could actually reach this cluster.
func (h Health) OK() bool { return h.Err == nil }

// Check answers "would digg work against this context right now?" — and when
// the answer is no, why.
//
// This is a real round trip on purpose. Everything cheaper (does the kubeconfig
// parse, does the context exist) already passed for every user who has ever
// reported that digg "cannot see" their EKS cluster: the context is right
// there in the picker, and it is the credential plugin behind it that is
// failing. Only a request finds that out.
func Check(contextName string) Health {
	h := Health{Context: contextName, Auth: describeAuth(contextName)}

	cl, err := For(contextName)
	if err != nil {
		h.Err = err
		return h
	}
	v, err := cl.Discovery.ServerVersion()
	if err != nil {
		h.Err = Diagnose(contextName, err)
		return h
	}
	h.Server = v.GitVersion
	return h
}

// CheckAll runs Check over every context in the kubeconfig, concurrently — a
// broken context blocks for its plugin's timeout, and doing forty of them one
// after another is a coffee break.
func CheckAll() ([]Health, error) {
	names, err := Contexts()
	if err != nil {
		return nil, err
	}
	out := make([]Health, len(names))
	var wg sync.WaitGroup
	for i, name := range names {
		wg.Add(1)
		go func(i int, name string) {
			defer wg.Done()
			out[i] = Check(name)
		}(i, name)
	}
	wg.Wait()
	return out, nil
}

// describeAuth names the credential method in a phrase, so `digg doctor` can
// show at a glance which contexts go through a plugin — the ones where "it
// works in kubectl but not here" is worth investigating.
func describeAuth(contextName string) string {
	cfg, err := loader(contextName).ClientConfig()
	if err != nil {
		// The kubeconfig itself is broken; Check will report the real error.
		return "unknown"
	}
	switch {
	case cfg.ExecProvider != nil:
		return "exec plugin: " + strings.Join(
			append([]string{cfg.ExecProvider.Command}, cfg.ExecProvider.Args...), " ")
	case cfg.AuthProvider != nil:
		return "auth provider: " + cfg.AuthProvider.Name
	case cfg.BearerToken != "" || cfg.BearerTokenFile != "":
		return "bearer token"
	case len(cfg.CertData) > 0 || cfg.CertFile != "":
		return "client certificate"
	case cfg.Username != "":
		return "basic auth"
	}
	return "anonymous"
}
