# Sets up a Windows machine to build, run and test W3Proj Studio: the counterpart of scripts/setup-linux.sh.
# Started by scripts/setup-windows.bat (which passes its arguments on):
#
#   --check       only report what's there and what's missing; changes nothing
#   --game PATH   use this Warcraft III folder (else the one already chosen, else the newest install found)
#
# Safe to run again: anything already installed is left alone, and a chosen game folder is kept.
# Installs go through winget (App Installer, part of Windows 10/11). What it sets up is in README.md ("Windows").
#
# Not here, on purpose: tauri-driver and Xvfb (on Windows the smoke tests drive WebView2 over the DevTools protocol)
# and the hidden World Editor (scripts/we-drive.mjs runs it through Proton in Xvfb, Linux only).

$ErrorActionPreference = "Stop"

$CheckOnly = $false
$GameArg = ""
for ($i = 0; $i -lt $args.Count; $i++) {
  switch ($args[$i]) {
    "--check" { $CheckOnly = $true }
    "--game" { $i++; if ($i -ge $args.Count) { Write-Error "--game needs a folder" }; $GameArg = $args[$i] }
    { $_ -in "-h", "--help" } { Get-Content $PSCommandPath -TotalCount 9 | Select-Object -Skip 2 | ForEach-Object { $_ -replace "^# ?", "" }; exit 0 }
    default { Write-Host "unknown option: $($args[$i]) (see --help)"; exit 2 }
  }
}

$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$NodeMajor = 22             # Vite 7 needs Node 20.19+ or 22.12+
$ActionlintVersion = "1.7.7"

$script:missing = @()
function Ok($what) { Write-Host "  " -NoNewline; Write-Host "ok      " -ForegroundColor Green -NoNewline; Write-Host " $what" }
function Miss($what) { Write-Host "  " -NoNewline; Write-Host "missing " -ForegroundColor Yellow -NoNewline; Write-Host " $what"; $script:missing += $what }
function Step($what) { Write-Host ""; Write-Host $what -ForegroundColor White }
function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

# PATH as the registry has it now, so programs winget just installed are found without a new terminal.
function Update-Path {
  $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $user = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$machine;$user;$env:USERPROFILE\.cargo\bin"
}

function Winget-Install($id, $extra = @()) {
  if (-not (Have winget)) { Write-Host "  winget isn't there (install App Installer from the Microsoft Store), install $id by hand"; return }
  Write-Host "  installing $id (winget)"
  & winget install --id $id --exact --silent --accept-package-agreements --accept-source-agreements @extra
  Update-Path
}

# --- C++ build tools (MSVC) -------------------------------------------------------------------
# Rust's Windows target links with Microsoft's linker; Tauri's crates compile C code with cl.exe.
Step "MSVC C++ build tools"
$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
$vc = $null
if (Test-Path $vswhere) {
  $vc = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property displayName
}
if ($vc) { Ok "$vc (VC tools)" } else {
  Miss "MSVC build tools"
  if (-not $CheckOnly) {
    Winget-Install "Microsoft.VisualStudio.2022.BuildTools" @("--override", "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended")
  }
}

# --- WebView2 ---------------------------------------------------------------------------------
Step "WebView2 runtime (the app's webview)"
$wv = @(
  "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
  "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
  "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
) | ForEach-Object { (Get-ItemProperty $_ -ErrorAction SilentlyContinue).pv } | Where-Object { $_ -and $_ -ne "0.0.0.0" } | Select-Object -First 1
if ($wv) { Ok "WebView2 $wv" } else {
  Miss "WebView2"
  if (-not $CheckOnly) { Winget-Install "Microsoft.EdgeWebView2Runtime" }
}

# --- Rust -------------------------------------------------------------------------------------
Step "Rust (version pinned in rust-toolchain.toml)"
if (-not (Have rustup)) { Update-Path }
if (Have rustup) { Ok "rustup" } else {
  Miss "rustup"
  if (-not $CheckOnly) { Winget-Install "Rustlang.Rustup" }
}
if (Have rustup) {
  Push-Location $Repo
  try {
    & rustup show active-toolchain *> $null
    if ($LASTEXITCODE -ne 0) {
      if ($CheckOnly) { Miss "the pinned Rust toolchain" } else { & rustup toolchain install }
    }
    $rv = & rustc --version 2>$null
    if ($rv) { Write-Host "  $rv" }
  } finally { Pop-Location }
}

# --- Node -------------------------------------------------------------------------------------
Step "Node $NodeMajor+"
function Node-Major { try { [int]((& node -v) -replace "^v(\d+).*", '$1') } catch { 0 } }
if ((Node-Major) -ge $NodeMajor) { Ok "node $(& node -v)" } else {
  $have = if (Have node) { & node -v } else { "none" }
  Miss "node $NodeMajor (have: $have)"
  if (-not $CheckOnly) { Winget-Install "OpenJS.NodeJS.LTS" }
}

# --- compiler cache (sccache) -----------------------------------------------------------------
# As on Linux: shared by this checkout and its worktrees, in target/tools, wired up by the local .cargo/config.toml.
# That file's paths are relative to the checkout, so one file serves a checkout shared with a Linux machine. Optional:
# without it builds are only slower. But a config that names sccache needs it here too, or cargo can't start rustc.
Step "sccache (a compiler cache shared by the worktrees)"
$Sccache = Join-Path $Repo "target\tools\bin\sccache.exe"
if (Test-Path $Sccache) { Ok "sccache" } else {
  Miss "sccache"
  if (-not $CheckOnly -and (Have cargo)) {
    # From outside the checkout: its .cargo/config.toml may name a wrapper that isn't on this machine yet.
    Push-Location ([IO.Path]::GetTempPath())
    try { & cargo install sccache --locked --root (Join-Path $Repo "target\tools") } finally { Pop-Location }
  }
}
$CargoConfig = Join-Path $Repo ".cargo\config.toml"
$ourConfig = (Test-Path $CargoConfig) -and (Select-String -Path $CargoConfig -Pattern "written by scripts/setup-" -Quiet)
$relative = (Test-Path $CargoConfig) -and (Select-String -Path $CargoConfig -Pattern '^rustc-wrapper = "target/' -Quiet)
if ((Test-Path $CargoConfig) -and -not $ourConfig) {
  Write-Host "  .cargo/config.toml was written by hand: left alone"
} elseif ($relative) {
  Ok ".cargo/config.toml (sccache)"
} elseif (Test-Path $Sccache) {
  if ($CheckOnly) { Miss ".cargo/config.toml (sccache)" } else {
    New-Item -ItemType Directory -Force (Join-Path $Repo ".cargo") | Out-Null
    $text = @'
# Local only (git-ignored), written by scripts/setup-linux.sh or scripts/setup-windows.bat: a shared compiler cache
# for this checkout and every worktree under .worktrees/ (cargo reads this file from the parent folders). The paths
# are relative to the checkout, so one file serves Linux and Windows; each needs sccache in target/tools/bin.
[build]
rustc-wrapper = "target/tools/bin/sccache"

[env]
SCCACHE_DIR = { value = "target/sccache", relative = true }
SCCACHE_CACHE_SIZE = "15G"
'@
    [IO.File]::WriteAllText($CargoConfig, ($text -replace "`r`n", "`n"))
    Ok ".cargo/config.toml (sccache)"
  }
} elseif ($ourConfig) {
  # An older config with absolute paths (another machine's): cargo fails with it until sccache is here.
  Miss ".cargo/config.toml names a wrapper that isn't on this machine (install sccache, or delete the file)"
}

# --- actionlint -------------------------------------------------------------------------------
Step "actionlint (checks the CI workflow files)"
$Actionlint = Join-Path $Repo "target\tools\bin\actionlint.exe"
if (Test-Path $Actionlint) { Ok "actionlint" } else {
  Miss "actionlint"
  if (-not $CheckOnly) {
    $v = $ActionlintVersion; $zip = "actionlint_${v}_windows_amd64.zip"
    $url = "https://github.com/rhysd/actionlint/releases/download/v$v"
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("actionlint-" + [Guid]::NewGuid())
    New-Item -ItemType Directory $tmp | Out-Null
    try {
      Invoke-WebRequest "$url/$zip" -OutFile (Join-Path $tmp $zip) -UseBasicParsing
      # To a file: GitHub sends release files as octet-stream, which Windows PowerShell's .Content gives as bytes.
      Invoke-WebRequest "$url/actionlint_${v}_checksums.txt" -OutFile (Join-Path $tmp "sums.txt") -UseBasicParsing
      $want = (Get-Content (Join-Path $tmp "sums.txt") | Where-Object { $_.Trim() -match " $([regex]::Escape($zip))$" } | Select-Object -First 1) -replace "\s.*$", ""
      $got = (Get-FileHash (Join-Path $tmp $zip) -Algorithm SHA256).Hash
      if ($want -and $got -ieq $want.Trim()) {
        Expand-Archive (Join-Path $tmp $zip) -DestinationPath (Join-Path $tmp "x")
        New-Item -ItemType Directory -Force (Split-Path $Actionlint) | Out-Null
        Copy-Item (Join-Path $tmp "x\actionlint.exe") $Actionlint
        Ok "actionlint $v"
      } else { Write-Host "  actionlint $v didn't match its checksum; skipped (optional)" }
    } catch { Write-Host "  couldn't download actionlint ${v}: $($_.Exception.Message); skipped (optional)" }
    finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
  }
}

# --- npm packages -----------------------------------------------------------------------------
# A checkout copied from Linux has Linux builds of esbuild and rollup in node_modules: `npm ci` replaces them.
Step "npm packages in app/"
$esbuildWin = Test-Path (Join-Path $Repo "app\node_modules\@esbuild\win32-x64")
if ($esbuildWin) { Ok "app/node_modules" } else {
  if (Test-Path (Join-Path $Repo "app\node_modules")) { Miss "app/node_modules (has no Windows builds: copied from Linux?)" } else { Miss "app/node_modules" }
  if (-not $CheckOnly -and (Node-Major) -ge $NodeMajor) {
    Push-Location (Join-Path $Repo "app"); try { & npm ci } finally { Pop-Location }
  }
}

# A Yarn Plug'n'Play manifest in a folder above the checkout (a `yarn` once run in the home folder leaves one):
# esbuild finds it and refuses every import its list doesn't name, so the unit tests and the headless bundle fail with
# "The Yarn Plug'n'Play manifest forbids importing ...". Only reported: the folder isn't this checkout's.
$dir = Split-Path $Repo
while ($dir) {
  foreach ($f in ".pnp.cjs", ".pnp.js") {
    $p = Join-Path $dir $f
    if (Test-Path $p) { Miss "no Yarn PnP manifest above the checkout: $p breaks esbuild's imports (rename or delete it)" }
  }
  $parent = Split-Path $dir
  if ($parent -eq $dir) { break }
  $dir = $parent
}

# --- Warcraft III -----------------------------------------------------------------------------
# The game's files (CASC storage) are read, never copied. The choice goes into .game-path (git-ignored), one folder per
# line, the first that exists counts (tests/gamepath.mjs), so a checkout shared with a Linux machine keeps its line.
Step "Warcraft III (the game's files, for new maps and the corpus tests)"

function Game-Build($dir) {
  $info = Join-Path $dir ".build.info"
  if (-not (Test-Path $info)) { return $null }
  $lines = Get-Content $info
  $cols = $lines[0] -split "\|"
  $col = [Array]::FindIndex($cols, [Predicate[string]] { param($c) $c -like "Version!*" })
  if ($col -lt 0) { return $null }
  foreach ($l in $lines | Select-Object -Skip 1) { $v = ($l -split "\|")[$col]; if ($v) { return $v } }
  return $null
}

$candidates = @(
  (Join-Path ${env:ProgramFiles(x86)} "Warcraft III"),
  (Join-Path $env:ProgramFiles "Warcraft III"),
  (Split-Path $Repo)
)
foreach ($key in "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Warcraft III",
                 "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Warcraft III") {
  $loc = (Get-ItemProperty $key -ErrorAction SilentlyContinue).InstallLocation
  if ($loc) { $candidates += $loc }
}
$found = $candidates | Where-Object { $_ -and (Test-Path (Join-Path $_ ".build.info")) } |
  ForEach-Object { (Resolve-Path $_).Path.TrimEnd("\") } | Select-Object -Unique

$GameFile = Join-Path $Repo ".game-path"
$listed = @()
if (Test-Path $GameFile) { $listed = @(Get-Content $GameFile | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith("#") }) }
$current = $listed | Where-Object { Test-Path -LiteralPath $_ -PathType Container } | Select-Object -First 1
if (-not $current -and $listed.Count) { $current = $listed[0] }
# Compared as Windows paths: .game-path may use / or \.
function Same($a, $b) { $a -and $b -and (($a -replace "/", "\").TrimEnd("\") -ieq ($b -replace "/", "\").TrimEnd("\")) }

$newest = $null; $newestBuild = $null
foreach ($g in $found) {
  $b = Game-Build $g; if (-not $b) { $b = "?" }
  $mark = if (Same $g $current) { " (chosen)" } else { "" }
  Write-Host "  found    build $b  $g$mark"
  if ($b -ne "?" -and (-not $newestBuild -or [version]$b -gt [version]$newestBuild)) { $newest = $g; $newestBuild = $b }
}

if ($GameArg) {
  if (-not (Test-Path (Join-Path $GameArg ".build.info"))) { Write-Host "  --game: no Warcraft III install (no .build.info) in $GameArg"; exit 1 }
  $pick = (Resolve-Path $GameArg).Path.TrimEnd("\")
} elseif ($current -and (Test-Path -LiteralPath $current -PathType Container)) {
  $pick = $current
} else {
  $pick = $newest
}

if ($env:W3PROJ_GAME) { Write-Host "  note: W3PROJ_GAME is set ($env:W3PROJ_GAME) and wins over .game-path" }
if (-not $pick) {
  Miss "Warcraft III"
  Write-Host "  none found. Install it through Battle.net, then run this again,"
  Write-Host "  or point to it: scripts\setup-windows.bat --game ""D:\Games\Warcraft III"""
} elseif (-not (Test-Path (Join-Path $pick ".build.info"))) {
  Miss "Warcraft III (.game-path points to $pick, which isn't an install)"
} else {
  Ok "Warcraft III build $(Game-Build $pick)  $pick"
  if ($newest -and -not (Same $pick $newest) -and -not $GameArg) { Write-Host "  note: a newer build ($newestBuild) is at $newest; choose it with --game" }
  # Forward slashes: the line is read on Linux too (as a folder that isn't there), and Node takes either on Windows.
  $pickLine = $pick -replace "\\", "/"
  $first = if ($listed.Count) { $listed[0] } else { $null }
  if (-not (Same $first $pick)) {
    if ($CheckOnly) { Miss ".game-path (run without --check to choose the folder above)" } else {
      $keep = $listed | Where-Object { -not (Same $_ $pick) -and -not (Test-Path -LiteralPath $_ -PathType Container) }
      $text = @(
        "# The Warcraft III folder for the tests and tools (tests/gamepath.mjs): the first line that exists counts.",
        "# Written by scripts/setup-linux.sh and scripts/setup-windows.bat.",
        $pickLine
      ) + $keep
      [IO.File]::WriteAllText($GameFile, (($text -join "`n") + "`n"))
      Write-Host "  wrote .game-path"
    }
  }
  Write-Host "  the app asks for its game folder at start when it has none that opens;"
  Write-Host "  later: ""Game Data: Choose Warcraft III Folder..."""
}

# --- Summary ----------------------------------------------------------------------------------
Step "Summary"
if ($CheckOnly) {
  if ($script:missing.Count) { Write-Host "  missing: $($script:missing -join ', ')"; Write-Host "  run without --check to install"; exit 1 }
  Write-Host "  everything is there"
} else {
  Write-Host "  done. Open a new terminal so newly installed programs are on PATH,"
  Write-Host "  then check with: scripts\setup-windows.bat --check"
}
