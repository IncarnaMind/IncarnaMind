import type { JSONContent } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { describe, expect, test } from "vitest";
import {
  CITATION_NODE,
  type CitationAttributes,
  CLAIM_CHECK_MARK,
  type Core,
  type Document,
  GENERATED_MARK,
} from "../../src/core";
import { claimsOf, foundElsewhere } from "../../src/renderer/src/editor/claimChecks";
import { pendingProposals } from "../../src/shared/proposals";
import { askAssistant } from "../helpers/assistant";
import { checkingModel, checkReply, isCheckRun, type Plan } from "../helpers/checks";
import { setUpWithDocuments, shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { editMind, readMind, resolveChanges, writeMind } from "../helpers/minds";
import { judgesNothing, type ModelCall, scriptedModel, scriptedModels } from "../helpers/models";

/*
 * A Passage a check finds that the sentence's Citations don't hold becomes a Citation in three
 * ways only (#3019): inside the assistant's own change, in an Answer, or by the User's click. A
 * check of a sentence in the Note writes nothing into its text and leaves no waiting change; its
 * mark keeps the model's own verdict, which the Note reads against its Citations as they stand.
 */

const LINE = "The tide turns twice a day.";
const OTHER = "The harbour closes at dusk.";
const LINE_ZH = "港口的潮水每天都会涨落两次。";
const OTHER_ZH = "港口在黄昏时关闭。";
const TIDES = {
  name: "Tides.md",
  contents: `# Tides\n\n${LINE}\n\n${OTHER}\n\n${LINE_ZH}\n\n${OTHER_ZH}\n`,
};
const SENTENCE = "Tides turn twice in a day here.";
const SENTENCE_ZH = "这里的潮水每天涨落两次。";

const PLANS: Record<string, Plan> = {
  [SENTENCE]: { verdict: "supported", quote: LINE, says: LINE, judgement: "same" },
  [SENTENCE_ZH]: { verdict: "supported", quote: LINE_ZH, says: LINE_ZH, judgement: "same" },
};

const citationOf = (tides: Document, quote: string): JSONContent => ({
  type: CITATION_NODE,
  attrs: {
    documentId: tides.id,
    documentName: tides.name,
    contentHash: tides.contentHash,
    quote,
    check: "found",
  },
});

/** A paragraph holding `sentence` with a Citation of `quote` before its stop, as the User wrote it. */
const cited = (
  id: string,
  sentence: string,
  citation: JSONContent,
  marks: JSONContent["marks"] = [],
): JSONContent => ({
  type: "paragraph",
  attrs: { id },
  content: [
    { type: "text", text: sentence.slice(0, -1), ...(marks.length > 0 && { marks }) },
    citation,
    { type: "text", text: sentence.slice(-1), ...(marks.length > 0 && { marks }) },
  ],
});

/** The Note's words and Citations, as its text holds them: what a check must leave as it is. */
function textOf(doc: ProseMirrorNode): string[] {
  const lines: string[] = [];
  doc.descendants((node) => {
    if (!node.isTextblock) return true;
    let line = "";
    node.forEach((child) => {
      line += child.isText ? (child.text ?? "") : `[${String(child.attrs.quote)}]`;
    });
    lines.push(line);
    return false;
  });
  return lines;
}

const shownIn = (client: MindClient) =>
  claimsOf(readMind(client), {
    footing: "not-yet-known",
    versions: null,
    folderId: null,
    scope: null,
  }).claims;

async function checkParagraph(core: Core, mindId: string, id: string, length: number) {
  await core.checkSentences({
    requestId: crypto.randomUUID(),
    mindId,
    action: "check-against-documents",
    from: { blockId: id, offset: 0 },
    to: { blockId: id, offset: length },
  });
}

describe("A check of a sentence in the Note writes nothing into it", { timeout: 30_000 }, () => {
  // protects=a check that finds a Passage the sentence's Citation doesn't hold changes nothing in the Note's text and leaves no waiting change, for the User's own sentence and for one the assistant wrote that the User accepted, in English and Chinese; its mark keeps the model's Supported with that Passage and reads Not checked, found elsewhere, until the Passage is a Citation (#3019); fails_when=the check adds the Citation, proposes it as a change, stores Not checked in place of the model's verdict, or shows a ✓ beside the Citation whose words don't say it; no_claim=how the card draws it.
  test.each([
    ["the User's own sentence", SENTENCE, OTHER, []],
    ["the User's own sentence, in Chinese", SENTENCE_ZH, OTHER_ZH, []],
    ["a sentence the assistant wrote, accepted", SENTENCE, OTHER, [{ type: GENERATED_MARK }]],
  ] as const)("%s", async (_kind, sentence, writerQuote, marks) => {
    const { core, client, mind, documents } = await setUpWithDocuments(checkingModel(PLANS), [
      TIDES,
    ]);
    const [tides] = documents;
    if (!tides) throw new Error("Tides.md wasn't added.");
    writeMind(client, [cited("s", sentence, citationOf(tides, writerQuote), [...marks])]);
    await client.settled();
    const before = textOf(readMind(client));

    await checkParagraph(core, mind.id, "s", sentence.length + 1);
    await client.settled();

    expect(textOf(readMind(client))).toEqual(before);
    expect(pendingProposals(client.blocks)).toEqual([]);
    const [claim] = shownIn(client);
    expect(claim?.check.state).toBe("supported");
    expect(claim?.check.evidence?.quote).toContain(sentence === SENTENCE ? LINE : LINE_ZH);
    expect(claim?.shown).toEqual({ state: "not-checked", reason: "found-elsewhere" });
    expect(claim?.reads.parts?.[0]?.evidence[0]?.quote).toContain(
      sentence === SENTENCE ? LINE : LINE_ZH,
    );
  });

  // protects=Check this Note sends no new check for a sentence whose ✓ waits on the User adding the Passage its check found: checked again it would give the same answer, so nothing is asked and it is held as checked (#3019); fails_when=Check this Note sends the sentence to the model again; no_claim=the whole-Note check's other choices.
  test("Check this Note doesn't ask about it again", async () => {
    const calls: ModelCall[] = [];
    const { core, client, mind, documents } = await setUpWithDocuments(
      checkingModel(PLANS, calls),
      [TIDES],
    );
    const [tides] = documents;
    if (!tides) throw new Error("Tides.md wasn't added.");
    writeMind(client, [cited("s", SENTENCE, citationOf(tides, OTHER))]);
    await client.settled();
    await checkParagraph(core, mind.id, "s", SENTENCE.length + 1);
    await client.settled();
    const asked = calls.length;

    const plan = await core.planMindCheck(mind.id, "changed");
    expect(plan.kind).toBe("unchanged");
    expect(calls.length).toBe(asked);
  });

  // protects=a mark an older version stored as Not checked, found elsewhere, holds no verdict an Add could bring back, so it is no dead end: it reads Not checked, not Supported, not yet cited, and Check this Note checks it again, after which it reads Supported, not yet cited, with the Passage to add (#3019); fails_when=it reads as waiting on an Add, or Check this Note holds it as checked and never asks again; no_claim=the card's look.
  test("a mark an older version stored as Not checked, found elsewhere, is checked again", async () => {
    const calls: ModelCall[] = [];
    const { core, client, mind, documents } = await setUpWithDocuments(
      checkingModel(PLANS, calls),
      [TIDES],
    );
    const [tides] = documents;
    if (!tides) throw new Error("Tides.md wasn't added.");
    writeMind(client, [cited("s", SENTENCE, citationOf(tides, OTHER))]);
    await client.settled();
    await checkParagraph(core, mind.id, "s", SENTENCE.length + 1);
    await client.settled();
    editMind(client, (blocks) => blocks.map(storedAsBefore));
    await client.settled();
    const [legacy] = shownIn(client);
    expect(legacy?.check.state).toBe("not-checked");
    expect(legacy?.shown).toEqual({ state: "not-checked", reason: "found-elsewhere" });
    expect(legacy && foundElsewhere(legacy)).toBe(false);
    const asked = calls.length;

    await core.checkMind({ requestId: crypto.randomUUID(), mindId: mind.id, mode: "all" });
    await client.settled();
    expect(calls.length).toBeGreaterThan(asked);
    const [now] = shownIn(client);
    expect(now?.check.state).toBe("supported");
    expect(now && foundElsewhere(now)).toBe(true);
  });
});

/** A paragraph's check as an older version stored it: Not checked, found elsewhere, its verdict gone. */
function storedAsBefore(block: JSONContent): JSONContent {
  return {
    ...block,
    content: block.content?.map((child) => ({
      ...child,
      ...(child.marks && {
        marks: child.marks.map((mark) =>
          mark.type === CLAIM_CHECK_MARK
            ? {
                ...mark,
                attrs: {
                  ...mark.attrs,
                  state: "not-checked",
                  reason: "found-elsewhere",
                  detail: null,
                  evidence: null,
                  says: null,
                  parts: null,
                },
              }
            : mark,
        ),
      }),
    })),
  };
}

/** A model that answers by writing `SENTENCE` into the Note with a Citation of `OTHER`, and checks as `PLANS` say. */
function writingModel() {
  return scriptedModel(
    (call) => {
      if (isCheckRun(call)) return checkReply(call, PLANS);
      const search = call.results.find((result) => result.tool === "search_documents");
      if (!search) return { calls: [{ tool: "search_documents", input: { query: "tides" } }] };
      if (!call.results.some((result) => result.tool === "cite")) {
        const passage = shownPassages(search.text).find((each) => each.text.includes(OTHER));
        return {
          calls: [
            {
              tool: "cite",
              input: { citations: [{ marker: 1, passage: passage?.id, quote: OTHER }] },
            },
          ],
        };
      }
      if (!call.results.some((result) => result.tool === "add_to_mind"))
        return {
          calls: [{ tool: "add_to_mind", input: { content: `${SENTENCE.slice(0, -1)}[^1].` } }],
        };
      return { text: "Added it." };
    },
    { generate: judgesNothing },
  );
}

async function assistantWrites() {
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(writingModel()).createChatModel,
  });
  core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
  const saved = await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "sk-ant-test",
    modelId: "claude-haiku-5-5",
  });
  for (const flow of ["chat", "checks"] as const)
    if (saved.service) await core.allowDataFlow(flow, saved.service.id);
  const sources = await createTempDataFolder();
  await addAndProcess(core, [await writeSourceFile(sources, TIDES.name, TIDES.contents)]);
  const mind = await core.createMind({ title: "Harbour" });
  const client = await connectToMind(core, mind.id);
  await askAssistant(core, { text: "Add a line on tides to this Note", mindId: mind.id });
  await client.settled();
  return { core, client };
}

const citationsIn = (client: MindClient): CitationAttributes[] => {
  const found: CitationAttributes[] = [];
  readMind(client).descendants((node) => {
    if (node.type.name === CITATION_NODE) found.push(node.attrs as CitationAttributes);
  });
  return found;
};

describe("Inside the assistant's own change", { timeout: 30_000 }, () => {
  // protects=the Passage the check of a sentence the assistant wrote found becomes that part's Citation inside the same change, after the writer's own, said to be the check's, so the part reads ✓; rejecting the change takes it with the sentence, and accepting keeps the ✓ (#3019); fails_when=the found Passage is left out, lands outside the change, survives a reject, or the ✓ needs another request; no_claim=where a model places its own Citations.
  test.each([["reject"], ["accept"]] as const)("%s the change", async (outcome) => {
    const { client } = await assistantWrites();
    expect(pendingProposals(client.blocks).length).toBeGreaterThan(0);
    const quotes = citationsIn(client).map((each) => [each.quote, each.foundByCheck ?? null]);
    expect(quotes).toEqual([
      [OTHER, null],
      [expect.stringContaining(LINE), true],
    ]);
    // Before the sentence's stop, as the writer's own Citation is.
    expect(textOf(readMind(client))[0]).toMatch(
      /^Tides turn twice in a day here\[[^\]]+\]\[[^\]]+\]\.$/,
    );
    expect(shownIn(client)[0]?.shown).toEqual({ state: "supported" });

    await resolveChanges(client, outcome);
    await client.settled();
    if (outcome === "reject") {
      expect(citationsIn(client)).toEqual([]);
      expect(shownIn(client)).toEqual([]);
    } else {
      expect(citationsIn(client).map((each) => each.foundByCheck ?? null)).toEqual([null, true]);
      expect(shownIn(client)[0]?.shown).toEqual({ state: "supported" });
    }
  });
});
