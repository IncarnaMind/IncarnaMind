import type * as Y from "yjs";
import { askToCheck, useAgentsToAsk, useNoModel, useReadAgentsToAsk } from "../askYourAi";
import { MetaLine } from "../components/MetaLine";
import { buttonStyle } from "../components/ui";
import { showVersion, useHandedFile } from "../handedFiles";
import { useLanguage, useT } from "../i18n";
import { checkClaims } from "../verify";

/**
 * The check card's line for a file an outside agent handed over (#3412): which agent, which of its
 * versions this Note checks, how many claims kept an earlier version's result, with a press to
 * check every claim again, and each other version's check to open in this one's place.
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
  const handed = useHandedFile(mindId, doc);
  const noModel = useNoModel();
  useReadAgentsToAsk(mindId);
  const agents = useAgentsToAsk(mindId);

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
  const canCheckAll = keptLine !== null && (!noModel || agents.length > 0);
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
      {(others.length > 0 || canCheckAll) && (
        <div className="flex flex-wrap gap-1.5 px-2 pb-1.5">
          {canCheckAll && (
            <button
              type="button"
              data-testid="verify-handed-check-all"
              className={buttonStyle("secondary", "sm")}
              disabled={running}
              onClick={() => void (noModel ? askToCheck(mindId) : checkClaims(mindId, doc))}
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
                if (each.mindId) void showVersion(mindId, each.mindId);
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
