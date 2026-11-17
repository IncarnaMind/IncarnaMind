# AI providers are configurable, and we don't use LangChain

**Amended 2026-10-11: which providers get first-class support, and which are best effort, is [ADR-0019](0019-few-first-class-providers-and-agents.md).**

The User picks one chat provider and one embedding provider. The options are OpenAI, Anthropic (chat only), Google, or any OpenAI-compatible server, which includes Ollama for fully local models and Chinese models such as DeepSeek and Qwen. ChatGPT Plus and Pro users can also use their plan for chat. This replaces the old backend, which needed Azure OpenAI, Google Vertex, Cohere, Voyage and a private Hugging Face endpoint all at once.

We don't use LangChain. The only parts the old code used were document loaders and a text splitter, which are small enough to own, and the user wants as few dependencies as possible.

## One catalog of providers and models (#176)

What the app knows about providers and models is one catalog in code (`src/core/providers/catalog`), read instead of guessing from model names.

- **Providers are written by hand,** with their endpoints per region, request quirks (OpenAI's `store: false`), a line on what the provider does with API data, and the models for Answers, quick tasks and reading images. A provider's Answers default is its cheaper capable model; its strongest is one click away.
- **Model facts are generated** from models.dev (MIT), cross-checked against LiteLLM's model list (MIT), by `node scripts/catalogModels.ts`, and corrected in a short hand-written overrides file. Their licences ship with the data. Prices are in the provider's own currency.
- **No runtime fetch.** The catalog changes only with releases. A provider's own model list, fetched after consent, brings new model ids on the day they launch; until the catalog knows them their capabilities are unknown, and they still work.
- **Precedence:** what the User set, then what the server reports (Ollama's model details, Anthropic's model list, a refusal an Answer meets), then the catalog, then unknown, which keeps the step-down of ADR-0007. Reading images, temperature, the way of citing, structured output and a cloud model's context window come from this, not from name patterns.
- **Stored providers** carry their catalog id and endpoint (migration 31); keys stay where they were.

## The ChatGPT plan runs on OpenAI's Sign in with ChatGPT (#122)

OpenAI documents it for open-source apps that run on the User's computer, with no approval needed: the first sign-in registers IncarnaMind's own client (`dynamic_agent_client`, "IncarnaMind" as the app's name), and requests go to the public Responses API with the User's token (https://developers.openai.com/siwc/token-sharing-open-source). It is a normal choice, "Continue with ChatGPT", not experimental.

- It replaced an experimental provider that signed in with the Codex CLI's client and called ChatGPT's `backend-api`, which OpenAI's terms rule out ("only through OpenAI's supported sign-in flow"; "Do not impersonate… another application", https://openai.com/policies/sign-in-with-chatgpt-terms/).
- The terms also require that the plan works without paying IncarnaMind or upgrading in it, and that only the User's own activity, or background work they agreed to, uses it: each data flow's consent covers that. A paid or hosted IncarnaMind would need OpenAI's interest form first.
- No code of OpenAI's devkit is used: its licence is non-commercial.

## Embeddings, reranking and tagging

- **Embedding:** the default provider is a small multilingual model built into the app, downloaded on first use and run on the User's CPU. Document text never leaves the machine during indexing. Users who want better quality can switch to an API or Ollama. Embeddings are off by default: search is keyword search, reranked, and the built-in model is one of the choices the User turns on (ADR-0009).
- **Reranking is on by default** with a built-in multilingual model, mmarco-mMiniLMv2-L12-H384: a 136 MB download once there are Documents to search, run on the CPU, sending nothing. In the retrieval evaluation (#31) it took hybrid search from 13 to 16 of 20 English Questions and from 19 to 20 of 20 Chinese ones, so the 80% bar holds, for about 0.5 to 0.9 s a search. The User can rerank with a Cohere or Voyage key instead, or turn it off.
- **Tagging and Organize (#180)** use one model choice, "Automatic" unless the User picks a model. Automatic takes, in order: Jev, when a TypeSafe Jev key is configured (it returns calibrated probabilities, and its endpoint can be changed, so Jev-compatible models work too); the tagging model of the chat provider, from the catalog's optional `tagging` role, else its quick-tasks model (never an Ollama cloud model, whose cloud doesn't hold a reply to a schema); a local decision model installed in Ollama; the chat model on this computer. On the Organize evaluation a cloud provider's cheap model tagged better than any local route, at under 2 US cents per 100 Documents. Calls that don't write an Answer go to the quick-tasks model, OpenAI's with reasoning off.

## Considered options

**Using a Gemini subscription instead of an API key**: rejected. Google's terms forbid third-party apps from using Gemini subscription credentials, and accounts that do so can be suspended. Gemini is available with an API key only.

## Consequences

- Changing the embedding provider means re-processing every Document, because Passages embedded by different models can't be compared.
  - Each Document records the model its vectors come from (provider, server and model) and their size. Search compares a query only with vectors of the current model.
  - During a switch, search uses the new model at once and is marked as rebuilding: keyword search covers every Document throughout, vector search the Documents already embedded again. We chose this over searching the old vectors until the switch completes, which would keep sending queries to the old provider after the User left it (defeating local mode) and need the old key and two sets of vectors.
  - A Document keeps its old vectors until the rebuild reaches it, so switching back before then costs nothing for it.
- Local mode ("keep everything on this computer") is a per-device setting. One-click Ollama also turns it on. It switches a cloud embedding provider back to the built-in model, which means re-processing every Document; an embedding provider on this computer, such as Ollama, is kept. It also pauses a reranking service; the built-in reranking model carries on. It doesn't block cloud chat or tagging. Settings tells the User when the chat model still sends Questions to a cloud provider.
- Jev is a closed, hosted model in early access, so nothing may depend on it being configured.
