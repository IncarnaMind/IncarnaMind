/**
 * The sentence check under both rules (`gates/check-false-passes.md`, #3003, #2739): a reply saved
 * from #2847's gates, or a held-out case's sentence, is pressed in call help as the model wrote it;
 * only the check's requests go to a real model, under the rule before #3003 and under today's, the
 * order turning per item. Each place's sentence and mark are read from the app, with the check's
 * tokens, its time and what each field it copied held. With `INCARNAMIND_EVAL_SPEED_REJUDGE`, the
 * saved replies are judged again per place instead, and nothing is pressed.
 *
 *   INCARNAMIND_EVAL_SPEED_TRIAL: saved report.json files, comma-separated (the dev trial), or
 *   INCARNAMIND_EVAL_SPEED_CASES: a held-out cases' JSON file, with INCARNAMIND_EVAL_SPEED_RUNS;
 *   INCARNAMIND_EVAL_SPEED_OUT: the folder the records go in; the key, ledger and stop as eval:speed's.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type LanguageModelMiddleware, wrapLanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { expect, test } from "vitest";
import type { Core } from "../../src/core";
import { isCopyOf } from "../../src/core/answers/checks/answerCheck";
import { createFakeEmbedder } from "../../src/core/embedding/fake";
import type { ChatLanguageModel } from "../../src/core/providers/models";
import { readHelpReply } from "../../src/renderer/src/helpReply";
import { citedSentences } from "../../src/shared/citedSentences";
import { type CallHelpSet, callHelpCaseOf, callHelpGroup, judgeCallHelp } from "./callHelp";
import type { CallDocument, CallHelpCase, CallTurn } from "./callHelpCases";
import { judgeOf } from "./judge";
import { openLedger } from "./ledger";
import { type PairedGroup, type PlaceMark, runOnArm } from "./paired";
import { env, list, modelNamed, spentUsd } from "./settings";

const RULES = ["as-before", "today"] as const;
type Rule = (typeof RULES)[number];

interface Item {
  key: string;
  model: string;
  group: PairedGroup;
  /** The reply as the model wrote it, its markers as `[^n]`, and the quote each marker cites. */
  raw: string;
  quotes: string[];
}

const CHECK_LINE =
  /^\[(found|not-found|unsupported|contradicted|not-checked|checking|cant-check)( ✓)?\] (.*?): “(.*)”$/;

/** A saved press's reply and quotes, as its report.json kept them. */
function savedReply(text: string): { raw: string; quotes: string[] } {
  const lines = text.split("\n");
  const end = lines.findIndex((line) => CHECK_LINE.test(line));
  const reply = lines.slice(0, end === -1 ? lines.length : end).join("\n");
  const quotes = lines
    .slice(end === -1 ? lines.length : end)
    .flatMap((line) => CHECK_LINE.exec(line)?.[4] ?? []);
  return { raw: reply.replace(/\[(\d+)\]/g, "[^$1]"), quotes };
}

interface SavedRow {
  set: CallHelpSet;
  id: string;
  model: string;
  run: number;
  candidate: { text: string; marks?: { judge: { unstated: number[] } } };
}

async function savedRows(): Promise<SavedRow[]> {
  const rows: SavedRow[] = [];
  for (const file of list("TRIAL") ?? list("REJUDGE") ?? []) {
    const report: { rows: SavedRow[] } = JSON.parse(await readFile(file, "utf8"));
    rows.push(...report.rows);
  }
  return rows;
}

interface HeldOutCase {
  id: string;
  shape: number;
  pair: string;
  polarity: "negative" | "positive";
  language: "en" | "zh-CN";
  documents: { name?: string; file?: string; text: string }[];
  call?: CallTurn[];
  sentence: string;
  cites: { in: string; quote: string }[];
}

/** A held-out case as a call: its Documents, its call (one line when it has none) and its sentence. */
function heldOutItems(cases: readonly HeldOutCase[], model: string, runs: number): Item[] {
  return cases.flatMap((each) => {
    const documents: CallDocument[] = each.documents.map((document) => ({
      file: document.file ?? `${document.name ?? "Document"}.md`,
      text: document.text,
    }));
    const call: CallHelpCase = {
      id: each.id,
      language: each.language,
      kind: "answer",
      needs: "newest",
      long: false,
      turns: each.call ?? [
        { who: "them", text: each.language === "zh-CN" ? "这个怎么说？" : "What does it say?" },
      ],
      documents,
      answer: "",
      rests: [],
    };
    const markers = each.cites.map((_, index) => `[^${index + 1}]`).join("");
    return Array.from({ length: runs }, (_, run) => ({
      key: `${each.id} run ${run + 1}`,
      model,
      group: callHelpGroup(call, "call-help-marks-4"),
      raw: `${each.sentence.replace(/[。.]$/, "")} ${markers}`,
      quotes: each.cites.map((cite) => cite.quote),
    }));
  });
}

type Options = Parameters<MockLanguageModelV4["doGenerate"]>[0];

const questionOf = (options: Options) =>
  (options.providerOptions as Record<string, { question?: string }> | undefined)?.incarnamind
    ?.question;

const textOf = (options: Options) =>
  options.prompt
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
    )
    .join("\n");

const passagesIn = (text: string) =>
  [...text.matchAll(/<passage id="([^"]+)"[^>]*>\n([\s\S]*?)\n<\/passage>/g)].map((match) => ({
    id: match[1] ?? "",
    text: match[2] ?? "",
  }));

const USAGE = {
  inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/** The reply's own requests, scripted to the item: cite its quotes, then write its reply. */
function scripted(current: () => Item) {
  const reply = (options: Options): { text?: string; cite?: object } => {
    const question = questionOf(options);
    // A dry run answers the check itself, every sentence supported, so nothing is sent anywhere.
    if (question === "sentence-batch") {
      return {
        text: JSON.stringify({
          sentences: [...textOf(options).matchAll(/<sentence number="(\d+)">/g)].map((match) => ({
            number: Number(match[1]),
            kind: "fact",
            unstated: null,
            uncited: null,
            verdict: "supported",
            roles: "same",
            time: "same",
            quoted: "states",
            says: null,
          })),
        }),
      };
    }
    if (question === "unmarked-quotes") return { text: '{"citations":[]}' };
    if (question !== undefined) return { text: "{}" };
    const item = current();
    const cited = options.prompt.some(
      (message) =>
        message.role === "tool" &&
        message.content.some((part) => part.type === "tool-result" && part.toolName === "cite"),
    );
    if (cited || item.quotes.length === 0) return { text: item.raw };
    const passages = passagesIn(textOf(options));
    const citations = item.quotes.flatMap((quote, at) => {
      const plain = quote.replace(/[。.]$/, "");
      const passage = passages.find((each) => each.text.includes(plain));
      return passage ? [{ marker: at + 1, passage: passage.id, quote }] : [];
    });
    return { cite: { citations } };
  };
  let call = 0;
  return new MockLanguageModelV4({
    doGenerate: async (options) => ({
      content: [{ type: "text", text: reply(options).text ?? "" }],
      finishReason: { unified: "stop", raw: undefined },
      usage: USAGE,
      warnings: [],
    }),
    doStream: async (options) => {
      const given = reply(options);
      const id = `call-${call++}`;
      const parts: Awaited<
        ReturnType<MockLanguageModelV4["doStream"]>
      >["stream"] extends ReadableStream<infer Part>
        ? Part[]
        : never = [{ type: "stream-start", warnings: [] }];
      if (given.text) {
        parts.push({ type: "text-start", id: "answer" });
        parts.push({ type: "text-delta", id: "answer", delta: given.text });
        parts.push({ type: "text-end", id: "answer" });
      }
      if (given.cite) {
        parts.push({
          type: "tool-call",
          toolCallId: id,
          toolName: "cite",
          input: JSON.stringify(given.cite),
        });
      }
      parts.push({
        type: "finish",
        finishReason: { unified: given.cite ? "tool-calls" : "stop", raw: undefined },
        usage: USAGE,
      });
      return {
        stream: new ReadableStream({
          pull(controller) {
            const part = parts.shift();
            if (part) controller.enqueue(part);
            else controller.close();
          },
        }),
      };
    },
  });
}

/** A batch the real model answered: what it was sent and the fields it copied, each read as the check reads it. */
interface BatchRecord {
  sentences: string[];
  entries: {
    number: number;
    verdict: unknown;
    unstated: unknown;
    uncited: unknown;
    stray: boolean;
  }[];
  reply: string;
}

/** Only the check's requests go to the real model; each one's reply is kept. */
function routed(
  real: ChatLanguageModel,
  fake: MockLanguageModelV4,
  batches: BatchRecord[],
): ChatLanguageModel {
  const middleware: LanguageModelMiddleware = {
    specificationVersion: "v4",
    wrapGenerate: async ({ doGenerate, params }) => {
      if (questionOf(params) !== "sentence-batch") return fake.doGenerate(params);
      const result = env("DRY") ? await fake.doGenerate(params) : await doGenerate();
      const reply = result.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("");
      const sentences = [
        ...textOf(params).matchAll(/<sentence number="\d+">\n([\s\S]*?)\n<\/sentence>/g),
      ].map((match) => match[1] ?? "");
      let entries: BatchRecord["entries"] = [];
      try {
        const read: unknown = JSON.parse(reply.match(/\{[\s\S]*\}/)?.[0] ?? "");
        const list =
          typeof read === "object" &&
          read !== null &&
          "sentences" in read &&
          Array.isArray(read.sentences)
            ? read.sentences
            : [];
        entries = list.flatMap((entry: unknown) => {
          if (typeof entry !== "object" || entry === null) return [];
          const fields = entry as Record<string, unknown>;
          const number = typeof fields.number === "number" ? fields.number : Number(fields.number);
          const sentence = sentences[number - 1] ?? "";
          const stray = [fields.unstated, fields.uncited].some(
            (words) =>
              typeof words === "string" && words.trim() !== "" && !isCopyOf(sentence, words),
          );
          return [
            {
              number,
              verdict: fields.verdict,
              unstated: fields.unstated,
              uncited: fields.uncited,
              stray,
            },
          ];
        });
      } catch {
        entries = [];
      }
      batches.push({ sentences, entries, reply });
      return result;
    },
    wrapStream: async ({ doStream, params }) =>
      questionOf(params) === "sentence-batch" ? doStream() : fake.doStream(params),
  };
  return wrapLanguageModel({ model: real, middleware });
}

const judging = () =>
  new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: '{"grade": "right", "unstated": []}' }],
      finishReason: { unified: "stop", raw: undefined },
      usage: USAGE,
      warnings: [],
    }),
  });

interface Pressed {
  key: string;
  model: string;
  rule: Rule;
  status: string;
  error: string | null;
  places: PlaceMark[];
  settledMs: number | null;
  check: { outputTokens: number | null; ms: number; outcome: string | undefined }[];
  batches: BatchRecord[];
}

/** Presses every item under both rules, the order turning per item, until the stop. */
async function pressAll(items: readonly Item[], out: string): Promise<Pressed[]> {
  const stopUsd = Number(env("STOP_USD") ?? "0");
  if (!(stopUsd > 0))
    throw new Error("INCARNAMIND_EVAL_SPEED_STOP_USD is needed for a run that pays.");
  const ledger = await openLedger(env("LEDGER"), "check trial");
  const pressed: Pressed[] = [];
  let spentBefore = 0;
  const groups = [...new Set(items.map((item) => item.group.name))];
  for (const [at, name] of groups.entries()) {
    const mine = items.filter((item) => item.group.name === name);
    const first = mine[0];
    if (!first) continue;
    const order: readonly Rule[] = at % 2 === 0 ? RULES : [...RULES].reverse();
    let current = first;
    const batches: BatchRecord[] = [];
    const fake = scripted(() => current);
    const opened = await Promise.all(
      order.map((rule) =>
        first.group.open({
          embedder: createFakeEmbedder(),
          keep: false,
          log: () => undefined,
          embeddings: false,
          recordTimings: true,
          chatModels: (inner) => (spec) => routed(inner(spec), fake, batches),
          checkRuleAsBefore: () => rule === "as-before",
        }),
      ),
    );
    const cores: Core[] = opened.map((each) => each.library.core);
    try {
      for (const core of cores) {
        core.on("consent.requested", (request) => {
          void core.respondToConsent(
            request.requestId,
            ["chat", "checks"].includes(request.flow.id),
          );
        });
      }
      for (const item of mine) {
        const spent =
          spentBefore + (await Promise.all(cores.map(spentUsd))).reduce((a, b) => a + b, 0);
        await ledger.record(spent);
        if (ledger.before + spent >= stopUsd) {
          await writeFile(
            join(out, "stopped.txt"),
            `Stopped at $${(ledger.before + spent).toFixed(2)} before ${item.key}.`,
          );
          return pressed;
        }
        current = item;
        for (const [index, rule] of order.entries()) {
          const library = opened[index]?.library;
          const meeting = opened[index]?.meeting;
          const run = mine[0]?.group.items[0];
          if (!library || !meeting || !run || !library.timings)
            throw new Error(`${name} didn't open.`);
          const model = modelNamed(item.model, "TRIAL");
          const { id: providerId } = await library.core.saveChatProvider(model);
          batches.length = 0;
          const done = await runOnArm(run, {
            library,
            meeting,
            recorder: library.timings,
            choice: { providerId, modelId: model.modelId },
            model: item.model,
            arm: rule === "as-before" ? "check-rule-as-before" : "today",
            grade: async () => "unread",
            claimsJudge: judging(),
          });
          pressed.push({
            key: item.key,
            model: item.model,
            rule,
            status: done.status,
            error: done.error,
            places: done.places ?? [],
            settledMs: done.marks?.settledMs ?? null,
            check: (done.requests ?? [])
              .filter((request) => request.step === "answer-check")
              .map((request) => ({
                outputTokens: request.outputTokens,
                ms: request.endMs,
                outcome: request.outcome,
              })),
            batches: [...batches],
          });
        }
      }
      spentBefore += (await Promise.all(cores.map(spentUsd))).reduce((a, b) => a + b, 0);
    } finally {
      await Promise.all(opened.map((each) => each.close()));
    }
  }
  return pressed;
}

/** The saved replies judged again per place, with the number listing their earlier judge gave. */
async function rejudge(rows: readonly SavedRow[], out: string) {
  const each = Number(env("REJUDGE_EACH") ?? "30");
  const stopUsd = Number(env("STOP_USD") ?? "0");
  if (!(stopUsd > 0))
    throw new Error("INCARNAMIND_EVAL_SPEED_STOP_USD is needed for a run that pays.");
  const ledger = await openLedger(env("LEDGER"), "judge's sample");
  const judge = judgeOf([]);
  const picked = [...new Set(rows.map((row) => row.model))].flatMap((model) =>
    rows.filter((row) => row.model === model && row.candidate.marks).slice(0, each),
  );
  const judged = [];
  for (const row of picked) {
    await ledger.record(judge.spent());
    if (ledger.before + judge.spent() >= stopUsd) break;
    const known = callHelpCaseOf(row.set, row.id);
    if (!known) continue;
    const { raw, quotes } = savedReply(row.candidate.text);
    const sentences = citedSentences(raw);
    const places: PlaceMark[] = readHelpReply(raw)
      .flatMap((item) => [item.lead, ...item.notes, item.effect ?? []].flat())
      .flatMap((piece) => (piece.kind === "citation" ? [piece] : []))
      .map((piece, index) => {
        const sentence = sentences.find((one) => one.at.includes(piece.at));
        const markers = [...new Set(sentence?.markers ?? [piece.marker])];
        return {
          id: `p${index + 1}`,
          number: piece.marker,
          marker: piece.marker,
          at: piece.at,
          sentence: sentence?.sentence ?? "",
          quotes: markers.flatMap((marker) =>
            quotes[marker - 1] ? [`“${quotes[marker - 1]}”`] : [],
          ),
          found: true,
          shown: false,
          unbacked: null,
        };
      });
    const reply = raw.replace(/\[\^(\d+)\]/g, "[$1]");
    const read = await judgeCallHelp(
      judge.model,
      known,
      [...(known.before ?? []), ...known.turns],
      reply,
      [],
      places,
    );
    const unbacked = read.unbacked ?? [];
    judged.push({
      set: row.set,
      id: row.id,
      model: row.model,
      run: row.run,
      grade: read.grade,
      unbacked,
      byNumber: [
        ...new Set(
          places.filter((place) => unbacked.includes(place.id)).map((place) => place.number),
        ),
      ],
      earlier: row.candidate.marks?.judge.unstated ?? [],
    });
  }
  await writeFile(
    join(out, "rejudged.json"),
    JSON.stringify({ judge: judge.name, spent: judge.spent(), judged }, null, 1),
  );
  return judged;
}

test("the sentence check under both rules", { timeout: 6 * 3600_000 }, async () => {
  const out = env("OUT");
  if (!out) throw new Error("INCARNAMIND_EVAL_SPEED_OUT names the folder the records go in.");
  await mkdir(out, { recursive: true });
  if (env("REJUDGE")) {
    const judged = await rejudge(await savedRows(), out);
    expect(judged.length).toBeGreaterThan(0);
    return;
  }
  const items: Item[] = env("CASES")
    ? heldOutItems(
        JSON.parse(await readFile(env("CASES") ?? "", "utf8")),
        env("MODEL") ?? "anthropic/claude-haiku-5-5",
        Number(env("RUNS") ?? "1"),
      )
    : (await savedRows()).flatMap((row) => {
        const known = callHelpCaseOf(row.set, row.id);
        if (!known) return [];
        return [
          {
            key: `${row.set} ${row.model} ${row.id} run ${row.run}`,
            model: row.model,
            group: callHelpGroup(known, row.set),
            ...savedReply(row.candidate.text),
          },
        ];
      });
  const pressed = await pressAll(items, out);
  await writeFile(join(out, "pressed.json"), JSON.stringify(pressed, null, 1));
  expect(pressed.length).toBeGreaterThan(0);
});
