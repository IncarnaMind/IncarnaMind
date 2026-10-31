import { useEffect, useRef, useState } from "react";
import { TRANSCRIPTION_ROUTES, type TranscriptionRoute } from "../../../../core/api";
import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import { ROUTE_LABELS, type ServicesView } from "../../transcriptionServices";

/**
 * Where meeting audio is transcribed, one setting wherever it is shown (Settings › Models,
 * Settings › Meetings, the first-run list). Unchosen it reads as this computer, and choosing that
 * stores it: a choice made on purpose is not the same as none (the first meeting asks only for none).
 * A cloud service is offered once there is a key for it (#141); choosing it is the consent to send
 * it meeting audio.
 */
export function TranscriptionRouteSelect({
  id,
  className,
  labelledBy,
  focusOnShow,
  localOnly = false,
  testId = "meetings-route",
  saveOnChange = true,
  read,
  onChosen,
  onBlur,
  onEscape,
}: {
  id: string;
  className: string;
  /** The element that names it, where its label isn't one that points at it. */
  labelledBy?: string;
  /** It takes the focus when it shows (Change was just pressed). */
  focusOnShow?: boolean;
  /** "Keep everything on this computer" is on: nothing in the cloud is offered (#1922). */
  localOnly?: boolean;
  /** Where it is the setup card's step, its own name. */
  testId?: string;
  /** The setup card's step saves when its Use this is pressed, so its choice is its consent there. */
  saveOnChange?: boolean;
  /** The view's read of the services, which says a failure; the select reads none of its own. */
  read: ServicesView;
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
  return (
    <select
      ref={field}
      id={id}
      aria-describedby={`${id}-tip`}
      aria-labelledby={labelledBy}
      data-testid={testId}
      value={shown ?? "local"}
      onBlur={onBlur}
      onKeyDown={(event) => {
        if (event.key === "Escape" && onEscape) {
          event.preventDefault();
          event.stopPropagation();
          onEscape();
        }
      }}
      onChange={(event) => {
        const chosen = TRANSCRIPTION_ROUTES.find((each) => each === event.target.value);
        if (!chosen) return;
        setValue(chosen);
        if (saveOnChange) void updateSettings({ device: { transcriptionRoute: chosen } });
        onChosen?.(chosen);
      }}
      className={className}
    >
      {offered.map((each) => (
        <option key={each} value={each}>
          {t(ROUTE_LABELS[each])}
        </option>
      ))}
    </select>
  );
}
