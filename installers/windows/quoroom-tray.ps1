param([switch]$OpenWhenReady)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'SilentlyContinue'

$scriptDir        = Split-Path -Parent $MyInvocation.MyCommand.Path
$cmdPath          = Join-Path $scriptDir 'quoroom.cmd'
$iconPath         = Join-Path $scriptDir '..\ui\quoroom-server.ico'
$url              = 'http://localhost:3700'
$mutexName        = 'Local\QuoroomServerTrayV5'
$installRoot      = Split-Path -Parent $scriptDir
$installRootLower = $installRoot.ToLowerInvariant()
$logDir           = Join-Path $env:USERPROFILE '.quoroom'
$logPath          = Join-Path $logDir 'tray.log'

function Write-Log([string]$msg) {
  try {
    if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
    $ts = Get-Date -Format 'HH:mm:ss.fff'
    "[$ts] $msg" | Add-Content -Path $logPath -EA SilentlyContinue
  } catch {}
}

# TCP port probe - returns near-instantly (connect refused is immediate on localhost)
function Test-ServerPort {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $ar = $client.BeginConnect('127.0.0.1', 3700, $null, $null)
    $ok = $ar.AsyncWaitHandle.WaitOne(100)
    if ($ok) { try { $client.EndConnect($ar) } catch { $ok = $false } }
    return [bool]$ok
  } catch { return $false }
  finally { try { $client.Close() } catch {} }
}

# Single-instance mutex
$createdNew = $true
$mutex = $null
try { $mutex = New-Object System.Threading.Mutex($true, $mutexName, [ref]$createdNew) } catch {}

if (-not $createdNew) {
  # Another tray is already running.
  # If -OpenWhenReady, poll until server port is open then open browser.
  if ($OpenWhenReady) {
    for ($i = 0; $i -lt 90; $i++) {
      if (Test-ServerPort) {
        Start-Sleep -Milliseconds 1500
        Start-Process $url
        break
      }
      Start-Sleep -Milliseconds 1000
    }
  }
  exit 0
}

Write-Log "Tray started. OpenWhenReady=$([bool]$OpenWhenReady)"

# Process helpers

function Find-ServerProcs {
  @(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='cmd.exe'" -EA SilentlyContinue |
    Where-Object {
      $exe = if ($_.ExecutablePath) { $_.ExecutablePath.ToLowerInvariant() } else { '' }
      $cmd = if ($_.CommandLine)    { $_.CommandLine.ToLowerInvariant()    } else { '' }
      $exe.Contains($installRootLower + '\runtime\node.exe') -or
      ($cmd.Contains($installRootLower) -and ($cmd.Contains(' serve') -or $cmd.Contains('\lib\cli.js')))
    })
}

function Stop-PidTree([int]$pid) {
  if ($pid -le 4 -or $pid -eq $PID) { return }
  try {
    & taskkill /PID $pid /T /F 1>$null 2>$null
  } catch {
    try { Stop-Process -Id $pid -Force -EA SilentlyContinue } catch {}
  }
}

function Stop-Server {
  foreach ($p in Find-ServerProcs) {
    Stop-PidTree $p.ProcessId
  }
  # Also kill anything owning port 3700 (catches zombie/elevated processes)
  $portOwners = Get-NetTCPConnection -LocalPort 3700 -EA SilentlyContinue |
    Where-Object { $_.OwningProcess -gt 4 -and $_.OwningProcess -ne $PID } |
    Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($portProc in $portOwners) {
    Stop-PidTree $portProc
  }
}

# On startup: evict anything occupying port 3700 so our server can bind cleanly.
# Best-effort - works when tray runs elevated (from installer); harmless otherwise.
function Clear-Port3700 {
  $portOwners = Get-NetTCPConnection -LocalPort 3700 -State Listen -EA SilentlyContinue |
    Where-Object { $_.OwningProcess -gt 4 -and $_.OwningProcess -ne $PID } |
    Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($portProc in $portOwners) {
    Write-Log "Evicting port-3700 owner PID=$portProc"
    Stop-PidTree $portProc
  }
  if ($portOwners.Count -gt 0) { Start-Sleep -Milliseconds 600 }
}

# UI state

$script:state           = 'starting'
$script:pendingOpen     = [bool]$OpenWhenReady
$script:openAfter       = [DateTime]::MaxValue
$script:quitting        = $false
$script:lastStartAt     = [DateTime]::MinValue
$script:lastProcCheckAt = [DateTime]::MinValue
$script:procRunning     = $false
$script:startedAt       = [DateTime]::MinValue
$script:lastAlive       = $false

function Try-StartServer {
  $now = Get-Date
  if (($now - $script:lastStartAt).TotalSeconds -lt 8) { return }
  $script:lastStartAt = $now
  if (-not (Test-Path $cmdPath)) { Write-Log "ERROR: $cmdPath not found"; return }
  Write-Log "Launching: $cmdPath serve --port 3700"
  Start-Process -FilePath $cmdPath -ArgumentList 'serve', '--port', '3700' -WindowStyle Hidden
  if ($script:startedAt -eq [DateTime]::MinValue) { $script:startedAt = $now }
}

function Check-Process {
  $now = Get-Date
  if (($now - $script:lastProcCheckAt).TotalSeconds -lt 2) { return }
  $script:lastProcCheckAt = $now
  $was = $script:procRunning
  $script:procRunning = (Find-ServerProcs).Count -gt 0
  if ($was -and -not $script:procRunning) {
    Write-Log "Server process died - resetting cooldown"
    $script:lastStartAt = [DateTime]::MinValue
    $script:startedAt   = [DateTime]::MinValue
  }
}

# Tray icon

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon    = if (Test-Path $iconPath) { New-Object System.Drawing.Icon($iconPath) } else { [System.Drawing.SystemIcons]::Application }
$notify.Text    = 'Quoroom Server (starting)'
$notify.Visible = $true

$menu        = New-Object System.Windows.Forms.ContextMenuStrip
$statusItem  = $menu.Items.Add('Status: starting')
$statusItem.Enabled = $false
$menu.Items.Add('-') | Out-Null
$openItem    = $menu.Items.Add('Open Quoroom')
$restartItem = $menu.Items.Add('Restart Server')
$quitItem    = $menu.Items.Add('Quit Quoroom')
$notify.ContextMenuStrip = $menu

function Refresh-Ui {
  $label = switch ($script:state) {
    'online'     { 'running'    }
    'offline'    { 'offline'    }
    'restarting' { 'restarting' }
    default      { 'starting'   }
  }
  $notify.Text         = if ($script:state -eq 'online') { 'Quoroom Server' } else { "Quoroom Server ($label)" }
  $statusItem.Text     = "Status: $label"
  $openItem.Enabled    = -not $script:quitting
  $restartItem.Enabled = -not $script:quitting
}

$openItem.Add_Click({
  if (Test-ServerPort) { Start-Process $url; return }
  $script:pendingOpen = $true
  $script:openAfter   = [DateTime]::MaxValue
  $script:state       = 'starting'
  Check-Process
  if (-not $script:procRunning) { Try-StartServer }
  Refresh-Ui
})

$restartItem.Add_Click({
  if ($script:quitting) { return }
  Write-Log "Restart requested"
  $script:state       = 'restarting'
  $script:pendingOpen = $true
  $script:openAfter   = [DateTime]::MaxValue
  Refresh-Ui
  Stop-Server
  $script:procRunning = $false
  $script:lastStartAt = [DateTime]::MinValue
  $script:startedAt   = [DateTime]::MinValue
  Start-Sleep -Milliseconds 300
  Try-StartServer
  Refresh-Ui
})

$quitItem.Add_Click({
  $script:quitting = $true
  Refresh-Ui
  Stop-Server
  [System.Windows.Forms.Application]::Exit()
})

$notify.Add_DoubleClick({ $openItem.PerformClick() })

# Timer - TCP port check is near-instant (~1ms), safe on UI thread

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 500
$timer.Add_Tick({
  if ($script:quitting) { return }

  Check-Process
  $alive = Test-ServerPort
  $now   = Get-Date

  if ($alive) {
    if (-not $script:lastAlive) {
      Write-Log "Server port open"
    }
    $script:state       = 'online'
    $script:procRunning = $true
    $script:lastAlive   = $true

    if ($script:pendingOpen) {
      if ($script:openAfter -eq [DateTime]::MaxValue) {
        # Delay 10s after port opens to let HTTP server finish init
        $script:openAfter = $now.AddMilliseconds(10000)
      } elseif ($now -ge $script:openAfter) {
        Write-Log "Opening browser: $url"
        $script:pendingOpen = $false
        $script:openAfter   = [DateTime]::MaxValue
        Start-Process $url
      }
    }
  } else {
    if ($script:lastAlive) { Write-Log "Server port closed" }
    $script:lastAlive = $false

    if ($script:pendingOpen -or $script:state -eq 'restarting' -or $script:procRunning) {
      $script:state = 'starting'
    } else {
      $script:state = 'offline'
    }

    if ($script:pendingOpen -or $script:procRunning) {
      if (-not $script:procRunning) { Try-StartServer }
    } elseif ($script:startedAt -eq [DateTime]::MinValue) {
      # Auto-start on first launch
      Try-StartServer
    }
  }

  Refresh-Ui
})

$timer.Start()
Clear-Port3700
Try-StartServer
Refresh-Ui
[System.Windows.Forms.Application]::Run()

# Cleanup
$timer.Stop()
$timer.Dispose()
$notify.Visible = $false
$notify.Dispose()
try { $mutex.ReleaseMutex() } catch {}
$mutex.Dispose()
Write-Log "Tray exited"
