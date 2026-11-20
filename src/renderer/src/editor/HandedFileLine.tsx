import { useEffect, useState } from "react";
import type { HandedFileOfMind } from "../../../core/api";
import { MetaLine } from "../components/MetaLine";
import { buttonStyle } from "../components/ui";
import { core } from "../core";
import { useLanguage, useT } from "../i18n";
import { useAppStore } from "../store";

/**
 * The check card's line for a file an outside agent handed over (#3412): which agent, which of its
 * versions this Note checks, and each other version's check to open. Read again whenever the
 * file's Document takes a new version.
 */
export function HandedFileLine({ mindId }: { mindId: string }) {
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
      {others.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-2 pb-1.5">
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
