# Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).

## What is signed

- **Windows:** the app's executable (`IncarnaMind.exe`), and then the installer built from it (`IncarnaMind-<version>-win-x64.exe`), each in its own signing request. What each request may sign is listed in the [artifact configurations](../.signpath/artifact-configurations/).
- **How they're built:** by the [Release workflow](../.github/workflows/release.yml) on GitHub-hosted runners, from a version tag in this repository, and nothing else. SignPath checks with GitHub that each signing request comes from that workflow.
- **Not signed:** third-party files the app includes, such as Electron's and native modules' libraries, which ship as their authors published them; and the uninstaller, which electron-builder generates while it builds the installer.
- **macOS:** builds are signed and notarized separately, with the maintainer's Apple Developer ID, once it is issued.

## Team roles

| Role | Members |
| --- | --- |
| Committers and reviewers | [Joey Xiong](https://github.com/junruxiong) |
| Approvers | [Joey Xiong](https://github.com/junruxiong) |

- **Changes:** changes from contributors outside the team are reviewed by a committer before they're merged into `main`.
- **Releases:** every signing request is approved by an approver.
- **Build scripts:** the build workflow and its scripts are reviewed like any other code.
- **Accounts:** everyone in the team uses multi-factor authentication for GitHub and for SignPath.

## Privacy

IncarnaMind has no account and no server of its own. Your files, Notes and search index stay on your computer. Anything IncarnaMind sends to an outside service (the AI model you choose, a Connector, a source search) is sent only after you agree, and [Settings → Privacy](privacy.md) lists each one and lets you take it back. Usage data is sent only if you agree; a test build for invited testers says on its first run that it sends usage data, with the switch to turn it off. Crash reports are off unless you turn them on. Update checks and model downloads send none of your content, and automatic update checks can be turned off in Settings.

The full privacy statement is in [docs/privacy.md](privacy.md).
