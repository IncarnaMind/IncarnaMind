import { describe, expect, test } from "vitest";
import type { ClaimPartPlan } from "../../src/core/api";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { opinionsIn } from "../../src/renderer/src/editor/opinionLocations";
import { readOpinionSentences } from "../../src/shared/opinions";
import { checkGenerate, checkReply, listedSentences, type Plan } from "../helpers/checks";
import { setUpWithDocuments } from "../helpers/citations";
import { createTempDataFolder } from "../helpers/core";
import { writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { editMind, readMind, writeMind } from "../helpers/minds";
import { scriptedModel } from "../helpers/models";

const CASES = [
  {
    language: "en",
    pure: "We think this is risky.",
    quote: "Costs rose 40%.",
    reworded: "Costs rose by 40%.",
  },
  {
    language: "zh-CN",
    pure: "我们认为这有风险。",
    quote: "成本上涨了40%。",
    reworded: "成本的涨幅为40%。",
  },
] as const;

function part(text: string, words: string, kind: ClaimPartPlan["kind"]): ClaimPartPlan {
  const start = text.indexOf(words);
  if (start < 0) throw new Error("The fixture part is absent.");
  return { span: { start, end: start + words.length }, kind };
}

async function setUpParts(example: (typeof CASES)[number]) {
  const sorts: string[] = [];
  const plans: Record<string, Plan> = {
    [example.quote]: { verdict: "supported", quote: example.quote },
    [example.reworded]: { verdict: "supported", quote: example.quote },
    [example.pure]: { verdict: "unsupported" },
  };
  const inventories = new Map<string, ClaimPartPlan[]>([
    [example.pure, [part(example.pure, example.pure, "opinion")]],
    [example.quote, [part(example.quote, example.quote, "fact")]],
    [example.reworded, [part(example.reworded, example.reworded, "fact")]],
  ]);
  const model = scriptedModel((call) => checkReply(call, plans), {
    generate(call) {
      if (call.question !== "find-claims") return checkGenerate(plans)(call);
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
  });
  const result = await setUpWithDocuments(model, [{ name: "Costs.md", contents: example.quote }]);
  const write = (text: string) =>
    writeMind(result.client, [
      {
        type: "paragraph",
        attrs: { id: "parts-note" },
        content: [{ type: "text", text }],
      },
    ]);
  const check = () =>
    result.core.checkMind({ requestId: crypto.randomUUID(), mindId: result.mind.id, mode: "all" });
  return { ...result, sorts, write, check };
}

for (const example of CASES)
  describe(example.language, () => {
    test("edited wording is sorted afresh while its unchanged owned receipt keeps its id", async () => {
      const setup = await setUpParts(example);
      setup.write(example.quote);
      await setup.client.settled();
      await setup.check();
      await setup.client.settled();
      const before = claimSpans(readMind(setup.client))[0]?.check;
      const id = before?.parts?.[0]?.evidence[0]?.id;
      expect(typeof id).toBe("string");
      const sortsBefore = setup.sorts.length;
      editMind(setup.client, (blocks) =>
        blocks.map((block) => ({
          ...block,
          content: block.content?.map((node) =>
            node.type === "text" ? { ...node, text: example.reworded } : node,
          ),
        })),
      );
      await setup.client.settled();
      await setup.check();
      await setup.client.settled();
      const after = claimSpans(readMind(setup.client))[0]?.check;
      expect(setup.sorts.length).toBeGreaterThan(sortsBefore);
      expect(after?.state).toBe("supported");
      expect(after?.parts?.[0]?.span).toEqual({ start: 0, end: example.reworded.length });
      expect(after?.parts?.[0]?.evidence[0]?.id).toBe(id);
      expect(after?.text).toBe(example.reworded);
    });

    test("Note result writes own distinct receipt ids and keeps unchanged receipts on recheck", async () => {
      const setup = await setUpParts(example);
      setup.write(`${example.quote} ${example.quote}`);
      await setup.client.settled();
      await setup.check();
      await setup.client.settled();
      const ids = claimSpans(readMind(setup.client)).map(
        (span) => span.check.parts?.[0]?.evidence[0]?.id,
      );
      expect(ids).toHaveLength(2);
      expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
      expect(new Set(ids).size).toBe(2);
      await setup.check();
      await setup.client.settled();
      expect(
        claimSpans(readMind(setup.client)).map((span) => span.check.parts?.[0]?.evidence[0]?.id),
      ).toEqual(ids);
      const reopened = await connectToMind(setup.core, setup.mind.id);
      expect(
        claimSpans(readMind(reopened)).map((span) => span.check.parts?.[0]?.evidence[0]?.id),
      ).toEqual(ids);
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
  });
