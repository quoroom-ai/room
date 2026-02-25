param(
  [string]$InstallDir = ""
)

$ErrorActionPreference = "SilentlyContinue"

if ([string]::IsNullOrWhiteSpace($InstallDir)) {
  exit 0
}

try {
  $installRoot = [System.IO.Path]::GetFullPath($InstallDir).TrimEnd('\').ToLowerInvariant()
} catch {
  exit 0
}

$selfPid = $PID

function Is-QuoroomProcess([object]$ProcessInfo, [string]$RootLower) {
  $exe = ""
  $cmd = ""
  if ($ProcessInfo.ExecutablePath) { $exe = $ProcessInfo.ExecutablePath.ToLowerInvariant() }
  if ($ProcessInfo.CommandLine) { $cmd = $ProcessInfo.CommandLine.ToLowerInvariant() }

  if ($exe.Contains($RootLower) -or $cmd.Contains($RootLower)) { return $true }
  if ($cmd.Contains("quoroom-tray.ps1") -or $cmd.Contains("quoroom-launch.vbs")) { return $true }
  if ($cmd.Contains("\quoroom\bin\quoroom.cmd")) { return $true }
  return $false
}

# Kill by port ownership first (catches elevated/zombie processes with unreadable command lines)
$portProcs = Get-NetTCPConnection -LocalPort 3700 -EA SilentlyContinue |
  Where-Object { $_.OwningProcess -gt 4 } |
  Select-Object -ExpandProperty OwningProcess -Unique

foreach ($portProc in $portProcs) {
  if ($portProc -ne $selfPid) {
    try { Stop-Process -Id $portProc -Force -EA SilentlyContinue } catch {}
    try { & taskkill /F /T /PID $portProc 2>$null | Out-Null } catch {}
  }
}

# Kill by process name + path matching
$filter = "Name='node.exe' OR Name='powershell.exe' OR Name='pwsh.exe' OR Name='wscript.exe' OR Name='cscript.exe' OR Name='cmd.exe'"

for ($attempt = 0; $attempt -lt 5; $attempt++) {
  $candidates = @(Get-CimInstance Win32_Process -Filter $filter)
  $targets = @($candidates | Where-Object { $_.ProcessId -ne $selfPid -and (Is-QuoroomProcess $_ $installRoot) })

  if ($targets.Count -eq 0) {
    break
  }

  foreach ($proc in $targets) {
    try { Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop } catch {}
    try { & taskkill /PID $proc.ProcessId /T /F | Out-Null } catch {}
  }

  Start-Sleep -Milliseconds 600
}

# Final check: kill any remaining port 3700 owners
Start-Sleep -Milliseconds 300
$remaining = Get-NetTCPConnection -LocalPort 3700 -EA SilentlyContinue |
  Where-Object { $_.OwningProcess -gt 4 -and $_.OwningProcess -ne $selfPid } |
  Select-Object -ExpandProperty OwningProcess -Unique

foreach ($portProc in $remaining) {
  try { Stop-Process -Id $portProc -Force -EA SilentlyContinue } catch {}
  try { & taskkill /F /T /PID $portProc 2>$null | Out-Null } catch {}
}

exit 0
