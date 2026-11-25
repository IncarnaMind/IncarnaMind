; The app registers its own links' scheme for its user at start on Windows (ADR-0033): the
; uninstaller takes the registration out, so no link points at a program that is gone.
;
; Opening at login (#3758) is the Run value Electron writes, named after the app's
; AppUserModelID, "electron.app." and the product name, as the app sets none of its own; Task
; Manager keeps whether it is enabled under StartupApproved by the same name. An update runs the
; old uninstaller too, and must keep them: only an uninstall takes them out.
!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\incarnamind"
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.${PRODUCT_NAME}"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "electron.app.${PRODUCT_NAME}"
  ${endIf}
!macroend
