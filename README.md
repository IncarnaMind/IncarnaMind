<!-- README.md and README.zh-CN.md match section for section. Change them together. -->

<p align="center"><b>English</b> · <a href="README.zh-CN.md">简体中文</a></p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="build/icon/svg/mac-dark.svg">
    <img src="build/icon/svg/mac-light.svg" width="96" height="96" alt="">
  </picture>
</p>

<h1 align="center">IncarnaMind</h1>

<p align="center"><b>The artifact layer for any agent: what your AI writes, checked against your files.</b></p>

<p align="center">A free, open-source desktop app for macOS, Windows and Linux.<br>Your files in one Library, sorted and searchable, your meetings with them.<br>The AI you already use writes here. Then check every sentence and figure against the page it came from.</p>

<p align="center">No IncarnaMind account needed. Connect Claude Code or <a href="docs/agents.md">another agent</a>, or use a model in IncarnaMind: your ChatGPT plan, your own key, or a local model through Ollama.</p>

<p align="center"><a href="https://github.com/IncarnaMind/IncarnaMind/releases"><img src="docs/images/download-en.svg" width="216" height="40" alt="Download a test build"></a>&nbsp;&nbsp;<a href="https://tally.so/r/rjN2jL?ref=readme"><img src="docs/images/notify-en.svg" width="278" height="40" alt="Get notified when the alpha opens"></a></p>

<p align="center">
  <a href="#download">macOS, Windows and Linux</a> ·
  <a href="#how-the-check-works">How the check works</a> ·
  <a href="#privacy">Privacy</a> ·
  <a href="https://github.com/IncarnaMind/IncarnaMind/discussions">Discussions</a>
  <br><br>
  <img alt="Desktop app for macOS, Windows and Linux" src="https://img.shields.io/badge/macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-desktop%20app-17191C">
  <a href="https://github.com/IncarnaMind/IncarnaMind/releases"><img alt="Latest pre-release" src="https://img.shields.io/github/v/release/IncarnaMind/IncarnaMind?include_prereleases&label=pre-release&color=17191C"></a>
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/github/license/IncarnaMind/IncarnaMind?color=17191C"></a>
  <a href="https://github.com/IncarnaMind/IncarnaMind/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/IncarnaMind/IncarnaMind?color=17191C"></a>
</p>

<p align="center"><img src="docs/images/demo-agent-en.gif" width="880" alt="Claude Code is asked for a credit memo on Northwind Retail with a chart of its leverage against the covenant limit. It writes the memo into IncarnaMind from the files and checks it sentence by sentence. The note opens with its table and chart, and one sentence is marked Partly supported. Ask Claude Code on the mark's card hands the sentence back, Claude Code rewrites it from the files, and the mark is gone. Then a call is recorded and transcribed on the computer. After Stop, Prepare notes with Claude Code hands the meeting over, and Claude Code proposes the notes, each point quoting the transcript."></p>

<p align="center"><sub>Two real sessions in the app, from test documents and a test call in synthetic voices: Claude Code wrote, checked and fixed the memo and prepared the meeting notes on Claude Haiku 5.5, with no AI model set up in IncarnaMind. The call was transcribed on the computer. Waits are cut, and the Claude Code pane is drawn from the sessions' logs. <a href="https://github.com/IncarnaMind/IncarnaMind/releases/download/v0.1.0-alpha.6/IncarnaMind-film-2026-11-21-en.mp4">Download the 47-second film in HD</a> (MP4, 3 MB).<br>Alpha: free test builds, not yet signed. The public alpha opens in early 2027.</sub></p>

## Download

| System | File on the [Releases page](https://github.com/IncarnaMind/IncarnaMind/releases) |
|---|---|
| macOS on Apple silicon (M1 or later) | `.dmg` |
| Windows | `.exe` |
| Linux | `.deb` for Ubuntu and Debian, or `.AppImage` |

Macs with an Intel processor aren't supported. Test builds change often and aren't signed yet, so your system warns you the first time. Windows builds will be signed through the SignPath Foundation ([code signing policy](docs/code-signing-policy.md)).

<details>
<summary>If your system won't open it</summary>

- **Windows** says "Windows protected your PC": click **More info**, then **Run anyway**.
- **macOS** says it can't verify IncarnaMind: open it once and click **Done**, then **System Settings → Privacy & Security → Open Anyway**. Or run `xattr -dr com.apple.quarantine /Applications/IncarnaMind.app`. Until the app is notarized, it can't update itself, so it tells you when a new version is out.
- **Linux**: for the AppImage, run `chmod +x IncarnaMind-*.AppImage`. On Ubuntu 22.04 or later, also `sudo apt install libfuse2` (`libfuse2t64` on 24.04 and later). On 24.04 and later, the AppImage runs without the app's sandbox.

</details>

<details>
<summary>Run it from source</summary>

With Node.js 24 or newer:

```shell
git clone https://github.com/IncarnaMind/IncarnaMind.git && cd IncarnaMind
npm install && npm run dev
```

</details>

## What it does

| | |
|---|---|
| **Your AI writes here** | Connect [Claude Code](docs/claude-code.md) or [another agent](docs/agents.md) to all your Documents, or the Folders you choose. What it writes opens here as a Note. A Note is a notebook for one topic. The agent's changes to your own Notes wait for you. |
| **Check** | Check a Note, or a PDF, Word file, deck or workbook someone sent you, against your files, sentence by sentence. Only what needs a look is marked, with the page that decides it, and one click hands the sentence to your AI to fix. Figures over a whole sheet are worked out again on your computer, with the working shown. |
| **Library** | Your files, read where they are: PDF, Word, PowerPoint, Excel and more. Ask them all at once, every page cited. |
| **Sort** | Link your folders. Organize suggests Folders and Tags for you to accept. |
| **Meet** | A live transcript made on your computer, help during the call, and notes that cite who said what. Your AI can find and cite a meeting too. |
| **Write and analyse** | No agent? IncarnaMind's own assistant drafts, charts spreadsheets and asks many documents the same questions, every input cited. |
| **Word** | Edit a Word file and export it as Word again: the parts you didn't touch stay exactly as they were, and your edits can go in as tracked changes. Or export a Note to Word with footnotes in eight citation styles. |

Works fully offline with [Ollama](https://ollama.com): nothing leaves your computer.

<details>
<summary><b>More</b></summary>

- Search OpenAlex, arXiv and PubMed for papers, save web pages, and import references from Zotero, BibTeX, RIS or CSL JSON.
- Add MCP servers and `SKILL.md` Skills. Anything that could change something asks you first.
- The whole app is in English and Chinese.

</details>

## How the check works

Each sentence is checked against the passages in your files that decide it. A sentence that holds shows nothing. One that needs a look is marked, says why, and opens the page in one click.

Figures are compared as numbers. One rounded from the source passes, and a different one is marked. A total, average or count over a whole sheet is worked out again by code on your computer, and the card shows the working.

Code confirms that every quote a verdict rests on is on its page. "Quote found" means the words are there; whether they prove your sentence is for you to judge. And the check only compares the writing with your files, so a mistake in the files themselves gets through. [The full rules](docs/how-the-check-works.md).

## How it compares

| | IncarnaMind | Gemini Notebook¹ | Open Notebook | AnythingLLM |
|---|:-:|:-:|:-:|:-:|
| Open source | ✓ | ✗ | ✓ | ◐ |
| Desktop app, no account | ✓ | ✗ | ◐ | ✓ |
| Reads local folders in place | ✓ | ✗ | ✗ | ◐ |
| Checks what your AI agent writes | ✓ | ✗ | ✗ | ✗ |
| Your ChatGPT plan, or your key | ✓ | ✗ | ◐ | ◐ |
| Citation opens the page, quote highlighted | ✓ | ◐ | ✗ | ✗ |
| Checks your own draft | ✓ | ✗ | ✗ | ✗ |
| Edits a Word file, untouched parts kept | ✓ | ✗ | ✗ | ✗ |
| Spreadsheet analysis | ✓ | ✓ | ✗ | ◐ |
| Meetings | ✓ | ✗ | ✗ | ✓ |

<sub>✓ yes · ◐ partly, or not stated · ✗ not in their documentation. ¹ Formerly NotebookLM. From each product's documentation, October and November 2026: [Gemini Notebook](https://support.google.com/gemininotebook/), [Open Notebook](https://github.com/lfnovo/open-notebook), [AnythingLLM](https://docs.anythingllm.com/).</sub>

## Privacy

You don't need an account. IncarnaMind reads your files where they are and changes one only when you edit a deck in it by hand, keeping the file as it was first, and a question sends only what it needs to the model you picked.

| What | Where it goes |
|---|---|
| Your files, Notes and search index | Your computer |
| Questions, writing and checks | The model you picked, with only what each needs. With Ollama, nowhere |
| What an agent you connected reads from IncarnaMind | That agent's own AI model, under its service's terms. IncarnaMind gives it only the Folders you chose, and nothing while **Keep everything on this computer** is on. The agent's other tools stay under its own control |
| Meeting audio | Transcribed on your computer |
| Finding papers, tagging, scans, cloud transcription | Only after you say yes |
| Usage data and crash reports | Only if you turn them on, never with your files |
| API keys | Your system's secure storage |

Where a provider offers the choice, IncarnaMind asks it not to keep your requests. It can't make a provider comply. What each one sends, and how to turn it off, is in [docs/privacy.md](docs/privacy.md) and **Settings → Privacy**. For client work, read the [client data statement](docs/client-data-statement.md).

<details>
<summary><b>Questions</b></summary>

- **Is it free?** Yes, open source under Apache 2.0. The model is billed by its provider, or covered by a plan you already have.
- **How is it different from NotebookLM (now Gemini Notebook)?** It runs on your computer, reads your files where they are and needs no account. It works with the AI you already use, checks what that AI writes as well as your own drafts, opens each citation at its page and exports to Word with footnotes. The table above has the rest.
- **Can a check miss something?** Yes: a check can miss a change of obligation, such as “should” where the Document says “may”.
- **Which AI can I use?** Connect an agent you already use, such as [Claude Code](docs/claude-code.md); [docs/agents.md](docs/agents.md) lists the others. Or set up a model in IncarnaMind: sign in with ChatGPT Plus or Pro, or use your own key from OpenAI, Anthropic, Google, DeepSeek, Qwen, SiliconFlow, OpenRouter, Kimi, GLM, Mistral, xAI or any OpenAI-compatible server.
- **Does it work offline?** Reading files and search do. Answers and checks need a model: a cloud one, or a local one through Ollama, which is slower.
- **Can I use it on client documents?** Your files stay on your computer, and only the model you chose and the services you allow receive anything. Read the [client data statement](docs/client-data-statement.md) first.
- **Will it change my files?** No. It writes only to its own data folder and to the files you export.
- **How do I back up?** Copy the data folder. It holds your Notes, the search index and your settings.

</details>

## Contributing

Code, testing with your own documents, translations and ideas are all welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), [open an issue](https://github.com/IncarnaMind/IncarnaMind/issues/new/choose) or ask in [Discussions](https://github.com/IncarnaMind/IncarnaMind/discussions).

## History

IncarnaMind began in 2023 as a Python tool for chatting with your PDFs, starred by about 800 of you. In 2026 it was rebuilt as a desktop app around one idea: an answer from your files is only useful if you can check it. The old tool is at the [`v1-python-cli`](https://github.com/IncarnaMind/IncarnaMind/tree/v1-python-cli) tag. If IncarnaMind helps you, a star helps other people find it.

<details>
<summary>Citing IncarnaMind</summary>

```bibtex
@misc{IncarnaMind2023, author = {Junru Xiong}, title = {IncarnaMind}, year = {2023},
  publisher = {GitHub}, journal = {GitHub Repository},
  howpublished = {\url{https://github.com/IncarnaMind/IncarnaMind}}}
```

</details>

## Licence

[Apache License 2.0](LICENSE). The bundled fonts (Source Serif 4, JetBrains Mono, Carlito, Caladea, and Noto Sans SC for the Chinese in Analyses' plots) are under the [SIL Open Font License 1.1](https://openfontlicense.org). The citation styles and locales come unmodified from the [Citation Style Language](https://citationstyles.org/) project under [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/), formatted by [Hayagriva](https://github.com/typst/hayagriva) (MIT or Apache-2.0). Notices are in [`resources/notices`](resources/notices).
