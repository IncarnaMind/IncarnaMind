import { describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import {
  CONTENT_SCHEMA_VERSION,
  CONTENT_SCHEMA_VERSION_KEY,
  type Core,
  MIND_SETTINGS_FIELD,
} from "../../src/core";
import { OLLAMA_CLOUD } from "../../src/core/providers/ollamaCloud";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { claimCheckShown, SENTENCES_CHECKED_AT_MOST } from "../../src/shared/claimChecks";
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
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind, type MindClient, typeInto } from "../helpers/mindClient";
import { editMind, readMind, resolveChanges, shownWithChanges, writeMind } from "../helpers/minds";
import {
  type GenerateCall,
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";
import { buildPdf } from "../helpers/pdf";

/**
 * What the assistant writes into a Mind is checked against its own Citations
 * before it lands (#1111): a part they don't support is cut, keeping the
 * Citations and each word's formatting, and the sentence shows it needs a
 * check again; a sentence still unsupported, or one that couldn't be checked,
 * lands marked; at most `SENTENCES_CHECKED_AT_MOST` are checked a write; and
 * words the User types meanwhile stay. The model's verdicts and cuts are
 * scripted; Claude Haiku's were tried by hand.
 */

const MOON = "Spring tides come at new and full moon.";
const OVERSTATED = "Spring tides come at new and full moon, and they flood the harbour every year";
const UNBACKED = "Neap tides are twice as strong";
const FAILING = "The harbour floods at every spring tide";
const RECORD_SOURCE = "ECF No. 41 at 3 states the deadline";
const RECORD_NEXT = "Id. at 2 states another deadline";
const RECORD_CUT = `${RECORD_SOURCE}, and the harbour floods`;
const RECORD_SOURCE_ZH = "ECF No. 41 at 3 载明了截止日期";
const RECORD_NEXT_ZH = "Id. at 2 载明了另一个截止日期";
const RECORD_CUT_ZH = `${RECORD_SOURCE_ZH}，并且港口被淹没`;
const YEARLY = "Every year the harbour floods, and spring tides come at new and full moon";
const OVERSTATED_ZH = "大潮出现在新月和满月时，并且每年都会淹没港口";
const TWO_CITED =
  "Spring tides come at new and full moon [^1], and they flood the harbour every year [^1].";
const TWO_CITED_ZH = "公司营收增长了5%[^1]，所有地区成本都大幅下降[^1]。";
const NOT_RISE = "Revenue did not rise in 2023 [^1].";
const NOT_RISE_ZH = "公司营收没有在所有地区增长[^1]。";
const STOP_BEFORE =
  "Spring tides come at new and full moon, and they flood the harbour every year.[^1]";
const COMMA_TAIL = "The harbour floods in spring[^1], in every region.";
const COMMA_TAIL_ZH = "大潮出现在新月和满月时[^1]，每年如此。";

/** A sentence as a check reads it: the Citation after its words as U+FFFC. */
const asChecked = (words: string) => `${words} ${INLINE_NODE}.`;
const asCheckedZh = (words: string) => `${words}${INLINE_NODE}。`;

/** A check's reply for a sentence a Passage states in part, naming what it covers and what it doesn't. */
const partly = (covered: string, uncovered: string) => ({
  reply: {
    text: `Verdict: unsupported\nNo Passage says all of it.\nCovered: ${covered}\nNot covered: ${uncovered}`,
  },
});

/** A check's reply for a cut its Citations support once the unsupported part is out. */
const supported: Plan = { verdict: "supported", quote: MOON, says: MOON };

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
  [asChecked(YEARLY)]: {
    reply: {
      text: "Verdict: unsupported\nNo Passage says the harbour floods every year.\nCovered: when spring tides come\nNot covered: the yearly floods",
    },
  },
  [TWO_CITED.replaceAll(" [^1]", ` ${INLINE_NODE}`)]: {
    reply: {
      text: "Verdict: unsupported\nNo Passage says the harbour floods every year.\nCovered: when spring tides come\nNot covered: the yearly floods",
    },
  },
  [asCheckedZh(OVERSTATED_ZH)]: {
    reply: {
      text: "Verdict: unsupported\n没有段落说港口每年被淹没。\nCovered: 大潮出现的时间\nNot covered: 每年淹没港口",
    },
  },
  // Its 5% is a figure, which the check asks about one by one.
  [TWO_CITED_ZH.replaceAll("[^1]", INLINE_NODE)]: {
    reply: (call) => ({
      text: unsupportedReply(
        call,
        "没有段落说两个数字都成立。\nCovered: 增长与成本\nNot covered: 两个数字",
      ),
    }),
  },
  [asChecked("Revenue did not rise in 2023")]: partly("the revenue", "not"),
  [asCheckedZh("公司营收没有在所有地区增长")]: partly("营收增长", "没有"),
  [`Spring tides come at new and full moon, and they flood the harbour every year.${INLINE_NODE}`]:
    partly("when spring tides come", "the yearly floods"),
  [`The harbour floods in spring${INLINE_NODE}, in every region.`]: partly(
    "the flood in spring",
    "every region",
  ),
  [`大潮出现在新月和满月时${INLINE_NODE}，每年如此。`]: partly("春季大潮", "每年如此"),
  // The cut sentences a re-check reads: the ones above the Citations now support, and the two whose cut changed what the sentence said.
  [asChecked("Spring tides come at new and full moon")]: supported,
  [asChecked("And spring tides come at new and full moon")]: supported,
  [`Spring tides come at new and full moon.${INLINE_NODE}`]: supported,
  [`The harbour floods in spring${INLINE_NODE}.`]: supported,
  [`大潮出现在新月和满月时${INLINE_NODE}。`]: supported,
  [`港口在春季会淹水${INLINE_NODE}。`]: supported,
  [`Revenue did rise in 2023 ${INLINE_NODE}.`]: { reply: { text: "Verdict: unsupported" } },
  [`公司营收在所有地区增长${INLINE_NODE}。`]: { reply: { text: "Verdict: unsupported" } },
  [asChecked(RECORD_SOURCE)]: { verdict: "unsupported", judgement: "same" },
  [asChecked(RECORD_NEXT)]: { verdict: "unsupported", judgement: "same" },
  [asChecked(RECORD_CUT)]: partly("the deadline", "the harbour floods"),
  [`${RECORD_SOURCE}.`]: { verdict: "unsupported", judgement: "same" },
  [`${RECORD_NEXT}.`]: { verdict: "unsupported", judgement: "same" },
  [asCheckedZh(RECORD_SOURCE_ZH)]: { verdict: "unsupported", judgement: "same" },
  [asCheckedZh(RECORD_NEXT_ZH)]: { verdict: "unsupported", judgement: "same" },
  [asCheckedZh(RECORD_CUT_ZH)]: partly("截止日期", "港口被淹没"),
  [`${RECORD_SOURCE_ZH}。`]: { verdict: "unsupported", judgement: "same" },
  [`${RECORD_NEXT_ZH}。`]: { verdict: "unsupported", judgement: "same" },
};

const PLANS: Record<string, Plan> = Object.fromEntries(
  Object.entries(RAW_PLANS).map(([text, plan]) => [text.replaceAll(INLINE_NODE, ""), plan]),
);

const CUT = /<task action="cut-unsupported">/;

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
  /** How the Answer ends: a spending cap reached during the check stops it too. */
  ends?: "finished" | "failed";
  /** The model's cut of a sentence, in place of its first clause and its marker, or given the cut's prompt. */
  cut?: string | ((prompt: string) => string);
  record?: { name: string; contents: string | Uint8Array; quote: string; query: string };
  /** Hears each request that isn't streamed, answered as `PLANS` says. */
  generated?: (call: GenerateCall) => void;
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

/**
 * A model that searches, cites the moon line, writes `content`, and replies;
 * checks a sentence as `PLANS` says; and, asked to cut a sentence, keeps its
 * first clause and its marker.
 */
function writingModel(
  {
    content,
    into = false,
    during,
    check,
    cut = "Spring tides come at new and full moon [1].",
    record,
    generated,
  }: Writing,
  calls: ModelCall[],
  coreOf: () => Core | null,
) {
  let waited: Promise<void> | null = null;
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
      if (CUT.test(call.prompt)) {
        const words = typeof cut === "string" ? cut : cut(call.prompt);
        return { text: `${words}\n<why>Only what the source says.</why>` };
      }
      const { results } = call;
      const search = results.find((result) => result.tool === "search_documents");
      if (!search)
        return {
          calls: [{ tool: "search_documents", input: { query: record?.query ?? "spring tides" } }],
        };
      if (!results.some((result) => result.tool === "cite")) {
        const [passage] = shownPassages(search.text);
        const citation = { marker: 1, passage: passage?.id, quote: record?.quote ?? MOON };
        const citations = record ? [citation, { ...citation, marker: 2 }] : [citation];
        return { calls: [{ tool: "cite", input: { citations } }] };
      }
      const writes = results.filter((result) => result.tool === tool);
      // Told its text has no Citation (#1415), it writes it again as it was: it says nothing the Documents say.
      const refused = writes.length === 1 && writes[0]?.text.includes("content has no Citation");
      if (writes.length === 0 || refused) {
        const input = into ? { content } : { title: "Tide notes", content };
        return { calls: [{ tool, input }] };
      }
      return { text: "Wrote it from your Documents." };
    },
    record || generated
      ? {
          generate: (call: GenerateCall) => {
            generated?.(call);
            return checkGenerate(PLANS)(call);
          },
        }
      : undefined,
  );
}

/** The scripted model finds the English line a Chinese cut cites, as a real model does: it searches in English, then quotes it. */
const englishEvidence =
  (claim: string) =>
  (call: ModelCall): ScriptedReply | null => {
    if (sentenceOf(call) !== claim.replaceAll(INLINE_NODE, "")) return null;
    const searches = call.results.filter((result) => result.tool === "search_documents");
    if (searches.length === 0)
      return { calls: [{ tool: "search_documents", input: { query: "spring tides" } }] };
    if (!call.results.some((result) => result.tool === "cite")) {
      const [shown] = shownPassages(searches.at(-1)?.text ?? "");
      return {
        calls: [
          { tool: "cite", input: { citations: [{ marker: 1, passage: shown?.id, quote: MOON }] } },
        ],
      };
    }
    return { text: `Verdict: supported\nAbsence: no\nThe Document says: ${MOON} [^1]` };
  };

/** A core with the tides line in a Folder, and a Mind there with a heading and a line. */
async function harbour(
  model: ReturnType<typeof writingModel>,
  cloud: Writing["cloud"],
  record: Writing["record"],
) {
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
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
  const mind = await core.createMind({ title: "Harbour notes", folderId: folder.id });
  const client = await connectToMind(core, mind.id);
  writeMind(client, [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Harbour" }] },
    { type: "paragraph", content: [{ type: "text", text: "Boats moor by the quay." }] },
  ]);
  await client.settled();
  return { core, folderId: folder.id, mindId: mind.id, client, service };
}

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
  );
  started = core;
  await onStart?.({ core, client, mindId, service, calls });
  const answer = await askAssistant(
    core,
    {
      text: writing.into
        ? "Add a short note on tides to this Mind"
        : "Summarise these Documents into a new note",
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
 * sentences (as checks read them) wait for the first one's check to end, `firstEnds` being the
 * sentence whose verdict ends it (its cut's, once cut); or, `reversed`, it waits for theirs. So
 * the checks end in opposite orders.
 */
async function checkRequestsOf(
  writing: Writing,
  sentences: { first: string; firstEnds: string; others: readonly string[]; checked: number },
  reversed: boolean,
) {
  const { first, firstEnds, others, checked } = sentences;
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
          : others.includes(sentence) && once(() => verdicts.includes(firstEnds));
        return until ? { ...reply, pause: { after: 0, until } } : reply;
      },
    },
    ({ client }) => {
      page = client;
    },
  );
  return {
    requests: [
      ...calls
        .filter((call) => isCheckRun(call) || CUT.test(call.prompt))
        .map((call) => normalized(call.options)),
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

describe("What the assistant writes is checked before it lands", { timeout: 30_000 }, () => {
  // protects=a written sentence that overstates its Citations lands with that part cut, its Citation kept, and marked to be checked again (#1111's acceptance); fails_when=the overstated words land, the Citation goes, it lands unmarked or unsupported, or the model isn't told; no_claim=how well a real model cuts.
  test("a part its Citations don't support is cut before it lands, the Citation kept, and it shows it needs a check again", async () => {
    const { core, model, calls, change, client } = await write({
      content: `## Tides\n\n${OVERSTATED} [^1].`,
    });

    expect(shownWithChanges(client)).toEqual([
      "+ Tides",
      "+ Spring tides come at new and full moon ⟨found⟩.",
    ]);
    const marks = await marksIn(core, client);
    expect(marks.map(({ shown }) => shown)).toEqual([{ state: "needs-recheck", why: "edited" }]);
    expect(change).toMatchObject({ created: true, proposals: 2 });
    expect(change).not.toHaveProperty("checking");
    expect(change?.selfCheck).toMatchObject({ cited: 1, sent: 1, failed: 0 });
    // A check of the sentence and a check of the cut, and one edit for the cut, told what the Citation quotes.
    expect(calls.filter((call) => isCheckRun(call) && call.results.length === 0)).toHaveLength(2);
    const cuts = calls.filter((call) => CUT.test(call.prompt));
    expect(cuts).toHaveLength(1);
    expect(cuts[0]?.prompt).toContain("the yearly floods");
    expect(cuts[0]?.prompt).toContain(`[1] “${MOON}”`);
    expect(lastResult(model)).toContain(
      "What their Citations don't support was taken out: “the yearly floods”.",
    );
  });

  // protects=a cut keeps each word's own formatting rather than giving all of it the first word's; fails_when=the plain words turn bold; no_claim=none beyond protects.
  test("a cut keeps each word's own formatting", async () => {
    const { client } = await write({
      content: `## Tides\n\n**Spring tides** come at new and full moon, and they flood the harbour every year [^1].`,
    });

    const paragraph = readMind(client).child(1);
    const runs: { text: string; bold: boolean }[] = [];
    paragraph.forEach((node) => {
      if (node.isText) {
        runs.push({
          text: node.text ?? "",
          bold: node.marks.some((mark) => mark.type.name === "bold"),
        });
      }
    });
    expect(runs.filter((run) => run.bold).map((run) => run.text.trim())).toEqual(["Spring tides"]);
    expect(runs.map((run) => run.text).join("")).toBe("Spring tides come at new and full moon .");
  });

  // protects=a cut that rewords the sentence, as Kimi K2.6's did ("across all tested crime categories" became "in all cases", #1397), moves its Citation or keeps one on words it didn't follow, or leaves no claim, isn't used: the sentence lands as the assistant wrote it, marked unsupported, in English and Chinese; fails_when=the cut's words land, or the model is told a part was taken out; no_claim=how often a real model rewords.
  test.each([
    {
      language: "en",
      content: `## Tides\n\n${OVERSTATED} [^1].`,
      cut: "Spring tides come at new and full moon in all cases [1].",
      written: asChecked(OVERSTATED),
    },
    {
      language: 'en, no claim left, as Claude Haiku 5.5\'s "Crime:"',
      content: `## Tides\n\n${OVERSTATED} [^1].`,
      cut: "Spring tides [1].",
      written: asChecked(OVERSTATED),
    },
    {
      language: "en, a Citation kept on words it didn't follow",
      content: `## Tides\n\n${TWO_CITED}`,
      cut: "Spring tides come at new and full moon [2].",
      written: TWO_CITED.replaceAll(" [^1]", ` ${INLINE_NODE}`),
    },
    {
      language: "en, its Citation moved",
      content: `## Tides\n\n${OVERSTATED} [^1].`,
      cut: "Spring tides [1] come at new and full moon.",
      written: asChecked(OVERSTATED),
    },
    {
      language: "zh-CN",
      content: `## 潮汐\n\n${OVERSTATED_ZH}[^1]。`,
      cut: "大潮在所有情况下都出现在新月和满月时[1]。",
      written: asCheckedZh(OVERSTATED_ZH),
    },
  ])(
    "a cut that does more than take a part out isn't used, and the sentence lands as written, marked ($language)",
    async ({ content, cut, written }) => {
      const { model, client } = await write({ content, cut });

      expect(paragraphText(client, 1)).toBe(written);
      const [mark] = claimSpans(readMind(client));
      expect(mark?.check).toMatchObject({
        state: "unsupported",
        text: written.replaceAll(INLINE_NODE, ""),
      });
      expect(lastResult(model)).toContain("1 sentence is still not supported by its Citations");
      expect(lastResult(model)).not.toContain("was taken out");
    },
  );

  // protects=only the part the cut takes out goes: every other word, mark, space and Citation lands byte for byte as the assistant wrote it, whatever spaces the model's reply has inside what it kept, and with its own full stop when the reply leaves it out, in English and Chinese (#1397); fails_when=any other byte of the sentence changes; no_claim=none beyond protects.
  test.each([
    {
      language: "en",
      content: `## Tides\n\n${OVERSTATED} [^1].`,
      cut: "Spring tides  come at new and full\nmoon [1].",
      written: asChecked(OVERSTATED),
      part: ", and they flood the harbour every year",
      check: undefined,
    },
    {
      language: "en, its full stop left out, with a sentence after it",
      content: `## Tides\n\n${OVERSTATED} [^1]. Neap tides come between.`,
      cut: "Spring tides come at new and full moon [1]",
      written: `${asChecked(OVERSTATED)} Neap tides come between.`,
      part: ", and they flood the harbour every year",
      check: undefined,
    },
    {
      language: "zh-CN",
      content: `## 潮汐\n\n${OVERSTATED_ZH}[^1]。`,
      cut: "大潮出现在 新月和满月时[1]。",
      written: asCheckedZh(OVERSTATED_ZH),
      part: "，并且每年都会淹没港口",
      check: englishEvidence(`大潮出现在新月和满月时${INLINE_NODE}。`),
    },
  ])(
    "a cut takes out only its part, and the rest lands byte for byte ($language)",
    async ({ content, cut, written, part, check }) => {
      const { core, model, client } = await write({ content, cut, check });

      expect(written).toContain(part);
      expect(paragraphText(client, 1)).toBe(written.replace(part, ""));
      const marks = await marksIn(core, client);
      expect(marks.map(({ shown }) => shown.state)).toEqual(["needs-recheck"]);
      expect(lastResult(model)).toContain("was taken out");
    },
  );

  // protects=a cut that takes a sentence's first words out may start it with the next word's capital, and is used; fails_when=it is refused for the capital; no_claim=none beyond protects.
  test("a cut that takes the first words out starts with the next word's capital", async () => {
    const { client } = await write({ content: `## Tides\n\n${YEARLY} [^1].` });

    expect(paragraphText(client, 1)).toBe(asChecked("Spring tides come at new and full moon"));
  });

  // protects=a cut that drops the first words lands with the next word's capital even when the model gives it in lower case (#1397's review); fails_when=the sentence starts in lower case; no_claim=none beyond protects.
  test("a cut that drops the first words lands with the next word's capital", async () => {
    const { client } = await write({
      content: `## Tides\n\n${YEARLY} [^1].`,
      cut: "and spring tides come at new and full moon [1].",
    });

    expect(paragraphText(client, 1)).toBe(asChecked("And spring tides come at new and full moon"));
  });

  // protects=a Citation a cut leaves out takes all its words with it, so none reads as backed by the next Citation (#1397's review), in English and Chinese; fails_when=a dropped Citation's words land under the next one; no_claim=how often a real model cuts one.
  test.each([
    {
      language: "en",
      content: `## Tides\n\n${TWO_CITED}`,
      cut: "Spring tides come at new and full moon, and they flood the harbour every year [2].",
      written: TWO_CITED.replaceAll(" [^1]", ` ${INLINE_NODE}`),
    },
    {
      language: "zh-CN",
      content: `## 潮汐\n\n${TWO_CITED_ZH}`,
      cut: "公司营收增长了5%，所有地区成本都大幅下降[2]。",
      written: TWO_CITED_ZH.replaceAll("[^1]", INLINE_NODE),
    },
  ])(
    "a cut that leaves a dropped Citation's words isn't used, and the sentence lands as written, marked ($language)",
    async ({ content, cut, written }) => {
      const { model, calls, client } = await write({ content, cut });

      expect(paragraphText(client, 1)).toBe(written);
      const [mark] = claimSpans(readMind(client));
      expect(mark?.check).toMatchObject({
        state: "unsupported",
        text: written.replaceAll(INLINE_NODE, ""),
      });
      // The rule refused it, not the check of the cut.
      expect(calls.filter((call) => isCheckRun(call) && call.results.length === 0)).toHaveLength(1);
      expect(lastResult(model)).toContain("1 sentence is still not supported by its Citations");
      expect(lastResult(model)).not.toContain("was taken out");
    },
  );

  // protects=a cut that changes what the sentence says ("did not rise" to "did rise", 没有 dropped) isn't used, because the cut is checked once as it would land (#1397's review), in English and Chinese; fails_when=the changed claim lands; no_claim=how often a real model cuts like that.
  test.each([
    {
      language: "en",
      content: `## Tides\n\n${NOT_RISE}`,
      cut: "Revenue did rise in 2023 [1].",
      checked: `Revenue did rise in 2023 ${INLINE_NODE}.`,
      written: asChecked("Revenue did not rise in 2023"),
    },
    {
      language: "zh-CN",
      content: `## 潮汐\n\n${NOT_RISE_ZH}`,
      cut: "公司营收在所有地区增长[1]。",
      checked: `公司营收在所有地区增长${INLINE_NODE}。`,
      written: asCheckedZh("公司营收没有在所有地区增长"),
    },
  ])(
    "a cut that changes what the sentence says isn't used, and the sentence lands as written, marked ($language)",
    async ({ content, cut, checked, written }) => {
      const { model, calls, client } = await write({ content, cut });

      expect(paragraphText(client, 1)).toBe(written);
      const [mark] = claimSpans(readMind(client));
      expect(mark?.check).toMatchObject({
        state: "unsupported",
        text: written.replaceAll(INLINE_NODE, ""),
      });
      expect(
        calls.some(
          (call) => isCheckRun(call) && sentenceOf(call) === checked.replaceAll(INLINE_NODE, ""),
        ),
      ).toBe(true);
      expect(lastResult(model)).toContain("1 sentence is still not supported by its Citations");
      expect(lastResult(model)).not.toContain("was taken out");
    },
  );

  // protects=a restored full stop takes the place of a comma or colon the cut kept before it, so "…[1],." and "…[1]，。" never land (#1397's review), in English and Chinese; fails_when=the stop dangles after the mark; no_claim=none beyond protects.
  test.each([
    {
      language: "en",
      content: `## Tides\n\n${COMMA_TAIL}`,
      cut: "The harbour floods in spring [1],",
      written: `The harbour floods in spring${INLINE_NODE}.`,
      check: undefined,
    },
    {
      language: "zh-CN",
      content: `## 潮汐\n\n${COMMA_TAIL_ZH}`,
      cut: "大潮出现在新月和满月时 [1]，",
      written: `大潮出现在新月和满月时${INLINE_NODE}。`,
      check: englishEvidence(`大潮出现在新月和满月时${INLINE_NODE}。`),
    },
  ])(
    "a restored full stop replaces a kept comma or colon ($language)",
    async ({ content, cut, written, check }) => {
      const { core, client } = await write({ content, cut, check });

      expect(paragraphText(client, 1)).toBe(written);
      const marks = await marksIn(core, client);
      expect(marks.map(({ shown }) => shown.state)).toEqual(["needs-recheck"]);
    },
  );

  // protects=a sentence whose full stop comes before its Citation ("…regions.[1]") keeps it when a cut leaves it out, so the next sentence stays apart (#1397's review); fails_when=the two sentences merge; no_claim=none beyond protects.
  test("a cut that leaves out the stop before its Citation keeps it, and the next sentence stays apart", async () => {
    const { client } = await write({
      content: `## Tides\n\n${STOP_BEFORE} Neap tides come between.`,
      cut: "Spring tides come at new and full moon [1]",
    });

    expect(paragraphText(client, 1)).toBe(
      `Spring tides come at new and full moon.${INLINE_NODE} Neap tides come between.`,
    );
  });

  // protects=a written sentence its Citations don't support at all lands marked unsupported, with the check's reason, so Check this note has nothing more to find; fails_when=it lands unmarked, is cut, or Check this note sends it again; no_claim=none beyond protects.
  test("a sentence still unsupported lands marked, and Check this note leaves it", async () => {
    const { core, model, calls, change, client } = await write({
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
    expect(calls.some((call) => CUT.test(call.prompt))).toBe(false);
    expect(lastResult(model)).toContain(
      "1 sentence is still not supported by its Citations, and marked so in the Note",
    );
    await resolveChanges(client, "accept");
    expect(claimSpans(readMind(client))).toHaveLength(1);
    expect(await core.planMindCheck(change?.mindId ?? "", "changed")).toMatchObject({
      kind: "unchanged",
    });
  });

  // protects=a check that fails lands its sentence marked not checked, with why, and the reply and the card's line say so; fails_when=it lands unmarked, which reads as supported; no_claim=the words of the line.
  test("a sentence whose check fails lands marked not checked, and the model is told", async () => {
    const { core, model, change, client } = await write({
      content: `## Tides\n\n${FAILING} [^1].`,
    });

    const [mark] = await marksIn(core, client);
    expect(mark?.check).toMatchObject({ state: "not-checked", reason: "failed" });
    expect(change?.selfCheck).toMatchObject({ cited: 1, sent: 1, failed: 1 });
    expect(lastResult(model)).toContain(
      "1 sentence couldn't be checked, and is marked so in the Note: say so.",
    );
  });

  // protects=the spending cap reached during the check stops it: the sentences left land not checked for that reason, and the change says what stopped it, for the line that offers Change the cap; fails_when=they land unmarked, or the stop isn't kept; no_claim=the line's words.
  test("the spending cap reached during the check stops it, and its sentences say why", async () => {
    let capped = false;
    const { core, change, client } = await write({
      content: `## Tides\n\n${UNBACKED} [^1]. ${OVERSTATED} [^1].`,
      cloud: { kind: "anthropic", modelId: "claude-haiku-5-5" },
      ends: "failed",
      check: (_call, started) => {
        if (!capped) {
          capped = true;
          void started.updateSettings({ user: { monthlyCap: { amount: 0, currency: "USD" } } });
        }
        return null;
      },
    });

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

  // protects=a User who allowed checks before they sent more isn't asked as the assistant writes, nor is anything sent: the write's sentences land not checked, saying why, and the Check of one asks for the more and checks the whole write once allowed (#2525); fails_when=the write lands unchecked with no reason, is sent on the earlier consent, asks in the background, or Allow checks only the one sentence; no_claim=the consent dialog's words.
  test("allowed before checks sent more, the write waits for the User's OK, then is checked whole", async () => {
    const asked: string[][] = [];
    const { core, calls, change, client } = await write(
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

  // protects=one write checks at most SENTENCES_CHECKED_AT_MOST sentences; the rest land marked not checked, and the reply says so; fails_when=a long draft sends a check for every sentence, or the rest land unmarked; no_claim=how long each check takes.
  test("one write checks at most the first sentences; the rest land marked not checked", async () => {
    const many = SENTENCES_CHECKED_AT_MOST + 1;
    const sentences = Array.from(
      { length: many },
      (_, index) => `Neap tide ${index + 1} is twice as strong [^1].`,
    );
    const { core, model, calls, change, client } = await write({
      content: `## Tides\n\n${sentences.join(" ")}`,
    });

    expect(calls.filter((call) => isCheckRun(call) && call.results.length === 0)).toHaveLength(
      SENTENCES_CHECKED_AT_MOST,
    );
    const marks = await marksIn(core, client);
    expect(marks).toHaveLength(many);
    expect(marks.at(-1)?.check).toMatchObject({ state: "not-checked", reason: "too-many" });
    expect(change?.selfCheck).toMatchObject({ cited: many, sent: SENTENCES_CHECKED_AT_MOST });
    expect(lastResult(model)).toContain(
      `Only the first ${SENTENCES_CHECKED_AT_MOST} of its ${many} sentences with Citations were checked`,
    );
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

  // protects=a landing that throws (here a newer version wrote the Note mid-check, so no edit may change it) is logged and never becomes its sentence's failure, and then fails the write's check as a whole, as one edit of all the marks did: the write stands and no check of it is reported (#2532); fails_when=runItems files the throw as the sentence's failure and lands it again, or the check reports normally after a mark couldn't land; no_claim=what the card says of a Note a newer version wrote.
  test("a mark that can't land is logged, not filed as its sentence's failure, and fails the check", async () => {
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
      expect(
        said(errors).filter((line) => line.includes("couldn't be checked before it landed")),
      ).toHaveLength(1);
      expect(change?.selfCheck).toBeUndefined();
      expect(lastResult(model)).toContain("Wrote 1 new Block");
    } finally {
      errors.mockRestore();
      warnings.mockRestore();
    }
  });

  // protects=the sentences of a table land together after every check, in one edit, as a table's marks are footed against each other and its chart drawn from them (#2532); fails_when=a table's sentence lands on its own as its check ends; no_claim=how a table foots.
  test("a table's sentences land together after every check", async () => {
    const seen: number[] = [];
    const { core, client } = await write(
      {
        content:
          "| Region | Note |\n| --- | --- |\n| North | Spring tides come at new and full moon [^1] |\n| South | Neap tides are twice as strong [^1] |",
        into: true,
        cloud: { kind: "anthropic", modelId: "claude-haiku-5-5" },
      },
      ({ client: connected }) => {
        connected.doc.on("update", () => {
          seen.push(claimSpans(readMind(connected)).length);
        });
      },
    );

    expect(await marksIn(core, client)).toHaveLength(2);
    expect(seen).toContain(2);
    expect(seen).not.toContain(1);
  });

  // protects=Stop while a write's sentences are checked keeps the marks that landed and lands none for a sentence whose check Stop cut short, as Check this note leaves them (#2532); fails_when=a sentence stopped mid-check lands marked, or a landed mark is taken back; no_claim=what the Answer says once stopped.
  test("Stop while a write is checked keeps the marks that landed and lands no more", async () => {
    const calls: ModelCall[] = [];
    let started: Core | null = null;
    let page: MindClient | null = null;
    let answer: { conversationId: string; answerId: string } | null = null;
    const moonMarked = () =>
      page !== null &&
      claimSpans(readMind(page)).some((span) => span.sentence.text.startsWith("Spring tides"));
    const model = writingModel(
      {
        content: `Spring tides come at new and full moon [^1]. ${UNBACKED} [^1].`,
        into: true,
        cloud: { kind: "anthropic", modelId: "claude-haiku-5-5" },
        check: (call, core) => {
          if (sentenceOf(call) !== `${UNBACKED} .` || call.results.length > 0) return null;
          const stopped = vi
            .waitFor(() => expect(moonMarked()).toBe(true), { timeout: 20_000, interval: 5 })
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
    page = client;

    const asked = await core.askInConversation({
      text: "Add a short note on tides to this Mind",
      mindId,
      scope: { folderIds: [folderId], tagIds: [], documentIds: [] },
    });
    if (!asked.asked) throw new Error("Not asked.");
    answer = { conversationId: asked.conversation.id, answerId: asked.answerId };
    const stopped = await vi.waitFor(
      async () => {
        const { messages } = await core.getConversation(asked.conversation.id);
        const found = messages.find((each) => each.id === asked.answerId);
        if (found?.kind !== "answer" || found.status !== "stopped") throw new Error("Not stopped.");
        return found;
      },
      { timeout: 20_000, interval: 20 },
    );

    const marks = await marksIn(core, client);
    expect(marks.map(({ sentence, check }) => [sentence, check.state])).toEqual([
      ["Spring tides come at new and full moon .", "supported"],
    ]);
    const [change] = changesIn(stopped);
    expect(change?.checking).toBe(2);
    expect(change?.selfCheck).toBeUndefined();
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

  // protects=the cuts listed for the model are in the Note's order whichever check ends first (#2532); fails_when=they are listed in the order their checks ended; no_claim=what each cut keeps.
  test("the cuts listed for the model are in the Note's order", async () => {
    let seen: readonly ModelCall[] = [];
    let page: MindClient | null = null;
    const tailChecked = () =>
      seen.some(
        (call) =>
          isCheckRun(call) &&
          sentenceOf(call) === "The harbour floods in spring." &&
          call.results.length > 0,
      );
    const { model } = await write(
      {
        content: `${OVERSTATED} [^1].\n\n${COMMA_TAIL}`,
        into: true,
        cloud: { kind: "anthropic", modelId: "claude-haiku-5-5" },
        cut: (prompt) =>
          prompt.includes("every region")
            ? "The harbour floods in spring [1],"
            : "Spring tides come at new and full moon [1].",
        check: (call) => {
          if (sentenceOf(call) !== `${OVERSTATED} .` || call.results.length > 0) return null;
          // The later sentence's cut is checked again before the earlier sentence is answered.
          const ended = vi
            .waitFor(() => expect(tailChecked()).toBe(true), { timeout: 20_000, interval: 5 })
            .then(() => page?.settled());
          return { ...checkReply(call, PLANS), pause: { after: 0, until: ended } };
        },
      },
      ({ client, calls }) => {
        page = client;
        seen = calls;
      },
    );

    expect(lastResult(model)).toContain(
      "What their Citations don't support was taken out: “the yearly floods”, “every region”.",
    );
  });

  // protects=a landing that fails on a Note that still takes edits leaves the table's marks to land after every check before the check fails (#2532); fails_when=the check fails before the last edit, and the table's sentence lands unmarked; no_claim=what makes an edit fail.
  test("a failed landing still lets a table's marks land before the check fails", async () => {
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
        [UNBACKED, "unsupported"],
      ]);
      expect(
        errors.mock.calls.filter(([line]) =>
          String(line).includes("couldn't be checked before it landed"),
        ),
      ).toHaveLength(1);
    } finally {
      edits.restore();
      errors.mockRestore();
    }
  });

  // protects=words the User types into what the assistant wrote while the check runs stay: only the sentences cut or marked are written, each only while unchanged (one with no cut too); fails_when=the User's words vanish, or a sentence they changed is cut over; no_claim=none beyond protects.
  test("words the User types while the check runs stay, and a sentence they changed is only marked", async () => {
    let client: MindClient | null = null;
    const { core } = await write(
      {
        content: `${OVERSTATED} [^1]. Neap tides come between.\n\nThe harbour office posts the times.\n\n${UNBACKED} [^1].`,
        into: true,
        during: async () => {
          const typing = client;
          if (!typing) return;
          await typing.settled();
          // After the cut sentence, in its paragraph; at the start of a paragraph with no cut; and in a marked sentence.
          const paragraph = typing.blocks.get(2);
          const texts =
            paragraph instanceof Y.XmlElement
              ? paragraph.toArray().filter((each) => each instanceof Y.XmlText)
              : [];
          const last = texts.at(-1);
          if (last instanceof Y.XmlText) last.insert(last.length, " Quiet.");
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
      "+ Spring tides come at new and full moon ⟨found⟩. Neap tides come between. Quiet.",
      "+ Today The harbour office posts the times.",
      "+ All Neap tides are twice as strong ⟨found⟩.",
    ]);
    const marks = await marksIn(core, page);
    expect(marks.map(({ sentence, shown }) => [sentence, shown.state])).toEqual([
      ["Spring tides come at new and full moon .", "needs-recheck"],
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

  test("a cut's validation preserves the referent for the next written sentence", async () => {
    const { core, client } = await write({
      into: true,
      record: RECORD_FILE,
      cut: `${RECORD_SOURCE} [1].`,
      content: `> ${RECORD_CUT} [^1].\n> ${RECORD_NEXT} [^2].`,
    });

    const next = (await marksIn(core, client)).find(({ sentence }) =>
      sentence.includes(RECORD_NEXT),
    );
    expect(next?.check.recordCites?.[0]).toMatchObject({
      raw: "Id. at 2",
      outcome: "supported",
      location: { kind: "page", from: 2, to: 2 },
    });
  });

  // protects=a cut lands after every check, so a later sentence's Id. in the same paragraph reads the Note as written and resolves as it did before marks landed as each check ends (#2532), in English and Chinese, with the Id. sentence twice; fails_when=the cut lands mid-run and the Id. sentences land with no record cite, unchecked; no_claim=how a cut sentence's own cite resolves.
  test.each([
    {
      language: "en",
      content: `> ${RECORD_CUT} [^1]. ${RECORD_NEXT} [^2]. ${RECORD_NEXT} [^2].`,
      cut: `${RECORD_SOURCE} [1].`,
      kept: `${RECORD_SOURCE} .`,
      dropped: "the harbour floods",
      next: RECORD_NEXT,
    },
    {
      language: "zh-CN",
      content: `> ${RECORD_CUT_ZH}[^1]。${RECORD_NEXT_ZH}[^2]。${RECORD_NEXT_ZH}[^2]。`,
      cut: `${RECORD_SOURCE_ZH}[1]。`,
      kept: `${RECORD_SOURCE_ZH}。`,
      dropped: "港口被淹没",
      next: RECORD_NEXT_ZH,
    },
  ])(
    "an Id. after a cut sentence resolves as written ($language)",
    async ({ content, cut, kept, dropped, next }) => {
      const recordStated: Plan = {
        verdict: "supported",
        quote: RECORD_FILE.quote,
        says: RECORD_FILE.quote,
      };
      const { core, client } = await write({
        into: true,
        record: RECORD_FILE,
        cut,
        content,
        check: (call) =>
          sentenceOf(call) === kept ? checkReply(call, { [kept]: recordStated }) : null,
      });

      expect(readMind(client).textContent).not.toContain(dropped);
      const marks = (await marksIn(core, client)).filter(({ sentence }) => sentence.includes(next));
      expect(marks).toHaveLength(2);
      for (const { check } of marks) {
        expect(check.recordCites?.[0]).toMatchObject({
          raw: "Id. at 2",
          outcome: "supported",
          location: { kind: "page", from: 2, to: 2 },
        });
      }
    },
  );

  // protects=normalized request equivalence: a write's checks send the same requests whichever order they end in, ids, times and cache keys put by, as marks land while other sentences are still checked and a cut lands after every check (#2532); fails_when=a mark that lands mid-run changes what a later check sends; no_claim=a check that starts after a cut would land, which the Id. test pins, nor the final marks, which a cut placed after every check changes on purpose for two identical sentences after it.
  test.each([
    {
      name: "paragraphs, a table and a cut",
      writing: {
        content: `${OVERSTATED} [^1]. ${UNBACKED} [^1].\n\n| Region | Note |\n| --- | --- |\n| North | ${MOON.slice(0, -1)} [^1] |`,
        into: true,
      },
      sentences: {
        first: `${OVERSTATED} .`,
        firstEnds: "Spring tides come at new and full moon .",
        others: [`${UNBACKED} .`, MOON.slice(0, -1)],
        checked: 3,
      },
    },
    {
      name: "an Id. after a cut",
      writing: {
        content: `> ${RECORD_CUT} [^1]. ${RECORD_NEXT} [^2]. ${RECORD_NEXT} [^2].`,
        into: true,
        record: RECORD_FILE,
        cut: `${RECORD_SOURCE} [1].`,
        check: (call: ModelCall) =>
          sentenceOf(call) === `${RECORD_SOURCE} .`
            ? checkReply(call, {
                [`${RECORD_SOURCE} .`]: {
                  verdict: "supported",
                  quote: RECORD_FILE.quote,
                  says: RECORD_FILE.quote,
                },
              })
            : null,
      },
      sentences: {
        first: `${RECORD_CUT} .`,
        firstEnds: `${RECORD_SOURCE} .`,
        others: [`${RECORD_NEXT} .`],
        checked: 3,
      },
    },
    {
      name: "two identical sentences after a cut",
      writing: { content: `${OVERSTATED} [^1]. ${UNBACKED} [^1]. ${UNBACKED} [^1].`, into: true },
      sentences: {
        first: `${OVERSTATED} .`,
        firstEnds: "Spring tides come at new and full moon .",
        others: [`${UNBACKED} .`],
        checked: 3,
      },
    },
  ])(
    "a write's checks send the same requests whichever order they end in ($name)",
    async ({ writing, sentences }) => {
      const inOrder = await checkRequestsOf(writing, sentences, false);
      const reversed = await checkRequestsOf(writing, sentences, true);

      const { firstEnds, others } = sentences;
      const ended = (verdicts: readonly string[], sentence: string) => verdicts.indexOf(sentence);
      for (const other of others) {
        expect(ended(inOrder.verdicts, firstEnds)).toBeLessThan(ended(inOrder.verdicts, other));
        expect(ended(reversed.verdicts, other)).toBeLessThan(
          ended(reversed.verdicts, sentences.first),
        );
      }
      expect(inOrder.requests.length).toBeGreaterThan(sentences.checked);
      expect(reversed.requests).toEqual(inOrder.requests);
    },
  );

  // protects=two identical sentences after a cut sentence in one paragraph each get their own mark, as a cut lands after every check; fails_when=the cut lands first and both marks go on the second sentence, the first left unmarked; no_claim=what the cut keeps.
  test("two identical sentences after a cut sentence each get their own mark", async () => {
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

  // protects=a sentence with no Citation isn't checked as it lands (#1909: it is left to the one count and the one Check), as its Citations are what the written check reads; fails_when=a check Run is made for it, or it lands marked; no_claim=none beyond protects.
  test("a sentence with no Citation isn't checked as it lands", async () => {
    const { calls, client } = await write({
      content: "## Tides\n\nThe harbour is quiet in winter.",
    });

    expect(shownWithChanges(client)).toEqual(["+ Tides", "+ The harbour is quiet in winter."]);
    expect(calls.some(isCheckRun)).toBe(false);
  });
});
