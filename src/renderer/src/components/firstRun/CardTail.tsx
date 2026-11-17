import type { WorkKind } from "../../../../core/api";
import { decisionModelOf } from "../../../../core/providers/catalog/decisions";
import type { MessageKey } from "../../../../shared/i18n";
import { commands } from "../../commands/registry";
import { exportPreferences } from "../../exports";
import { useT } from "../../i18n";
import { useModelNames } from "../../modelNames";
import { useAppStore } from "../../store";
import { ROUTE_LABELS } from "../../transcriptionServices";
import { FEATURE_COMMANDS, type NextFeature, nextFeatures, nextLeadOf } from "./cardWords";

const FEATURE_WORDS: Record<NextFeature, MessageKey> = {
  checkFile: "firstOpen.next.checkFile",
  compare: "firstOpen.next.compare",
  exportWord: "firstOpen.next.exportWord",
  ownReport: "firstOpen.next.ownReport",
  citationStyle: "firstOpen.next.citationStyle",
  findSources: "firstOpen.next.findSources",
  addFiles: "firstOpen.next.addFiles",
  record: "firstOpen.next.record",
};

/** Runs a feature's command, on the example Note for one that acts on a Note. */
function runFeature(feature: NextFeature, mindId: string): Promise<unknown> {
  const [own, last] = FEATURE_COMMANDS[feature];
  const id = feature === "exportWord" && exportPreferences().format === "docx" ? last : own;
  if (!id) return Promise.resolve();
  return commands.run(id, { focus: { kind: "mind", id: mindId } });
}

const linkClass =
  "rounded-sm text-left font-semibold text-accent-strong underline-offset-2 hover:underline focus-visible:outline-offset-0";

/**
 * Get started's foot after the first run's setup (#3296): one line of what the setup set, with
 * where it changes; and, once the steps are done, what to try next in the User's work, merged
 * across their picks.
 */
export function CardTail({
  work,
  mindId,
  live,
  done,
}: {
  work: readonly WorkKind[];
  mindId: string;
  live: boolean;
  done: boolean;
}) {
  const t = useT();
  const reportError = useAppStore((state) => state.reportError);
  const openSettings = useAppStore((state) => state.openSettings);
  const features = nextFeatures(work);
  return (
    <div className="mt-3 flex flex-col gap-1.5 border-t border-rule pt-3 text-[13px] leading-5">
      {done && features.length > 0 && (
        <p
          data-testid={live ? "first-open-next" : undefined}
          className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-ink-secondary"
        >
          <span>{t(nextLeadOf(work))}</span>
          {features.map((feature, index) => (
            <span key={feature} className="inline-flex items-baseline gap-x-2">
              {index > 0 && <span aria-hidden="true">·</span>}
              <button
                type="button"
                data-testid={live ? "first-open-next-feature" : undefined}
                data-feature={feature}
                onClick={() => void runFeature(feature, mindId).catch(reportError)}
                className={linkClass}
              >
                {t(FEATURE_WORDS[feature])}
              </button>
            </span>
          ))}
        </p>
      )}
      <p
        data-testid={live ? "first-open-set" : undefined}
        className="text-[12px] leading-[18px] text-ink-meta"
      >
        <WhatWasSet /> ·{" "}
        <button
          type="button"
          data-testid={live ? "first-open-set-change" : undefined}
          onClick={() => openSettings("ai")}
          className={linkClass}
        >
          {t("firstOpen.set.change")}
        </button>
      </p>
    </div>
  );
}

/** The three models as the setup left them: Answers, sorting and meeting transcription. */
function WhatWasSet() {
  const t = useT();
  const nameOf = useModelNames();
  const readiness = useAppStore((state) => state.chatReadiness);
  const classifier = useAppStore((state) => state.library?.settings.classifier ?? null);
  const route = useAppStore((state) => state.settings?.device.transcriptionRoute ?? null);
  const answers = readiness?.ready
    ? t("firstOpen.set.answers", {
        model: nameOf(readiness.modelId, readiness.provider.id).name,
      })
    : t("firstOpen.set.noAi");
  const sorting =
    !classifier || classifier.kind === "automatic"
      ? t("firstOpen.set.sorting.none")
      : classifier.kind === "auto" || classifier.kind === "ollama"
        ? t("firstOpen.set.sorting.here")
        : t("firstOpen.set.sorting", {
            model:
              classifier.kind === "chat"
                ? nameOf(classifier.choice.modelId, classifier.choice.providerId).name
                : classifier.kind === "jev"
                  ? "TypeSafe Jev"
                  : (decisionModelOf(classifier.host, classifier.modelId)?.name ??
                    classifier.modelId),
          });
  const transcription =
    route === null
      ? t("firstOpen.set.transcription.later")
      : route === "local"
        ? t("firstOpen.set.transcription.here")
        : t("firstOpen.set.transcription", { service: t(ROUTE_LABELS[route]) });
  return <>{[answers, sorting, transcription].join(" · ")}</>;
}
