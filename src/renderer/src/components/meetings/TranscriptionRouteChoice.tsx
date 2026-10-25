import { useEffect, useRef, useState } from "react";
import type { CloudTranscriptionRoute } from "../../../../core/api";
import { core } from "../../core";
import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import { useTranscriptionServicesList } from "../../transcriptionServices";
import { CloudLineIcon, ComputerLineIcon } from "../lineIcons";
import { buttonStyle } from "../ui";

const lineClass = "flex items-center gap-3 rounded-lg p-3 ring-1 ring-rule ring-inset";
const linkClass =
  "shrink-0 text-[12px] leading-5 whitespace-nowrap text-accent underline-offset-2 hover:underline";

/**
 * Where the first recording is transcribed, on its sheet (#141): one line, this computer, with a
 * quiet "Other ways…" that unfolds to the cloud services the User has keys for. Each has its own
 * button, and that click is the consent (ADR-0022); nothing is chosen for the User. Once one is
 * chosen, the line names it, with the way back. A choice made before the sheet opened (first run,
 * Settings) stands, so the sheet doesn't ask again. When this computer is known not to keep up,
 * the services show unfolded with the reason, or, with no key, a line says live text may lag.
 */
export function TranscriptionRouteChoice() {
  const t = useT();
  const route = useAppStore((state) => state.settings?.device.transcriptionRoute) ?? null;
  const localMode = useAppStore((state) => state.embedding?.localOnly === true);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const openSettings = useAppStore((state) => state.openSettings);
  const services = useTranscriptionServicesList().filter((service) => service.hasKey);
  const [open, setOpen] = useState(false);
  const [chosenBefore] = useState(route);
  const [keepsUp, setKeepsUp] = useState<boolean | null>(null);
  const root = useRef<HTMLDivElement>(null);
  // Each button here removes itself, so focus goes on to what replaces it, once that has rendered
  // (a choice waits for the settings to come back), never to the page body.
  const focusNext = useRef<string | null>(null);
  useEffect(() => {
    const next = focusNext.current && root.current?.querySelector<HTMLElement>(focusNext.current);
    if (!next) return;
    focusNext.current = null;
    next.focus();
  });
  useEffect(() => {
    core.getTranscriptionSpeed().then(
      (speed) => setKeepsUp(speed.keepsUp),
      (error: unknown) =>
        console.error("This computer's transcription speed couldn't be read.", error),
    );
  }, []);

  const chosen = services.find((service) => service.route === route);
  if (chosen && !localMode) {
    return (
      <div ref={root} data-testid="meeting-route" data-route={chosen.route} className={lineClass}>
        <CloudLineIcon className="size-[18px] shrink-0 text-ink-meta" />
        <div className="min-w-0 grow">
          <p className="text-ui font-semibold text-ink">
            {t("meetings.route.cloudOn", { service: chosen.name })}
          </p>
          <p className="text-[12px] leading-4 text-ink-meta">
            {t("meetings.route.cloudLine", { service: chosen.name })}
          </p>
        </div>
        <button
          type="button"
          data-testid="meeting-route-here"
          onClick={() => {
            focusNext.current = '[data-testid="meeting-route-other"]';
            void updateSettings({ device: { transcriptionRoute: "local" } });
          }}
          className={linkClass}
        >
          {t("meetings.route.useHere")}
        </button>
      </div>
    );
  }

  const offered = localMode || chosenBefore === "local" ? [] : services;
  const slow = keepsUp === false;
  const unfolded = offered.length > 0 && (open || slow);
  const use = (each: CloudTranscriptionRoute) => {
    setOpen(false);
    focusNext.current = '[data-testid="meeting-route-here"]';
    void updateSettings({ device: { transcriptionRoute: each } });
  };
  return (
    <div ref={root} data-testid="meeting-route" data-route="local" className="flex flex-col gap-2">
      <div className={lineClass}>
        <ComputerLineIcon className="size-[18px] shrink-0 text-ink-meta" />
        <div className="min-w-0 grow">
          <p className="text-ui font-semibold text-ink">{t("meetings.route.here")}</p>
          <p className="text-[12px] leading-4 text-ink-meta">{t("meetings.route.hereLine")}</p>
        </div>
        {offered.length > 0 && !unfolded && (
          <button
            type="button"
            data-testid="meeting-route-other"
            aria-expanded={false}
            onClick={() => {
              focusNext.current = '[data-testid^="meeting-route-use-"]';
              setOpen(true);
            }}
            className={linkClass}
          >
            {t("meetings.route.otherWays")}
          </button>
        )}
      </div>
      {slow && offered.length === 0 && !localMode && (
        <p className="text-[12px] leading-4 text-ink-meta">
          {t("meetings.route.slowNoKey")}{" "}
          <button
            type="button"
            onClick={() => openSettings("meetings")}
            className="text-accent underline-offset-2 hover:underline"
          >
            {t("meetings.route.settingsLink")}
          </button>
        </p>
      )}
      {unfolded && (
        <div data-testid="meeting-route-ways" className="flex flex-col gap-2 pl-[42px]">
          {slow && (
            <p className="text-[12px] leading-4 font-semibold text-ink">
              {t("meetings.route.slow")}
            </p>
          )}
          {offered.map((service) => (
            <div key={service.route} className="flex items-center gap-3 text-[13px] text-ink">
              <span className="grow">{t("meetings.route.wayRow", { service: service.name })}</span>
              <button
                type="button"
                data-testid={`meeting-route-use-${service.route}`}
                onClick={() => use(service.route)}
                className={buttonStyle("secondary", "sm")}
              >
                {t("meetings.route.use", { service: service.name })}
              </button>
            </div>
          ))}
          <p className="text-[12px] leading-4 text-ink-meta">{t("meetings.route.waysNote")}</p>
        </div>
      )}
    </div>
  );
}
