/**
 * A Note's figure written with a ledger side ("1,234.56元 DR") under a stated unit that reads it as
 * written ("单位：元") had a scale question beside its sign question, so its check marked it
 * unread. With the scale question gone (#2512) it asks the sign question alone: the model names
 * the reading and the figure gets a verdict. Each case checks its Note in a core that holds its
 * own Document only. A figure whose side the Document contradicts must never be Supported. Runs only
 * with INCARNAMIND_LIVE_ANTHROPIC_KEY (the model is INCARNAMIND_LIVE_ANTHROPIC_MODEL, Haiku 5.5 by
 * default); INCARNAMIND_LIVE_REPORT keeps each case's reading, verdict and the spend.
 */
import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { expect, onTestFinished, test } from "vitest";
import * as Y from "yjs";
import { createAiSdkChatModel } from "../../src/core";
import { createElement } from "../../src/core/answers/blocks";
import { figuresInMind } from "../../src/core/answers/checks/figureOccurrences";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL =
  process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ??
  (catalogProvider("anthropic")?.roles.quickTasks as string);

interface Case {
  name: string;
  /** The Note's paragraph: a stated unit, then the sentence checked. */
  unit: string;
  sentence: string;
  document: { name: string; contents: string };
  /** The Document's line that decides it. */
  deciding: string;
  /** The Document states the same ledger side as the Note. */
  agrees: boolean;
}

const CASES: Case[] = [
  {
    name: "receivable, debit in both",
    unit: "单位：元。",
    sentence: "应收账款期末余额为 1,234.56元 DR。",
    document: {
      name: "应收账款明细账.md",
      contents: "# 应收账款明细账\n单位：元\n期末余额：借方 1,234.56\n",
    },
    deciding: "期末余额：借方 1,234.56",
    agrees: true,
  },
  {
    name: "payable, debit in the Note, credit in the Document",
    unit: "单位：元。",
    sentence: "应付账款期末余额为 1,234.56元 DR。",
    document: {
      name: "应付账款明细账.md",
      contents: "# 应付账款明细账\n单位：元\n期末余额：贷方 1,234.56\n",
    },
    deciding: "期末余额：贷方 1,234.56",
    agrees: false,
  },
  {
    name: "advance receipts, credit in both",
    unit: "单位：元。",
    sentence: "预收款项期末余额为 980.00元 CR。",
    document: {
      name: "预收款项明细账.md",
      contents: "# 预收款项明细账\n单位：元\n期末余额：贷方 980.00\n",
    },
    deciding: "期末余额：贷方 980.00",
    agrees: true,
  },
  {
    name: "other receivables, credit in the Note, debit in the Document",
    unit: "单位：元。",
    sentence: "其他应收款期末余额为 2,450.00元 CR。",
    document: {
      name: "其他应收款明细账.md",
      contents: "# 其他应收款明细账\n单位：元\n期末余额：借方 2,450.00\n",
    },
    deciding: "期末余额：借方 2,450.00",
    agrees: false,
  },
  {
    name: "trade receivables, debit in both",
    unit: "(in US dollars) ",
    sentence: "Trade receivables closed at $1,234.56 DR.",
    document: {
      name: "Trade receivables ledger.md",
      contents: "# Trade receivables ledger\n(in US dollars)\nClosing balance: 1,234.56 DR\n",
    },
    deciding: "Closing balance: 1,234.56 DR",
    agrees: true,
  },
  {
    name: "accrued expenses, debit in the Note, credit in the Document",
    unit: "(in US dollars) ",
    sentence: "Accrued expenses closed at $640.00 DR.",
    document: {
      name: "Accrued expenses ledger.md",
      contents: "# Accrued expenses ledger\n(in US dollars)\nClosing balance: 640.00 CR\n",
    },
    deciding: "Closing balance: 640.00 CR",
    agrees: false,
  },
];

/** The Note's figures in the sentence, read as the Note's check reads them. */
function noteFigures({ unit, sentence }: Case) {
  const doc = new Y.Doc();
  onTestFinished(() => doc.destroy());
  const blocks = doc.getXmlFragment("blocks");
  blocks.insert(0, [
    createElement({
      type: "paragraph",
      attrs: { id: "p" },
      content: [{ type: "text", text: `${unit}${sentence}` }],
    }),
  ]);
  return figuresInMind(blocks).filter(
    (figure) => figure.locator.kind === "text" && figure.locator.from.offset >= unit.length,
  );
}

test.skipIf(KEY === undefined)(
  "a ledger figure asked its sign alone is never Supported against the other side",
  { timeout: 1_800_000 },
  async () => {
    const results = [];
    const spent: unknown[] = [];
    for (const each of CASES) {
      expect(
        noteFigures(each).map((figure) => figure.reading.ambiguous.map((one) => one.kind)),
      ).toEqual([["sign"]]);
      // Its own core, so the Note's check searches this case's Document alone.
      const core = startCore(await createTempDataFolder(), {
        createChatModel: createAiSdkChatModel,
      });
      core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
      await core.saveChatProvider({ kind: "anthropic", apiKey: KEY ?? "", modelId: MODEL });
      const sources = await createTempDataFolder();
      await addAndProcess(core, [
        await writeSourceFile(sources, each.document.name, each.document.contents),
      ]);
      const mind = await core.createMind({ title: each.name });
      const client = await connectToMind(core, mind.id);
      writeMind(client, [
        {
          type: "paragraph",
          attrs: { id: randomUUID() },
          content: [{ type: "text", text: `${each.unit}${each.sentence}` }],
        },
      ]);
      await client.settled();
      await core.checkMind({ requestId: each.name, mindId: mind.id, mode: "all" });
      await client.settled();
      const checked = claimSpans(readMind(client)).find(({ sentence }) =>
        sentence.text.includes(each.sentence.trim().slice(0, 12)),
      );
      const figure = checked?.check.figures?.[0];
      results.push({
        case: each.name,
        agrees: each.agrees,
        sentence: checked?.check.state ?? "missing",
        figure: figure?.state ?? null,
        reason: figure?.reason ?? null,
        reading: figure?.reading.value ?? null,
        source: figure?.sourceInput?.number.value ?? null,
        quote: figure?.sourceInput?.citation.quote ?? null,
        deciding: each.deciding,
      });
      spent.push(...(await core.getCostSummary()).spent);
    }
    if (process.env.INCARNAMIND_LIVE_REPORT)
      await appendFile(
        process.env.INCARNAMIND_LIVE_REPORT,
        `${JSON.stringify({ model: MODEL, results, spent }, null, 2)}\n`,
      );
    for (const each of results.filter((one) => !one.agrees)) {
      expect(each.figure, each.case).not.toBe("supported");
      expect(each.sentence, each.case).not.toBe("supported");
    }
  },
);
