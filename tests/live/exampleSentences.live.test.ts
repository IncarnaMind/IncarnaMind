/**
 * The gate of #3088 on a real model (`eval/evidence/3088-example-sentences/README.md`): the credit
 * example's own two sentences in a new Note, with the example alone and beside a Document of the
 * User's own, wrong twins of them, and held-out pairs of the same two kinds (a comparative clause,
 * a figure with a thousands comma in a short Note), each Note checked as Check this note does,
 * its sort included. One JSON line a check, and one for the run, to INCARNAMIND_LIVE_GATE_OUT.
 * Runs only with INCARNAMIND_LIVE_ANTHROPIC_KEY, or with INCARNAMIND_LIVE_GATE_DRY=1, where a
 * scripted judge stands in and nothing is sent.
 */
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import type { LanguageModelV4CallOptions, LanguageModelV4Usage } from "@ai-sdk/provider";
import type { JSONContent } from "@tiptap/core";
import { wrapLanguageModel } from "ai";
import { describe, expect, test, vi } from "vitest";
import { type Core, createAiSdkChatModel, type Document } from "../../src/core";
import { readVerdict } from "../../src/core/answers/checks/prompt";
import type { Language } from "../../src/core/language";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { reasonText } from "../../src/renderer/src/cost";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { translate } from "../../src/shared/i18n";
import { checkGenerate, isCheckRun, sentenceOf, unsupportedReply } from "../helpers/checks";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import { scriptedModel, scriptedModels } from "../helpers/models";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const DRY = process.env.INCARNAMIND_LIVE_GATE_DRY === "1";
const OUT = process.env.INCARNAMIND_LIVE_GATE_OUT;
const ARM = process.env.INCARNAMIND_LIVE_GATE_ARM ?? "unnamed";
const ROUND = Number(process.env.INCARNAMIND_LIVE_GATE_ROUND ?? "0");
const GROUPS = (process.env.INCARNAMIND_LIVE_GATE_GROUPS ?? "example,held-out").split(",");
const MODEL =
  process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ??
  (catalogProvider("anthropic")?.roles.answers as string);
/** Notes checked at once: enough to finish a round in minutes, few enough to stay under the key's limit. */
const AT_ONCE = 4;
const EXAMPLES = resolve(__dirname, "../../resources/examples");

/** A sentence to check, and the part of it whose first reply is counted. */
interface Probe {
  sentence: string;
  /** Right: the Documents state it. Wrong: they say otherwise, so it is never to be Supported. */
  expected: "right" | "wrong";
  /** The part whose first reply's verdict is recorded; the sentence's whole text when it has none. */
  part?: string;
}

const EXAMPLE = {
  en: {
    report: "Northwind Retail · Q3 2026 results",
    line: "Underlying EBITDA was £96 million, against £118 million a year earlier.",
    own: {
      name: "Harbour Foods board pack",
      text: "Harbour Foods sells through its own shops and online.\n\nHarbour Foods’ underlying EBITDA was £12 million in 2025.",
    },
    note: [
      {
        sentence: "Underlying EBITDA was £96 million, against £118 million a year earlier.",
        expected: "right",
        part: "against £118 million a year earlier",
      },
      { sentence: "Revenue was £1,284 million, up 4.2% year on year.", expected: "right" },
    ],
    twins: [
      {
        sentence: "Underlying EBITDA was £96 million, against £128 million a year earlier.",
        expected: "wrong",
        part: "against £128 million a year earlier",
      },
      {
        sentence: "Underlying EBITDA was £118 million, against £96 million a year earlier.",
        expected: "wrong",
        part: "against £96 million a year earlier",
      },
      { sentence: "Revenue was £1,248 million, up 4.2% year on year.", expected: "wrong" },
    ],
  },
  "zh-CN": {
    report: "Northwind Retail · 2026 年第三季度业绩",
    line: "基础 EBITDA 为 9,600 万英镑，上年同期为 1.18 亿英镑。",
    own: {
      name: "海港食品董事会资料",
      text: "海港食品通过自有门店和线上渠道销售。\n\n海港食品 2025 年的基础 EBITDA 为 1,200 万英镑。",
    },
    note: [
      {
        sentence: "基础 EBITDA 为 9,600 万英镑，上年同期为 1.18 亿英镑。",
        expected: "right",
        part: "上年同期为 1.18 亿英镑",
      },
      { sentence: "集团收入为 12.84 亿英镑，同比增长 4.2%。", expected: "right" },
    ],
    twins: [
      {
        sentence: "基础 EBITDA 为 9,600 万英镑，上年同期为 1.28 亿英镑。",
        expected: "wrong",
        part: "上年同期为 1.28 亿英镑",
      },
      {
        sentence: "基础 EBITDA 为 1.18 亿英镑，上年同期为 9,600 万英镑。",
        expected: "wrong",
        part: "上年同期为 9,600 万英镑",
      },
      { sentence: "集团收入为 12.48 亿英镑，同比增长 4.2%。", expected: "wrong" },
    ],
  },
} as const satisfies Record<
  Language,
  {
    report: string;
    line: string;
    own: { name: string; text: string };
    note: readonly Probe[];
    twins: readonly Probe[];
  }
>;

/** A held-out case: its own Folder, its own Document and a Note of one sentence. */
interface HeldOut extends Probe {
  id: string;
  kind: "comparative" | "short-note";
  language: Language;
  document: string;
}

/** Written before any run; none is an example the check's instructions or the unit tests give. */
const HELD_OUT: readonly HeldOut[] = [
  ...pair("en-a1", "comparative", "en", {
    document:
      "Operating profit fell to £41 million in 2026, from £52 million in 2025, as energy costs rose.",
    right: "Operating profit was £41 million in 2026, against £52 million in 2025.",
    wrong: "Operating profit was £41 million in 2026, against £25 million in 2025.",
    parts: ["against £52 million in 2025", "against £25 million in 2025"],
  }),
  ...pair("en-a2", "comparative", "en", {
    document: "Average occupancy in July was 82 per cent, compared with 76 per cent in July 2025.",
    right: "Occupancy averaged 82% in July, up from 76% a year before.",
    wrong: "Occupancy averaged 82% in July, down from 76% a year before.",
    parts: ["up from 76% a year before", "down from 76% a year before"],
  }),
  ...pair("en-a3", "comparative", "en", {
    document: "Net debt was $3.4 billion at 31 December 2026 (31 December 2025: $2.9 billion).",
    right:
      "Net debt stood at $3.4 billion at the end of 2026, compared with $2.9 billion a year earlier.",
    wrong:
      "Net debt stood at $2.9 billion at the end of 2026, compared with $3.4 billion a year earlier.",
    parts: [
      "compared with $2.9 billion a year earlier",
      "compared with $3.4 billion a year earlier",
    ],
  }),
  ...pair("zh-a1", "comparative", "zh-CN", {
    document: "报告期内营业利润为 2,750 万元，去年同期为 3,180 万元，主要受原材料涨价影响。",
    right: "营业利润为 2,750 万元，上年同期为 3,180 万元。",
    wrong: "营业利润为 2,750 万元，上年同期为 3,810 万元。",
    parts: ["上年同期为 3,180 万元", "上年同期为 3,810 万元"],
  }),
  ...pair("zh-a2", "comparative", "zh-CN", {
    document: "本年平均出租率为 91%，上年为 87%。",
    right: "出租率为 91%，较上年的 87% 有所上升。",
    wrong: "出租率为 91%，较上年的 87% 有所下降。",
    parts: ["较上年的 87% 有所上升", "较上年的 87% 有所下降"],
  }),
  ...pair("zh-a3", "comparative", "zh-CN", {
    document: "截至 2026 年末，净负债为 18.6 亿元（2025 年末：15.2 亿元）。",
    right: "2026 年末净负债为 18.6 亿元，一年前为 15.2 亿元。",
    wrong: "2026 年末净负债为 15.2 亿元，一年前为 18.6 亿元。",
    parts: ["一年前为 15.2 亿元", "一年前为 18.6 亿元"],
  }),
  ...pair("en-b1", "short-note", "en", {
    document: "Group sales were £2,615 million in the year, up 3 per cent on the year before.",
    right: "Sales were £2,615 million.",
    wrong: "Sales were £2,165 million.",
  }),
  ...pair("en-b2", "short-note", "en", {
    document: "Operating costs were $1.075 billion for the year, the company said.",
    right: "Costs came to $1,075 million.",
    wrong: "Costs came to $1,705 million.",
  }),
  ...pair("en-b3", "short-note", "en", {
    document: "The group employed 4,310 people at the end of the year.",
    right: "Headcount was 4,310.",
    wrong: "Headcount was 3,410.",
  }),
  ...pair("zh-b1", "short-note", "zh-CN", {
    document: "集团全年销售额为 2,615 万英镑，同比增长 3%。",
    right: "销售额为 2,615 万英镑。",
    wrong: "销售额为 2,165 万英镑。",
  }),
  ...pair("zh-b2", "short-note", "zh-CN", {
    document: "全年营业成本为 1075 万美元。",
    right: "成本为 1,075 万美元。",
    wrong: "成本为 1,705 万美元。",
  }),
  ...pair("zh-b3", "short-note", "zh-CN", {
    document: "The group employed 4,310 people at the end of the year.",
    right: "Headcount was 4,310.",
    wrong: "Headcount was 3,410.",
  }),
];

function pair(
  id: string,
  kind: HeldOut["kind"],
  language: Language,
  words: { document: string; right: string; wrong: string; parts?: readonly [string, string] },
): HeldOut[] {
  return [
    {
      id: `${id}-right`,
      kind,
      language,
      document: words.document,
      sentence: words.right,
      expected: "right",
      ...(words.parts && { part: words.parts[0] }),
    },
    {
      id: `${id}-wrong`,
      kind,
      language,
      document: words.document,
      sentence: words.wrong,
      expected: "wrong",
      ...(words.parts && { part: words.parts[1] }),
    },
  ];
}

/** What the run's requests did: each check Run's replies, and every refused, failed or timed-out request. */
const heard = {
  requests: 0,
  refused: 0,
  failed: 0,
  timedOut: 0,
  inputTokens: 0,
  outputTokens: 0,
  /** Dollars, at the catalog's Haiku 5.5 price, from each reply's own usage. */
  spent: 0,
  /** Requests not sent because the gate's stop was reached. */
  held: 0,
  replies: [] as { prompt: string; sentence: string; text: string }[],
};

/** The gate's stop in dollars, and what the gate spent before this arm-round. */
const STOP = Number(process.env.INCARNAMIND_LIVE_GATE_STOP_USD ?? "Infinity");
const SPENT_BEFORE = Number(process.env.INCARNAMIND_LIVE_GATE_SPENT_USD ?? "0");
/** Room for the requests already in flight when the stop is reached: a few at about $0.001 each. */
const IN_FLIGHT = 0.05;

type Usage = LanguageModelV4Usage;

/** Haiku 5.5's catalog price, per million tokens: uncached input, cache reads, cache writes, output. */
function priced(usage: Usage) {
  const input = usage.inputTokens;
  heard.inputTokens += input.total ?? 0;
  heard.outputTokens += usage.outputTokens.total ?? 0;
  heard.spent +=
    ((input.noCache ?? input.total ?? 0) * 0.1 +
      (input.cacheRead ?? 0) * 0.01 +
      (input.cacheWrite ?? 0) * 0.125 +
      (usage.outputTokens.total ?? 0) * 0.5) /
    1_000_000;
}

/** Sends no request once the gate's spend, before this arm-round and in it, reaches its stop. */
function underStop() {
  if (SPENT_BEFORE + heard.spent < STOP - IN_FLIGHT) return;
  heard.held++;
  throw new Error("The gate's spend stop is reached; no more requests are sent.");
}

type Params = LanguageModelV4CallOptions;

const textOf = (prompt: Params["prompt"], role?: string): string =>
  prompt
    .filter((message) => (role ? message.role === role : message.role !== "system"))
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => ("text" in part ? part.text : "")).join(""),
    )
    .join("\n");

function heardFailure(error: unknown): never {
  const status =
    typeof error === "object" && error !== null && "statusCode" in error
      ? Number(error.statusCode)
      : null;
  const name = error instanceof Error ? error.name : "";
  if (name === "AbortError" || name === "TimeoutError") heard.timedOut++;
  else if (status !== null && status >= 400) heard.refused++;
  else heard.failed++;
  throw error;
}

function heardReply(params: Params, text: string) {
  if (!textOf(params.prompt, "system").startsWith("You check one sentence")) return;
  const prompt = textOf(params.prompt);
  const sentence = /<sentence>\n([\s\S]*?)\n<\/sentence>/.exec(prompt)?.[1] ?? "";
  heard.replies.push({ prompt, sentence, text });
}

/** The real model, every request counted and every check Run's reply kept. */
const realModel: NonNullable<Parameters<typeof startCore>[1]>["createChatModel"] = (spec) =>
  wrapLanguageModel({
    model: createAiSdkChatModel(spec),
    middleware: {
      specificationVersion: "v4",
      wrapGenerate: async ({ doGenerate, params }) => {
        underStop();
        heard.requests++;
        const result = await Promise.resolve(doGenerate()).catch(heardFailure);
        priced(result.usage);
        const text = result.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
        if (text.length > 0) heardReply(params, text.join(""));
        return result;
      },
      wrapStream: async ({ doStream, params }) => {
        underStop();
        heard.requests++;
        const result = await Promise.resolve(doStream()).catch(heardFailure);
        let text = "";
        const stream = result.stream.pipeThrough(
          new TransformStream({
            transform(part, controller) {
              if (part.type === "text-delta") text += part.delta;
              if (part.type === "error") heard.failed++;
              if (part.type === "finish") priced(part.usage);
              controller.enqueue(part);
            },
            flush() {
              heardReply(params, text);
            },
          }),
        );
        return { ...result, stream };
      },
    },
  });

/** The dry run's sort: a sentence's parts are before and after its first comma, as a real sort may split them. */
function dryParts(text: string): { kind: "fact"; text: string }[] {
  const comma = /,\s+|，/u.exec(text);
  if (!comma) return [{ kind: "fact", text }];
  return [
    { kind: "fact", text: text.slice(0, comma.index) },
    { kind: "fact", text: text.slice(comma.index + comma[0].length).replace(/[.。]$/u, "") },
  ];
}

/** The dry run's judge: it sorts as `dryParts` does, searches once and finds nothing. */
const dryModel = scriptedModel(
  (call) => {
    heard.requests++;
    if (!isCheckRun(call)) return { text: "Done." };
    if (!call.results.some((result) => result.tool === "search_documents"))
      return { calls: [{ tool: "search_documents", input: { query: sentenceOf(call) } }] };
    const text = unsupportedReply(call);
    heard.replies.push({ prompt: call.prompt, sentence: sentenceOf(call), text });
    return { text };
  },
  {
    generate: (call) => {
      heard.requests++;
      if (call.question !== "find-claims") return checkGenerate({})(call);
      const { sentences } = JSON.parse(call.prompt) as {
        sentences: { number: number; text: string }[];
      };
      return {
        text: JSON.stringify({
          sentences: sentences.map(({ number, text }) => ({
            number,
            parts: dryParts(text),
          })),
        }),
      };
    },
  },
);

async function coreIn(language: Language): Promise<Core> {
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir, {
    paths: { dataDir, examples: EXAMPLES },
    createChatModel: DRY ? scriptedModels(dryModel).createChatModel : realModel,
  });
  core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
  await core.updateSettings({ user: { language, monthlyCap: { amount: 5, currency: "USD" } } });
  if (DRY) await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  else await core.saveChatProvider({ kind: "anthropic", apiKey: KEY ?? "", modelId: MODEL });
  return core;
}

async function examplesReady(core: Core): Promise<Document[]> {
  await core.createExamples();
  const examples = await core.getExamples();
  return vi.waitFor(
    async () => {
      const read = await core.listDocuments({ linkedFolderId: examples.linkedFolderId ?? "" });
      expect(read.length).toBe(2);
      expect(read.every((each) => each.status === "ready")).toBe(true);
      return read;
    },
    { timeout: 60_000 },
  );
}

/** A Citation of `line` in `document`, made as the viewer makes one from selected words. */
async function citationOf(core: Core, document: Document, line: string): Promise<JSONContent> {
  const selected = await core.citeSelection({
    documentId: document.id,
    parts: [{ unit: 1, text: line }],
  });
  return {
    type: "citation",
    attrs: {
      passageId: selected.passageId,
      documentId: document.id,
      documentName: document.name,
      contentHash: selected.contentHash,
      quote: selected.quote,
      pageFrom: selected.pageFrom,
      pageTo: selected.pageTo,
      location: selected.location,
      check: selected.check,
    },
  };
}

interface Written {
  client: MindClient;
  mindId: string;
  probes: readonly Probe[];
  row: Record<string, unknown>;
}

async function noteOf(
  core: Core,
  title: string,
  probes: readonly Probe[],
  citation: JSONContent | null,
  folderId?: string,
): Promise<Pick<Written, "client" | "mindId">> {
  const mind = await core.createMind({ title, ...(folderId && { folderId }) });
  const client = await connectToMind(core, mind.id);
  writeMind(
    client,
    probes.map(({ sentence }, index) => ({
      type: "paragraph",
      attrs: { id: `line-${index}` },
      content: [
        { type: "text", text: sentence },
        ...(citation && sentence.includes("EBITDA") ? [citation] : []),
      ],
    })),
  );
  await client.settled();
  return { client, mindId: mind.id };
}

/** The first verdict a check Run of `part`, in the Note whose sentence is `sentence`, wrote. */
function firstReplyOf(part: string, sentence: string): string | null {
  const reply = heard.replies.find(
    (each) =>
      each.sentence === part && each.prompt.includes(sentence) && /Verdict:/i.test(each.text),
  );
  return reply ? (readVerdict(reply.text)?.verdict ?? "unread") : null;
}

async function checkAll(core: Core, language: Language, notes: readonly Written[]) {
  const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
    translate(language, key, params);
  const rows: Record<string, unknown>[] = [];
  for (let at = 0; at < notes.length; at += AT_ONCE) {
    await Promise.all(
      notes.slice(at, at + AT_ONCE).map(async ({ client, mindId, probes, row }) => {
        const run = await core.checkMind({
          requestId: `${ARM}-${ROUND}-${mindId}`,
          mindId,
          mode: "all",
        });
        await client.settled();
        const spans = claimSpans(readMind(client));
        for (const probe of probes) {
          const span = spans.find((each) => each.sentence.text.trim() === probe.sentence);
          const check = span?.check;
          const parts = (check?.parts ?? []).map((each) => ({
            text: probe.sentence.slice(each.span.start, each.span.end),
            verdict: each.verdict,
            reason: each.verdict === "not-checked" ? each.reason : null,
          }));
          const part = probe.part ? parts.find((each) => each.text === probe.part) : undefined;
          rows.push({
            ...row,
            run: run.kind,
            sentence: probe.sentence,
            expected: probe.expected,
            state: check?.state ?? "no-mark",
            reason: check?.state === "not-checked" ? check.reason : null,
            line:
              check?.state === "not-checked" && check.reason
                ? reasonText(t, language, check.reason, check.detail)
                : null,
            figures: (check?.figures ?? []).map((figure) => ({
              shown: figure.reading.chars,
              state: figure.state,
              reason: figure.state === "not-checked" ? figure.reason : null,
            })),
            parts,
            ...(probe.part && {
              part: probe.part,
              partVerdict: part?.verdict ?? null,
              firstReply: firstReplyOf(probe.part, probe.sentence),
            }),
          });
        }
      }),
    );
  }
  return rows;
}

function write(rows: readonly Record<string, unknown>[]) {
  if (!OUT) return;
  for (const row of rows) appendFileSync(OUT, `${JSON.stringify(row)}\n`);
}

async function exampleRound(language: Language, own: boolean) {
  const words = EXAMPLE[language];
  const core = await coreIn(language);
  const report = (await examplesReady(core)).find((each) => each.name === words.report);
  if (!report) throw new Error("The example's report isn't there.");
  if (own) {
    const sources = await createSourceFolder();
    await addAndProcess(core, [
      await writeSourceFile(
        sources,
        `${words.own.name}.md`,
        `# ${words.own.name}\n\n${words.own.text}\n`,
      ),
    ]);
  }
  const citation = await citationOf(core, report, words.line);
  const setup = own ? "example+own" : "example";
  const base = { arm: ARM, round: ROUND, group: "example", language, setup };
  const notes: Written[] = [
    {
      ...(await noteOf(core, "Summary of my documents", words.note, citation)),
      probes: words.note,
      row: { ...base, case: "note" },
    },
    ...(await Promise.all(
      words.twins.map(async (twin, index) => ({
        ...(await noteOf(core, `Twin ${index + 1}`, [twin], citation)),
        probes: [twin],
        row: { ...base, case: `twin-${index + 1}` },
      })),
    )),
  ];
  const rows = await checkAll(core, language, notes);
  const { spent } = await core.getCostSummary();
  core.close();
  return { rows, spent };
}

async function heldOutRound(language: Language) {
  const cases = HELD_OUT.filter((each) => each.language === language);
  const core = await coreIn(language);
  const sources = await createSourceFolder();
  const notes: Written[] = [];
  for (const each of cases) {
    const [file] = await addAndProcess(core, [
      await writeSourceFile(sources, `${each.id}.md`, `# ${each.id}\n\n${each.document}\n`),
    ]);
    if (!file) throw new Error(`${each.id}'s Document didn't process.`);
    const folder = await core.createLibraryGroup({ name: each.id, description: "" });
    await core.moveToFolder({ documentIds: [file.id], folderId: folder.id });
    notes.push({
      ...(await noteOf(core, each.id, [each], null, folder.id)),
      probes: [each],
      row: {
        arm: ARM,
        round: ROUND,
        group: "held-out",
        language,
        case: each.id,
        kind: each.kind,
      },
    });
  }
  const rows = await checkAll(core, language, notes);
  const { spent } = await core.getCostSummary();
  core.close();
  return { rows, spent };
}

describe("the #3088 gate", () => {
  test.skipIf(!DRY && KEY === undefined)(
    "one round of every case, each Note checked once",
    { timeout: 3_600_000 },
    async () => {
      const spent: unknown[] = [];
      for (const language of ["en", "zh-CN"] as const) {
        if (GROUPS.includes("example"))
          for (const own of [false, true]) {
            const round = await exampleRound(language, own);
            write(round.rows);
            spent.push(round.spent);
          }
        if (GROUPS.includes("held-out")) {
          const round = await heldOutRound(language);
          write(round.rows);
          spent.push(round.spent);
        }
      }
      write([
        {
          arm: ARM,
          round: ROUND,
          group: "run",
          model: DRY ? "scripted" : MODEL,
          requests: heard.requests,
          refused: heard.refused,
          failed: heard.failed,
          timedOut: heard.timedOut,
          inputTokens: heard.inputTokens,
          outputTokens: heard.outputTokens,
          priced: heard.spent,
          held: heard.held,
          spent,
        },
      ]);
      expect(heard.requests).toBeGreaterThan(0);
    },
  );
});
