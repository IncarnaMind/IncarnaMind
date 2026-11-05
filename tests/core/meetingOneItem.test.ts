import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { type Core, DATABASE_FILE, type SearchScope } from "../../src/core";
import { openDatabase } from "../../src/core/storage";
import { type Migration, migrations } from "../../src/core/storage/migrations";
import { citationState } from "../../src/shared/citations";
import { createTempDataFolder } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { classifierModel } from "../helpers/library";
import { scriptedModels } from "../helpers/models";
import { taggingModel, tagNamesOf, waitForTagging } from "../helpers/tags";
import {
  recordedMeeting,
  stoppedMeeting,
  transcribingCore,
  transcriptRead,
  until,
} from "../helpers/transcription";

/*
 * One meeting is one item (#2528): a Meeting's Transcript belongs to its Note. It has no Folder,
 * Tags or row of its own, and goes where the Note goes: into its Folder, behind its wall and to
 * Recently deleted, under the Note's one Undo.
 */

const NAMES = {
  en: { note: "Meeting, 6 October", transcript: "Transcript · Meeting, 6 October" },
  "zh-CN": { note: "会议，10月6日", transcript: "转写稿 · 会议，10月6日" },
} as const;

const WITHIN = "The launch moves to the eighteenth of November.";

const folderScope = (folderId: string): SearchScope => ({
  folderIds: [folderId],
  tagIds: [],
  documentIds: [],
});

/** The Documents a search for the meeting's words finds from this Note, as its Answer would. */
const foundFrom = async (core: Core, mindId: string) =>
  (
    await core.searchPassages("eighteenth of November", {
      mode: "keyword",
      place: { kind: "turn", mindId, conversationId: null },
    })
  ).map((passage) => passage.documentId);

const filedTranscripts = async (core: Core, documentId: string) =>
  (await core.getLibrary()).assignments.filter((each) => each.documentId === documentId);

for (const language of ["en", "zh-CN"] as const) {
  describe(`A meeting is one item (${language})`, { timeout: 60_000 }, () => {
    test("its Transcript belongs to its Note, and moves, files and walls with it, under one Undo", async () => {
      const { core, dataDir, meeting } = await recordedMeeting(language);
      const { document } = await stoppedMeeting(core, dataDir, meeting.id);
      expect(document.name).toBe(NAMES[language].transcript);
      expect(document.meetingMindId).toBe(meeting.mindId);
      // No Folder of its own: its Note's is its place.
      expect(await filedTranscripts(core, document.id)).toEqual([]);

      const harbour = await core.createLibraryGroup({ name: "Harbour works", description: "" });
      const outside = await core.createMind({ title: "Ferry timetable" });
      expect(await core.countScopeDocuments(folderScope(harbour.id))).toBe(0);

      // The Note moves into the Folder, and its Transcript with it.
      await core.moveToFolder({ mindIds: [meeting.mindId], folderId: harbour.id });
      expect(await core.countScopeDocuments(folderScope(harbour.id))).toBe(1);
      const inFolder = await core.searchPassages("eighteenth of November", {
        mode: "keyword",
        scope: folderScope(harbour.id),
      });
      expect(inFolder.map((passage) => passage.documentId)).toEqual([document.id]);
      expect(await filedTranscripts(core, document.id)).toEqual([]);

      // Walled, the Folder keeps the Transcript inside it, as it keeps its Note.
      await core.updateLibraryGroup(harbour.id, {
        name: "Harbour works",
        description: "",
        keepInside: true,
      });
      expect(await foundFrom(core, meeting.mindId)).toEqual([document.id]);
      expect(await foundFrom(core, outside.id)).toEqual([]);

      // Undo moves the Note back, its Transcript with it, out of the wall.
      await core.moveToFolder({ mindIds: [meeting.mindId], folderId: null });
      expect(await core.countScopeDocuments(folderScope(harbour.id))).toBe(0);
      expect(await foundFrom(core, outside.id)).toEqual([document.id]);
    });

    test("it is deleted and restored with its Note, as one item in Recently deleted, and never alone", async () => {
      const { core, dataDir, meeting } = await recordedMeeting(language);
      const { document } = await stoppedMeeting(core, dataDir, meeting.id);

      await expect(core.deleteDocuments([document.id])).rejects.toMatchObject({
        wording: { key: "error.transcript.withNote" },
      });
      await expect(core.deleteDocument(document.id)).rejects.toMatchObject({
        wording: { key: "error.transcript.withNote" },
      });
      expect((await core.listDocuments()).map((each) => each.id)).toContain(document.id);

      await core.deleteMind(meeting.mindId);
      expect(
        (await core.listDeleted()).map((item) => [item.kind, item.name, item.meeting]),
      ).toEqual([["mind", NAMES[language].note, { recording: true, transcript: true }]]);
      expect((await core.listDocuments()).map((each) => each.id)).not.toContain(document.id);

      await core.restore([{ kind: "mind", id: meeting.mindId }], { reopen: true });
      expect(await core.listDeleted()).toEqual([]);
      expect((await core.listDocuments()).find((each) => each.id === document.id)).toMatchObject({
        meetingMindId: meeting.mindId,
      });
    });
  });
}

describe("A meeting's Transcript is never filed alone", { timeout: 60_000 }, () => {
  test("a move, a drag's filing, Tags and Organize leave it with its Note; another Document files as before", async () => {
    const fake = classifierModel();
    const { core, dataDir, meeting } = await recordedMeeting("en", {}, () => fake.model);
    const { document } = await stoppedMeeting(core, dataDir, meeting.id);
    const [own] = await addAndProcess(core, [
      await writeSourceFile(await createTempDataFolder(), "tide-tables.txt", "High water at noon."),
    ]);
    if (!own) throw new Error("No Document added.");
    const harbour = await core.createLibraryGroup({ name: "Harbour works", description: "" });
    const tag = await core.createTag({ name: "Tides" });

    await expect(
      core.moveToFolder({ documentIds: [document.id], folderId: harbour.id }),
    ).rejects.toMatchObject({ wording: { key: "error.transcript.withNote" } });
    await expect(core.assignDocumentGroup(document.id, harbour.id)).rejects.toMatchObject({
      wording: { key: "error.transcript.withNote" },
    });
    await expect(core.addDocumentTag(document.id, tag.id)).rejects.toMatchObject({
      wording: { key: "error.transcript.withNote" },
    });
    await expect(core.addTagToDocuments([own.id, document.id], tag.id)).rejects.toMatchObject({
      wording: { key: "error.transcript.withNote" },
    });
    expect(await filedTranscripts(core, document.id)).toEqual([]);
    expect((await core.listDocuments()).find((each) => each.id === document.id)?.tags).toEqual([]);

    // Another Document moves and is tagged as ever.
    await core.moveToFolder({ documentIds: [own.id], folderId: harbour.id });
    await core.addDocumentTag(own.id, tag.id);
    expect((await filedTranscripts(core, own.id)).map((each) => each.groupId)).toEqual([
      harbour.id,
    ]);

    // Organize files the User's Documents and leaves the Transcript where its Note is.
    const loose = await addAndProcess(core, [
      await writeSourceFile(await createTempDataFolder(), "pier-survey.txt", "The pier survey."),
    ]);
    const provider = await core.saveChatProvider({ kind: "ollama", modelId: "main-model" });
    await core.saveLibrarySettings({
      classifier: { kind: "chat", choice: { providerId: provider.id, modelId: "small" } },
      automatic: true,
    });
    await core.classifyDocuments();
    await vi.waitFor(async () => {
      const filed = await filedTranscripts(core, loose[0]?.id ?? "");
      expect(filed.map((each) => each.groupId)).toEqual([harbour.id]);
    });
    await core.classifyDocuments([document.id]);
    expect(await filedTranscripts(core, document.id)).toEqual([]);
  });
});

describe("A meeting's Transcript has no Tags of its own", { timeout: 60_000 }, () => {
  test("automatic tagging tags the User's new Document and leaves the Transcript, read before it, untagged", async () => {
    const tagging = taggingModel(["Minutes"]);
    const models = scriptedModels(tagging.model);
    const { core, dataDir, meeting } = await recordedMeeting("en", {}, models.createChatModel);
    await core.createTag({ name: "Minutes", description: "Notes of a meeting." });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    await core.stopMeeting(meeting.id);
    const { documentId } = await until(core, meeting.id, (each) => each.state === "saved");
    const transcript = await transcriptRead(core, dataDir, meeting.id, documentId as string);

    const [own] = await addAndProcess(core, [
      await writeSourceFile(await createTempDataFolder(), "pier-minutes.txt", "Pier minutes."),
    ]);
    if (!own) throw new Error("No Document added.");
    await waitForTagging(core, [own.id]);

    expect(await tagNamesOf(core, own.id)).toEqual(["Minutes"]);
    expect(await tagNamesOf(core, transcript.id)).toEqual([]);
  });
});

describe("A search inside a Transcript", { timeout: 60_000 }, () => {
  test("finds the words with the time they were said, and its Citations still resolve", async () => {
    const { core, dataDir, meeting } = await recordedMeeting("en");
    const { document } = await stoppedMeeting(core, dataDir, meeting.id);

    const [match] = await core.searchDocumentText("eighteenth of November");
    expect(match).toMatchObject({ documentId: document.id, atMs: 1750 });
    const [later] = await core.searchDocumentText("partner preview");
    expect(later).toMatchObject({ documentId: document.id, atMs: 5750 });

    const citation = {
      documentId: document.id,
      contentHash: document.contentHash,
      location: { kind: "time" as const, from: 1750, to: 4000, speaker: "Me" },
      quote: WITHIN,
      check: "found" as const,
      checkReason: null,
    };
    expect(citationState(citation, await core.listDocuments()).check).toBe("found");
  });
});

const ours = migrations.find((each) => each.description.includes("(#2528)")) as Migration;

/**
 * Takes the data folder back to how the version before this one left it: this migration undone,
 * then `before` run on the database, as that version's own filings were.
 */
function asBefore(dataDir: string, before: (db: ReturnType<typeof openDatabase>) => void) {
  const db = openDatabase(join(dataDir, DATABASE_FILE));
  db.exec(`
    DROP TABLE meeting_joins;
    DROP INDEX documents_by_meeting_mind;
    ALTER TABLE documents DROP COLUMN meeting_mind_id;
    DELETE FROM schema_migrations WHERE version = ${ours.version};
  `);
  before(db);
  db.close();
}

describe("A database from before (#2528)", { timeout: 60_000 }, () => {
  test("joins its pair once: the Note goes behind its Transcript's wall, says so once, keeps its Citations, and Undo takes it back", async () => {
    const { core, dataDir, meeting } = await recordedMeeting("en");
    const { document } = await stoppedMeeting(core, dataDir, meeting.id);
    const vault = await core.createLibraryGroup({ name: "Vault", description: "" });
    await core.updateLibraryGroup(vault.id, { name: "Vault", description: "", keepInside: true });
    const desk = await core.createLibraryGroup({ name: "Open desk", description: "" });
    await core.moveToFolder({ mindIds: [meeting.mindId], folderId: desk.id });
    const outside = await core.createMind({ title: "Ferry timetable" });
    const tag = await core.createTag({ name: "Calls" });
    core.close();
    // The Transcript filed on its own behind the wall, and tagged, as a drag or Organize could.
    asBefore(dataDir, (db) => {
      db.run(
        `INSERT INTO document_groups (id, document_id, group_id, source, status, request_id,
           created_at, updated_at)
         VALUES ('filed-alone', ?, ?, 'user', 'classified', 'request', ?, ?)`,
        [document.id, vault.id, document.createdAt, document.createdAt],
      );
      db.run(
        `INSERT INTO document_tags (id, document_id, tag_id, source, created_at, updated_at)
         VALUES ('tagged-alone', ?, ?, 'user', ?, ?)`,
        [document.id, tag.id, document.createdAt, document.createdAt],
      );
    });

    const { core: again } = await transcribingCore(dataDir);
    expect((await again.listMinds()).find((mind) => mind.id === meeting.mindId)?.folderId).toBe(
      vault.id,
    );
    const joined = await again.listJoinedMeetings();
    expect(
      joined.map(({ mindId, folderId, fromFolderId }) => ({ mindId, folderId, fromFolderId })),
    ).toEqual([{ mindId: meeting.mindId, folderId: vault.id, fromFolderId: desk.id }]);
    expect(await filedTranscripts(again, document.id)).toEqual([]);
    const transcript = (await again.listDocuments()).find((each) => each.id === document.id);
    expect(transcript).toMatchObject({ meetingMindId: meeting.mindId, tags: [] });
    // Nothing walled came out: only the Note behind the wall finds the meeting's words.
    expect(await foundFrom(again, meeting.mindId)).toEqual([document.id]);
    expect(await foundFrom(again, outside.id)).toEqual([]);
    const citation = {
      documentId: document.id,
      contentHash: document.contentHash,
      location: { kind: "time" as const, from: 1750, to: 4000, speaker: "Me" },
      quote: WITHIN,
      check: "found" as const,
      checkReason: null,
    };
    expect(citationState(citation, await again.listDocuments()).check).toBe("found");

    // Said once: the sidebar marks it said, and it isn't listed again.
    await again.joinedMeetingsSaid(joined.map((each) => each.id));
    expect(await again.listJoinedMeetings()).toEqual([]);

    // Undo moves the Note back where it was, its Transcript with it.
    await again.moveToFolder({ mindIds: [meeting.mindId], folderId: desk.id });
    expect(await foundFrom(again, outside.id)).toEqual([document.id]);
    again.close();

    const { core: third } = await transcribingCore(dataDir);
    expect(await third.listJoinedMeetings()).toEqual([]);
    expect((await third.listMinds()).find((mind) => mind.id === meeting.mindId)?.folderId).toBe(
      desk.id,
    );
    third.close();
  });

  test("a Transcript left live beside its deleted Note goes to Recently deleted with it, as one item", async () => {
    const { core, dataDir, meeting } = await recordedMeeting("en");
    const { document } = await stoppedMeeting(core, dataDir, meeting.id);
    core.close();
    // Deleted before #1253, the Note went alone: its Meeting and Transcript stayed.
    asBefore(dataDir, (db) => {
      db.run("UPDATE minds SET deleted_at = ? WHERE id = ?", [
        "2026-10-06T09:00:30.000Z",
        meeting.mindId,
      ]);
    });

    const { core: again } = await transcribingCore(dataDir);
    expect((await again.listDocuments()).map((each) => each.id)).not.toContain(document.id);
    expect(
      (await again.listDeleted()).map((item) => [item.kind, item.id, item.meeting?.transcript]),
    ).toEqual([["mind", meeting.mindId, true]]);

    await again.restore([{ kind: "mind", id: meeting.mindId }], { reopen: true });
    expect((await again.listDocuments()).find((each) => each.id === document.id)).toMatchObject({
      meetingMindId: meeting.mindId,
    });
    expect(await foundFrom(again, meeting.mindId)).toEqual([document.id]);
  });
});
