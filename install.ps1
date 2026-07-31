# digg installer for Windows.
#   irm https://raw.githubusercontent.com/notshekhar/digg/main/install.ps1 | iex
#
# Downloads the prebuilt binary for this machine from GitHub Releases. No node,
# no bun, no package manager — the runtime is inside the binary.
#
# Layout after install:
#   $DiggHome\                        (default: %LOCALAPPDATA%\digg)
#     ├── digg.exe
#     └── package.json                version, read via dirname(execPath)
#
# digg reads your kubeconfig directly and talks to the API server itself, so
# kubectl is not needed at runtime. Every auth method still works, including
# exec credential plugins (aws/gcp/oidc) — those are launched from the
# kubeconfig, not from kubectl.
#
# Parameters:
#   -Version <vX.Y.Z>   pin a specific tag        (env DIGG_VERSION)
#   -Force              reinstall even if current (env DIGG_FORCE=1)
#   -Uninstall          remove the install        (env DIGG_UNINSTALL=1)
#   -NoModifyPath       do not touch the user PATH

[CmdletBinding()]
param(
    [string]$Version = $env:DIGG_VERSION,
    [switch]$Force,
    [switch]$Uninstall,
    [switch]$NoModifyPath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RepoSlug = if ($env:DIGG_REPO_SLUG) { $env:DIGG_REPO_SLUG } else { "notshekhar/digg" }
$DiggHome = if ($env:DIGG_HOME) { $env:DIGG_HOME } else { Join-Path $env:LOCALAPPDATA "digg" }
if ($env:DIGG_FORCE -eq "1") { $Force = $true }
if ($env:DIGG_UNINSTALL -eq "1") { $Uninstall = $true }
if ($env:DIGG_NO_MODIFY_PATH -eq "1") { $NoModifyPath = $true }

function Write-Bold($text) { Write-Host $text -ForegroundColor White }
function Write-Dim($text) { Write-Host $text -ForegroundColor DarkGray }
function Write-Err($text) { Write-Host $text -ForegroundColor Red }

# ── Download ───────────────────────────────────────────────────────────────
# Streamed, with the live ■■■···  42% bar. Same implementation hehe, loop and
# markdown ship: HttpClient with ResponseHeadersRead so the bar starts moving
# before the body lands. Throws on HTTP errors; the caller falls back to
# Invoke-WebRequest on any failure (older hosts, redirected console, missing
# System.Net.Http, …).
function Download-WithProgress {
    param([string]$Url, [string]$OutFile)

    # Windows PowerShell 5.1 needs the assembly loaded explicitly.
    try { Add-Type -AssemblyName System.Net.Http -ErrorAction SilentlyContinue } catch {}

    $client = [System.Net.Http.HttpClient]::new()
    $client.DefaultRequestHeaders.UserAgent.ParseAdd("digg-installer")
    $stream = $null
    $file = $null
    try {
        $resp = $client.GetAsync($Url, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
        if (-not $resp.IsSuccessStatusCode) { throw "HTTP $([int]$resp.StatusCode)" }
        $total = $resp.Content.Headers.ContentLength
        $stream = $resp.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $file = [System.IO.File]::Create($OutFile)

        $buf = New-Object byte[] 262144
        $done = 0
        $width = 50
        $lastPct = -1
        try { [Console]::CursorVisible = $false } catch {}
        while (($n = $stream.Read($buf, 0, $buf.Length)) -gt 0) {
            $file.Write($buf, 0, $n)
            $done += $n
            if ($total) {
                $pct = [int][math]::Min(100, ($done * 100 / $total))
                if ($pct -ne $lastPct) {
                    $on = [int]($pct * $width / 100)
                    # "·" (U+00B7) over opencode's "･": it exists in the legacy
                    # conhost codepages, so old terminals degrade gracefully.
                    $bar = ("■" * $on) + ("·" * ($width - $on))
                    Write-Host -NoNewline ("`r$bar {0,3}%" -f $pct) -ForegroundColor DarkYellow
                    $lastPct = $pct
                }
            }
        }
        if ($lastPct -ge 0) { Write-Host "" }
    } finally {
        try { [Console]::CursorVisible = $true } catch {}
        if ($file) { $file.Dispose() }
        if ($stream) { $stream.Dispose() }
        $client.Dispose()
    }
}

function Get-File($url, $out) {
    $downloaded = $false
    if (-not [Console]::IsOutputRedirected) {
        try {
            Download-WithProgress -Url $url -OutFile $out
            $downloaded = $true
        } catch {
            Remove-Item $out -Force -ErrorAction SilentlyContinue
        }
    }
    if (-not $downloaded) {
        Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing
    }
}

function Resolve-LatestTag {
    # The releases/latest redirect is not rate-limited the way the API is.
    try {
        $res = Invoke-WebRequest -Uri "https://github.com/$RepoSlug/releases/latest" `
            -MaximumRedirection 0 -ErrorAction SilentlyContinue -UseBasicParsing
        $loc = $res.Headers.Location
    } catch {
        $loc = $_.Exception.Response.Headers["Location"]
    }
    if ($loc -and $loc -match "/tag/(.+)$") { return $Matches[1] }
    $json = Invoke-RestMethod -Uri "https://api.github.com/repos/$RepoSlug/releases/latest" -UseBasicParsing
    return $json.tag_name
}

function Add-ToUserPath($dir) {
    $current = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($current -and $current.Split(";") -contains $dir) { return }
    if ($NoModifyPath) { Write-Dim "  add to PATH yourself: $dir"; return }
    $next = if ($current) { "$current;$dir" } else { $dir }
    [Environment]::SetEnvironmentVariable("Path", $next, "User")
    $env:Path = "$env:Path;$dir"
    Write-Dim "  added $dir to your PATH (new terminals pick it up)"
}

# ── Uninstall ──────────────────────────────────────────────────────────────
if ($Uninstall) {
    Write-Bold "Removing digg"
    if (Test-Path $DiggHome) {
        Remove-Item -Recurse -Force $DiggHome
        Write-Dim "  removed $DiggHome"
    }
    $current = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($current) {
        $kept = ($current.Split(";") | Where-Object { $_ -and $_ -ne $DiggHome }) -join ";"
        [Environment]::SetEnvironmentVariable("Path", $kept, "User")
    }
    Write-Dim "  your preferences are untouched in $env:USERPROFILE\.digg"
    Write-Bold "Done."
    exit 0
}

# ── Install ────────────────────────────────────────────────────────────────
$arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { $null }
if (-not $arch) { Write-Err "digg needs 64-bit Windows"; exit 1 }
$target = "windows-$arch"

$tag = $Version
if (-not $tag) { $tag = Resolve-LatestTag }
if (-not $tag) { Write-Err "could not resolve the latest release of $RepoSlug"; exit 1 }
if ($tag -notmatch "^v") { $tag = "v$tag" }

$exe = Join-Path $DiggHome "digg.exe"
$installed = ""
if (Test-Path $exe) {
    try { $installed = (& $exe version 2>$null).Trim() } catch { $installed = "" }
}

Write-Host "digg " -NoNewline -ForegroundColor Green
Write-Dim $target
if ($installed -and -not $Force) {
    if ([version]$installed -ge [version]($tag.TrimStart("v"))) {
        Write-Bold "Already at $installed (latest $tag)"
        exit 0
    }
    Write-Dim "  update: $installed -> $($tag.TrimStart('v'))"
} else {
    Write-Dim "  installing $($tag.TrimStart('v'))"
}

$scratch = Join-Path ([System.IO.Path]::GetTempPath()) ("digg-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $scratch -Force | Out-Null
try {
    $asset = "digg-$target.tar.gz"
    $url = "https://github.com/$RepoSlug/releases/download/$tag/$asset"
    $tarball = Join-Path $scratch $asset

    Get-File $url $tarball
    if (-not (Test-Path $tarball) -or (Get-Item $tarball).Length -eq 0) {
        Write-Err "downloaded nothing from $url"; exit 1
    }

    # A missing checksum is a warning; a mismatched one is fatal.
    try {
        $sumFile = Join-Path $scratch "sum"
        Invoke-WebRequest -Uri "$url.sha256" -OutFile $sumFile -UseBasicParsing
        $want = (Get-Content $sumFile -Raw).Trim().Split(" ")[0]
        $got = (Get-FileHash $tarball -Algorithm SHA256).Hash.ToLower()
        if ($want -ne $got) {
            Write-Err "checksum mismatch - refusing to install"
            Write-Err "  expected $want"
            Write-Err "  got      $got"
            exit 1
        }
        Write-Dim "  sha256 ok"
    } catch {
        Write-Dim "  no published checksum for this asset"
    }

    if (Test-Path $DiggHome) { Remove-Item -Recurse -Force $DiggHome }
    New-Item -ItemType Directory -Path $DiggHome -Force | Out-Null
    # tar ships with Windows 10 1803+. The tarball holds one directory named for
    # the target; strip it so digg.exe lands directly in the home.
    & tar -xzf $tarball -C $DiggHome --strip-components=1
    if ($LASTEXITCODE -ne 0) { Write-Err "extract failed"; exit 1 }
} finally {
    Remove-Item -Recurse -Force $scratch -ErrorAction SilentlyContinue
}

Add-ToUserPath $DiggHome

$version = & $exe version
Write-Host ""
Write-Bold "digg $version"
# digg talks to the API server itself; kubectl is not a runtime dependency.
# A missing kubeconfig is the thing that actually stops it working.
if (-not ($env:KUBECONFIG -or (Test-Path (Join-Path $HOME ".kube\config")))) {
    Write-Err "  no kubeconfig found — digg needs one to reach your clusters"
}
Write-Dim "  run: digg"
Write-Dim "  it opens http://127.0.0.1:9787 - your clusters, in the browser."
