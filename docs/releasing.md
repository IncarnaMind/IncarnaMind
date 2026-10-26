# Releasing

For maintainers: packaging, cutting a release, signing, crash reports and usage data.

[electron-builder](https://www.electron.build) packages the app (config: `electron-builder.yml`), and electron-updater updates installed apps from GitHub Releases (`src/main/updater.ts`). To package locally, into `dist/`:

```shell
npm run dist:dir     # the unpacked app, for a quick check (e.g. dist/mac-arm64/IncarnaMind.app)
npm run dist         # the installers for the current system; never published
```

## Cutting a release

1. Set the version, commit it and tag it: `npm version 1.2.3`. This updates `package.json` and `package-lock.json`, commits, and creates the tag `v1.2.3`.
2. Push the commit and the tag: `git push && git push origin v1.2.3`.
3. The tag starts the **Release** workflow (`.github/workflows/release.yml`). It checks that the tag matches `package.json`, creates a draft GitHub Release, builds, checks each package's contents and size (`npm run check:package`), and only then uploads:
   - for macOS, a dmg and a zip, each for Apple silicon and Intel;
   - for Windows, an NSIS installer, signed once SignPath is set up (see Windows signing);
   - for Linux, an AppImage and a .deb. The .deb is the one that runs with Chromium's sandbox on Ubuntu 24.04 and later. It can't update itself: like the unsigned macOS build, it tells the user a new version is out;
   - the `latest*.yml` files that auto-update reads.

   On macOS, before its upload, the packaged Apple silicon app also transcribes a meeting with its real speech engine (`npm run test:packaged`, #1239). If that check fails, the macOS files aren't uploaded, but the Windows and Linux legs still upload theirs. Never publish a draft without its macOS files: a failed transcription check most likely means transcription is broken on the other platforms too.
4. Review the draft, edit its notes (ending with the code signing policy line, see below), try the installers, and click **Publish release**. Installed apps only see an update once its release is published.

After the first release is published, follow the comment in `README.md` (and the one its Chinese counterpart mirrors): add the release badge.

## macOS signing and notarization

The workflow signs and notarizes the macOS app when these repository secrets exist. Without `CSC_LINK`, it builds an unsigned (ad-hoc signed) app and still succeeds.

| Secret | Value |
| --- | --- |
| `CSC_LINK` | The "Developer ID Application" certificate and its private key, exported from Keychain Access as a `.p12` file and base64-encoded (`base64 -i certificate.p12 \| pbcopy`) |
| `CSC_KEY_PASSWORD` | The password of that `.p12` file |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | To notarize with an Apple ID: the Apple ID, an [app-specific password](https://support.apple.com/102654) and the team ID |
| `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | Or, to notarize with an App Store Connect API key: the contents of the `.p8` file, its key ID and the issuer ID |

An unsigned macOS build can't update itself: IncarnaMind tells the user a new version is out and offers its download page.

## Windows signing (SignPath Foundation)

When the `SIGNPATH_API_TOKEN` secret exists, the Release workflow has [SignPath](https://about.signpath.io) sign the Windows app, and then the installer built from it:

1. electron-builder packages the app and an installer, as it does without signing. The workflow uploads the app, `dist/win-unpacked`, as a workflow artifact and sends it to SignPath, which signs `IncarnaMind.exe` (artifact configuration `windows-app`).
2. electron-builder builds the NSIS installer again, from the signed app (`--prepackaged`), and SignPath signs that installer (`windows-installer`). The first installer is built only because electron-builder writes the app's update settings (`resources/app-update.yml`) when it builds an installer, and not with `--dir`.
3. `scripts/signedInstaller.ts` puts the signed installer in `dist/` and redoes what electron-builder worked out from the unsigned one: the blockmap, and the sha512 and size in `latest.yml`. Auto-update refuses an installer whose hash doesn't match.
4. A step checks both files with `Get-AuthenticodeSignature`, and fails the job if either isn't signed and timestamped. The job's summary lists each file's signer.

The artifact configurations in `.signpath/artifact-configurations/` list exactly what SignPath signs, and SignPath refuses a file whose product name isn't IncarnaMind or whose product version isn't the tag's. Electron's and the native modules' libraries are third-party and ship as their authors published them. The uninstaller isn't signed either: electron-builder generates it while it builds the installer, after SignPath has signed the app.

SignPath signs only what this workflow built on GitHub's own runners, which it checks with GitHub. The workflow waits up to two hours for each signing request. With the `release-signing` policy an approver approves each request in SignPath, so a release asks twice: for the app, then a few minutes later for the installer. If a wait runs out, re-run the Windows job.

Without the `SIGNPATH_API_TOKEN` secret, the workflow builds an unsigned installer, as before, warns and still succeeds. With the secret but a variable missing, the job fails and names the variable.

### Setting it up

In SignPath, in the IncarnaMind project (SignPath Foundation's support does what the project's role doesn't allow):

1. Check that the trusted build system **GitHub.com** is linked to the project.
2. Add two artifact configurations with the slugs `windows-app` and `windows-installer`, pasting the files of the same names in `.signpath/artifact-configurations/`. When one of those files changes, paste it again before the next release.
3. Add a CI user, make it a submitter of the `test-signing` signing policy, and create an API token for it.

Then, in GitHub, under **Settings → Secrets and variables → Actions**:

| Name | Kind | Value |
| --- | --- | --- |
| `SIGNPATH_API_TOKEN` | Secret | The CI user's API token |
| `SIGNPATH_ORGANIZATION_ID` | Variable | The organization's ID, from its settings in SignPath |
| `SIGNPATH_PROJECT_SLUG` | Variable | The project's slug |
| `SIGNPATH_SIGNING_POLICY_SLUG` | Variable | `test-signing`, until the switch below |

Then push a pre-release tag and read the Windows job's summary.

### The test certificate

SignPath's test certificate is self-signed, so Windows doesn't trust it: SmartScreen still warns, as it does for an unsigned installer, and the signature check lets that one error pass with a warning. Auto-update still works. electron-builder signs nothing itself, so it writes no `publisherName` into the app's `app-update.yml`, and electron-updater installs an update without checking who signed it.

### Switching to the SignPath Foundation certificate

1. Make the CI user a submitter of the `release-signing` policy, and set `SIGNPATH_SIGNING_POLICY_SLUG` to `release-signing`.
2. Tag a pre-release. Its Windows job's summary should say **valid** for both files, and name the signer.
3. Set `win.signtoolOptions.publisherName` in `electron-builder.yml` to that signer's whole subject (`CN=…, O=…, …`). Apps installed from then on install only updates signed with that subject, so every later release has to be signed: an unsigned one would fail to install as an update. If the certificate's subject ever changes, list the old and the new one (`publisherName` takes a list) before releasing with the new one.
4. Change the Windows line in both READMEs: Windows releases are signed.

### The project's terms

The terms the project keeps are in the [code signing policy](code-signing-policy.md):

- The policy stays linked from both READMEs, under "Code signing policy".
- Every release's notes end with the line "Code signing policy: https://github.com/IncarnaMind/IncarnaMind/blob/main/docs/code-signing-policy.md".
- Before approving a signing request, an approver listed in the policy reviews the release's draft, which the workflow creates before it builds.
- The product name stays "IncarnaMind" and the version matches the tag; the artifact configurations enforce both.
- Everyone in the team uses multi-factor authentication for GitHub and SignPath.
- The signed installer contains only what this repository builds; nothing that isn't open source goes into it.

## Crash reports

Users can opt in to crash reports in **Settings → Privacy**; they go to Sentry, scrubbed of file paths, Document text, Mind content, Questions and Answers (`src/main/crashScrubber.ts`). Only a build made with a Sentry DSN offers them: set `MAIN_VITE_SENTRY_DSN` when building (electron-vite reads it from the environment or a `.env.local` file). The release workflow passes the `SENTRY_DSN` repository secret; without it, releases don't offer crash reports. Never commit a DSN.

## Usage data

Users can agree to send anonymous usage data, listed event by event in [privacy.md](privacy.md#usage-data); it goes to PostHog. Only a build made with a PostHog project sends it, or asks: set `MAIN_VITE_POSTHOG_KEY` (the project's API key, `phc_…`) and `MAIN_VITE_POSTHOG_HOST` (its host over https, PostHog's EU cloud or a self-hosted server) when building. The release workflow passes the `POSTHOG_KEY` and `POSTHOG_HOST` repository variables; without them, releases send no usage data. In the PostHog project, turn on **Discard client IP data**.

A release asks once, in a card in the sidebar after the first Answer to the User's own Question (not on the first run), and sends nothing, or keeps nothing to send, unless the User chooses Send. A test build, for invited testers, sends usage data until the User turns it off, and its first run says so, in a notice in the same place: build it with `MAIN_VITE_TESTER_BUILD=1`. The release workflow does that only for tags with `-tester` in them (`v0.9.0-tester.1`). An `-alpha` or `-beta` tag makes a release build, which asks first, so a public pre-release never sends usage data by default.
