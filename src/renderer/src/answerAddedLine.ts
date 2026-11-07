import { quotedName } from "../../shared/naming";
import type { Words } from "./lineNames";

/**
 * What an Answer's line under it says when it went into a Note: "Wrote “…”" for a Note just
 * made, "Added to “…”" for one that was there (#1940), and, when its Citations come from a
 * walled Folder the Note is outside, that it was copied out of it (#1934).
 */
export const answerAddedLine =
  (made: boolean, mind: string, outOf: string | null): Words =>
  (t) => {
    const name = quotedName(mind || t("mind.untitled"));
    if (made) {
      return outOf === null
        ? t("answer.wrote", { mind: name })
        : t("answer.wrote.outOfWall", { mind: name, folder: outOf });
    }
    return outOf === null
      ? t("answer.added", { mind: name })
      : t("answer.added.outOfWall", { mind: name, folder: outOf });
  };
