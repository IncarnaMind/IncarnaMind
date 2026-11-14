import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Meeting, MeetingHelp, MeetingHelpKind, MeetingHelpTemplate } from "../../../core/api";
import type { MessageKey } from "../../../shared/i18n";
import { GENERAL_HELP, MEETING_TEMPLATES, templateLabel } from "../../../shared/meetingHelp";
import {
  type FieldMode,
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
import { LevelBars } from "../components/meetings/LevelBars";
import { MicrophoneButton } from "../components/meetings/MicrophoneButton";
import { ProblemLine } from "../components/ProblemLine";
import { core, files } from "../core";
import { useT } from "../i18n";
import { askHelp, askQuestion, quickNotesHere, useMeetingHelp } from "../meetingHelp";
import { isLive, isWaitingForPermission, useMeetings, useMeetingTime } from "../meetings";
import { clockTime } from "../meetingTime";
import { useAppStore } from "../store";
import { AskBar } from "./AskBar";
import { savedFieldMode, saveFieldMode } from "./fieldMode";
import { type Draft, type QuickNotes, quickNotesFor } from "./quickNotes";
import { Thread } from "./Thread";

declare global {
  interface Window {
    readonly [MEETING_PANEL_BRIDGE_KEY]: MeetingPanelBridge;
  }
}

const bridge = window[MEETING_PANEL_BRIDGE_KEY];

/** The most of the screen's height the panel covers; its thread scrolls inside it (#2925). */
const TALLEST = 0.6;

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

/** The keyboard for the field: taken on a press in it, ⌃⌥N or ⌘K, and given back on Esc or collapse. */
const takeKeyboard = () => bridge.keyboard(true);
const giveKeyboardBack = () => bridge.keyboard(false);

/**
 * The floating panel during a call: above the meeting app, never taking its focus by itself. Its
 * header says the recording and holds the template, collapse and close; then the ask bar with the
 * help prompts and the field for a quick note or a question, and under it the Meeting's thread
 * (#2925). Collapsed, it is a pill with the level bars, which become Stop when pointed at.
 */
export function MeetingPanel() {
  const meeting = useMeetings((state) => state.meetings.find((each) => isLive(each)));
  const [folded, setFolded] = useState(false);
  const [pinned, setPinned] = useState<string[]>([]);
  const [held, setHeld] = useState<HeldKeys>({});
  const [fieldWanted, setFieldWanted] = useState<FieldMode | null>(null);
  const root = useRef<HTMLDivElement>(null);
  // Here, not in the bar, which a collapse unmounts.
  const drafts = useRef(new Map<string, Draft>());
  const meetingId = meeting?.id;
  const [modes, setModes] = useState<Readonly<Record<string, FieldMode>>>({});
  const saved = useMemo(() => (meetingId ? savedFieldMode(meetingId) : "note"), [meetingId]);
  const mode = (meetingId && modes[meetingId]) || saved;
  const chooseMode = useCallback(
    (chosen: FieldMode) => {
      if (!meetingId) return;
      setModes((now) => ({ ...now, [meetingId]: chosen }));
      saveFieldMode(meetingId, chosen);
    },
    [meetingId],
  );
  const notes = useMemo(
    () =>
      meetingId && quickNotesHere()
        ? quickNotesFor(meetingId, core, drafts.current, (error) =>
            useAppStore.getState().reportError(error),
          )
        : null,
    [meetingId],
  );
  // A panel opening again shows the line the core still holds, one its Note refused, unless
  // something is typed already; the bar shows it once it is shown again (`restored`), in Note,
  // as the line is a note.
  const [restored, setRestored] = useState(0);
  useEffect(() => {
    if (!meetingId || !quickNotesHere()) return;
    let current = true;
    core.getQuickNoteDraft(meetingId).then(
      (held) => {
        if (!current || !held || drafts.current.get(meetingId)?.text) return;
        drafts.current.set(meetingId, { text: held.text, began: { ms: held.atMs } });
        chooseMode("note");
        setRestored((now) => now + 1);
      },
      (error: unknown) => useAppStore.getState().reportError(error),
    );
    return () => {
      current = false;
    };
  }, [meetingId, chooseMode]);

  useEffect(() => {
    // The innermost thing open took its Esc already; one left over gives the keyboard back.
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !event.isComposing)
        giveKeyboardBack();
    };
    // The app's Edit menu acts on the field while the panel has the keyboard.
    const focused = () => files.setEditMenu({ text: "field", undo: null, redo: null });
    window.addEventListener("keydown", onEscape);
    window.addEventListener("focus", focused);
    const stop = files.onMenuCommand((command) => {
      if (!(document.activeElement instanceof HTMLTextAreaElement)) return;
      if (command === "edit.undo") document.execCommand("undo");
      if (command === "edit.redo") document.execCommand("redo");
    });
    return () => {
      window.removeEventListener("keydown", onEscape);
      window.removeEventListener("focus", focused);
      stop();
    };
  }, []);

  useEffect(() => {
    if (folded) giveKeyboardBack();
  }, [folded]);

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
        now.includes(help.answerId)
          ? now.filter((each) => each !== help.answerId)
          : [...now, help.answerId],
      ),
    [],
  );
  const fieldTaken = useCallback(() => setFieldWanted(null), []);
  // While a press waits for its help, the Meeting's help is still the one before, which isn't the newest.
  const asking = useMeetingHelp((state) => (meeting ? state.pending[meeting.id] : undefined));
  const latestPinned = !asking && pinned.includes(meeting?.help?.answerId ?? "");
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
        if (command === "note" || command === "ask") {
          setFolded(false);
          setFieldWanted(command);
        }
        const live = meetingRef.current;
        const waiting = live && useMeetingHelp.getState().pending[live.id];
        if (command === "pin" && live?.help && !waiting) togglePin(live.help);
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
          mode={mode}
          onMode={chooseMode}
          fieldWanted={fieldWanted}
          onFieldTaken={fieldTaken}
          notes={notes}
          restored={restored}
          onPin={togglePin}
          onFold={() => setFolded(true)}
        />
      )}
    </div>
  );
}

function stateKey(meeting: Meeting): MessageKey {
  if (isWaitingForPermission(meeting)) return "meetings.bar.waiting";
  return meeting.status === "recording" ? "meetings.bar.recording" : "meetings.bar.paused";
}

function RecordingDot({ meeting }: { meeting: Meeting }) {
  return (
    <span
      aria-hidden="true"
      data-status={isWaitingForPermission(meeting) ? "waiting" : meeting.status}
      className="recording-dot"
    />
  );
}

function RecordingState({ meeting }: { meeting: Meeting }) {
  const t = useT();
  const time = clockTime(useMeetingTime(meeting));
  return (
    <span className="panel-state">
      <RecordingDot meeting={meeting} />
      <b>{t(stateKey(meeting))}</b>
      {!isWaitingForPermission(meeting) && (
        <span role="timer" data-testid="panel-time" className="panel-time">
          {time}
        </span>
      )}
    </span>
  );
}

/** The pill shows the dot and the time; the rest is in its tooltip and accessible name (#2713). */
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
  const time = clockTime(useMeetingTime(meeting));
  const waiting = isWaitingForPermission(meeting);
  const state = t(stateKey(meeting));
  const label = [
    t("meetings.callHelp"),
    waiting ? state : `${state} ${time}`,
    ...(keys ? [t("meetings.panel.keysForHelp", { keys })] : []),
  ].join(" · ");
  return (
    <section aria-label={label} title={label} data-testid="panel-pill" className="panel-pill">
      <span className="panel-drag panel-pill-grip panel-state">
        <RecordingDot meeting={meeting} />
        {meeting.status === "recording" && !waiting ? (
          <span role="timer" data-testid="panel-time" className="panel-time">
            {time}
          </span>
        ) : (
          <span>{state}</span>
        )}
      </span>
      <LevelBars meeting={meeting} onStop={() => void useMeetings.getState().stop(meeting.id)} />
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
  mode,
  onMode,
  fieldWanted,
  onFieldTaken,
  notes,
  restored,
  onPin,
  onFold,
}: {
  meeting: Meeting;
  keys: Partial<Record<MeetingHelpKind, string>>;
  microphoneKeys: string | null;
  pinned: readonly string[];
  mode: FieldMode;
  onMode(mode: FieldMode): void;
  fieldWanted: FieldMode | null;
  onFieldTaken(): void;
  notes: QuickNotes | null;
  restored: number;
  onPin(help: MeetingHelp): void;
  onFold(): void;
}) {
  const t = useT();
  const hidden = useAppStore((state) => state.settings?.device.meetingPanelHidden ?? true);
  const [choosing, setChoosing] = useState(false);
  const [reach, setReach] = useState(0);
  const problem = useMeetings((state) => state.problems[meeting.id]);
  return (
    <section
      aria-label={t("meetings.help.label")}
      style={{
        maxHeight: Math.round(window.screen.availHeight * TALLEST),
        ...(reach > 0 && { minHeight: reach }),
      }}
      className="panel"
    >
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
      <AskBar
        // Another Meeting's field holds that Meeting's own line, and a line restored shows anew.
        key={`${meeting.id}-${restored}`}
        meeting={meeting}
        keys={keys}
        mode={mode}
        onMode={onMode}
        fieldWanted={fieldWanted}
        onAsk={(kind) => void askHelp(meeting, kind)}
        onQuestion={(text) => askQuestion(meeting, text).then((asked) => asked !== null)}
        onReach={setReach}
        onTakeKeyboard={takeKeyboard}
        onFieldTaken={onFieldTaken}
        notes={notes}
      />
      <Thread meeting={meeting} pinned={pinned} onPin={onPin} />
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
