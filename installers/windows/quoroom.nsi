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
!define MUI_WELCOMEPAGE_TEXT "This installer adds Quoroom to your PATH.$\r$\n$\r$\nAfter install, the local server starts automatically and your browser opens http://localhost:3700.$\r$\n$\r$\nYour browser controls Quoroom locally on this PC. Room data stays on your machine and is not sent to the internet by default."

; Pages
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "..\..\LICENSE"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE FinishPageLeave
!insertmacro MUI_PAGE_FINISH
!undef MUI_PAGE_CUSTOMFUNCTION_LEAVE

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

Section "Install"
  SetOutPath "$INSTDIR"

  ; Copy all files from staging
  File /r "${STAGING_DIR}\*.*"

  ; Create uninstaller
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; Start Menu
  CreateDirectory "$SMPROGRAMS\Quoroom"
  CreateShortcut "$SMPROGRAMS\Quoroom\Uninstall.lnk" "$INSTDIR\uninstall.exe"

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
  RMDir /r "$SMPROGRAMS\Quoroom"

  ; Remove registry
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Quoroom"
  DeleteRegKey HKLM "Software\Quoroom"
SectionEnd

; --- Launch server + browser ---

Function LaunchQuoroom
  ; Start local API/UI server via the packaged CLI wrapper.
  ExecShell "open" "$INSTDIR\bin\quoroom.cmd" "serve --port 3700"
  ; Give server a moment to bind before opening the browser.
  Sleep 1500
  ExecShell "open" "http://localhost:3700"
FunctionEnd

; Launch automatically when the user leaves the Finish page.
Function FinishPageLeave
  Call LaunchQuoroom
FunctionEnd

; --- Helper functions ---

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
