/**
 * The line at the top of a Mind that is a source (#335): "Used as a source ·
 * Update the snapshot". The whole line takes the update, as the menu does,
 * and Undo puts the version before it back.
 */
import { commands } from "../commands/registry";
import { useT } from "../i18n";
import { useMindSource } from "../mindSources";
import { useAppStore } from "../store";

export function MindSourceLine({ mindId, readOnly }: { mindId: string; readOnly: boolean }) {
  const t = useT();
  const source = useMindSource(mindId);
  if (!source || readOnly) return null;
  return (
    <p className="mind-source">
      <button
        type="button"
        data-testid="mind-source-line"
        title={t("mind.updateSnapshot")}
        onClick={() => {
          commands
            .run("mind.updateSourceSnapshot", {
              focus: { kind: "mind", id: mindId },
              surface: "mind",
            })
            .catch(useAppStore.getState().reportError);
        }}
        className="mind-source-button"
      >
        {t("mind.sourceLine")}
      </button>
    </p>
  );
}
