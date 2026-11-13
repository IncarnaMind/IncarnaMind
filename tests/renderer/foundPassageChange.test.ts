/**
 * A Passage the check of the assistant's own sentence found rides in that change only while the
 * change still waits there for the User (#3019). Accepted, rejected or edited while its check
 * runs, the sentence is the User's, and the check writes nothing into it: an accepted one reads
 * found elsewhere, and Add as Citation then shows its ✓ with no request.
 */
import type { JSONContent } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import {
  CITATION_NODE,
  type CitationAttributes,
  type Document,
  GENERATED_MARK,
} from "../../src/core";
import { EDIT_INSTRUCTIONS, EDIT_INSTRUCTIONS_NAMED } from "../../src/core/edits/prompt";
import { CitationNumbers } from "../../src/renderer/src/editor/citationNumbers";
import { ClaimChecks, claimsOf, shownClaims } from "../../src/renderer/src/editor/claimChecks";
import { pendingProposals } from "../../src/shared/proposals";
import { askAssistant } from "../helpers/assistant";
import { checkReply, isCheckRun, type Plan } from "../helpers/checks";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { boundEditor } from "../helpers/editor";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind, resolveChanges, writeMind } from "../helpers/minds";
import {
  judgesNothing,
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";

vi.mock("../../src/renderer/src/core", () => ({ core: {} }));
vi.mock("../../src/renderer/src/editWithAi", () => ({ resolveProposalsIn: vi.fn() }));
vi.mock("../../src/renderer/src/modelInUse", () => ({ modelInUseOf: vi.fn() }));
vi.mock("../../src/renderer/src/store", () => ({
  useAppStore: { getState: () => ({ documents: [], minds: [], settings: { language: "en" } }) },
}));

const { addAsCitation } = await import("../../src/renderer/src/checks");

const LINE = "The tide turns twice a day.";
const OTHER = "The harbour closes at dusk.";
const LINE_ZH = "港口的潮水每天都会涨落两次。";
const OTHER_ZH = "港口在黄昏时关闭。";
const TIDES = `# Tides\n\n${LINE}\n\n${OTHER}\n\n${LINE_ZH}\n\n${OTHER_ZH}\n`;
const SENTENCE = "Tides turn twice in a day here.";
const SENTENCE_ZH = "这里的潮水每天涨落两次。";
const PLANS: Record<string, Plan> = {
  [SENTENCE]: { verdict: "supported", quote: LINE, says: LINE, judgement: "same" },
  [SENTENCE_ZH]: { verdict: "supported", quote: LINE_ZH, says: LINE_ZH, judgement: "same" },
};

/** The sentence with its Citation before its stop, as the assistant writes it. */
const written = (sentence: string) => `${sentence.slice(0, -1)}[^1]${sentence.slice(-1)}`;

/**
 * An assistant that cites `quote` and writes with `write`, rewriting a passage as `rewrite` says;
 * each check replies as `PLANS` say, and with `hold` its verdict waits until the test lets it go.
 */
function assistant(
  quote: string,
  write: { tool: string; input: unknown },
  hold: boolean,
  rewrite: (passage: string) => string = (passage) => passage,
) {
  let release = () => {};
  const until = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached = () => {};
  const held = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const calls: ModelCall[] = [];
  const model = scriptedModel(
    (call): ScriptedReply => {
      calls.push(call);
      const passage = [EDIT_INSTRUCTIONS, EDIT_INSTRUCTIONS_NAMED].includes(call.system)
        ? /<passage>\n([\s\S]*?)\n<\/passage>/.exec(call.prompt)?.[1]
        : undefined;
      if (passage !== undefined) return { text: rewrite(passage) };
      if (isCheckRun(call)) {
        const reply = checkReply(call, PLANS);
        return hold && "text" in reply && reply.text?.startsWith("Verdict")
          ? { ...reply, pause: { after: 0, until, reached } }
          : reply;
      }
      const search = call.results.find((result) => result.tool === "search_documents");
      if (!search) return { calls: [{ tool: "search_documents", input: { query: "tides" } }] };
      if (!call.results.some((result) => result.tool === "cite")) {
        const passage = shownPassages(search.text).find((each) => each.text.includes(quote));
        return {
          calls: [
            { tool: "cite", input: { citations: [{ marker: 1, passage: passage?.id, quote }] } },
          ],
        };
      }
      if (!call.results.some((result) => result.tool === write.tool)) return { calls: [write] };
      return { text: "Done." };
    },
    { generate: judgesNothing },
  );
  return { model, calls, held, release };
}

async function noteWith(
  model: ReturnType<typeof scriptedModel>,
  before: (tides: Document) => JSONContent[] = () => [],
) {
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
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
  const [tides] = await addAndProcess(core, [await writeSourceFile(sources, "Tides.md", TIDES)]);
  if (!tides) throw new Error("Tides.md wasn't added.");
  const mind = await core.createMind({ title: "Harbour" });
  const client = await connectToMind(core, mind.id);
  const blocks = before(tides);
  if (blocks.length > 0) {
    writeMind(client, blocks);
    await client.settled();
  }
  return { core, mind, client };
}

/** A text's words without its formatting, which its `toString` writes as tags. */
const wordsOf = (text: Y.XmlText) =>
  (text.toDelta() as { insert: unknown }[])
    .map((run) => (typeof run.insert === "string" ? run.insert : ""))
    .join("");

/** Lets the core's pushes reach the client: they arrive on later turns of the event loop. */
async function turns() {
  for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve));
}

/** The Note's words and Citations, each Citation as its quote in brackets. */
function textOf(doc: ProseMirrorNode): string[] {
  const lines: string[] = [];
  doc.descendants((node) => {
    if (!node.isTextblock) return true;
    let line = "";
    node.forEach((child) => {
      line += child.isText ? (child.text ?? "") : `[${String(child.attrs.quote)}]`;
    });
    if (line !== "") lines.push(line);
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

/** A Citation in the Note, with the change it is part of while that waits. */
type Cited = CitationAttributes & { proposal?: unknown };

const citationsIn = (client: MindClient): Cited[] => {
  const found: Cited[] = [];
  readMind(client).descendants((node) => {
    if (node.type.name === CITATION_NODE) found.push(node.attrs as Cited);
  });
  return found;
};

/** Writes `sentence` into a new Note citing `writerQuote`, and holds its check till `meanwhile` is done. */
async function heldWrite(
  sentence: string,
  writerQuote: string,
  meanwhile: (client: MindClient) => unknown,
) {
  const write = { tool: "add_to_mind", input: { content: written(sentence) } };
  const { model, calls, held, release } = assistant(writerQuote, write, true);
  const { core, mind, client } = await noteWith(model);
  const answered = askAssistant(core, {
    text: "Add a line on tides to this Note",
    mindId: mind.id,
  });
  await held;
  await turns();
  expect(pendingProposals(client.blocks).length).toBeGreaterThan(0);
  await meanwhile(client);
  await client.settled();
  release();
  await answered;
  await turns();
  return { client, calls };
}

describe("The assistant's change resolved while its check runs", { timeout: 30_000 }, () => {
  // protects=a change the User accepts while its check runs leaves the sentence as they accepted it: the check's found Passage is not written into it, the sentence reads found elsewhere, and Add as Citation then shows its ✓ with no request, in English and Chinese (#3019); fails_when=the check puts its Passage into the accepted text by itself, or the ✓ shows without the User's click; no_claim=the card's look.
  test.each([
    [SENTENCE, OTHER, LINE],
    [SENTENCE_ZH, OTHER_ZH, LINE_ZH],
  ])("accepted: %s", async (sentence, writerQuote, found) => {
    const { client, calls } = await heldWrite(sentence, writerQuote, (note) =>
      resolveChanges(note, "accept"),
    );
    expect(pendingProposals(client.blocks)).toEqual([]);
    expect(textOf(readMind(client))).toEqual([
      `${sentence.slice(0, -1)}[${writerQuote}]${sentence.slice(-1)}`,
    ]);
    expect(shownIn(client).map((claim) => claim.shown)).toEqual([
      { state: "not-checked", reason: "found-elsewhere" },
    ]);

    const asked = calls.length;
    const editor = boundEditor(client, [CitationNumbers, ClaimChecks]);
    const [claim] = shownClaims(editor.state);
    if (!claim) throw new Error("The sentence has no check.");
    expect(addAsCitation(editor, claim)).toBe(true);
    expect(shownClaims(editor.state)[0]?.shown).toEqual({ state: "supported" });
    expect(citationsIn(client).at(-1)?.quote).toContain(found);
    expect(citationsIn(client).at(-1)?.foundByCheck).toBe(true);
    expect(calls.length).toBe(asked);
  });

  // protects=a change the User rejects while its check runs leaves nothing behind when the check lands: no sentence, no Citation, no mark (#3019); fails_when=the check writes its Passage or its mark back into the Note; no_claim=none.
  test("rejected", async () => {
    const { client } = await heldWrite(SENTENCE, OTHER, (note) => resolveChanges(note, "reject"));
    expect(textOf(readMind(client))).toEqual([]);
    expect(citationsIn(client)).toEqual([]);
    expect(shownIn(client)).toEqual([]);
  });

  // protects=a sentence the User edits while its check runs keeps their words, gets no Citation from the check, and shows it needs checking again, as before (#3019); fails_when=the check writes its Passage into the edited sentence; no_claim=none.
  test("edited", async () => {
    const { client } = await heldWrite(SENTENCE, OTHER, (note) => {
      note.doc.transact(() => {
        for (const block of note.blocks.toArray()) {
          const text = block instanceof Y.XmlElement ? block.get(0) : null;
          if (text instanceof Y.XmlText && wordsOf(text).startsWith("Tides turn"))
            text.insert("Tides".length, " always");
        }
      });
    });
    expect(citationsIn(client).map((each) => each.quote)).toEqual([OTHER]);
    expect(shownIn(client).map((claim) => claim.shown)).toEqual([
      { state: "needs-recheck", why: "edited" },
    ]);
  });
});

/**
 * A paragraph the assistant wrote and the User accepted, now theirs, under its heading, citing the
 * line that doesn't say it: the assistant's next change rewrites words inside it.
 */
const accepted = (tides: Document): JSONContent[] => [
  {
    type: "heading",
    attrs: { id: "heading", level: 2 },
    content: [{ type: "text", text: "Tides", marks: [{ type: GENERATED_MARK }] }],
  },
  {
    type: "paragraph",
    attrs: { id: "accepted" },
    content: [
      { type: "text", text: "Tides turn often", marks: [{ type: GENERATED_MARK }] },
      {
        type: CITATION_NODE,
        attrs: {
          documentId: tides.id,
          documentName: tides.name,
          contentHash: tides.contentHash,
          quote: OTHER,
          check: "found",
        },
      },
      { type: "text", text: ".", marks: [{ type: GENERATED_MARK }] },
    ],
  },
];

describe("A change that rewrites words inside a paragraph", { timeout: 30_000 }, () => {
  // protects=when the assistant's change rewrites words inside a paragraph the User already holds, the found Passage goes in after words that change inserts, as part of it: Reject takes it away with them and Accept keeps it and the ✓, with no request (#3019); fails_when=the Passage lands outside the waiting change, survives a Reject, or the ✓ needs another request after Accept; no_claim=how the change splits the words.
  test.each([["reject"], ["accept"]] as const)("%s", async (outcome) => {
    const edit = {
      tool: "edit_mind",
      input: { part: "Tides", content: `## Tides\n\n${written(SENTENCE)}` },
    };
    const { model, calls } = assistant(OTHER, edit, false);
    const { core, mind, client } = await noteWith(model, accepted);
    const before = textOf(readMind(client));
    await askAssistant(core, { text: "Say what the tides do here", mindId: mind.id });
    await turns();
    expect(pendingProposals(client.blocks).length).toBeGreaterThan(0);
    const found = () =>
      citationsIn(client).flatMap((each) => (each.foundByCheck ? [each.quote ?? ""] : []));
    expect(found()).toEqual([expect.stringContaining(LINE)]);
    expect(citationsIn(client).find((each) => each.foundByCheck)?.proposal).toMatchObject({
      kind: "insert",
    });
    const asked = calls.length;

    await resolveChanges(client, outcome);
    await client.settled();
    if (outcome === "reject") {
      expect(textOf(readMind(client))).toEqual(before);
      expect(found()).toEqual([]);
    } else {
      expect(found()).toEqual([expect.stringContaining(LINE)]);
      expect(shownIn(client).map((claim) => claim.shown)).toEqual([{ state: "supported" }]);
    }
    expect(calls.length).toBe(asked);
  });
});
