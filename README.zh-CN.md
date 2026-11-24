<!-- README.md 与 README.zh-CN.md 逐节对应，修改时请两份一起改。 -->

<p align="center"><a href="README.md">English</a> · <b>简体中文</b></p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="build/icon/svg/mac-dark.svg">
    <img src="build/icon/svg/mac-light.svg" width="96" height="96" alt="">
  </picture>
</p>

<h1 align="center">IncarnaMind</h1>

<p align="center"><b>给任何 AI 用的文档层：它写，这里对着你的文件核对。</b></p>

<p align="center">免费开源的桌面应用，支持 macOS、Windows 和 Linux。<br>你的文件集中在一个知识库里，整理好、搜得到，会议也在其中。<br>你在用的 AI 在这里写，再把每一句话、每一个数字对照它出自的那一页核对。</p>

<p align="center">不用注册 IncarnaMind 账号。连接 Claude Code 或<a href="docs/agents.zh-CN.md">其他智能体</a>，或者在 IncarnaMind 里设置模型：ChatGPT 订阅、你自己的密钥，或通过 Ollama 用本地模型。</p>

<p align="center"><a href="https://github.com/IncarnaMind/IncarnaMind/releases"><img src="docs/images/download-zh.svg" width="131" height="40" alt="下载测试版"></a>&nbsp;&nbsp;<a href="https://tally.so/r/LZA5aG?ref=readme-zh"><img src="docs/images/notify-zh.svg" width="187" height="40" alt="alpha 上线时通知我"></a></p>

<p align="center">
  <a href="#下载">macOS、Windows、Linux</a> ·
  <a href="#核对是怎么做的">核对是怎么做的</a> ·
  <a href="#隐私">隐私</a> ·
  <a href="https://github.com/IncarnaMind/IncarnaMind/discussions">讨论区</a>
  <br><br>
  <img alt="桌面应用，支持 macOS、Windows 和 Linux" src="https://img.shields.io/badge/macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-desktop%20app-17191C">
  <a href="https://github.com/IncarnaMind/IncarnaMind/releases"><img alt="最新预发布版" src="https://img.shields.io/github/v/release/IncarnaMind/IncarnaMind?include_prereleases&label=pre-release&color=17191C"></a>
  <a href="LICENSE"><img alt="许可证：Apache-2.0" src="https://img.shields.io/github/license/IncarnaMind/IncarnaMind?color=17191C"></a>
  <a href="https://github.com/IncarnaMind/IncarnaMind/stargazers"><img alt="GitHub 星标" src="https://img.shields.io/github/stars/IncarnaMind/IncarnaMind?color=17191C"></a>
</p>

<p align="center"><img src="docs/images/demo-agent-zh-CN.gif" width="880" alt="请 Claude Code 写一份 Northwind Retail 的信贷备忘录，并配一张杠杆率对照契约上限的图表。它根据文件把备忘录写进 IncarnaMind，再逐句核对。笔记打开后有表格和图表，其中一句标为“部分有依据”。在这句的卡片上点“交给 Claude Code”，Claude Code 按文件原文改写，标记随之消失。接着录制一段通话，在这台电脑上转写。停止后点“用 Claude Code 整理会议笔记”，Claude Code 给出会议笔记，每一条都引用转写稿原话。"></p>

<p align="center"><sub>应用里的两次真实操作，用的是测试文档和一段合成人声的测试通话：Claude Code 使用 Claude Haiku 5.5 撰写、核对并修改这份备忘录，并整理会议笔记，IncarnaMind 里没有设置 AI 模型。通话在这台电脑上转写。等待的部分已剪掉，Claude Code 一栏按运行记录重绘。<a href="https://github.com/IncarnaMind/IncarnaMind/releases/download/v0.1.0-alpha.6/IncarnaMind-film-2026-11-21-zh-CN.mp4">下载 46 秒的高清影片</a>（MP4，4 MB）。<br>Alpha 阶段：免费测试版，暂未签名。公开 alpha 将在 2027 年初开放。</sub></p>

## 下载

| 系统 | [Releases 页面](https://github.com/IncarnaMind/IncarnaMind/releases)上的文件 |
|---|---|
| macOS，Apple 芯片（M1 及更新机型） | `.dmg` |
| Windows | `.exe` |
| Linux | Ubuntu 和 Debian 用 `.deb`，或 `.AppImage` |

不支持 Intel 处理器的 Mac。测试版更新频繁，暂未签名，第一次打开时系统会提示风险。Windows 版将通过 SignPath Foundation 签名（[代码签名政策](docs/code-signing-policy.md)）。

<details>
<summary>系统不让打开时</summary>

- **Windows** 提示“Windows 已保护你的电脑”：点**更多信息**，再点**仍要运行**。
- **macOS** 提示无法验证 IncarnaMind：先打开一次并点**完成**，再到**系统设置 → 隐私与安全性**里点**仍要打开**。也可以运行 `xattr -dr com.apple.quarantine /Applications/IncarnaMind.app`。完成公证之前，应用无法自动更新，有新版本时会提醒你。
- **Linux**：AppImage 需要先运行 `chmod +x IncarnaMind-*.AppImage`。Ubuntu 22.04 及以上还要运行 `sudo apt install libfuse2`（24.04 及以上是 `libfuse2t64`）。在 24.04 及以上，AppImage 不启用应用的沙盒。

</details>

<details>
<summary>从源代码运行</summary>

需要 Node.js 24 或更新版本：

```shell
git clone https://github.com/IncarnaMind/IncarnaMind.git && cd IncarnaMind
npm install && npm run dev
```

</details>

## 它能做什么

| | |
|---|---|
| **你的 AI 在这里写** | 把你的全部文档，或你选的文件夹，交给 [Claude Code](docs/claude-code.md#简体中文) 或[其他智能体](docs/agents.zh-CN.md)。它写的内容在这里以笔记打开。一篇笔记就是为一个主题准备的笔记本。它对你自己笔记的修改要等你确认。 |
| **核对** | 把笔记，或别人发来的 PDF、Word、PowerPoint、Excel 文件，对照你的文件逐句核对。只标出需要看一眼的句子，附上能下结论的那一页；点一下就把这句话交给你的 AI 去改。整张表的汇总在你的电脑上重新算一遍，并给出算的过程。 |
| **知识库** | 在原处读取你的文件：PDF、Word、PowerPoint、Excel 等。一次问遍所有文档，每一页都有引用。 |
| **整理** | 关联你的文件夹，“整理”推荐文件夹和标签，由你确认。 |
| **会议** | 在你的电脑上实时转写、通话中帮助，会后笔记引用谁说了什么。你的 AI 也能找到并引用会议。 |
| **写作和分析** | 没有智能体？用 IncarnaMind 自带的助手起草、给表格画图、向多份文档问同样的问题，每个输入都有引用。 |
| **Word** | 编辑 Word 文件后再导出为 Word：没改动的部分原样保留，你的修改可以作为修订写入。也能把笔记导出为带脚注的 Word，支持八种引用格式。 |

配合 [Ollama](https://ollama.com) 可完全离线使用，内容不离开你的电脑。

<details>
<summary><b>更多</b></summary>

- 在 OpenAlex、arXiv 和 PubMed 里搜索论文，保存网页，从 Zotero、BibTeX、RIS 或 CSL JSON 导入引用信息。
- 添加 MCP 服务器和 `SKILL.md` 技能。凡是可能改动内容的操作，都会先问你。
- 整个应用都有中文和英文。

</details>

## 核对是怎么做的

每一句话都对照你文件里能下结论的段落核对。站得住的句子不加任何标记；需要看一眼的会被标出，写明原因，点一下就打开原文那一页。

数字按数值比较。从原文四舍五入来的算通过，不一样的会被标出。整张表的合计、平均或计数，会在你的电脑上用代码重新算一遍，卡片上给出算的过程。

结论所依据的每一段引文，都由代码确认确实在那一页。“找到引文”只说明这段文字在那里，能不能证明你的句子，要你自己看。核对只拿写出来的内容和你的文件比，文件本身有错，它发现不了。[完整规则](docs/how-the-check-works.zh-CN.md)。

## 和同类产品比较

| | IncarnaMind | Gemini Notebook¹ | Open Notebook | AnythingLLM |
|---|:-:|:-:|:-:|:-:|
| 开源 | ✓ | ✗ | ✓ | ◐ |
| 桌面应用，不需要账号 | ✓ | ✗ | ◐ | ✓ |
| 在原处读取本地文件夹 | ✓ | ✗ | ✗ | ◐ |
| 核对你的 AI 智能体写的内容 | ✓ | ✗ | ✗ | ✗ |
| 用 ChatGPT 订阅或你的密钥 | ✓ | ✗ | ◐ | ◐ |
| 点开引用到原文那一页，引文高亮 | ✓ | ◐ | ✗ | ✗ |
| 核对你自己写的草稿 | ✓ | ✗ | ✗ | ✗ |
| 编辑 Word 文件，没改的部分原样保留 | ✓ | ✗ | ✗ | ✗ |
| 表格数据分析 | ✓ | ✓ | ✗ | ◐ |
| 会议 | ✓ | ✗ | ✗ | ✓ |

<sub>✓ 支持 · ◐ 部分支持或未说明 · ✗ 官方文档中没有。¹ 原名 NotebookLM。依据各产品 2026 年 10 月和 11 月的官方文档：[Gemini Notebook](https://support.google.com/gemininotebook/)、[Open Notebook](https://github.com/lfnovo/open-notebook)、[AnythingLLM](https://docs.anythingllm.com/)。</sub>

## 隐私

不需要账号。IncarnaMind 在原处读取你的文件，从不改动；一个问题只把它需要的内容发给你选的模型。

| 内容 | 去向 |
|---|---|
| 你的文件、笔记和搜索索引 | 你的电脑 |
| 提问、写作和核对 | 你选的模型，只发送必需的内容。用 Ollama 时哪儿也不去 |
| 你连接的智能体从 IncarnaMind 读取的内容 | 该智能体自己的 AI 模型，按该服务的条款处理。IncarnaMind 只向它提供你选的文件夹；开启**所有内容都留在这台电脑上**后暂停。智能体自己的其他工具仍由它自己控制 |
| 笔记对话里你自己的 AI | 可以按它自己的设置，用它自己的工具（命令、文件、网页）在这台电脑上操作。IncarnaMind 显示每一步，并把它要问你的转给你；它用这些工具做的事，IncarnaMind 看不到，也无法撤销 |
| 会议录音 | 在你的电脑上转写 |
| 查找论文、打标签、扫描页、云端转写 | 你同意后才会发送 |
| 使用数据和崩溃报告 | 你打开才会发送，绝不包括你的文件 |
| API 密钥 | 系统自带的安全存储 |

只要服务提供这个选项，IncarnaMind 都会要求它不保存你的请求，但无法强制它照做。每一项发送什么、怎么关闭，见 [docs/privacy.md](docs/privacy.md) 和**设置 → 隐私**。处理客户文件，请看[客户数据声明](docs/client-data-statement.zh-CN.md)。

<details>
<summary><b>常见问题</b></summary>

- **要花钱吗？** 不用，开源免费（Apache 2.0 许可证）。模型的费用由提供它的服务收取，或者由你已有的订阅承担。
- **和 NotebookLM（现名 Gemini Notebook）有什么不同？** 它在你的电脑上运行，文件在原处读取，不需要账号。能用你已经在用的 AI，既核对它写的内容，也核对你自己写的草稿；点开引用就到原文那一页，还能导出带脚注的 Word。其余见上面的比较表。
- **核对会漏掉什么吗？** 会：可能漏掉义务的变化，比如把“可以”写成“应当”。
- **能用哪些 AI？** 可以连接你已经在用的智能体，比如 [Claude Code](docs/claude-code.md#简体中文)，其他的见 [docs/agents.zh-CN.md](docs/agents.zh-CN.md)。也可以在 IncarnaMind 里设置模型：最省事的是填一个 DeepSeek 密钥（设置里有“如何获取？”），也可以用通义千问、硅基流动、Kimi、智谱 GLM、OpenAI、Anthropic、Google、OpenRouter、Mistral、xAI 的密钥，或任何兼容 OpenAI 接口的服务，还能直接登录 ChatGPT Plus 或 Pro。
- **能离线用吗？** 读取文件和搜索可以离线。回答和核对需要模型：云端模型，或通过 Ollama 运行的本地模型，后者更慢。
- **能用在客户文件上吗？** 你的文件留在你的电脑上，只有你选的模型和你允许的服务会收到内容。请先看[客户数据声明](docs/client-data-statement.zh-CN.md)。
- **会改动我的文件吗？** 不会。它只往自己的数据文件夹和你导出的文件里写内容。
- **怎么备份？** 复制数据文件夹就行，里面有你的笔记、搜索索引和设置。

</details>

## 参与贡献

欢迎贡献代码、用你自己的文档测试、翻译和提建议。请先看 [CONTRIBUTING.md](CONTRIBUTING.md)，或者[提一个 issue](https://github.com/IncarnaMind/IncarnaMind/issues/new/choose)，或在[讨论区](https://github.com/IncarnaMind/IncarnaMind/discussions)提问。

## 项目由来

IncarnaMind 始于 2023 年，最初是一个和 PDF 对话的 Python 工具，收获了约 800 个星标。2026 年，它围绕一个想法重写成桌面应用：基于你的文件给出的回答，只有能核对才有用。旧工具保留在 [`v1-python-cli`](https://github.com/IncarnaMind/IncarnaMind/tree/v1-python-cli) 标签下。如果 IncarnaMind 对你有帮助，点个星标能让更多人找到它。

<details>
<summary>引用 IncarnaMind</summary>

```bibtex
@misc{IncarnaMind2023, author = {Junru Xiong}, title = {IncarnaMind}, year = {2023},
  publisher = {GitHub}, journal = {GitHub Repository},
  howpublished = {\url{https://github.com/IncarnaMind/IncarnaMind}}}
```

</details>

## 许可证

[Apache License 2.0](LICENSE)。随应用附带的字体（Source Serif 4、JetBrains Mono、Carlito、Caladea）采用 [SIL Open Font License 1.1](https://openfontlicense.org)。引用格式和语言文件原样取自 [Citation Style Language](https://citationstyles.org/) 项目，采用 [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) 许可，由 [Hayagriva](https://github.com/typst/hayagriva)（MIT 或 Apache-2.0）排版。相关声明见 [`resources/notices`](resources/notices)。
