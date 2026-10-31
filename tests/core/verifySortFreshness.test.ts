import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { verificationOf } from "../../src/shared/verification";
import {
  checkGenerate,
  checkReply,
  isCheckRun,
  listedSentences,
  type Plan,
  sentenceOf,
} from "../helpers/checks";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind } from "../helpers/minds";
import { failingModel, type ModelCall, scriptedModel, scriptedModels } from "../helpers/models";
import { buildPdf } from "../helpers/pdf";

const CASES = [
  { language: "en", item: "Item", cash: "Cash", receivables: "Receivables" },
  { language: "zh-CN", item: "项目", cash: "现金", receivables: "应收款项" },
] as const;

async function setUp(example: (typeof CASES)[number]) {
  const original = `${example.cash} — 2025: 3,820; 2024: 3,145`;
  const edited = `${example.cash} — 2025: 3,821; 2024: 3,145`;
  const otherRow = `${example.receivables} — 2025: 2,610; 2024: 2,290`;
  const tableSorts: string[][] = [];
  const calls: ModelCall[] = [];
  const plans: Record<string, Plan> = { [original]: { verdict: "unsupported" } };
  const model = scriptedModel(
    (call) => {
      calls.push(call);
      return checkReply(call, plans);
    },
    {
      generate(call) {
        if (!call.system.startsWith("You sort the sentences")) return checkGenerate(plans)(call);
        const sentences = listedSentences(call.prompt);
        if (sentences.some(({ text }) => text === otherRow)) {
          tableSorts.push(sentences.map(({ text }) => text));
        }
        return {
          text: JSON.stringify({
            sentences: sentences.map(({ number, text }) => ({
              number,
              parts: text === original ? [{ kind: "fact", text }] : [],
            })),
          }),
        };
      },
    },
  );
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const sources = await createTempDataFolder();
  await addAndProcess(core, [
    await writeSourceFile(sources, "Evidence.md", "These records describe published accounts."),
  ]);
  const row = (y: number, cells: readonly string[]) =>
    cells.map((text, column) => ({ text, x: [72, 260, 340][column] ?? 72, y }));
  const path = await writeSourceFile(
    sources,
    "Accounts.pdf",
    buildPdf([
      {
        placed: [
          ...row(720, [example.item, "2025", "2024"]),
          ...row(706, [example.cash, "3,820", "3,145"]),
          ...row(692, [example.receivables, "2,610", "2,290"]),
        ],
      },
    ]),
  );
  const verified = await core.verifyDocument({ path });
  if (!verified.ok) throw new Error(`The report wasn't verified: ${verified.reason}`);
  const { mind } = verified;
  const client = await connectToMind(core, mind.id);
  await client.settled();
  expect(readMind(client).content.content.map((block) => block.type.name)).toEqual(["table"]);
  const request = () => ({ requestId: crypto.randomUUID(), mindId: mind.id });
  const checked = () =>
    calls.filter((call) => isCheckRun(call) && call.results.length === 0).map(sentenceOf);
  return { core, client, model, tableSorts, original, edited, request, checked };
}

async function editValue(client: MindClient) {
  const value = [...client.blocks.createTreeWalker(() => true)].find(
    (node): node is Y.XmlText => node instanceof Y.XmlText && node.toString() === "3,820",
  );
  if (!value) throw new Error("The table value is absent.");
  client.doc.transact(() => {
    value.delete(0, value.length);
    value.insert(0, "3,821");
  });
  await client.settled();
}

for (const example of CASES)
  describe(`Verify sorting freshness, ${example.language}`, () => {
    test("an unchanged full table row reuses its completed sort", async () => {
      const setup = await setUp(example);
      expect(await setup.core.findClaims(setup.request())).toEqual({ kind: "found", claims: 1 });
      expect(await setup.core.verifyClaims(setup.request())).toMatchObject({
        kind: "checked",
        claims: 1,
        checked: 1,
      });
      await setup.client.settled();
      expect(setup.tableSorts).toHaveLength(1);
      expect(setup.tableSorts[0]).toContain(setup.original);
      expect(setup.checked()).toEqual([setup.original]);
      expect(claimSpans(readMind(setup.client)).map((span) => span.sentence.text)).toEqual([
        example.cash,
      ]);
    });

    test("a changed numeric cell is sorted again although the first-cell words are unchanged", async () => {
      const setup = await setUp(example);
      expect(await setup.core.findClaims(setup.request())).toEqual({ kind: "found", claims: 1 });
      await setup.client.settled();
      const before = verificationOf(setup.client.doc);
      expect(before?.claims?.map((claim) => claim.text)).toEqual([example.cash]);
      await editValue(setup.client);
      expect(await setup.core.verifyClaims(setup.request())).toEqual({ kind: "nothing" });
      await setup.client.settled();
      expect(setup.tableSorts).toHaveLength(2);
      expect(setup.tableSorts[1]).toContain(setup.edited);
      expect(setup.tableSorts[1]).not.toContain(setup.original);
      expect(verificationOf(setup.client.doc)?.sortedText).not.toBe(before?.sortedText);
      expect(setup.checked()).toEqual([]);
      expect(claimSpans(readMind(setup.client))).toEqual([]);
    });

    test("an edit during sorting cancels that Verify without checking new words or retrying", async () => {
      const setup = await setUp(example);
      let enter = () => {};
      let release = () => {};
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const generate = setup.model.doGenerate.bind(setup.model);
      let first = true;
      setup.model.doGenerate = async (options) => {
        if (first) {
          first = false;
          enter();
          await held;
        }
        return generate(options);
      };
      const running = setup.core.verifyClaims(setup.request());
      await entered;
      try {
        await editValue(setup.client);
      } finally {
        release();
      }
      expect(await running).toEqual({ kind: "cancelled" });
      await setup.client.settled();
      expect(setup.tableSorts).toHaveLength(1);
      expect(setup.tableSorts[0]).toContain(setup.original);
      expect(setup.checked()).toEqual([]);
      expect(claimSpans(readMind(setup.client))).toEqual([]);
      expect(await setup.core.verifyClaims(setup.request())).toEqual({ kind: "nothing" });
      expect(setup.tableSorts).toHaveLength(2);
      expect(setup.tableSorts[1]).toContain(setup.edited);
      expect(setup.checked()).toEqual([]);
    });

    test("a failed sorting refresh returns its provider problem without creating a Check", async () => {
      const setup = await setUp(example);
      expect(await setup.core.findClaims(setup.request())).toEqual({ kind: "found", claims: 1 });
      await editValue(setup.client);
      const failure = failingModel(400, "The sorter is unavailable.");
      setup.model.doGenerate = failure.doGenerate.bind(failure);
      expect(await setup.core.verifyClaims(setup.request())).toMatchObject({
        kind: "failed",
        error: { message: "The sorter is unavailable." },
      });
      await setup.client.settled();
      expect(setup.checked()).toEqual([]);
      expect(claimSpans(readMind(setup.client))).toEqual([]);
    });
  });
