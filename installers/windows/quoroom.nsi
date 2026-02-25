; Quoroom Windows Installer (NSIS)
; Build: makensis /DVERSION=x.x.x /DOUT_FILE=out.exe /DSTAGING_DIR=staging\quoroom quoroom.nsi

!include "MUI2.nsh"

Name "Quoroom"
OutFile "${OUT_FILE}"
InstallDir "$PROGRAMFILES\Quoroom"
InstallDirRegKey HKLM "Software\Quoroom" "InstallDir"
RequestExecutionLevel admin

; Version info
VIProductVersion "${VI_VERSION}"
VIAddVersionKey "ProductName" "Quoroom"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "FileDescription" "Quoroom - Autonomous AI agent collective engine"
VIAddVersionKey "LegalCopyright" "MIT License"

; Modern UI
!define MUI_ABORTWARNING

; Welcome copy
!define MUI_WELCOMEPAGE_TEXT "This installer adds Quoroom to your PATH.$\r$\n$\r$\nAfter install, the local server starts automatically and your browser opens http://localhost:3700.$\r$\n$\r$\nAny time later, reopen from Start Menu -> Quoroom Server -> Open Quoroom Server, or use the Quoroom Server desktop shortcut (no terminal window).$\r$\n$\r$\nYour browser controls Quoroom locally on this PC. Room data stays on your machine and is not sent to the internet by default."

; Pages
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "..\..\LICENSE"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE FinishPageLeave
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

Section "Install"
  SetRegView 64
  SetOutPath "$INSTDIR"

  ; Stop running Quoroom processes from previous installs to avoid locked files.
  Call StopRunningQuoroom
  Sleep 500

  ; Copy all files from staging
  File /r "${STAGING_DIR}\*.*"

  ; Create uninstaller
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; Cleanup old launcher names from previous versions
  RMDir /r "$SMPROGRAMS\Quoroom"
  Delete "$DESKTOP\Quoroom.lnk"

  ; Start Menu
  CreateDirectory "$SMPROGRAMS\Quoroom Server"
  Call CreateTrayScript
  Call CreateLauncherScript
  CreateShortcut "$SMPROGRAMS\Quoroom Server\Open Quoroom Server.lnk" "$SYSDIR\wscript.exe" '"$INSTDIR\bin\quoroom-launch.vbs"' "$INSTDIR\ui\quoroom-server.ico" 0
  CreateShortcut "$SMPROGRAMS\Quoroom Server\Uninstall.lnk" "$INSTDIR\uninstall.exe"
  CreateShortcut "$DESKTOP\Quoroom Server.lnk" "$SYSDIR\wscript.exe" '"$INSTDIR\bin\quoroom-launch.vbs"' "$INSTDIR\ui\quoroom-server.ico" 0

  ; Add bin\ to system PATH via registry
  ReadRegStr $0 HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path"
  ; Only add if not already present
  StrCpy $1 "$INSTDIR\bin"
  Push $0
  Push $1
  Call StrContains
  Pop $2
  StrCmp $2 "" 0 +2
    WriteRegExpandStr HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path" "$0;$1"

  ; Notify shell of environment change
  SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000

  ; Add/Remove Programs registry
  WriteRegStr HKLM "Software\Quoroom" "InstallDir" "$INSTDIR"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Quoroom" \
    "DisplayName" "Quoroom"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Quoroom" \
    "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Quoroom" \
    "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Quoroom" \
    "Publisher" "Quoroom"
SectionEnd

Section "Uninstall"
  SetRegView 64
  ; Remove bin\ from system PATH
  ReadRegStr $0 HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path"
  ; Remove ;$INSTDIR\bin or $INSTDIR\bin; from PATH
  StrCpy $1 "$INSTDIR\bin"
  Push $0
  Push ";$1"
  Call un.StrReplace
  Pop $0
  Push $0
  Push "$1;"
  Call un.StrReplace
  Pop $0
  Push $0
  Push "$1"
  Call un.StrReplace
  Pop $0
  WriteRegExpandStr HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path" "$0"
  SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000

  ; Remove files
  RMDir /r "$INSTDIR"

  ; Remove Start Menu
  RMDir /r "$SMPROGRAMS\Quoroom Server"
  RMDir /r "$SMPROGRAMS\Quoroom"
  Delete "$DESKTOP\Quoroom Server.lnk"
  Delete "$DESKTOP\Quoroom.lnk"

  ; Remove registry
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Quoroom"
  DeleteRegKey HKLM "Software\Quoroom"
SectionEnd

; --- Launch server + browser ---

Function LaunchQuoroom
  ; Run launcher via Windows Script Host so quoroom.cmd stays hidden.
  Exec '"$SYSDIR\wscript.exe" "$INSTDIR\bin\quoroom-launch.vbs"'
FunctionEnd

Function .onInit
  SetRegView 64
  StrCmp $PROGRAMFILES64 "" +2 0
    StrCpy $INSTDIR "$PROGRAMFILES64\Quoroom"

  Push $INSTDIR
  Push "\AppData\Local\Temp\"
  Call StrContains
  Pop $0
  StrCmp $0 "" +2 0
    StrCpy $INSTDIR "$PROGRAMFILES\Quoroom"

  Push $INSTDIR
  Push "\Temp\quoroom-"
  Call StrContains
  Pop $0
  StrCmp $0 "" +2 0
    StrCpy $INSTDIR "$PROGRAMFILES\Quoroom"
FunctionEnd

Function un.onInit
  SetRegView 64
FunctionEnd

; Launch automatically when the user leaves the Finish page.
Function FinishPageLeave
  Call LaunchQuoroom
FunctionEnd

; --- Helper functions ---

Function CreateLauncherScript
  FileOpen $0 "$INSTDIR\bin\quoroom-launch.vbs" w
  FileWrite $0 "Set shell = CreateObject($\"WScript.Shell$\")$\r$\n"
  FileWrite $0 "Set fso = CreateObject($\"Scripting.FileSystemObject$\")$\r$\n"
  FileWrite $0 "scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)$\r$\n"
  FileWrite $0 "cmdPath = scriptDir & $\"\\quoroom.cmd$\"$\r$\n"
  FileWrite $0 "url = $\"http://localhost:3700$\"$\r$\n"
  FileWrite $0 "$\r$\n"
  FileWrite $0 "Function IsQuoroomHealthy(baseUrl)$\r$\n"
  FileWrite $0 "  On Error Resume Next$\r$\n"
  FileWrite $0 "  Set http = CreateObject($\"WinHttp.WinHttpRequest.5.1$\")$\r$\n"
  FileWrite $0 "  http.SetTimeouts 500, 500, 500, 500$\r$\n"
  FileWrite $0 "  http.Open $\"GET$\", baseUrl & $\"/api/auth/handshake$\", False$\r$\n"
  FileWrite $0 "  http.Send$\r$\n"
  FileWrite $0 "  If Err.Number <> 0 Then$\r$\n"
  FileWrite $0 "    Err.Clear$\r$\n"
  FileWrite $0 "    IsQuoroomHealthy = False$\r$\n"
  FileWrite $0 "    Exit Function$\r$\n"
  FileWrite $0 "  End If$\r$\n"
  FileWrite $0 "  IsQuoroomHealthy = (http.Status = 200)$\r$\n"
  FileWrite $0 "End Function$\r$\n"
  FileWrite $0 "$\r$\n"
  FileWrite $0 "If IsQuoroomHealthy(url) Then$\r$\n"
  FileWrite $0 "  shell.Run url, 1, False$\r$\n"
  FileWrite $0 "  WScript.Quit 0$\r$\n"
  FileWrite $0 "End If$\r$\n"
  FileWrite $0 "$\r$\n"
  FileWrite $0 "command = Chr(34) & cmdPath & Chr(34) & $\" serve --port 3700$\"$\r$\n"
  FileWrite $0 "shell.Run command, 0, False$\r$\n"
  FileWrite $0 "For i = 1 To 10$\r$\n"
  FileWrite $0 "  If IsQuoroomHealthy(url) Then Exit For$\r$\n"
  FileWrite $0 "  WScript.Sleep 1000$\r$\n"
  FileWrite $0 "Next$\r$\n"
  FileWrite $0 "WScript.Sleep 10000$\r$\n"
  FileWrite $0 "shell.Run url, 1, False$\r$\n"
  FileClose $0
FunctionEnd

Function CreateTrayScript
  File "/oname=$INSTDIR\bin\quoroom-tray.ps1" "..\..\installers\windows\quoroom-tray.ps1"
FunctionEnd

Function StopRunningQuoroom
  InitPluginsDir
  File "/oname=$PLUGINSDIR\quoroom-stop.ps1" "..\..\installers\windows\stop-quoroom.ps1"
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\quoroom-stop.ps1" -InstallDir "$INSTDIR"'
  Pop $0
  Delete "$PLUGINSDIR\quoroom-stop.ps1"
FunctionEnd

; StrContains - check if $1 is in $0 (push haystack, needle)
Function StrContains
  Exch $R1 ; needle
  Exch
  Exch $R0 ; haystack
  Push $R2
  Push $R3
  Push $R4
  StrLen $R3 $R1
  StrCpy $R4 0
  loop:
    StrCpy $R2 $R0 $R3 $R4
    StrCmp $R2 "" notfound
    StrCmp $R2 $R1 found
    IntOp $R4 $R4 + 1
    Goto loop
  found:
    StrCpy $R0 $R1
    Goto done
  notfound:
    StrCpy $R0 ""
  done:
    Pop $R4
    Pop $R3
    Pop $R2
    Exch $R0
FunctionEnd

; StrReplace - replace all occurrences (push string, old, returns new on stack)
Function un.StrReplace
  Exch $R1 ; old
  Exch
  Exch $R0 ; string
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  StrLen $R3 $R1
  StrCpy $R5 ""
  StrCpy $R4 0
  loop:
    StrCpy $R2 $R0 $R3 $R4
    StrCmp $R2 "" done
    StrCmp $R2 $R1 replace
    StrCpy $R2 $R0 1 $R4
    StrCpy $R5 "$R5$R2"
    IntOp $R4 $R4 + 1
    Goto loop
  replace:
    IntOp $R4 $R4 + $R3
    Goto loop
  done:
    StrCpy $R0 $R5
    Pop $R5
    Pop $R4
    Pop $R3
    Pop $R2
    Exch $R0
FunctionEnd
