import { describe, expect, test } from "vitest";
import type { ConversationAnswer, SearchScope } from "../../src/core";
import { migrations } from "../../src/core/storage/migrations";
import { folderScope } from "../../src/shared/searchScope";
import { askAssistant } from "../helpers/assistant";
import { recordSearches, setUpWithDocuments } from "../helpers/citations";
import { queryDatabase } from "../helpers/core";
import { type ModelCall, scriptedModel } from "../helpers/models";

const FILES = [
  { name: "Client A lease.txt", contents: "Termination notice: 90 days.\n" },
  { name: "General memo.txt", contents: "Termination notice: 60 days.\n" },
];

async function setUp({ wall = true } = {}) {
  const calls: ModelCall[] = [];
  const { answerSearch } = recordSearches();
  const model = scriptedModel((call) => {
    calls.push(call);
    return call.results.length === 0
      ? { calls: [{ tool: "search_documents", input: { query: "notice" } }] }
      : { text: "Previous turn token" };
  });
  const setup = await setUpWithDocuments(model, FILES, { answerSearch });
  const { core } = setup;
  const docA = setup.documents.find((each) => each.name.includes("Client A"));
  const docX = setup.documents.find((each) => each.name.includes("General"));
  if (!docA || !docX) throw new Error("The provenance fixture is missing a Document.");
  const folderA = await core.createLibraryGroup({ name: "Client A", description: "" });
  if (wall) {
    await core.updateLibraryGroup(folderA.id, {
      name: "Client A",
      description: "",
      keepInside: true,
    });
  }
  const folderX = await core.createLibraryGroup({ name: "General", description: "" });
  await core.assignDocumentGroup(docA.id, folderA.id);
  await core.assignDocumentGroup(docX.id, folderX.id);
  const noteA = await core.createMind({ title: "Client A note", folderId: folderA.id });
  const noteX = await core.createMind({ title: "General note", folderId: folderX.id });
  return { ...setup, calls, core, docA, docX, folderA, folderX, noteA, noteX, noteN: setup.mind };
}

type Setup = Awaited<ReturnType<typeof setUp>>;

/** What the migration that records each Question's Folder writes into an older row. */
const recording = migrations.find((each) => each.sql.includes("ADD COLUMN folder_asked_in"));
const BACKFILL = recording?.sql.slice(recording.sql.indexOf("UPDATE conversation_messages")) ?? "";
type Turn = { mindId: string | null; scope?: SearchScope | null };

describe("A Question's recorded Folder decides its wall", () => {
  const cases: {
    name: string;
    first: Turn;
    second: Turn;
    expected: boolean;
    change?: (setup: Setup, first: ConversationAnswer) => Promise<void>;
  }[] = [
    { name: "asked in walled A", first: { mindId: "a" }, second: { mindId: "a" }, expected: true },
    {
      name: "asked in A, wall turned on later",
      first: { mindId: "a" },
      second: { mindId: "a" },
      expected: true,
      change: async (s) => {
        await s.core.updateLibraryGroup(s.folderA.id, {
          name: "Client A",
          description: "",
          keepInside: true,
        });
      },
    },
    {
      name: "asked in A, wall turned off",
      first: { mindId: "a" },
      second: { mindId: "n" },
      expected: true,
      change: async (s) => {
        await s.core.updateLibraryGroup(s.folderA.id, {
          name: "Client A",
          description: "",
          keepInside: false,
        });
      },
    },
    {
      name: "asked in A, Note moved out",
      first: { mindId: "a" },
      second: { mindId: "n" },
      expected: false,
      change: async (s) => {
        await s.core.moveToFolder({ mindIds: [s.noteA.id], folderId: null });
      },
    },
    {
      name: "asked in A, Note deleted",
      first: { mindId: "a" },
      second: { mindId: "n" },
      expected: false,
      change: async (s) => {
        await s.core.deleteMind(s.noteA.id);
      },
    },
    { name: "asked in no Folder", first: { mindId: "n" }, second: { mindId: "n" }, expected: true },
    {
      name: "asked in no Folder, Note moved into a wall",
      first: { mindId: "n" },
      second: { mindId: "n" },
      expected: false,
      change: async (s) => {
        await s.core.moveToFolder({ mindIds: [s.noteN.id], folderId: s.folderA.id });
      },
    },
    {
      name: "no-Note Conversation in A",
      first: { mindId: null },
      second: { mindId: "a" },
      expected: true,
    },
    {
      name: "legacy row after the backfill",
      first: { mindId: "a" },
      second: { mindId: "a" },
      expected: true,
      change: async (s, first) => {
        const asked = [first.questionId];
        queryDatabase(
          s.dataDir,
          "UPDATE conversation_messages SET folder_asked_in = NULL WHERE id = ?",
          asked,
        );
        queryDatabase(s.dataDir, BACKFILL);
        expect(
          queryDatabase(
            s.dataDir,
            "SELECT folder_asked_in FROM conversation_messages WHERE id = ?",
            asked,
          ),
        ).toEqual([{ folder_asked_in: s.folderA.id }]);
      },
    },
  ];

  for (const row of cases) {
    test(row.name, async () => {
      const s = await setUp({ wall: row.name !== "asked in A, wall turned on later" });
      const firstScope =
        row.name === "no-Note Conversation in A" ? folderScope(s.folderA.id) : row.first.scope;
      const firstId =
        row.first.mindId === "a" ? s.noteA.id : row.first.mindId === "n" ? s.noteN.id : null;
      const secondId =
        row.second.mindId === "a" ? s.noteA.id : row.second.mindId === "n" ? s.noteN.id : null;
      const firstAnswer = await askAssistant(s.core, {
        text: "Start",
        mindId: firstId,
        ...(firstScope && { scope: firstScope }),
      });
      if (row.change) await row.change(s, firstAnswer);
      const from = s.calls.length;
      await askAssistant(s.core, {
        text: "Follow up",
        mindId: secondId,
        conversationId: firstAnswer.conversationId,
        ...(row.second.scope && { scope: row.second.scope }),
      });
      const carried = s.calls
        .slice(from)
        .some((call) => `${call.system}\n${call.prompt}`.includes("Previous turn token"));
      expect(carried).toBe(row.expected);
    });
  }
});
