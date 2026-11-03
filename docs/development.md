# Development

How to run, test and evaluate IncarnaMind from source. For how to contribute, see [CONTRIBUTING.md](../CONTRIBUTING.md); for packaging and releases, see [releasing.md](releasing.md).

## Run it

You need Node.js 24 or newer (`.nvmrc`). After cloning:

```shell
npm install
npm run dev          # start the app in development
npm run typecheck    # TypeScript, strict
npm run lint         # Biome (npm run format fixes what it can)
npm test             # Vitest: drives the core's public interface; no keys, no network
npm run test:smoke   # Playwright: builds the app and drives it in Electron
npm run eval         # the retrieval evaluation (see below)
```

npm 11.20 and newer run a dependency's install script only if `allowScripts` in `package.json` approves it ([`npm install-scripts`](https://docs.npmjs.com/cli/v11/commands/npm-install-scripts)); esbuild and onnxruntime-node are approved, and a new dependency with an install script needs an entry too. Electron has no install script: its binary downloads the first time the app or a smoke spec launches, so that first launch needs the network.

Keep development data apart from your real data folder by pointing the app at another one: `INCARNAMIND_DATA_DIR=/tmp/incarnamind-dev npm run dev`.

On Linux with no desktop, run the smoke test on a virtual display, as CI does: `xvfb-run -a --server-args="-screen 0 1920x1080x24" npm run test:smoke`.

## Installers

Installers for testers come from CI only: pushing a version tag builds them on a clean checkout (see [releasing.md](releasing.md)). Don't hand out a local `npm run dist` build. `npm run dist:dir` is for checking your own packaging changes; follow it with `npm run check:package`, which fails when `app.asar` holds anything but `out/`, `node_modules/` and `package.json`, or when a size is over its budget.

## App icon

The icon's drawings are the SVGs in `build/icon/svg/`. The rest of `build/icon/` is generated from them and committed, so packaging needs no extra tools. After changing a drawing, run

```
npm run icons
```

on macOS with Xcode 26 and Playwright's Chromium (`npx playwright install chromium`), and commit what changed. It writes `icon.icns`, `Assets.car` (compiled from the Icon Composer icon `AppIcon.icon`: macOS 26's Default and Dark), `icon.ico`, the Linux PNGs in `png/` and the development build's Dock icons. Run again with the same drawings, it gives the same files, except `Assets.car`, which actool stamps.

## Embeddings

Embeddings are off by default: document search is keyword search, reranked. Turned on in Settings, it runs a built-in embedding model, multilingual-e5-small (int8 ONNX, 135 MB), on your CPU in an Electron utility process. The app downloads it from Hugging Face into the data folder (`models/`) the first time a Document needs it, and checks each file's SHA-256; after that, indexing works offline. The tests use a deterministic fake instead. `INCARNAMIND_REAL_MODEL=1 npm test` also runs one test with the real model, downloading it unless `INCARNAMIND_MODEL_DIR` points at a folder holding its files. On Linux x64, set `ONNXRUNTIME_NODE_INSTALL=skip` when you run `npm install`, or onnxruntime-node also downloads its CUDA libraries, which the app doesn't use.

Embeddings can also come from OpenAI, Google, an OpenAI-compatible server or Ollama, and reranking can use Cohere or Voyage AI instead of the built-in model.

## Evaluation

`npm run eval` measures retrieval, and optionally Citation quality, against the project's targets. It adds the sample PDFs in `data/` (made for this repository; [`data/README.md`](../data/README.md)) and the Chinese articles in `eval/retrieval/fixtures/` to a temporary data folder and searches for each Question in `eval/retrieval/questions.json`. Retrieval needs no keys; the first run downloads the embedding and reranking models into `~/.cache/incarnamind-eval/`. It isn't part of `npm test` or CI's default run. See [`eval/README.md`](../eval/README.md) for the Citation part, the variables and the latest results.

## Model catalog

What the app knows about model providers lives in `src/core/providers/catalog/` (ADR-0005). The providers (`providers.ts`), the corrections (`overrides.ts`) and the local models (`local.ts`) are written by hand. `models.json`, each model's inputs, Tools, context, limits and price, is generated:

```
npm run catalog:update
```

It fetches models.dev and LiteLLM's model list (both MIT; their notice is `resources/notices/model-catalog.txt`), rewrites `models.json`, and prints what changed: new and removed models, changed prices, limits and abilities, and any provider default (a role in `providers.ts`) whose model changed or is gone. Where LiteLLM disagrees it only prints; correct a fact in `overrides.ts`. Running it twice gives no diff. `--models-dev <file>` and `--litellm <file>` read copies, and `--diff-file <file>` also writes the diff as Markdown.

A weekly workflow (`.github/workflows/catalog-update.yml`, also runnable by hand) does this and opens one pull request, from the branch `automation/catalog-update`, with the diff in its description; the next run updates that pull request instead of opening another, and closes it if the sources match again. A person reviews and merges it. If a default changed, run the evaluation for that model and cite it in the pull request before merging. Pull requests opened with the workflow's token don't start CI by themselves: push an empty commit to the branch, or close and reopen the pull request, to run the checks.

## Citation styles

Citations and the Bibliography are formatted by Hayagriva, the CSL engine of the Typst project, built to WebAssembly with a small binding of our own (ADR-0016). The built module is committed as `resources/citation-styles/engine.wasm`, beside the CSL styles and locales the app ships unmodified, so nothing here needs Rust. Only a change to the binding (`wasm/citation-styles`) does: then run

```
sh wasm/citation-styles/build.sh
```

with rustup on the `PATH` (it installs the pinned toolchain) to try the change. The committed `engine.wasm` is the build on x86_64 Linux: cargo mixes the build machine's platform into its crate hashes, so another machine builds a module that works the same but differs in bytes. CI's "Citation-style engine" workflow runs `build.sh --check` on Linux for every change to the binding or the file, and uploads what it built as the `citation-engine-built` artifact: commit that `engine.wasm`, with its SHA-256 in `engine.wasm.sha256`. A change to the engine's output shows in the golden files, `tests/fixtures/citation-styles/golden/`: review the diff, then update them with `npx vitest run tests/core/citationStyleGoldens.test.ts -u`. A new style goes in `resources/citation-styles/styles` exactly as the CSL repository has it, in `src/shared/citationStyles.ts`, and in `resources/notices/citation-styles.txt` with its authors and contributors.

## Architecture

[`CONTEXT.md`](../CONTEXT.md) is the glossary, and [`docs/adr/`](adr/) records the decisions behind the design, from the local-first Electron app (ADR-0004, ADR-0006) to SQLite storage (ADR-0008) and retrieval (ADR-0009).

In short: the React UI in the renderer talks over a typed bridge to the core, a TypeScript module in the Electron main process with no Electron imports. The core keeps each Note as a Yjs document and everything else in SQLite, in the data folder. Documents are indexed in place from Linked folders, never copied (ADR-0010). Answers come from a tool-calling loop (ADR-0007), through the AI SDK.

Code lives in `src/`: `core` (app logic), `main` (Electron main process), `preload` (the typed bridge to the UI), `renderer` (React UI) and `shared` (i18n dictionaries, bridge names and the text normaliser).
