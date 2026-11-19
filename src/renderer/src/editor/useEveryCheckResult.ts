import { useEffect, useState } from "react";
import type * as Y from "yjs";
import { everyCheckResultOf, observeEveryCheckResult } from "../../../shared/everyCheckResult";

/** Whether the Note shows every check result (#3358), as it changes here or from elsewhere. */
export function useEveryCheckResult(doc: Y.Doc): boolean {
  const [shown, setShown] = useState(() => everyCheckResultOf(doc));
  useEffect(() => {
    setShown(everyCheckResultOf(doc));
    return observeEveryCheckResult(doc, () => setShown(everyCheckResultOf(doc)));
  }, [doc]);
  return shown;
}
