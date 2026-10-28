import type { Editor } from "@tiptap/core";
import type { EditorView } from "@tiptap/pm/view";
import { describe, expect, test, vi } from "vitest";
import { CITATION_NODE, type CitationAttributes } from "../../src/core/api";
import { citationCopiesKey } from "../../src/renderer/src/editor/citationSchema";
import {
  citationSignOff,
  noteDocOf,
  toggleCitationSignOff,
} from "../../src/renderer/src/editor/signOffActions";
import { signOffsOf } from "../../src/shared/signOffs";
import { createTempDataFolder, startCore } from "../helpers/core";
import { boundEditor, headlessEditor } from "../helpers/editor";
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
});
