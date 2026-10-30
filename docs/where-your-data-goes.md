# Where your data goes

**English** · [简体中文](where-your-data-goes.zh-CN.md)

IncarnaMind reads, searches and indexes your files here. It has no account or server for them. Data leaves only to a service you choose, where a line says what goes; a model on this computer sends nothing. Settings → Privacy lists every flow; [privacy.md](privacy.md) has the full detail, every field included.

| What you use | What leaves | Goes to | When |
| --- | --- | --- | --- |
| A Question | The Question and its context: the Blocks above it, except the Blocks of your text you excluded; in the assistant, earlier messages and the Note in focus; up to 30 Note names if it can read Notes; the Passages found with their Document names and pages; up to 50 Document names; Connector and Skill-script results, a capped Analysis report, and live Meeting Transcript lines. | The AI model's provider | Each time you ask; choosing a cloud model allows this and the next two flows. |
| Edit with AI and Writing suggestions | The selected text with its paragraphs, or the paragraph you pause in and up to 8 Passages that match it | The AI model's provider | Each time you ask; suggestions only after you turn them on |
| A check | The sentences checked, with each Citation's quote and Document name; or a document's claims, with their paragraphs and Passages; after a new version, the cited sentences of the Notes in its Folder, for contradictions | The AI model's provider | When you start it; the contradiction check runs in the background once allowed. A Citation's quote is checked here locally. |
| Automatic Tags, Organize and scans | A Document's name, type and opening excerpt; Tag names and descriptions; Organize also sends every Folder's name and description, and up to 3 page images of a PDF with no text | The AI model's provider, or TypeSafe Jev if you saved a Jev key; the image model's service for page images | Tagging follows `Tag and sort new Documents automatically` (on by default locally); Organize when you start it, after a line says what goes; grouping follows the same switch; page images only after you allow them |
| Document search and reranking | With a cloud embedding model: every Passage with its Document's name, again when the model changes, and every search query. With a Cohere or Voyage AI key: each query and its candidate Passages. | OpenAI, Google, an OpenAI-compatible server, or Ollama elsewhere; Cohere or Voyage AI | Only with those choices; the built-in model and reranker send nothing |
| Web search | What an Answer searches for, written by the model | The provider of the model you asked with | Off unless you turn it on; the pages are fetched from your computer |
| A Connector | The arguments of its Tool calls; the words you type in Settings → Connectors | That Connector, one service each; the MCP Registry for a search; a remote Connector's server, and its authorization server at sign-in | When an Answer calls it; the first time you search; when it connects or signs in |
| Find sources, look-up and reference check | What you search for, with filters; a DOI or work ID; each reference list entry, as written | OpenAlex, arXiv, PubMed, Crossref and other sources you choose; Crossref or arXiv for look-up; Crossref, then OpenAlex or arXiv, for reference check | Once you allow that source and use it; reference check answers are kept here |
| Meeting transcription | All of a Meeting's audio while it records, microphone and computer sound | Soniox (your key) or OpenAI realtime (your key) | Only with a cloud route; it can't be chosen in local mode |
| An AI agent you connected | What it reads: Passages and Notes in your shared folders, and Answers it asks for | The agent, then its own AI model | When it calls; paused in local mode |

On the same chat flow, `Make this a Skill` sends up to 40,000 characters from the end of the Note; a Question naming another Note, up to about 12,000 tokens of it; a command, names, dates, Folders and Tags of what it found; a model without Tools, the Question rewritten and translated as search queries.

## Nothing of yours goes without a choice

With `Keep everything on this computer` on, every cloud flow above stops or uses a local model. Still happening: update checks to GitHub at startup, unless off; model downloads from huggingface.co, hf-mirror.com and, once set up, ModelScope or R2, and Ollama pulls (nothing of yours); a page you name waits for you to let it go; and a local Connector keeps working and can reach the network itself.

Usage data goes only from a build with an analytics project and only if you choose Send (a test build sends until you turn it off); crash reports only if you turn them on; sign-ins to ChatGPT, a Claude account or GitHub go only to that service.

Your keys stay here and go only to their own service, except an AI agent's pairing key: a plain-text copy is in the agent's settings, setup command or install bundle, so keep it private. There is no sync: nothing is uploaded to an IncarnaMind account; there isn't one.
