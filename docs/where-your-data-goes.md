# Where your data goes

**English** · [简体中文](where-your-data-goes.zh-CN.md)

IncarnaMind reads, searches and indexes your files here. It has no account or server for them. Data leaves only to a service you choose, where a line says what goes; a model on this computer sends nothing. Settings → Privacy lists every flow; [privacy.md](privacy.md) has the full detail.

| What you use | What leaves | Goes to | When |
| --- | --- | --- | --- |
| A Question | The Question and its context: the Blocks above it; in the assistant, earlier messages and the Note in focus; up to 30 Note names if it can read Notes; the Passages found with their Document names and pages; up to 50 Document names; Connector and Skill-script results, a capped Analysis report, and live Transcript lines in a Meeting. | The AI model's provider you chose | Each time you ask; choosing a cloud model allows this, Edit with AI, the checks and suggestions at once. |
| Edit with AI | The selected text and the paragraphs it is in | The AI model's provider | Each time you ask |
| A check | The sentences checked with each Citation's quote and Document name, or a document's claims with their paragraphs and Passages; after a new Document version, the cited sentences of the Notes in its Folder, for contradictions | The AI model's provider | When you start it; the contradiction check runs in the background once allowed. A Citation's quote is checked here without a model. |
| Writing suggestions | The paragraph you pause in and up to 8 Passages that match it | The AI model's provider | Only after you turn suggestions on |
| Automatic Tags, Organize and scans | A Document's name, type and opening excerpt; every Tag's and Folder's name and description; Organize can also send up to 3 page images of a PDF with no text | The AI model's provider, or TypeSafe Jev if you saved a Jev key; the image model's service for page images | Tagging follows `Tag and sort new Documents automatically` (on by default for a model on this computer); Organize when you start it, after a line says what goes; grouping follows the same switch; page images only after you allow them in Settings → Privacy |
| Document search | With a cloud embedding model: every Passage with its Document's name, again when you change the model, and every search query | OpenAI, Google, an OpenAI-compatible server, or Ollama elsewhere | Only then; the built-in model runs here and sends nothing |
| Reranking | With a Cohere or Voyage AI key: each query and its candidate Passages | Cohere or Voyage AI | Only then; the built-in reranker runs here |
| Web search | What an Answer searches for, written by the model | The provider of the model you asked with | Off unless you turn it on; the pages are fetched from your computer |
| A Connector | The arguments of its Tool calls; the words you type in Settings → Connectors | That Connector, one service each; the MCP Registry for a search | When an Answer calls it; the first time you search |
| Find sources, look-up and reference check | What you search for, with filters; a DOI or work ID; each reference list entry, as written | OpenAlex, arXiv, PubMed, Crossref and the others you choose; Crossref or arXiv for a look-up; Crossref, then OpenAlex or arXiv, for a reference check | Once you allow that provider and use it; reference check answers are kept here |
| Meeting transcription | All of a Meeting's audio while it records, microphone and computer sound | Soniox (your key) or OpenAI realtime (your key) | Only with a cloud route; it can't be chosen in local mode |
| An AI agent you connected | What it reads: Passages and Notes in the folders you shared, and Answers it asks for | The agent, then its own AI model | When it calls; paused in local mode |

## Nothing of yours goes without a choice

With `Keep everything on this computer` on, every cloud flow above stops or uses only a model on this computer. What still happens: update checks to GitHub at startup in the installed app, unless off; model downloads from huggingface.co, hf-mirror.com and, once set up, ModelScope or R2, and Ollama pulls (nothing of yours); a page you name waits for you to let it go; and a Connector here keeps working, and can reach the network itself.

Usage data goes only from a build with an analytics project and only if you choose Send (a test build sends until you turn it off); crash reports only if you turn them on; sign-ins to ChatGPT, a Claude account or GitHub go only to that service.

Your keys stay here and go only to their own service. There is no sync: nothing is uploaded to an IncarnaMind account; there isn't one.
