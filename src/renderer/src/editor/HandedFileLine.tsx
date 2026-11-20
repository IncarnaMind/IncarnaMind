import { useEffect, useState } from "react";
import type * as Y from "yjs";
import type { HandedFileOfMind } from "../../../core/api";
import { MetaLine } from "../components/MetaLine";
import { buttonStyle } from "../components/ui";
import { core } from "../core";
import { useLanguage, useT } from "../i18n";
import { useAppStore } from "../store";
import { checkClaims } from "../verify";

/**
 * The check card's line for a file an outside agent handed over (#3412): which agent, which of its
 * versions this Note checks, how many claims kept an earlier version's result, with a press to
 * check every claim again, and each other version's check to open. Read again whenever the file's
 * Document takes a new version.
 */
export function HandedFileLine({
  mindId,
  doc,
  kept,
  running,
}: {
  mindId: string;
  doc: Y.Doc;
  kept: number;
  running: boolean;
}) {
  const t = useT();
  const language = useLanguage();
  const [handed, setHanded] = useState<HandedFileOfMind | null>(null);
  const documentId = handed?.file.documentId ?? null;
  const version = useAppStore((state) =>
    documentId === null
      ? null
      : (state.documents.find((each) => each.id === documentId)?.contentHash ?? null),
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new version of its Document is a new version of the file
  useEffect(() => {
    let current = true;
    core
      .handedFileOf(mindId)
      .then((found) => {
        if (current) setHanded(found);
      })
      .catch((error: unknown) => console.error("The handed-over file couldn't be read.", error));
    return () => {
      current = false;
    };
  }, [mindId, version]);

  if (!handed) return null;
  const format = (value: number) => new Intl.NumberFormat(language).format(value);
  const others = handed.versions.filter(
    (each) => each.number !== handed.version && each.mindId !== null,
  );
  const from = handed.versions
    .filter((each) => each.number < handed.version && each.mindId !== null)
    .at(-1)?.number;
  const keptLine =
    kept > 0 && from !== undefined
      ? t(kept === 1 ? "verify.handed.kept.one" : "verify.handed.kept", {
          count: format(kept),
          from: format(from),
        })
      : null;
  return (
    <div data-testid="verify-handed" className="check-rows">
      <MetaLine
        className="check-card-summary"
        parts={[
          t("verify.handed.line", {
            agent: handed.file.agent,
            version: format(handed.version),
            count: format(handed.versions.length),
          }),
        ]}
      />
      {keptLine !== null && (
        <MetaLine
          className="check-card-summary"
          data-testid="verify-handed-kept"
          parts={[keptLine]}
        />
      )}
      {(others.length > 0 || keptLine !== null) && (
        <div className="flex flex-wrap gap-1.5 px-2 pb-1.5">
          {keptLine !== null && (
            <button
              type="button"
              data-testid="verify-handed-check-all"
              className={buttonStyle("secondary", "sm")}
              disabled={running}
              onClick={() => void checkClaims(mindId, doc)}
            >
              {t("verify.handed.checkAll")}
            </button>
          )}
          {others.map((each) => (
            <button
              key={each.number}
              type="button"
              data-testid="verify-handed-version"
              className={buttonStyle("secondary", "sm")}
              aria-label={t("verify.handed.openLabel", { n: format(each.number) })}
              onClick={() => {
                if (each.mindId) useAppStore.getState().openMind(each.mindId);
              }}
            >
              {t("verify.handed.open", { n: format(each.number) })}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
