/**
 * Keeps what a real model replied when a sentence about a Document's name is checked against the
 * Library (#2525), so the reading of those replies can be replayed for free
 * (tests/core/libraryRepliesReplay.test.ts) instead of asked again. Each case has a Library of its
 * own; each request's reply text and Tool calls are written, with the check's outcome, to the file
 * INCARNAMIND_CAPTURE names. Runs only with the key in the environment
 * (INCARNAMIND_LIVE_ANTHROPIC_KEY; the model is INCARNAMIND_LIVE_ANTHROPIC_MODEL, Haiku 5.5 by
 * default), makes no request without one, and stops at INCARNAMIND_LIVE_CAP US dollars (0.10).
 * The recorder wraps the model here only: the app's own request path is as it is.
 *
 * Bars for a run with twins that are wrong, written before it (eight names, four with a number and
 * four without, five checks each: the true sentence "appears once" about a name held once, the true
 * sentence "appears twice" about a name held twice, the wrong sentence "appears once" about a name
 * held twice, twice over, and the wrong sentence "appears twice" about a name held once; a name held
 * twice is two Documents of one name, a .txt and a .md file, so the Library's fact says two; 40
 * checks an arm). Run at the same time on main just before the Library-line wording (#3245) and
 * just after it, which differ by that change alone, so a wrong Supported can be told from one main
 * already had:
 *   - Wrong Supported: 0 of the 24 wrong sentences on either arm. A wrong Supported just after the
 *     wording that isn't there just before it means the wording is reverted.
 *   - False Contradicted: 0 of the 16 true sentences on either arm.
 * A wrong sentence is seen to be wrong first: on the arm before the wording, in the replies kept,
 * its fact line says what makes it wrong (two Documents of the name, or one).
 * And for the branch in which a number in a Document's name is no figure it is asked about (the
 * name's number is also left out of the engine's own reading of the claim):
 *   - Wrong Supported: 0 of the 24, and false Contradicted 0 of the 16.
 *   - Rescued: at least 5 of the 8 true "appears once" sentences about names with a number
 *     Supported, by the Library's own fact (0 of 8 on main after the wording, and 4 of 8 on the
 *     branch before the engine stopped asking for the name's number).
 */
import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { wrapLanguageModel } from "ai";
import { describe, expect, test } from "vitest";
import { type Core, createAiSdkChatModel } from "../../src/core";
import { questionOf } from "../../src/core/answers/judge";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import type { ChatModelFactory } from "../../src/core/providers/models";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL =
  process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ??
  (catalogProvider("anthropic")?.roles.quickTasks as string);
const CAP = Number(process.env.INCARNAMIND_LIVE_CAP ?? "0.10");

type Language = "en" | "zh-CN";

interface Recorded {
  via: "stream" | "generate";
  question: string | null;
  text: string;
  tools: { name: string; input: string }[];
  finish: string;
}

/** The model the core builds, with each request's reply kept in `into`, in the order they began. */
function recording(into: Recorded[]): ChatModelFactory {
  return (spec) =>
    wrapLanguageModel({
      model: createAiSdkChatModel(spec),
      middleware: {
        specificationVersion: "v4",
        wrapGenerate: async ({ doGenerate, params }) => {
          const entry: Recorded = {
            via: "generate",
            question: questionOf(params) ?? null,
            text: "",
            tools: [],
            finish: "",
          };
          into.push(entry);
          const result = await doGenerate();
          for (const part of result.content) {
            if (part.type === "text") entry.text += part.text;
            else if (part.type === "tool-call")
              entry.tools.push({ name: part.toolName, input: part.input });
          }
          entry.finish = result.finishReason.unified;
          return result;
        },
        wrapStream: async ({ doStream, params }) => {
          const entry: Recorded = {
            via: "stream",
            question: questionOf(params) ?? null,
            text: "",
            tools: [],
            finish: "",
          };
          into.push(entry);
          const result = await doStream();
          const stream = result.stream.pipeThrough(
            new TransformStream({
              transform(part, controller) {
                if (part.type === "text-delta") entry.text += part.delta;
                else if (part.type === "tool-call")
                  entry.tools.push({ name: part.toolName, input: part.input });
                else if (part.type === "finish") entry.finish = part.finishReason.unified;
                controller.enqueue(part);
              },
            }),
          );
          return { ...result, stream };
        },
      },
    });
}

const FILLER = [
  { name: "Harbour survey.txt", contents: "Harbour survey: the north wall needs repointing." },
  { name: "Crew roster.txt", contents: "Crew roster: Ines, Tomas and Wren on the early shift." },
  { name: "Tide log.csv", contents: "Date,High water\n2026-10-01,04:12\n2026-10-02,04:55\n" },
];

interface Case {
  language: Language;
  name: string;
  copies: 1 | 2;
  says: "once" | "twice";
}

const sentenceOf = ({ language, name, says }: Case): string =>
  language === "zh-CN"
    ? `${name} 在你的资料库中出现了${says === "once" ? "一" : "两"}次。`
    : `${name} appears ${says} in your Library.`;

/** Four names with a number in them and four without, in English and Chinese. */
const NAMES: { language: Language; name: string }[] = [
  ...["Report 12", "Invoice 10432", "Minutes 3.2", "Harbour survey", "Crew roster", "Tide log"].map(
    (name) => ({ language: "en" as const, name }),
  ),
  ...["报告 12", "港口勘测"].map((name) => ({ language: "zh-CN" as const, name })),
];

/**
 * Each name, five checks: it held once and said once (true), held twice and said twice (true), held
 * twice and said once (wrong, twice over), held once and said twice (wrong). A name held twice is two
 * Documents of one name, a .txt and a .md file: the Library's fact says two.
 */
const CASES: Case[] = NAMES.flatMap(({ language, name }) => [
  { language, name, copies: 1 as const, says: "once" as const },
  { language, name, copies: 2 as const, says: "twice" as const },
  { language, name, copies: 2 as const, says: "once" as const },
  { language, name, copies: 2 as const, says: "once" as const },
  { language, name, copies: 1 as const, says: "twice" as const },
]);

const spentOf = async (core: Core): Promise<number> =>
  (await core.getCostSummary()).spent
    .filter((money) => money.currency === "USD")
    .reduce((sum, money) => sum + money.amount, 0);

describe("replies to a sentence about a name, kept for replay", () => {
  test.skipIf(KEY === undefined || !process.env.INCARNAMIND_CAPTURE)(
    `${MODEL}: keeps each check's replies`,
    { timeout: 3_600_000 },
    async () => {
      let total = 0;
      let kept = 0;
      const wrongSupported: string[] = [];
      let trueSupported = 0;
      let trueContradicted = 0;
      let trueChecks = 0;
      for (const each of CASES) {
        if (total >= CAP) break;
        const calls: Recorded[] = [];
        const core = startCore(await createTempDataFolder(), { createChatModel: recording(calls) });
        core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
        await core.saveChatProvider({ kind: "anthropic", apiKey: KEY ?? "", modelId: MODEL });
        await core.updateSettings({ user: { language: each.language } });
        const sources = await createTempDataFolder();
        const copies = Array.from({ length: each.copies }, (_, at) => ({
          name: `${each.name}.${at === 0 ? "txt" : "md"}`,
          contents: `${each.name}: the figures for the quarter.`,
        }));
        const files = [...FILLER.filter((file) => !file.name.startsWith(each.name)), ...copies];
        const paths = await Promise.all(
          files.map((file) => writeSourceFile(sources, file.name, file.contents)),
        );
        await addAndProcess(core, paths);
        const note = await core.createMind({ title: "Library overview", folderId: null });
        const mind = await connectToMind(core, note.id);
        const sentence = sentenceOf(each);
        writeMind(mind, [
          { type: "paragraph", attrs: { id: "one" }, content: [{ type: "text", text: sentence }] },
        ]);
        await mind.settled();
        // Only what the check asked: the Library's processing and the Note's writing are not kept.
        calls.length = 0;
        await core.checkMind({ requestId: `check-${randomUUID()}`, mindId: note.id, mode: "all" });
        await mind.settled();
        const check = claimSpans(readMind(mind))[0]?.check;
        total += await spentOf(core);
        core.close();
        await appendFile(
          process.env.INCARNAMIND_CAPTURE ?? "",
          `${JSON.stringify({
            ...each,
            sentence,
            state: check?.state ?? "no mark",
            reason: check?.state === "not-checked" ? (check.reason ?? null) : null,
            unsupportedReason: check?.unsupported?.reason ?? null,
            calls,
          })}\n`,
        );
        kept++;
        if ((each.copies === 1) === (each.says === "once")) {
          trueChecks++;
          if (check?.state === "supported") trueSupported++;
          if (check?.state === "contradicted") trueContradicted++;
        } else if (check?.state === "supported") wrongSupported.push(sentence);
      }
      await appendFile(
        process.env.INCARNAMIND_CAPTURE ?? "",
        `${JSON.stringify({ summary: { kept, trueChecks, trueSupported, trueContradicted, wrongSupported, spent: total } })}\n`,
      );
      expect(kept).toBeGreaterThan(0);
      expect(wrongSupported).toEqual([]);
    },
  );
});
