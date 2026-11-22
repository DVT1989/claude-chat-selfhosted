; Claude Agent installer (built on Linux with makensis, see backend/Dockerfile).
; Installs a Windows service, registers in Apps & features, uninstalls cleanly.
; The pairing code is read from the file name (ClaudeAgentSetup-XXXX-XXXX.exe) when present.
Unicode true
!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"

!ifndef APP_URL
  !define APP_URL "https://"
!endif
!ifndef VERSION
  !define VERSION "1.0.0"
!endif
!define REGKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\ClaudeAgent"
!ifdef SIGN
  ; the uninstaller is written during the build: sign it too
  !uninstfinalize 'sign "%1"' = 0
!endif

Name "Claude Agent"
OutFile "ClaudeAgentSetup.exe"
InstallDir "$PROGRAMFILES64\ClaudeAgent"
RequestExecutionLevel admin
SetCompressor /SOLID lzma
BrandingText "Claude Chat"
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "Claude Agent"
VIAddVersionKey "FileDescription" "Claude Agent installer"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "CompanyName" "Claude Chat"
VIAddVersionKey "LegalCopyright" "Claude Chat"

Var Server
Var Code
Var hServer
Var hCode
Var Enrolled

!define MUI_ABORTWARNING
Page custom PairPage PairLeave
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_TEXT "Claude Agent draait nu als Windows-service. Het apparaat staat in Claude Chat onder Instellingen > Apparaten."
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Dutch"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "Claude Agent vraagt 64-bit Windows."
    Abort
  ${EndIf}
  SetRegView 64
  SetShellVarContext all
  StrCpy $Server "${APP_URL}"
  StrCpy $Code ""
  StrCpy $0 $EXEFILE 17
  ${If} $0 == "ClaudeAgentSetup-"
    StrCpy $Code $EXEFILE 9 17
  ${EndIf}
  StrCpy $Enrolled "0"
  ${If} ${FileExists} "$APPDATA\ClaudeAgent\config.json"
    StrCpy $Enrolled "1"
  ${EndIf}
FunctionEnd

Function PairPage
  ${If} $Enrolled == "1"
    Abort ; already paired: this is an update
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "Apparaat koppelen" "Koppelcode uit Claude Chat, Instellingen > Apparaten"
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 10u "Server"
  Pop $0
  ${NSD_CreateText} 0 12u 100% 12u "$Server"
  Pop $hServer
  ${NSD_CreateLabel} 0 34u 100% 10u "Koppelcode"
  Pop $0
  ${NSD_CreateText} 0 46u 100% 12u "$Code"
  Pop $hCode
  nsDialogs::Show
FunctionEnd

Function PairLeave
  ${NSD_GetText} $hServer $Server
  ${NSD_GetText} $hCode $Code
  ${If} $Code == ""
    MessageBox MB_ICONEXCLAMATION "Vul de koppelcode in."
    Abort
  ${EndIf}
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "/oname=$PLUGINSDIR\claude-agent.exe" "claude-agent.exe"
  nsExec::ExecToStack '"$PLUGINSDIR\claude-agent.exe" enroll --server "$Server" --code "$Code"'
  Pop $0
  Pop $1
  ${If} $0 != "0"
    MessageBox MB_ICONEXCLAMATION "Koppelen mislukt:$\r$\n$1"
    Abort
  ${EndIf}
  StrCpy $Enrolled "1"
FunctionEnd

Section "Install"
  SetRegView 64
  SetShellVarContext all
  ; update: stop the running service first so the file can be replaced
  nsExec::Exec 'sc.exe stop ClaudeAgent'
  Sleep 2000
  nsExec::Exec 'taskkill.exe /F /IM claude-agent.exe'
  SetOutPath "$INSTDIR"
  File "claude-agent.exe"
  WriteUninstaller "$INSTDIR\uninstall.exe"
!ifdef SIGN
  ; trust our self-signed publisher, so Windows shows "Claude Chat Agent" instead of an unknown publisher
  File "/oname=$INSTDIR\codesign.cer" "codesign.crt"
  nsExec::Exec 'certutil.exe -f -addstore Root "$INSTDIR\codesign.cer"'
  nsExec::Exec 'certutil.exe -f -addstore TrustedPublisher "$INSTDIR\codesign.cer"'
!endif

  ; key file readable only by SYSTEM and Administrators
  nsExec::Exec 'icacls.exe "$APPDATA\ClaudeAgent" /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F'

  nsExec::Exec 'sc.exe create ClaudeAgent binPath= "\"$INSTDIR\claude-agent.exe\" run" start= auto DisplayName= "Claude Agent"'
  nsExec::Exec 'sc.exe config ClaudeAgent binPath= "\"$INSTDIR\claude-agent.exe\" run" start= auto'
  nsExec::Exec 'sc.exe description ClaudeAgent "Beheer op afstand via Claude Chat"'
  nsExec::Exec 'sc.exe failure ClaudeAgent reset= 86400 actions= restart/5000/restart/5000/restart/30000'
  nsExec::Exec 'sc.exe start ClaudeAgent'

  WriteRegStr HKLM "${REGKEY}" "DisplayName" "Claude Agent"
  WriteRegStr HKLM "${REGKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${REGKEY}" "Publisher" "Claude Chat"
  WriteRegStr HKLM "${REGKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${REGKEY}" "DisplayIcon" "$INSTDIR\claude-agent.exe"
  WriteRegStr HKLM "${REGKEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKLM "${REGKEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegDWORD HKLM "${REGKEY}" "NoModify" 1
  WriteRegDWORD HKLM "${REGKEY}" "NoRepair" 1
  WriteRegDWORD HKLM "${REGKEY}" "EstimatedSize" 6500
SectionEnd

Section "Uninstall"
  SetRegView 64
  SetShellVarContext all
  nsExec::Exec 'sc.exe stop ClaudeAgent'
  Sleep 2000
  nsExec::Exec 'taskkill.exe /F /IM claude-agent.exe'
  ; tell the server, so the device disappears from the overview
  nsExec::Exec '"$INSTDIR\claude-agent.exe" unenroll'
  nsExec::Exec 'sc.exe delete ClaudeAgent'
  nsExec::Exec 'certutil.exe -delstore TrustedPublisher "Claude Chat Agent"'
  nsExec::Exec 'certutil.exe -delstore Root "Claude Chat Agent"'
  Delete "$INSTDIR\codesign.cer"
  Delete "$INSTDIR\claude-agent.exe"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  RMDir /r "$APPDATA\ClaudeAgent"
  DeleteRegKey HKLM "${REGKEY}"
SectionEnd
