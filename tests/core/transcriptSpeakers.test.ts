/**
 * Who's who in a Meeting's Transcript (#138), through the core's public interface as the
 * Transcript's speaker menu uses it: the names the User gives and the lines they move are kept
 * apart from the file, so a Citation of a line shows the name as it is now, in a Note that isn't
 * open too, while the file, its version and every check stay as they were.
 */
import { readFileSync } from "node:fs";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test, vi } from "vitest";
import type { Core, Document, TranscriptSpeakers } from "../../src/core";
import { cleanQuote } from "../../src/core/answers/citations";
import { type Cue, readVtt } from "../../src/core/documents/formats/vtt";
import { clockTime } from "../../src/shared/clock";
import {
  SPEAKER_ME,
  type SpeakerChoice,
  type TranscriptLine,
  withSpeakerChosen,
} from "../../src/shared/speakers";
import {
  askAndFinish,
  citingModel,
  mindCitations,
  onlyCitation,
  type ShownPassage,
} from "../helpers/citations";
import { createTempDataFolder } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { writeMind } from "../helpers/minds";
import {
  fakeSeparator,
  recordedCall,
  savedCues,
  toldCues,
  transcriptRead,
  until,
} from "../helpers/transcription";

const linesOf = (cues: readonly Cue[]): TranscriptLine[] =>
  cues.flatMap((cue) => (cue.speaker ? [{ startMs: cue.startMs, label: cue.speaker }] : []));

const lineBy = (cues: readonly Cue[], label: string, nth = 0): Cue => {
  const cue = cues.filter((each) => each.speaker === label)[nth];
  if (!cue) throw new Error(`No line ${nth} by ${label}.`);
  return cue;
};

/** The file's line that `told`, the same lines by who spoke them now, gives to `speaker`. */
const lineToldBy = (cues: readonly Cue[], told: readonly Cue[], speaker: string, nth = 0): Cue => {
  const at = told.indexOf(lineBy(told, speaker, nth));
  const cue = cues[at];
  if (!cue) throw new Error(`No line ${nth} told as ${speaker}.`);
  return cue;
};

async function transcriptOf(core: Core, meetingId: string): Promise<Document> {
  const meeting = (await core.listMeetings()).find((each) => each.id === meetingId);
  const document = (await core.listDocuments()).find(
    (each) => each.id === meeting?.transcript?.documentId,
  );
  if (!document) throw new Error("No Transcript.");
  return document;
}

/** Says who speaks `line`, as the speaker menu does: the whole who's who, set again. */
async function choose(
  core: Core,
  documentId: string,
  cues: readonly Cue[],
  line: Cue,
  choice: SpeakerChoice,
  all = false,
): Promise<Document> {
  const now = (await core.listDocuments()).find((each) => each.id === documentId);
  const speakers = withSpeakerChosen(
    now?.speakers ?? null,
    linesOf(cues),
    { startMs: line.startMs, label: line.speaker as string },
    choice,
    all,
  );
  return core.setTranscriptSpeakers({ documentId, speakers });
}

const citationOf = (document: Document, cue: Cue): JSONContent => ({
  type: "citation",
  attrs: {
    passageId: "passage-1",
    documentId: document.id,
    documentName: document.name,
    contentHash: document.contentHash,
    location: { kind: "time", from: cue.startMs, to: cue.endMs, speaker: cue.speaker },
    quote: cue.text,
    check: "found",
  },
});

const exported = async (core: Core, mindId: string) =>
  new TextDecoder().decode((await core.exportMind(mindId, { format: "markdown" })).data);

describe("Who's who in a Transcript (#138)", { timeout: 60_000 }, () => {
  // protects=a Speaker named, and a line given to a new Speaker, show in a Citation of a Note that isn't open, in another Folder, by the name as it is now, through Undo; the Transcript's file, its version and the Note's stored labels never change; fails_when=the export keeps the old label, a rename of the new Speaker misses the moved line, Undo leaves a name, the file is rewritten, a new version is made or a Citation stores a name; no_claim=the window's own labels, which the renderer tests and the window spec cover.
  test("a name shows in every Citation of the line, in a Note that isn't open, and the file and its version stay", async () => {
    const { core, meeting } = await recordedCall(await createTempDataFolder(), {
      speakerSeparator: fakeSeparator().separator,
    });
    const told = await toldCues(core, meeting.id);
    const cues = await savedCues(core, meeting.id);
    const transcript = await transcriptOf(core, meeting.id);
    const file = readFileSync(transcript.path);
    const passed = transcript.speakers as TranscriptSpeakers;
    const first = lineToldBy(cues, told, "Speaker 1");
    const second = lineToldBy(cues, told, "Speaker 2");

    const folder = await core.createLibraryGroup({ name: "Clients", description: "" });
    const mind = await core.createMind({ title: "Follow-up" });
    await core.moveToFolder({ mindIds: [mind.id], folderId: folder.id });
    const client = await connectToMind(core, mind.id);
    writeMind(client, [
      {
        type: "paragraph",
        content: [{ type: "text", text: "Budget " }, citationOf(transcript, first)],
      },
      {
        type: "paragraph",
        content: [{ type: "text", text: "Review " }, citationOf(transcript, second)],
      },
    ]);
    await client.settled();
    await core.closeMind(mind.id);
    const at = (cue: Cue, name: string) => `${name} · ${clockTime(cue.startMs)}`;
    expect(await exported(core, mind.id)).toContain(at(first, "Speaker 1"));

    await choose(core, transcript.id, cues, first, { name: "Dana Whitfield" }, true);
    await choose(core, transcript.id, cues, second, { name: "Priya" });
    const named = await transcriptOf(core, meeting.id);
    expect(named.speakers).toEqual({
      labels: { "Speaker 1": "Dana Whitfield", "Speaker 3": "Priya" },
      lines: { ...passed.lines, [`${second.startMs} Them`]: "Speaker 3" },
    });
    let text = await exported(core, mind.id);
    expect(text).toContain(at(first, "Dana Whitfield"));
    expect(text).toContain(at(second, "Priya"));
    expect(text).not.toContain(at(first, "Speaker 1"));

    // Naming the new Speaker again, every line by them, the moved line among them, follows.
    await choose(core, transcript.id, cues, second, { name: "Priya Shah" }, true);
    expect(await exported(core, mind.id)).toContain(at(second, "Priya Shah"));

    // Undo sets the whole who's who back, to the voices the pass found.
    const undone = await core.setTranscriptSpeakers({
      documentId: transcript.id,
      speakers: named.speakers as TranscriptSpeakers,
    });
    expect(undone.speakers).toEqual(named.speakers);
    await core.setTranscriptSpeakers({ documentId: transcript.id, speakers: passed });
    text = await exported(core, mind.id);
    expect(text).toContain(at(first, "Speaker 1"));
    expect(text).toContain(at(second, "Speaker 2"));
    expect((await transcriptOf(core, meeting.id)).speakers).toEqual(passed);

    // Nothing else changed: the file, its version, and the labels the Note's Citations keep.
    const after = await transcriptOf(core, meeting.id);
    expect(readFileSync(after.path)).toEqual(file);
    expect(after.contentHash).toBe(transcript.contentHash);
    const reopened = await connectToMind(core, mind.id);
    expect(mindCitations(reopened).map((each) => each.location)).toEqual([
      { kind: "time", from: first.startMs, to: first.endMs, speaker: "Them" },
      { kind: "time", from: second.startMs, to: second.endMs, speaker: "Them" },
    ]);
    core.close();
  });

  // protects="Me" is the User: it is never named, by the menu or the core, while lines still go to and from Me; fails_when=a name for Me is kept, or a line can't be given to Me or taken from Me; no_claim=the fill's wording of the User, which the real-model check covers.
  test('"Me" is never named, while lines go to and from Me', async () => {
    const { core, meeting } = await recordedCall(await createTempDataFolder(), {
      speakerSeparator: fakeSeparator().separator,
    });
    const told = await toldCues(core, meeting.id);
    const cues = await savedCues(core, meeting.id);
    const transcript = await transcriptOf(core, meeting.id);
    await expect(
      core.setTranscriptSpeakers({
        documentId: transcript.id,
        speakers: { labels: { [SPEAKER_ME]: "Joey" }, lines: {} },
      }),
    ).rejects.toMatchObject({ wording: { key: "error.transcript.speakersUnheld" } });

    const mine = lineBy(cues, SPEAKER_ME);
    const theirs = lineToldBy(cues, told, "Speaker 1");
    // A new name for every line by Me moves them to a new Speaker: Me keeps its name.
    const moved = await choose(core, transcript.id, cues, mine, { name: "Sam" }, true);
    expect(moved.speakers?.labels).toEqual({ "Speaker 3": "Sam" });
    expect(moved.speakers?.lines[`${mine.startMs} Me`]).toBe("Speaker 3");
    const back = await choose(core, transcript.id, cues, theirs, { label: SPEAKER_ME });
    expect(back.speakers?.lines[`${theirs.startMs} Them`]).toBe(SPEAKER_ME);
    core.close();
  });

  // protects=a model reads each line by its Speaker's name and the User's as "Me"; its "0:12 Dana" is matched against those names and stored as the quoted line's own label, when two Speakers share the name too, and a name the line isn't by finds nothing; fails_when=the model reads a label for a named Speaker, a Citation stores a name or another Speaker's label, or a wrong name is found; no_claim=a real model's wording, which the real-model check covers.
  test('a model reads the names and "Me", and its "0:12 Dana" stores the quoted line\'s own label', async () => {
    let shown: ShownPassage[] = [];
    let cite: { location: string; quote: string } = { location: "", quote: "" };
    const plan = {
      query: "",
      records: (passages: ShownPassage[]) => {
        shown = passages;
        const passage = passages.find((each) => each.text.includes(cite.quote));
        return [{ marker: 1, passage: passage?.id, location: cite.location, quote: cite.quote }];
      },
      answer: "They said so [^1].",
    };
    const model = citingModel(plan);
    const dataDir = await createTempDataFolder();
    const { core, meeting } = await recordedCall(dataDir, {
      speakerSeparator: fakeSeparator().separator,
      model,
    });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const told = await toldCues(core, meeting.id);
    const cues = await savedCues(core, meeting.id);
    const transcript = await transcriptRead(
      core,
      dataDir,
      meeting.id,
      (await transcriptOf(core, meeting.id)).id,
    );
    const first = lineToldBy(cues, told, "Speaker 1");
    const second = lineToldBy(cues, told, "Speaker 2");
    // Two people of one name, as a call can have.
    await choose(core, transcript.id, cues, first, { name: "Dana" }, true);
    await choose(core, transcript.id, cues, second, { name: "Dana" }, true);

    const mind = await core.createMind({ title: "Who said it" });
    const client = await connectToMind(core, mind.id);
    plan.query = second.text;
    cite = { location: `${clockTime(second.startMs)} Dana`, quote: second.text };
    const asked = await askAndFinish(core, client, mind.id, "What did they say?");
    const marks = shown.map((passage) => passage.text).join("\n");
    expect(marks).toContain(`[${clockTime(second.startMs)} Dana] ${second.text}`);
    expect(marks).toContain(`[${clockTime(lineBy(cues, SPEAKER_ME).startMs)} Me]`);
    expect(marks).not.toMatch(/\[\d+:\d{2} Speaker [12]\]/);
    expect(onlyCitation(client, asked.answerId)).toMatchObject({
      location: { kind: "time", from: second.startMs, speaker: "Them" },
      check: "found",
    });

    cite = { location: `${clockTime(second.startMs)} Priya`, quote: second.text };
    const wrong = await askAndFinish(core, client, mind.id, "And what did Priya say then?");
    expect(onlyCitation(client, wrong.answerId).check).not.toBe("found");

    // A name with a digit first, brackets or Chinese punctuation is read and cited as any other:
    // the model reads it in its mark, brackets made spaces, and writes it back so.
    for (const name of ["3M rep", "(Client) Dana", "Dana [CFO]", "王总（客户）"]) {
      await choose(core, transcript.id, cues, second, { name }, true);
      const mark = name.replace(/[[\]]/g, " ").replace(/\s+/g, " ").trim();
      cite = { location: `${clockTime(second.startMs)} ${mark}`, quote: second.text };
      const named = await askAndFinish(core, client, mind.id, `What did ${name} say?`);
      expect(shown.map((passage) => passage.text).join("\n")).toContain(
        `[${clockTime(second.startMs)} ${mark}] ${second.text}`,
      );
      expect(onlyCitation(client, named.answerId)).toMatchObject({
        location: { kind: "time", from: second.startMs, speaker: "Them" },
        check: "found",
      });
    }
    core.close();
  });

  // protects=an Answer asked while a call's speakers are told apart, whose records are still out when the pass gives the line another Speaker, is checked against who's who as its model read it: its "0:00 Them" is found, stores the line's own label and shows the new Speaker (#2839); fails_when=the record is checked against who's who changed while it was out and isn't found; no_claim=a real model's wording.
  test("an Answer whose records are out when the pass renames their line finds them", async () => {
    let release = () => {};
    const holds = new Promise<void>((resolve) => {
      release = resolve;
    });
    let answer = () => {};
    const recordsHeld = new Promise<void>((resolve) => {
      answer = resolve;
    });
    let recorded = false;
    let cite = { location: "", quote: "" };
    const plan = {
      query: "",
      records: (passages: ShownPassage[]) => {
        recorded = true;
        const passage = passages.find((each) => each.text.includes(cite.quote));
        return [{ marker: 1, passage: passage?.id, location: cite.location, quote: cite.quote }];
      },
      answer: "They said so [^1].",
      recordsHeld,
    };
    const { separator } = fakeSeparator({ holds });
    const dataDir = await createTempDataFolder();
    const { core, meeting } = await recordedCall(dataDir, {
      speakerSeparator: separator,
      model: citingModel(plan),
    });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const cues = await (async () => {
      const saved = await until(
        core,
        meeting.id,
        (transcript) => transcript.state === "saved" && transcript.separating,
      );
      return readVtt(readFileSync(saved.savedPath as string, "utf8")).cues;
    })();
    await transcriptRead(core, dataDir, meeting.id, (await transcriptOf(core, meeting.id)).id);
    const line = lineBy(cues, "Them");
    const mind = await core.createMind({ title: "Who said it" });
    const client = await connectToMind(core, mind.id);
    plan.query = line.text;
    cite = { location: `${clockTime(line.startMs)} Them`, quote: line.text };
    const asked = askAndFinish(core, client, mind.id, "What did they say?");
    await vi.waitFor(() => expect(recorded).toBe(true));
    release();
    const told = await toldCues(core, meeting.id);
    const now = told[cues.indexOf(line)]?.speaker;
    expect(now).toMatch(/^Speaker \d$/);
    answer();
    const { answerId } = await asked;
    expect(onlyCitation(client, answerId)).toMatchObject({
      location: { kind: "time", from: line.startMs, speaker: "Them" },
      check: "found",
    });
    core.close();
  });

  // protects=a quote the model copies with the longest mark a name can make loses the whole mark; fails_when=the mark's end stays in the quote, so the quote isn't found; no_claim=marks of other Units.
  test("a quote copied with the longest name's mark loses the mark", () => {
    const longest = "Dana Whitfield of the Northwind Retail credit and treasury g";
    expect(longest).toHaveLength(60);
    expect(cleanQuote(`[0:09 ${longest}] The budget is approved for this year.`)).toBe(
      "The budget is approved for this year.",
    );
  });

  // protects=the words of a label ("Me", "我", "Them", "Speaker 2", "发言人 3") are never another Speaker's name, so a model never reads someone else's line as the User's; a name with a format character can't pass as another; fails_when=the core keeps such a name; no_claim=the menu, where typing a label's words picks that Speaker (the window spec).
  test("a label's words, or a hidden character, are refused as a name, with the reason", async () => {
    const { core, meeting } = await recordedCall(await createTempDataFolder(), {
      speakerSeparator: fakeSeparator().separator,
    });
    await savedCues(core, meeting.id);
    const transcript = await transcriptOf(core, meeting.id);
    const passed = transcript.speakers;
    for (const name of ["Me", "我", "Them", "对方", "Speaker 3", "发言人 3", "发言人？"]) {
      await expect(
        core.setTranscriptSpeakers({
          documentId: transcript.id,
          speakers: { labels: { "Speaker 2": name }, lines: {} },
        }),
      ).rejects.toMatchObject({
        wording: { key: "error.transcript.speakerNameIsLabel", values: { name } },
      });
    }
    for (const name of ["Dana\u202Eevil", "Da\u200Bna", "x".repeat(61)]) {
      await expect(
        core.setTranscriptSpeakers({
          documentId: transcript.id,
          speakers: { labels: { "Speaker 2": name }, lines: {} },
        }),
      ).rejects.toMatchObject({ wording: { key: "error.transcript.speakersUnheld" } });
    }
    expect((await transcriptOf(core, meeting.id)).speakers).toEqual(passed);
    core.close();
  });

  // protects=with one voice on the other side ("Them"), with the speaker models missing ("Me" and "Them" kept, a problem said), and in a room no pass told apart ("Speaker ?"), the source labels are named and moved as any Speaker; fails_when=naming refuses a source label, or a line moved from "Speaker ?" takes a label the file already has; no_claim=the pass itself, which tests/core/speakerPass.test.ts covers.
  test('one voice, missing speaker models and a room\'s "Speaker ?" are named the same way', async () => {
    const one = await recordedCall(await createTempDataFolder(), {
      speakerSeparator: fakeSeparator({ voiceOf: () => 0 }).separator,
    });
    const oneCues = await savedCues(one.core, one.meeting.id);
    expect(new Set(oneCues.map((cue) => cue.speaker))).toEqual(new Set(["Me", "Them"]));
    const oneDocument = await transcriptOf(one.core, one.meeting.id);
    const named = await choose(
      one.core,
      oneDocument.id,
      oneCues,
      lineBy(oneCues, "Them"),
      { name: "Dana" },
      true,
    );
    expect(named.speakers?.labels).toEqual({ Them: "Dana" });
    one.core.close();

    const missing = await recordedCall(await createTempDataFolder(), {
      speakerSeparator: fakeSeparator().separator,
      speakerModelSource: {
        segmentation: {
          baseUrl: "http://127.0.0.1:9/",
          files: [{ path: "model.int8.onnx", size: 10, sha256: "0".repeat(64) }],
        },
        embedding: { baseUrl: "http://127.0.0.1:9/", files: [] },
      },
    });
    const missingCues = await savedCues(missing.core, missing.meeting.id);
    expect(new Set(missingCues.map((cue) => cue.speaker))).toEqual(new Set(["Me", "Them"]));
    expect(
      (await missing.core.listMeetings()).find((each) => each.id === missing.meeting.id)?.transcript
        ?.problem?.kind,
    ).toBe("speakers");
    const missingDocument = await transcriptOf(missing.core, missing.meeting.id);
    const them = await choose(
      missing.core,
      missingDocument.id,
      missingCues,
      lineBy(missingCues, "Them", 1),
      { name: "Priya" },
    );
    expect(them.speakers).toEqual({
      labels: { "Speaker 1": "Priya" },
      lines: { [`${lineBy(missingCues, "Them", 1).startMs} Them`]: "Speaker 1" },
    });
    missing.core.close();

    const room = await recordedCall(
      await createTempDataFolder(),
      { capture: { system: "denied" } },
      ["microphone"],
    );
    const roomCues = await savedCues(room.core, room.meeting.id);
    expect(new Set(roomCues.map((cue) => cue.speaker))).toEqual(new Set(["Speaker ?"]));
    const roomDocument = await transcriptOf(room.core, room.meeting.id);
    const everyone = await choose(
      room.core,
      roomDocument.id,
      roomCues,
      lineBy(roomCues, "Speaker ?"),
      { name: "Lin" },
      true,
    );
    expect(everyone.speakers?.labels).toEqual({ "Speaker ?": "Lin" });
    room.core.close();
  });

  // protects=a pass run again after it failed leaves a Transcript the User has named as it is, so the names and moved lines keep hanging on the labels they were given for; fails_when=Try again relabels a named Transcript; no_claim=a pass on a Transcript nobody named, which tests/core/speakerPass.test.ts covers.
  test("Try again after a failed pass leaves a named Transcript's labels", async () => {
    const working = fakeSeparator();
    let failed = 0;
    const { core, meeting } = await recordedCall(await createTempDataFolder(), {
      speakerSeparator: {
        separate: (request) =>
          failed++ === 0
            ? Promise.reject(new Error("The speaker process stopped."))
            : working.separator.separate(request),
      },
    });
    const cues = await savedCues(core, meeting.id);
    const transcript = await transcriptOf(core, meeting.id);
    await choose(core, transcript.id, cues, lineBy(cues, "Them"), { name: "Dana" }, true);
    await core.retryTranscript(meeting.id);
    const after = await savedCues(core, meeting.id);
    expect(after.map((cue) => cue.speaker)).toEqual(cues.map((cue) => cue.speaker));
    expect(working.requests).toHaveLength(0);
    expect((await transcriptOf(core, meeting.id)).speakers?.labels).toEqual({ Them: "Dana" });
    core.close();
  });
});
