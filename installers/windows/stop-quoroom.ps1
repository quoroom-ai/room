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

exit 0
