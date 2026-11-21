import { useEffect, useState } from "react";
import type * as Y from "yjs";
import { MIND_CONTENT_FIELD } from "../../core/api";
import { fingerprintOfMind } from "../../shared/mindState";
import { verificationOf } from "../../shared/verification";
import { core } from "./core";
import { useAppStore } from "./store";

/**
 * What each result of the Note that keeps what it was judged with would be judged with now, by its
 * id (`JudgedWithNow`), as the core works it out (#3455): the window reads each result with it, so
 * a line whose heading or slide changed since its check shows Needs re-check here as in exports
 * and the agents' replies. Asked again after every change; until the core's answer for the new
 * text comes, the last one stays, as the figure schedule's does. Null for a Note no file check
 * made, whose results keep none.
 */
export function useJudgedNow(
  mindId: string,
  doc: Y.Doc | null,
): ReadonlyMap<string, string> | null {
  const [read, setRead] = useState<{ doc: Y.Doc; lines: ReadonlyMap<string, string> } | null>(null);
  useEffect(() => {
    if (!doc) return;
    const blocks = doc.getXmlFragment(MIND_CONTENT_FIELD);
    let active = true;
    let pending = false;
    let changed = false;
    const refresh = () => {
      if (verificationOf(doc) === null) return;
      if (pending) {
        changed = true;
        return;
      }
      pending = true;
      changed = false;
      const basis = fingerprintOfMind(doc);
      core
        .judgedWithNow(mindId)
        .then((now) => {
          if (active && now.basis === basis && basis === fingerprintOfMind(doc))
            setRead({ doc, lines: new Map(Object.entries(now.lines)) });
        })
        .catch((error: unknown) => {
          if (active) useAppStore.getState().reportError(error);
        })
        .finally(() => {
          pending = false;
          if (active && changed) refresh();
        });
    };
    blocks.observeDeep(refresh);
    const stop = core.on("mind.update", (event) => {
      if (event.mindId === mindId) refresh();
    });
    refresh();
    return () => {
      active = false;
      stop();
      blocks.unobserveDeep(refresh);
    };
  }, [mindId, doc]);
  return read?.doc === doc ? read.lines : null;
}
