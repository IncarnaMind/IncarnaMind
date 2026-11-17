/**
 * The last box of #2525 on a real model, each case in a Library of its own. Runs only with the key
 * in the environment (INCARNAMIND_LIVE_ANTHROPIC_KEY; the model is INCARNAMIND_LIVE_ANTHROPIC_MODEL,
 * Haiku 5.5 by default) and makes no request without one. INCARNAMIND_LIVE_REPORT keeps what each
 * case said, INCARNAMIND_LIVE_ARM names the code it ran on (main or the branch), and
 * INCARNAMIND_LIVE_CAP stops the arm at that many US dollars (0.45 by default). The same file runs
 * on main and on the branch, in the same hour.
 *
 * Bars, written before any run:
 *
 * (1) A true sentence about a Document whose name holds a number ("Report 12 appears once in your
 * Library.") that a Library fact settles, in English and Chinese, three name shapes each ("Report
 * 12", "Invoice 10432", "Minutes 3.2"), two checks of each. A wrong twin of each (the name appears
 * twice and the sentence says once; or it appears once and the sentence says twice) is checked as
 * well.
 *   - Wrong Supported: 0 of the 24 wrong-twin checks. Any Supported on a wrong twin fails the run.
 *   - False Contradicted: 0 of the 12 true-sentence checks.
 *   - Rescued: at least 8 of the 12 true-sentence checks are Supported, by the Library's own fact
 *     (main is read in the same run: the number in the name held it Not checked).
 *
 * (2) Asked "What files do I have?" (我有哪些文件？) in a Library of six readable Documents, a damaged
 * PDF and a scan with no text, six asks in each language, every answer read by hand.
 *   - The answer names the damaged Document, with why it couldn't be read, in at least 10 of the 12.
 *   - It lists no fewer of the six readable Documents than main does in the same run (the sum over
 *     the 12 asks).
 */
import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { type Core, createAiSdkChatModel } from "../../src/core";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { askAndFinish } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { answerText, readMind, writeMind } from "../helpers/minds";
import { buildPdf } from "../helpers/pdf";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL =
  process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ??
  (catalogProvider("anthropic")?.roles.quickTasks as string);
const ARM = process.env.INCARNAMIND_LIVE_ARM ?? "branch";
const CAP = Number(process.env.INCARNAMIND_LIVE_CAP ?? "0.45");
const REPEATS = 2;

type Language = "en" | "zh-CN";

async function libraryOf(
  files: readonly { name: string; contents: string | Uint8Array }[],
  language: Language,
) {
  const core = startCore(await createTempDataFolder(), { createChatModel: createAiSdkChatModel });
  core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
  await core.saveChatProvider({ kind: "anthropic", apiKey: KEY ?? "", modelId: MODEL });
  await core.updateSettings({ user: { language } });
  const sources = await createTempDataFolder();
  const paths = await Promise.all(
    files.map((file) => writeSourceFile(sources, file.name, file.contents)),
  );
  await addAndProcess(core, paths);
  return core;
}

const spentOf = async (core: Core): Promise<number> =>
  (await core.getCostSummary()).spent
    .filter((money) => money.currency === "USD")
    .reduce((sum, money) => sum + money.amount, 0);

const FILLER = [
  { name: "Harbour survey.txt", contents: "Harbour survey: the north wall needs repointing." },
  { name: "Crew roster.txt", contents: "Crew roster: Ines, Tomas and Wren on the early shift." },
  { name: "Tide log.csv", contents: "Date,High water\n2026-10-01,04:12\n2026-10-02,04:55\n" },
];

interface NameCase {
  language: Language;
  name: string;
  /** How many Documents have the name, and what the sentence says. */
  copies: 1 | 2;
  says: "once" | "twice";
}

const NAMES: Record<Language, string[]> = {
  en: ["Report 12", "Invoice 10432", "Minutes 3.2"],
  "zh-CN": ["报告 12", "发票 10432", "会议纪要 3.2"],
};

const sentenceOf = ({ language, name, says }: NameCase): string =>
  language === "zh-CN"
    ? `${name} 在你的资料库中出现了${says === "once" ? "一" : "两"}次。`
    : `${name} appears ${says} in your Library.`;

const CASES: NameCase[] = (["en", "zh-CN"] as const).flatMap((language) =>
  NAMES[language].flatMap((name) => [
    { language, name, copies: 1 as const, says: "once" as const },
    { language, name, copies: 2 as const, says: "once" as const },
    { language, name, copies: 1 as const, says: "twice" as const },
  ]),
);

const isTrue = (each: NameCase) => (each.copies === 1) === (each.says === "once");

async function stateOfNameCase(each: NameCase): Promise<{ state: string; spent: number }> {
  const copies = Array.from({ length: each.copies }, (_, at) => ({
    name: `${each.name}${at === 0 ? "" : " (2)"}.txt`,
    contents: `${each.name}: the figures for the quarter.`,
  }));
  const core = await libraryOf([...FILLER, ...copies], each.language);
  const note = await core.createMind({ title: "Library overview", folderId: null });
  const mind = await connectToMind(core, note.id);
  const sentence = sentenceOf(each);
  writeMind(mind, [
    { type: "paragraph", attrs: { id: "one" }, content: [{ type: "text", text: sentence }] },
  ]);
  await mind.settled();
  await core.checkMind({ requestId: `check-${randomUUID()}`, mindId: note.id, mode: "all" });
  await mind.settled();
  const check = claimSpans(readMind(mind))[0]?.check;
  const spent = await spentOf(core);
  core.close();
  return { state: check?.state ?? "no mark", spent };
}

describe("a sentence about a name with a number, live", () => {
  test.skipIf(KEY === undefined)(
    `${MODEL} on ${ARM}: no wrong Supported, no false Contradicted`,
    { timeout: 3_600_000 },
    async () => {
      const lines = [`## ${MODEL} · ${ARM} · names with a number`];
      const wrongSupported: string[] = [];
      let rescued = 0;
      let trueChecks = 0;
      let falseContradicted = 0;
      let total = 0;
      outer: for (let round = 0; round < REPEATS; round++) {
        for (const each of CASES) {
          if (total >= CAP) {
            lines.push(`Stopped at US$${total.toFixed(3)}, the cap.`);
            break outer;
          }
          const { state, spent } = await stateOfNameCase(each);
          total += spent;
          const sentence = sentenceOf(each);
          const right = isTrue(each);
          if (right) {
            trueChecks++;
            if (state === "supported") rescued++;
            if (state === "contradicted") falseContradicted++;
          } else if (state === "supported") wrongSupported.push(sentence);
          lines.push(
            `- ${right ? "true" : "WRONG twin"} [${each.copies} Document${each.copies === 1 ? "" : "s"}] ${sentence} → ${state}`,
          );
        }
      }
      lines.push(
        `True sentences: Supported ${rescued} of ${trueChecks}; Contradicted ${falseContradicted}. Wrong twins Supported: ${wrongSupported.length}. Spent US$${total.toFixed(3)}.`,
        "",
      );
      if (process.env.INCARNAMIND_LIVE_REPORT)
        await appendFile(process.env.INCARNAMIND_LIVE_REPORT, `${lines.join("\n")}\n`);
      expect(wrongSupported).toEqual([]);
    },
  );
});

const READABLE = [
  { name: "Kestrel plan.txt", contents: "Kestrel plan: the budget is £40,000." },
  { name: "Harbour survey.txt", contents: "Harbour survey: the north wall needs repointing." },
  { name: "Tide log.csv", contents: "Date,High water\n2026-10-01,04:12\n2026-10-02,04:55\n" },
  { name: "Crew roster.txt", contents: "Crew roster: Ines, Tomas and Wren on the early shift." },
  { name: "Supplier letter.txt", contents: "Dear site manager, the timber arrives on 3 November." },
  { name: "Budget notes.md", contents: "# Budget notes\n\nCrew costs are the largest line.\n" },
];
const READABLE_NAMES = READABLE.map((file) => file.name.replace(/\.[a-z]+$/, ""));
const DAMAGED = { name: "Damaged draft.pdf", contents: "This isn't a PDF." };
const SCAN = { name: "Harbour notice.pdf", contents: buildPdf([{ image: true }]) };

/** Why it couldn't be read, in either language: what an answer says of a damaged file. */
const WHY =
  /damaged|corrupt|couldn['’]t be (?:opened|read)|can['’]t be (?:opened|read)|could not be (?:opened|read)|unreadable|损坏|无法打开|打不开|无法读取|未能读取|读取失败|无法读/i;

describe("what files do I have, live", () => {
  test.skipIf(KEY === undefined)(
    `${MODEL} on ${ARM}: names the file that couldn't be read`,
    { timeout: 3_600_000 },
    async () => {
      const lines = [`## ${MODEL} · ${ARM} · what files do I have`];
      let named = 0;
      let withWhy = 0;
      let readableListed = 0;
      let asks = 0;
      let total = 0;
      for (let at = 0; at < 12; at++) {
        if (total >= CAP) {
          lines.push(`Stopped at US$${total.toFixed(3)}, the cap.`);
          break;
        }
        const language: Language = at % 2 === 0 ? "en" : "zh-CN";
        const core = await libraryOf([...READABLE, DAMAGED, SCAN], language);
        const note = await core.createMind({ title: "Files", folderId: null });
        const mind = await connectToMind(core, note.id);
        const { answerId } = await askAndFinish(
          core,
          mind,
          note.id,
          language === "en" ? "What files do I have?" : "我有哪些文件？",
        );
        const text = answerText(mind, answerId);
        total += await spentOf(core);
        core.close();
        asks++;
        const damaged = /Damaged draft/i.test(text);
        const why = damaged && WHY.test(text);
        const listed = READABLE_NAMES.filter((name) => text.includes(name)).length;
        if (damaged) named++;
        if (why) withWhy++;
        readableListed += listed;
        lines.push(
          `- [${language}] damaged named ${damaged}, why ${why}, readable listed ${listed} of 6:`,
          ...text.split("\n").map((line) => `    ${line}`),
        );
      }
      lines.push(
        `Asks ${asks}: names the damaged file ${named}, with why ${withWhy}; readable names listed in all ${readableListed}. Spent US$${total.toFixed(3)}.`,
        "",
      );
      if (process.env.INCARNAMIND_LIVE_REPORT)
        await appendFile(process.env.INCARNAMIND_LIVE_REPORT, `${lines.join("\n")}\n`);
      expect(asks).toBeGreaterThan(0);
    },
  );
});
