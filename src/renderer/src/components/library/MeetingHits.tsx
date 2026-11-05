import type { DocumentTextMatch } from "../../../../core/api";
import { useT } from "../../i18n";
import { meetingHitsOf, transcriptInNote } from "../../meetingTranscript";
import { atPassage } from "../../palette";
import { useAppStore } from "../../store";
import { openTranscriptOfNote } from "../../transcripts";
import { MindLineIcon } from "../lineIcons";
import { pageRowClass } from "./LibraryRow";
import { sectionNameClass } from "./SectionHead";

/**
 * The meetings the Library's search finds by words said in them, as their Notes' hits (#2528): a
 * meeting is a Note, so it is never a Document row. Each opens its Transcript beside its Note, at
 * the words, as ⌘K does.
 */
export function MeetingHits({
  matches,
}: {
  matches: ReadonlyMap<string, DocumentTextMatch> | null;
}) {
  const t = useT();
  const documents = useAppStore((state) => state.documents);
  const minds = useAppStore((state) => state.minds);
  const hits = meetingHitsOf(matches, documents, minds);
  if (hits.length === 0) return null;
  const label = t("library.found.meetings");
  return (
    <section data-testid="library-meetings" aria-label={label} className="mt-6">
      <h3 className={`${sectionNameClass} mb-1 px-2`}>{label}</h3>
      <ul>
        {hits.map(({ match, note }) => (
          <li key={match.documentId} className={pageRowClass(false)}>
            <button
              type="button"
              data-row-main
              data-testid="library-meeting-hit"
              onClick={() => {
                openTranscriptOfNote(note.id, match.documentId, atPassage(match)).catch(
                  useAppStore.getState().reportError,
                );
              }}
              className="flex w-full min-w-0 items-start gap-2 px-2 py-2 text-left outline-none"
            >
              <MindLineIcon className="mt-0.5 size-4 shrink-0 text-ink-meta" />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-[14px] leading-5 text-ink">
                  {transcriptInNote(note, match.atMs, t)}
                </span>
                <span className="line-clamp-2 text-[13px] leading-5 text-ink-meta">
                  {match.excerpt}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
