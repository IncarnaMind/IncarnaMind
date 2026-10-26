<!-- README.md 与 README.zh-CN.md 逐节对应，修改时请两份一起改。 -->

<p align="center"><a href="README.md">English</a> · <b>简体中文</b></p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="build/icon/svg/mac-dark.svg">
    <img src="build/icon/svg/mac-light.svg" width="96" height="96" alt="">
  </picture>
</p>

<h1 align="center">IncarnaMind</h1>

<p align="center">
  <b>别信 AI，点开出处看。</b><br>
  每个回答都标出它来自哪一页，点一下，原文那一页就打开，引文高亮显示。<br>
  适合靠文件写报告、要对每个数字负责的分析师、律师和工程师。免费开源，在你自己的电脑上运行。<br>
  <sub>Alpha 阶段。早期测试版暂未签名，公开 alpha 将在 2027 年初开放。</sub>
</p>

<p align="center"><a href="https://tally.so/r/LZA5aG?ref=readme-zh"><img src="docs/images/notify-zh.svg" width="187" height="40" alt="alpha 上线时通知我"></a></p>

<p align="center">
  <a href="#下载"><b>下载</b></a> ·
  <a href="#你能用它做什么">你能用它做什么</a> ·
  <a href="#你的文件始终归你">隐私</a> ·
  <a href="https://github.com/IncarnaMind/IncarnaMind/discussions">讨论区</a>
  <br><br>
  <img alt="桌面应用，支持 macOS、Windows 和 Linux" src="https://img.shields.io/badge/macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-desktop%20app-17191C">
  <a href="LICENSE"><img alt="许可证：Apache-2.0" src="https://img.shields.io/github/license/IncarnaMind/IncarnaMind?color=17191C"></a>
  <!-- 第一个版本发布后，加上：<a href="https://github.com/IncarnaMind/IncarnaMind/releases/latest"><img alt="最新版本" src="https://img.shields.io/github/v/release/IncarnaMind/IncarnaMind?color=17191C"></a> -->
</p>

<p align="center"><img src="docs/images/demo-tour-2026-10-25-zh-CN.gif" width="880" alt="一位信贷分析师的周一，模型为 Claude Sonnet 5.5。动画依次展示五个场景：草稿中的一句话在页边被标上红色 ≠，“与文档矛盾”的卡片引用 Q3 业绩（报告里写 36.8%，业绩里是 38.6%）；就杠杆率条款提问，回答带编号引用，点开一条引用，贷款协议在对应页面打开，引文高亮；一句经核对算出的话，卡片给出算式和每个输入来自哪一页；“核对此 Mind”再次标出错误的数字，改正后标记变成绿色；最后是结束页。57 秒的视频还展示：资料库读取一个装着贷款方新文件的文件夹，“整理”为它们建议文件夹和标签；“对比文档”填好三份条款清单的对比表，每个单元格都有引用；回答作为灰色文字加进报告并带撤销提示，再用同一批数字做出柱状图；一通通话（用合成语音录制的测试录音），有实时转写、通话帮助的回答和引用通话内容的笔记；以及把报告导出为 Word，脚注可见。"></p>

<p align="center"><sub>图中展示的功能现在都能用。<a href="docs/images/demo-tour-2026-10-25-zh-CN.mp4">观看 57 秒高清完整版</a></sub></p>

**IncarnaMind** 是一款免费开源的桌面应用，支持 macOS、Windows 和 Linux：你可以借助 AI 写作，并就自己的文档（PDF、Word、PowerPoint、Excel 等）提问。它能把草稿里的每一句话、每一个数字都对照这些文档核对，不管草稿是谁写的；每个回答都标明出处的确切页码。它用你已经在用的 AI：你自己的 API 密钥（比如 DeepSeek），或你的 ChatGPT、Claude、Copilot 订阅。

**两分钟上手。** 第一次打开会显示一个已核对的示例，里面有一个数字是错的。点页边红色的 ≠，再向那两份文档提个问题。

## 下载

**公开 alpha 将在 2027 年初开放。** 在那之前，[发布页](https://github.com/IncarnaMind/IncarnaMind/releases)上有 macOS（Apple 芯片和 Intel）、Windows 和 Linux 的早期测试版，以预发布版本的形式提供：更新频繁，暂未签名，第一次打开时系统会给出警告（见下）。想在 alpha 开放时收到通知，可以[留下邮箱](https://tally.so/r/LZA5aG?ref=readme-zh)，或点本页右上角的 **Watch → Custom → Releases**。也可以用 Node.js 24 或更高版本从源码运行：

```shell
git clone https://github.com/IncarnaMind/IncarnaMind.git && cd IncarnaMind
npm install && npm run dev
```

Windows 版将通过 SignPath Foundation 为开源项目提供的免费签名服务签名，在此之前安装程序暂未签名。见[代码签名政策（Code signing policy）](docs/code-signing-policy.md)。

<details>
<summary>系统不让打开时</summary>

- **Windows** 提示“Windows 已保护你的电脑”：安装程序暂时还没有代码签名。点**更多信息**，再点**仍要运行**。
- **macOS** 提示无法验证 IncarnaMind：在完成公证之前，先打开一次，在警告里点**完成**，再到**系统设置 → 隐私与安全性**里点**仍要打开**。也可以运行 `xattr -dr com.apple.quarantine /Applications/IncarnaMind.app`。未签名的 Mac 版不能自动更新：有新版本时，IncarnaMind 会通知你，并打开下载页面。
- **Linux**：Ubuntu 和 Debian 请用 .deb（推荐），其他发行版可用 AppImage。在 Ubuntu 24.04 及更新版本上，AppImage 会在没有应用沙盒的情况下运行。使用 AppImage 时，先运行 `chmod +x IncarnaMind-*.AppImage`。Ubuntu 22.04 及以后的版本还要运行 `sudo apt install libfuse2`（24.04 及以后是 `libfuse2t64`）。

</details>

## 你能用它做什么

**每个回答都能核对。** 回答会标出每个说法的出处，并附上原文引文，再逐条到那个位置核对：找到了打绿勾，没找到就标成橙色；点一下，原文就打开到那一页，引文高亮显示。展开回答的过程，可以看到它搜了什么、用了哪些来源。

**边写边问。** 一篇笔记就是为一个主题准备的笔记本，旁边就是助手：就当前的笔记或你的文件向它提问，回答以对话的形式留在助手里，每个引用都已核对。你的草稿保持原样，直到你点 **添加到笔记**：回答连同引用放到光标处，可以像普通文字一样修改。

**AI 帮你写，改不改由你定。** 告诉助手要改什么（“把摘要缩短”“把今天的决定加到项目计划里”“把这些论文整理成一篇新笔记”），它就直接修改 Mind，或新建一个 Mind，边写边一段段出现，改动直接生效：在你修改之前以灰色显示，一键撤销，也可以点“查看改动”看改了什么；提问仍然得到回答。也可以选中文字，选“用 AI 编辑…”，每处修订都会说明为什么这样改。开启写作建议后，你停下来时会出现灰色的续写，只在你的文档支持时出现，并且总带着引用；按 Tab 采纳。

**交稿前先核对一遍。** 在 Mind 里选中几句话，选择 **对照文档核对**：每句话都会标出在你的文档里有依据、无依据还是与文档矛盾，原文一键打开，页面角落的核对标记会统计还有几处需要留意。别人写的 PDF 也能这样逐条核对说法：**+ → 核对文档…**。

**用表格对比文档。** **对比文档…** 会向你选的每个文件提出同样的问题，填成一张表，每一格都是带引用、经过核对的回答。

**写完就能交。** 把 Mind 导出为 Word 或 Markdown，引用和参考文献按你选的引用格式排好：APA、MLA、Chicago、Harvard、IEEE、Vancouver、GB/T 7714，或 IncarnaMind 自己的编号格式。没通过核对的引用会标上“[未核实]”。也可以把 Word 文件打开成 Mind，再导出回同一个文件：没改动的部分原样保留，你的修改可以作为修订写回去。

**会议中记笔记。** 开始录音后，实时转写显示在 Mind 旁边，转写在你的电脑上完成。会议结束后，可以把转写稿保存为文档，笔记就能引用会上说过的话。通话中，一个小面板可以建议你接下来怎么说，并根据你的文档回答对方的问题。

<details>
<summary><b>更多</b></summary>

**直接用你手上的文件。** 把你平时用的文件夹添加为同步文件夹，连 Zotero 的存储文件夹也可以：IncarnaMind 就地读取里面的 PDF、Word（连批注一起）、PowerPoint、Excel、CSV、Markdown 和纯文本文件，从不移动或修改它们，文件有变化也会跟着更新。

**模型由你来选。** 可以用你自己的 OpenAI、Anthropic、Google、DeepSeek、通义千问、硅基流动、OpenRouter 密钥，还有更多可选，例如 Kimi、智谱 GLM、Mistral、xAI，或任何兼容 OpenAI 接口的服务。已经订阅了 ChatGPT Plus 或 Pro、Claude 或 GitHub Copilot，也可以直接登录，用订阅提问，无需密钥（Copilot 登录目前是实验性的）。

**从首页开始。** 从第二次打开起，IncarnaMind 会先显示首页：最近的 Mind 和各自的第一行，以卡片显示的文件夹和其中最近的变化，还有需要你处理的事，比如正在读取的文档。点 **新建 Mind** 一键开始写，旁边的 ▾ 里是其他新建方式。第一次打开时显示的是一个已核对的示例。

**文档再多也不乱。** “整理”会给每个文档推荐文件夹和标签，由你确认，你自己做的选择都会保留。用本机模型时它会自动运行；用云端模型时，要等你在**设置 → 模型**里打开“自动为新文档打标签并整理”才会运行，开关旁会写明它会发送什么。

**查找和添加资料。** 在 OpenAlex、arXiv 和 PubMed 里搜索论文，开放获取的直接添加为文档；输入网址保存网页，像文件一样引用和核对；还能从 Zotero 或任何 CSL JSON、BibTeX、RIS 文件导入引用信息。

**连接应用和技能，运行前先问你。** 添加连接器（MCP 服务器），或者直接导入你在 Claude Desktop、Cursor 里配置好的；也可以添加技能（标准的 `SKILL.md` 文件夹），内置三个。可能改动内容的工具和技能里的脚本，都要你同意后才会运行。

**中英双语。** 整个界面都有中文和英文。

</details>

## 你的文件始终归你

不需要注册账号。你的 Mind 和搜索索引都存在你电脑上的一个数据文件夹里，你的文件原样留在原处。一个问题会连同它需要的内容发给你选的 AI 模型：你所在的 Mind、为它找到的段落，以及它可能搜索的文档名；用本机模型时哪儿也不去。其他可能离开你电脑的内容，比如查找论文、自动打标签和整理、扫描页的图片、会议的云端转写，都和它们发送的内容一起列在 [docs/privacy.md](docs/privacy.md#what-goes-to-a-service-you-chose) 和**设置 → 隐私**里，每一项都可以单独停止。API 密钥用系统自带的安全存储加密保存。使用数据只有在你同意后才收集，是[匿名事件](docs/privacy.md#usage-data)，绝不包括你的文件或问题，随时可以在**设置 → 隐私**中关闭。崩溃报告默认关闭，开启后也会先去掉你的内容。

- **发送之前先问你。** IncarnaMind 第一次要把内容发给外部服务之前，会先告诉你要发什么、发给谁，等你同意后才发送。**设置 → 隐私**里列出了每一项，随时可以撤回。
- **要求服务不保存。** 只要它提供这个选项，IncarnaMind 都会要求它不要保存你的请求；发给 OpenAI 和 xAI 的每个请求都带着这个要求，发给 OpenRouter 的请求则要求它只使用不保存、不训练的服务。这只是请求：IncarnaMind 无法强制服务照做。
- **运行什么，由你说了算。** 连接器里可能改动内容的工具，以及技能里的脚本，在运行之前 IncarnaMind 都会先问你：允许这一次、始终允许，或者拒绝。**设置 → 隐私**里列出了你设过的每条规则，随时可以撤销。
- **用于客户的文件？** 请看[客户数据声明](docs/client-data-statement.zh-CN.md)：该怎么向客户说明他们的文档，附可直接贴进委托函的段落。

<details>
<summary><b>常见问题</b></summary>

- **“找到引文”是什么意思？** 意思是这段文字确实在引用所指的位置，但不代表它能证明你写的那句话，所以原文永远只差一次点击。“无法核对”表示那里没有可以比对的文字，比如扫描页。
- **能用在客户的或保密的文件上吗？** 你的文件留在你的电脑上，只有你选的 AI 模型和你允许的少数服务会收到内容。处理客户事务之前，请看[客户数据声明](docs/client-data-statement.zh-CN.md)，并查看**设置 → 隐私**，那里列出了当前开着的每一项服务。
- **要花钱吗？** 不用。IncarnaMind 开源免费（Apache 2.0 许可证）。AI 模型的费用由提供它的服务收取：用你已有的 ChatGPT、Claude、Copilot 订阅，或用自己的 API 密钥按用量付费。
- **一定要有 API 密钥吗？** 需要一个 AI 模型，最省事的是填一个 DeepSeek 密钥（设置里有“如何获取？”）。也可以填通义千问、硅基流动、OpenAI、Anthropic、Google、OpenRouter 的密钥；“设置”中还有更多服务，例如 Kimi、智谱 GLM、Mistral、xAI，或任何兼容 OpenAI 接口的服务。订阅了 ChatGPT Plus 或 Pro，可以使用 ChatGPT 登录。
- **是 NotebookLM（现名 Gemini Notebook）的替代品吗？** 是。IncarnaMind 在你的电脑上运行，文件在原处读取，不需要账号；模型由你来选（你自己的密钥，或 ChatGPT、Claude、Copilot 订阅）；每条引用都和原文所在页逐一核对，你自己写的句子也能核对；Mind 还能导出为带引用的 Word。
- **能用我的 ChatGPT 订阅吗？** 能，需要 ChatGPT Plus 或 Pro。在**设置 → 模型**里选**使用 ChatGPT 继续**，在浏览器里完成登录即可：之后的提问会以你的账号发给 OpenAI，计入订阅的用量上限，不需要密钥。
- **能用我的 Claude 或 GitHub Copilot 订阅吗？** 能。在**其他方式**或**设置 → 模型**里，用你的 Claude 或 GitHub 账号登录；登录之前不会启用。回答会计入你订阅的用量限额。Copilot 登录目前是实验性的。
- **能离线用吗？** 读取文件和搜索可以离线。回答和核对需要 AI 模型，大多数人要联网。通过 [Ollama](https://ollama.com) 运行的本地模型可以离线回答，但比云端模型慢，也没那么可靠。按含义搜索（嵌入）是可选功能，默认关闭。
- **会改动我的文件吗？** 不会。它只在原处读取文件，只往自己的数据文件夹和你导出的文件里写内容。
- **怎么备份？** 复制数据文件夹就行，里面有你的 Mind、搜索索引和设置。

</details>

## 参与贡献

欢迎写代码、用你自己的文档测试、翻译和提想法：先读 [CONTRIBUTING.md](CONTRIBUTING.md)（英文），也可以[提交 issue](https://github.com/IncarnaMind/IncarnaMind/issues/new/choose)，或到[讨论区](https://github.com/IncarnaMind/IncarnaMind/discussions)提问（中文、英文都可以）。

## 项目由来

IncarnaMind 最早是 2023 年的一个 Python 命令行工具，用来和 PDF 对话，收获了大约 800 个 star；2026 年从头重写成桌面应用，核心只有一个想法：从文件里得到的回答，能核对才真正有用。旧版命令行工具保留在 [`v1-python-cli`](https://github.com/IncarnaMind/IncarnaMind/tree/v1-python-cli) 标签下。谢谢一直关注它的你；如果 IncarnaMind 对你有用，点个 star，能让更多人看到它。

<details>
<summary>引用 IncarnaMind</summary>

```bibtex
@misc{IncarnaMind2023, author = {Junru Xiong}, title = {IncarnaMind}, year = {2023},
  publisher = {GitHub}, journal = {GitHub Repository},
  howpublished = {\url{https://github.com/IncarnaMind/IncarnaMind}}}
```

</details>

## 许可证

[Apache License 2.0](LICENSE)。应用内置的字体（Source Serif 4、Source Sans 3 和 JetBrains Mono）采用 [SIL Open Font License 1.1](https://openfontlicense.org)。引用格式和语言文件原样取自 [Citation Style Language](https://citationstyles.org/) 项目，采用 [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/)；排版引擎是 [Hayagriva](https://github.com/typst/hayagriva)（MIT 或 Apache-2.0）。相关声明见 [`resources/notices`](resources/notices)。
