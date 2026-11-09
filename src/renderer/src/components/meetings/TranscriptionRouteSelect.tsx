import { useEffect, useRef, useState } from "react";
import {
  type CloudTranscriptionRoute,
  TRANSCRIPTION_ROUTES,
  type TranscriptionRoute,
} from "../../../../core/api";
import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import { ROUTE_LABELS, type ServicesView } from "../../transcriptionServices";
import { PopUpSelect } from "../settings/PopUpButton";

const SET_UP = "set-up:";

/**
 * The rows at the foot of the list that set a service up in place, "Use Soniox…" and the like,
 * under "Set up another transcription service". `open`: the one whose setup shows.
 */
export interface TranscriptionSetUpRows {
  offers: readonly CloudTranscriptionRoute[];
  open: CloudTranscriptionRoute | null;
  onChoose(route: CloudTranscriptionRoute): void;
}

/**
 * Where meeting audio is transcribed, one setting, chosen in Settings › AI. Unchosen it reads
 * as this computer, and choosing that
 * stores it: a choice made on purpose is not the same as none (the first meeting asks only for none).
 * A cloud service is offered once there is a key for it (#141); choosing it is the consent to send
 * it meeting audio. Where it is a setting, `setUp` ends the list with the services still to set up.
 */
export function TranscriptionRouteSelect({
  id,
  className,
  popUp = false,
  grouped = false,
  labelledBy,
  focusOnShow,
  localOnly = false,
  testId = "meetings-route",
  read,
  setUp = null,
  onChosen,
  onBlur,
  onEscape,
}: {
  id: string;
  className?: string;
  /** Drawn as a pop-up button, as Settings' rows draw a choice; its look is then its own. */
  popUp?: boolean;
  /** Its services under who pays for them (Settings › AI): this computer, or the User's keys. */
  grouped?: boolean;
  /** The element that names it, where its label isn't one that points at it. */
  labelledBy?: string;
  /** It takes the focus when it shows (Change was just pressed). */
  focusOnShow?: boolean;
  /** "Keep everything on this computer" is on: nothing in the cloud is offered (#1922). */
  localOnly?: boolean;
  testId?: string;
  /** The view's read of the services, which says a failure; the select reads none of its own. */
  read: ServicesView;
  setUp?: TranscriptionSetUpRows | null;
  onChosen?(chosen: TranscriptionRoute): void;
  onBlur?(): void;
  onEscape?(): void;
}) {
  const t = useT();
  const saved = useAppStore((state) => state.settings?.device.transcriptionRoute) ?? null;
  const updateSettings = useAppStore((state) => state.updateSettings);
  // Shown at once; the setting follows when the core has it.
  const [value, setValue] = useState<TranscriptionRoute | null>(saved);
  useEffect(() => setValue(saved), [saved]);
  const field = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    if (focusOnShow) field.current?.focus();
  }, [focusOnShow]);
  const services = read.state === "ready" ? read.data : [];
  // Local mode offers only this computer, whatever was chosen before it came on.
  const shown = localOnly ? "local" : value;
  const offered = TRANSCRIPTION_ROUTES.filter(
    (each) =>
      each === "local" ||
      (!localOnly &&
        (each === value || services.some((service) => service.route === each && service.hasKey))),
  );
  const Field = popUp ? PopUpSelect : "select";
  return (
    <Field
      ref={field}
      id={id}
      aria-describedby={`${id}-tip`}
      aria-labelledby={labelledBy}
      data-testid={testId}
      value={setUp?.open ? `${SET_UP}${setUp.open}` : (shown ?? "local")}
      onBlur={onBlur}
      onKeyDown={(event) => {
        if (event.key === "Escape" && onEscape) {
          event.preventDefault();
          event.stopPropagation();
          onEscape();
        }
      }}
      onChange={(event) => {
        const offer = setUp?.offers.find((each) => `${SET_UP}${each}` === event.target.value);
        if (offer) {
          setUp?.onChoose(offer);
          return;
        }
        const chosen = TRANSCRIPTION_ROUTES.find((each) => each === event.target.value);
        if (!chosen) return;
        setValue(chosen);
        void updateSettings({ device: { transcriptionRoute: chosen } });
        onChosen?.(chosen);
      }}
      className={className}
    >
      {grouped ? (
        <>
          {offered.some((each) => each !== "local") && (
            <optgroup label={t("ai.payer.keys")}>
              {offered
                .filter((each) => each !== "local")
                .map((each) => (
                  <option key={each} value={each}>
                    {t(ROUTE_LABELS[each])}
                  </option>
                ))}
            </optgroup>
          )}
          <optgroup label={t("ai.payer.local")}>
            <option value="local">{t(ROUTE_LABELS.local)}</option>
          </optgroup>
        </>
      ) : (
        offered.map((each) => (
          <option key={each} value={each}>
            {t(ROUTE_LABELS[each])}
          </option>
        ))
      )}
      {setUp && setUp.offers.length > 0 && (
        <optgroup label={t("meetings.setUp.group")}>
          {setUp.offers.map((each) => (
            <option key={each} value={`${SET_UP}${each}`}>
              {t("meetings.setUp.row", { provider: t(ROUTE_LABELS[each]) })}
            </option>
          ))}
        </optgroup>
      )}
    </Field>
  );
}
