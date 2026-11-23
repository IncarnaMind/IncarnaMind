import type { ChangeRun, ChangeView } from "../../../shared/checkChange";
import { useT } from "../i18n";

/** Struck words and the words written after them, which a space keeps apart where words have spaces. */
const spacedBefore = (struck: string, next: ChangeRun | undefined): boolean =>
  next?.kind === "written" &&
  /[\p{Script=Latin}\p{N}%)]$/u.test(struck) &&
  /^[\p{Script=Latin}\p{N}\p{Sc}(]/u.test(next.text);

/**
 * What a check card's change makes of the sentence (#3715), drawn as a change waiting in the Note
 * is: the words it takes out struck in grey and the words it writes underlined in blue, or, where
 * it writes the sentence anew, the old sentence on one "Was:" line over the new one.
 */
export function CheckChangeView({ view, titled }: { view: ChangeView; titled: boolean }) {
  const t = useT();
  return (
    <section
      className="claim-change"
      data-testid="claim-change"
      aria-label={t("claim.change.title")}
    >
      {titled && <p className="claim-change-title">{t("claim.change.title")}</p>}
      {view.kind === "anew" ? (
        <>
          <p className="claim-change-was" data-testid="claim-change-was" title={view.was}>
            {t("change.was", { text: view.was })}
          </p>
          <p className="claim-change-text">
            <ins>{view.now}</ins>
          </p>
        </>
      ) : (
        <p className="claim-change-text" data-testid="claim-change-text">
          {view.cut && "…"}
          {view.runs.map((run, index) =>
            run.kind === "struck" ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: the runs are rebuilt whole with the change.
              <span key={index}>
                <del>{run.text}</del>
                {spacedBefore(run.text, view.runs[index + 1]) && " "}
              </span>
            ) : run.kind === "written" ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: the runs are rebuilt whole with the change.
              <ins key={index}>{run.text}</ins>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: the runs are rebuilt whole with the change.
              <span key={index}>{run.text}</span>
            ),
          )}
        </p>
      )}
    </section>
  );
}
