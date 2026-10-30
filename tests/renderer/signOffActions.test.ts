import { type Editor, getSchema } from "@tiptap/core";
import type { Slice } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import { prosemirrorToYXmlFragment } from "@tiptap/y-tiptap";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import * as Y from "yjs";
import { CITATION_NODE, type CitationAttributes, MIND_CONTENT_FIELD } from "../../src/core/api";
import { setProposal } from "../../src/core/proposals/write";
import { citationCopiesKey } from "../../src/renderer/src/editor/citationSchema";
import { undoStackOf } from "../../src/renderer/src/editor/editorUndo";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { resolveInEditor } from "../../src/renderer/src/editor/proposalReview";
import {
  citationSignOff,
  noteDocOf,
  signOffCounts,
  toggleCitationSignOff,
} from "../../src/renderer/src/editor/signOffActions";
import { pendingPart } from "../../src/shared/claimParts";
import { citationSignOffBasis, type SignOffRecord, signOffsOf } from "../../src/shared/signOffs";
import { createTempDataFolder, startCore } from "../helpers/core";
import { boundEditor, headlessEditor } from "../helpers/editor";
import type { MindClient } from "../helpers/mindClient";
import { connectToMind } from "../helpers/mindClient";
import { writeMind } from "../helpers/minds";

const store = vi.hoisted(() => ({ documents: [] as { id: string; contentHash: string }[] }));
vi.mock("../../src/renderer/src/store", () => ({
  useAppStore: { getState: () => ({ documents: store.documents, settings: null }) },
}));

/*
 * The User's own "Checked by me" on a Citation (#1933), in the editor: one step of the note's
 * Undo with the id it gives the Citation, and a copy pasted beside a marked Citation is a
 * Citation of its own.
 */

const cited = (id?: string) => ({
  type: CITATION_NODE,
  attrs: {
    passageId: "passage-1",
    documentId: "document-1",
    documentName: "Tides",
    contentHash: "v1",
    quote: "Spring tides come at new moon.",
    check: "found",
    ...(id && { id }),
  },
});

const signer = { name: "Ada Lovelace", personId: "person-1" };

function citationAt(editor: Editor): { pos: number; id: unknown } {
  let found: { pos: number; id: unknown } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (!found && node.type.name === CITATION_NODE) found = { pos, id: node.attrs.id };
  });
  if (!found) throw new Error("No Citation");
  return found;
}

describe("Checked by me on a Citation", () => {
  // protects=marking a Citation gives it an id and writes the mark in one step, which the note's Undo takes back whole, and marking it again takes the mark off (#1933); fails_when=Undo leaves the mark, or the id without it; no_claim=the card's words, which the smoke spec covers.
  test("marks it, and the note's Undo takes the mark back with the id it gave it", async () => {
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind({ title: "Tides" });
    const client = await connectToMind(core, mind.id);
    writeMind(client, [
      {
        type: "paragraph",
        attrs: { id: "p1" },
        content: [
          { type: "text", text: "Spring tides come at new moon" },
          cited(),
          { type: "text", text: "." },
        ],
      },
    ]);
    await client.settled();
    const editor = boundEditor(client);
    const doc = noteDocOf(editor);
    if (!doc) throw new Error("The editor isn't bound to the Note.");

    toggleCitationSignOff(editor, citationAt(editor).pos, signer);
    const { pos, id } = citationAt(editor);
    expect(typeof id).toBe("string");
    const versions = new Map([["document-1", "v1"]]);
    const now = () =>
      citationSignOff(
        signOffsOf(doc),
        editor.state.doc,
        pos,
        (editor.state.doc.nodeAt(pos)?.attrs ?? {}) as CitationAttributes,
        versions,
        "person-1",
      );
    expect(now()).toMatchObject({ state: "checked", name: "Ada Lovelace", mine: true });

    editor.commands.undo();
    expect(citationAt(editor).id ?? null).toBeNull();
    expect(signOffsOf(doc)).toEqual([]);

    editor.commands.redo();
    expect(now()).toMatchObject({ state: "checked" });
    toggleCitationSignOff(editor, citationAt(editor).pos, signer);
    expect(signOffsOf(doc)).toEqual([]);
  });

  // protects=a mark made now is checked now: a Citation kept at its Document's first version while a newer one is current reads checked once the User marks it, and changed only when a version newer than that comes (#1933), in English and Chinese; fails_when=the fresh mark reads changed; no_claim=Keep citing the old version itself.
  test.each([
    ["en", "Spring tides come at new moon"],
    ["zh-CN", "大潮出现在新月时"],
  ])("a fresh mark on a Citation of an older version is checked (%s)", async (_, words) => {
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind({ title: "Tides" });
    const client = await connectToMind(core, mind.id);
    writeMind(client, [
      {
        type: "paragraph",
        attrs: { id: "p1" },
        content: [{ type: "text", text: words }, cited(), { type: "text", text: "." }],
      },
    ]);
    await client.settled();
    const editor = boundEditor(client);
    const doc = noteDocOf(editor);
    if (!doc) throw new Error("The editor isn't bound to the Note.");
    store.documents = [{ id: "document-1", contentHash: "v2" }];
    try {
      toggleCitationSignOff(editor, citationAt(editor).pos, signer);
      const { pos } = citationAt(editor);
      const shown = (versions: Map<string, string>) =>
        citationSignOff(
          signOffsOf(doc),
          editor.state.doc,
          pos,
          (editor.state.doc.nodeAt(pos)?.attrs ?? {}) as CitationAttributes,
          versions,
          "person-1",
        )?.state;
      expect(shown(new Map([["document-1", "v2"]]))).toBe("checked");
      expect(shown(new Map([["document-1", "v3"]]))).toBe("changed");
    } finally {
      store.documents = [];
    }
  });

  // protects=a Citation marked in the editor after a version was kept, then edited or deleted, comes back from that version with the mark's id, so the mark shows on it again; and so does one that version was already restored once before the mark (#1933), in English and Chinese; fails_when=the restored Citation has no id or another; no_claim=whether the mark then reads checked or changed.
  test.each([
    ["en", "edited", "Spring tides come at new moon"],
    ["en", "deleted", "Spring tides come at new moon"],
    ["en", "restored before the mark", "Spring tides come at new moon"],
    ["zh-CN", "edited", "大潮出现在新月时"],
    ["zh-CN", "deleted", "大潮出现在新月时"],
    ["zh-CN", "restored before the mark", "大潮出现在新月时"],
  ] as const)(
    "a version kept before the mark brings the Citation back marked (%s, %s)",
    async (_, since, words) => {
      const core = startCore(await createTempDataFolder());
      const mind = await core.createMind({ title: "Tides" });
      const client = await connectToMind(core, mind.id);
      writeMind(client, [
        {
          type: "paragraph",
          attrs: { id: "p1" },
          content: [{ type: "text", text: words }, cited(), { type: "text", text: "." }],
        },
      ]);
      await client.settled();
      const kept = await core.saveCheckpoint(mind.id, "accept");
      const editor = boundEditor(client);
      const doc = noteDocOf(editor);
      if (!doc) throw new Error("The editor isn't bound to the Note.");
      if (since === "restored before the mark") {
        await core.restoreCheckpoint(mind.id, kept.id);
        await client.settled();
      }

      toggleCitationSignOff(editor, citationAt(editor).pos, signer);
      const marked = signOffsOf(doc)[0]?.target.id;
      expect(citationAt(editor).id).toBe(marked);
      const { pos } = citationAt(editor);
      if (since === "edited")
        editor.view.dispatch(
          editor.state.tr.setNodeAttribute(pos, "quote", "Neap tides come at half moon."),
        );
      if (since === "deleted") editor.commands.deleteRange({ from: pos, to: pos + 1 });
      await client.settled();

      await core.restoreCheckpoint(mind.id, kept.id);
      await client.settled();

      expect(citationAt(editor).id).toBe(marked);
      expect(signOffsOf(doc).map((record) => record.target.id)).toEqual([marked]);
    },
  );

  // protects=a marked Citation copied and pasted beside itself is a Citation of its own, with no id, so the mark never moves to the copy; one cut and pasted, or dragged, keeps its id and the mark (#1933); fails_when=a copy shares the id; no_claim=pastes from other apps.
  test("a copy pasted beside a marked Citation has no id; one moved keeps it", () => {
    const editor = headlessEditor();
    editor.commands.setContent({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Tides" }, cited("c1")] }],
    });
    const { pos } = citationAt(editor);
    const slice = editor.state.doc.slice(pos, pos + 1);
    const plugin = editor.state.plugins.find((each) => each.spec.key === citationCopiesKey);
    const paste = plugin?.props.transformPasted;
    if (!plugin || !paste) throw new Error("No paste transform for Citations");
    const idsIn = (fragment: ReturnType<typeof paste>) => {
      const ids: unknown[] = [];
      fragment.content.descendants((node) => {
        if (node.type.name === CITATION_NODE) ids.push(node.attrs.id ?? null);
      });
      return ids;
    };
    const view = (move: boolean) =>
      ({ state: editor.state, dragging: move ? { slice, move } : null }) as unknown as EditorView;

    expect(idsIn(paste.call(plugin, slice, view(false), false))).toEqual([null]);
    expect(idsIn(paste.call(plugin, slice, view(true), false))).toEqual(["c1"]);

    editor.commands.deleteRange({ from: pos, to: pos + 1 });
    expect(idsIn(paste.call(plugin, slice, view(false), false))).toEqual(["c1"]);
  });

  // protects=a Citation the editor writes has its own id from the start, so one deleted and brought back with ⌘Z before anyone marks it, then marked, is found again by a version kept before the deletion (#1933), in English and Chinese; fails_when=the restored Citation lacks the mark's id; no_claim=Undo of the mark itself, which the first test covers.
  test.each([
    ["en", "Spring tides come at new moon"],
    ["zh-CN", "大潮出现在新月时"],
  ])("a Citation deleted and brought back with Undo keeps its id (%s)", async (_, words) => {
    const { core, mind, client, editor, doc } = await noteWith(words, false);
    editor.commands.insertContentAt(words.length + 1, cited());
    const written = citationAt(editor).id;
    expect(typeof written).toBe("string");
    await client.settled();
    const kept = await core.saveCheckpoint(mind.id, "accept");

    undoStackOf(editor)?.stopCapturing();
    const { pos } = citationAt(editor);
    editor.commands.deleteRange({ from: pos, to: pos + 1 });
    undoStackOf(editor)?.stopCapturing();
    editor.commands.undo();
    await client.settled();
    expect(citationAt(editor).id).toBe(written);

    toggleCitationSignOff(editor, citationAt(editor).pos, signer);
    expect(signOffsOf(doc)[0]?.target.id).toBe(written);
    await core.restoreCheckpoint(mind.id, kept.id);
    await client.settled();
    expect(citationAt(editor).id).toBe(written);
  });

  // protects=an older Citation, written before Citations had ids, keeps the identity the versions kept before give it when the Note's very first edit here deletes it, changes it in place (Keep citing the old version), edits beside it, or turns its paragraph into a heading, a bullet list or a quote: brought back with ⌘Z or changed, then marked, it is found by a version from before (#1933), in English and Chinese; fails_when=the Citation the mark names isn't the one the restore brings back; no_claim=a Note opened and never edited, which gets no ids.
  test.each([
    ["deleted", "en", "Spring tides come at new moon"],
    ["changed in place", "en", "Spring tides come at new moon"],
    ["edited beside", "en", "Spring tides come at new moon"],
    ["made a heading", "en", "Spring tides come at new moon"],
    ["made a bullet list", "en", "Spring tides come at new moon"],
    ["made a quote", "en", "Spring tides come at new moon"],
    ["deleted", "zh-CN", "大潮出现在新月时"],
    ["changed in place", "zh-CN", "大潮出现在新月时"],
    ["edited beside", "zh-CN", "大潮出现在新月时"],
    ["made a heading", "zh-CN", "大潮出现在新月时"],
    ["made a bullet list", "zh-CN", "大潮出现在新月时"],
    ["made a quote", "zh-CN", "大潮出现在新月时"],
  ] as const)(
    "an older Citation keeps its identity when the Note's first edit is: %s (%s)",
    async (first, _, words) => {
      const { core, mind, client, editor, doc } = await noteWith(words, true);
      expect(citationAt(editor).id ?? null).toBeNull();
      const kept = await core.saveCheckpoint(mind.id, "accept");

      const { pos } = citationAt(editor);
      if (first === "deleted") {
        editor.commands.deleteRange({ from: pos, to: pos + 1 });
        undoStackOf(editor)?.stopCapturing();
        editor.commands.undo();
      } else if (first === "changed in place") {
        const node = editor.state.doc.nodeAt(pos);
        editor.view.dispatch(
          editor.state.tr.setNodeMarkup(pos, undefined, {
            ...node?.attrs,
            contentHash: "v2",
            keptOver: "v1",
          }),
        );
      } else if (first === "edited beside") {
        editor.view.dispatch(editor.state.tr.insertText("So: ", 1));
      } else {
        editor.commands.setTextSelection(2);
        if (first === "made a heading") editor.commands.setNode("heading", { level: 2 });
        else if (first === "made a bullet list") editor.commands.toggleBulletList();
        else editor.commands.toggleBlockquote();
        undoStackOf(editor)?.stopCapturing();
        editor.commands.undo();
      }
      await client.settled();

      toggleCitationSignOff(editor, citationAt(editor).pos, signer);
      const marked = signOffsOf(doc)[0]?.target.id;
      expect(typeof marked).toBe("string");
      await core.restoreCheckpoint(mind.id, kept.id);
      await client.settled();
      expect(citationAt(editor).id).toBe(marked);
    },
  );

  // protects=an older Citation the assistant's waiting change takes out, accepted in the editor and brought back with ⌘Z before the Note was edited here, keeps the identity the versions kept before give it, so a mark made on it is found by them (#1933), in English and Chinese; fails_when=the Citation the mark names isn't the one the restore brings back; no_claim=the changes card, which decides through the same helper.
  test.each([
    ["en", "Spring tides come at new moon"],
    ["zh-CN", "大潮出现在新月时"],
  ])(
    "an older Citation the assistant's accepted deletion took out keeps its identity through Undo (%s)",
    async (_, words) => {
      const { core, mind, client, editor, doc } = await noteWith(words, true);
      const kept = await core.saveCheckpoint(mind.id, "accept");
      client.doc.transact(() => {
        for (const block of client.blocks.toArray()) {
          if (!(block instanceof Y.XmlElement)) continue;
          for (const node of block.createTreeWalker((each) => each instanceof Y.XmlElement))
            if (node instanceof Y.XmlElement && node.nodeName === CITATION_NODE)
              setProposal(node, { id: "change-1", request: "request-1", kind: "delete" });
        }
      }, "core");
      await client.settled();

      resolveInEditor(editor, "all", "accept");
      expect(() => citationAt(editor)).toThrow();
      editor.commands.undo();
      await client.settled();

      toggleCitationSignOff(editor, citationAt(editor).pos, signer);
      const marked = signOffsOf(doc)[0]?.target.id;
      expect(typeof marked).toBe("string");
      await core.restoreCheckpoint(mind.id, kept.id);
      await client.settled();
      expect(citationAt(editor).id).toBe(marked);
    },
  );

  // protects=a Citation cut and pasted elsewhere keeps its id, so a version kept before the move still finds the mark made after it, and a copy pasted beside it gets an id of its own (#1933); fails_when=the moved Citation loses its id, or the copy shares it; no_claim=pastes from other apps.
  test("a Citation cut and pasted keeps its id; a copy pasted beside it gets its own", async () => {
    const { core, mind, client, editor, doc } = await noteWith(
      "Spring tides come at new moon",
      false,
    );
    editor.commands.insertContentAt(31, cited());
    const written = citationAt(editor).id;
    await client.settled();
    const kept = await core.saveCheckpoint(mind.id, "accept");
    const pasted = (slice: Slice) => {
      const plugin = editor.state.plugins.find((each) => each.spec.key === citationCopiesKey);
      const paste = plugin?.props.transformPasted;
      if (!plugin || !paste) throw new Error("No paste transform for Citations");
      return paste.call(plugin, slice, editor.view, false);
    };

    const { pos } = citationAt(editor);
    const slice = editor.state.doc.slice(pos, pos + 1);
    editor.commands.deleteRange({ from: pos, to: pos + 1 });
    editor.view.dispatch(editor.state.tr.replace(1, 1, pasted(slice)));
    expect(citationAt(editor)).toMatchObject({ pos: 1, id: written });
    editor.view.dispatch(editor.state.tr.replace(2, 2, pasted(editor.state.doc.slice(1, 2))));
    const ids: unknown[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === CITATION_NODE) ids.push(node.attrs.id);
    });
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(written);
    expect(typeof ids[1]).toBe("string");
    expect(ids[1]).not.toBe(written);
    await client.settled();

    toggleCitationSignOff(editor, 1, signer);
    await core.restoreCheckpoint(mind.id, kept.id);
    await client.settled();
    expect(citationAt(editor).id).toBe(written);
    expect(signOffsOf(doc).map((record) => record.target.id)).toEqual([written]);
  });

  // protects=checked text deleted by ordinary editing leaves the badge's counts, which cover only the text as it is, and ⌘Z brings its mark back (#1933), in English and Chinese; fails_when=the count keeps the deleted Citation, or Undo leaves it off; no_claim=the badge's words, which the smoke spec covers.
  test.each([
    ["en", "Spring tides come at new moon"],
    ["zh-CN", "大潮出现在新月时"],
  ])(
    "deleting a checked Citation drops it from the counts, and Undo brings it back (%s)",
    async (_, words) => {
      const { editor, doc } = await noteWith(words, false);
      editor.commands.insertContentAt(words.length + 1, cited());
      undoStackOf(editor)?.stopCapturing();
      toggleCitationSignOff(editor, citationAt(editor).pos, signer);
      const versions = new Map([["document-1", "v1"]]);
      const counts = () =>
        signOffCounts(editor.state.doc, signOffsOf(doc), null, versions, "person-1");
      expect(counts()).toEqual({ checked: 1, changed: 0 });

      undoStackOf(editor)?.stopCapturing();
      const { pos } = citationAt(editor);
      editor.commands.deleteRange({ from: pos, to: pos + 1 });
      expect(counts()).toEqual({ checked: 0, changed: 0 });
      undoStackOf(editor)?.stopCapturing();
      editor.commands.undo();
      expect(counts()).toEqual({ checked: 1, changed: 0 });
    },
  );

  // protects=two devices editing the same older Note apart give its older Citation the same id, its element's, so the marks each makes name one Citation once their changes meet (#1933); fails_when=the two ids differ or either is missing; no_claim=Citations written since, whose id their writer gives.
  test("two devices give an older Citation the same id", () => {
    const first = new Y.Doc();
    const content = getSchema(noteExtensions()).nodeFromJSON({
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { id: "p1" },
          content: [{ type: "text", text: "Spring tides" }, cited(), { type: "text", text: "." }],
        },
      ],
    });
    prosemirrorToYXmlFragment(content, first.getXmlFragment(MIND_CONTENT_FIELD));
    const second = new Y.Doc();
    Y.applyUpdate(second, Y.encodeStateAsUpdate(first));
    onTestFinished(() => {
      first.destroy();
      second.destroy();
    });
    const editors = [first, second].map((each) => boundEditor({ doc: each } as MindClient));
    for (const editor of editors) editor.view.dispatch(editor.state.tr.insertText("So: ", 1));
    const [one, two] = editors.map((editor) => citationAt(editor).id);
    expect(typeof one).toBe("string");
    expect(two).toBe(one);

    Y.applyUpdate(second, Y.encodeStateAsUpdate(first));
    Y.applyUpdate(first, Y.encodeStateAsUpdate(second));
    expect(editors.map((editor) => citationAt(editor).id)).toEqual([one, one]);
  });
});

/** A Note of one sentence, bound to an editor; with `older`, its Citation is one written before Citations had ids. */
async function noteWith(words: string, older: boolean) {
  const core = startCore(await createTempDataFolder());
  const mind = await core.createMind({ title: "Tides" });
  const client = await connectToMind(core, mind.id);
  writeMind(client, [
    {
      type: "paragraph",
      attrs: { id: "p1" },
      content: [
        { type: "text", text: words },
        ...(older ? [cited()] : []),
        { type: "text", text: "." },
      ],
    },
  ]);
  await client.settled();
  const editor = boundEditor(client);
  const doc = noteDocOf(editor);
  if (!doc) throw new Error("The editor isn't bound to the Note.");
  return { core, mind, client, editor, doc };
}

describe("Checked by me on Note-owned part receipts", () => {
  test.each(["Revenue rose 5%, and costs fell.", "收入增长了5%，成本下降了。"])(
    "independent receipts use current words and one-step Undo without changing the app verdict: %s",
    async (words) => {
      const core = startCore(await createTempDataFolder());
      const mind = await core.createMind({ title: "Results" });
      const client = await connectToMind(core, mind.id);
      const receipt: CitationAttributes = {
        id: "receipt-a",
        passageId: "p",
        documentId: "document-1",
        documentName: "Results",
        contentHash: "v1",
        pageFrom: 1,
        pageTo: 1,
        location: null,
        quote: "Revenue rose 5%.",
        check: "found",
        checkReason: null,
      };
      const middle = Math.floor(words.length / 2);
      const parts = [
        [0, middle, "receipt-a"],
        [middle, words.length, "receipt-b"],
      ].map(([start, end, id]) => ({
        ...pendingPart({ span: { start: Number(start), end: Number(end) }, kind: "fact" }),
        verdict: "supported",
        evidence: [{ ...receipt, id }],
      }));
      writeMind(client, [
        {
          type: "paragraph",
          attrs: { id: "p1" },
          content: [
            {
              type: "text",
              text: words,
              marks: [
                {
                  type: "claimCheck",
                  attrs: {
                    id: "check",
                    request: "request",
                    action: "check-against-documents",
                    state: "supported",
                    text: words,
                    parts,
                    scope: { folderId: null, widened: false },
                    versions: [],
                    excluded: [],
                    checkedAt: "2026-10-28T09:00:00.000Z",
                  },
                },
              ],
            },
          ],
        },
      ]);
      await client.settled();
      const editor = boundEditor(client);
      const doc = noteDocOf(editor);
      if (!doc) throw new Error("No bound Note.");
      const before = editor.state.doc.toJSON();
      const counts = () =>
        signOffCounts(
          editor.state.doc,
          signOffsOf(doc),
          null,
          new Map([["document-1", "v1"]]),
          signer.personId,
        );
      toggleCitationSignOff(editor, "receipt-a", signer);
      expect(signOffsOf(doc).map((mark) => mark.target)).toEqual([
        { kind: "citation", id: "receipt-a" },
      ]);
      expect(counts()).toEqual({ checked: 1, changed: 0 });
      expect(editor.state.doc.toJSON()).toEqual(before);
      editor.commands.undo();
      expect(signOffsOf(doc)).toEqual([]);
      editor.commands.redo();
      expect(counts()).toEqual({ checked: 1, changed: 0 });
      toggleCitationSignOff(editor, "receipt-b", signer);
      expect(counts()).toEqual({ checked: 2, changed: 0 });
      toggleCitationSignOff(editor, "receipt-a", signer);
      expect(signOffsOf(doc).map((mark) => mark.target.id)).toEqual(["receipt-b"]);
      editor.view.dispatch(editor.state.tr.insertText("Updated ", 1));
      expect(counts()).toEqual({ checked: 0, changed: 1 });
      toggleCitationSignOff(editor, "receipt-b", signer);
      expect(counts()).toEqual({ checked: 1, changed: 0 });
      expect(
        signOffCounts(
          editor.state.doc,
          signOffsOf(doc),
          null,
          new Map([["document-1", "v2"]]),
          signer.personId,
        ),
      ).toEqual({ checked: 0, changed: 1 });
      const records = signOffsOf(doc);
      editor.setEditable(false);
      toggleCitationSignOff(editor, "receipt-a", signer);
      expect(signOffsOf(doc)).toEqual(records);
      editor.setEditable(true);
      editor.view.dispatch(editor.state.tr.delete(0, editor.state.doc.content.size));
      expect(() => toggleCitationSignOff(editor, "receipt-a", signer)).not.toThrow();
      expect(signOffsOf(doc)).toEqual(records);
      expect(counts()).toEqual({ checked: 0, changed: 0 });
    },
  );
});

test.each(["Spring tides come at new moon.", "大潮出现在新月时。"])(
  "an inline Citation and a part receipt with one canonical id count one human mark: %s",
  (words) => {
    const receipt: CitationAttributes = {
      id: "shared-citation",
      passageId: "p",
      documentId: "d",
      documentName: "Tides",
      contentHash: "v1",
      pageFrom: 1,
      pageTo: 1,
      location: null,
      quote: "Tides rise.",
      check: "found",
      checkReason: null,
    };
    const mark = {
      type: "claimCheck",
      attrs: {
        id: "check",
        state: "supported",
        text: words,
        parts: [
          {
            ...pendingPart({ span: { start: 0, end: words.length }, kind: "fact" }),
            verdict: "supported",
            evidence: [receipt],
          },
        ],
      },
    };
    const doc = getSchema(noteExtensions()).nodeFromJSON({
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { id: "p" },
          content: [
            { type: "text", text: words.slice(0, -1), marks: [mark] },
            { type: CITATION_NODE, attrs: receipt },
            { type: "text", text: words.slice(-1), marks: [mark] },
          ],
        },
      ],
    });
    const records: SignOffRecord[] = [
      {
        id: "human",
        target: { kind: "citation", id: receipt.id ?? "" },
        at: "2026-10-28T09:00:00.000Z",
        contentHash: citationSignOffBasis(words, receipt),
        deletedAt: null,
        name: signer.name,
        personId: signer.personId,
      },
    ];
    expect(signOffCounts(doc, records, null, new Map([["d", "v1"]]), signer.personId)).toEqual({
      checked: 1,
      changed: 0,
    });
    expect(signOffCounts(doc, records, null, new Map([["d", "v2"]]), signer.personId)).toEqual({
      checked: 0,
      changed: 1,
    });
  },
);
