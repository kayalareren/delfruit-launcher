!ifndef BUILD_UNINSTALLER
!include "nsDialogs.nsh"
Var ZipFolder
Var GameFolder
Var ZipField
Var GameField

!macro customPageAfterChangeDir
  Page custom StoragePage StoragePageLeave

Function StoragePage
  !insertmacro MUI_HEADER_TEXT "Depolama klasörleri" "ZIP dosyalarının ve oyunların konumunu seç."
  ${If} $ZipFolder == ""
    StrCpy $ZipFolder "$PROFILE\Downloads\DelFruit Launcher"
  ${EndIf}
  ${If} $GameFolder == ""
    StrCpy $GameFolder "$LOCALAPPDATA\DelFruit Launcher\Games"
  ${EndIf}
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 6u 100% 12u "ZIP indirme klasörü"
  Pop $0
  ${NSD_CreateDirRequest} 0 22u 75% 14u "$ZipFolder"
  Pop $ZipField
  ${NSD_CreateBrowseButton} 78% 22u 22% 14u "Gözat..."
  Pop $0
  ${NSD_OnClick} $0 BrowseZipFolder
  ${NSD_CreateLabel} 0 51u 100% 12u "Oyun kurulum klasörü"
  Pop $0
  ${NSD_CreateDirRequest} 0 67u 75% 14u "$GameFolder"
  Pop $GameField
  ${NSD_CreateBrowseButton} 78% 67u 22% 14u "Gözat..."
  Pop $0
  ${NSD_OnClick} $0 BrowseGameFolder
  nsDialogs::Show
FunctionEnd

Function BrowseZipFolder
  Pop $0
  ${NSD_GetText} $ZipField $1
  nsDialogs::SelectFolderDialog "ZIP indirme klasörünü seç" "$1"
  Pop $0
  ${If} $0 != error
    ${NSD_SetText} $ZipField "$0"
  ${EndIf}
FunctionEnd

Function BrowseGameFolder
  Pop $0
  ${NSD_GetText} $GameField $1
  nsDialogs::SelectFolderDialog "Oyun kurulum klasörünü seç" "$1"
  Pop $0
  ${If} $0 != error
    ${NSD_SetText} $GameField "$0"
  ${EndIf}
FunctionEnd

Function StoragePageLeave
  ${NSD_GetText} $ZipField $ZipFolder
  ${NSD_GetText} $GameField $GameFolder
  ${If} $ZipFolder == ""
  ${OrIf} $GameFolder == ""
    MessageBox MB_ICONEXCLAMATION "İki klasörü de seç."
    Abort
  ${EndIf}
FunctionEnd
!macroend

!macro customInstall
  ${If} $ZipFolder != ""
  ${AndIf} $GameFolder != ""
    FileOpen $0 "$INSTDIR\storage-defaults.txt" w
    ${IfNot} ${Errors}
      FileWriteUTF16LE /BOM $0 "$ZipFolder$\r$\n$GameFolder$\r$\n"
      FileClose $0
    ${EndIf}
  ${EndIf}
!macroend

!endif

!ifdef BUILD_UNINSTALLER
!include "nsDialogs.nsh"
Var DeleteProfileData
Var DeleteProfileDataBox

!macro customUnWelcomePage
  UninstPage custom un.DataOptions un.DataOptionsLeave

Function un.DataOptions
  !insertmacro MUI_HEADER_TEXT "DelFruit Launcher’ı kaldır" "Uygulama kaldırılırken kullanıcı verilerine ne yapılacağını seç."
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateCheckbox} 0 12u 100% 14u "Kullanıcı verilerini de sil"
  Pop $DeleteProfileDataBox
  ${If} $DeleteProfileData == ${BST_CHECKED}
    ${NSD_Check} $DeleteProfileDataBox
  ${EndIf}
  ${NSD_CreateLabel} 0 38u 95% 42u "Bu seçenek tüm yerel profilleri, ayarları, oturumları ve uygulama veri klasörünün içindeki oyunları siler. Ayrı konumlara kurulan oyunlar ve aldığın yedekler korunur."
  Pop $0
  nsDialogs::Show
FunctionEnd

Function un.DataOptionsLeave
  ${NSD_GetState} $DeleteProfileDataBox $DeleteProfileData
FunctionEnd
!macroend

!macro customUnInstall
  Delete "$INSTDIR\storage-defaults.txt"
  ${If} $DeleteProfileData == ${BST_CHECKED}
    SetShellVarContext current
    RMDir /r "$APPDATA\${APP_FILENAME}"
    RMDir /r "$APPDATA\${APP_PACKAGE_NAME}"
    ${If} $installMode == "all"
      SetShellVarContext all
    ${EndIf}
  ${EndIf}
!macroend
!endif
