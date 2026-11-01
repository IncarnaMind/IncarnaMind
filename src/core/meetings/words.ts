/**
 * The words a Meeting's speech may hold (#1031), gathered when it is first transcribed, from what
 * IncarnaMind already holds, with nothing read again from a file and nothing sent anywhere: the
 * names in its Note's title and text, the User's Words to know (Settings › Meetings), its Folder's
 * name, and the names its Folder's Documents use most. The meeting's own come first: the
 * engine is told only as many as fit (../transcription/context).
 */
import { wordKey } from "../../shared/meetingWords";
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

export interface MeetingWordSources {
  db: Database;
  meetingId: string;
  /** Words to know, newest first. */
  userWords: readonly string[];
  /** The Note's in-app Folder's name, or null when it is in none. */
  folderName(folderId: string): string | null;
  /** The live Documents in that Folder. */
  folderDocuments(folderId: string): readonly string[];
}

export function meetingWords(sources: MeetingWordSources): string[] {
  const { db } = sources;
  const words: string[] = [];
  const seen = new Set<string>();
  const add = (word: string) => {
    const key = wordKey(word);
    if (word === "" || seen.has(key) || words.length >= MAX_WORDS) return;
    seen.add(key);
    words.push(word);
  };
  const addFound = (name: string) => {
    if (name.length <= MAX_NAME_LENGTH) add(name);
  };

  const note = db.get<{ mind_id: string; title: string; folder_id: string | null }>(
    `SELECT m.id AS mind_id, m.title, m.folder_id FROM meetings AS meeting
     JOIN minds AS m ON m.id = meeting.mind_id WHERE meeting.id = ?`,
    [sources.meetingId],
  );
  if (note) {
    const text = db
      .all<{ text: string }>(
        "SELECT text FROM mind_blocks WHERE mind_id = ? AND deleted_at IS NULL ORDER BY position",
        [note.mind_id],
      )
      .map((row) => row.text);
    for (const name of namesIn([note.title, ...text].join("\n")).keys()) addFound(name);
  }
  for (const word of sources.userWords) add(word);
  if (!note?.folder_id) return words;

  addFound(sources.folderName(note.folder_id)?.trim() ?? "");
  const ids = new Set(sources.folderDocuments(note.folder_id));
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
  for (const [name, count] of namesIn(texts.join("\n"))) {
    if (count >= DOCUMENT_MENTIONS) addFound(name);
  }
  return words;
}
