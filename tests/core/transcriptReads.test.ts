import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { Core, Document } from "../../src/core";
import { readVtt } from "../../src/core/documents/formats/vtt";
import type { WatchFolder, WatchListener } from "../../src/core/documents/watcher";
import { answerEnded } from "../helpers/citations";
import { createTempDataFolder } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { heldClock } from "../helpers/heldClock";
import { type ModelCall, scriptedModel } from "../helpers/models";
import { stoppedMeeting, transcribingCore, transcriptRead, until } from "../helpers/transcription";

const SECOND = 1000;
/** How long a recording call's Transcript goes between reads while it is short (docs/adr/0011). */
const FIRST_SPACING = 20 * SECOND;
const MINE = Array.from({ length: 60 }, (_, at) => `Line ${at + 1} said here.`);
const THEIRS = Array.from({ length: 60 }, (_, at) => `Line ${at + 1} said there.`);
const ADDED_BY_HAND = "\n00:00:30.000 --> 00:00:32.000\n<v Them>Added by hand afterwards.\n";

/** A watcher the test reports changes through, as the file system would, at once. */
function reportedChanges() {
  const listeners = new Map<string, WatchListener>();
  const watch: WatchFolder = (root, listener) => {
    listeners.set(root, listener);
    return {
      close: () => {
        if (listeners.get(root) === listener) listeners.delete(root);
      },
    };
  };
  return {
    watch,
    watched: (folder: string) => listeners.has(folder),
    /** Each watcher whose folder holds a path hears it changed. */
    report(...paths: string[]) {
      for (const path of paths) {
        for (const [root, listener] of listeners) {
          if (path.startsWith(`${root}${sep}`)) listener.onChange([path]);
        }
      }
    },
  };
}

async function documentOf(core: Core, documentId: string): Promise<Document> {
  const document = (await core.listDocuments()).find((each) => each.id === documentId);
  if (!document) throw new Error(`No Document ${documentId}.`);
  return document;
}

async function textOf(core: Core, documentId: string): Promise<string> {
  return (await core.readDocumentText(documentId)).pages.map((page) => page.text).join("\n");
}

/**
 * A core recording calls with the fake engine, its watcher's reports and the waits between a
 * Transcript's reads in the test's hands, and a Document added on its own: reported changed in
 * the same pass as a Transcript's file, it shows that pass has looked at the file.
 */
async function recordingCalls(dataDir?: string) {
  const data = dataDir ?? (await createTempDataFolder());
  const changes = reportedChanges();
  const clock = heldClock();
  const calls: ModelCall[] = [];
  const { core, record } = await transcribingCore(data, {
    model: scriptedModel((call) => {
      calls.push(call);
      return { text: "They said so." };
    }),
    engine: { lines: MINE, theirLines: THEIRS },
    linkedFolders: { watch: changes.watch },
    paceTimers: clock.timers,
  });
  const statuses: { id: string; status: Document["status"] }[] = [];
  core.on("document.status", (document) => {
    statuses.push({ id: document.id, status: document.status });
  });
  const barrierPath = await writeSourceFile(
    await createSourceFolder(),
    "Barrier.md",
    "# Barrier\n\n0\n",
  );
  const [barrier] = await addAndProcess(core, [barrierPath]);
  if (!barrier) throw new Error("The barrier Document wasn't added.");
  let barriers = 0;

  const vttOf = (meetingId: string) => join(data, "Transcripts", `${meetingId}.vtt`);
  const start = async () => {
    const meeting = await core.createMeeting({ folderId: null });
    await core.startMeeting({ meetingId: meeting.id, systemAudio: true });
    await until(core, meeting.id, (transcript) => transcript.state === "live");
    return meeting;
  };
  const ready = (documentId: string, read: (document: Document) => boolean) =>
    vi.waitFor(
      async () => {
        const document = await documentOf(core, documentId);
        if (document.status !== "ready" || !read(document)) {
          throw new Error(`Not read yet: ${document.status} ${document.contentHash}`);
        }
        return document;
      },
      { timeout: 10_000, interval: 20 },
    );

  return {
    core,
    record,
    clock,
    calls,
    changes,
    dataDir: data,
    transcripts: join(data, "Transcripts"),
    vttOf,
    start,
    /** Reports `paths` changed with the barrier's file, and waits until that pass has looked at them. */
    reported: async (...paths: string[]) => {
      const before = await documentOf(core, barrier.id);
      writeFileSync(barrierPath, `# Barrier\n\n${++barriers}\n`);
      changes.report(...paths, barrierPath);
      await vi.waitFor(
        async () => {
          const now = await documentOf(core, barrier.id);
          expect(now.status === "ready" && now.contentHash === before.contentHash).toBe(false);
        },
        { timeout: 10_000, interval: 20 },
      );
    },
    /** The call's Transcript Document as its first line made it, read. */
    firstRead: async (meetingId: string) => {
      const { documentId } = await until(core, meetingId, (each) => each.documentId !== null);
      return ready(documentId as string, () => true);
    },
    /** The Document read again: a version after `document`'s. */
    readAgain: (document: Document) =>
      ready(document.id, (now) => now.contentHash !== document.contentHash),
    /** How many times the Document has been read: each time it started being processed. */
    reads: (documentId: string) =>
      statuses.filter((each) => each.id === documentId && each.status === "extracting").length,
    /** A call recorded and stopped, its Transcript saved and read. */
    recorded: async () => {
      const meeting = await start();
      record(9 * SECOND);
      await until(core, meeting.id, (transcript) => transcript.lines >= 8);
      await stoppedMeeting(core, data, meeting.id);
      return meeting;
    },
  };
}

const lastLineOf = (path: string) => readVtt(readFileSync(path, "utf8")).cues.at(-1)?.text ?? "";

describe("A recording call's Transcript is read at its own spacing (#3055)", {
  timeout: 60_000,
}, () => {
  // protects=a recording call's Transcript is read at its first line and at the spacing the Transcripts module keeps, however its folder is watched, and whole at Stop; fails_when=a change the watcher reports to the recording file is read, so each line written is a read and a version kept; no_claim=the spacing past 20 s, which this doesn't change.
  test("with another call's Transcript kept, a change reported to the recording file is left to the call: read at its first line, 20 s on and at Stop", async () => {
    const calls = await recordingCalls();
    await calls.recorded();
    expect(calls.changes.watched(calls.transcripts)).toBe(true);

    const live = await calls.start();
    calls.record(3 * SECOND);
    const first = await calls.firstRead(live.id);
    calls.record(6 * SECOND);
    await until(calls.core, live.id, (transcript) => transcript.lines >= 6);
    await calls.reported(calls.vttOf(live.id));
    expect(await documentOf(calls.core, first.id)).toMatchObject({
      status: "ready",
      contentHash: first.contentHash,
    });

    calls.clock.advance(FIRST_SPACING);
    await calls.readAgain(first);
    expect(calls.reads(first.id)).toBe(2);
    await stoppedMeeting(calls.core, calls.dataDir, live.id);
  });

  test("a first call is read the same way, before its folder is watched and after", async () => {
    const calls = await recordingCalls();
    const live = await calls.start();
    calls.record(3 * SECOND);
    const first = await calls.firstRead(live.id);
    calls.record(3 * SECOND);
    await until(calls.core, live.id, (transcript) => transcript.lines >= 4);
    calls.clock.advance(FIRST_SPACING);
    const twenty = await calls.readAgain(first);
    expect(calls.changes.watched(calls.transcripts)).toBe(true);

    calls.record(6 * SECOND);
    await until(calls.core, live.id, (transcript) => transcript.lines >= 8);
    await calls.reported(calls.vttOf(live.id));
    expect(await documentOf(calls.core, first.id)).toMatchObject({
      status: "ready",
      contentHash: twenty.contentHash,
    });
    expect(calls.reads(first.id)).toBe(2);
    await stoppedMeeting(calls.core, calls.dataDir, live.id);
  });

  test("another call's Note deleted before this call, and brought back with Undo during it, changes nothing", async () => {
    const calls = await recordingCalls();
    const earlier = await calls.recorded();
    await calls.core.deleteMind(earlier.mindId);

    const live = await calls.start();
    calls.record(3 * SECOND);
    const first = await calls.firstRead(live.id);
    calls.record(4 * SECOND);
    await until(calls.core, live.id, (transcript) => transcript.lines >= 4);
    // A pass first, as any would, so the folder's watcher is as it is during the call.
    await calls.reported();
    await calls.reported(calls.vttOf(live.id));
    expect(await documentOf(calls.core, first.id)).toMatchObject({
      status: "ready",
      contentHash: first.contentHash,
    });

    await calls.core.restore([{ kind: "mind", id: earlier.mindId }]);
    calls.record(4 * SECOND);
    await until(calls.core, live.id, (transcript) => transcript.lines >= 8);
    await calls.reported(calls.vttOf(live.id));
    expect(await documentOf(calls.core, first.id)).toMatchObject({
      status: "ready",
      contentHash: first.contentHash,
    });

    calls.clock.advance(FIRST_SPACING);
    await calls.readAgain(first);
    expect(calls.reads(first.id)).toBe(2);
    await stoppedMeeting(calls.core, calls.dataDir, live.id);
  });

  test("a typed Question and a press for help read the call up to its last line", async () => {
    const calls = await recordingCalls();
    await calls.recorded();
    await calls.core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const live = await calls.start();
    calls.record(3 * SECOND);
    const { id: documentId } = await calls.firstRead(live.id);

    calls.record(6 * SECOND);
    await until(calls.core, live.id, (transcript) => transcript.lines >= 6);
    let newest = lastLineOf(calls.vttOf(live.id));
    let from = calls.calls.length;
    const asked = await calls.core.askInConversation({
      mindId: live.mindId,
      text: "What did they just say?",
    });
    if (!asked.asked) throw new Error("Not asked.");
    await answerEnded(calls.core, asked.answerId);
    expect(calls.calls.slice(from).some((call) => call.prompt.includes(newest))).toBe(true);
    expect(await textOf(calls.core, documentId)).toContain(newest);

    calls.record(6 * SECOND);
    await until(calls.core, live.id, (transcript) => transcript.lines >= 12);
    newest = lastLineOf(calls.vttOf(live.id));
    from = calls.calls.length;
    const pressed = await calls.core.askMeetingHelp({
      meetingId: live.id,
      kind: "say",
      conversationId: null,
    });
    if (!pressed.asked) throw new Error("Not pressed.");
    await answerEnded(calls.core, pressed.answerId);
    expect(calls.calls.slice(from).some((call) => call.prompt.includes(newest))).toBe(true);
    expect(await textOf(calls.core, documentId)).toContain(newest);
  });

  test("the call's own Note deleted during it stops it; brought back with Undo, its Transcript is read whole", async () => {
    const calls = await recordingCalls();
    const live = await calls.start();
    calls.record(3 * SECOND);
    const first = await calls.firstRead(live.id);
    calls.record(6 * SECOND);
    await until(calls.core, live.id, (transcript) => transcript.lines >= 6);

    await calls.core.deleteMind(live.mindId);
    await calls.core.restore([{ kind: "mind", id: live.mindId }]);
    const saved = await until(calls.core, live.id, (transcript) => transcript.state === "saved");
    expect(saved.documentId).toBe(first.id);
    await transcriptRead(calls.core, calls.dataDir, live.id, first.id);
    expect(await textOf(calls.core, first.id)).toContain(lastLineOf(calls.vttOf(live.id)));
  });

  test("a Transcript saved at Stop is read again when its file changes outside IncarnaMind", async () => {
    const calls = await recordingCalls();
    const meeting = await calls.recorded();
    const { documentId } = await until(calls.core, meeting.id, (each) => each.state === "saved");
    appendFileSync(calls.vttOf(meeting.id), ADDED_BY_HAND);
    calls.changes.report(calls.vttOf(meeting.id));
    await transcriptRead(calls.core, calls.dataDir, meeting.id, documentId as string);
    expect(await textOf(calls.core, documentId as string)).toContain("Added by hand afterwards.");
  });

  test("while a call records, another call's finished Transcript changed outside is read at once", async () => {
    const calls = await recordingCalls();
    const earlier = await calls.recorded();
    const { documentId } = await until(calls.core, earlier.id, (each) => each.state === "saved");
    const live = await calls.start();
    calls.record(3 * SECOND);
    await calls.firstRead(live.id);

    appendFileSync(calls.vttOf(earlier.id), ADDED_BY_HAND);
    calls.changes.report(calls.vttOf(earlier.id));
    await transcriptRead(calls.core, calls.dataDir, earlier.id, documentId as string);
    expect(await textOf(calls.core, documentId as string)).toContain("Added by hand afterwards.");
  });

  test("a Linked folder that holds the data folder leaves the recording file to the call too", async () => {
    const outer = await createSourceFolder();
    const dataDir = join(outer, "data");
    mkdirSync(dataDir);
    const calls = await recordingCalls(dataDir);
    await calls.core.addLinkedFolder(outer);
    await calls.core.reconcileDocuments();
    expect(calls.changes.watched(outer)).toBe(true);

    const live = await calls.start();
    calls.record(3 * SECOND);
    const first = await calls.firstRead(live.id);
    calls.record(6 * SECOND);
    await until(calls.core, live.id, (transcript) => transcript.lines >= 6);
    await calls.reported(calls.vttOf(live.id));
    expect(await documentOf(calls.core, first.id)).toMatchObject({
      status: "ready",
      contentHash: first.contentHash,
    });
  });

  test("a call IncarnaMind quit during is read as it was at the next start, and whole at its Stop", async () => {
    const dataDir = await createTempDataFolder();
    const before = await recordingCalls(dataDir);
    const live = await before.start();
    before.record(3 * SECOND);
    const { id: documentId } = await before.firstRead(live.id);
    before.record(6 * SECOND);
    await until(before.core, live.id, (transcript) => transcript.lines >= 6);
    before.core.close();

    // The call waits, paused, for the User; the next start reads what its file holds.
    const after = await recordingCalls(dataDir);
    await transcriptRead(after.core, dataDir, live.id, documentId);
    const { meeting } = await stoppedMeeting(after.core, dataDir, live.id);
    expect(meeting.status).toBe("stopped");
    expect(readVtt(readFileSync(after.vttOf(live.id), "utf8")).cues.length).toBeGreaterThanOrEqual(
      6,
    );
  });
});
