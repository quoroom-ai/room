param(
  [string]$Version = "",
  [string]$OutFile = "",
  [switch]$SkipBuild = $false
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Require-Command([string]$Name) {
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $cmd) {
    throw "Required command not found: $Name"
  }
  return $cmd.Source
}

function Find-Makensis() {
  $fromPath = Get-Command "makensis" -ErrorAction SilentlyContinue
  if (-not $fromPath) { $fromPath = Get-Command "makensis.exe" -ErrorAction SilentlyContinue }
  if ($fromPath) { return $fromPath.Source }

  $candidates = @(
    "${env:ProgramFiles(x86)}\NSIS\makensis.exe",
    "${env:ProgramFiles(x86)}\NSIS\Bin\makensis.exe",
    "$env:ChocolateyInstall\bin\makensis.exe",
    "C:\ProgramData\chocolatey\bin\makensis.exe"
  ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }

  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) { return $candidate }
  }

  return $null
}

function Get-ViVersion([string]$VersionString) {
  $base = ($VersionString -replace "-.*", "")
  $parts = $base.Split(".")
  while ($parts.Count -lt 4) { $parts += "0" }
  return ($parts[0..3] -join ".")
}

function Assert-WindowsPe([string]$FilePath, [string]$Name) {
  if (-not (Test-Path $FilePath)) {
    throw "$Name not found at $FilePath"
  }
  $bytes = [System.IO.File]::ReadAllBytes($FilePath)
  if ($bytes.Length -lt 2 -or $bytes[0] -ne 0x4D -or $bytes[1] -ne 0x5A) {
    throw "$Name is not a Windows PE binary: $FilePath"
  }
}

function Write-CrLfAsciiFile([string]$Path, [string[]]$Lines) {
  $content = ($Lines -join "`r`n") + "`r`n"
  [System.IO.File]::WriteAllText($Path, $content, [System.Text.Encoding]::ASCII)
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot

if ($env:OS -ne "Windows_NT") {
  throw "Windows installer build must run on Windows."
}

$npm = Require-Command "npm.cmd"
$makensis = Find-Makensis
if (-not $makensis) {
  throw "makensis not found. Install NSIS first."
}

$pkg = Get-Content (Join-Path $repoRoot "package.json") -Raw | ConvertFrom-Json
if (-not $Version) { $Version = [string]$pkg.version }
if (-not $OutFile) { $OutFile = "artifacts/windows/quoroom-v$Version-win-local.exe" }

$viVersion = Get-ViVersion $Version
$outPath = if ([System.IO.Path]::IsPathRooted($OutFile)) { $OutFile } else { Join-Path $repoRoot $OutFile }
$outDir = Split-Path -Parent $outPath
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

if (-not $SkipBuild) {
& $npm run build
  if ($LASTEXITCODE -ne 0) { throw "npm run build failed." }
}

$outMcp = Join-Path $repoRoot "out/mcp"
$outUi = Join-Path $repoRoot "out/ui"
if (-not (Test-Path $outMcp)) { throw "Missing build output: $outMcp" }
if (-not (Test-Path $outUi)) { throw "Missing build output: $outUi" }

$nodeModules = Join-Path $outMcp "node_modules"
if (Test-Path $nodeModules) {
  Remove-Item -Recurse -Force $nodeModules
}

Push-Location $outMcp
try {
  & $npm install --omit=dev
  if ($LASTEXITCODE -ne 0) { throw "npm install for out/mcp failed." }
} finally {
  Pop-Location
}

$betterSqlite = Join-Path $nodeModules "better-sqlite3/build/Release/better_sqlite3.node"
Assert-WindowsPe $betterSqlite "better-sqlite3 native module"

$nodeVersion = "20.18.1"
$cacheDir = Join-Path $repoRoot ".cache"
$nodeZip = Join-Path $cacheDir "node-v$nodeVersion-win-x64.zip"
$nodeDir = Join-Path $cacheDir "node-v$nodeVersion-win-x64"
$nodeExe = Join-Path $nodeDir "node.exe"
New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null

if (-not (Test-Path $nodeExe)) {
  if (-not (Test-Path $nodeZip)) {
    Invoke-WebRequest -Uri "https://nodejs.org/dist/v$nodeVersion/node-v$nodeVersion-win-x64.zip" -OutFile $nodeZip
  }
  if (Test-Path $nodeDir) {
    Remove-Item -Recurse -Force $nodeDir
  }
  Expand-Archive -Path $nodeZip -DestinationPath $cacheDir -Force
}

Assert-WindowsPe $nodeExe "Bundled Node runtime"

$stagingRoot = Join-Path $repoRoot "staging"
$stagingApp = Join-Path $stagingRoot "quoroom"
if (Test-Path $stagingRoot) {
  Remove-Item -Recurse -Force $stagingRoot
}
New-Item -ItemType Directory -Force -Path `
  (Join-Path $stagingApp "bin"), `
  (Join-Path $stagingApp "lib"), `
  (Join-Path $stagingApp "runtime"), `
  (Join-Path $stagingApp "ui") | Out-Null

Copy-Item -Force $nodeExe (Join-Path $stagingApp "runtime/node.exe")

$wrapperPath = Join-Path $stagingApp "bin/quoroom.cmd"
Write-CrLfAsciiFile $wrapperPath @(
  "@echo off",
  "setlocal EnableExtensions EnableDelayedExpansion",
  "set ""RUNTIME=%~dp0\..\runtime\node.exe""",
  "set ""BUNDLED_CLI=%~dp0\..\lib\cli.js""",
  "set ""BUNDLED_MODULES=%~dp0\..\lib\node_modules""",
  "set ""BUNDLED_PKG=%~dp0\..\lib\package.json""",
  "set ""CLI=%BUNDLED_CLI%""",
  "set ""STATUS=1""",
  "set ""BUNDLED_VERSION=0.0.0""",
  "if exist ""%BUNDLED_PKG%"" (",
  "  for /f %%A in ('powershell -NoProfile -ExecutionPolicy Bypass -Command ""try { (Get-Content -Raw '%BUNDLED_PKG%' | ConvertFrom-Json).version } catch { '' }""') do set ""BUNDLED_VERSION=%%A""",
  ")",
  "",
  "rem Check for user-space auto-update",
  "set ""USER_APP=%USERPROFILE%\.quoroom\app""",
  "set ""USER_CLI=%USER_APP%\lib\cli.js""",
  "set ""BOOT_MARKER=%USER_APP%\.booting""",
  "set ""CRASH_COUNT_FILE=%USER_APP%\.crash_count""",
  "",
  "if not exist ""%USER_CLI%"" goto no_update",
  "if not exist ""%USER_APP%\version.json"" goto no_update",
  "set ""USER_VERSION=""",
  "for /f %%A in ('powershell -NoProfile -ExecutionPolicy Bypass -Command ""try { (Get-Content -Raw '%USER_APP%\version.json' | ConvertFrom-Json).version } catch { '' }""') do set ""USER_VERSION=%%A""",
  "if not defined USER_VERSION goto no_update",
  "call :SemverGt ""%USER_VERSION%"" ""%BUNDLED_VERSION%""",
  "if errorlevel 1 goto update_candidate",
  "rmdir /s /q ""%USER_APP%"" 2>NUL",
  "goto no_update",
  "",
  ":update_candidate",
  "if not exist ""%BOOT_MARKER%"" goto use_update",
  "rem Previous boot crashed; increment crash counter",
  "set /a COUNT=0",
  "if exist ""%CRASH_COUNT_FILE%"" set /p COUNT=<""%CRASH_COUNT_FILE%""",
  "set /a COUNT=%COUNT%+1",
  "echo %COUNT%>""%CRASH_COUNT_FILE%""",
  "if %COUNT% GEQ 3 (",
  "  echo Auto-update crashed 3 times, rolling back to bundled version 1>&2",
  "  rmdir /s /q ""%USER_APP%"" 2>NUL",
  "  goto no_update",
  ")",
  "",
  ":use_update",
  "if not exist ""%USER_CLI%"" goto no_update",
  "set ""CLI=%USER_CLI%""",
  "set ""NODE_PATH=%BUNDLED_MODULES%""",
  "",
  ":no_update",
  "",
  "if not exist ""%RUNTIME%"" goto fallback",
  """%RUNTIME%"" -e """" >NUL 2>NUL",
  "set ""STATUS=%ERRORLEVEL%""",
  "if ""%STATUS%""==""0"" goto run_bundled",
  "rem Runtime crash exits are often >=128 (for example 133). For normal runtime failures, keep original code.",
  "if ""%STATUS%""==""9009"" goto fallback",
  "if %STATUS% GEQ 128 goto fallback",
  "exit /b %STATUS%",
  "",
  ":run_bundled",
  """%RUNTIME%"" ""%CLI%"" %*",
  "exit /b %ERRORLEVEL%",
  "",
  ":fallback",
  "where node >NUL 2>NUL",
  "if errorlevel 1 (",
  "  echo Quoroom failed to start: bundled runtime exited with code %STATUS%, and no system node was found. 1>&2",
  "  exit /b %STATUS%",
  ")",
  "",
  "node ""%CLI%"" %*",
  "exit /b %ERRORLEVEL%",
  "",
  ":SemverGt",
  "setlocal EnableDelayedExpansion",
  "set ""A=%~1""",
  "set ""B=%~2""",
  "for /f ""tokens=1-3 delims=. -+"" %%a in (""!A!"") do (",
  "  set ""A1=%%a""",
  "  set ""A2=%%b""",
  "  set ""A3=%%c""",
  ")",
  "for /f ""tokens=1-3 delims=. -+"" %%a in (""!B!"") do (",
  "  set ""B1=%%a""",
  "  set ""B2=%%b""",
  "  set ""B3=%%c""",
  ")",
  "for %%v in (A1 A2 A3 B1 B2 B3) do if not defined %%v set ""%%v=0""",
  "for %%v in (A1 A2 A3 B1 B2 B3) do (",
  "  for /f ""delims=0123456789"" %%x in (""!%%v!"") do set ""%%v=0""",
  ")",
  "if !A1! GTR !B1! (endlocal & exit /b 1)",
  "if !A1! LSS !B1! (endlocal & exit /b 0)",
  "if !A2! GTR !B2! (endlocal & exit /b 1)",
  "if !A2! LSS !B2! (endlocal & exit /b 0)",
  "if !A3! GTR !B3! (endlocal & exit /b 1)",
  "endlocal & exit /b 0"
)

Copy-Item -Recurse -Force (Join-Path $outMcp "*") (Join-Path $stagingApp "lib")
Copy-Item -Recurse -Force (Join-Path $outUi "*") (Join-Path $stagingApp "ui")

$zipOut = Join-Path $outDir "quoroom-v$Version-win-local.zip"
if (Test-Path $zipOut) { Remove-Item -Force $zipOut }
Compress-Archive -Path $stagingApp -DestinationPath $zipOut -Force

$nsiPath = Join-Path $repoRoot "installers/windows/quoroom.nsi"
& $makensis `
  "/DVERSION=$Version" `
  "/DVI_VERSION=$viVersion" `
  "/DOUT_FILE=$outPath" `
  "/DSTAGING_DIR=$stagingApp" `
  $nsiPath
if ($LASTEXITCODE -ne 0) { throw "makensis failed." }

$hash = (Get-FileHash -Algorithm SHA256 $outPath).Hash.ToLowerInvariant()
Write-Host "Built installer: $outPath"
Write-Host "SHA256: $hash"
