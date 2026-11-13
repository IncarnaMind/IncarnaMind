/*
 * A Passage the check of what the assistant wrote finds goes into the Note only inside the write's
 * own change, while that change still waits for the User (#3019). This check runs after the
 * reply (#2830), and the window applies a reply's changes as its Answer ends: by the time a
 * verdict lands, the change is usually the User's, so the check writes nothing and the sentence
 * reads Supported, not yet cited, for Add as Citation or Add all. A change the rule for asked
 * changes holds back still waits, and the Passage rides in it.
 *
 * The window applies them when "conversation.message" brings the ended Answer: for a Note open
 * in no editor, with `core.applyAskedChanges` and each changed Note's requests from
 * `changedMinds`. These tests do the same on the same event; the check's requests wait until
 * it is done, as a check, slower than that call, does in the app.
 */
import { Editor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { DOMParser } from "linkedom";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  type AskedChangeApplication,
  CITATION_NODE,
  type CitationAttributes,
  type Core,
  MIND_CONTENT_FIELD,
} from "../../src/core";
import { changedMinds } from "../../src/renderer/src/changedMinds";
import { CitationNumbers } from "../../src/renderer/src/editor/citationNumbers";
import { ClaimChecks, shownClaims } from "../../src/renderer/src/editor/claimChecks";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { pendingProposals } from "../../src/shared/proposals";
import { checkReply, isCheckRun, type Plan } from "../helpers/checks";
import { answerEnded, shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { resolveChanges } from "../helpers/minds";
import { judgesNothing, scriptedModel, scriptedModels } from "../helpers/models";

vi.mock("../../src/renderer/src/core", () => ({ core: {} }));
vi.mock("../../src/renderer/src/editWithAi", () => ({ resolveProposalsIn: vi.fn() }));
vi.mock("../../src/renderer/src/modelInUse", () => ({ modelInUseOf: vi.fn() }));
vi.mock("../../src/renderer/src/store", () => ({
  useAppStore: { getState: () => ({ documents: [], minds: [], settings: { language: "en" } }) },
}));

const { addAsCitation, addFoundCitations } = await import("../../src/renderer/src/checks");

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
  vi.unstubAllGlobals();
});

const LINE = "The tide turns twice a day.";
const OTHER = "The harbour closes at dusk.";
const DAWN = "Boats leave the harbour at dawn.";
const TIDES = { name: "Tides.md", contents: `# Tides\n\n${LINE}\n\n${OTHER}\n\n${DAWN}\n` };
const SENTENCE = "Tides turn twice in a day here.";
const EARLY = "Boats sail out early in the morning.";
const STRAY = "- A stray line from the search.";
// Each sentence cites the harbour's closing; its check finds the Passage that backs it elsewhere.
const PLANS: Record<string, Plan> = {
  [SENTENCE]: { verdict: "supported", quote: LINE, says: LINE, judgement: "same" },
  [EARLY]: { verdict: "supported", quote: DAWN, says: DAWN, judgement: "same" },
};
const WRITTEN = `## Harbour\n\n${SENTENCE.slice(0, -1)}[^1]. ${EARLY.slice(0, -1)}[^1].`;
const NOT_YET_CITED = { state: "not-checked", reason: "found-elsewhere" };

/**
 * The assistant cites the closing line and writes both sentences into the Note in front; with
 * `takesOut`, it then takes a stray line back out of its own text in the same turn, said to only
 * take text out, which the rule holds back. A check's request waits for `applied`.
 */
function writer(applied: Promise<void>, takesOut: boolean) {
  return scriptedModel(
    (call) => {
      if (isCheckRun(call)) {
        const reply = checkReply(call, PLANS);
        return "error" in reply ? reply : { ...reply, pause: { after: 0, until: applied } };
      }
      const search = call.results.find((result) => result.tool === "search_documents");
      if (!search) return { calls: [{ tool: "search_documents", input: { query: "harbour" } }] };
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
          calls: [
            {
              tool: "add_to_mind",
              input: { content: takesOut ? `${WRITTEN}\n\n${STRAY}` : WRITTEN },
            },
          ],
        };
      if (takesOut && !call.results.some((result) => result.tool === "edit_mind"))
        return {
          calls: [
            {
              tool: "edit_mind",
              input: { part: "Harbour", content: WRITTEN, times_as_long: 1, removes_only: true },
            },
          ],
        };
      return { text: "Added it." };
    },
    { generate: judgesNothing },
  );
}

function stubDom() {
  const document = new DOMParser().parseFromString(
    "<html><head></head><body></body></html>",
    "text/html",
  );
  Object.defineProperty(document, "styleSheets", { value: [] });
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", document.defaultView);
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("getComputedStyle", () => ({
    fontStyle: "",
    fontWeight: "",
    fontSize: "",
    fontFamily: "",
  }));
}

/** The Note's editor, as the window binds it to the Note's copy the core keeps. */
function editorOf(client: MindClient): Editor {
  const editor = new Editor({
    element: globalThis.document.createElement("div"),
    editorProps: { handleScrollToSelection: () => true },
    extensions: [
      ...noteExtensions(),
      CitationNumbers,
      ClaimChecks,
      Collaboration.configure({ document: client.doc, field: MIND_CONTENT_FIELD }),
    ],
  });
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  cleanup.push(() => editor.destroy());
  return editor;
}

const citationsIn = (editor: Editor): CitationAttributes[] => {
  const found: CitationAttributes[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === CITATION_NODE) found.push(node.attrs as CitationAttributes);
  });
  return found;
};

const foundIn = (editor: Editor) =>
  citationsIn(editor).flatMap((each) => (each.foundByCheck ? [each.quote] : []));

const shownIn = (editor: Editor) => shownClaims(editor.state).map((each) => each.shown);

/**
 * The assistant writes into the Note in front; its reply's changes are applied as the window
 * applies them when its Answer ends, and the write's check, waiting until then, lands after.
 */
async function writtenThenApplied(takesOut: boolean) {
  stubDom();
  let release = () => {};
  const applied = new Promise<void>((resolve) => {
    release = resolve;
  });
  const core: Core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(writer(applied, takesOut)).createChatModel,
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
  const mind = await core.createMind({ title: "Harbour notes" });
  const client = await connectToMind(core, mind.id);

  const applications: Promise<(AskedChangeApplication | null)[]>[] = [];
  core.on("conversation.message", (message) => {
    if (message.kind !== "answer" || message.status === "streaming" || applications.length > 0)
      return;
    const all = Promise.all(
      changedMinds(message).map((row) =>
        core.applyAskedChanges({
          answerId: message.id,
          mindId: row.mindId,
          requests: row.requests,
        }),
      ),
    );
    applications.push(all);
    void all.finally(release);
  });
  const asked = await core.askInConversation({
    text: "Add a line on the harbour",
    mindId: mind.id,
  });
  if (!asked.asked) throw new Error(`The Question wasn't asked: ${JSON.stringify(asked)}`);
  expect((await answerEnded(core, asked.answerId)).event).toBe("finished");
  const [all] = applications;
  if (!all) throw new Error("The Answer's changes were never applied.");
  const held = (await all).map((each) => each?.held ?? null);
  await client.settled();
  return { client, held, editor: editorOf(client) };
}

describe("A Passage the check finds once the reply's changes are the User's", {
  timeout: 30_000,
}, () => {
  // protects=with the reply's changes applied as the window applies them when the Answer ends, the check that lands after writes nothing into the Note: each sentence reads Supported, not yet cited; Add as Citation cites one, and Add all every one of that check, each with one Undo (#3019, #2830); fails_when=the check writes a Citation into words that are the User's, a sentence reads ✓ with no Citation that says it, or Add and its Undo don't round-trip; no_claim=how the card draws it.
  test("applied when the Answer ends, the check writes nothing; Add as Citation and Add all cite, each with one Undo", async () => {
    const { client, held, editor } = await writtenThenApplied(false);

    expect(held).toEqual([false]);
    expect(pendingProposals(client.blocks)).toEqual([]);
    expect(citationsIn(editor).map((each) => [each.quote, each.foundByCheck ?? null])).toEqual([
      [OTHER, null],
      [OTHER, null],
    ]);
    expect(shownIn(editor)).toEqual([NOT_YET_CITED, NOT_YET_CITED]);

    const [first] = shownClaims(editor.state);
    if (!first) throw new Error("The first sentence has no check.");
    expect(addAsCitation(editor, first)).toBe(true);
    expect(shownIn(editor)).toEqual([{ state: "supported" }, NOT_YET_CITED]);
    expect(foundIn(editor)).toEqual([expect.stringContaining(LINE)]);
    editor.commands.undo();
    expect(shownIn(editor)).toEqual([NOT_YET_CITED, NOT_YET_CITED]);
    expect(foundIn(editor)).toEqual([]);

    expect(addFoundCitations(editor)).toBe(2);
    expect(shownIn(editor)).toEqual([{ state: "supported" }, { state: "supported" }]);
    expect(foundIn(editor)).toEqual([expect.stringContaining(LINE), expect.stringContaining(DAWN)]);
    editor.commands.undo();
    expect(shownIn(editor)).toEqual([NOT_YET_CITED, NOT_YET_CITED]);
    expect(foundIn(editor)).toEqual([]);
  });

  // protects=a change the rule for asked changes holds back, here a removal in the same turn said to only take text out that does more, still waits when the check lands, and the found Passages ride in it as each part's Citation: rejecting the change takes them with it (#3019); fails_when=a found Passage is left out of the waiting change or lands outside it; no_claim=whether the rule should hold this reply.
  test("a change still waiting when the check lands takes the found Passages in it", async () => {
    const { client, held, editor } = await writtenThenApplied(true);

    expect(held).toEqual([true]);
    expect(pendingProposals(client.blocks).length).toBeGreaterThan(0);
    expect(foundIn(editor)).toEqual([expect.stringContaining(LINE), expect.stringContaining(DAWN)]);
    expect(shownIn(editor)).toEqual([{ state: "supported" }, { state: "supported" }]);

    await resolveChanges(client, "reject");
    expect(citationsIn(editor)).toEqual([]);
    expect(shownIn(editor)).toEqual([]);
  });
});
