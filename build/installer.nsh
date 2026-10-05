; Optional Open With registration. Never write extension defaults or UserChoice.
!define TRELLORA_TEXT_PROGID "${APP_ID}.Text"
!define TRELLORA_CAPABILITIES "Software\${APP_ID}\Capabilities"

!macro customInstall
  WriteRegStr SHELL_CONTEXT "Software\Classes\${TRELLORA_TEXT_PROGID}" "" "Trellora text document"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${TRELLORA_TEXT_PROGID}\DefaultIcon" "" '$\"$appExe$\",0'
  WriteRegStr SHELL_CONTEXT "Software\Classes\${TRELLORA_TEXT_PROGID}\shell\open\command" "" '$\"$appExe$\" $\"%1$\"'
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}" "FriendlyAppName" "${PRODUCT_NAME}"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\shell\open\command" "" '$\"$appExe$\" $\"%1$\"'
  WriteRegStr SHELL_CONTEXT "${TRELLORA_CAPABILITIES}" "ApplicationName" "${PRODUCT_NAME}"
  WriteRegStr SHELL_CONTEXT "${TRELLORA_CAPABILITIES}" "ApplicationDescription" "View and edit local Markdown and text files"
  !insertmacro TrelloraOptionalExtension "md"
  !insertmacro TrelloraOptionalExtension "markdown"
  !insertmacro TrelloraOptionalExtension "txt"
  WriteRegStr SHELL_CONTEXT "Software\RegisteredApplications" "${APP_ID}" "${TRELLORA_CAPABILITIES}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro TrelloraOptionalExtension EXT
  WriteRegStr SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" "${TRELLORA_TEXT_PROGID}" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".${EXT}" ""
  WriteRegStr SHELL_CONTEXT "${TRELLORA_CAPABILITIES}\FileAssociations" ".${EXT}" "${TRELLORA_TEXT_PROGID}"
!macroend

!macro customUnInstall
  ; A moved or newer installation owns its registration; do not delete its keys.
  ReadRegStr $R0 SHELL_CONTEXT "Software\Classes\${TRELLORA_TEXT_PROGID}\shell\open\command" ""
  ${If} $R0 == '$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" $\"%1$\"'
    DeleteRegValue SHELL_CONTEXT "Software\Classes\.md\OpenWithProgids" "${TRELLORA_TEXT_PROGID}"
    DeleteRegValue SHELL_CONTEXT "Software\Classes\.markdown\OpenWithProgids" "${TRELLORA_TEXT_PROGID}"
    DeleteRegValue SHELL_CONTEXT "Software\Classes\.txt\OpenWithProgids" "${TRELLORA_TEXT_PROGID}"
    DeleteRegKey /ifempty SHELL_CONTEXT "Software\Classes\.md\OpenWithProgids"
    DeleteRegKey /ifempty SHELL_CONTEXT "Software\Classes\.markdown\OpenWithProgids"
    DeleteRegKey /ifempty SHELL_CONTEXT "Software\Classes\.txt\OpenWithProgids"
    DeleteRegKey SHELL_CONTEXT "Software\Classes\${TRELLORA_TEXT_PROGID}"
    DeleteRegKey SHELL_CONTEXT "${TRELLORA_CAPABILITIES}"
    DeleteRegKey /ifempty SHELL_CONTEXT "Software\${APP_ID}"
    DeleteRegValue SHELL_CONTEXT "Software\RegisteredApplications" "${APP_ID}"
  ${EndIf}
  ReadRegStr $R0 SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\shell\open\command" ""
  ${If} $R0 == '$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" $\"%1$\"'
    DeleteRegKey SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"
  ${EndIf}
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
