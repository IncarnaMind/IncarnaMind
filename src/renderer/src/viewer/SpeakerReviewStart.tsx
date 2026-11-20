import { useState } from "react";
import type { MeetingSpeakerReviewQuote } from "../../../core/api";
import { speakerName } from "../../../shared/speakers";
import { LineAction } from "../components/ProblemLine";
import { useT } from "../i18n";

export function SpeakerReviewStart({
  quote,
  named,
  run,
}: {
  quote: MeetingSpeakerReviewQuote;
  named(label: string): string | null;
  run(selfLabel?: string): void;
}) {
  const t = useT();
  const [selfLabel, setSelfLabel] = useState("");
  return (
    <>
      {quote.selfMatch && (
        <div className="space-y-1">
          <label className="flex flex-wrap items-center gap-2 text-ink">
            {t("meetings.review.selfLabel")}
            <select
              className="max-w-full rounded border border-rule bg-sheet px-2 py-1 text-ink"
              value={selfLabel}
              onChange={(event) => setSelfLabel(event.target.value)}
            >
              <option value="">{t("meetings.review.chooseSelfLabel")}</option>
              {quote.selfMatch.labels.map((label) => {
                const number = speakerName(label, t);
                const name = named(label);
                return (
                  <option key={label} value={label}>
                    {name ? t("meetings.review.namedLabel", { name, label: number }) : number}
                  </option>
                );
              })}
            </select>
          </label>
          <p className="text-ink-meta">{t("meetings.review.selfHelp")}</p>
        </div>
      )}
      <LineAction
        action={{
          label: t(
            quote.roomDownloadBytes !== undefined
              ? quote.roomDownloadBytes > 0
                ? "meetings.review.roomInstall"
                : "meetings.review.roomCheck"
              : quote.cached
                ? "meetings.review.viewCached"
                : "meetings.review.confirm",
          ),
          disabled: !!quote.selfMatch && !quote.selfMatch.labels.includes(selfLabel),
          onClick: () => run(quote.selfMatch ? selfLabel : undefined),
        }}
      />
    </>
  );
}
