import { isMacOS } from "@tiptap/core";
import { Fragment, useEffect } from "react";
import type { Meeting } from "../../../core/api";
import { formatBytes } from "../../../shared/bytes";
import { useLanguage, useT } from "../i18n";
import { useMeetings } from "../meetings";
import { loadSavedProviders, useSavedProviders } from "../savedProviders";
import { useAppStore } from "../store";
import { ScreenLineIcon } from "./lineIcons";
import { providerName } from "./providers/shared";

interface LineAction {
  label: string;
  testId: string;
  onClick(): void;
  /** The way on the line asks for: in the accent. The others are in ink. */
  primary?: boolean;
}

/**
 * The shared screen's one line over the meeting's control (#834, #3762): while the Meeting
 * records, it asks whether to read a shared screen, until the User answers; then it says which
 * window is read, with Stop. What stopped the reading is said here too, with the one thing to do.
 * Later in the call the sheet's "Shared screen…" reads one. Nothing while paused: only a
 * recording Meeting reads its screen.
 */
export function SharedScreenLine({ meeting }: { meeting: Meeting }) {
  const t = useT();
  const { chooseScreen, declineScreen, stopScreen, openSettings } = useMeetings.getState();
  const explained = useMeetings((state) => state.screenExplained[meeting.id] ?? false);
  const screen = meeting.screen;
  const language = useLanguage();
  const provider = useSavedProviders((state) =>
    state.providers.find((each) => each.id === screen?.providerId),
  );
  const external = useAppStore((state) => !!state.settings?.device.meetingCallHelpAgentId);
  useEffect(loadSavedProviders, []);
  useEffect(() => {
    if (
      (!explained && screen?.problem !== "denied") ||
      meeting.status !== "recording" ||
      (screen?.permission === "granted" && screen.problem !== "denied")
    )
      return;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        await useMeetings.getState().load();
      } finally {
        pending = false;
      }
    };
    window.addEventListener("focus", refresh);
    const timer = window.setInterval(refresh, 1500);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [explained, meeting.status, screen?.permission, screen?.problem]);
  if (!screen || meeting.status !== "recording") return null;
  const choose = (primary = true): LineAction => ({
    label: t("meetings.screen.choose"),
    testId: "meeting-screen-choose",
    onClick: () => void chooseScreen(meeting.id),
    primary,
  });

  let text: string | null = null;
  let actions: LineAction[] = [];
  let role: "status" | "alert" = "status";
  const decline: LineAction = {
    label: t("meetings.screen.decline"),
    testId: "meeting-screen-decline",
    onClick: () => void declineScreen(meeting.id),
  };
  if (screen.permission === "not-asked" && explained && screen.state !== "reading") {
    // Said before macOS asks for Screen Recording, which reading a window needs.
    text = t("meetings.screen.explain");
    actions = [];
  } else if (screen.state === "ask") {
    text = [
      provider
        ? t("meetings.screen.askProvider", { provider: providerName(provider, t, language) })
        : t("meetings.screen.askModel"),
      ...(external ? [t("meetings.screen.askExternal")] : []),
    ].join(" ");
    actions = [choose(), decline];
  } else if (screen.state === "choosing") {
    text = t("meetings.screen.choosing");
  } else if (screen.state === "reading") {
    const window = screen.window ?? "";
    const model = screen.model;
    // The system's picker doesn't always say which window it gave.
    text =
      model && (model.state === "downloading" || model.state === "not-downloaded")
        ? t(window ? "meetings.screen.downloading" : "meetings.screen.downloadingShared", {
            window,
            percent: String(
              Math.floor((model.downloadedBytes / Math.max(1, model.totalBytes)) * 100),
            ),
            size: formatBytes(model.totalBytes, t),
          })
        : t(window ? "meetings.screen.reading" : "meetings.screen.readingShared", { window });
    actions = [
      {
        label: t("meetings.screen.stop"),
        testId: "meeting-screen-stop",
        onClick: () => void stopScreen(meeting.id),
      },
    ];
  } else if (screen.problem) {
    role = "alert";
    if (screen.problem === "whole-screen") {
      text = t("meetings.screen.wholeScreen");
      actions = [choose()];
    } else if (screen.problem === "denied") {
      text = t("meetings.screen.denied");
      // On macOS, the window is captured with Screen & System Audio Recording, where the computer's sound is.
      actions = isMacOS()
        ? [
            {
              label: t("meetings.line.openSettings.mac"),
              testId: "meeting-screen-settings",
              onClick: () => void openSettings(meeting.id, "system"),
              primary: true,
            },
          ]
        : [choose()];
    } else if (screen.problem === "closed") {
      text = t("meetings.screen.closed");
      actions = [choose()];
    } else {
      text = t("meetings.screen.failed");
      actions = [
        {
          label: t("meetings.screen.retry"),
          testId: "meeting-screen-retry",
          onClick: () => void chooseScreen(meeting.id),
          primary: true,
        },
      ];
    }
  }

  if (text === null) return null;
  return (
    <p
      data-testid="meeting-screen-line"
      data-state={screen.state}
      data-problem={screen.problem ?? undefined}
      role={role}
      className="meeting-screen-line"
    >
      <ScreenLineIcon className="meeting-screen-icon" />
      <span className="meeting-screen-text">
        <span data-testid="meeting-screen-words">{text}</span>
        {actions.map((action) => (
          <Fragment key={action.testId}>
            <span aria-hidden="true"> · </span>
            <button
              type="button"
              data-testid={action.testId}
              onClick={action.onClick}
              className={`meeting-screen-action ${action.primary ? "meeting-screen-action--primary" : ""}`}
            >
              {action.label}
            </button>
          </Fragment>
        ))}
      </span>
    </p>
  );
}
