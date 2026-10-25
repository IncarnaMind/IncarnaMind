import { getSchema, type JSONContent } from "@tiptap/core";
import { updateYFragment } from "@tiptap/y-tiptap";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { ANSWER_BLOCK, MIND_SETTINGS_FIELD, QUESTION_BLOCK } from "../../src/core";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import {
  mindModelOf,
  modelInUse,
  observeMindModel,
  setMindModel,
} from "../../src/shared/mindModel";
import { createTempDataFolder, startCore } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { note, question, readMind, writeMind } from "../helpers/minds";

const CHOICE = { providerId: "provider-1", modelId: "claude-sonnet-5.5" };

/**
 * A Mind as Questions and Answers were stored before the composer: a Note, a
 * Question with a model, a Search scope and a forced Skill, its finished
 * Answer with a Citation and its Tool calls, and an Answer that was stopped.
 */
function writtenBefore(): JSONContent[] {
  const asked = question(
    "What did the tide tables say?",
    { providerId: "provider-gone", modelId: "an-older-model" },
    { folderIds: ["folder-1"], tagIds: ["tag-1"] },
  );
  asked.attrs = { ...asked.attrs, forcedSkill: "tide-tables" };
  const stopped = question("And in Calais?");
  const citation = {
    type: "citation",
    attrs: {
      marker: "1",
      documentId: "doc-1",
      documentName: "Tide tables",
      passageId: "p-1",
      location: { kind: "pages", from: 2, to: 2 },
      quote: "High water comes later each day.",
      check: "found",
      checkReason: null,
    },
  };
  return [
    note("Written before the composer."),
    asked,
    {
      type: ANSWER_BLOCK,
      attrs: {
        id: "answer-1",
        questionId: asked.attrs.id,
        providerId: "provider-gone",
        modelId: "an-older-model",
        status: "done",
        generatedHash: "abc",
        citationSupport: "tools",
        toolCalls: JSON.stringify([
          {
            id: "call-1",
            tool: "search_documents",
            source: "documents",
            input: { query: "tide tables" },
            status: "done",
            resultCount: 3,
          },
        ]),
      },
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "High water comes later each day." }, citation],
        },
      ],
    },
    stopped,
    {
      type: ANSWER_BLOCK,
      attrs: { id: "answer-2", questionId: stopped.attrs.id, status: "stopped" },
      content: [{ type: "paragraph", content: [{ type: "text", text: "In Calais it" }] }],
    },
    note(""),
  ];
}

describe("the model a Mind's Questions are asked with", () => {
  test("is stored with the Mind when chosen, and read back after a restart; its Blocks don't change", async () => {
    const dataDir = await createTempDataFolder();
    const firstRun = startCore(dataDir);
    const mind = await firstRun.createMind({ title: "Chosen model" });
    const writer = await connectToMind(firstRun, mind.id);
    writeMind(writer, [note("Notes.")]);
    const blocks = writer.blocks.toString();
    expect(mindModelOf(writer.doc)).toBeNull();
    setMindModel(writer.doc, CHOICE);
    await writer.settled();
    expect(writer.blocks.toString()).toBe(blocks);
    firstRun.close();

    const secondRun = startCore(dataDir);
    const reader = await connectToMind(secondRun, mind.id);
    expect(mindModelOf(reader.doc)).toEqual(CHOICE);
    expect(reader.blocks.toString()).toBe(blocks);
    // Another Mind has none: it follows the default for new Minds.
    const other = await secondRun.createMind({ title: "Default model" });
    expect(mindModelOf((await connectToMind(secondRun, other.id)).doc)).toBeNull();
  });

  test("changes in every window the Mind is open in, and can be forgotten", async () => {
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind();
    const here = await connectToMind(core, mind.id);
    const there = await connectToMind(core, mind.id);
    let heard = 0;
    const stop = observeMindModel(there.doc, () => {
      heard++;
    });
    setMindModel(here.doc, CHOICE);
    await here.settled();
    expect(mindModelOf(there.doc)).toEqual(CHOICE);
    // Choosing the same again changes nothing.
    const before = Y.encodeStateVector(here.doc);
    setMindModel(here.doc, { ...CHOICE });
    expect(Y.encodeStateVector(here.doc)).toEqual(before);
    setMindModel(here.doc, null);
    await here.settled();
    expect(mindModelOf(there.doc)).toBeNull();
    expect(heard).toBe(2);
    stop();
  });

  test("anything malformed counts as none", () => {
    const doc = new Y.Doc();
    const settings = doc.getMap(MIND_SETTINGS_FIELD);
    for (const value of ["claude", { providerId: "p" }, { providerId: "", modelId: "m" }, 3]) {
      settings.set("model", value);
      expect(mindModelOf(doc)).toBeNull();
    }
  });
});

describe("Minds written before the composer", () => {
  test("read the same: their Questions and Answers keep every attribute, and showing them writes nothing", async () => {
    const dataDir = await createTempDataFolder();
    const firstRun = startCore(dataDir);
    const mind = await firstRun.createMind({ title: "From before" });
    const writer = await connectToMind(firstRun, mind.id);
    writeMind(writer, writtenBefore());
    await writer.settled();
    const written = readMind(writer).toJSON();
    firstRun.close();

    // Opened again after a restart, with today's schema: every Block as it was written.
    const secondRun = startCore(dataDir);
    const reader = await connectToMind(secondRun, mind.id);
    const read = readMind(reader);
    expect(read.toJSON()).toEqual(written);
    expect(read.child(1).type.name).toBe(QUESTION_BLOCK);
    expect(read.child(1).attrs).toMatchObject({
      modelId: "an-older-model",
      scopeFolderIds: ["folder-1"],
      scopeTagIds: ["tag-1"],
      forcedSkill: "tide-tables",
    });
    expect(read.child(2).attrs).toMatchObject({ status: "done", citationSupport: "tools" });
    expect(read.child(4).attrs).toMatchObject({ status: "stopped" });

    // The editor's binding writes back what it shows: for these Blocks, nothing changes.
    const before = Y.encodeStateVector(reader.doc);
    const schema = getSchema(noteExtensions());
    reader.doc.transact(() =>
      updateYFragment(reader.doc, reader.blocks, schema.nodeFromJSON(read.toJSON()), {
        mapping: new Map(),
        isOMark: new Map(),
      }),
    );
    expect(Y.encodeStateVector(reader.doc)).toEqual(before);
    // And they have no model of their own: they follow the default for new Minds.
    expect(mindModelOf(reader.doc)).toBeNull();
  });
});

describe("the model in use", () => {
  const own = { providerId: "own", modelId: "own-model" };
  const last = { providerId: "last", modelId: "last-model" };
  const fallback = { providerId: "default", modelId: "default-model" };
  const all = () => true;

  test("is the Mind's own pick, else the last pick, else the Answers default", () => {
    expect(modelInUse({ own, last, fallback }, all)).toEqual(own);
    expect(modelInUse({ own: null, last, fallback }, all)).toEqual(last);
    expect(modelInUse({ own: null, last: null, fallback }, all)).toEqual(fallback);
    expect(modelInUse({ own: null, last: null, fallback: null }, all)).toBeNull();
  });

  test("skips a pick on a provider that is no longer saved, down the chain", () => {
    expect(modelInUse({ own, last, fallback }, (id) => id !== "own")).toEqual(last);
    expect(modelInUse({ own, last, fallback }, (id) => id === "default")).toEqual(fallback);
    expect(modelInUse({ own: null, last, fallback }, (id) => id !== "last")).toEqual(fallback);
  });
});
