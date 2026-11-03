import { useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import type { SearchScope } from "../../core/api";
import { mindScopeOf, observeMindScope, scopeBeforeOf, setMindScope } from "../../shared/mindScope";
import { sameScope } from "../../shared/searchScope";
import { type CitedSource, useComposer } from "./composer";
import { openMindCopy } from "./mindCopies";
import { useAppStore } from "./store";

/** Keeps the Mind's draft on the scope kept with the Mind, as it is and as it changes, here or elsewhere. */
export function useKeptScope(mindId: string, doc: Y.Doc): void {
  useEffect(() => {
    const mirror = () => {
      const kept = mindScopeOf(doc);
      const drafted = useComposer.getState().draft(mindId).scope;
      if (kept === drafted || (kept && drafted && sameScope(kept, drafted))) return;
      useComposer.getState().update(mindId, { scope: kept });
    };
    mirror();
    return observeMindScope(doc, mirror);
  }, [mindId, doc]);
}

export function useMindScope(doc: Y.Doc): SearchScope | null {
  const [scope, setScope] = useState(() => mindScopeOf(doc));
  useEffect(() => {
    setScope(mindScopeOf(doc));
    return observeMindScope(doc, () => setScope(mindScopeOf(doc)));
  }, [doc]);
  return scope;
}

export function useCitedScopeDocument(source: CitedSource | null, mindDoc: Y.Doc | null) {
  const reportError = useAppStore((state) => state.reportError);
  const mindId = source?.mindId ?? null;
  const [opened, setOpened] = useState<{ mindId: string; doc: Y.Doc } | null>(null);
  const pending = useRef<{ mindId: string; scope: SearchScope | null }[]>([]);
  useEffect(() => {
    if (mindId === null) {
      setOpened(null);
      return;
    }
    const close = openMindCopy(
      mindId,
      ({ doc }) => {
        if (!doc) {
          setOpened(null);
          return;
        }
        setOpened({ mindId, doc });
        for (const edit of pending.current.filter((each) => each.mindId === mindId)) {
          setMindScope(doc, edit.scope);
        }
        pending.current = pending.current.filter((each) => each.mindId !== mindId);
      },
      reportError,
    );
    return () => {
      setOpened(null);
      close();
    };
  }, [mindId, reportError]);
  const doc = opened?.mindId === mindId ? opened.doc : null;
  const setScope = (scope: SearchScope | null) => {
    if (mindId === null) {
      if (mindDoc) setMindScope(mindDoc, scope);
    } else if (doc) {
      setMindScope(doc, scope);
    } else {
      pending.current.push({ mindId, scope });
    }
  };
  return { doc: mindId === null ? mindDoc : doc, setScope };
}

/** Where the Mind's narrowed scope goes back to in one click (`scopeBeforeOf`); null for no Mind. */
export function useScopeBefore(doc: Y.Doc | null): SearchScope | null {
  const [before, setBefore] = useState(() => doc && scopeBeforeOf(doc));
  useEffect(() => {
    if (!doc) {
      setBefore(null);
      return;
    }
    setBefore(scopeBeforeOf(doc));
    return observeMindScope(doc, () => setBefore(scopeBeforeOf(doc)));
  }, [doc]);
  return before;
}
