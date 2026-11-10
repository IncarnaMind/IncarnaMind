import { describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import {
  CONTENT_SCHEMA_VERSION,
  CONTENT_SCHEMA_VERSION_KEY,
  type Core,
  MIND_SETTINGS_FIELD,
  type WrittenCheckProgress,
} from "../../src/core";
import { OLLAMA_CLOUD } from "../../src/core/providers/ollamaCloud";
import { reasonText } from "../../src/renderer/src/cost";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { claimCheckShown } from "../../src/shared/claimChecks";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";
import { INLINE_NODE } from "../../src/shared/sentences";
import { askAssistant, changesIn, lastResult } from "../helpers/assistant";
import {
  checkGenerate,
  checkReply,
  isCheckRun,
  type Plan,
  sentenceOf,
  unsupportedReply,
} from "../helpers/checks";
import { answerEnded, shownPassages } from "../helpers/citations";
import {
  createMemoryKeychain,
  createTempDataFolder,
  type MemoryKeychain,
  queryDatabase,
  startCore,
} from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind, type MindClient, typeInto } from "../helpers/mindClient";
import { editMind, readMind, resolveChanges, shownWithChanges, writeMind } from "../helpers/minds";
import {
  type GenerateCall,
  type GeneratedReply,
  judgesNothing,
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";
import { buildPdf } from "../helpers/pdf";

/**
 * What the assistant writes into a Mind is checked once it lands, and the reply doesn't wait for
 * it (#1111, #2830): every sentence a check reads, cited or not, is checked as Check this Note
 * checks it, past twelve; each shows as being checked until its mark lands; a sentence its
 * Citations don't support, or one that couldn't be checked, lands marked, never cut; Stop on the
 * Note's badge and an Undo of the write end the check, a new message doesn't; and words the User
 * types meanwhile stay. The model's verdicts are scripted; Claude Haiku's were tried by hand.
 */

const MOON = "Spring tides come at new and full moon.";
const OVERSTATED = "Spring tides come at new and full moon, and they flood the harbour every year";
const UNBACKED = "Neap tides are twice as strong";
const FAILING = "The harbour floods at every spring tide";
const RECORD_SOURCE = "ECF No. 41 at 3 states the deadline";
const RECORD_NEXT = "Id. at 2 states another deadline";
const TWO_CITED_ZH = "公司营收增长了5%[^1]，所有地区成本都大幅下降[^1]。";

/** A sentence as a check reads it: the Citation after its words as U+FFFC. */
const asChecked = (words: string) => `${words} ${INLINE_NODE}.`;

const RAW_PLANS: Record<string, Plan> = {
  [asChecked(OVERSTATED)]: {
    reply: {
      text: "Verdict: unsupported\nNo Passage says the harbour floods every year.\nCovered: when spring tides come\nNot covered: the yearly floods",
    },
  },
  [asChecked(UNBACKED)]: {
    reply: { text: "Verdict: unsupported\nNo Passage compares the strength of the tides." },
  },
  [asChecked(FAILING)]: { reply: { error: { status: 500, message: "The service broke." } } },
  // Its 5% is a figure, which the check asks about one by one.
  [TWO_CITED_ZH.replaceAll("[^1]", INLINE_NODE)]: {
    reply: (call) => ({
      text: unsupportedReply(
        call,
        "没有段落说两个数字都成立。\nCovered: 增长与成本\nNot covered: 两个数字",
      ),
    }),
  },
  [asChecked("Spring tides come at new and full moon")]: {
    verdict: "supported",
    quote: MOON,
    says: MOON,
  },
  [asChecked(RECORD_SOURCE)]: { verdict: "unsupported", judgement: "same" },
  [asChecked(RECORD_NEXT)]: { verdict: "unsupported", judgement: "same" },
  [`${RECORD_SOURCE}.`]: { verdict: "unsupported", judgement: "same" },
  [`${RECORD_NEXT}.`]: { verdict: "unsupported", judgement: "same" },
};

const PLANS: Record<string, Plan> = Object.fromEntries(
  Object.entries(RAW_PLANS).map(([text, plan]) => [text.replaceAll(INLINE_NODE, ""), plan]),
);

/** Edit with AI's request to cut what a sentence's Citations don't support: a write's check never sends one now. */
const CUT = /<task action="cut-unsupported">/;

/** What the model reads once its write's check has begun: it is told to say nothing of it. */
const CHECKED_AFTER = "IncarnaMind checks these sentences against the Documents itself";

interface Writing {
  content: string;
  /** Into the Mind in focus, after its text, rather than a new one. */
  into?: boolean;
  /** Runs while the first check waits for its reply. */
  during?: () => Promise<void>;
  /** A check's reply in place of `PLANS`', given the core; null: `PLANS`'. */
  check?: (call: ModelCall, core: Core) => ScriptedReply | null;
  /** A model on a service, not on this computer. */
  cloud?: { kind: "anthropic"; modelId: string } | { kind: "ollama"; modelId: string };
  /** How the Answer ends. */
  ends?: "finished" | "failed";
  record?: { name: string; contents: string | Uint8Array; quote: string; query: string };
  /** Hears each request that isn't streamed, answered as `PLANS` says. */
  generated?: (call: GenerateCall) => void;
  /** It writes before it cites: `cite` comes beside the write, after it, or in the step after. */
  citesAfter?: "beside" | "next-step";
  /** Its closing reply fails, so the Answer does. */
  replyFails?: boolean;
  /** Into a Note with no title and no text yet, which takes its name from what lands. */
  untitled?: boolean;
  /** A request that isn't streamed answered as this says; null: as `PLANS` says. */
  generate?: (call: GenerateCall) => GeneratedReply | null;
  /** Ends the claims sort, in place of its time limit. */
  sortTimeLimit?: () => AbortSignal;
  /** Hears the model call its writing Tool. */
  writes?: () => void;
}

const RECORD_FILE: NonNullable<Writing["record"]> = {
  name: "ECF No. 41.pdf",
  contents: buildPdf([
    { lines: ["Introduction"] },
    { lines: ["Second page", "Another deadline"] },
    { lines: ["Trial briefs", "Trial briefs are due September 2"] },
  ]),
  quote: "Trial briefs are due September 2",
  query: "Trial briefs",
};

/** A model that searches, cites the moon line, writes `content`, and replies; and checks a sentence as `PLANS` says. */
function writingModel(
  {
    content,
    into = false,
    during,
    check,
    record,
    generated,
    generate,
    citesAfter,
    replyFails = false,
    writes,
  }: Writing,
  calls: ModelCall[],
  coreOf: () => Core | null,
) {
  let waited: Promise<void> | null = null;
  const heardWrite = writes;
  const tool = into ? "add_to_mind" : "create_mind";
  return scriptedModel(
    (call): ScriptedReply => {
      calls.push(call);
      if (isCheckRun(call)) {
        const core = coreOf();
        const reply = (check && core && check(call, core)) || checkReply(call, PLANS);
        if (!during || waited || "error" in reply) return reply;
        waited = during();
        return { ...reply, pause: { after: 0, until: waited } };
      }
      const { results } = call;
      const search = results.find((result) => result.tool === "search_documents");
      if (!search)
        return {
          calls: [{ tool: "search_documents", input: { query: record?.query ?? "spring tides" } }],
        };
      const cited = results.some((result) => result.tool === "cite");
      const writes = results.filter((result) => result.tool === tool);
      if (!cited) {
        const [passage] = shownPassages(search.text);
        const citation = { marker: 1, passage: passage?.id, quote: record?.quote ?? MOON };
        const citations = record ? [citation, { ...citation, marker: 2 }] : [citation];
        const cite = { tool: "cite", input: { citations } };
        if (citesAfter && writes.length === 0) {
          const input = into ? { content } : { title: "Tide notes", content };
          heardWrite?.();
          return { calls: [{ tool, input }, ...(citesAfter === "beside" ? [cite] : [])] };
        }
        return { calls: [cite] };
      }
      // Told its text has no Citation (#1415), it writes it again as it was: it says nothing the Documents say.
      const refused = writes.length === 1 && writes[0]?.text.includes("content has no Citation");
      if (writes.length === 0 || refused) {
        const input = into ? { content } : { title: "Tide notes", content };
        heardWrite?.();
        return { calls: [{ tool, input }] };
      }
      if (replyFails) return { error: { status: 500, message: "The service broke." } };
      return { text: "Wrote it from your Documents." };
    },
    record || generated || generate
      ? {
          generate: (call: GenerateCall) => {
            generated?.(call);
            return generate?.(call) ?? checkGenerate(PLANS)(call);
          },
        }
      : { generate: judgesNothing },
  );
}

/** A core with the tides line in a Folder, and a Mind there with a heading and a line. */
async function harbour(
  model: ReturnType<typeof writingModel>,
  cloud: Writing["cloud"],
  record: Writing["record"],
  untitled = false,
  sortTimeLimit?: Writing["sortTimeLimit"],
  keychain?: MemoryKeychain,
) {
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir, {
    createChatModel: scriptedModels(model).createChatModel,
    ...(sortTimeLimit && { contradictionWatch: { sortTimeLimit } }),
    ...(keychain && { keychain }),
  });
  let service: string | undefined;
  if (cloud) {
    core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
    const saved = await core.saveChatProvider(
      cloud.kind === "anthropic" ? { ...cloud, apiKey: "sk-ant-test" } : cloud,
    );
    // A cloud model in Ollama sends to ollama.com, not to the Ollama on this computer.
    service = cloud.kind === "ollama" ? OLLAMA_CLOUD.id : saved.service?.id;
    for (const flow of ["chat", "checks"] as const) {
      if (service) await core.allowDataFlow(flow, service);
    }
  } else await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const sources = await createTempDataFolder();
  const documents = await addAndProcess(core, [
    await writeSourceFile(
      sources,
      record?.name ?? "Tides.md",
      record?.contents ?? `# Tides\n\n${MOON}\n`,
    ),
  ]);
  const folder = await core.createLibraryGroup({ name: "Coast", description: "" });
  await core.moveToFolder({ documentIds: documents.map((each) => each.id), folderId: folder.id });
  const mind = await core.createMind({
    title: untitled ? "" : "Harbour notes",
    folderId: folder.id,
  });
  const client = await connectToMind(core, mind.id);
  if (!untitled) {
    writeMind(client, [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Harbour" }] },
      { type: "paragraph", content: [{ type: "text", text: "Boats moor by the quay." }] },
    ]);
  }
  await client.settled();
  return { core, folderId: folder.id, mindId: mind.id, client, service, dataDir };
}

const ASK = {
  into: "Add a short note on tides to this Mind",
  made: "Summarise these Documents into a new note",
};

/** What the User asks the second time, for a longer version of what the assistant wrote. */
const LONGER = "Make that note on tides longer";

/**
 * A model that adds `first` to the Note in front, then, asked for it `LONGER`, writes `longer`
 * over it with edit_mind, in place, telling `rewrites` as it does; each sentence's check as
 * `check` says, else as `PLANS` does.
 */
function rewritingModel(
  {
    first,
    longer,
    check,
    rewrites,
    generate,
  }: {
    first: string;
    longer: string;
    check?: (call: ModelCall) => ScriptedReply | null;
    rewrites?: () => void;
    generate?: (call: GenerateCall) => GeneratedReply | null;
  },
  calls: ModelCall[],
) {
  return scriptedModel(
    (call): ScriptedReply => {
      calls.push(call);
      if (isCheckRun(call)) return check?.(call) ?? checkReply(call, PLANS);
      const { results } = call;
      const again = call.prompt.includes(LONGER);
      const tool = again ? "edit_mind" : "add_to_mind";
      const search = results.find((result) => result.tool === "search_documents");
      if (!search)
        return { calls: [{ tool: "search_documents", input: { query: "spring tides" } }] };
      if (!results.some((result) => result.tool === "cite")) {
        const [passage] = shownPassages(search.text);
        const citations = [{ marker: 1, passage: passage?.id, quote: MOON }];
        return { calls: [{ tool: "cite", input: { citations } }] };
      }
      if (!results.some((result) => result.tool === tool)) {
        const input = again ? { part: "Tides", content: longer } : { content: first };
        if (again) rewrites?.();
        return { calls: [{ tool, input }] };
      }
      return { text: again ? "It says more now." : "Wrote it from your Documents." };
    },
    { generate: (call: GenerateCall) => generate?.(call) ?? checkGenerate(PLANS)(call) },
  );
}

/**
 * A keychain whose reads wait, once `hold` is called, until `release`: a model is readied with
 * its key, so a check being readied waits there.
 */
function holdingKeychain() {
  const keychain = createMemoryKeychain();
  let holding = false;
  let held = 0;
  let release: () => void = () => undefined;
  let released = Promise.resolve();
  return {
    keychain: {
      ...keychain,
      get: async (name: string) => {
        if (holding) {
          held++;
          await released;
        }
        return keychain.get(name);
      },
    } satisfies MemoryKeychain,
    hold() {
      holding = true;
      released = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    held: () => held,
    release() {
      holding = false;
      release();
    },
  };
}

/** Writes as `writing` says and resolves once the Answer has ended and the check of what it wrote is over. */
async function write(
  writing: Writing,
  onStart?: (started: {
    core: Core;
    client: MindClient;
    mindId: string;
    service: string | undefined;
    calls: readonly ModelCall[];
  }) => void | Promise<void>,
) {
  const calls: ModelCall[] = [];
  let started: Core | null = null;
  const model = writingModel(writing, calls, () => started);
  const { core, folderId, mindId, client, service } = await harbour(
    model,
    writing.cloud,
    writing.record,
    writing.untitled,
    writing.sortTimeLimit,
  );
  started = core;
  await onStart?.({ core, client, mindId, service, calls });
  const answer = await askAssistant(
    core,
    {
      text: writing.into ? ASK.into : ASK.made,
      ...(writing.into && { mindId }),
      scope: { folderIds: [folderId], tagIds: [], documentIds: [] },
    },
    writing.ends,
  );
  const [change] = changesIn(answer);
  const page = writing.into ? client : await connectToMind(core, change?.mindId ?? "");
  await page.settled();
  return { core, model, calls, answer, change, client: page };
}

/** Asks for a write and resolves as soon as its Answer ends, while what it wrote may still be checked. */
async function writeAndReply(writing: Writing, progress: WrittenCheckProgress[] = []) {
  const calls: ModelCall[] = [];
  let started: Core | null = null;
  const model = writingModel(writing, calls, () => started);
  const { core, folderId, mindId, client } = await harbour(model, writing.cloud, writing.record);
  started = core;
  core.on("writtenCheck.progress", (event) => progress.push(event));
  const ended = new Map<string, "finished" | "failed">();
  core.on("answer.finished", (event) => ended.set(event.answerId, "finished"));
  core.on("answer.failed", (event) => ended.set(event.answerId, "failed"));
  const asked = await core.askInConversation({
    text: writing.into ? ASK.into : ASK.made,
    ...(writing.into && { mindId }),
    scope: { folderIds: [folderId], tagIds: [], documentIds: [] },
  });
  if (!asked.asked) throw new Error("Not asked.");
  const how = await vi.waitFor(
    () => {
      const end = ended.get(asked.answerId);
      if (!end) throw new Error("The Answer hasn't ended.");
      return end;
    },
    { timeout: 20_000, interval: 5 },
  );
  expect(how).toBe(writing.ends ?? "finished");
  return { core, model, calls, client, mindId, folderId, progress, asked };
}

/** The Answer as stored now. */
async function storedAnswer(core: Core, conversationId: string, answerId: string) {
  const { messages } = await core.getConversation(conversationId);
  const found = messages.find((each) => each.id === answerId);
  if (found?.kind !== "answer") throw new Error("No Answer.");
  return found;
}

/** Asks, and resolves as soon as the Answer ends, while what it wrote may still be checked. */
async function askAndEnd(core: Core, input: Parameters<Core["askInConversation"]>[0]) {
  const ended = new Set<string>();
  const stop = core.on("answer.finished", (event) => ended.add(event.answerId));
  try {
    const asked = await core.askInConversation(input);
    if (!asked.asked) throw new Error("Not asked.");
    await vi.waitFor(
      () => {
        if (!ended.has(asked.answerId)) throw new Error("The Answer hasn't ended.");
      },
      { timeout: 20_000, interval: 5 },
    );
    return { conversationId: asked.conversation.id, id: asked.answerId };
  } finally {
    stop();
  }
}

/** Resolves once the check under `request` has said it ended. */
const checkEnds = (progress: readonly WrittenCheckProgress[], request?: string) =>
  vi.waitFor(
    () => {
      const ended = progress.find(
        (event) => !event.running && (request === undefined || event.request === request),
      );
      if (!ended) throw new Error("The check hasn't ended.");
      return ended;
    },
    { timeout: 20_000, interval: 10 },
  );

/**
 * Makes the next mark's edit fail once it is armed, and only that once: an edit that breaks for a
 * reason other than the Note refusing it.
 */
function failOneMark() {
  let armed: boolean | null = false;
  const format = Y.XmlText.prototype.format;
  const spy = vi.spyOn(Y.XmlText.prototype, "format").mockImplementation(function (
    this: Y.XmlText,
    ...args: Parameters<Y.XmlText["format"]>
  ) {
    if (armed) {
      armed = null;
      throw new Error("The edit broke.");
    }
    format.apply(this, args);
  });
  return {
    arm: () => {
      if (armed === false) armed = true;
    },
    restore: () => spy.mockRestore(),
  };
}

const ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;

const endsCheck = (reply: ScriptedReply) =>
  "text" in reply && typeof reply.text === "string" && !("calls" in reply && reply.calls?.length);

/**
 * Every request a write's checks send, normalized: ids, times and cache keys put by. The other
 * sentences (as checks read them) wait for the first one's check to end; or, `reversed`, it waits
 * for theirs. So the checks end in opposite orders.
 */
async function checkRequestsOf(
  writing: Writing,
  sentences: { first: string; others: readonly string[]; checked: number },
  reversed: boolean,
) {
  const { first, others, checked } = sentences;
  let page: MindClient | null = null;
  const verdicts: string[] = [];
  const generated: GenerateCall[] = [];
  const once = (ended: () => boolean) =>
    vi
      .waitFor(() => expect(ended()).toBe(true), { timeout: 20_000, interval: 5 })
      .then(() => page?.settled());
  const { calls } = await write(
    {
      ...writing,
      cloud: { kind: "anthropic", modelId: "claude-haiku-5-5" },
      generated: (call) => generated.push(call),
      check: (call, core) => {
        const reply = writing.check?.(call, core) ?? checkReply(call, PLANS);
        if (endsCheck(reply)) verdicts.push(sentenceOf(call));
        if (call.results.length > 0) return reply;
        const sentence = sentenceOf(call);
        const until = reversed
          ? sentence === first &&
            once(() => verdicts.filter((each) => others.includes(each)).length >= checked - 1)
          : others.includes(sentence) && once(() => verdicts.includes(first));
        return until ? { ...reply, pause: { after: 0, until } } : reply;
      },
    },
    ({ client }) => {
      page = client;
    },
  );
  return {
    requests: [
      ...calls.filter(isCheckRun).map((call) => normalized(call.options)),
      // A sentence's comparisons and its record cites' judgements, not the reply's own checks.
      ...generated
        .filter((call) => /^(Compare a sentence|A sentence the User wrote)/.test(call.system))
        .map((call) => normalized(call.options)),
    ].sort(),
    verdicts,
  };
}

/**
 * A request's whole call, its prompt's messages, Tools, settings and provider options, with
 * only what differs between two runs of the same write put by: ids, times, cache keys, the
 * signal, and the scripted model's Tool call ids, numbered in their order within the request.
 */
function normalized(options: unknown): string {
  const toolCalls = new Map<string, string>();
  const text = JSON.stringify(options, (key, value: unknown) => {
    if (key === "abortSignal" || typeof value === "function") return undefined;
    if (key === "promptCacheKey" || key === "cacheKey") return "<key>";
    if (key === "toolCallId" && typeof value === "string") {
      if (!toolCalls.has(value)) toolCalls.set(value, `call-${toolCalls.size}`);
      return toolCalls.get(value);
    }
    return value;
  });
  return text.replace(ID, "<id>").replace(TIME, "<time>");
}

/** A paragraph of the Mind as checks read it: each Citation as U+FFFC. */
function paragraphText(client: MindClient, index: number): string {
  let text = "";
  readMind(client)
    .child(index)
    .forEach((node) => {
      text += node.isText ? (node.text ?? "") : INLINE_NODE;
    });
  return text;
}

/** Each check's mark in the Mind and how it shows, by its sentence. */
async function marksIn(core: Core, client: MindClient) {
  await client.settled();
  const versions = new Map((await core.listDocuments()).map((each) => [each.id, each.contentHash]));
  return claimSpans(readMind(client)).map((span) => ({
    sentence: span.sentence.text.replaceAll(INLINE_NODE, "").trim(),
    check: span.check,
    shown: claimCheckShown(span.check, {
      text: span.sentence.text,
      versions,
      folderId: span.check.scope.folderId,
      scope: null,
    }),
  }));
}

/** The states of the marks the client sees now. */
const statesIn = (client: MindClient) =>
  claimSpans(readMind(client)).map((span) => span.check.state);

describe("What the assistant writes is checked once it lands, the reply not waiting", {
  timeout: 30_000,
}, () => {
  // protects=the reply and the end of the Answer come while the check of what it wrote still runs, each written sentence shown as being checked until its own mark lands (#2830's acceptance: a scripted slow judge); fails_when=the Answer waits for the check, a sentence lands unmarked while it is checked, or the check stops with the Answer; no_claim=how long a real check takes.
  test("the Answer ends while a slow check of what it wrote still runs, and the check finishes after", async () => {
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { core, client, progress, asked } = await writeAndReply({
      content: `Spring tides come at new and full moon [^1]. ${UNBACKED} [^1].`,
      into: true,
      cloud: { kind: "anthropic", modelId: "claude-haiku-5-5" },
      check: (call) =>
        call.results.length === 0
          ? { ...checkReply(call, PLANS), pause: { after: 0, until: slow } }
          : null,
    });

    await client.settled();
    expect(statesIn(client)).toEqual(["checking", "checking"]);
    const answered = await storedAnswer(core, asked.conversation.id, asked.answerId);
    expect(answered.text).toBe("Wrote it from your Documents.");
    expect(changesIn(answered)[0]?.selfCheck).toMatchObject({
      checkable: 2,
      sent: 2,
      checked: 0,
      running: true,
    });
    expect(progress[0]).toMatchObject({ done: 0, total: 2, running: true });

    release();
    expect(await checkEnds(progress)).toMatchObject({ done: 2, total: 2, running: false });
    await client.settled();
    expect(statesIn(client)).toEqual(["supported", "unsupported"]);
    const checked = await storedAnswer(core, asked.conversation.id, asked.answerId);
    const [change] = changesIn(checked);
    expect(change?.selfCheck).toMatchObject({ checked: 2, failed: 0, look: 1 });
    expect(change?.selfCheck).not.toHaveProperty("running");
  });

  // protects=the check counts live: each landing moves `done` by one, the total stays the sentences being checked (#2830); fails_when=the count is reported once and never moves, as the step's did; no_claim=the words the line shows.
  test("the check says how far it is as each mark lands", async () => {
    const progress: WrittenCheckProgress[] = [];
    await write(
      {
        content: `## Tides\n\nSpring tides come at new and full moon [^1]. ${UNBACKED} [^1]. Neap tide 3 is twice as strong [^1].`,
        cloud: { kind: "anthropic", modelId: "claude-haiku-5-5" },
      },
      ({ core }) => {
        core.on("writtenCheck.progress", (event) => progress.push(event));
      },
    );

    expect(progress.map(({ done, total, running }) => [done, total, running])).toEqual([
      [0, 3, true],
      [1, 3, true],
      [2, 3, true],
      [3, 3, true],
      [3, 3, false],
    ]);
  });

  // protects=a written sentence that overstates its Citations lands as written, its Citation kept, marked unsupported with what isn't covered, and is never cut after the reply (#2830); fails_when=its words change, the Citation goes, it lands unmarked, or a cut is asked for; no_claim=how well a real model judges the part.
  test("a part its Citations don't support lands marked, its words and Citation as written", async () => {
    const { core, model, calls, change, client } = await write({
      content: `## Tides\n\n${OVERSTATED} [^1].`,
    });

    expect(shownWithChanges(client)).toEqual(["+ Tides", `+ ${OVERSTATED} ⟨found⟩.`]);
    const marks = await marksIn(core, client);
    expect(marks.map(({ check }) => check.state)).toEqual(["unsupported"]);
    expect(marks[0]?.check.unsupported).toMatchObject({ uncovered: "the yearly floods" });
    expect(calls.some((call) => CUT.test(call.prompt))).toBe(false);
    expect(change?.selfCheck).toMatchObject({ cited: 1, sent: 1, checked: 1, failed: 0, look: 1 });
    expect(lastResult(model)).toContain(CHECKED_AFTER);
  });

  // protects=a written sentence its Citations don't support at all lands marked unsupported, with the check's reason, so Check this note has nothing more to find, and the model is told nothing of the verdict; fails_when=it lands unmarked, or Check this note sends it again, or the reply is told to report it; no_claim=none beyond protects.
  test("a sentence still unsupported lands marked, and Check this note leaves it", async () => {
    const { core, model, change, client } = await write({
      content: `## Tides\n\n${UNBACKED} [^1].`,
    });

    expect(shownWithChanges(client)).toEqual([
      "+ Tides",
      "+ Neap tides are twice as strong ⟨found⟩.",
    ]);
    const [mark] = claimSpans(readMind(client));
    expect(mark?.check).toMatchObject({
      state: "unsupported",
      action: "check-against-documents",
      text: asChecked(UNBACKED).replaceAll(INLINE_NODE, ""),
      unsupported: { reason: "No Passage compares the strength of the tides." },
    });
    expect(lastResult(model)).toContain(CHECKED_AFTER);
    expect(lastResult(model)).not.toContain("not supported");
    await resolveChanges(client, "accept");
    expect(claimSpans(readMind(client))).toHaveLength(1);
    expect(await core.planMindCheck(change?.mindId ?? "", "changed")).toMatchObject({
      kind: "unchanged",
    });
  });

  // protects=a check that fails lands its sentence marked not checked, with why, and the card's line counts it, while the reply is told nothing of it; fails_when=it lands unmarked, which reads as supported, or the reply is told to say so; no_claim=the words of the line.
  test("a sentence whose check fails lands marked not checked, and the card counts it", async () => {
    const { core, model, change, client } = await write({
      content: `## Tides\n\n${FAILING} [^1].`,
    });

    const [mark] = await marksIn(core, client);
    expect(mark?.check).toMatchObject({ state: "not-checked", reason: "failed" });
    expect(change?.selfCheck).toMatchObject({ cited: 1, sent: 1, checked: 0, failed: 1 });
    expect(lastResult(model)).not.toContain("couldn't be checked");
  });

  // protects=the spending cap reached during the check stops it: the sentences left land not checked for that reason, and the change says what stopped it, for the line that offers Change the cap; fails_when=they land unmarked, or the stop isn't kept; no_claim=the line's words.
  test("the spending cap reached during the check stops it, and its sentences say why", async () => {
    // Heard from before the Answer is asked: its check may start only after it ends.
    let finished: Promise<void> = Promise.resolve();
    let capped: Promise<void> | null = null;
    const { core, change, client } = await write(
      {
        content: `## Tides\n\n${UNBACKED} [^1]. ${OVERSTATED} [^1].`,
        cloud: { kind: "anthropic", modelId: "claude-haiku-5-5" },
        check: (call, started) => {
          // Reached once the reply is in: the check goes on after it.
          capped ??= finished
            .then(() =>
              started.updateSettings({ user: { monthlyCap: { amount: 0, currency: "USD" } } }),
            )
            .then(() => undefined);
          return call.results.length === 0
            ? { ...checkReply(call, PLANS), pause: { after: 0, until: capped } }
            : null;
        },
      },
      ({ core: started }) => {
        finished = new Promise<void>((resolve) => {
          const stop = started.on("answer.finished", () => {
            stop();
            resolve();
          });
        });
      },
    );

    const marks = await marksIn(core, client);
    expect(marks.map(({ check }) => [check.state, check.reason])).toEqual([
      ["not-checked", "cost-cap"],
      ["not-checked", "cost-cap"],
    ]);
    expect(change?.selfCheck).toMatchObject({
      cited: 2,
      sent: 2,
      checked: 0,
      failed: 2,
      stop: { reason: "cost-cap" },
    });
  });

  // protects=a plan's limit reached during the check stops it the same way, keeping the stop for the line that says when it resumes; fails_when=the sentences land unmarked, or the stop isn't kept; no_claim=the line's words.
  test("a plan's limit reached during the check stops it, and its sentences say why", async () => {
    const { core, change, client } = await write({
      content: `## Tides\n\n${UNBACKED} [^1].`,
      cloud: { kind: "ollama", modelId: "glm-5.3:cloud" },
      check: () => ({
        error: { status: 402, message: "You have reached your weekly usage limit" },
      }),
    });

    const [mark] = await marksIn(core, client);
    expect(mark?.check).toMatchObject({ state: "not-checked", reason: "plan-limit" });
    expect(change?.selfCheck).toMatchObject({
      sent: 1,
      checked: 0,
      failed: 1,
      stop: { reason: "plan-limit" },
    });
  });

  // protects=turning the checks flow off while the check runs stops it at once: no request after it reaches the model's service, and the sentences land not checked, saying why (#1206); fails_when=the remaining sentences are still sent, or land unmarked; no_claim=the Privacy page.
  test("turning the checks flow off while the check runs sends nothing more, and the sentences land not checked", async () => {
    let turnOff: (() => Promise<void>) | null = null;
    let sentBefore = -1;
    const { core, calls, change, client } = await write(
      {
        content: `## Tides\n\n${UNBACKED} [^1]. Neap tide 2 is twice as strong [^1]. Neap tide 3 is twice as strong [^1].`,
        cloud: { kind: "anthropic", modelId: "claude-haiku-5-5" },
        during: () => turnOff?.() ?? Promise.resolve(),
      },
      ({ core: started, service, calls: made }) => {
        turnOff = async () => {
          if (service) await started.revokeConsent("checks", service);
          sentBefore = made.filter(isCheckRun).length;
        };
      },
    );

    // The checks' first requests were on their way, a cloud model's several at once; none went after.
    const checks = calls.filter(isCheckRun);
    expect(sentBefore).toBeGreaterThan(0);
    expect(checks).toHaveLength(sentBefore);
    expect(checks.every((call) => call.results.length === 0)).toBe(true);
    const marks = await marksIn(core, client);
    expect(marks.map(({ check }) => [check.state, check.reason])).toEqual([
      ["not-checked", "consent-revoked"],
      ["not-checked", "consent-revoked"],
      ["not-checked", "consent-revoked"],
    ]);
    expect(change?.selfCheck).toMatchObject({
      cited: 3,
      sent: 3,
      checked: 0,
      failed: 3,
      blocked: { reason: "consent-revoked", count: 3 },
    });
  });

  // protects=a User who allowed checks before they sent more isn't asked as the assistant writes, nor is anything sent: the write's sentences land not checked, saying why, and the Check of one asks for the more and checks the whole write once allowed (#2525), and the model, whose check ended before its result was written, is still told the check isn't its to report (#2830); fails_when=the write lands unchecked with no reason, is sent on the earlier consent, asks in the background, Allow checks only the one sentence, or the model hears nothing of the check; no_claim=the consent dialog's words.
  test("allowed before checks sent more, the write waits for the User's OK, then is checked whole", async () => {
    const asked: string[][] = [];
    const { core, model, calls, change, client } = await write(
      {
        content: `## Tides\n\nSpring tides come at new and full moon [^1]. ${UNBACKED} [^1].`,
        cloud: { kind: "anthropic", modelId: "claude-haiku-5-5" },
      },
      async ({ core: started, service }) => {
        const checks = started.dataFlows.get("checks");
        if (!service || !checks) throw new Error("The checks flow to the model isn't set up.");
        const more = [
          "library-counts",
          "library-names",
          "file-properties",
          "absence-documents",
          "watched-sentences",
        ];
        await started.revokeConsent("checks", service);
        started.dataFlows.register({
          ...checks,
          sends: checks.sends.filter((kind) => !more.includes(kind)),
        });
        await started.allowDataFlow("checks", service);
        started.dataFlows.register(checks);
        started.on("consent.requested", (request) => asked.push([...request.newKinds]));
      },
    );

    expect(asked).toEqual([]);
    expect(calls.some(isCheckRun)).toBe(false);
    // Its check ended before the call's result was written: the model is told all the same.
    expect(lastResult(model)).toContain(CHECKED_AFTER);
    expect((await marksIn(core, client)).map(({ check }) => [check.state, check.reason])).toEqual([
      ["not-checked", "consent-widened"],
      ["not-checked", "consent-widened"],
    ]);
    expect(change?.selfCheck).toMatchObject({
      cited: 2,
      sent: 2,
      checked: 0,
      failed: 2,
      blocked: { reason: "consent-widened", count: 2 },
    });

    const paragraph = change?.selfCheck?.blocks?.[1];
    if (!paragraph || !change) throw new Error("The write has no paragraph.");
    // What the assistant wrote is a change to accept before a check reads it, as for every check.
    await resolveChanges(client, "accept");
    await core.checkSentences({
      requestId: "review-consent",
      mindId: change.mindId,
      action: "check-against-documents",
      from: { blockId: paragraph, offset: 0 },
      to: { blockId: paragraph, offset: paragraphText(client, 1).length },
    });

    expect(asked).toEqual([
      [
        "library-counts",
        "library-names",
        "file-properties",
        "absence-documents",
        "watched-sentences",
      ],
    ]);
    expect(calls.some(isCheckRun)).toBe(true);
    expect((await marksIn(core, client)).map(({ check }) => check.state)).toEqual([
      "supported",
      "unsupported",
    ]);
  });

  // protects=every sentence a write holds is checked and gets its mark, past the twelve one check used to send (#2830's acceptance: 40 sentences); fails_when=a long write checks only its first sentences, or the rest land unmarked or not checked for being too many; no_claim=how long each check takes.
  test("every sentence of a long write is checked and gets its mark, past twelve", async () => {
    const sentences = Array.from(
      { length: 40 },
      (_, index) => `Neap tide ${index + 1} is twice as strong [^1].`,
    );
    const { core, model, calls, change, client } = await write({
      content: `## Tides\n\n${sentences.join(" ")}`,
    });

    expect(calls.filter((call) => isCheckRun(call) && call.results.length === 0)).toHaveLength(40);
    const marks = await marksIn(core, client);
    expect(marks).toHaveLength(40);
    expect(marks.every(({ check }) => check.state === "unsupported")).toBe(true);
    expect(change?.selfCheck).toMatchObject({ checkable: 40, cited: 40, sent: 40, checked: 40 });
    expect(lastResult(model)).not.toContain("Only the first");
  });

  // protects=a claim the assistant wrote with no Citation is checked too, as Check this note would check it (#2830: every sentence it wrote); fails_when=it lands unmarked, left for a later Check; no_claim=the verdict a real check gives.
  test("a claim it wrote with no Citation is checked as it lands, as Check this note checks it", async () => {
    const { core, calls, change, client } = await write({
      content: "## Tides\n\nThe harbour is quiet in winter.",
    });

    expect(shownWithChanges(client)).toEqual(["+ Tides", "+ The harbour is quiet in winter."]);
    // Its check searches the Documents for something that backs it before it judges.
    const checks = calls.filter(isCheckRun);
    expect(checks.length).toBeGreaterThan(0);
    expect(
      checks.some((call) => call.results.some((result) => result.tool === "search_documents")),
    ).toBe(true);
    expect((await marksIn(core, client)).map(({ check }) => check.state)).toEqual(["unsupported"]);
    expect(change?.selfCheck).toMatchObject({ checkable: 1, cited: 0, sent: 1, checked: 1 });
  });

  // protects=a write into the empty Note in front, which has no title, names it as the User now finds it, by its new first line, so the reply never names a Note that is gone (#2769, #2830); fails_when=the result names it "Untitled" after the write named it, which the reply then repeats and the record of changes no longer backs; no_claim=the words the model replies with.
  test("a write into an untitled Note names it by the first line it gave it", async () => {
    const { model } = await write({
      content: `## Tide summary\n\n${MOON} [^1].`,
      into: true,
      untitled: true,
    });

    expect(lastResult(model)).toContain(
      "in the Note the User is in, which held nothing before and which its first line now names “Tide summary”",
    );
    expect(lastResult(model)).not.toContain("Untitled");
  });

  const isSort = (call: GenerateCall) => call.question === "find-claims";
  /** The sort of the write's two sentences with no Citation, asked again of the second, not the one a sentence's own check asks. */
  const writeSorted = (call: GenerateCall) => isSort(call) && call.prompt.includes('"number":2');

  // protects=a sentence the claims sort says nothing of, asked twice, is checked as a claim, as Check this Note keeps it, never left out as an opinion (#2830); fails_when=it loses its checking dot, leaves the total and gets no mark, while the line says every sentence was checked; no_claim=how often a real model leaves one out.
  test("a sentence the claims sort leaves undecided is checked as a claim", async () => {
    const progress: WrittenCheckProgress[] = [];
    const sorted: string[] = [];
    const { core, answer, client } = await write(
      {
        content: "## Tides\n\nThe harbour is quiet in winter. The quay is busy in summer.",
        generate: (call) => {
          if (!writeSorted(call)) return isSort(call) ? judgesNothing(call) : null;
          sorted.push(call.prompt);
          const parts = [{ kind: "fact", text: "The harbour is quiet in winter." }];
          return { text: JSON.stringify({ sentences: [{ number: 1, parts }] }) };
        },
      },
      ({ core: started }) => {
        started.on("writtenCheck.progress", (event) => progress.push(event));
      },
    );

    expect(await checkEnds(progress)).toMatchObject({ done: 2, total: 2 });
    expect(sorted).toHaveLength(2);
    expect(
      (await marksIn(core, client)).map(({ sentence, check }) => [sentence, check.state]),
    ).toEqual([
      ["The harbour is quiet in winter.", "unsupported"],
      ["The quay is busy in summer.", "unsupported"],
    ]);
    const [checked] = changesIn(await storedAnswer(core, answer.conversationId, answer.id));
    expect(checked?.selfCheck).toMatchObject({ checkable: 2, checked: 2, leftOut: 0 });
  });

  // protects=a claims sort that never replies is given up on at its time limit, and each sentence is then checked on its own, as when the sort fails, so the count never freezes (#2830); fails_when=the sentences with no Citation wait on the sort for good, the line stuck at what the cited ones reached; no_claim=how long a real sort takes, or the limit's length.
  test("a claims sort that never replies is given up on, and each sentence is checked on its own", async () => {
    const limit = new AbortController();
    const progress: WrittenCheckProgress[] = [];
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { core, answer, client } = await write(
        {
          content: "## Tides\n\nThe harbour is quiet in winter. The quay is busy in summer.",
          sortTimeLimit: () => limit.signal,
          generate: (call) => {
            if (!writeSorted(call)) return isSort(call) ? judgesNothing(call) : null;
            // Asked, the sort never replies: its limit is what ends it.
            limit.abort();
            return { text: "", until: new Promise<void>(() => undefined) };
          },
        },
        ({ core: started }) => {
          started.on("writtenCheck.progress", (event) => progress.push(event));
        },
      );

      expect(await checkEnds(progress)).toMatchObject({ done: 2, total: 2 });
      expect((await marksIn(core, client)).map(({ check }) => check.state)).toEqual([
        "unsupported",
        "unsupported",
      ]);
      const [checked] = changesIn(await storedAnswer(core, answer.conversationId, answer.id));
      expect(checked?.selfCheck).toMatchObject({ checkable: 2, checked: 2 });
      expect(
        warnings.mock.calls.some(([line]) => String(line).includes("weren't named in time")),
      ).toBe(true);
    } finally {
      warnings.mockRestore();
    }
  });

  // protects=a written sentence's mark lands as its own check ends, while another sentence of the write is still being checked (#2532); fails_when=the marks wait for the last check and land together; no_claim=the order in which the checks end.
  test("a sentence's mark lands as soon as its check ends, while another is still checked", async () => {
    let page: MindClient | null = null;
    const moonMarked = () =>
      page !== null &&
      claimSpans(readMind(page)).some(
        (span) => span.sentence.text.startsWith("Spring tides") && span.check.state === "supported",
      );
    let markedWhileWaiting = false;
    const { core, client } = await write(
      {
        content: `Spring tides come at new and full moon [^1]. ${UNBACKED} [^1].`,
        into: true,
        cloud: { kind: "anthropic", modelId: "claude-haiku-5-5" },
        check: (call) => {
          if (sentenceOf(call) !== `${UNBACKED} .` || call.results.length > 0) return null;
          const landed = vi
            .waitFor(() => expect(moonMarked()).toBe(true), { timeout: 20_000, interval: 5 })
            .then(
              () => {
                markedWhileWaiting = true;
              },
              () => undefined,
            );
          return { ...checkReply(call, PLANS), pause: { after: 0, until: landed } };
        },
      },
      ({ client: connected }) => {
        page = connected;
      },
    );

    expect(markedWhileWaiting).toBe(true);
    const marks = await marksIn(core, client);
    expect(marks.map(({ sentence, check }) => [sentence, check.state])).toEqual([
      ["Spring tides come at new and full moon .", "supported"],
      ["Neap tides are twice as strong .", "unsupported"],
    ]);
  });

  // protects=a landing that throws (here a newer version wrote the Note mid-check, so no edit may change it) is logged and never becomes its sentence's failure, and the check ends with what it couldn't land counted not checked (#2532); fails_when=runItems files the throw as the sentence's failure and lands it again, or the check never ends; no_claim=what the card says of a Note a newer version wrote.
  test("a mark that can't land is logged, not filed as its sentence's failure, and the check ends", async () => {
    let page: MindClient | null = null;
    let newer: Promise<void> | null = null;
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { model, calls, change } = await write(
        {
          content: `Spring tides come at new and full moon [^1]. ${UNBACKED} [^1].`,
          into: true,
          cloud: { kind: "anthropic", modelId: "claude-haiku-5-5" },
          check: (call) => {
            const client = page;
            if (call.results.length > 0 || !client) return null;
            if (!newer) {
              client.doc
                .getMap(MIND_SETTINGS_FIELD)
                .set(CONTENT_SCHEMA_VERSION_KEY, CONTENT_SCHEMA_VERSION + 1);
              newer = client.settled();
            }
            return { ...checkReply(call, PLANS), pause: { after: 0, until: newer } };
          },
        },
        ({ client }) => {
          page = client;
        },
      );
      const said = (spy: typeof errors) => spy.mock.calls.map((args) => String(args[0]));

      expect(calls.filter((call) => isCheckRun(call) && call.results.length === 0)).toHaveLength(2);
      expect(said(errors).filter((line) => line.includes("marks couldn't land"))).toHaveLength(1);
      expect(said(warnings).filter((line) => line.includes("couldn't be checked"))).toEqual([]);
      expect(said(errors).filter((line) => line.includes("couldn't be checked:"))).toHaveLength(1);
      expect(change?.selfCheck).toMatchObject({ checked: 0, failed: 2 });
      expect(lastResult(model)).toContain("Wrote 1 new Block");
    } finally {
      errors.mockRestore();
      warnings.mockRestore();
    }
  });

  // protects=the sentences of a table land together after every check, in one edit, as a table's marks are footed against each other and its chart drawn from them (#2532), while the count still moves as each check ends (#2830); fails_when=a table's sentence lands on its own as its check ends, or the count stays at 0 until the end; no_claim=how a table foots.
  test("a table's sentences land together after every check, and the count moves as each ends", async () => {
    const seen: string[][] = [];
    const progress: WrittenCheckProgress[] = [];
    const { core, client } = await write(
      {
        content:
          "| Region | Note |\n| --- | --- |\n| North | Spring tides come at new and full moon [^1] |\n| South | Neap tides are twice as strong [^1] |",
        into: true,
        cloud: { kind: "anthropic", modelId: "claude-haiku-5-5" },
      },
      ({ core: started, client: connected }) => {
        started.on("writtenCheck.progress", (event) => progress.push(event));
        connected.doc.on("update", () => {
          seen.push(claimSpans(readMind(connected)).map((span) => span.check.state));
        });
      },
    );

    expect(await marksIn(core, client)).toHaveLength(2);
    expect(progress.map(({ done, total, running }) => [done, total, running])).toEqual([
      [0, 2, true],
      [1, 2, true],
      [2, 2, true],
      [2, 2, false],
    ]);
    // Both show as checked together: never one with a verdict while the other is still checking.
    expect(seen).toContainEqual(["checking", "checking"]);
    expect(
      seen.some(
        (states) => states.includes("checking") && states.some((each) => each !== "checking"),
      ),
    ).toBe(false);
  });

  // protects=a verdict that comes back while the window writes the write's Block again, its removal in one change and its return in the next (#2378), lands once the Block is back, and the line counts it checked (#2830); fails_when=the verdict is dropped as if an Undo had taken the write away, so the sentence ends Not checked, stopped, and the line says it couldn't be checked; no_claim=how often a window writes a Block again.
  test("a verdict that comes while the window writes its Block again lands once the Block is back", async () => {
    let page: MindClient | null = null;
    let mind = "";
    let taken = false;
    let back = Promise.resolve();
    const { core, change, client } = await write(
      {
        content: `${MOON.slice(0, -1)} [^1].`,
        into: true,
        cloud: { kind: "anthropic", modelId: "claude-haiku-5-5" },
        check: (call, started) => {
          const connected = page;
          if (call.results.length > 0 || !connected || taken) return null;
          taken = true;
          const before = readMind(connected).toJSON().content ?? [];
          connected.doc.transact(() => connected.blocks.delete(connected.blocks.length - 1, 1));
          const removed = connected.settled();
          // The Block comes back only once its sentence's verdict is in, while it is still gone.
          back = removed
            .then(() =>
              vi.waitFor(
                async () => {
                  const used = await started.listAiUse(mind);
                  expect(used.map((each) => each.kind)).toContain("sentence-checked");
                },
                { timeout: 20_000, interval: 5 },
              ),
            )
            .then(() => {
              editMind(connected, () => before);
              return connected.settled();
            });
          return { ...checkReply(call, PLANS), pause: { after: 0, until: removed } };
        },
      },
      ({ client: connected, mindId }) => {
        page = connected;
        mind = mindId;
      },
    );

    await back;
    expect(taken).toBe(true);
    expect(
      (await marksIn(core, client)).map(({ sentence, check }) => [sentence, check.state]),
    ).toEqual([["Spring tides come at new and full moon .", "supported"]]);
    expect(change?.selfCheck).toMatchObject({ checkable: 1, checked: 1, failed: 0 });
  });

  // protects=Stop on the Note's badge ends a write's check: the marks that landed stay, the sentences it hadn't checked land not checked, and nothing more is sent (#2830); fails_when=a stopped sentence stays shown as being checked, lands a verdict, or the check goes on; no_claim=what the badge looks like.
  test("Stop on the Note's badge ends the check, keeping the marks that landed", async () => {
    let stop: (() => Promise<void>) | null = null;
    const { core, calls, client, progress, asked } = await writeAndReply({
      content: `Spring tides come at new and full moon [^1]. ${UNBACKED} [^1].`,
      into: true,
      cloud: { kind: "anthropic", modelId: "claude-haiku-5-5" },
      check: (call) => {
        if (sentenceOf(call) !== `${UNBACKED} .` || call.results.length > 0) return null;
        const stopped = vi
          .waitFor(() => expect(stop).not.toBeNull(), { timeout: 20_000, interval: 5 })
          .then(() => stop?.());
        return { ...checkReply(call, PLANS), pause: { after: 0, until: stopped } };
      },
    });
    await vi.waitFor(() => expect(progress.at(-1)?.done).toBe(1), { timeout: 20_000 });
    const request = progress[0]?.request ?? "";
    const sent = calls.filter(isCheckRun).length;
    stop = () => core.cancelCheck(request);

    expect(await checkEnds(progress)).toMatchObject({ done: 2, total: 2, running: false });
    const marks = await marksIn(core, client);
    expect(marks.map(({ sentence, check }) => [sentence, check.state, check.reason])).toEqual([
      ["Spring tides come at new and full moon .", "supported", null],
      ["Neap tides are twice as strong .", "not-checked", "stopped"],
    ]);
    // The stopped sentence's request had gone; nothing went after it.
    expect(calls.filter(isCheckRun).length).toBeLessThanOrEqual(sent + 1);
    const [change] = changesIn(await storedAnswer(core, asked.conversation.id, asked.answerId));
    expect(change?.selfCheck).toMatchObject({ checked: 1, failed: 1 });
  });

  // protects=a table's cell whose check ended before Stop on the Note's badge keeps the verdict it was given, while the cell whose check Stop cut short lands Not checked (#2710, #2830); fails_when=the held cell verdict is dropped with the Stop and the cell reads Not checked though it was checked; no_claim=the verdict the scripted judge gives the first cell.
  test("Stop while a table's write is checked keeps the cell verdict that ended, and stops the rest", async () => {
    const calls: ModelCall[] = [];
    let started: Core | null = null;
    const progress: WrittenCheckProgress[] = [];
    const model = writingModel(
      {
        content:
          "| Region | Note |\n| --- | --- |\n| North | Spring tides come at new and full moon [^1] |\n| South | Neap tides are twice as strong [^1] |",
        into: true,
        // One claim at a time, as a local model checks: the second check starting proves the first ended.
        check: (call, core) => {
          if (!sentenceOf(call).includes("Neap tides are twice as strong")) return null;
          if (call.results.length > 0) return null;
          const request = progress[0]?.request ?? "";
          const stopped = Promise.resolve().then(() => core.cancelCheck(request));
          return { ...checkReply(call, PLANS), pause: { after: 0, until: stopped } };
        },
      },
      calls,
      () => started,
    );
    const { core, folderId, mindId, client } = await harbour(model, undefined, undefined);
    started = core;
    core.on("writtenCheck.progress", (event) => progress.push(event));

    await askAssistant(core, {
      text: ASK.into,
      mindId,
      scope: { folderIds: [folderId], tagIds: [], documentIds: [] },
    });

    expect(await checkEnds(progress)).toMatchObject({ done: 2, total: 2 });
    const marks = await marksIn(core, client);
    expect(marks.map(({ sentence, check }) => [sentence, check.state, check.reason])).toEqual([
      ["Spring tides come at new and full moon", "unsupported", null],
      ["Neap tides are twice as strong", "not-checked", "stopped"],
    ]);
  });

  // protects=Stop on the Answer once its write has landed doesn't stop the check of what it wrote: only Stop before the write lands does (#2830); fails_when=the Answer's Stop takes the check with it and the sentences stay unmarked or stopped; no_claim=what the Answer says once stopped.
  test("Stop on the Answer after its write landed leaves the check to finish", async () => {
    const calls: ModelCall[] = [];
    let started: Core | null = null;
    let answer: { conversationId: string; answerId: string } | null = null;
    const progress: WrittenCheckProgress[] = [];
    const model = writingModel(
      {
        content: `Spring tides come at new and full moon [^1]. ${UNBACKED} [^1].`,
        into: true,
        check: (call, core) => {
          if (sentenceOf(call) !== `${UNBACKED} .` || call.results.length > 0) return null;
          const stopped = vi
            .waitFor(() => expect(answer).not.toBeNull(), { timeout: 20_000, interval: 5 })
            .then(() => (answer ? core.stopConversationAnswer(answer) : undefined));
          return { ...checkReply(call, PLANS), pause: { after: 0, until: stopped } };
        },
      },
      calls,
      () => started,
    );
    const { core, folderId, mindId, client } = await harbour(
      model,
      { kind: "anthropic", modelId: "claude-haiku-5-5" },
      undefined,
    );
    started = core;
    core.on("writtenCheck.progress", (event) => progress.push(event));

    const asked = await core.askInConversation({
      text: ASK.into,
      mindId,
      scope: { folderIds: [folderId], tagIds: [], documentIds: [] },
    });
    if (!asked.asked) throw new Error("Not asked.");
    answer = { conversationId: asked.conversation.id, answerId: asked.answerId };

    expect(await checkEnds(progress)).toMatchObject({ done: 2, total: 2 });
    const marks = await marksIn(core, client);
    expect(marks.map(({ sentence, check }) => [sentence, check.state])).toEqual([
      ["Spring tides come at new and full moon .", "supported"],
      ["Neap tides are twice as strong .", "unsupported"],
    ]);
  });

  // protects=text written before `cite` recorded its markers is checked once its Citations go in after the Run, even after a Stop, since it landed before it (#1635, #2830); fails_when=a Stop leaves it with found Citations and no mark, which reads as checked; no_claim=what the Answer says once stopped.
  test("a write made before cite is checked after its Run, a Stop since or not", async () => {
    const calls: ModelCall[] = [];
    let started: Core | null = null;
    let answer: { conversationId: string; answerId: string } | null = null;
    const progress: WrittenCheckProgress[] = [];
    let stopped = false;
    const model = writingModel(
      {
        content: `Spring tides come at new and full moon [^1]. ${UNBACKED} [^1].`,
        into: true,
        citesAfter: "next-step",
      },
      calls,
      () => started,
    );
    const { core, folderId, mindId, client } = await harbour(
      model,
      { kind: "anthropic", modelId: "claude-haiku-5-5" },
      undefined,
    );
    started = core;
    core.on("writtenCheck.progress", (event) => progress.push(event));
    // Stopped as its reply begins: the write and its Citations are in by then.
    core.on("answer.delta", (event) => {
      if (stopped || !answer || event.answerId !== answer.answerId) return;
      stopped = true;
      void core.stopConversationAnswer(answer);
    });

    const asked = await core.askInConversation({
      text: ASK.into,
      mindId,
      scope: { folderIds: [folderId], tagIds: [], documentIds: [] },
    });
    if (!asked.asked) throw new Error("Not asked.");
    answer = { conversationId: asked.conversation.id, answerId: asked.answerId };
    await answerEnded(core, asked.answerId);

    expect(await checkEnds(progress)).toMatchObject({ done: 2, total: 2 });
    // Written before its Citations were in, it is checked after the Run: the model is told so.
    const result = calls
      .flatMap((call) => call.results)
      .find((each) => each.tool === "add_to_mind");
    expect(result?.text).toContain(CHECKED_AFTER);
    await client.settled();
    expect(shownWithChanges(client).at(-1)).toBe(
      "+ Spring tides come at new and full moon ⟨found⟩. Neap tides are twice as strong ⟨found⟩.",
    );
    expect((await marksIn(core, client)).map(({ check }) => check.state)).toEqual([
      "supported",
      "unsupported",
    ]);
  });

  // protects=Undo of the write stops its check: no sentence's check starts after it, the check ends as undone, and a Redo brings the sentences back shown as stopped, never as still being checked, with the line saying they weren't checked (#2830's acceptance); fails_when=the check goes on with sentences that are gone, or a Redo shows checking dots that never end; no_claim=how Undo looks in the window, or the turns of checks already sent.
  test("Undo of the write stops its check, and a Redo shows its sentences not checked", async () => {
    let undo: (() => void) | null = null;
    // More sentences than a cloud model checks at once: some are still to start when it is undone.
    const sentences = Array.from(
      { length: 10 },
      (_, index) => `Neap tide ${index + 1} is twice as strong [^1].`,
    );
    const { core, calls, client, progress, asked } = await writeAndReply({
      content: sentences.join(" "),
      into: true,
      cloud: { kind: "anthropic", modelId: "claude-haiku-5-5" },
      check: (call) => {
        if (call.results.length > 0) return null;
        const undone = vi
          .waitFor(() => expect(undo).not.toBeNull(), { timeout: 20_000, interval: 5 })
          .then(() => undo?.());
        return { ...checkReply(call, PLANS), pause: { after: 0, until: undone } };
      },
    });
    await client.settled();
    expect(statesIn(client)).toEqual(sentences.map(() => "checking"));
    const started = () => calls.filter((call) => isCheckRun(call) && call.results.length === 0);
    await vi.waitFor(() => expect(started().length).toBeGreaterThan(0), { timeout: 20_000 });
    const sent = started().length;
    expect(sent).toBeLessThan(sentences.length);
    const history = new Y.UndoManager(client.blocks);
    const written = client.blocks.length - 1;
    undo = () => client.doc.transact(() => client.blocks.delete(written, 1));

    expect(await checkEnds(progress)).toMatchObject({ running: false });
    await client.settled();
    expect(shownWithChanges(client)).toEqual(["Harbour", "Boats moor by the quay."]);
    expect(started()).toHaveLength(sent);
    const [change] = changesIn(await storedAnswer(core, asked.conversation.id, asked.answerId));
    expect(change?.selfCheck).toMatchObject({ undone: true });

    history.undo();
    await client.settled();
    await vi.waitFor(() => expect(statesIn(client)).toEqual(sentences.map(() => "not-checked")), {
      timeout: 20_000,
    });
    // Back, the write's line says what wasn't checked, as a stopped check's does.
    await vi.waitFor(
      async () => {
        const [back] = changesIn(await storedAnswer(core, asked.conversation.id, asked.answerId));
        expect(back?.selfCheck).not.toHaveProperty("undone");
        expect(back?.selfCheck).toMatchObject({ checked: 0, failed: sentences.length });
      },
      { timeout: 20_000 },
    );
  });

  // protects=an Undo, or a reject while it waits, of a write that rewrote the assistant's own text in place ends its check, though the write's Blocks keep their ids: nothing more is sent, nothing lands on the words brought back, which keep the marks they had, and the write's line goes (#2830); fails_when=the check goes on because the ids are still there, its marks land on the restored text, or the Answer still says what it checked; no_claim=how Undo looks in the window, which applies the change and takes it back in one step.
  test.each(["undo", "reject"] as const)(
    "the %s of a rewrite in place ends its check, and the words brought back keep their marks",
    async (how) => {
      const longer = Array.from(
        { length: 8 },
        (_, index) => `Neap tide ${index + 1} is twice as strong [^1].`,
      );
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const calls: ModelCall[] = [];
      const model = rewritingModel(
        {
          first: `## Tides\n\n${MOON.slice(0, -1)} [^1].`,
          longer: `## Tides\n\n${MOON.slice(0, -1)} [^1]. ${longer.join(" ")}`,
          check: (call) =>
            /^Neap tide \d/.test(sentenceOf(call)) && call.results.length === 0
              ? { ...checkReply(call, PLANS), pause: { after: 0, until: held } }
              : null,
        },
        calls,
      );
      const { core, folderId, mindId, client } = await harbour(
        model,
        { kind: "anthropic", modelId: "claude-haiku-5-5" },
        undefined,
      );
      const progress: WrittenCheckProgress[] = [];
      core.on("writtenCheck.progress", (event) => progress.push(event));
      const scope = { folderIds: [folderId], tagIds: [], documentIds: [] };
      const first = await askAssistant(core, { text: ASK.into, mindId, scope });
      const firstCheck = await checkEnds(progress);
      // The window applies what the User asked for once the Answer ends.
      await resolveChanges(client, "accept");
      await client.settled();
      const before = readMind(client).toJSON().content ?? [];
      const marksBefore = (await marksIn(core, client)).map(({ sentence, check }) => [
        sentence,
        check.state,
        check.request,
      ]);
      expect(marksBefore).toEqual([
        ["Spring tides come at new and full moon .", "supported", firstCheck.request],
      ]);

      const second = await askAndEnd(core, {
        text: LONGER,
        mindId,
        scope,
        conversationId: first.conversationId,
      });
      const started = () =>
        calls.filter(
          (call) =>
            isCheckRun(call) && call.results.length === 0 && /^Neap tide/.test(sentenceOf(call)),
        );
      await vi.waitFor(() => expect(started().length).toBeGreaterThan(0), { timeout: 20_000 });
      const sent = started().length;
      expect(sent).toBeLessThan(longer.length);
      const request = progress.find((event) => event.request !== firstCheck.request)?.request;
      if (how === "reject") await resolveChanges(client, "reject");
      else {
        // An Undo of the applied rewrite: the Note as it was before it, in one step.
        await resolveChanges(client, "accept");
        editMind(client, () => before);
      }
      await client.settled();

      expect(await checkEnds(progress, request)).toMatchObject({ running: false });
      release();
      await client.settled();
      expect(started()).toHaveLength(sent);
      expect(shownWithChanges(client)).toEqual([
        "Harbour",
        "Boats moor by the quay.",
        "Tides",
        "Spring tides come at new and full moon ⟨found⟩.",
      ]);
      expect(
        (await marksIn(core, client)).map(({ sentence, check }) => [
          sentence,
          check.state,
          check.request,
        ]),
      ).toEqual(marksBefore);
      const [change] = changesIn(await storedAnswer(core, second.conversationId, second.id));
      expect(change?.selfCheck).toMatchObject({ undone: true });
    },
  );

  // protects=a rewrite in place rejected while its check is still being readied, before it marks anything, is never checked: the words brought back keep the mark they had, nothing of it is sent, and the Answer has no line for it (#2830); fails_when=its first marks land on the words brought back and end there as stopped, or its sentences are sent for a write that is gone; no_claim=how long readying takes.
  test("a rewrite in place rejected while its check is readied leaves the words brought back as they were", async () => {
    const keys = holdingKeychain();
    const calls: ModelCall[] = [];
    const model = rewritingModel(
      {
        first: `## Tides\n\n${MOON.slice(0, -1)} [^1].`,
        longer: "## Tides\n\nSpring tides come twice a month, at new and full moon [^1].",
        rewrites: () => keys.hold(),
      },
      calls,
    );
    const { core, folderId, mindId, client } = await harbour(
      model,
      { kind: "anthropic", modelId: "claude-haiku-5-5" },
      undefined,
      false,
      undefined,
      keys.keychain,
    );
    const progress: WrittenCheckProgress[] = [];
    core.on("writtenCheck.progress", (event) => progress.push(event));
    const scope = { folderIds: [folderId], tagIds: [], documentIds: [] };
    const first = await askAssistant(core, { text: ASK.into, mindId, scope });
    const firstCheck = await checkEnds(progress);
    await resolveChanges(client, "accept");
    await client.settled();
    const marksBefore = (await marksIn(core, client)).map(({ sentence, check }) => [
      sentence,
      check.state,
      check.request,
    ]);
    expect(marksBefore).toEqual([
      ["Spring tides come at new and full moon .", "supported", firstCheck.request],
    ]);

    const answering = askAndEnd(core, {
      text: LONGER,
      mindId,
      scope,
      conversationId: first.conversationId,
    });
    // The rewrite waits in the Note while its check is readied with the model's key.
    await vi.waitFor(
      () => {
        expect(keys.held()).toBeGreaterThan(0);
        expect(shownWithChanges(client).join("\n")).toContain("twice a month");
      },
      { timeout: 20_000, interval: 5 },
    );
    await resolveChanges(client, "reject");
    keys.release();
    const second = await answering;
    await vi.waitFor(
      () => {
        const begun = new Set(progress.map((event) => event.request));
        const ended = new Set(progress.filter((each) => !each.running).map((each) => each.request));
        expect([...begun].every((request) => ended.has(request))).toBe(true);
      },
      { timeout: 20_000, interval: 10 },
    );
    await client.settled();

    expect(shownWithChanges(client)).toEqual([
      "Harbour",
      "Boats moor by the quay.",
      "Tides",
      "Spring tides come at new and full moon ⟨found⟩.",
    ]);
    expect(
      (await marksIn(core, client)).map(({ sentence, check }) => [
        sentence,
        check.state,
        check.request,
      ]),
    ).toEqual(marksBefore);
    expect(
      calls.filter((call) => isCheckRun(call) && sentenceOf(call).includes("twice a month")),
    ).toEqual([]);
    const [change] = changesIn(await storedAnswer(core, second.conversationId, second.id));
    expect(change?.selfCheck).toBeUndefined();
  });

  // protects=a newer write over the same Blocks takes their sentences over from the older write's check still running: the older check's late verdicts never land on the newer text (#2830); fails_when=the older check's result overwrites the newer check's mark, so a sentence reads as checked by a check of words it no longer has; no_claim=which verdicts the judge gives.
  test("a newer write over the same Blocks takes their sentences over from the older check", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let paused = false;
    const calls: ModelCall[] = [];
    const model = rewritingModel(
      {
        first: `## Tides\n\n${MOON.slice(0, -1)} [^1]. ${UNBACKED} [^1].`,
        longer: `## Tides\n\n${MOON.slice(0, -1)} [^1]. ${UNBACKED} [^1]. Neap tide 1 is twice as strong [^1].`,
        // Only the first write's check of the neap sentence waits: the newer write's goes on.
        check: (call) => {
          if (paused || sentenceOf(call) !== `${UNBACKED} .` || call.results.length > 0)
            return null;
          paused = true;
          return { ...checkReply(call, PLANS), pause: { after: 0, until: held } };
        },
      },
      calls,
    );
    const { core, folderId, mindId, client } = await harbour(
      model,
      { kind: "anthropic", modelId: "claude-haiku-5-5" },
      undefined,
    );
    const progress: WrittenCheckProgress[] = [];
    core.on("writtenCheck.progress", (event) => progress.push(event));
    const scope = { folderIds: [folderId], tagIds: [], documentIds: [] };
    const first = await askAndEnd(core, { text: ASK.into, mindId, scope });
    const older = progress[0]?.request ?? "";
    await vi.waitFor(() => expect(paused).toBe(true), { timeout: 20_000 });
    await resolveChanges(client, "accept");
    await client.settled();

    await askAndEnd(core, {
      text: LONGER,
      mindId,
      scope,
      conversationId: first.conversationId,
    });
    const newer = progress.find((event) => event.request !== older)?.request ?? "";
    expect(await checkEnds(progress, newer)).toMatchObject({ done: 3, total: 3 });
    release();
    expect(await checkEnds(progress, older)).toMatchObject({ running: false });
    await client.settled();

    expect(
      (await marksIn(core, client)).map(({ sentence, check }) => [
        sentence,
        check.state,
        check.request === newer,
      ]),
    ).toEqual([
      ["Spring tides come at new and full moon .", "supported", true],
      ["Neap tides are twice as strong .", "unsupported", true],
      ["Neap tide 1 is twice as strong .", "unsupported", true],
    ]);
  });

  // protects=Retry or regenerate while a write's check runs leaves the Answer written again with its own calls: the old turn's check, ending after, never writes the old turn's calls over them (#2830); fails_when=the old check's end puts the old Answer's write card on the new Answer; no_claim=what the new Answer says.
  test("an Answer written again while its write's check runs keeps its own calls once that check ends", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let answers = 0;
    const model = scriptedModel(
      (call): ScriptedReply => {
        if (isCheckRun(call))
          return call.results.length === 0
            ? { ...checkReply(call, PLANS), pause: { after: 0, until: held } }
            : checkReply(call, PLANS);
        const { results } = call;
        if (results.length === 0) answers++;
        // Written again, the Answer only replies.
        if (answers > 1) return { text: "Nothing to add." };
        const search = results.find((result) => result.tool === "search_documents");
        if (!search)
          return { calls: [{ tool: "search_documents", input: { query: "spring tides" } }] };
        if (!results.some((result) => result.tool === "cite")) {
          const [passage] = shownPassages(search.text);
          const citations = [{ marker: 1, passage: passage?.id, quote: MOON }];
          return { calls: [{ tool: "cite", input: { citations } }] };
        }
        if (!results.some((result) => result.tool === "add_to_mind")) {
          const content = `${MOON.slice(0, -1)} [^1]. ${UNBACKED} [^1].`;
          return { calls: [{ tool: "add_to_mind", input: { content } }] };
        }
        return { text: "Wrote it from your Documents." };
      },
      { generate: checkGenerate(PLANS) },
    );
    const { core, folderId, mindId, client } = await harbour(
      model,
      { kind: "anthropic", modelId: "claude-haiku-5-5" },
      undefined,
    );
    const progress: WrittenCheckProgress[] = [];
    core.on("writtenCheck.progress", (event) => progress.push(event));
    const scope = { folderIds: [folderId], tagIds: [], documentIds: [] };
    const first = await askAndEnd(core, { text: ASK.into, mindId, scope });
    expect(changesIn(await storedAnswer(core, first.conversationId, first.id))).toHaveLength(1);
    // The window applies what was asked for: written again, the Answer keeps it.
    await resolveChanges(client, "accept");
    await client.settled();

    const again = await core.regenerateConversationAnswer({
      conversationId: first.conversationId,
      answerId: first.id,
    });
    if (!again.asked) throw new Error("Not asked again.");
    await answerEnded(core, again.answerId);
    expect(progress.at(-1)).toMatchObject({ running: true });
    release();
    await checkEnds(progress);
    await client.settled();

    const stored = await storedAnswer(core, first.conversationId, first.id);
    expect(stored.text).toBe("Nothing to add.");
    expect(changesIn(stored)).toEqual([]);
  });

  // protects=a new message sent while the check of what the last Answer wrote runs is answered at once; its own write's check waits its turn, saying so, and both finish in order (#2830's acceptance, beside its smoke spec; one write's check at a time, #2532); fails_when=the new Question waits for the check, the new Answer stops it, or the second check runs beside the first; no_claim=what the window shows.
  test("a message sent during the check is answered, its write's check waits its turn, and both finish", async () => {
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = 0;
    const { core, client, progress, mindId, folderId, asked } = await writeAndReply({
      content: `Spring tides come at new and full moon [^1]. ${UNBACKED} [^1].`,
      into: true,
      cloud: { kind: "anthropic", modelId: "claude-haiku-5-5" },
      // Only the first write's two sentences wait: the next Answer writes again.
      check: (call) =>
        call.results.length === 0 && held++ < 2
          ? { ...checkReply(call, PLANS), pause: { after: 0, until: slow } }
          : null,
    });
    const first = progress[0]?.request ?? "";

    const next = await askAndEnd(core, {
      text: "Thanks. What else is in the tides file?",
      mindId,
      conversationId: asked.conversation.id,
      scope: { folderIds: [folderId], tagIds: [], documentIds: [] },
    });
    expect(
      progress.filter((event) => event.request === first).every((event) => event.running),
    ).toBe(true);
    const second = progress.find((event) => event.request !== first);
    expect(second).toMatchObject({ done: 0, total: 2, running: true, waiting: true });
    expect(held).toBe(2);

    release();
    expect(await checkEnds(progress, first)).toMatchObject({ done: 2, total: 2 });
    expect(await checkEnds(progress, second?.request)).toMatchObject({ done: 2, total: 2 });
    const events = progress.filter((event) => event.request === second?.request);
    expect(events.map((event) => event.waiting)).toEqual([
      true,
      ...events.slice(1).map(() => false),
    ]);
    expect(held).toBe(4);
    await client.settled();
    expect(statesIn(client)).toEqual(["supported", "unsupported", "supported", "unsupported"]);
    const answered = await storedAnswer(core, next.conversationId, next.id);
    expect(changesIn(answered)[0]?.selfCheck).toMatchObject({ checked: 2, failed: 0 });
  });

  /** Two writes, one after the other, of eight sentences each, every first request of a check held until `open`. */
  async function twoWrites() {
    const first = Array.from(
      { length: 8 },
      (_, index) => `Neap tide ${index + 1} is twice as strong [^1].`,
    );
    const second = Array.from(
      { length: 8 },
      (_, index) => `Tide pool ${index + 1} holds crabs [^1].`,
    );
    let answers = 0;
    let holding = true;
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const started: string[] = [];
    let inFlight = 0;
    let most = 0;
    const model = scriptedModel(
      (call): ScriptedReply => {
        if (isCheckRun(call)) {
          const reply = checkReply(call, PLANS);
          if (call.results.length > 0 || "error" in reply) return reply;
          started.push(sentenceOf(call));
          inFlight++;
          most = Math.max(most, inFlight);
          const done = (holding ? gate : Promise.resolve()).then(() => {
            inFlight--;
          });
          return { ...reply, pause: { after: 0, until: done } };
        }
        const { results } = call;
        if (results.length === 0) answers++;
        const search = results.find((result) => result.tool === "search_documents");
        if (!search)
          return { calls: [{ tool: "search_documents", input: { query: "spring tides" } }] };
        if (!results.some((result) => result.tool === "cite")) {
          const [passage] = shownPassages(search.text);
          const citations = [{ marker: 1, passage: passage?.id, quote: MOON }];
          return { calls: [{ tool: "cite", input: { citations } }] };
        }
        if (!results.some((result) => result.tool === "add_to_mind")) {
          const content = (answers > 1 ? second : first).join(" ");
          return { calls: [{ tool: "add_to_mind", input: { content } }] };
        }
        return { text: "Wrote it from your Documents." };
      },
      { generate: checkGenerate(PLANS) },
    );
    const { core, folderId, mindId, client } = await harbour(
      model,
      { kind: "anthropic", modelId: "claude-haiku-5-5" },
      undefined,
    );
    const progress: WrittenCheckProgress[] = [];
    core.on("writtenCheck.progress", (event) => progress.push(event));
    const scope = { folderIds: [folderId], tagIds: [], documentIds: [] };
    const one = await askAndEnd(core, { text: ASK.into, mindId, scope });
    await vi.waitFor(() => expect(inFlight).toBe(6), { timeout: 20_000, interval: 5 });
    const two = await askAndEnd(core, {
      text: "Add a note on tide pools too",
      mindId,
      scope,
      conversationId: one.conversationId,
    });
    const requestOf = (index: number) => [...new Set(progress.map((each) => each.request))][index];
    await vi.waitFor(() => expect(requestOf(1)).toBeDefined(), { timeout: 20_000, interval: 5 });
    const isSecond = (sentence: string) => sentence.startsWith("Tide pool");
    return {
      core,
      client,
      progress,
      one,
      two,
      firstRequest: requestOf(0) ?? "",
      secondRequest: requestOf(1) ?? "",
      sentOfSecond: () => started.filter(isSecond).length,
      started,
      isSecond,
      inFlight: () => inFlight,
      most: () => most,
      open: () => {
        holding = false;
        open();
      },
    };
  }

  // protects=a turn's writes are checked one at a time, and no more than six requests are out at once in all (#1635, #2532: twelve missed the first-verdict bar); a write that waits its turn says so, never a count that stands still, and the Note's count already holds its sentences (#2830); fails_when=a second write's check runs beside the first, more than six requests are out at once, or the waiting write shows a count; no_claim=how fast a real provider answers.
  test("a second write's check waits for the first, saying so, and six requests at most are out at once", async () => {
    const writes = await twoWrites();
    const { progress, firstRequest, secondRequest } = writes;

    expect(progress.find((each) => each.request === secondRequest)).toMatchObject({
      done: 0,
      total: 8,
      running: true,
      waiting: true,
    });
    expect(writes.inFlight()).toBe(6);
    expect(writes.sentOfSecond()).toBe(0);

    writes.open();
    expect(await checkEnds(progress, firstRequest)).toMatchObject({ done: 8, total: 8 });
    expect(await checkEnds(progress, secondRequest)).toMatchObject({ done: 8, total: 8 });
    expect(writes.most()).toBe(6);
    const firstOfSecond = writes.started.findIndex(writes.isSecond);
    expect(firstOfSecond).toBe(8);
    expect(writes.started.slice(firstOfSecond).every(writes.isSecond)).toBe(true);
  });

  // protects=Stop on the Note's badge, or an Undo of the write, ends a check still waiting its turn: nothing is ever sent for it, and its sentences say Not checked, stopped, or go with the write (#2830); fails_when=the waiting check runs once the first ends, or its sentences stay shown as being checked; no_claim=how the badge looks.
  test.each(["stop", "undo"] as const)(
    "a %s while a write's check waits its turn ends it with nothing sent",
    async (how) => {
      const writes = await twoWrites();
      const { core, client, progress, firstRequest, secondRequest, two } = writes;
      await client.settled();
      if (how === "stop") await core.cancelCheck(secondRequest);
      else client.doc.transact(() => client.blocks.delete(client.blocks.length - 1, 1));
      await client.settled();
      expect(await checkEnds(progress, secondRequest)).toMatchObject({ running: false });

      writes.open();
      expect(await checkEnds(progress, firstRequest)).toMatchObject({ done: 8, total: 8 });
      await client.settled();
      expect(writes.sentOfSecond()).toBe(0);
      const marks = (await marksIn(core, client)).filter(({ sentence }) =>
        writes.isSecond(sentence),
      );
      const [change] = changesIn(await storedAnswer(core, two.conversationId, two.id));
      if (how === "stop") {
        expect(marks.map(({ check }) => [check.state, check.reason])).toEqual(
          Array.from({ length: 8 }, () => ["not-checked", "stopped"]),
        );
        expect(change?.selfCheck).toMatchObject({ checked: 0, failed: 8 });
      } else {
        expect(marks).toEqual([]);
        expect(change?.selfCheck).toMatchObject({ undone: true });
      }
    },
  );

  // protects=an opinion the older check's claims sort names after a newer write took that sentence over lands nowhere: neither the newer check's mark nor either count moves for it, and the stored count of what couldn't be checked never goes below zero (#2830); fails_when=the late sort takes the newer check's mark off the sentence, counts it left out a second time, or stores a negative count; no_claim=how a real model sorts.
  test("an older check's late sort leaves a sentence a newer write took over alone", async () => {
    let releaseSort: () => void = () => undefined;
    const sortHeld = new Promise<void>((resolve) => {
      releaseSort = resolve;
    });
    let sortsOfBoth = 0;
    const calls: ModelCall[] = [];
    const model = rewritingModel(
      {
        first: `## Tides\n\n${MOON.slice(0, -1)} [^1]. The harbour is quiet in winter. The quay is busy in summer.`,
        longer: `## Tides\n\n${MOON.slice(0, -1)} [^1]. The harbour is quiet in winter. The quay is busy in summer. Neap tide 1 is twice as strong [^1].`,
        generate: (call) => {
          if (!isSort(call)) return null;
          const both =
            call.prompt.includes("The harbour is quiet in winter") &&
            call.prompt.includes("The quay is busy in summer");
          if (!both) return judgesNothing(call);
          sortsOfBoth++;
          if (sortsOfBoth > 1) return judgesNothing(call);
          // The first write's sort comes back once the newer write has taken its sentences over.
          const sentences = [
            { number: 1, parts: [{ kind: "opinion", text: "The harbour is quiet in winter." }] },
            { number: 2, parts: [{ kind: "fact", text: "The quay is busy in summer." }] },
          ];
          return { text: JSON.stringify({ sentences }), until: sortHeld };
        },
      },
      calls,
    );
    const { core, folderId, mindId, client } = await harbour(
      model,
      { kind: "anthropic", modelId: "claude-haiku-5-5" },
      undefined,
    );
    const progress: WrittenCheckProgress[] = [];
    core.on("writtenCheck.progress", (event) => progress.push(event));
    const scope = { folderIds: [folderId], tagIds: [], documentIds: [] };
    const first = await askAndEnd(core, { text: ASK.into, mindId, scope });
    const older = progress[0]?.request ?? "";
    await vi.waitFor(() => expect(sortsOfBoth).toBe(1), { timeout: 20_000, interval: 5 });
    await resolveChanges(client, "accept");
    await client.settled();

    const second = await askAndEnd(core, {
      text: LONGER,
      mindId,
      scope,
      conversationId: first.conversationId,
    });
    const newer = progress.find((event) => event.request !== older)?.request ?? "";
    await vi.waitFor(() => expect(newer).not.toBe(""), { timeout: 20_000 });
    releaseSort();
    expect(await checkEnds(progress, older)).toMatchObject({ running: false });
    expect(await checkEnds(progress, newer)).toMatchObject({ done: 4, total: 4 });
    await client.settled();

    expect(
      (await marksIn(core, client)).map(({ sentence, check }) => [
        sentence,
        check.request === newer,
      ]),
    ).toEqual([
      ["Spring tides come at new and full moon .", true],
      ["The harbour is quiet in winter.", true],
      ["The quay is busy in summer.", true],
      ["Neap tide 1 is twice as strong .", true],
    ]);
    const [olderCheck] = changesIn(await storedAnswer(core, first.conversationId, first.id));
    expect(olderCheck?.selfCheck?.leftOut).toBe(0);
    expect(olderCheck?.selfCheck?.failed).toBeGreaterThanOrEqual(0);
    expect(
      progress.filter((event) => event.request === older).every((event) => event.total >= 0),
    ).toBe(true);
    const [newerCheck] = changesIn(await storedAnswer(core, second.conversationId, second.id));
    expect(newerCheck?.selfCheck).toMatchObject({
      checkable: 4,
      checked: 4,
      failed: 0,
      leftOut: 0,
    });
  });

  // protects=a sentence a newer write took over before its check began is never sent, and nothing about it is logged as a failed check (#2830); fails_when=its take-over is logged as "A check in Note … failed"; no_claim=what the newer check finds.
  test("a sentence taken over before its check began is neither sent nor logged as failed", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let paused = false;
    const errors = vi.spyOn(console, "error");
    try {
      const calls: ModelCall[] = [];
      const model = rewritingModel(
        {
          first: `## Tides\n\n${MOON.slice(0, -1)} [^1]. Neap tide 1 is twice as strong [^1]. Neap tide 2 is twice as strong [^1].`,
          longer: `## Tides\n\n${MOON.slice(0, -1)} [^1]. Neap tide 1 is twice as strong [^1]. Neap tide 2 is twice as strong [^1]. Neap tide 3 is twice as strong [^1].`,
          // A model on this computer checks one sentence at a time: the first one's check waits.
          check: (call) => {
            if (paused || call.results.length > 0) return null;
            paused = true;
            return { ...checkReply(call, PLANS), pause: { after: 0, until: held } };
          },
        },
        calls,
      );
      const { core, folderId, mindId, client } = await harbour(model, undefined, undefined);
      const progress: WrittenCheckProgress[] = [];
      core.on("writtenCheck.progress", (event) => progress.push(event));
      const scope = { folderIds: [folderId], tagIds: [], documentIds: [] };
      const first = await askAndEnd(core, { text: ASK.into, mindId, scope });
      const older = progress[0]?.request ?? "";
      await vi.waitFor(() => expect(paused).toBe(true), { timeout: 20_000 });
      await resolveChanges(client, "accept");
      await client.settled();
      const neapChecks = () =>
        calls.filter(
          (call) =>
            isCheckRun(call) &&
            call.results.length === 0 &&
            /^Neap tide [12] /.test(sentenceOf(call)),
        ).length;
      expect(neapChecks()).toBe(0);

      await askAndEnd(core, { text: LONGER, mindId, scope, conversationId: first.conversationId });
      const newer = progress.find((event) => event.request !== older)?.request ?? "";
      release();
      expect(await checkEnds(progress, older)).toMatchObject({ running: false });
      expect(await checkEnds(progress, newer)).toMatchObject({ done: 4, total: 4 });

      expect(neapChecks()).toBe(2);
      expect(
        errors.mock.calls.filter(([line]) => String(line).startsWith("A check in Note")),
      ).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });

  // protects=a verdict that comes back while the window writes one Block of a write again, the write's other Blocks staying, lands once that Block is back, its table's verdicts too (#2378, #2830); fails_when=the sentence's verdict is dropped because its Block alone was away, and it ends Not checked; no_claim=how often a window writes a Block again.
  test("a verdict whose Block alone is away while the window writes it again lands once it is back", async () => {
    let page: MindClient | null = null;
    let mind = "";
    let taken = false;
    let returned: () => void = () => undefined;
    const back = new Promise<void>((resolve) => {
      returned = resolve;
    });
    let putBack = Promise.resolve();
    const { core, change, client } = await write(
      {
        content: `${MOON.slice(0, -1)} [^1].\n\n| Region | Note |\n| --- | --- |\n| South | ${UNBACKED} [^1] |`,
        into: true,
        cloud: { kind: "anthropic", modelId: "claude-haiku-5-5" },
        check: (call, started) => {
          const connected = page;
          if (call.results.length > 0 || !connected) return null;
          // The table's cell waits until the paragraph is back, so the one verdict in between is the paragraph's.
          if (sentenceOf(call).includes("Neap tides")) {
            return { ...checkReply(call, PLANS), pause: { after: 0, until: back } };
          }
          if (taken) return null;
          taken = true;
          const before = readMind(connected).toJSON().content ?? [];
          // The paragraph the write added, the Block before its table.
          connected.doc.transact(() => connected.blocks.delete(connected.blocks.length - 2, 1));
          const removed = connected.settled();
          putBack = removed
            .then(() =>
              vi.waitFor(
                async () => {
                  const used = await started.listAiUse(mind);
                  expect(used.map((each) => each.kind)).toContain("sentence-checked");
                },
                { timeout: 20_000, interval: 5 },
              ),
            )
            .then(() => {
              editMind(connected, () => before);
              return connected.settled();
            })
            .then(returned);
          return { ...checkReply(call, PLANS), pause: { after: 0, until: removed } };
        },
      },
      ({ client: connected, mindId }) => {
        page = connected;
        mind = mindId;
      },
    );

    await putBack;
    expect(taken).toBe(true);
    expect(
      (await marksIn(core, client)).map(({ sentence, check }) => [sentence, check.state]),
    ).toEqual([
      ["Spring tides come at new and full moon .", "supported"],
      ["Neap tides are twice as strong", "unsupported"],
    ]);
    expect(change?.selfCheck).toMatchObject({ checkable: 2, checked: 2, failed: 0 });
  });

  // protects=Stop on the Answer while the check of its write is being readied, the write having landed, leaves its sentences Not checked, stopped, as a Stop mid-check does (#2710), with nothing sent; fails_when=they are left with no mark, which reads as checked, or are sent; no_claim=how long readying takes.
  test("a Stop while the check of a write is readied lands its sentences Not checked, stopped", async () => {
    const keys = holdingKeychain();
    const calls: ModelCall[] = [];
    let started: Core | null = null;
    const model = writingModel(
      {
        content: `Spring tides come at new and full moon [^1]. ${UNBACKED} [^1].`,
        into: true,
        writes: () => keys.hold(),
      },
      calls,
      () => started,
    );
    const { core, folderId, mindId, client } = await harbour(
      model,
      { kind: "anthropic", modelId: "claude-haiku-5-5" },
      undefined,
      false,
      undefined,
      keys.keychain,
    );
    started = core;
    const asked = await core.askInConversation({
      text: ASK.into,
      mindId,
      scope: { folderIds: [folderId], tagIds: [], documentIds: [] },
    });
    if (!asked.asked) throw new Error("Not asked.");
    await vi.waitFor(() => expect(keys.held()).toBeGreaterThan(0), {
      timeout: 20_000,
      interval: 5,
    });
    // The Stop ends the Answer once its call comes back, which is waiting on the key.
    const stopping = core.stopConversationAnswer({
      conversationId: asked.conversation.id,
      answerId: asked.answerId,
    });
    keys.release();
    await stopping;
    await vi.waitFor(
      async () =>
        expect(
          (await marksIn(core, client)).map(({ check }) => [check.state, check.reason]),
        ).toEqual([
          ["not-checked", "stopped"],
          ["not-checked", "stopped"],
        ]),
      { timeout: 20_000 },
    );
    expect(calls.filter(isCheckRun)).toEqual([]);
  });

  // protects=a check cut off by a crash says, on the next start, what its Note shows: the verdicts that had landed are counted checked, the rest not checked (#2830); fails_when=the line says every sentence couldn't be checked over a Note that shows verdicts; no_claim=what the window draws.
  test("after a crash mid-check, the next start counts the verdicts that had landed", async () => {
    let paused = false;
    const calls: ModelCall[] = [];
    const model = rewritingModel(
      {
        first: `## Tides\n\n${MOON.slice(0, -1)} [^1]. ${UNBACKED} [^1].`,
        longer: "",
        // One sentence at a time on this computer: the second one's check never comes back.
        check: (call) => {
          if (sentenceOf(call) !== `${UNBACKED} .` || call.results.length > 0 || paused)
            return null;
          paused = true;
          return {
            ...checkReply(call, PLANS),
            pause: { after: 0, until: new Promise(() => undefined) },
          };
        },
      },
      calls,
    );
    const { core, folderId, mindId, client, dataDir } = await harbour(model, undefined, undefined);
    const progress: WrittenCheckProgress[] = [];
    core.on("writtenCheck.progress", (event) => progress.push(event));
    const scope = { folderIds: [folderId], tagIds: [], documentIds: [] };
    const answer = await askAndEnd(core, { text: ASK.into, mindId, scope });
    await vi.waitFor(() => expect(progress.at(-1)?.done).toBe(1), { timeout: 20_000 });
    await vi.waitFor(() => expect(paused).toBe(true), { timeout: 20_000 });
    await client.settled();

    // The app stops here without ending the check, as a crash does: a second start reads the store.
    const again = startCore(dataDir, { createChatModel: scriptedModels(model).createChatModel });
    try {
      const { messages } = await again.getConversation(answer.conversationId);
      const stored = messages.find((each) => each.id === answer.id);
      const [change] = stored?.kind === "answer" ? changesIn(stored) : [];
      expect(change?.selfCheck).toMatchObject({ checkable: 2, checked: 1, failed: 1 });
      expect(change?.selfCheck).not.toHaveProperty("running");
      const page = await connectToMind(again, mindId);
      await page.settled();
      const verdicts = (await marksIn(again, page)).filter(
        ({ check }) =>
          check.request === change?.selfCheck?.request &&
          check.state !== "not-checked" &&
          check.state !== "checking",
      );
      expect(verdicts.map(({ sentence }) => sentence)).toEqual([
        "Spring tides come at new and full moon .",
      ]);
    } finally {
      again.close();
    }
  });

  // protects=every request a write's check sends is recorded as the written check's, also those sent after the reply, so the time it takes is read whole (#1624, #2532); fails_when=a check request after the reply is recorded under no step, or under the Answer alone; no_claim=how long a real check takes.
  test("every request of a write's check is recorded as the written check's, after the reply too", async () => {
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    let dataDirOf = "";
    let endedAt = "";
    const calls: ModelCall[] = [];
    let started: Core | null = null;
    const model = writingModel(
      {
        content: `Spring tides come at new and full moon [^1]. ${UNBACKED} [^1].`,
        into: true,
        cloud: { kind: "anthropic", modelId: "claude-haiku-5-5" },
        check: (call) =>
          call.results.length === 0
            ? { ...checkReply(call, PLANS), pause: { after: 0, until: slow } }
            : null,
      },
      calls,
      () => started,
    );
    const { core, folderId, mindId, dataDir } = await harbour(
      model,
      { kind: "anthropic", modelId: "claude-haiku-5-5" },
      undefined,
    );
    started = core;
    dataDirOf = dataDir;
    const progress: WrittenCheckProgress[] = [];
    core.on("writtenCheck.progress", (event) => progress.push(event));
    const answer = await askAndEnd(core, {
      text: ASK.into,
      mindId,
      scope: { folderIds: [folderId], tagIds: [], documentIds: [] },
    });
    endedAt = new Date().toISOString();
    release();
    await checkEnds(progress);
    expect(answer.id).not.toBe("");
    core.close();

    const rows = queryDatabase<{
      step: string | null;
      data_flow: string | null;
      started_at: string;
    }>(
      dataDirOf,
      "SELECT step, data_flow, started_at FROM ai_timings WHERE data_flow = 'checks' ORDER BY started_at",
    );
    expect(rows.some((row) => row.started_at > endedAt)).toBe(true);
    expect(rows.every((row) => row.step === "written-check")).toBe(true);
  });

  // protects=once the Note refuses an edit, no further mark is tried, even after an earlier edit failed for another reason (#2532); fails_when=the first failure kept for the report hides the refusal and a later mark is tried again; no_claim=what makes an edit fail.
  test("a refused edit after another failure still stops every later mark", async () => {
    let page: MindClient | null = null;
    let newer = false;
    const edits = failOneMark();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { calls } = await write(
        {
          content: `${MOON.slice(0, -1)} [^1].\n\n${UNBACKED} [^1].\n\nThe harbour office posts the times [^1].`,
          into: true,
          check: (call) => {
            const client = page;
            if (call.results.length > 0 || !client) return null;
            edits.arm();
            if (sentenceOf(call) !== `${UNBACKED} .` || newer) return null;
            // A newer version writes the Note once the first mark has failed for another reason.
            newer = true;
            client.doc
              .getMap(MIND_SETTINGS_FIELD)
              .set(CONTENT_SCHEMA_VERSION_KEY, CONTENT_SCHEMA_VERSION + 1);
            return { ...checkReply(call, PLANS), pause: { after: 0, until: client.settled() } };
          },
        },
        ({ client }) => {
          page = client;
        },
      );
      edits.restore();

      expect(calls.filter((call) => isCheckRun(call) && call.results.length === 0)).toHaveLength(3);
      const refused = errors.mock.calls.filter(([line]) =>
        String(line).includes("marks couldn't land"),
      );
      expect(refused.map(([, error]) => (error instanceof Error ? error.name : null))).toEqual([
        "Error",
        "MindReadOnlyError",
      ]);
    } finally {
      edits.restore();
      errors.mockRestore();
    }
  });

  // protects=a landing that fails on a Note that still takes edits leaves the table's marks to land after every check before the check reports it (#2532); fails_when=the check stops before the last edit, and the table's sentence lands unmarked; no_claim=what makes an edit fail.
  test("a failed landing still lets a table's marks land before the check reports it", async () => {
    const edits = failOneMark();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { core, client } = await write({
        content: `${MOON.slice(0, -1)} [^1].\n\n| Region | Note |\n| --- | --- |\n| North | ${UNBACKED} [^1] |`,
        into: true,
        check: (call) => {
          // Only the paragraph's mark fails, once: the table's lands in the last edit.
          if (sentenceOf(call) !== `${UNBACKED} .`) edits.arm();
          return null;
        },
      });
      edits.restore();

      const marks = await marksIn(core, client);
      expect(marks.map(({ sentence, check }) => [sentence, check.state])).toEqual([
        ["Spring tides come at new and full moon .", "not-checked"],
        [UNBACKED, "unsupported"],
      ]);
      expect(
        errors.mock.calls.filter(([line]) => String(line).includes("couldn't be checked:")),
      ).toHaveLength(1);
    } finally {
      edits.restore();
      errors.mockRestore();
    }
  });

  // protects=words the User types into what the assistant wrote while the check runs stay: each sentence is marked only on its words as they are, and one the User changed shows it needs a check again; fails_when=the User's words vanish, or a changed sentence shows the verdict of words it no longer has; no_claim=none beyond protects.
  test("words the User types while the check runs stay, and a sentence they changed shows it needs a check", async () => {
    let client: MindClient | null = null;
    const { core } = await write(
      {
        content: `${OVERSTATED} [^1].\n\nThe harbour office posts the times.\n\n${UNBACKED} [^1].`,
        into: true,
        during: async () => {
          const typing = client;
          if (!typing) return;
          await typing.settled();
          typeInto(typing, 3, 0, "Today ");
          typeInto(typing, 4, 0, "All ");
          await typing.settled();
        },
      },
      ({ client: connected }) => {
        client = connected;
      },
    );
    const page = client as MindClient | null;
    if (!page) throw new Error("No client.");
    await page.settled();

    expect(shownWithChanges(page)).toEqual([
      "Harbour",
      "Boats moor by the quay.",
      `+ ${OVERSTATED} ⟨found⟩.`,
      "+ Today The harbour office posts the times.",
      "+ All Neap tides are twice as strong ⟨found⟩.",
    ]);
    const marks = await marksIn(core, page);
    expect(marks.map(({ sentence, shown }) => [sentence, shown.state])).toEqual([
      [`${OVERSTATED} .`, "unsupported"],
      ["Today The harbour office posts the times.", "needs-recheck"],
      ["All Neap tides are twice as strong .", "needs-recheck"],
    ]);
  });

  // protects=a sentence with a Citation is checked even when it is too short to make a claim (#1909), as "€12 million" in a table; fails_when=isClaim leaves it unchecked; no_claim=the verdict.
  test("a short sentence with a Citation is checked", async () => {
    const { core, change, client } = await write({ content: "## Tides\n\n€12 million [^1]." });

    expect(change?.selfCheck).toMatchObject({
      checkable: 1,
      cited: 1,
      sent: 1,
      checked: 1,
      failed: 0,
    });
    const marks = await marksIn(core, client);
    expect(marks.map(({ sentence, shown }) => [sentence, shown.state])).toEqual([
      ["€12 million .", "unsupported"],
    ]);
  });

  // protects=a cited table cell with a figure is checked even when the sort names no fact for it: Claude Haiku 5.5 named a bare cell an opinion or no claim, and the write landed no check on it at all (#2719); fails_when=an empty or opinion-only sort skips the figure's check and the cell lands unmarked; no_claim=the verdict the check gives.
  test("a cited figure in a table cell is checked even when the sort names no fact", async () => {
    const { core, change, client } = await write({
      content: "| Item | 2024 |\n| --- | --- |\n| Revenue | 100 [^1] |",
      generated: () => undefined,
    });
    expect(change?.selfCheck).toMatchObject({ cited: 1, sent: 1, checked: 1, failed: 0 });
    const marks = await marksIn(core, client);
    expect(marks.map(({ sentence, shown }) => [sentence, shown.state])).toEqual([
      ["100", "unsupported"],
    ]);
  });

  // protects=a table's heading cell with a Citation is a heading, not a claim (#2378); fails_when=the heading is sent to a check and lands unsupported; no_claim=whether a real check would misread a heading.
  test("a table's heading cell with a Citation is a heading, not a claim to check", async () => {
    const { core, change, client } = await write({
      content: "| Region | Revenue [^1] |\n| --- | --- |\n| North | 10 |",
    });
    expect(change).not.toHaveProperty("selfCheck");
    expect(await marksIn(core, client)).toEqual([]);
    const headers: string[] = [];
    readMind(client).descendants((node) => {
      if (node.type.name !== "tableHeader") return true;
      node.descendants((cell) => {
        if (cell.type.name === "citation") headers.push(cell.attrs.documentId ?? "");
        return true;
      });
      return true;
    });
    expect(headers).toEqual([expect.any(String)]);
  });

  test("a nested proposed write resolves Id. against its own preceding sentence", async () => {
    const { core, change, client } = await write({
      into: true,
      record: RECORD_FILE,
      content: `> ${RECORD_SOURCE} [^1].\n> ${RECORD_NEXT} [^2].`,
    });

    expect(change?.selfCheck).toMatchObject({ cited: 2, sent: 2, checked: 2, failed: 0 });
    const next = (await marksIn(core, client)).find(({ sentence }) =>
      sentence.includes(RECORD_NEXT),
    );
    expect(next?.check.recordCites?.[0]).toMatchObject({
      raw: "Id. at 2",
      outcome: "supported",
      location: { kind: "page", from: 2, to: 2 },
    });
  });

  test("identical proposed Id. sentences never borrow a later occurrence", async () => {
    const { core, change, client } = await write({
      into: true,
      record: RECORD_FILE,
      content: `> ${RECORD_SOURCE} [^1].\n> ${RECORD_NEXT} [^2].\n> ${RECORD_NEXT} [^2].`,
    });

    expect(change?.selfCheck).toMatchObject({ cited: 3, sent: 3, checked: 3, failed: 0 });
    const next = (await marksIn(core, client)).filter(({ sentence }) =>
      sentence.includes(RECORD_NEXT),
    );
    expect(next).toHaveLength(2);
    for (const { check } of next) {
      expect(check.recordCites?.[0]).toMatchObject({ raw: "Id. at 2", outcome: "supported" });
    }
  });

  // protects=normalized request equivalence: a write's checks send the same requests whichever order they end in, ids, times and cache keys put by, as marks land while other sentences are still checked (#2532); fails_when=a mark that lands mid-run changes what a later check sends; no_claim=the final marks.
  test.each([
    {
      name: "paragraphs and a table",
      writing: {
        content: `${OVERSTATED} [^1]. ${UNBACKED} [^1].\n\n| Region | Note |\n| --- | --- |\n| North | ${MOON.slice(0, -1)} [^1] |`,
        into: true,
      },
      sentences: {
        first: `${OVERSTATED} .`,
        others: [`${UNBACKED} .`, MOON.slice(0, -1)],
        checked: 3,
      },
    },
    {
      name: "an Id. after its record cite",
      writing: {
        content: `> ${RECORD_SOURCE} [^1]. ${RECORD_NEXT} [^2]. ${RECORD_NEXT} [^2].`,
        into: true,
        record: RECORD_FILE,
      },
      sentences: { first: `${RECORD_SOURCE} .`, others: [`${RECORD_NEXT} .`], checked: 3 },
    },
    {
      name: "two identical sentences",
      writing: { content: `${OVERSTATED} [^1]. ${UNBACKED} [^1]. ${UNBACKED} [^1].`, into: true },
      sentences: { first: `${OVERSTATED} .`, others: [`${UNBACKED} .`], checked: 3 },
    },
  ])(
    "a write's checks send the same requests whichever order they end in ($name)",
    async ({ writing, sentences }) => {
      const inOrder = await checkRequestsOf(writing, sentences, false);
      const reversed = await checkRequestsOf(writing, sentences, true);

      const { first, others } = sentences;
      const ended = (verdicts: readonly string[], sentence: string) => verdicts.indexOf(sentence);
      for (const other of others) {
        expect(ended(inOrder.verdicts, first)).toBeLessThan(ended(inOrder.verdicts, other));
        expect(ended(reversed.verdicts, other)).toBeLessThan(ended(reversed.verdicts, first));
      }
      expect(inOrder.requests.length).toBeGreaterThan(sentences.checked);
      expect(reversed.requests).toEqual(inOrder.requests);
    },
  );

  // protects=two identical sentences in one paragraph each get their own mark; fails_when=both marks go on the second sentence, the first left unmarked; no_claim=none beyond protects.
  test("two identical sentences each get their own mark", async () => {
    const { client } = await write({
      content: `${OVERSTATED} [^1]. ${UNBACKED} [^1]. ${UNBACKED} [^1].`,
    });

    const spans = claimSpans(readMind(client)).filter((span) =>
      span.sentence.text.startsWith(UNBACKED),
    );
    expect(spans.map((span) => span.check.state)).toEqual(["unsupported", "unsupported"]);
    expect(new Set(spans.map((span) => span.sentence.from)).size).toBe(2);
  });

  test("an uncited unresolved cite between proposed sentences clears Id.'s referent", async () => {
    const { core, client } = await write({
      into: true,
      record: RECORD_FILE,
      content: `> ${RECORD_SOURCE} [^1].\n> PL-999999.\n> ${RECORD_NEXT} [^2].`,
    });

    const next = (await marksIn(core, client)).find(({ sentence }) =>
      sentence.includes(RECORD_NEXT),
    );
    expect(next?.check.recordCites?.[0]).toMatchObject({ raw: "Id. at 2", outcome: "not-found" });
  });

  test("a proposed Id. resolves against a record item already in the Note", async () => {
    const { core, client } = await write(
      {
        into: true,
        record: RECORD_FILE,
        content: `> ${RECORD_NEXT} [^1].`,
      },
      async ({ core, client, mindId }) => {
        const text = `${RECORD_SOURCE}.`;
        editMind(client, (blocks) => [
          ...blocks,
          {
            type: "paragraph",
            attrs: { id: "existing-record-source" },
            content: [{ type: "text", text }],
          },
        ]);
        await client.settled();
        await core.checkSentences({
          requestId: "existing-record-source",
          mindId,
          action: "check-against-documents",
          from: { blockId: "existing-record-source", offset: 0 },
          to: { blockId: "existing-record-source", offset: text.length },
        });
      },
    );

    const next = (await marksIn(core, client)).find(({ sentence }) =>
      sentence.includes(RECORD_NEXT),
    );
    expect(next?.check.recordCites?.[0]).toMatchObject({
      raw: "Id. at 2",
      outcome: "supported",
      location: { kind: "page", from: 2, to: 2 },
    });
  });

  // protects=text written before `cite` recorded its markers is checked once its Citations go in after the Run: each cited sentence lands marked and the card counts it (#1635); fails_when=it lands with found Citations and no mark, which reads as checked, or the card has no check; no_claim=how often a real model writes before it cites.
  test.each(["beside", "next-step"] as const)(
    "a write made before cite recorded its markers is checked once they go in (%s)",
    async (citesAfter) => {
      const { core, calls, change, client } = await write({
        content: `## Tides\n\nSpring tides come at new and full moon [^1].\n\n${UNBACKED} [^1].`,
        citesAfter,
      });

      expect(shownWithChanges(client)).toEqual([
        "+ Tides",
        "+ Spring tides come at new and full moon ⟨found⟩.",
        "+ Neap tides are twice as strong ⟨found⟩.",
      ]);
      const marks = await marksIn(core, client);
      expect(marks.map(({ sentence, shown }) => [sentence, shown.state])).toEqual([
        ["Spring tides come at new and full moon .", "supported"],
        ["Neap tides are twice as strong .", "unsupported"],
      ]);
      expect(change).toMatchObject({ created: true, proposals: 3, cited: 2 });
      expect(change?.selfCheck).toMatchObject({ cited: 2, sent: 2, checked: 2, failed: 0 });
      expect(calls.filter((call) => isCheckRun(call) && call.results.length === 0)).toHaveLength(2);
    },
  );

  // protects=a write made before cite, in a Run that then fails, lands its cited sentences not checked, saying in English and Chinese that the Answer stopped with an error before the check, and sends no check to the provider that failed (#1635); fails_when=they land unmarked, which reads as checked, the line says the check failed or nothing, or a check is sent; no_claim=the words of the Answer's own failure.
  test("a write made before cite in a Run that fails lands not checked, sending nothing", async () => {
    const { core, calls, change, client } = await write({
      content: "## Tides\n\nSpring tides come at new and full moon [^1].",
      citesAfter: "next-step",
      replyFails: true,
      ends: "failed",
    });

    expect(shownWithChanges(client)).toEqual([
      "+ Tides",
      "+ Spring tides come at new and full moon ⟨found⟩.",
    ]);
    const marks = await marksIn(core, client);
    expect(marks.map(({ check }) => [check.state, check.reason])).toEqual([
      ["not-checked", "answer-failed"],
    ]);
    const shown = (language: "en" | "zh-CN") =>
      marks.map(({ check }) =>
        check.state === "not-checked" && check.reason
          ? reasonText(
              (key: MessageKey, params?: MessageParams) => translate(language, key, params),
              language,
              check.reason,
              check.detail,
            )
          : null,
      );
    expect(shown("en")).toEqual(["The Answer stopped with an error before this was checked."]);
    expect(shown("zh-CN")).toEqual(["回答出错停止，这句话尚未核对。"]);
    expect(change?.selfCheck).toMatchObject({ cited: 1, sent: 1, checked: 0, failed: 1 });
    expect(calls.some(isCheckRun)).toBe(false);
  });

  // protects=a Note that refuses one write's Citations after the Run doesn't leave another write of the same Answer unchecked: the other is still checked and lands marked (#1635); fails_when=the refusal stops every after-Run check, so the other write's found Citations read as checked; no_claim=what makes a Note refuse edits other than a newer version.
  test("a Note that refuses one write's Citations after the Run leaves the other write checked", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      let harbourClient: MindClient | null = null;
      const calls: ModelCall[] = [];
      const model = scriptedModel(
        (call): ScriptedReply => {
          calls.push(call);
          if (isCheckRun(call)) return checkReply(call, PLANS);
          const { results } = call;
          const search = results.find((result) => result.tool === "search_documents");
          if (!search) {
            return { calls: [{ tool: "search_documents", input: { query: "spring tides" } }] };
          }
          if (!results.some((result) => result.tool === "create_mind")) {
            const content = "## Tides\n\nSpring tides come at new and full moon [^1].";
            return { calls: [{ tool: "create_mind", input: { title: "Tide notes", content } }] };
          }
          if (!results.some((result) => result.tool === "add_to_mind")) {
            return { calls: [{ tool: "add_to_mind", input: { content: `${UNBACKED} [^1].` } }] };
          }
          if (!results.some((result) => result.tool === "cite")) {
            // A newer version writes the Note in front: its Citations can't go in after the Run.
            harbourClient?.doc
              .getMap(MIND_SETTINGS_FIELD)
              .set(CONTENT_SCHEMA_VERSION_KEY, CONTENT_SCHEMA_VERSION + 1);
            const [passage] = shownPassages(search.text);
            const citations = [{ marker: 1, passage: passage?.id, quote: MOON }];
            return {
              calls: [{ tool: "cite", input: { citations } }],
              pause: { after: 0, until: harbourClient?.settled() ?? Promise.resolve() },
            };
          }
          return { text: "Wrote it from your Documents." };
        },
        { generate: judgesNothing },
      );
      const { core, folderId, mindId, client } = await harbour(model, undefined, undefined);
      harbourClient = client;

      const answer = await askAssistant(core, {
        text: "Add a short note on tides to this Mind and make a new note on them too",
        mindId,
        scope: { folderIds: [folderId], tagIds: [], documentIds: [] },
      });

      const made = changesIn(answer).find((change) => change.created);
      expect(made?.selfCheck).toMatchObject({ cited: 1, sent: 1, checked: 1 });
      const page = await connectToMind(core, made?.mindId ?? "");
      const marks = await marksIn(core, page);
      expect(marks.map(({ sentence, shown }) => [sentence, shown.state])).toEqual([
        ["Spring tides come at new and full moon .", "supported"],
      ]);
      expect(
        errors.mock.calls.some(([line]) => String(line).includes("couldn't go in (call")),
      ).toBe(true);
    } finally {
      errors.mockRestore();
    }
  });

  // protects=a write's check readied as the core closes goes no further: it reads nothing of the closed database, sends nothing and fails nothing (#2216, #2830); fails_when=it takes its scope from the closed database once readied, and fails; no_claim=what a check under way does as the core closes, which the Stop and quitting tests cover.
  test("a write's check readied as the core closes reads nothing after, sends nothing and fails nothing", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const keys = holdingKeychain();
      const calls: ModelCall[] = [];
      let started: Core | null = null;
      const model = writingModel(
        {
          content: `Spring tides come at new and full moon [^1]. ${UNBACKED} [^1].`,
          into: true,
          writes: () => keys.hold(),
        },
        calls,
        () => started,
      );
      const { core, folderId, mindId } = await harbour(
        model,
        { kind: "anthropic", modelId: "claude-haiku-5-5" },
        undefined,
        false,
        undefined,
        keys.keychain,
      );
      started = core;
      await core.askInConversation({
        text: ASK.into,
        mindId,
        scope: { folderIds: [folderId], tagIds: [], documentIds: [] },
      });
      await vi.waitFor(() => expect(keys.held()).toBeGreaterThan(0), {
        timeout: 20_000,
        interval: 5,
      });

      core.close();
      keys.release();
      for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve));

      const named = [...errors.mock.calls, ...warnings.mock.calls]
        .map((call) => call.map(String).join(" "))
        .filter((line) => line.includes(mindId));
      expect(named).toEqual([]);
      expect(calls.filter(isCheckRun)).toEqual([]);
    } finally {
      errors.mockRestore();
      warnings.mockRestore();
    }
  });
});
