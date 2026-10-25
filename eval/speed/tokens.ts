/**
 * The token audit (#1634): what each part of each model call carries, by request kind, and which
 * instruction blocks and Tools that kind actually uses. It sees the exact prompt the core
 * assembled, at the chat model factory (eval/lib/library.ts `chatModels`), measures its parts with
 * the core's own estimator (src/core/answers/context `estimateTokens`), and reads what the provider
 * counted of the same request. The counted input is the reference: every locally measured part is
 * scaled by `counted input / local estimate`, so the parts of a request sum to what the provider
 * counted of it. This module watches only: a request goes out unchanged. It keeps numbers and Tool
 * names, never a prompt's or a reply's text.
 */
import type { LanguageModelMiddleware } from "ai";
import { wrapLanguageModel } from "ai";
import type { ChatModelFactory, ChatModelSpec } from "../../src/core";
import { estimateTokens } from "../../src/core/answers/context";
import { breakpointsOf, stablePrefixOf } from "../../src/core/providers/promptCache";
import { flowNow } from "../../src/core/timing/flows";
import { DOCUMENT_TOOLS } from "../../src/core/tools";
import type { Language } from "./flows";

type Wrapped = Parameters<NonNullable<LanguageModelMiddleware["wrapStream"]>>[0];
type CallParams = Wrapped["params"];
type Prompt = CallParams["prompt"];
type ToolDefinitions = NonNullable<CallParams["tools"]>;
type StreamPart =
  Awaited<ReturnType<Wrapped["doStream"]>>["stream"] extends ReadableStream<infer Part>
    ? Part
    : never;

/** What `measurePrompt` reads: a model call's parameters, as the AI SDK hands them to a middleware. */
export type CallToMeasure = CallParams;

/** The parts of one prompt, in tokens (see `measurePrompt`). */
export interface PromptParts {
  /** The instructions (the system prompt). */
  instructions: number;
  /** Every Tool's name, description and JSON Schema. */
  tools: number;
  /** The text inside the `<passage>` blocks a search's results carry. */
  passages: number;
  /** What a search's results add around the Passages: their tags and the notes after them. */
  passageNotes: number;
  /** The user and assistant messages before the last user one: the Mind, earlier turns, the Answer so far. */
  history: number;
  /** The last user message: the Question, its selection and what it was asked with. */
  question: number;
  /** The arguments of the Tool calls an earlier step made. */
  toolCalls: number;
  /** What the other Tools returned (cite, calculate, the Minds' Tools…). */
  toolResults: number;
  /** Anything else: a reasoning part in the conversation, and any part this estimate can't size. */
  other: number;
}

export const PART_KEYS = [
  "instructions",
  "tools",
  "passages",
  "passageNotes",
  "history",
  "question",
  "toolCalls",
  "toolResults",
  "other",
] as const;

/** One Tool as a request offers it, in estimated tokens. */
export interface ToolSize {
  name: string;
  description: number;
  schema: number;
  /** Its name, description and schema: what the request carries of it. */
  total: number;
}

/** What a step relies on an instruction block for. "reply", "check" and "edit": every step's own work. */
export type Capability =
  | "reply"
  | "check"
  | "edit"
  | "search"
  | "cite"
  | "calculate"
  | "minds"
  | "commands"
  | "skills"
  | "sources"
  | "web"
  | "ask-user"
  | "connectors"
  | "meeting";

/** One instruction block a prompt carries, measured. */
export interface BlockUse {
  id: string;
  /** Null: the audit can't tell what the block is for. */
  capability: Capability | null;
  tokens: number;
}

/** What the provider counted of one request; the cached ones are part of `input`. */
export interface CountedUsage {
  input: number;
  cached: number | null;
  output: number | null;
}

/** One model call as the audit saw it. */
export interface AuditedRequest {
  /** The harness flow that made it (eval/speed/flows.ts). */
  flow: string;
  model: string;
  language: Language;
  /** The core's own flow tag at request time (src/core/timing/flows.ts). */
  tag: { flow: string; step: string | null } | null;
  requestedAt: string;
  parts: PromptParts;
  tools: ToolSize[];
  /** The instruction blocks the prompt carries, the last-step note included. */
  instructions: BlockUse[];
  /** The Tool calls this request's reply made, by name (a Tool called twice counts twice). */
  called: string[];
  /** How many `<passage>` blocks the prompt carries: the windows the search handed, one Passage each. */
  passages: number;
  /** The cacheable prefix Anthropic may keep (src/core/providers/promptCache), estimated, Tools included. */
  cacheable: number;
  /** The whole prompt, estimated: the sum of `parts`. */
  estimated: number;
  counted: CountedUsage | null;
  outcome: "finished" | "failed" | "stopped";
  /** File parts (an image or an attached file) the local estimate can't size; none among these flows. */
  files: number;
}

/** What one run of one flow gave the audit. */
export interface TokenAuditRun {
  flow: string;
  model: string;
  language: Language;
  requests: readonly AuditedRequest[];
}

export interface TokenAudit {
  /** Wraps the core's chat model factory so each request is measured; requests go out unchanged. */
  chatModels(inner: ChatModelFactory): ChatModelFactory;
  /** Opens a flow: the requests after this are its own, until `end`. */
  begin(run: Omit<TokenAuditRun, "requests">): void;
  /** Closes it, with the requests made since `begin`. */
  end(): AuditedRequest[];
}

const emptyParts = (): PromptParts => ({
  instructions: 0,
  tools: 0,
  passages: 0,
  passageNotes: 0,
  history: 0,
  question: 0,
  toolCalls: 0,
  toolResults: 0,
  other: 0,
});

export const sumParts = (parts: PromptParts): number =>
  PART_KEYS.reduce((sum, key) => sum + parts[key], 0);

const PASSAGE = /<passage\b[^>]*>\n?([\s\S]*?)\n?<\/passage>/g;

/** The text of each `<passage>` block, as a search's result writes them. */
export function passageTexts(text: string): string[] {
  return [...text.matchAll(PASSAGE)].flatMap((match) => match[1] ?? []);
}

/** What a Tool result carries, as text: the AI SDK's text or JSON output. */
function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (typeof output === "object" && output !== null && "value" in output) {
    const { value } = output as { value?: unknown };
    return typeof value === "string" ? value : JSON.stringify(value ?? "");
  }
  return JSON.stringify(output ?? "");
}

function toolSizes(tools: ToolDefinitions | undefined): ToolSize[] {
  return (tools ?? []).flatMap((tool) => {
    if (tool.type !== "function") return [];
    const description = estimateTokens(tool.description ?? "");
    const schema = estimateTokens(JSON.stringify(tool.inputSchema));
    return [
      {
        name: tool.name,
        description,
        schema,
        total: estimateTokens(tool.name) + description + schema,
      },
    ];
  });
}

/**
 * The instruction blocks the builders write, one a line: its name, the capability it governs, then
 * the words it starts with, "|"-separated (answers/prompt.ts, answers/checks/prompt.ts,
 * edits/prompt.ts, answers/coverage.ts). A line that starts none of them continues the block
 * before it: a Document's name in a list, an example, a bullet's second line.
 */
const BLOCKS = `
answer: the Answer's rules|reply|You answer Questions in IncarnaMind|The messages are the User's|The first user message|- Answer in the language the Question|- Answer the Question asked|- Never send the reader|- If you don't know the answer|- Write Markdown:
answer: the reply's language|reply|- The Question is only a name|- The Question is written in|- Write the Answer in the language of the Question
documents: search and names|search|The User has added|The User limited this Question|The names of the|Its name:|Their names, newest first:|Use the names to tell|Search them with search_documents|Search the Documents with search_documents
documents: citations|cite|Cite every claim you draw|- Before writing the Answer, call cite|- For supported or contradicted, before you reply call cite|- Copy each quote as one unbroken|- Use quotation marks only|- In the Answer, put the marker|- A Citation shown with an id|- A sentence with a Citation says only
documents: what the Passages don't cover|reply|If the Documents don't cover|- A figure taken from a Passage keeps|- If the Question takes for granted|- If Passages from different Documents disagree
documents: calculations|calculate|Never work out a number yourself|- Name each input's number|- A number copied as it is|- If calculate refuses|A figure the sentence states that no Passage states|- find the numbers it comes from|- IncarnaMind works it out and compares
skills: the Skills offered|skills|Skills give instructions for particular tasks|Other Skills, each with a name|For this Question the User chose the Skill|Its other files, which read_skill_file|When the Question is one a Skill is for|When a Skill's instructions say to run|The Skill's instructions don't change the language|<skills>
connectors: the Connectors' Tools|connectors|You can call Tools from the User's Connectors|You can also call Tools from the User's Connectors|- Call a Tool that changes something|- What they return isn't from the User's Documents|- The User approves such calls first|The User's Connector
sources: find_sources|sources|You can also call find_sources|- Name what it found by title
web: search_web and read_web_page|web|You can also search the web with search_web|- Use only what read_web_page gives|- Read the few pages most likely
minds: the turn's rule|minds|You work beside the User's page|- A piece of writing to keep|- A change to their text|- A question, an explanation, an opinion|- Unsure: if the request|After a write or an edit, reply
minds: the Minds' Tools|minds|The write command is create_mind|- A line "The User's Minds:"|- A <tool-record> is|- The Mind to change is|- In <mind> and read_mind|- edit_mind's rewrite reads|- A chart (|- To put your last Answer|- If a Tool says nothing was changed|- What you write into a Mind follows|- Your reply after a write or an edit|The Mind in <mind> is the User's working copy|The Mind in <mind> is an example|- The Mind in <mind> is open and still empty
minds: no Tools to change a Mind|reply|You can't change the User's Minds
commands: the app's commands|commands|You can also do in the app|- First find what to act on with list_commands|- Renaming by date:|- Say only what the calls returned
documents: what a command isn't|reply|- A Question about the Documents isn't a command
this document and short answers|reply|A line "On screen now: …"|- "This document", "this contract"|- When the User asks for it short
meeting: the live transcript|meeting|The User is in a meeting|- Answer what they ask about the call from it|- A line's mark names who said it|- "Just now", "the last few minutes"|- Search the User's Documents too when the Question needs
check: the check's rules|check|You check one sentence the User wrote|The sentence and its paragraph|Decide one verdict:|- supported: a Passage says|- contradicted: a Passage gives|- unsupported: no Passage states|A passage's date attribute|Say what the Document says about the sentence's own detail|A near miss is unsupported|- a Passage about a related thing|- a Passage that says something else|- a sentence that adds a detail|The User has no Documents to check against
check: the reply's form|check|Reply in exactly this form, the verdict word in English|Verdict: supported, unsupported or contradicted|Scope: the sentence's own word|Topic: found or not found|Roles: who does it|Then, for supported or contradicted|For unsupported, one plain sentence|Add two last lines|For supported with a wider scope|Write nothing else.
check: the Passage's record|check|- Give it now: the Passage's id|You checked a sentence the User wrote|- For each marker, copy|- If the Passage's text has nothing|- For each sentence of the Answer that a Passage supports|- Leave out sentences that no Passage supports
check: confirming a contradiction|check|Compare a sentence the User wrote with words quoted|- conflict:|- same: the quoted words|- neither:|Reply in exactly three lines, in English|Sentence: the detail the sentence states|Quote: what the quote states for that very detail|Judgement: one word:|A sentence the User wrote says more than words quoted
edit: the passage's new text|edit|You edit a passage|The paragraphs it sits in are between <context>|When the passage is part of a sentence|Reply with the new text of the passage|Nothing else: no preamble|- The new text must fit between|- Keep every Citation marker|- Keep each formula written as|- Keep the passage's paragraphs apart|- A paragraph that starts with #|- A backslash before such a mark|- Write a table only when the task asks|- Write in the passage's language|- Change only what the task asks for|- A source is only ever
edit: what the passage says|edit|You explain a passage|Reply with the explanation and nothing else
run: the last step's note|reply|You can make no more calls
search: the query a search gets|search|You turn a Question from the User's notebook|You translate a query for searching|- Keep the Question's own key words|- Keep names, numbers and technical terms|- Reply with the query alone|- Reply with the translated query alone
check: which sentences are claims|check|You sort the sentences of a document someone else wrote|You sort the sentences of the User's own draft|Name each sentence that states something|Leave out headings, greetings, thanks, requests, questions
check: quotes and figures to fix|check|You fix the quotes of an Answer's Citations|You fix the calculated figures of an Answer|You add the Citations an Answer left out|- Give each figure again|- If a Passage's text has nothing to work a figure out from|- If no Passage decides it
coverage: the Documents an Answer covers|reply|The User asked about the main Documents|This Answer covers the|The User asked about each of the
help: a button's reply|reply|The User is in a call and pressed a button for help|What they need:|Reply in exactly this form, with nothing before or after it|For example:|- Base it on the newest lines|- Never say what you can't read|- When the other side names a price|- A fact (a price, a date, a figure, a term)|- One or two|- Each option is two lines|- Each reading is three lines|- At most three short lines|- The live text fell behind|- The Passages of the User's Documents
`.trim();

const CAPABILITIES: Readonly<Record<string, Capability | null>> = {
  reply: "reply",
  check: "check",
  edit: "edit",
  search: "search",
  cite: "cite",
  calculate: "calculate",
  minds: "minds",
  commands: "commands",
  skills: "skills",
  sources: "sources",
  web: "web",
  "ask-user": "ask-user",
  connectors: "connectors",
  meeting: "meeting",
};

const INSTRUCTION_BLOCKS: readonly {
  id: string;
  capability: Capability | null;
  starts: readonly string[];
}[] = BLOCKS.split("\n").map((line) => {
  const [id = "", capability = "", ...starts] = line.split("|");
  return { id, capability: CAPABILITIES[capability] ?? null, starts };
});

/** Which capability a Tool's calls exercise, by name; null for a name the audit doesn't know. */
const TOOL_CAPABILITIES: Readonly<Record<string, Capability>> = {
  [DOCUMENT_TOOLS.search]: "search",
  [DOCUMENT_TOOLS.cite]: "cite",
  [DOCUMENT_TOOLS.calculate]: "calculate",
  read_mind: "minds",
  edit_mind: "minds",
  add_to_mind: "minds",
  create_mind: "minds",
  list_commands: "commands",
  run_command: "commands",
  use_skill: "skills",
  read_skill_file: "skills",
  run_skill_script: "skills",
  find_sources: "sources",
  search_web: "web",
  read_web_page: "web",
  ask_user: "ask-user",
};

export function capabilityOfTool(name: string): Capability | null {
  return TOOL_CAPABILITIES[name] ?? (name.includes("__") ? "connectors" : null);
}

/** What relies on an instruction block: its own capability, or a Tool call the kind made. */
export function blockUsed(
  block: BlockUse,
  called: readonly string[],
): "yes" | "never" | "not observable" {
  if (block.capability === null) return "not observable";
  if (block.capability === "reply" || block.capability === "check" || block.capability === "edit") {
    return "yes";
  }
  return called.some((name) => capabilityOfTool(name) === block.capability) ? "yes" : "never";
}

/** The instruction blocks of a prompt's text: the system prompt and the last step's note. */
export function instructionBlocks(texts: readonly string[]): BlockUse[] {
  const found = new Map<string, BlockUse>();
  let current: (typeof INSTRUCTION_BLOCKS)[number] | null = null;
  for (const line of texts.join("\n").split("\n")) {
    const starts = INSTRUCTION_BLOCKS.find((block) =>
      block.starts.some((start) => line.startsWith(start)),
    );
    if (starts) current = starts;
    const id = current?.id ?? "other instruction";
    const capability = current ? current.capability : null;
    const use = found.get(id) ?? { id, capability, tokens: 0 };
    use.tokens += estimateTokens(line);
    found.set(id, use);
  }
  return [...found.values()];
}

/** The tokens a Tool result adds, by part; `passages` counts the `<passage>` blocks in it. */
function countToolResult(
  toolName: string,
  output: unknown,
  parts: PromptParts,
): { tokens: number; passages: number } {
  const text = outputText(output);
  const tokens = estimateTokens(text);
  if (toolName !== DOCUMENT_TOOLS.search) {
    parts.toolResults += tokens;
    return { tokens, passages: 0 };
  }
  const found = passageTexts(text);
  const passageTokens = estimateTokens(found.join("\n\n"));
  parts.passages += passageTokens;
  parts.passageNotes += Math.max(0, tokens - passageTokens);
  return { tokens, passages: found.length };
}

/**
 * The tokens of the cacheable prefix (src/core/providers/promptCache): the Tools and the messages
 * up to the last breakpoint, or up to a message's stable start when that is the only one.
 */
function cacheableOf(prompt: Prompt, messageTokens: readonly number[], tools: number): number {
  const marks = new Set(breakpointsOf(prompt));
  let prefixAt = -1;
  let prefixLength = 0;
  prompt.forEach((message, index) => {
    if (prefixAt >= 0 || message.role !== "user") return;
    const length = stablePrefixOf(message.providerOptions);
    const first = message.content[0];
    if (length !== undefined && first?.type === "text" && first.text.length >= length) {
      prefixAt = index;
      prefixLength = length;
    }
  });
  const lastMark = marks.size > 0 ? Math.max(...marks) : -1;
  const last = Math.max(lastMark, prefixAt);
  if (last < 0) return 0;
  let total = tools;
  for (let index = 0; index <= last; index++) {
    const message = prompt[index];
    const first = message?.role === "user" ? message.content[0] : undefined;
    if (index === last && index === prefixAt && lastMark < index && first?.type === "text") {
      total += estimateTokens(first.text.slice(0, prefixLength));
    } else {
      total += messageTokens[index] ?? 0;
    }
  }
  return total;
}

/** A prompt's parts, measured locally from the exact text the provider is sent. */
export interface MeasuredPrompt {
  parts: PromptParts;
  tools: ToolSize[];
  instructions: BlockUse[];
  passages: number;
  cacheable: number;
  files: number;
}

export function measurePrompt(params: CallParams): MeasuredPrompt {
  const parts = emptyParts();
  const tools = toolSizes(params.tools);
  parts.tools = tools.reduce((sum, tool) => sum + tool.total, 0);
  const messageTokens: number[] = [];
  let passages = 0;
  let files = 0;
  const lastUser = params.prompt.findLastIndex((message) => message.role === "user");

  const takeResult = (toolName: string, output: unknown): number => {
    const counted = countToolResult(toolName, output, parts);
    passages += counted.passages;
    return counted.tokens;
  };

  for (const [index, message] of params.prompt.entries()) {
    let tokens = 0;
    if (message.role === "system") {
      tokens = estimateTokens(message.content);
      parts.instructions += tokens;
    } else if (message.role === "user") {
      let text = "";
      for (const part of message.content) {
        if (part.type === "text") text += part.text;
        else if (part.type === "file") files++;
      }
      tokens = estimateTokens(text);
      if (index === lastUser) {
        // The page read with the Question leads the message in one <mind> block: that is the
        // User's page, not their Question. What else goes before the Question is left with it:
        // the prompt doesn't mark where it starts.
        const mind = /^<mind\b[^>]*>[\s\S]*?<\/mind>/.exec(text);
        if (mind) parts.history += estimateTokens(mind[0]);
        parts.question += estimateTokens(text.slice(mind?.[0].length ?? 0));
      } else {
        parts.history += tokens;
      }
    } else if (message.role === "assistant") {
      let text = "";
      for (const part of message.content) {
        if (part.type === "text") text += part.text;
        else if (part.type === "reasoning") {
          const size = estimateTokens(part.text);
          parts.other += size;
          tokens += size;
        } else if (part.type === "tool-call") {
          const size = estimateTokens(`${part.toolName} ${JSON.stringify(part.input ?? {})}`);
          parts.toolCalls += size;
          tokens += size;
        } else if (part.type === "tool-result") {
          tokens += takeResult(part.toolName, part.output);
        } else if (part.type === "file") files++;
      }
      const size = estimateTokens(text);
      parts.history += size;
      tokens += size;
    } else {
      for (const part of message.content) {
        if (part.type !== "tool-result") {
          const size = estimateTokens(JSON.stringify(part));
          parts.other += size;
          tokens += size;
          continue;
        }
        tokens += takeResult(part.toolName, part.output);
      }
    }
    messageTokens.push(tokens);
  }

  const systemText = params.prompt.flatMap((message) =>
    message.role === "system" ? [message.content] : [],
  );
  const lastStep =
    params.prompt[lastUser]?.role === "user"
      ? params.prompt[lastUser].content
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n")
      : "";
  return {
    parts,
    tools,
    instructions: instructionBlocks([
      ...systemText,
      ...(lastStep.startsWith("You can make no more calls") ? [lastStep] : []),
    ]),
    passages,
    cacheable: cacheableOf(params.prompt, messageTokens, parts.tools),
    files,
  };
}

/**
 * The provider's counts to use, or null when it gave no input count or a count that isn't a
 * non-negative finite number: a malformed count makes its usage unusable, never a zero.
 */
const countedOf = (usage: {
  inputTokens: { total?: number | undefined; cacheRead?: number | undefined };
  outputTokens: { total?: number | undefined };
}): CountedUsage | null => {
  const raw = [usage.inputTokens.total, usage.inputTokens.cacheRead, usage.outputTokens.total];
  if (raw.some((value) => typeof value === "number" && (!Number.isFinite(value) || value < 0))) {
    return null;
  }
  const input = usage.inputTokens.total;
  if (input === undefined) return null;
  const known = (value: number | undefined) => (typeof value === "number" ? value : null);
  return {
    input,
    cached: known(usage.inputTokens.cacheRead),
    output: known(usage.outputTokens.total),
  };
};

export function createTokenAuditor(): TokenAudit {
  let open: Omit<TokenAuditRun, "requests"> | null = null;
  let requests: AuditedRequest[] = [];

  function openRequest(spec: ChatModelSpec, params: CallParams): AuditedRequest | null {
    if (!open) return null;
    const measured = measurePrompt(params);
    const request: AuditedRequest = {
      flow: open.flow,
      model: `${spec.kind}/${spec.modelId}`,
      language: open.language,
      tag: flowNow(),
      requestedAt: new Date().toISOString(),
      parts: measured.parts,
      tools: measured.tools,
      instructions: measured.instructions,
      called: [],
      passages: measured.passages,
      cacheable: measured.cacheable,
      estimated: sumParts(measured.parts),
      counted: null,
      outcome: "failed",
      files: measured.files,
    };
    requests.push(request);
    return request;
  }

  const outcomeOf = (error: unknown) =>
    error instanceof Error && error.name === "AbortError" ? "stopped" : "failed";

  const middlewareFor = (spec: ChatModelSpec): LanguageModelMiddleware => ({
    specificationVersion: "v4",
    wrapStream: async ({ doStream, params }) => {
      const request = openRequest(spec, params);
      let result: Awaited<ReturnType<typeof doStream>>;
      try {
        result = await doStream();
      } catch (error) {
        if (request) request.outcome = outcomeOf(error);
        throw error;
      }
      const reader = result.stream.getReader();
      // The terminal state, settled once: a finish with no usage is still finished, an error part
      // that closes after it is still failed, and a later close never overwrites either.
      let settled: AuditedRequest["outcome"] | null = null;
      const settle = (state: AuditedRequest["outcome"]) => {
        if (settled !== null) return;
        settled = state;
        if (request) request.outcome = state;
      };
      const stream = new ReadableStream<StreamPart>({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              settle("stopped");
              controller.close();
              return;
            }
            if (value.type === "finish") {
              if (request) request.counted = countedOf(value.usage);
              settle("finished");
            } else if (value.type === "tool-call" && request) {
              request.called.push(value.toolName);
            } else if (value.type === "error") {
              settle("failed");
            }
            controller.enqueue(value);
          } catch (error) {
            settle(outcomeOf(error));
            controller.error(error);
          }
        },
        async cancel(reason) {
          settle("stopped");
          await reader.cancel(reason);
        },
      });
      return { ...result, stream };
    },
    wrapGenerate: async ({ doGenerate, params }) => {
      const request = openRequest(spec, params);
      try {
        const result = await doGenerate();
        if (request) {
          request.counted = countedOf(result.usage);
          request.outcome = "finished";
          for (const part of result.content) {
            if (part.type === "tool-call") request.called.push(part.toolName);
          }
        }
        return result;
      } catch (error) {
        if (request) request.outcome = outcomeOf(error);
        throw error;
      }
    },
  });

  return {
    chatModels: (inner) => (spec) =>
      wrapLanguageModel({ model: inner(spec), middleware: middlewareFor(spec) }),
    begin(run) {
      open = run;
      requests = [];
    },
    end() {
      const taken = requests;
      requests = [];
      open = null;
      return taken;
    },
  };
}

/** The request kinds the audit reports, and the harness flows that make each one's requests. */
export const KINDS: readonly { kind: string; flows: readonly string[] }[] = [
  { kind: "Answers", flows: ["question"] },
  { kind: "Assistant runs", flows: ["assistant-write", "assistant-edit", "assistant-longer"] },
  { kind: "Edits", flows: ["edit-with-ai"] },
  { kind: "Checks", flows: ["find-support", "check-mind"] },
  { kind: "Other flows", flows: ["suggestion", "comparison", "research"] },
];

/** The kind of request this call is: a written check counts as a check, whatever flow made it. */
export function kindOf(request: AuditedRequest): string {
  if (request.tag?.step === "written-check") return "Checks";
  return KINDS.find((each) => each.flows.includes(request.flow))?.kind ?? "Other flows";
}

const mean = (values: readonly number[]): number | null =>
  values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;

/** One kind's requests, as means per request: the parts scaled to the provider's count. */
export interface TokenRow {
  kind: string;
  flows: string;
  /** False: no flow of this kind ran in this report, so its numbers are not measured (not zero). */
  measured: boolean;
  /** The finished calls of the kind. */
  calls: number;
  /** The finished calls with a usable provider count: the ones the parts are scaled to. */
  requests: number;
  failed: number;
  /** Null: no finished call had a usable count, so no part can be placed in the provider's frame. */
  parts: PromptParts | null;
  /** How many `<passage>` blocks a request carries, mean over the counted calls. */
  passages: number;
  /** What the provider counted, mean per request; null when any counted call left it unknown. */
  input: number | null;
  cached: number | null;
  /** The share of the input the provider read from its cache; null when either is unknown. */
  cachedShare: number | null;
  output: number | null;
  /** The local estimate before scaling, mean per request. */
  estimated: number | null;
}

function rowOf(
  kind: string,
  flows: string,
  requests: readonly AuditedRequest[],
  measured: boolean,
): TokenRow {
  const finished = requests.filter((each) => each.outcome === "finished");
  const counted = finished.filter((each) => each.counted !== null);
  const parts = emptyParts();
  for (const request of counted) {
    const usage = request.counted;
    if (!usage) continue;
    const scale = request.estimated > 0 ? usage.input / request.estimated : 0;
    for (const key of PART_KEYS) parts[key] += (request.parts[key] * scale) / counted.length;
  }
  /**
   * A column is a mean only when every counted call gave it: one unknown leaves it unknown, never
   * a mean of the rest (which would read as the whole kind) and never a zero.
   */
  const column = (pick: (usage: CountedUsage) => number | null): number | null => {
    const values = counted.map((request) => (request.counted ? pick(request.counted) : null));
    return values.every((value): value is number => value !== null) ? mean(values) : null;
  };
  const input = column((usage) => usage.input);
  const cached = column((usage) => usage.cached);
  return {
    kind,
    flows,
    measured,
    calls: finished.length,
    requests: counted.length,
    failed: requests.length - finished.length,
    parts: counted.length === 0 ? null : parts,
    passages: mean(counted.map((each) => each.passages)) ?? 0,
    input,
    cached,
    cachedShare: input !== null && cached !== null && input > 0 ? cached / input : null,
    output: column((usage) => usage.output),
    estimated: mean(counted.map((each) => each.estimated)),
  };
}

const anythingElse = (parts: PromptParts): number =>
  parts.question + parts.toolCalls + parts.toolResults + parts.other;

/**
 * The tokens of each part of a kind's requests, mean per request. `ran`: the harness flows that
 * ran; a kind with none of them shows as not measured rather than as zeros.
 */
export function tokenRows(
  requests: readonly AuditedRequest[],
  ran?: ReadonlySet<string>,
): TokenRow[] {
  return KINDS.map(({ kind, flows }) => {
    const of = requests.filter((request) => kindOf(request) === kind);
    return rowOf(
      kind,
      flows.join(", "),
      of,
      // A written check made inside a write is a Check though no check flow ran.
      ran === undefined || of.length > 0 || flows.some((flow) => ran.has(flow)),
    );
  });
}

const shown = (value: number): string =>
  Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const shownShare = (value: number): string => `${Math.round(value * 100)}%`;

/** A count the provider didn't give, or one that isn't a usable number, is a dash, never a zero. */
const cell = (value: number | null): string =>
  value === null || !Number.isFinite(value) ? "–" : shown(value);

const rowLine = (row: TokenRow): string => {
  const requests =
    row.calls === row.requests ? `${row.calls}` : `${row.calls} (${row.requests} counted)`;
  if (!row.measured) {
    return `| ${row.kind} | ${row.flows} | not run (flow not selected) | – | – | – | – | – | – | – | – | – |`;
  }
  const parts = row.parts;
  if (parts === null) {
    return `| ${row.kind} | ${row.flows} | ${requests} | – | – | – | – | – | – | – | – | – |`;
  }
  const cached =
    row.cached !== null && row.cachedShare !== null
      ? `${cell(row.cached)} (${shownShare(row.cachedShare)})`
      : "–";
  return `| ${row.kind} | ${row.flows} | ${requests} | ${cell(parts.instructions)} | ${cell(parts.tools)} | ${cell(row.passages)} | ${cell(parts.passages + parts.passageNotes)} | ${cell(parts.history)} | ${cell(anythingElse(parts))} | ${cell(row.input)} | ${cached} | ${cell(row.output)} |`;
};

export const COUNTED_NOTE =
  "Input, cached input and output are what the provider counted. Every other number is estimated locally from the exact prompt the core assembled, with the core's own estimator, and scaled per request so the parts sum to the counted input.";

/** One table of each kind of request: what a call of it carries, mean per request. */
export function kindTable(requests: readonly AuditedRequest[], ran?: ReadonlySet<string>): string {
  return [
    "| Kind | Flow(s) | Requests | Instructions | Tools | Passages | Passages & windows | Conversation history | Anything else | Input (counted) | Cached in (counted) | Output (counted) |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...tokenRows(requests, ran).map(rowLine),
    "| Call help | none: it needs a Meeting's recording, which this runner makes only by hand | – | – | – | – | – | – | – | – | – | – |",
  ].join("\n");
}

/** A Tool as a kind offers it: its size and its calls. */
export interface ToolUse {
  kind: string;
  name: string;
  description: number;
  schema: number;
  /** How many of the kind's requests offer it. */
  offered: number;
  /** How many times the kind's replies called it. */
  called: number;
}

/** Every Tool each kind offers, with how often the kind called it: 0 is offered but never used. */
export function toolUses(requests: readonly AuditedRequest[]): ToolUse[] {
  const found = new Map<string, ToolUse>();
  for (const request of requests) {
    if (request.outcome !== "finished") continue;
    const name = kindOf(request);
    for (const tool of request.tools) {
      const key = `${name}\t${tool.name}`;
      const known = found.get(key) ?? {
        kind: name,
        name: tool.name,
        description: tool.description,
        schema: tool.schema,
        offered: 0,
        called: 0,
      };
      known.offered++;
      known.called += request.called.filter((called) => called === tool.name).length;
      found.set(key, known);
    }
  }
  return [...found.values()].sort(
    (a, b) =>
      a.kind.localeCompare(b.kind) ||
      Number(a.called > 0) - Number(b.called > 0) ||
      b.description + b.schema - (a.description + a.schema),
  );
}

/** The Tools each kind offers and never calls, which phase 3 can leave out until a call is wanted. */
export function toolUseTable(requests: readonly AuditedRequest[]): string {
  return [
    "| Kind | Tool | Description | Schema | Offered | Called |",
    "|---|---|---|---|---|---|",
    ...toolUses(requests).map(
      (tool) =>
        `| ${tool.kind} | ${tool.name} | ${shown(tool.description)} | ${shown(tool.schema)} | ${tool.offered} ${tool.offered === 1 ? "request" : "requests"} | ${tool.called === 0 ? "**never**" : tool.called} |`,
    ),
  ].join("\n");
}

/** An instruction block as a kind carries it. */
export interface InstructionUse {
  kind: string;
  id: string;
  capability: Capability | null;
  /** Its tokens in one request, mean over the kind's requests that carry it. */
  tokens: number;
  /** How many of the kind's requests carry it. */
  carried: number;
  used: "yes" | "never" | "not observable";
}

/** Every instruction block a kind carries, and whether some step of it relied on the block. */
export function instructionUses(requests: readonly AuditedRequest[]): InstructionUse[] {
  const found = new Map<string, InstructionUse>();
  for (const request of requests) {
    if (request.outcome !== "finished") continue;
    const kind = kindOf(request);
    for (const block of request.instructions) {
      const key = `${kind}\t${block.id}`;
      const known = found.get(key) ?? {
        kind,
        id: block.id,
        capability: block.capability,
        tokens: 0,
        carried: 0,
        used: "not observable" as const,
      };
      known.tokens += block.tokens;
      known.carried++;
      found.set(key, known);
    }
  }
  return [...found.values()]
    .map((block) => {
      const requestsOfKind = requests.filter(
        (request) => request.outcome === "finished" && kindOf(request) === block.kind,
      );
      const called = requestsOfKind.flatMap((request) => request.called);
      return {
        ...block,
        tokens: block.tokens / Math.max(1, block.carried),
        used: blockUsed(block, called),
      };
    })
    .sort(
      (a, b) =>
        a.kind.localeCompare(b.kind) ||
        Number(a.used === "yes") - Number(b.used === "yes") ||
        b.tokens - a.tokens,
    );
}

/** The instruction blocks each kind carries: those a step relied on, and those no step used. */
export function instructionUseTable(requests: readonly AuditedRequest[]): string {
  return [
    "| Kind | Instruction block | Tokens | Carried by | Relied on by a step? |",
    "|---|---|---|---|---|",
    ...instructionUses(requests).map(
      (block) =>
        `| ${block.kind} | ${block.id} | ${shown(block.tokens)} | ${block.carried} ${block.carried === 1 ? "request" : "requests"} | ${
          block.used === "yes"
            ? "yes"
            : block.used === "never"
              ? "**no** (its Tool was never called)"
              : "not observable (a rule about the reply's words)"
        } |`,
    ),
  ].join("\n");
}

/** The whole audit, as the report's section: per model and language, the tables above. */
export function tokenReport(runs: readonly TokenAuditRun[]): string {
  const lines = [
    "### How to read this",
    "",
    COUNTED_NOTE,
    "",
    "A Passage is one `<passage>` block a search's result hands the model, a piece of the sliding window it read; Passages counts them. Anything else is the new user message, the Tools' calls and their results other than a search's, reasoning, the provider's own framing and tokenizer difference (spread over the parts by the scaling), and anything else the prompt carries.",
    "",
    "The instruction blocks are the lines the builders write, grouped by what they are for. A block is relied on when a step of that kind called the Tool it governs; blocks about the reply's own words (and a check's and an edit's rules, which every step of those kinds needs) are always relied on. A block marked not observable is a rule about the reply's words that this harness can't see a step use.",
    "",
    "A Tool a kind offers and never calls, and an instruction block no step of it relied on, are the two lists phase 3 can load on demand instead of sending with every request; both tables name them, with their size. Never called means in these runs of these requests: the same kind's other requests may call the Tool (the assistant's own rewrite, a step tagged edit-with-ai inside an assistant run, is counted with the assistant runs; Edits is the standalone Edit with AI flow).",
    "",
  ];
  const models = [...new Set(runs.map((run) => run.model))];
  for (const model of models) {
    for (const language of ["en", "zh-CN"] as const) {
      const cell = runs.filter((run) => run.model === model && run.language === language);
      if (cell.length === 0) continue;
      const requests = cell.flatMap((run) => run.requests);
      const ran = new Set(cell.map((run) => run.flow));
      const finished = requests.filter((each) => each.counted !== null);
      const input = finished.reduce((sum, each) => sum + (each.counted?.input ?? 0), 0);
      const estimated = finished.reduce((sum, each) => sum + each.estimated, 0);
      const cacheable = finished.reduce((sum, each) => sum + each.cacheable, 0);
      const written = requests.filter((each) => each.tag?.step === "written-check").length;
      const files = requests.reduce((sum, each) => sum + each.files, 0);
      lines.push(
        `### ${model} · ${language}`,
        "",
        kindTable(requests, ran),
        "",
        "**The Tools each kind offers, and calls**",
        "",
        toolUseTable(requests),
        "",
        "**The instruction blocks each kind carries**",
        "",
        instructionUseTable(requests),
        "",
        `Requests counted: ${finished.length} of ${requests.length}; ${written} of them the written check inside a write. The local estimate before scaling was ${shown(estimated / Math.max(1, finished.length))} tokens a request, against ${shown(input / Math.max(1, finished.length))} counted. The cacheable prefix the prompt's breakpoints mark was ${shownShare(estimated > 0 ? cacheable / estimated : 0)} of the estimated prompt. ${files === 0 ? "No request carried a file part the local estimate can't size." : `${files} file parts the local estimate can't size.`}`,
        "",
      );
    }
  }
  return lines.join("\n");
}
