import { describe, expect, test } from "vitest";
import type { ClaimPartPlan } from "../../src/core/api";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { opinionsIn } from "../../src/renderer/src/editor/opinionLocations";
import { readOpinionSentences } from "../../src/shared/opinions";
import { verificationOf } from "../../src/shared/verification";
import {
  checkGenerate,
  checkReply,
  isCheckRun,
  listedSentences,
  type Plan,
  sentenceOf,
} from "../helpers/checks";
import { setUpWithDocuments } from "../helpers/citations";
import { createTempDataFolder } from "../helpers/core";
import { writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { editMind, readMind, writeMind } from "../helpers/minds";
import { type ModelCall, scriptedModel } from "../helpers/models";

const CASES = [
  {
    language: "en",
    opinion: "We think this is risky",
    fact: "costs rose 40%",
    mixed: "We think this is risky because costs rose 40%.",
    pure: "We think this is risky.",
    quote: "Costs rose 40%.",
  },
  {
    language: "zh-CN",
    opinion: "我们认为这有风险",
    fact: "成本上涨了40%",
    mixed: "我们认为这有风险，因为成本上涨了40%。",
    pure: "我们认为这有风险。",
    quote: "成本上涨了40%。",
  },
] as const;

function part(text: string, words: string, kind: ClaimPartPlan["kind"]): ClaimPartPlan {
  const start = text.indexOf(words);
  if (start < 0) throw new Error("The fixture part is absent.");
  return { span: { start, end: start + words.length }, kind };
}

async function setUpParts(example: (typeof CASES)[number]) {
  const calls: ModelCall[] = [];
  const sorts: string[] = [];
  const plans: Record<string, Plan> = {
    [example.fact]: { verdict: "supported", quote: example.quote },
    [example.quote]: { verdict: "supported", quote: example.quote },
    [example.opinion]: { verdict: "unsupported" },
    [example.pure]: { verdict: "unsupported" },
  };
  const inventories = new Map<string, ClaimPartPlan[]>([
    [
      example.mixed,
      [part(example.mixed, example.opinion, "opinion"), part(example.mixed, example.fact, "fact")],
    ],
    [example.pure, [part(example.pure, example.pure, "opinion")]],
    [example.quote, [part(example.quote, example.quote, "fact")]],
  ]);
  const model = scriptedModel(
    (call) => {
      calls.push(call);
      return checkReply(call, plans);
    },
    {
      generate(call) {
        if (!call.system.startsWith("You sort the sentences")) return checkGenerate(plans)(call);
        sorts.push(call.prompt);
        const sentences = listedSentences(call.prompt).flatMap(({ number, text }) => {
          const parts = inventories.get(text);
          if (!parts) throw new Error(`No sorting fixture for ${text}`);
          return [
            {
              number,
              parts: parts.map((plan) => ({
                kind: plan.kind,
                text: text.slice(plan.span.start, plan.span.end),
              })),
            },
          ];
        });
        return { text: JSON.stringify({ sentences }) };
      },
    },
  );
  const result = await setUpWithDocuments(model, [{ name: "Costs.md", contents: example.quote }]);
  const blockId = "parts-note";
  const write = (text: string) =>
    writeMind(result.client, [
      {
        type: "paragraph",
        attrs: { id: blockId },
        content: [{ type: "text", text }],
      },
    ]);
  const check = () =>
    result.core.checkMind({ requestId: crypto.randomUUID(), mindId: result.mind.id, mode: "all" });
  return { ...result, model, calls, sorts, blockId, write, check };
}

for (const example of CASES)
  describe(example.language, () => {
    test("one mixed sentence keeps its fact when Check anyway checks only the opinion", async () => {
      const setup = await setupForMixed();
      const before = claimSpans(readMind(setup.client));
      expect(before).toHaveLength(1);
      expect(before[0]?.check.state).toBe("supported");
      expect(opinionsIn(readMind(setup.client), setup.client.doc)).toHaveLength(1);
      const opinion = opinionsIn(readMind(setup.client), setup.client.doc)[0];
      if (!opinion) throw new Error("No omitted opinion in the checked fixture.");
      const factBefore = before[0]?.check.parts?.find((part) => part.kind === "fact");
      const countBefore = setup.calls.filter(
        (call) => isCheckRun(call) && call.results.length === 0,
      ).length;
      await setup.core.checkSentences({
        requestId: crypto.randomUUID(),
        mindId: setup.mind.id,
        action: "check-against-documents",
        from: { blockId: setup.blockId, offset: 0 },
        to: { blockId: setup.blockId, offset: example.opinion.length },
        part: { id: opinion.id, span: opinion.span },
      });
      await setup.client.settled();
      const after = claimSpans(readMind(setup.client));
      expect(after).toHaveLength(1);
      expect(after[0]?.check.state).toBe("unsupported");
      expect(after[0]?.check.parts?.find((part) => part.kind === "fact")).toEqual(factBefore);
      expect(opinionsIn(readMind(setup.client), setup.client.doc)).toHaveLength(0);
      const added = setup.calls
        .filter((call) => isCheckRun(call) && call.results.length === 0)
        .slice(countBefore);
      expect(added.map(sentenceOf)).toEqual([example.opinion]);
      await setup.check();
      await setup.client.settled();
      expect(
        claimSpans(readMind(setup.client))[0]?.check.parts?.map((part) => part.verdict),
      ).toEqual(["unsupported", "supported"]);
      expect(opinionsIn(readMind(setup.client), setup.client.doc)).toHaveLength(0);
    });

    test("a changed part target is refused before another check starts", async () => {
      const setup = await setupForMixed();
      const opinion = opinionsIn(readMind(setup.client), setup.client.doc)[0];
      if (!opinion) throw new Error("No omitted opinion in the checked fixture.");
      const count = setup.calls.length;
      await expect(
        setup.core.checkSentences({
          requestId: crypto.randomUUID(),
          mindId: setup.mind.id,
          action: "check-against-documents",
          from: { blockId: setup.blockId, offset: 0 },
          to: { blockId: setup.blockId, offset: example.opinion.length },
          part: { id: opinion.id, span: { start: opinion.span.start, end: opinion.span.end - 1 } },
        }),
      ).rejects.toThrow();
      expect(setup.calls).toHaveLength(count);
      expect(opinionsIn(readMind(setup.client), setup.client.doc)).toHaveLength(1);
    });

    test("a second part request cannot overwrite an in-flight result", async () => {
      const setup = await setupForMixed();
      const opinion = opinionsIn(readMind(setup.client), setup.client.doc)[0];
      if (!opinion) throw new Error("No omitted opinion in the checked fixture.");
      let enter = () => {};
      let release = () => {};
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      const stream = setup.model.doStream.bind(setup.model);
      let held = false;
      setup.model.doStream = async (options) => {
        if (!held) {
          held = true;
          enter();
          await wait;
        }
        return stream(options);
      };
      const input = {
        mindId: setup.mind.id,
        action: "check-against-documents" as const,
        from: { blockId: setup.blockId, offset: 0 },
        to: { blockId: setup.blockId, offset: example.opinion.length },
        part: { id: opinion.id, span: opinion.span },
      };
      const first = setup.core.checkSentences({ ...input, requestId: crypto.randomUUID() });
      await entered;
      try {
        await expect(
          setup.core.checkSentences({ ...input, requestId: crypto.randomUUID() }),
        ).rejects.toThrow();
      } finally {
        release();
      }
      await first;
      await setup.client.settled();
      expect(claimSpans(readMind(setup.client))).toHaveLength(1);
      expect(
        claimSpans(readMind(setup.client))[0]?.check.parts?.map((part) => part.verdict),
      ).toEqual(["unsupported", "supported"]);
    });

    test("two identical pure opinions survive reopen without marks, then an edit is sorted again", async () => {
      const setup = await setUpParts(example);
      setup.write(`${example.pure} ${example.pure}`);
      await setup.client.settled();
      expect(await setup.check()).toMatchObject({ kind: "checked", sentences: 0 });
      await setup.client.settled();
      expect(claimSpans(readMind(setup.client))).toHaveLength(0);
      expect(readOpinionSentences(setup.client.doc).map((entry) => entry.occurrence)).toEqual([
        0, 1,
      ]);
      const reopened = await connectToMind(setup.core, setup.mind.id);
      expect(opinionsIn(readMind(reopened), reopened.doc)).toHaveLength(2);
      editMind(setup.client, (blocks) => [
        {
          type: "paragraph",
          attrs: { id: "prefix" },
          content: [{ type: "text", text: "Heading" }],
        },
        ...blocks,
      ]);
      await setup.client.settled();
      expect(opinionsIn(readMind(setup.client), setup.client.doc)).toHaveLength(2);
      setup.write(example.quote);
      await setup.client.settled();
      await setup.check();
      await setup.client.settled();
      expect(claimSpans(readMind(setup.client))[0]?.check.state).toBe("supported");
      expect(opinionsIn(readMind(setup.client), setup.client.doc)).toHaveLength(0);
    });

    test("editing a checked fact into an opinion removes the old mark after sorting", async () => {
      const setup = await setUpParts(example);
      setup.write(example.quote);
      await setup.client.settled();
      await setup.check();
      await setup.client.settled();
      expect(claimSpans(readMind(setup.client))).toHaveLength(1);
      editMind(setup.client, (blocks) =>
        blocks.map((block) => ({
          ...block,
          content: block.content?.map((node) =>
            node.type === "text" ? { ...node, text: example.pure } : node,
          ),
        })),
      );
      await setup.client.settled();
      expect(claimSpans(readMind(setup.client))).toHaveLength(1);
      await setup.check();
      await setup.client.settled();
      expect(claimSpans(readMind(setup.client))).toHaveLength(0);
      expect(opinionsIn(readMind(setup.client), setup.client.doc)).toHaveLength(1);
    });

    test("Verify keeps a manually checked opinion in the same inventory on later checks", async () => {
      const setup = await setUpParts(example);
      const file = await writeSourceFile(await createTempDataFolder(), "Opinion.txt", example.pure);
      const made = await setup.core.verifyDocument({ path: file });
      if (!made.ok) throw new Error("The test Document could not be verified.");
      const client = await connectToMind(setup.core, made.mind.id);
      const input = () => ({ requestId: crypto.randomUUID(), mindId: made.mind.id });
      expect(await setup.core.findClaims(input())).toEqual({ kind: "found", claims: 0 });
      await client.settled();
      const opinion = opinionsIn(readMind(client), client.doc)[0];
      if (!opinion) throw new Error("Verify lost the omitted opinion.");
      expect(claimSpans(readMind(client))).toHaveLength(0);
      await setup.core.checkSentences({
        ...input(),
        action: "check-against-documents",
        from: { blockId: opinion.blockId, offset: 0 },
        to: { blockId: opinion.blockId, offset: example.pure.length },
        part: { id: opinion.id, span: opinion.span },
      });
      await client.settled();
      expect(verificationOf(client.doc)?.claims).toHaveLength(1);
      expect(await setup.core.findClaims(input())).toEqual({ kind: "found", claims: 1 });
      expect(await setup.core.verifyClaims(input())).toMatchObject({
        kind: "checked",
        claims: 1,
        checked: 1,
      });
      await client.settled();
      expect(claimSpans(readMind(client))[0]?.check.parts?.map((part) => part.verdict)).toEqual([
        "unsupported",
      ]);
      expect(opinionsIn(readMind(client), client.doc)).toHaveLength(0);
    });

    test("Verify re-sorts an edited opinion, then reuses the unchanged inventory", async () => {
      const setup = await setUpParts(example);
      const file = await writeSourceFile(
        await createTempDataFolder(),
        "Edited opinion.txt",
        example.pure,
      );
      const made = await setup.core.verifyDocument({ path: file });
      if (!made.ok) throw new Error("The test Document could not be verified.");
      const client = await connectToMind(setup.core, made.mind.id);
      const input = () => ({ requestId: crypto.randomUUID(), mindId: made.mind.id });
      expect(await setup.core.findClaims(input())).toEqual({ kind: "found", claims: 0 });
      expect(setup.sorts).toHaveLength(1);
      editMind(client, (blocks) =>
        blocks.map((block) => ({
          ...block,
          content: [{ type: "text", text: example.quote }],
        })),
      );
      await client.settled();
      expect(await setup.core.verifyClaims(input())).toMatchObject({
        kind: "checked",
        claims: 1,
        checked: 1,
      });
      await client.settled();
      expect(claimSpans(readMind(client))[0]?.check.state).toBe("supported");
      expect(opinionsIn(readMind(client), client.doc)).toHaveLength(0);
      expect(setup.sorts).toHaveLength(2);
      await setup.core.verifyClaims(input());
      expect(setup.sorts).toHaveLength(2);
    });

    async function setupForMixed() {
      const result = await setUpParts(example);
      result.write(example.mixed);
      await result.client.settled();
      await result.check();
      await result.client.settled();
      return result;
    }
  });
