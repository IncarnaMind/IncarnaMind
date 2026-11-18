import type { WorkKind } from "../../../../core/api";
import type { MessageKey } from "../../../../shared/i18n";
import { core } from "../../core";
import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import {
  BookmarkLineIcon,
  CalculatorLineIcon,
  FindSourcesLineIcon,
  MicLineIcon,
  SparkLineIcon,
  TableLineIcon,
} from "../lineIcons";
import { buttonStyle } from "../ui";
import { SetupChoice, SetupPanel, type StepPlace } from "./SetupPanel";

const WORK_WORDS: Record<WorkKind, { title: MessageKey; line: MessageKey }> = {
  finance: { title: "setupPage.work.finance", line: "setupPage.work.finance.line" },
  legal: { title: "setupPage.work.legal", line: "setupPage.work.legal.line" },
  research: { title: "setupPage.work.research", line: "setupPage.work.research.line" },
  reports: { title: "setupPage.work.reports", line: "setupPage.work.reports.line" },
  meetings: { title: "setupPage.work.meetings", line: "setupPage.work.meetings.line" },
  other: { title: "setupPage.work.other", line: "setupPage.work.other.line" },
};

const WORK_ICONS: Record<WorkKind, typeof SparkLineIcon> = {
  finance: CalculatorLineIcon,
  legal: BookmarkLineIcon,
  research: FindSourcesLineIcon,
  reports: TableLineIcon,
  meetings: MicLineIcon,
  other: SparkLineIcon,
};

const toggled = (work: readonly WorkKind[], kind: WorkKind): WorkKind[] =>
  work.includes(kind) ? work.filter((each) => each !== kind) : [...work, kind];

/**
 * The setup's first step (#3296): what the User works on, several picks allowed, in an order kept
 * for this install. Where this copy can send them and hasn't, "Send and continue" sends the picks,
 * once per install, as its line says, and "Continue without sending" sends nothing; Skip picks
 * nothing.
 */
export function WorkStep({
  place,
  order,
  work,
  onWork,
  sent,
  onSent,
}: {
  place: StepPlace;
  order: readonly WorkKind[];
  work: readonly WorkKind[];
  onWork(work: WorkKind[]): void;
  /** This install has sent the picks. */
  sent: boolean;
  onSent(): void;
}) {
  const t = useT();
  const usageData = useAppStore((state) => state.privacy?.usageData);
  const canSend = usageData?.available === true && !usageData.localMode && !sent;
  const send = () => {
    core
      .sendWorkPicked(work)
      .catch((error: unknown) => console.error("The first run's picks couldn't be sent.", error));
    onSent();
    place.next();
  };
  const picked = work.length > 0;
  return (
    <SetupPanel
      place={place}
      view="work"
      title={t("setupPage.work.title")}
      lead={t("setupPage.work.lead")}
      foot={
        <>
          <span className="flex-1" />
          {!picked && (
            <button
              type="button"
              data-testid="setup-skip"
              onClick={() => {
                onWork([]);
                place.next();
              }}
              className={buttonStyle("ghost", "lg")}
            >
              {t("setupPage.skip")}
            </button>
          )}
          {picked && canSend && (
            <button
              type="button"
              data-testid="setup-work-dont-send"
              onClick={place.next}
              className={buttonStyle("ghost", "lg")}
            >
              {t("setupPage.work.dontSend")}
            </button>
          )}
          <button
            type="button"
            data-testid="setup-next"
            disabled={!picked}
            onClick={canSend ? send : place.next}
            className={buttonStyle("primary", "lg")}
          >
            {t(canSend ? "setupPage.work.send" : "setupPage.continue")}
          </button>
        </>
      }
    >
      <fieldset className="m-0 grid grid-cols-1 gap-2.5 border-0 p-0 min-[600px]:auto-rows-fr min-[600px]:grid-cols-2">
        <legend className="sr-only">{t("setupPage.work.title")}</legend>
        {order.map((kind) => {
          const Icon = WORK_ICONS[kind];
          return (
            <SetupChoice
              key={kind}
              icon={<Icon className="size-[18px]" />}
              type="checkbox"
              name="work"
              value={kind}
              testId="setup-work"
              checked={work.includes(kind)}
              title={t(WORK_WORDS[kind].title)}
              line={t(WORK_WORDS[kind].line)}
              onChange={() => onWork(toggled(work, kind))}
            />
          );
        })}
      </fieldset>
      {canSend && (
        <p data-testid="setup-work-sent" className="text-[12px] leading-[18px] text-ink-meta">
          {t("setupPage.work.sent")}
        </p>
      )}
    </SetupPanel>
  );
}
