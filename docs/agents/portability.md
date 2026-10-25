# Keep the core portable

The core (`src/core`) will also run where Electron and Node don't, and the User's data will sync between devices. Each rule below costs little now and a lot once the app is out. A change that breaks one says so in its pull request.

1. **Node built-ins go through an adapter.** New uses of `node:fs`, `node:crypto`, `node:child_process`, `node:net`, `node:http`, `node:worker_threads` or `node:os` in `src/core` go through an adapter the host passes in, as `Database`, `Keychain`, `Browser`, `FileShell` and the ZIP reader's inflate do. Feature code doesn't import them directly.
2. **Storage stays plain SQLite.** The `Database` port stays as small as it is: exec, run, get, all and transaction. Don't use features only `node:sqlite` has (custom SQL functions, sessions, the backup API), and no loadable extensions; vectors stay in memory (ADR-0009). FTS5 with `contentless_delete` needs SQLite 3.43 or later.
3. **A Document is a source plus a relative path, never an absolute path,** and its versions are content hashes (ADR-0020).
4. **The extracted text is what travels.** Citations are checked against stored text, not files (ADR-0010). Each version's Units record which extractor made them, and its version, so text from two extractors is never silently mixed.
5. **Indexes belong to one device.** The keyword index depends on `Intl.Segmenter`, which differs between engines, so it never syncs. Segmentation stays behind the one function in `documents/keywords.ts`. Vectors may sync only with their model id.
6. **OAuth takes its redirect from the host.** The PKCE and state logic is separate from how the redirect comes back: a loopback server on a computer, a custom scheme or a universal link elsewhere.
7. **Model calls go only through the AI SDK's provider factories, with `fetch` passed in.** Provider code uses no Node-only HTTP.
8. **One helper each for hashing and for ids:** a streaming `contentHash` for files and one `newId()`, so another host can supply Web Crypto or a native implementation.
9. **Heavy jobs are messages, not threads.** A job and its result are plain, structured-clone-safe data, so a worker thread, a Web Worker or a native module can run them.
10. **The core API can be called from another device.** `CoreApi` arguments and results stay structured-clone-safe, as they already are across IPC.
11. **Secrets never sync, and tokens never move.** A key moves between devices only when the User chooses to send it, over a paired encrypted link. OAuth tokens are never copied: each device signs in itself (ADR-0003).
12. **Settings split per device where devices differ.** The default model belongs to the User, but whether its provider is set up belongs to the device, and the core falls back plainly when this device lacks the key. Consent stays per service and per device (ADR-0014, ADR-0022).
13. **A Tool says what it needs.** A Tool that needs a process (Skill scripts, STDIO Connectors) or the local agent socket says so in its Effects, so a host without processes hides it rather than failing (ADR-0013).
14. **New JavaScript features need a fallback.** New `Intl` APIs beyond Collator, NumberFormat and DateTimeFormat, new `TextDecoder` encodings, and WebAssembly either have a fallback or stay off the Answer path.
15. **Models are pinned files the host places.** Model downloads are pinned by revision, size and SHA-256 (as `embedding/model.ts` does), in a models folder the host chooses.
