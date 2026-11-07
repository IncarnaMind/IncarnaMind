import { join, resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { type Core, DATABASE_FILE, type SearchScope } from "../../src/core";
import { openDatabase } from "../../src/core/storage";
import { type Migration, migrations } from "../../src/core/storage/migrations";
import { citationState } from "../../src/shared/citations";
import { askAndFinish, citationsIn, citingModel } from "../helpers/citations";
import { createTempDataFolder } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { classifierModel } from "../helpers/library";
import { connectToMind } from "../helpers/mindClient";
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
const EXAMPLES = resolve(__dirname, "../../resources/examples");

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
      wording: { key: "error.transcript.tagWithNote" },
    });
    await expect(core.addTagToDocuments([own.id, document.id], tag.id)).rejects.toMatchObject({
      wording: { key: "error.transcript.tagWithNote" },
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
    DROP TABLE meeting_join_transcripts;
    DROP TABLE meetings_left_apart;
    DROP INDEX documents_by_meeting_mind;
    ALTER TABLE documents DROP COLUMN meeting_mind_id;
    DELETE FROM schema_migrations WHERE version = ${ours.version};
  `);
  before(db);
  db.close();
}

describe("A database from before (#2528)", { timeout: 60_000 }, () => {
  test("joins a pair one wall lies between on its walled side, says so once, and Undo puts both back exactly", async () => {
    const { core, dataDir, meeting } = await recordedMeeting("en");
    const { document } = await stoppedMeeting(core, dataDir, meeting.id);
    const vault = await core.createLibraryGroup({ name: "Vault", description: "" });
    await core.updateLibraryGroup(vault.id, { name: "Vault", description: "", keepInside: true });
    const desk = await core.createLibraryGroup({ name: "Open desk", description: "" });
    await core.moveToFolder({ mindIds: [meeting.mindId], folderId: desk.id });
    const behind = await core.createMind({ title: "Harbour vault notes" });
    await core.moveToFolder({ mindIds: [behind.id], folderId: vault.id });
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
    const folderOf = async (mindId: string) =>
      (await again.listMinds()).find((mind) => mind.id === mindId)?.folderId;
    // The Note went in, behind the wall: nothing walled came out.
    expect(await folderOf(meeting.mindId)).toBe(vault.id);
    const joined = await again.listJoinedMeetings();
    expect(
      joined.map(({ mindId, folderId, noteMoved }) => ({ mindId, folderId, noteMoved })),
    ).toEqual([{ mindId: meeting.mindId, folderId: vault.id, noteMoved: true }]);
    expect(await filedTranscripts(again, document.id)).toEqual([]);
    expect((await again.listDocuments()).find((each) => each.id === document.id)).toMatchObject({
      meetingMindId: meeting.mindId,
      tags: [],
    });
    expect(await foundFrom(again, meeting.mindId)).toEqual([document.id]);
    expect(await foundFrom(again, behind.id)).toEqual([document.id]);
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

    // Undo: the Note goes back out, the Transcript stays behind the wall, a Document of its own
    // again with its Folder and Tag.
    await again.undoMeetingJoin(joined[0]?.id as string);
    expect(await folderOf(meeting.mindId)).toBe(desk.id);
    const apart = (await again.listDocuments()).find((each) => each.id === document.id);
    expect(apart?.meetingMindId).toBeNull();
    expect(apart?.tags.map((each) => each.tagId)).toEqual([tag.id]);
    expect((await filedTranscripts(again, document.id)).map((each) => each.groupId)).toEqual([
      vault.id,
    ]);
    expect(await foundFrom(again, behind.id)).toEqual([document.id]);
    expect(await foundFrom(again, meeting.mindId)).toEqual([]);
    expect(await foundFrom(again, outside.id)).toEqual([]);
    expect(await again.listJoinedMeetings()).toEqual([]);
    again.close();
  });

  test("takes a Transcript outside into its walled Note's Folder, and Undo puts it back outside", async () => {
    const { core, dataDir, meeting } = await recordedMeeting("en");
    const { document } = await stoppedMeeting(core, dataDir, meeting.id);
    const vault = await core.createLibraryGroup({ name: "Vault", description: "" });
    await core.updateLibraryGroup(vault.id, { name: "Vault", description: "", keepInside: true });
    const desk = await core.createLibraryGroup({ name: "Open desk", description: "" });
    await core.moveToFolder({ mindIds: [meeting.mindId], folderId: vault.id });
    const outside = await core.createMind({ title: "Ferry timetable" });
    core.close();
    asBefore(dataDir, (db) => {
      db.run(
        `INSERT INTO document_groups (id, document_id, group_id, source, status, request_id,
           created_at, updated_at)
         VALUES ('filed-alone', ?, ?, 'user', 'classified', 'request', ?, ?)`,
        [document.id, desk.id, document.createdAt, document.createdAt],
      );
    });

    const { core: again } = await transcribingCore(dataDir);
    expect((await again.listMinds()).find((mind) => mind.id === meeting.mindId)?.folderId).toBe(
      vault.id,
    );
    expect(
      (await again.listDocuments()).find((each) => each.id === document.id)?.meetingMindId,
    ).toBe(meeting.mindId);
    expect(await foundFrom(again, outside.id)).toEqual([]);
    const joined = await again.listJoinedMeetings();
    expect(
      joined.map(({ mindId, folderId, noteMoved }) => ({ mindId, folderId, noteMoved })),
    ).toEqual([{ mindId: meeting.mindId, folderId: vault.id, noteMoved: false }]);

    await again.undoMeetingJoin(joined[0]?.id as string);
    expect((await again.listMinds()).find((mind) => mind.id === meeting.mindId)?.folderId).toBe(
      vault.id,
    );
    expect((await filedTranscripts(again, document.id)).map((each) => each.groupId)).toEqual([
      desk.id,
    ]);
    expect(await foundFrom(again, outside.id)).toEqual([document.id]);
    again.close();
  });

  test("leaves a pair two walls lie between exactly where it is, each wall's Notes finding only their own, and says so once", async () => {
    const { core, dataDir, meeting } = await recordedMeeting("en");
    const { document } = await stoppedMeeting(core, dataDir, meeting.id);
    const vault = await core.createLibraryGroup({ name: "Vault", description: "" });
    await core.updateLibraryGroup(vault.id, { name: "Vault", description: "", keepInside: true });
    const cellar = await core.createLibraryGroup({ name: "Cellar", description: "" });
    await core.updateLibraryGroup(cellar.id, { name: "Cellar", description: "", keepInside: true });
    await core.moveToFolder({ mindIds: [meeting.mindId], folderId: cellar.id });
    const behind = await core.createMind({ title: "Harbour vault notes" });
    await core.moveToFolder({ mindIds: [behind.id], folderId: vault.id });
    const outside = await core.createMind({ title: "Ferry timetable" });
    const tag = await core.createTag({ name: "Calls" });
    core.close();
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
    const folderOf = async (mindId: string) =>
      (await again.listMinds()).find((mind) => mind.id === mindId)?.folderId;
    expect(await folderOf(meeting.mindId)).toBe(cellar.id);
    expect((await filedTranscripts(again, document.id)).map((each) => each.groupId)).toEqual([
      vault.id,
    ]);
    const transcript = (await again.listDocuments()).find((each) => each.id === document.id);
    expect(transcript?.meetingMindId).toBeNull();
    expect(transcript?.tags.map((each) => each.tagId)).toEqual([tag.id]);
    // Each wall's Notes still find only their own Documents.
    expect(await foundFrom(again, behind.id)).toEqual([document.id]);
    expect(await foundFrom(again, meeting.mindId)).toEqual([]);
    expect(await foundFrom(again, outside.id)).toEqual([]);
    expect(await again.listJoinedMeetings()).toEqual([]);

    const left = await again.listMeetingsLeftApart();
    expect(left.map((each) => each.mindId)).toEqual([meeting.mindId]);
    await again.meetingsLeftApartSaid(left.map((each) => each.id));
    again.close();

    // Said once: the next start says nothing.
    const { core: third } = await transcribingCore(dataDir);
    expect(await third.listMeetingsLeftApart()).toEqual([]);
    third.close();
  });

  test("joins a pair behind the same wall, its Transcript then where its Note is, and says nothing", async () => {
    const { core, dataDir, meeting } = await recordedMeeting("en");
    const { document } = await stoppedMeeting(core, dataDir, meeting.id);
    const vault = await core.createLibraryGroup({ name: "Vault", description: "" });
    await core.updateLibraryGroup(vault.id, { name: "Vault", description: "", keepInside: true });
    const minutes = await core.createLibraryGroup({
      name: "Minutes",
      description: "",
      parentId: vault.id,
    });
    await core.moveToFolder({ mindIds: [meeting.mindId], folderId: minutes.id });
    const outside = await core.createMind({ title: "Ferry timetable" });
    core.close();
    asBefore(dataDir, (db) => {
      db.run(
        `INSERT INTO document_groups (id, document_id, group_id, source, status, request_id,
           created_at, updated_at)
         VALUES ('filed-alone', ?, ?, 'user', 'classified', 'request', ?, ?)`,
        [document.id, vault.id, document.createdAt, document.createdAt],
      );
    });

    const { core: again } = await transcribingCore(dataDir);
    expect((await again.listMinds()).find((mind) => mind.id === meeting.mindId)?.folderId).toBe(
      minutes.id,
    );
    expect(
      (await again.listDocuments()).find((each) => each.id === document.id)?.meetingMindId,
    ).toBe(meeting.mindId);
    expect(await filedTranscripts(again, document.id)).toEqual([]);
    expect(await again.countScopeDocuments(folderScope(minutes.id))).toBe(1);
    expect(await foundFrom(again, meeting.mindId)).toEqual([document.id]);
    expect(await foundFrom(again, outside.id)).toEqual([]);
    expect(await again.listMeetingsLeftApart()).toEqual([]);
    again.close();
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

describe("Don't cite the Transcript", { timeout: 60_000 }, () => {
  test("keeps a meeting's Transcript out of an Answer's Citations and a check's evidence, while it is still read", async () => {
    const model = citingModel({
      query: "eighteenth of November",
      records: (passages) =>
        passages.map((passage, index) => ({
          marker: index + 1,
          passage: passage.id,
          quote: "The launch moves to the eighteenth of November",
        })),
      answer: "The launch moves to the eighteenth of November.[^1]",
    });
    const models = scriptedModels(model);
    const { core, dataDir, meeting } = await recordedMeeting("en", {}, models.createChatModel);
    const { document } = await stoppedMeeting(core, dataDir, meeting.id);
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const asker = await core.createMind({ title: "Launch plan" });
    const client = await connectToMind(core, asker.id);

    const before = await askAndFinish(core, client, asker.id, "When does the launch move to?");
    expect(citationsIn(client, before.answerId).map((each) => each.documentId)).toEqual([
      document.id,
    ]);

    await core.setNotCited(document.id, true);
    const after = await askAndFinish(core, client, asker.id, "When does the launch move to, now?");
    expect(citationsIn(client, after.answerId)).toEqual([]);
    expect(JSON.stringify(model.doStreamCalls.at(-1)?.prompt ?? [])).toContain('cite=\\"never\\"');
    const evidence = await core.searchEvidence("eighteenth of November");
    expect(evidence.passages).toEqual([]);
    expect(evidence.excluded).toMatchObject([{ documentId: document.id, reason: "own-workings" }]);
  });
});

describe("A first meeting beside the shipped examples", { timeout: 60_000 }, () => {
  test("makes the Library the User's own: its Note searches its words, never the examples", async () => {
    const dataDir = await createTempDataFolder();
    const { core, record } = await transcribingCore(dataDir, { examples: EXAMPLES });
    await core.createExamples();
    const { linkedFolderId } = await core.getExamples();
    await vi.waitFor(
      async () => {
        const read = await core.listDocuments({ linkedFolderId: linkedFolderId ?? "" });
        expect(read.length).toBeGreaterThan(0);
        expect(read.every((each) => each.status === "ready")).toBe(true);
      },
      { timeout: 30_000 },
    );
    const fromNote = async (mindId: string, words: string) =>
      core.searchPassages(words, {
        mode: "keyword",
        place: { kind: "turn", mindId, conversationId: null },
      });
    const asker = await core.createMind({ title: "Leverage" });
    expect((await fromNote(asker.id, "Net debt to EBITDA")).length).toBeGreaterThan(0);

    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id });
    record(9_000);
    await until(core, meeting.id, (transcript) => transcript.lines >= 4);
    const { document } = await stoppedMeeting(core, dataDir, meeting.id);

    expect(
      (await fromNote(meeting.mindId, "eighteenth of November")).map((each) => each.documentId),
    ).toEqual([document.id]);
    expect(await fromNote(meeting.mindId, "Net debt to EBITDA")).toEqual([]);
    expect(await fromNote(asker.id, "Net debt to EBITDA")).toEqual([]);
  });
});
