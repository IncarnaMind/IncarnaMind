import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import type { Core, RestoreRef } from "../../src/core";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { citationState } from "../../src/shared/citations";
import { claimCheckShown } from "../../src/shared/claimChecks";
import { checkGenerate, checkReply, isCheckRun, type Plan } from "../helpers/checks";
import {
  askAndFinish,
  onlyCitation,
  setUpWithDocuments,
  shownPassages,
} from "../helpers/citations";
import type { MindClient } from "../helpers/mindClient";
import { editMind, readMind } from "../helpers/minds";
import { scriptedModel } from "../helpers/models";

/*
 * The Undo of an add takes its Documents out to Recently deleted, and its Redo brings back the
 * very same ones (#1390). Every Citation and check mark that pointed at them is then back as it
 * was (#2402): an Answer's Citation is found again, and a Note's mark is Supported again.
 */

const TIDES = {
  name: "Tides.md",
  contents: "# Tides\n\nSpring tides happen at new moon and at full moon.",
};
const BREAD = {
  name: "Bread.md",
  contents: "# Bread\n\nSourdough bread needs a starter fed with flour and water every day.",
};
const SPRING = "Spring tides happen at new moon and at full moon.";
const WRITTEN = "Spring tides come at new and full moon.";
const PLANS: Record<string, Plan> = {
  [WRITTEN]: { verdict: "supported", quote: SPRING, says: "Tides says so." },
};

/** Answers with one Citation of the Tides Document, and checks the Note's sentence as `PLANS` say. */
const model = () =>
  scriptedModel(
    (call) => {
      if (isCheckRun(call)) return checkReply(call, PLANS);
      const searches = call.results.filter((result) => result.tool === "search_documents");
      if (searches.length === 0) {
        return { calls: [{ tool: "search_documents", input: { query: "spring tides" } }] };
      }
      if (!call.results.some((result) => result.tool === "cite")) {
        const passage = shownPassages(searches.at(-1)?.text ?? "").find((each) =>
          each.text.includes(SPRING),
        );
        const citations = [{ marker: 1, passage: passage?.id, quote: SPRING }];
        return { calls: [{ tool: "cite", input: { citations } }] };
      }
      return { text: "Spring tides come at new and full moon [^1]." };
    },
    { generate: checkGenerate(PLANS), judgesItsAnswers: true },
  );

/** The Note's marks and the Answer's Citation as the window shows them, from the Library now. */
async function shown(core: Core, client: MindClient, answerId: string) {
  await client.settled();
  const documents = await core.listDocuments();
  const versions = new Map(documents.map((each) => [each.id, each.contentHash]));
  const [mark] = claimSpans(readMind(client)).map((span) =>
    claimCheckShown(span.check, {
      text: span.sentence.text,
      versions,
      folderId: null,
      scope: null,
    }),
  );
  const { check, reason } = citationState(onlyCitation(client, answerId), documents);
  return { mark, citation: { check, reason } };
}

describe("Undo and Redo of an add (#2402)", { timeout: 30_000 }, () => {
  test("after Redo, the Answer's Citation and the Note's mark that pointed at its Documents are back as before", async () => {
    const { core, client, mind, documents } = await setUpWithDocuments(model(), [TIDES, BREAD]);
    const { answerId } = await askAndFinish(core, client, mind.id, "When are spring tides?");
    const written: JSONContent & { attrs: { id: string } } = {
      type: "paragraph",
      attrs: { id: "written" },
      content: [{ type: "text", text: WRITTEN }],
    };
    editMind(client, (blocks) => [...blocks, written]);
    await client.settled();
    await core.checkSentences({
      requestId: crypto.randomUUID(),
      mindId: mind.id,
      action: "check-against-documents",
      from: { blockId: "written", offset: 0 },
      to: { blockId: "written", offset: WRITTEN.length },
    });
    const before = await shown(core, client, answerId);
    expect(before).toEqual({
      mark: { state: "supported" },
      citation: { check: "found", reason: null },
    });

    // The add's Undo, as the undo line's: each Document it brought in, to Recently deleted.
    const taken: RestoreRef[] = [];
    for (const document of documents) {
      await core.deleteDocument(document.id);
      taken.push({ kind: "document", id: document.id });
    }
    expect(await shown(core, client, answerId)).toEqual({
      mark: { state: "needs-recheck", why: "document-removed" },
      citation: { check: "cant-check", reason: "document-removed" },
    });

    // Its Redo.
    await core.restore(taken);
    expect(await shown(core, client, answerId)).toEqual(before);
    expect((await core.listDocuments()).map((each) => each.id).sort()).toEqual(
      documents.map((each) => each.id).sort(),
    );
  });
});
