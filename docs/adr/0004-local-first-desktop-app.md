# Version 1 is a local-first desktop app

**Amended 2026-10-26 (#2004): keys are kept in `secrets.json` in the data folder, encrypted with Electron's `safeStorage`, whose key the OS holds (the macOS Keychain, Windows DPAPI, or GNOME Keyring or KWallet on Linux); on Linux with no keyring they are kept as plain text only once the User accepts that on the device (`src/core/secrets.ts`, `src/main/secretsFile.ts`, `docs/privacy.md`).**

Version 1 is a desktop app that keeps all of a User's data (Minds, Documents and settings) on their own machine, with no server and no sign-in. We chose this over a self-hosted web server for three reasons: installing is just download-and-open, personal data stays on the User's machine, and it removes auth, multi-user data separation and server operations entirely. The hosted version comes later (ADR-0002) and reuses the same TypeScript core, so the core must not depend on the desktop shell.

## Considered options

- **Local web app** (one command or a Docker container on your own machine): rejected as too technical for most people who want to ask questions about their PDFs.
- **Hosted web app with sign-in**: deferred to the hosted version.

## Consequences

- Model API keys are stored in the OS keychain.
- Passages are still sent to the chosen AI provider when a Question is answered, unless the User picks a local model, so "local" does not mean fully private.
- The desktop shell (Tauri or Electron) is decided separately.
