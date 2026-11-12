/**
 * The words a Meeting's speech may hold (#1031), gathered when it is first transcribed, from what
 * IncarnaMind already holds, with nothing read again from a file: the User's name (Settings ›
 * General), the people on its calendar event and their companies (#190), the names in its Note's
 * title and text, the User's Words to know (Settings › Meetings), its Folder's name, and the names
 * its Folder's Documents use most. The User's and the meeting's own come first: the engine on this
 * computer is told only as many as fit (../transcription/context), and a cloud service only as
 * many as its own field takes (../transcription/cloud/words).
 *
 * They are two lists, cut at `MAX_WORDS`. `sent` is what a cloud service may be told; `here` stays
 * on this computer, for its engine and a line's spelling: each part's words, with the capitalised
 * words that are a name as often as an ordinary word (./names). During the call the Note is read
 * again when it changes (by the User or the assistant), for `here` alone: `sent` is kept as first
 * gathered until IncarnaMind quits, and gathered again for a Meeting recorded on after a reopen.
 */
import { wordKey } from "../../shared/meetingWords";
import type { CalendarAttendee } from "../api";
import { companiesOf } from "../calendars/events";
import type { Database } from "../storage";
import { namesIn } from "./names";

/** More than the engine takes: it keeps those that fit, in this order. */
const MAX_WORDS = 40;
/**
 * A name found longer than this is a heading or a sentence: told, it would take the room of
 * several names.
 */
const MAX_NAME_LENGTH = 40;
/** The Documents read, newest first, and the Passages of each from its start. */
const DOCUMENTS_READ = 20;
const PASSAGES_READ = 30;
/** A name the Documents use only once may be a passing mention. */
const DOCUMENT_MENTIONS = 2;

const LISTS = new Set(["bulletList", "orderedList", "taskList"]);

export interface MeetingWordSources {
  db: Database;
  meetingId: string;
  /** The User's name as they set it in Settings › General; null when they haven't. */
  userName?: string | null;
  /** Words to know, newest first. */
  userWords: readonly string[];
  /** The Note's in-app Folder's name, or null when it is in none. */
  folderName(folderId: string): string | null;
  /** The live Documents in that Folder. */
  folderDocuments(folderId: string): readonly string[];
  /** The people on the calendar event the Note was made for (#190); none for any other. */
  attendees?(mindId: string): readonly CalendarAttendee[];
}

/**
 * The words from one place. As first gathered, `here` holds those of `sent`, in the order this
 * computer is told them; read again, only `here` follows the Note.
 */
interface WordsFrom {
  from:
    | "userName"
    | "calendarEvent"
    | "note"
    | "wordsToKnow"
    | "folderName"
    | "folderDocuments"
    | "noteItems";
  sent: readonly string[];
  here: readonly string[];
}

export interface MeetingWords {
  /** What a cloud service is sent with the Meeting's audio, once the User allowed it the words. */
  readonly sent: readonly string[];
  /** What the transcriber on this computer is told, and what a line's names are spelled by. */
  readonly here: readonly string[];
  /** Both lists' words by where they come from, in the order they are told. */
  readonly parts: readonly WordsFrom[];
}

interface NoteRow {
  mind_id: string;
  title: string;
  folder_id: string | null;
}

const short = (names: Iterable<string>) =>
  [...names].filter((name) => name.length <= MAX_NAME_LENGTH);

const everywhere = (from: WordsFrom["from"], words: readonly string[]): WordsFrom => ({
  from,
  sent: words,
  here: words,
});

function listed(words: readonly string[]): string[] {
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const word of words) {
    if (kept.length >= MAX_WORDS) break;
    const key = wordKey(word);
    if (word === "" || seen.has(key)) continue;
    seen.add(key);
    kept.push(word);
  }
  return kept;
}

const noteOf = ({ db, meetingId }: MeetingWordSources) =>
  db.get<NoteRow>(
    `SELECT m.id AS mind_id, m.title, m.folder_id FROM meetings AS meeting
     JOIN minds AS m ON m.id = meeting.mind_id WHERE meeting.id = ?`,
    [meetingId],
  );

/** The names in the Note's title and text, and last the words kept here that open its items. */
function fromNote(db: Database, note: NoteRow | undefined): [WordsFrom, WordsFrom] {
  if (!note) return [everywhere("note", []), everywhere("noteItems", [])];
  const lines = db
    .all<{ kind: string; text: string }>(
      "SELECT kind, text FROM mind_blocks WHERE mind_id = ? AND deleted_at IS NULL ORDER BY position",
      [note.mind_id],
    )
    // A list's items come without their markers: they are written as a typed list's are.
    .map((block) => (LISTS.has(block.kind) ? block.text.replace(/^/gmu, "- ") : block.text));
  const found = namesIn([note.title, ...lines].join("\n"));
  const count = (name: string) =>
    (found.names.get(name) ?? 0) + (found.besideChinese.get(name) ?? 0);
  const here = [...new Set([...found.names.keys(), ...found.besideChinese.keys()])].sort(
    (a, b) => count(b) - count(a),
  );
  return [
    { from: "note", sent: short(found.names.keys()), here: short(here) },
    { from: "noteItems", sent: [], here: short(found.itemOpeners.keys()) },
  ];
}

/** The names the Folder's Documents use at least twice, newest Documents first. */
function fromDocuments(sources: MeetingWordSources, folderId: string): WordsFrom {
  const { db } = sources;
  const ids = new Set(sources.folderDocuments(folderId));
  // A Transcript holds the names as the engine heard them, wrong ones too.
  const newest = db
    .all<{ id: string }>(
      `SELECT id FROM documents WHERE deleted_at IS NULL AND kind != 'transcript'
       ORDER BY created_at DESC`,
    )
    .filter((row) => ids.has(row.id))
    .slice(0, DOCUMENTS_READ);
  const texts = newest.flatMap((row) =>
    db
      .all<{ text: string }>(
        `SELECT text FROM passages WHERE document_id = ? AND deleted_at IS NULL
         ORDER BY position LIMIT ?`,
        [row.id, PASSAGES_READ],
      )
      .map((passage) => passage.text),
  );
  const found = namesIn(texts.join("\n"));
  const used = (counts: Iterable<[string, number]>) =>
    short([...counts].filter(([, count]) => count >= DOCUMENT_MENTIONS).map(([name]) => name));
  const all = new Map(found.names);
  for (const [name, count] of found.besideChinese) all.set(name, (all.get(name) ?? 0) + count);
  return { from: "folderDocuments", sent: used(found.names), here: used(all) };
}

/**
 * The Meeting's words. Every word a cloud service may be sent is in a `sent` below, and nowhere
 * else. Given the words `first` gathered, only the Note is read again, for `here`: each `sent`
 * stays as `first` has it.
 */
export function meetingWords(sources: MeetingWordSources, first?: MeetingWords): MeetingWords {
  const note = noteOf(sources);
  const [noteNames, noteItems] = fromNote(sources.db, note);
  if (first) {
    const readAgain = new Map([noteNames, noteItems].map((part) => [part.from, part.here]));
    const parts = first.parts.map((part) => ({
      ...part,
      here: readAgain.get(part.from) ?? part.here,
    }));
    return { sent: first.sent, here: listed(parts.flatMap((part) => part.here)), parts };
  }
  const others = note
    ? (sources.attendees?.(note.mind_id) ?? []).filter((person) => !person.self)
    : [];
  const people = others.map((person) => person.name).filter((name) => !name.includes("@"));
  const folderId = note?.folder_id ?? null;
  const parts: WordsFrom[] = [
    everywhere("userName", [sources.userName?.trim() ?? ""]),
    everywhere("calendarEvent", short([...people, ...companiesOf(others)])),
    noteNames,
    everywhere("wordsToKnow", sources.userWords),
    everywhere("folderName", folderId ? short([sources.folderName(folderId)?.trim() ?? ""]) : []),
    folderId ? fromDocuments(sources, folderId) : everywhere("folderDocuments", []),
    noteItems,
  ];
  return {
    sent: listed(parts.flatMap((part) => part.sent)),
    here: listed(parts.flatMap((part) => part.here)),
    parts,
  };
}
