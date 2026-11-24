/**
 * The versions of a deck this window's hand edits wrote (#149), from the one it showed when they
 * began. While a deck's version is one of these, its viewer goes on drawing what it wrote, rather
 * than reading the file again (which would start it again, and with it a new sitting), and a tab
 * opened at a Citation of the first stays on it rather than showing the version cited. A version
 * written while one of its writes is under way is taken as that write's until the write says what
 * it wrote: the file's change can reach the window before the write's answer does. Any other
 * version is read again, as before.
 */
import { create } from "zustand";

interface Written {
  /** What names the deck while it holds one of these: what named it as the first began. */
  key: string;
  versions: readonly string[];
  /** Writes under way. */
  writing: number;
}

interface HandVersions {
  byDocument: Readonly<Record<string, Written>>;
  /** How often a deck was put back as it stood, so it is read again even at a version it had. */
  putBack: Readonly<Record<string, number>>;
}

export const useHandVersions = create<HandVersions>(() => ({ byDocument: {}, putBack: {} }));

const named = (state: HandVersions, documentId: string, version: string) => {
  const times = state.putBack[documentId] ?? 0;
  return times === 0 ? version : `${version}#${times}`;
};

const change = (documentId: string, make: (state: HandVersions) => Written | undefined) =>
  useHandVersions.setState((state) => {
    const next = make(state);
    const { [documentId]: _, ...others } = state.byDocument;
    return { byDocument: next ? { ...others, [documentId]: next } : others };
  });

/** A write of the deck shown at `shown` begins; what it returns is told what it wrote (null: nothing). */
export function beginWrite(documentId: string, shown: string): (wrote: string | null) => void {
  change(documentId, (state) => {
    const now = state.byDocument[documentId];
    return now?.versions.includes(shown)
      ? { ...now, writing: now.writing + 1 }
      : { key: named(state, documentId, shown), versions: [shown], writing: 1 };
  });
  let ended = false;
  return (wrote) => {
    if (ended) return;
    ended = true;
    change(documentId, ({ byDocument }) => {
      const now = byDocument[documentId];
      return (
        now && {
          ...now,
          writing: now.writing - 1,
          versions:
            wrote && !now.versions.includes(wrote) ? [...now.versions, wrote] : now.versions,
        }
      );
    });
  };
}

/** A copy saved beside a deck holds `version`, written by hand from here. */
export function adopt(documentId: string, version: string): void {
  change(documentId, (state) => ({
    key: named(state, documentId, version),
    versions: [version],
    writing: 0,
  }));
}

/** The deck was put back as it stood: it is read again, whichever version that is. */
export function forget(documentId: string): void {
  useHandVersions.setState((state) => {
    const { [documentId]: _, ...others } = state.byDocument;
    return {
      byDocument: others,
      putBack: { ...state.putBack, [documentId]: (state.putBack[documentId] ?? 0) + 1 },
    };
  });
}

/** Whether this window's hand edits took the deck from `from` to `now`, or are taking it there. */
export function wroteByHand(
  state: HandVersions,
  documentId: string,
  from: string,
  now: string,
): boolean {
  const written = state.byDocument[documentId];
  return (
    written?.versions.includes(from) === true &&
    (written.writing > 0 || written.versions.includes(now))
  );
}

/** What names the deck at `version`: the same while its hand edits here wrote it. */
export function steadyVersion(state: HandVersions, documentId: string, version: string): string {
  const written = state.byDocument[documentId];
  return written && (written.writing > 0 || written.versions.includes(version))
    ? written.key
    : named(state, documentId, version);
}

/** The deck at `version`, named by `steadyVersion`, now. */
export const useSteadyVersion = (documentId: string, version: string): string =>
  useHandVersions((state) => steadyVersion(state, documentId, version));
