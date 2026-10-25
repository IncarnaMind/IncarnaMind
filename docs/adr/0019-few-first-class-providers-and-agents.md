---
status: accepted (2026-10-11)
---

# A few providers and agents get first-class support; the rest go through generic routes

The catalog (ADR-0005) holds 13 chat providers plus the ChatGPT plan and Jev, and Settings → Agents (#351) lists 23 outside agents, about a dozen of which IncarnaMind sets up by writing into their own configuration files. Each route we promise carries upkeep that grows with every release. Model ids, prices and quirks change. Errors need plain words. A key guide has to be kept in English and Chinese, the vendor's terms have to be watched, and every AI feature is tried by hand on real providers before it is called done (`AGENTS.md`). An agent's configuration format can change under us at any time. At the same time, a User who already pays for a plan should be able to start in one click, and a User in mainland China needs a provider that works there.

We support two tiers:

- **First-class providers:** the ChatGPT plan (Sign in with ChatGPT, #122), Anthropic, OpenAI, Google, OpenRouter and Ollama (local models and Ollama's cloud models), and for mainland China DeepSeek, Qwen (Alibaba Cloud Model Studio) and SiliconFlow. They appear in the first-run model setup (#103), each has a plain-words key guide in English and Chinese where a key is needed, and each is tried by hand before a release.
- **Best-effort providers:** Mistral, xAI, Kimi and GLM stay in the catalog and keep working for Users who have their keys, listed under "More providers" in Settings → Models, with no guide of their own and no release check. Any other service is reached as an OpenAI-compatible endpoint (MiniMax, Volcengine, Tencent and the rest), or through OpenRouter and SiliconFlow, which reach most models with one account.
- **First-class agents:** the Claude desktop app (every plan, Free included), Claude Code, the ChatGPT desktop app and Codex (one configuration; the ChatGPT app reaches local servers in its Work and Codex modes), Cursor, and Antigravity (the route for Google AI Pro and Ultra subscribers, since Gemini CLI no longer serves those plans' personal accounts); in China, Tencent's WorkBuddy, and the 豆包 desktop app once it has been tried by hand and its data terms read. Each is set up in one click or by IncarnaMind and tried before a release. Chat apps that only reach servers on the internet (ChatGPT and Claude on the web, Gemini, Le Chat, Grok and others) can't reach IncarnaMind, which serves only this computer.
- **Other agents** connect as "Other agent": IncarnaMind shows a configuration to copy, and no longer writes into their files. Pairings made before this keep working.
- **Plans.** Sign in with ChatGPT, Ollama's and OpenRouter's own sign-in, the Claude desktop app through the agent connection, and an Anthropic API key, with a short note that links to Anthropic's own pages instead of copying its steps. Google AI Pro and Ultra subscribers are pointed to Antigravity, where their plan pays, with only a link to Google's credit page, whose steps (three consoles, a card, prepaid billing) are too many to guide. No presets for coding or token plans.
- **The User's own Claude Code (#385):** unmodified and signed in through its own flow, run by IncarnaMind on the User's Claude plan, as an opt-in.

A provider or agent moves between tiers with a one-line change: a field in the catalog or the agent list. Promote one when Users ask for it; demote one that breaks often or loses its Users.

## Considered options

- **Every provider and agent first-class.** Rejected: the upkeep grows with each one, and most would be tested rarely, so a promise we keep for a few becomes one we break for many.
- **Only aggregators (OpenRouter, SiliconFlow) and the ChatGPT plan.** Rejected: Users with an Anthropic, OpenAI or Google key, often a company key, expect to paste it, and each provider's data terms differ from the aggregator's.
- **Removing the best-effort providers.** Rejected: a catalog row costs little to keep, and Users who set one up would lose it.
- **Presets for the coding and token plans of Chinese vendors.** Rejected: most limit use to coding tools or listed tools, and at the usage of a notebook pay-as-you-go costs less than any of them.

## Consequences

- The catalog gains a support field per provider, and the agent list one per agent. The first-run setup lists only first-class providers. Settings → Models lists first-class ones first and the rest under "More providers". A provider a User already set up shows under their providers whatever its tier.
- `docs/agents/testing.md` names the first-class providers and agents for release checks. The multi-provider rule for AI features stays as it is.
- Settings → Agents shows the first-class agents and "Other agent". The code that writes other agents' configuration files goes, except what Disconnect needs to remove an entry IncarnaMind wrote before.
- A best-effort provider can break for a while before anyone notices. Its errors still reach the User in plain words, and a report moves it up the queue.

## Amendment: experimental sign-in routes

A plan can also be reached through an experimental sign-in route, where the User signs in with their own account. Such a route:

- is opt-in: listed under other ways, off until the User signs in, never preselected or recommended;
- says before sign-in, in three sentences with focus on the safe choice, that the provider may refuse or block it, that the account is the User's own, and that it can be turned off at any time in Settings › Models;
- names the provider in a plain line when it stops working, with a way back to an API key;
- keeps its client profile in its provider's one configuration module, behind one build flag (`EXPERIMENTAL_SIGN_IN_ROUTES`, `src/core/buildFlags.ts`), so every such route leaves the bundle with a one-line change.

## Amendment: plans through a sign-in route

- Under other ways, the User can sign in with a Claude plan or a GitHub Copilot plan, each an experimental sign-in route as the amendment above sets out.
- With either plan, the setup and Settings say that Answers count toward the plan's usage limits.

## Amendment: Add a provider (#179)

- Settings → Models no longer splits the key providers into the first-class ones and "More providers". "Add a provider…" opens a directory of every provider in groups that follow the interface language: Popular, International, China, On this computer and Other in English, and 常用, 中国, 国际, 本机, 其他 in Chinese.
- Popular holds what most Users of that language set up first, whatever its tier: Anthropic, OpenAI, Google, Ollama and OpenRouter in English; DeepSeek, Qwen, Kimi, GLM, SiliconFlow and Ollama in Chinese, where the best-effort Kimi and GLM are among the most used.
- The tiers still decide what the first-run setup offers, which providers have a key guide, and which are tried by hand before a release.

## Amendment: Kimi and GLM on the first-run key form (#1375)

This changes two earlier lines. Consequences says "The first-run setup lists only first-class providers", and the Add a provider amendment says "The tiers still decide what the first-run setup offers". Neither holds now: the first-run key form lists the first-class providers and Kimi and GLM, which the catalog marks with a `firstRun` field.

- **Why.** In mainland China few first-class providers work (DeepSeek, Qwen and SiliconFlow), and Kimi and GLM are among the most used there. A first-run line that left them out sent those Users to Settings to find them.
- **The line.** The first-run key line names the providers that work for the language: DeepSeek, Qwen, Kimi and GLM in Chinese; OpenAI, Anthropic, Google, DeepSeek and Kimi in English. Each named provider opens its key form in one step. The form's row of choices follows the language: in Chinese DeepSeek, Qwen, Kimi and GLM come first.
- **What the tiers still decide.** Which providers have a key guide of their own, and which are tried by hand before a release. Kimi and GLM have neither.
