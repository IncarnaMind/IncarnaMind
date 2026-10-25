import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Meeting, MeetingHelp, MeetingHelpKind, MeetingHelpTemplate } from "../../../core/api";
import { GENERAL_HELP, MEETING_TEMPLATES, templateLabel } from "../../../shared/meetingHelp";
import {
  type HeldKeys,
  MEETING_PANEL_BRIDGE_KEY,
  type MeetingPanelBridge,
  SAYS_HIDDEN_FROM_SHARES,
} from "../../../shared/meetingPanel";
import { keysHere } from "../commands/keymap";
import {
  ChevronDownLineIcon,
  CloseLineIcon,
  EyeOffLineIcon,
  MicOffLineIcon,
  MinusLineIcon,
} from "../components/lineIcons";
import { HelpButtons } from "../components/meetings/HelpButtons";
import {
  HelpHeading,
  HelpOutline,
  HelpSuggestion,
  useHelpAnswer,
} from "../components/meetings/HelpSuggestion";
import { LevelBars } from "../components/meetings/LevelBars";
import { MicrophoneButton } from "../components/meetings/MicrophoneButton";
import { ProblemLine } from "../components/ProblemLine";
import { ReadinessExplanation } from "../components/providers/ChatReadinessNotice";
import { core } from "../core";
import { errorMessage } from "../errors";
import { translateNow, useT } from "../i18n";
import { addHelpToNotes, askHelp, useMeetingHelp } from "../meetingHelp";
import { isLive, useMeetings, useMeetingTime } from "../meetings";
import { clockTime } from "../meetingTime";
import { useAppStore } from "../store";

declare global {
  interface Window {
    readonly [MEETING_PANEL_BRIDGE_KEY]: MeetingPanelBridge;
  }
}

const bridge = window[MEETING_PANEL_BRIDGE_KEY];

const ADDED_MS = 6000;

function keyLabels(held: HeldKeys) {
  const labels: Partial<Record<MeetingHelpKind, string>> = {};
  for (const kind of GENERAL_HELP) {
    const keys = held[kind];
    if (keys) labels[kind] = keysHere(keys);
  }
  const first = held.say;
  const run =
    first?.endsWith("+1") &&
    GENERAL_HELP.every((kind, index) => held[kind] === first.replace(/1$/, String(index + 1)))
      ? `${keysHere(first).replace(/1$/, "")}1–${GENERAL_HELP.length}`
      : null;
  return { labels, run };
}

/**
 * The floating panel during a call: above the meeting app, never taking its focus. Its
 * header says the recording and holds the template, collapse and close; then the help buttons,
 * and under them the latest suggestion, which a press replaces unless it is pinned. Collapsed,
 * it is a pill with the level bars, which become Stop when pointed at.
 */
export function MeetingPanel() {
  const meeting = useMeetings((state) => state.meetings.find((each) => isLive(each)));
  const [folded, setFolded] = useState(false);
  const [pinned, setPinned] = useState<MeetingHelp[]>([]);
  const [held, setHeld] = useState<HeldKeys>({});
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void bridge.keys().then(setHeld);
    return bridge.onKeys(setHeld);
  }, []);

  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const tell = () => {
      const box = element.getBoundingClientRect();
      bridge.resize(box.width, box.height);
    };
    tell();
    const observer = new ResizeObserver(tell);
    observer.observe(element);
    return () => observer.disconnect();
  });

  const togglePin = useCallback(
    (help: MeetingHelp) =>
      setPinned((now) =>
        now.some((each) => each.answerId === help.answerId)
          ? now.filter((each) => each.answerId !== help.answerId)
          : [...now, help],
      ),
    [],
  );
  const latestPinned = pinned.some((each) => each.answerId === meeting?.help?.answerId);
  useEffect(() => bridge.state({ folded, pinned: latestPinned }), [folded, latestPinned]);

  const meetingRef = useRef(meeting);
  meetingRef.current = meeting;
  useEffect(() => {
    const stops = [
      bridge.onHelp((kind) => {
        const live = meetingRef.current;
        if (!live) return;
        setFolded(false);
        void askHelp(live, kind);
      }),
      bridge.onCommand((command) => {
        if (command === "fold") setFolded((now) => !now);
        const help = meetingRef.current?.help;
        if (command === "pin" && help) togglePin(help);
      }),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  }, [togglePin]);

  if (!meeting) return null;
  const { labels, run } = keyLabels(held);
  return (
    <div ref={root} data-testid="meeting-panel" data-folded={folded} className="panel-root">
      {folded ? (
        <Pill meeting={meeting} keys={run} onExpand={() => setFolded(false)} />
      ) : (
        <Panel
          meeting={meeting}
          keys={labels}
          microphoneKeys={held.mic ? keysHere(held.mic) : null}
          pinned={pinned}
          onPin={togglePin}
          onFold={() => setFolded(true)}
        />
      )}
    </div>
  );
}

function RecordingState({ meeting, brand = false }: { meeting: Meeting; brand?: boolean }) {
  const t = useT();
  const time = clockTime(useMeetingTime(meeting));
  const recording = meeting.status === "recording";
  return (
    <span className="panel-state">
      <span aria-hidden="true" data-status={meeting.status} className="recording-dot" />
      {brand && <b>IncarnaMind</b>}
      {brand ? (
        <span>
          {t(recording ? "meetings.bar.recording" : "meetings.bar.paused")} {time}
        </span>
      ) : (
        <>
          <b>{t(recording ? "meetings.bar.recording" : "meetings.bar.paused")}</b>
          <span role="timer" data-testid="panel-time" className="panel-time">
            {time}
          </span>
        </>
      )}
    </span>
  );
}

function Pill({
  meeting,
  keys,
  onExpand,
}: {
  meeting: Meeting;
  keys: string | null;
  onExpand(): void;
}) {
  const t = useT();
  return (
    <section aria-label={t("meetings.help.label")} data-testid="panel-pill" className="panel-pill">
      <span className="panel-drag panel-pill-grip">
        <RecordingState meeting={meeting} brand />
      </span>
      <LevelBars meeting={meeting} onStop={() => void useMeetings.getState().stop(meeting.id)} />
      {keys && (
        <kbd data-testid="panel-keys" className="panel-keys">
          {keys}
        </kbd>
      )}
      <button
        type="button"
        data-testid="panel-expand"
        aria-label={t("meetings.panel.expand")}
        title={t("meetings.panel.expand")}
        onClick={onExpand}
        className="panel-icon-button"
      >
        <ChevronDownLineIcon className="size-3.5" />
      </button>
    </section>
  );
}

function Panel({
  meeting,
  keys,
  microphoneKeys,
  pinned,
  onPin,
  onFold,
}: {
  meeting: Meeting;
  keys: Partial<Record<MeetingHelpKind, string>>;
  microphoneKeys: string | null;
  pinned: readonly MeetingHelp[];
  onPin(help: MeetingHelp): void;
  onFold(): void;
}) {
  const t = useT();
  const hidden = useAppStore((state) => state.settings?.device.meetingPanelHidden ?? true);
  const [choosing, setChoosing] = useState(false);
  const problem = useMeetings((state) => state.problems[meeting.id]);
  const help = meeting.help;
  const shownPinned = pinned.filter((each) => each.answerId !== help?.answerId);
  return (
    <section aria-label={t("meetings.help.label")} className="panel">
      <header className="panel-header panel-drag">
        <RecordingState meeting={meeting} />
        <MicrophoneButton
          meeting={meeting}
          testId="panel-mic"
          className="panel-icon-button"
          keys={microphoneKeys}
        />
        <button
          type="button"
          data-testid="panel-template"
          aria-expanded={choosing}
          title={t("meetings.template.title")}
          onClick={() => setChoosing(!choosing)}
          className="panel-template"
        >
          {meeting.helpTemplate
            ? t(templateLabel(meeting.helpTemplate))
            : t("meetings.template.chip")}
          <ChevronDownLineIcon className="size-3" />
        </button>
        <span className="grow" />
        <button
          type="button"
          data-testid="panel-collapse"
          aria-label={t("meetings.panel.collapse")}
          title={t("meetings.panel.collapse")}
          onClick={onFold}
          className="panel-icon-button"
        >
          <MinusLineIcon className="size-3.5" />
        </button>
        <button
          type="button"
          data-testid="panel-close"
          aria-label={t("meetings.panel.close")}
          title={t("meetings.panel.close")}
          onClick={() => bridge.close()}
          className="panel-icon-button"
        >
          <CloseLineIcon className="size-3.5" />
        </button>
      </header>
      {meeting.microphonePausedAtMs !== null && (
        <p role="status" data-testid="panel-mic-line" className="panel-subline">
          <MicOffLineIcon className="size-3.5 shrink-0" />
          <b>{t("meetings.mic.pausedSince", { time: clockTime(meeting.microphonePausedAtMs) })}</b>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            data-testid="panel-mic-resume"
            onClick={() => void useMeetings.getState().setMicrophonePaused(meeting.id, false)}
            className="panel-link"
          >
            {t("meetings.mic.resumeLine")}
          </button>
        </p>
      )}
      {problem && (
        <ProblemLine testId="panel-problem" className="px-3.5 pb-2">
          {problem}
        </ProblemLine>
      )}
      {choosing && (
        <TemplateChoice
          meeting={meeting}
          onChosen={() => {
            setChoosing(false);
          }}
        />
      )}
      {SAYS_HIDDEN_FROM_SHARES && hidden && (
        <p data-testid="panel-hidden" className="panel-hidden">
          <EyeOffLineIcon className="size-3 shrink-0" />
          <span>{t("meetings.panel.hidden")}</span>
        </p>
      )}
      <HelpButtons
        meeting={meeting}
        layout="grid"
        keys={keys}
        onPress={(kind) => void askHelp(meeting, kind)}
      />
      {shownPinned.map((each) => (
        <Suggestion key={each.answerId} meeting={meeting} help={each} pinned onPin={onPin} />
      ))}
      <Latest
        meeting={meeting}
        pinned={pinned.some((each) => each.answerId === help?.answerId)}
        onPin={onPin}
      />
    </section>
  );
}

function TemplateChoice({ meeting, onChosen }: { meeting: Meeting; onChosen(): void }) {
  const t = useT();
  const choose = (template: MeetingHelpTemplate | null) => {
    onChosen();
    core
      .setMeetingTemplate({ meetingId: meeting.id, template })
      .catch((error: unknown) => useAppStore.getState().reportError(error));
  };
  const options: (MeetingHelpTemplate | null)[] = [null, ...MEETING_TEMPLATES];
  return (
    <fieldset aria-label={t("meetings.template.title")} className="panel-templates">
      {options.map((template) => (
        <button
          key={template ?? "none"}
          type="button"
          data-testid="panel-template-option"
          data-template={template ?? "none"}
          aria-pressed={meeting.helpTemplate === template}
          onClick={() => choose(template)}
          className="panel-template-option"
        >
          {template ? t(templateLabel(template)) : t("meetings.template.none")}
        </button>
      ))}
    </fieldset>
  );
}

function Latest({
  meeting,
  pinned,
  onPin,
}: {
  meeting: Meeting;
  pinned: boolean;
  onPin(help: MeetingHelp): void;
}) {
  const t = useT();
  const pending = useMeetingHelp((state) => state.pending[meeting.id]);
  const blocked = useMeetingHelp((state) => state.blocked[meeting.id]);
  if (pending) {
    return (
      <div className="panel-suggestion" data-testid="help-pending">
        <HelpHeading kind={pending} />
        <HelpOutline count={2} />
      </div>
    );
  }
  if (blocked) {
    return (
      <div className="panel-suggestion">
        {"readiness" in blocked ? (
          <p data-testid="help-set-up" className="panel-line">
            {blocked.readiness.reason === "no-provider" ? (
              t("meetings.help.setUp")
            ) : (
              <ReadinessExplanation readiness={blocked.readiness} inLine />
            )}
            <span aria-hidden="true"> · </span>
            <button type="button" onClick={() => bridge.setUp()} className="panel-link">
              {t("providers.readiness.setUp")}
            </button>
          </p>
        ) : (
          <p role="alert" data-testid="help-problem" className="panel-line">
            {blocked.message}
          </p>
        )}
      </div>
    );
  }
  if (!meeting.help) return null;
  return <Suggestion meeting={meeting} help={meeting.help} pinned={pinned} onPin={onPin} />;
}

function Suggestion({
  meeting,
  help,
  pinned,
  onPin,
}: {
  meeting: Meeting;
  help: MeetingHelp;
  pinned: boolean;
  onPin(help: MeetingHelp): void;
}) {
  const t = useT();
  const answer = useHelpAnswer(help);
  const [added, setAdded] = useState<{ blockIds: string[] } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!added) return;
    const timer = setTimeout(() => setAdded(null), ADDED_MS);
    return () => clearTimeout(timer);
  }, [added]);
  if (!answer) {
    return (
      <div className="panel-suggestion">
        <HelpHeading kind={help.kind} heard={help.heard} />
        <HelpOutline count={2} />
      </div>
    );
  }
  const addToNotes = async () => {
    setProblem(null);
    try {
      const { blockIds } = await addHelpToNotes(meeting, help);
      setAdded({ blockIds });
    } catch (error) {
      setProblem(errorMessage(error, translateNow));
    }
  };
  const undoAdd = (blockIds: string[]) => {
    setAdded(null);
    core
      .undoAddToNote({ mindId: meeting.mindId, blockIds })
      .catch((error: unknown) => setProblem(errorMessage(error, translateNow)));
  };
  return (
    <div className="panel-suggestion" data-pinned={pinned}>
      <HelpSuggestion
        help={help}
        answer={answer}
        onRetry={() => void askHelp(meeting, help.kind)}
      />
      {answer.status === "done" && (
        <div className="panel-actions">
          <button
            type="button"
            data-testid="help-pin"
            aria-pressed={pinned}
            onClick={() => onPin(help)}
            className="panel-ghost"
          >
            {t(pinned ? "meetings.help.unpin" : "meetings.help.pin")}
          </button>
          {added ? (
            <p role="status" data-testid="help-added" className="panel-line">
              {t("meetings.help.added")}
              <span aria-hidden="true"> · </span>
              <button type="button" onClick={() => undoAdd(added.blockIds)} className="panel-link">
                {t("move.undo")}
              </button>
            </p>
          ) : (
            <button
              type="button"
              data-testid="help-add"
              onClick={() => void addToNotes()}
              className="panel-ghost"
            >
              {t("meetings.help.addToNotes")}
            </button>
          )}
        </div>
      )}
      {problem && (
        <p role="alert" className="panel-line">
          {problem}
        </p>
      )}
    </div>
  );
}
