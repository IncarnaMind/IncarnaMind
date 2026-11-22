; The app registers its own links' scheme for its user at start on Windows (ADR-0033): the
; uninstaller takes the registration out, so no link points at a program that is gone.
!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\incarnamind"
!macroend
