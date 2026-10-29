# Writing Chinese strings

Read this before adding or changing a string in `src/shared/i18n/zh-CN.ts`, whether you are a person or a coding agent. It sits beside the words in [`CONTEXT.md`](../../CONTEXT.md) and the interaction rules in [`interaction.md`](interaction.md).

**The bar:** the Chinese interface reads like mainstream Chinese software, in the words Chinese Users already know from Feishu, Yuque, Tencent Docs, WPS, Kimi, Doubao, Yuanbao, ChatGPT, Notion, Obsidian, Zotero, macOS and Windows. Write it as a Chinese product would say it, not as a translation of the English. When a term isn't in the glossary below, use the word those apps show for the same thing, and add it here.

## The rules

1. **你, never 您.** Ant Design, Arco, Semi and Microsoft's Chinese style guide all say so; macOS uses 你 throughout.
2. **A space between Chinese and Latin letters or numbers.** "导出为 Word", "135 MB", "第 3 页", "{count} 个文档". No space next to full-width punctuation ("“Lease”的文件"), and none before % or °.
3. **Full-width punctuation in Chinese text:** ，。：；？！（）. Separate list items with 、 ("PDF、Word 和 Excel"). Parentheses stay full-width around Latin text: "Word（.docx）".
4. **Quotation marks are “ ”**, with ‘ ’ inside. Quote the names of UI items, files, Documents, Folders, Tags and anything the User typed: "移动到“财务”", "已保存“Tides 2.docx”". Keep 《》 for the titles of published works. Never use 「」.
5. **One "…" (U+2026)** after a command that asks for more before it acts ("导出…", "移动到…") and on progress ("正在整理…"). Use "……" only in running prose.
6. **Buttons and menu items are a verb, or a verb and its object:** 保存, 添加文档, 移动到…. No 请, no 点击, no 。. Cancel is 取消, Done is 完成, Retry is 重试.
7. **Errors say what happened, then what to do.** Prefer 无法… or 未能… to a bare 失败 or 没有成功: "无法调用 Notion：search", "未能登录。", "无法读取此文件". Don't blame the User.
8. **Empty states say "还没有…" and the next step:** "还没有文档。添加文件或文件夹。" Not "暂无数据".
9. **Counts use 个** for 文档, 文件, 文件夹, 标签, 引用, 段落 and 工具, and **项** for a mixed selection ("还有 3 项"). 篇 counts a Note ("3 篇笔记"), and stays only in prose for a Document ("一篇文档"). A Note takes no plural in a label: "笔记（3）", "收起笔记".
10. **Status:** progress is 正在… ("正在整理 3 个文档…"), done is 已… ("已保存"), not yet is 尚未… or 未….
11. **Use the verbs Chinese apps use:** 生成 an Answer (not 写), 加载 (not 载入), 调用 a Tool (not 询问), 搜索 in a search field (not 查找), 新建 (not 创建), 重命名 (not 改名), 撤销 (not 撤消).
12. **Avoid translationese.**
    - No 被 where an active sentence works ("已删除", not "已被删除").
    - No 进行 + verb ("根据描述来判断", not "依据描述进行判断").
    - No long 的 chain before a noun: split the sentence ("添加一个问题，只搜索此文件夹", not "添加一个只搜索此文件夹的问题").
    - Drop 它/它的 and 你的 when they add nothing.
    - Put the condition first ("开启后，…").
13. **One word for one thing.** Use the glossary everywhere and never a second word for the same concept: 不在文件夹中, not 未分类 or 未分组; AI 模型 in sentences (not 对话模型 or 聊天模型); a company's own name, or 服务 when generic (not 提供商 or 服务商).
14. **Platform words go in their own keys.** Where macOS and Windows name a thing differently, add a key per platform and choose it in code, as `linkedFolders.reveal.mac` / `.windows` / `.other` and `menu.copy` / `menu.copy.other` do. Don't put one platform's word on the other.
15. **Names stay as they are:** IncarnaMind, ChatGPT, Ollama, OpenAI, PDF, Word, Markdown. Write file types in capitals (ZIP, CSV), and keys as they are printed (Enter, Esc, Backspace, ⌘J).

Before you open the pull request, read every new Chinese string aloud. If it sounds translated, rewrite it. Check it on screen at the narrowest window, too (interaction rule 11).

## Glossary

The words from `CONTEXT.md`, then the ones the interaction rules bring in. Where Chinese apps disagree, the choice follows the one most of them show.

A Note is what the User writes in; your text is a Block the User writes. The code and the data keep `mind`. 笔记 means the Note, and 你写的内容 means your text.

### IncarnaMind's own words

| English | Chinese | Notes |
|---|---|---|
| Note | 笔记 | The place the User writes in. 篇 counts it in prose ("3 篇笔记"); a label takes no measure word: "笔记（3）", "收起笔记". Where the User first meets it (the example's banner, the first empty Note, New Note's tooltip) one sentence says what it is: "笔记：在这里写作、向文档提问，每条引文都会核对。" |
| Assistant | 助手 | The one per window. "展开助手", "收起助手". As Kimi, Doubao and Yuanbao call themselves (智能助手, AI 助手). |
| Conversation | 对话 | New chat is "新对话", History "历史对话", counted with 个: "3 个对话". As Doubao, Yuanbao, DeepSeek, Qwen, Feishu, Cherry Studio and Open WebUI show it. |
| Your text | 你写的内容 | A Block the User writes, as opposed to one the assistant wrote. The strings say 你写的内容 for it ("你写的内容", "正在搜索你写的内容和文档…"); 笔记 means the Note. |
| Block | 块 | "块选项". As Feishu does. |
| Question | 问题 | Ask: 提问. "就此文档提问". |
| Answer | 回答 | Generate: 生成; Regenerate: 重新生成; Stop: 停止. |
| Question context | 上下文 | |
| Search scope | 搜索范围 | "选择搜索范围", "缩小范围". |
| Document | 文档 | Counted with 个. |
| Missing Document | (status) 文件缺失 | Long form: "找不到文件：引用保留原文，搜索不再包含它。" |
| Unavailable Document | (status) 无法访问 | |
| Linked folder | 关联文件夹 | "添加文件或文件夹…", "移除关联文件夹…". Nothing is synced to a cloud: IncarnaMind reads the folder where it is, and says so ("开始读取"). Not 同步文件夹, which promises a copy IncarnaMind doesn't make. |
| Other Documents | 其他文档 | |
| Web page | 网页 | A Document saved from a web address (网址). Its snapshot is 快照, as search engines' 网页快照: "打开快照". Fetching it is 抓取: "重新抓取", "无法抓取：网页需要登录". The live page: 原网页 ("打开原网页"). |
| Passage | 段落 | |
| Citation | 引用 | The numbered reference in an Answer, as Kimi, Doubao, Qwen, Cherry Studio and Open WebUI show it. |
| Own workings | 工作文件 | A Document the User keeps as their own workings: "不作为引用来源", "重新作为引用来源", its label "不引用", and on a check's card "只有你自己的工作文件这样写。" |
| quote (of a Citation) | 引文 | "已在第 3 页找到引文", "未找到引文". |
| Quote (block) | 引述 | The "/" menu's block for quoted text; not a Citation (引用) or its quote (引文). |
| Selected text (in a Document) | 所选文字, 选中的文字 | Words the User selected in a Document's viewer, to ask about, add to a note or copy: "就此提问", "“{文档}”中选中的文字没有发送". Not a Quote block (引述). |
| Location | 位置 | "第 3 页", "第 2 张幻灯片", "第 4–6 行", "§ 标题", a web page's "§ 历史，第 3 段". |
| Cited page | 引用页面 | The saved picture of what a Citation points at: "打开引用页面". |
| Source pack | PDF 引用页面合集 | The export of a Note's cited pages. |
| Web page to share | 可分享的网页 | The export a reader opens in a browser, each Citation's quote a click away: "可分享的网页（.html）". A template puts no space around `{format}`: the space comes only beside a Latin name ("导出为 PDF", "导出为可分享的网页（.html）"). |
| Footnote | 脚注 | As Word, WPS and Feishu. "插入脚注", "脚注 3". |
| Reference record | 引用信息 | The "Cite as" panel's title too. Its fields: 类型、标题、作者、日期、期刊（出处）、卷、期、页码、出版者、DOI、网址、语言. |
| Needs details (a reference record) | 信息待补充 | |
| Look up (a reference record) | 查询 | "按 DOI 从 Crossref 补全空白字段". |
| Web search | 联网搜索 | Searching the web from an Answer: "允许回答联网搜索", "已联网搜索“…”", and the Unsupported card's action. Never 网页搜索. As Kimi, Doubao, Yuanbao and DeepSeek show it. |
| Find sources | 查找资料 | "查找资料…". One name for the panel, its menu items and the button on a claim's card, never 查找来源. 资料 matches 资料库 (Library): what is found is added to it. |
| Source provider | 资料来源 | "资料来源：OpenAlex arXiv PubMed". Not 服务, which is an AI model's company. |
| Open access | 开放获取 | As CNKI and publishers say it. "仅开放获取", "无开放全文". |
| Preprint / Accepted manuscript | 预印本 / 录用稿 | The version an open copy is. |
| Cited by {count} | 被引 {count} 次 | As CNKI and Google Scholar show it. |
| Import references | 导入引用信息… | From a CSL JSON, BibTeX or RIS file. Counted with 条: "导入了 3 条". |
| Reference without a Document | 还没有文档 | Its list: "添加 PDF…" links it. |
| Citation style | 引用格式 | "引用格式…", "引用格式已改为 APA 第 7 版". A style keeps its own name; its variant goes in full-width brackets, in the standard's words: "GB/T 7714—2015（顺序编码制）", "（著者-出版年制）". |
| A citation style's form | 作者-年份, 作者, 编号, 代号, 脚注 | What the picker says after each style's name, for author-date, author, numeric, label and note. A label ("[Smi10]") is 代号, never 标签, which is a Tag. |
| Bibliography | 参考文献 | Its heading in the Note and in Chinese styles' exports. |
| Style (a Note's font and text size) | 样式 | "样式…" in the Note's menu. Its parts: 字体 (font), 字号 (text size: 小、默认、大) and "设为新建笔记的默认样式". The three fonts are 默认, 衬线 and 等宽, as Notion's; a font the computer lacks is "此电脑未安装该字体". |
| Format (the selection menu's Aa) | 格式 | As Word and WPS name formatting: 字体、字号; alignment 左对齐、居中、右对齐、两端对齐; 行距 with 单倍、1.15、1.5、双倍、自定义…; space around a paragraph 添加/移除段前间距, 添加/移除段后间距, as Google Docs words it; 增加缩进, 减少缩进 and 首行缩进 2 字符; 文字颜色 with 自动; 上标, 下标. A Note's own line spacing in 样式 is 行距 too, its first choice 默认. |
| Folder | 文件夹 | |
| Source location | 磁盘上的文件夹 | The sidebar's name for the files as they are on disk; the Library's filter names it 文件位置. |
| Tag | 标签 | Tagging is 打标签; automatic tagging is 自动打标签. |
| Library | 资料库 | Where the User's files live in ChatGPT (资料库), Yuanbao (资料库, 加入资料库) and LobeChat. Not 知识库, which in Feishu and Yuque is a wiki and in AI clients a collection built for one assistant. |
| Organize | 整理 | "整理此文件夹". As Tencent Docs (批量整理文档) and Apple Notes (整理备忘录). |
| Not in a Folder | 不在文件夹中 | One place for Documents and Notes in no Folder. |
| Tab | 标签页 | As Chrome, Edge and VS Code. A preview tab is kept with 保持打开. |
| Group (of tabs) | 栏 | "第 1 栏", "向右拆分", "各栏等宽", "移动到右侧一栏". |
| Tool | 工具 | Calling one: 调用. |
| Connector | 连接器 | As Doubao, Feishu, LobeChat and Microsoft. |
| Skill | 技能 | As Kimi, Doubao, Yuanbao, Feishu, Notion and Cherry Studio. |
| Skill script | 技能脚本 | |
| Built-in Skill | 内置技能 | |
| Outside agent | 智能体 | The User's own AI agent: "连接智能体", "设置 → 智能体". As Kimi, Doubao, Yuanbao and Coze call an agent. |
| Proposal | 修订 | Accept: 接受; Reject: 拒绝; Accept all: 全部接受; Reject all: 全部拒绝. As WPS and Feishu (接受修订, 拒绝修订). |
| AI text | AI 生成的文字 | Not shown as a word in the interface yet. "Mark as mine" is 标为我写的, and its undo line 已标为你写的. |
| Checkpoint | 检查点 | |
| History (a Note's versions) | 历史版本 | "历史版本", "恢复此版本", "当前版本". As Yuque and Tencent Docs. Not 历史对话, which is the assistant's. |
| Record cite | 记录引用 | A reference in legal writing to a record Document and its exact Location ("Smith Dep. 45:3–12"). Each has its own result, apart from the sentence's: "这句话中的记录引用". Not 引用 alone, which is a Citation. |
| Citation check | 核对 | "正在核对引文…", "无法核对". |
| Quote not found | 未找到引文 | |
| Unsupported | 无依据 | |
| Not found (a sentence's check) | 未找到 | The card of an unsupported sentence that nothing in the scope states: "未找到", "未在“{scope}”中找到". Never 未找到引文, which is a Citation's quote. |
| Contradicted | 与文档矛盾 | |
| Needs re-check | 需重新核对 | |
| Not checked | 未核对 | A claim that wasn't checked: the model declined, its reply couldn't be read, or a limit stopped the run ("未核对：已达花费上限"). |
| Not examined | 未能判断是否为说法 | A sentence the model said nothing of when the check named the claims: "1 句未能判断是否为说法". Not 未核对, which is a claim whose check failed or hasn't run. |
| Claim | 说法 | What a check looks at, in an Answer, a Note or a document someone else wrote. Counted with 条: "核对 24 条说法". Not 论断, an argued conclusion, or 主张, a party's claim in law: neither fits a sentence in a contract or a site report. |
| Shorten (an AI edit) | 精简 | "精简", "正在精简…". Not 缩写, which means abbreviate. The others: 润色, 翻译, 解释. |
| Find support | 查找出处 | No longer a command: only a ⌘K keyword for Check against Documents, which offers Add as Citation. 出处 is the word for a source a writer cites (注明出处); not 依据, which reads as a check. |
| Check record | 核对记录 | "将核对记录导出为 PDF". The PDF or CSV of what a Note's checks left. |
| Check against Documents | 对照文档核对 | Gives a verdict: 有依据, 无依据 or 与文档矛盾. |
| Check someone else's PDF | 核对别人的 PDF | The + menu and ⌘K command (#1941). The verb is 核对, as for a Citation; the card it opens still says 核对这个文档. |
| Need a look | 需要留意 | The claims that are unsupported or contradicted: "3 条需要留意" in Verify. The Note's health counts its unsupported sentences with 处: "2 处需要留意". |
| Mark | 标记 | |
| Run | 运行 | |
| Task | 任务 | |
| Routine | 定时任务 | As Kimi, Doubao, Yuanbao, Cherry Studio and LobeChat. |
| Comparison table | 对比表 | |
| Chart | 图表 | Its kinds: 柱状图、折线图、饼图、散点图. "以表格显示" / "以图表显示"; "用表格生成图表". |
| Columns (a chart's series) | 数据列 | The columns of a table a chart draws. A scatter chart's two: 横轴 and 纵轴. |
| Rows (a switched chart's series) | 数据行 | The rows of a table a chart draws once its rows and columns are switched: "行列互换". |
| Source (of a chart's values) | 数据来源 | Under a chart in an export, as Chinese reports caption theirs: "数据来源：". |
| Memory | 记忆 | |
| Meeting | 会议 | |
| Voice memo | 语音备忘 | "录一段语音备忘"; the + menu's item is 语音备忘. As Apple's 语音备忘录, without its 录. Its note: "已写入语音备忘". |
| Transcript | 转写稿 | |
| Speaker | 发言人 | |
| Me, Them, Speaker ? (a live line before speakers are told apart) | 我, 对方, 发言人 ? | "Me" is the microphone, "Them" the computer's sound, "Speaker ?" a meeting in a room, with no computer sound. |
| Granted folder | 授权文件夹 | |
| Output location | 保存位置 | |
| Usage data | 使用数据 | |
| Scanned page, scan | 扫描页、扫描件 | A PDF page that is a picture: counted with 页 ("12 页扫描件"). |
| Text recognition (OCR) | 文字识别 | Reading a scan: 识别 ("正在识别 12 页扫描件…", "第 3 页扫描件无法识别"). The model is 文字识别模型. |
| Text read from a scan | 从扫描件识别的文字 | On a Citation's card. A word it may have misread: "可能识别有误". |

### Figures

A figure in an Answer is written as reports write it, with no space between the number and its scale or unit: "3,045.74万元", "2.3个百分点", "约1.2亿元".

| English | Chinese | Notes |
|---|---|---|
| figure (a number in an Answer) | 数字 | Counted with 个: "计算了 2 个数字", "1 个数字未能计算". |
| Calculated figure | 计算结果 | Its label word is 计算得出 ("计算得出 · 20.4%"), as "Calculated" is in English. |
| Input (of a calculation) | 所用数据 | "所用数据均已找到". |
| Calculation check | 核对计算 | The verb is 核对, as for a Citation: "正在核对数字…". |
| Unchecked figure | 未核对的数字 | |
| Analysis | 数据分析 | Can't run: "这台电脑上无法运行数据分析：…". |
| Sandbox (where Skill scripts and Analyses run) | 沙盒 | Never 沙箱. |
| Analyse data… (⌘K, and the composer's chip) | 分析数据… | The chip reads 分析数据; a step that ran one, 对“{document}”运行了数据分析. |
| Recalculate | 重新计算 | |
| Run again | 重新运行 | |
| percentage points | 个百分点 | A difference of two percents: "2.3个百分点", never "2.3%". |
| about (an approximate figure) | 约 | "约1.2亿元". |
| times (a multiple) | 倍 | "4.00倍". |
| yes / no (what a comparison gives) | 是 / 否 | |
| Tie out figures | 核对数字 | The command in ⌘K and the page menu: every figure in a Note against its source. |
| Figure schedule | 数字核对表 | The tab beside the Note, and its export: "导出核对表…", "{name} – 数字核对表". Counts as the header does: "18 个数字 · 15 个有依据 · 3 个需要留意 · 0 个未核对". |
| Source value | 来源数值 | The number as the source gives it. |
| Difference | 差异 | The signed amount ("+£10m"), or "由 £4,979.6m 舍入" for a figure within its shown rounding. |
| Doesn't add up (a total) | 合计不符 | Figures only: "合计不符：上面各行相加为 £4,850m". A total that agrees with its source says "与来源一致" too. |
| Treat as a total / Not a total | 将此行当作合计 / 将此列当作合计 / 不是合计 | The table menu and the schedule's row menu. 合计 is a total, 小计 a subtotal, 总计 a grand total, as statements label them. |

### Finance and law

The words the finance and law Skills (#1938) use, as Chinese research, banking and legal products
write them.

| English | Chinese | Notes |
|---|---|---|
| Covenant (financial) | 财务约定 | A term of a facility agreement: its test, its level and the latest figure. The Skill's title is 财务约定摘要. |
| Confidential information memorandum (CIM) | 保密信息备忘录（CIM） | Its short form is 信息备忘录. The Skill's title is 信息备忘录疑点核查. |
| Data room | 数据室 | Not 资料库, which is the Library. |
| Red flag (a CIM claim the data room doesn't support or contradicts) | 疑点 | A claim that needs a look; not 红旗, a literal translation. |
| Credit memo / credit committee paper | 授信报告 | Its outline is 授信报告提纲, as banks word it. |
| Deposition | 证词 | The transcript is 证词笔录; a summary is 证词摘要. |
| Guidance (a company's) | 业绩指引 | The forward-looking figures a company gives, as announcements and research write it. |
| Earnings review | 业绩回顾 | The quarter against the prior period and the guidance. |
| Chronology | 事件时间线 | The dated list of a record's events. |

### Dates and times

A date in a string is a `{date}` or `{time}` parameter, written by `src/shared/dates.ts`, never by a string or by code of its own: "会议，{date}", "{time} 后可重试". The module gives each language one style, and a test fails on a date built by hand elsewhere.

| Kind | English | Chinese |
|---|---|---|
| Day | 12 October | 10月12日 |
| Date | 12 Oct 2026 | 2026年10月12日 |
| Date and time | 12 Oct 2026, 15:20 | 2026年10月12日 15:20 |
| Time | 15:20 | 15:20 |

The year is left out when it is this year, except in a Date, and a time today is the time alone. The clock has 24 hours ("15:20"), and 12 when the system asks for it ("下午3:20"). A weekday goes before the date in English ("Friday 9 Oct") and after it in Chinese ("10月9日星期五").

### Models and settings

| English | Chinese | Notes |
|---|---|---|
| embedding model | 嵌入模型 | |
| reranking | 重新排序; the model: 重排序模型 | |
| provider | the company's name, or 服务 | "无法连接 OpenAI"; 服务 for the Settings row. Not 提供商. |
| money | $1.40、¥1.40 | The narrow symbol of each currency, in both languages: "$", never "US$", and "¥". Two currencies in one line are told apart by them: "$3.20 和 ¥1.40". |
| API key | API 密钥 | |
| Server URL (base URL) | API 地址 | As Cherry Studio and Open WebUI. |
| local / cloud | 本地 / 云端 | "本地模型", "云端模型", "在本机运行". |
| sign in / sign out | 登录 / 退出登录 | |
| ChatGPT plan | ChatGPT 订阅 | |
| Settings | 设置 | |

### File and editing words

| English | Chinese | Notes |
|---|---|---|
| Recently deleted | 回收站 | As Feishu, Yuque, Tencent Docs, WPS, DingTalk, Obsidian and Zotero. Restore: 恢复. Delete permanently: 彻底删除. |
| Revoke (an allowed service) | 停止允许 | Not 撤销, which is Undo. For a service the User allowed to receive data (Privacy); approvals have their own words. |
| Local mode | 所有内容都留在这台电脑上 | The one name, quoted: “所有内容都留在这台电脑上”; its button is 允许使用云端模型. Never 本地模式. A line that names it says what stopped, then the name: “未发送：已开启“所有内容都留在这台电脑上”。” |
| Chat model | AI 模型 | In sentences and on Settings' labels. |
| Embedding model | 搜索模型 · 按含义搜索 | "正在为搜索读取文档". Not 嵌入. |
| Reranking | 把最相关的排在前面 | "最相关的排在前面" on Settings; never 重排序. |
| Undo | 撤销 | The undo line: "已将 3 个文档移动到“财务” · 撤销". |
| Rename | 重命名 | |
| Move to… | 移动到… | |
| Pin / Unpin / Pinned | 置顶 / 取消置顶 / 已置顶 | |
| Recent | 最近 | |
| Peek (Space) | 预览 | macOS calls its Quick Look 快速查看; Chinese apps say 预览. |
| Get info | 文档信息 | As Feishu (文档信息) and Tencent Docs (查看文档信息). The same on every platform. |
| To review | 待确认 | |
| Suggested Folder | 推荐的文件夹 | The chip says 推荐. |
| Accept / Not this Folder (a Suggested Folder) | 接受 / 拒绝推荐的文件夹 | The pair a Proposal has (接受, 拒绝), as verbs; the undo line says 已接受 or 已拒绝, never a bare 不…. |
| Show in Finder | macOS: 在访达中显示; Windows: 在文件资源管理器中显示; Linux: 在文件管理器中显示 | Per-platform keys. |
| Copy path | 复制路径 | As VS Code and Obsidian, on every platform. |
| Open in default app | 用默认应用打开 | |
| Copy (Edit menu) | macOS: 拷贝; Windows and Linux: 复制 | Per-platform keys. |
| View (menu) | macOS: 显示; Windows and Linux: 查看 | Per-platform keys. |
| Sidebar | 侧边栏 | One word on every platform, so the button and the menu agree. |
| Import / Export | 导入 / 导出 | |
| Filter | 筛选; Clear filters: 清除筛选 | |
