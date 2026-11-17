/**
 * The last box of #2525 on a real model: "What files do I have?" in a Library with Documents that
 * couldn't be read. Runs only with the key in the environment (INCARNAMIND_LIVE_ANTHROPIC_KEY; the
 * model is INCARNAMIND_LIVE_ANTHROPIC_MODEL, Haiku 5.5 by default) and makes no request without
 * one. INCARNAMIND_LIVE_REPORT keeps what each answer said, INCARNAMIND_LIVE_ARM names the code it
 * ran on (main or the branch), and INCARNAMIND_LIVE_CAP stops the arm at that many US dollars
 * (0.45 by default). The same file runs on main and on the branch, in the same hour.
 *
 * Bars, written before any run: asked "What files do I have?" (我有哪些文件？) in a Library of six
 * readable Documents, a damaged PDF and a scan with no text, six asks in each language, every
 * answer read by hand.
 *   - The answer names the damaged Document, with why it couldn't be read, in at least 10 of the 12.
 *   - It lists no fewer of the six readable Documents than main does in the same run (the sum over
 *     the 12 asks).
 */
import { appendFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { type Core, createAiSdkChatModel } from "../../src/core";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { askAndFinish } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { answerText } from "../helpers/minds";
import { buildPdf } from "../helpers/pdf";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL =
  process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ??
  (catalogProvider("anthropic")?.roles.quickTasks as string);
const ARM = process.env.INCARNAMIND_LIVE_ARM ?? "branch";
const CAP = Number(process.env.INCARNAMIND_LIVE_CAP ?? "0.45");

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
