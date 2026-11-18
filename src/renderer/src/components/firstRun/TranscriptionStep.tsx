import { useT } from "../../i18n";
import {
  FirstTranscriptionChoiceFields,
  useFirstTranscriptionChoice,
} from "../meetings/FirstTranscriptionChoice";
import { buttonStyle } from "../ui";
import { SetupPanel, type StepPlace } from "./SetupPanel";

/**
 * The setup's last step (#3296): where meeting audio is turned into text, as
 * `useFirstTranscriptionChoice` says. Finish keeps the choice; "Set up when I record" leaves it to the
 * first recording.
 */
export function TranscriptionStep({ place }: { place: StepPlace }) {
  const t = useT();
  const setup = useFirstTranscriptionChoice();
  const next = async () => {
    if (await setup.finish()) place.next();
  };

  return (
    <SetupPanel
      place={place}
      view="meetings"
      title={t("setupPage.meetings.title")}
      lead={t("setupPage.meetings.lead")}
      foot={
        <>
          {place.back && (
            <button
              type="button"
              data-testid="setup-back"
              onClick={place.back}
              className={`-ml-2.5 ${buttonStyle("ghost", "lg")}`}
            >
              {t("setupPage.back")}
            </button>
          )}
          <span className="flex-1" />
          <button
            type="button"
            data-testid="setup-skip"
            onClick={place.next}
            disabled={setup.step.busy}
            className={buttonStyle("ghost", "lg")}
          >
            {t("setupPage.meetings.later")}
          </button>
          <button
            type="button"
            data-testid="setup-next"
            disabled={!setup.ready || setup.busy}
            onClick={() => void next()}
            className={buttonStyle("primary", "lg")}
          >
            {t("setupPage.finish")}
          </button>
        </>
      }
    >
      <FirstTranscriptionChoiceFields setup={setup} onEnter={() => void next()} />
    </SetupPanel>
  );
}
