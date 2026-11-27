import {
  type CSSProperties,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { create } from "zustand";
import { useChecks } from "../checks";
import {
  CheckLineIcon,
  CheckMarkIcon,
  ClaimMarkIcon,
  NotYetCitedIcon,
  StopLineIcon,
} from "../components/icons";
import { useT } from "../i18n";
import type { NoteStateMark } from "../noteState";
import type { CheckButtonView } from "./checkButtonState";
import { useCardPlace } from "./checkPlace";

/** The state's mark, as the margin draws the worst thing it found. */
function StateMark({ mark }: { mark: NoteStateMark }) {
  switch (mark) {
    case "checked":
      return <CheckMarkIcon check="found" className="note-check-mark" />;
    case "contradicted":
      return <ClaimMarkIcon state="contradicted" className="note-check-mark" />;
    case "unsupported":
      return <ClaimMarkIcon state="unsupported" className="note-check-mark" />;
    case "notFound":
      return <CheckMarkIcon check="not-found" className="note-check-mark" />;
    case "recheck":
      return <ClaimMarkIcon state="needs-recheck" className="note-check-mark" />;
    case "notChecked":
      return <ClaimMarkIcon state="not-checked" className="note-check-mark" />;
    case "notYetCited":
      return <NotYetCitedIcon className="note-check-mark note-check-mark--wide" />;
  }
}

function Mark({ mark }: { mark: CheckButtonView["mark"] }) {
  if (mark === "check") return <CheckLineIcon className="note-check-mark" />;
  if (mark === "running") return <span aria-hidden="true" className="note-check-dot" />;
  return <StateMark mark={mark} />;
}

/**
 * The widest the Check and its Stop have been since a run began, while it is `held`: a run's words
 * changing, its Stop going and the result it ends in move nothing beside them until the User types
 * (#2519).
 */
function useHeldWidth(room: RefObject<HTMLElement | null>, held: boolean): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!held) {
      if (width !== null) setWidth(null);
      return;
    }
    const now = room.current?.offsetWidth ?? 0;
    if (now > (width ?? 0)) setWidth(now);
  });
  return width;
}

/**
 * The Note's Check (#3794): the word Check and the sentences not checked yet, dark while they
 * wait, which checks in one press; while it runs, how far it has got, with Stop; then what the
 * check found, which opens the Checks card. The tab strip's row and the line above the Note's input
 * show the same one.
 */
export function CheckButton({
  view,
  open,
  onPress,
  onStop,
  place,
}: {
  view: CheckButtonView;
  open: boolean;
  onPress(from: HTMLElement): void;
  onStop: (() => void) | null;
  place: "strip" | "line";
}) {
  const t = useT();
  const room = useRef<HTMLSpanElement>(null);
  const held = useHeldWidth(room, view.fresh);
  const opensCard = view.kind !== "check";
  return (
    <span
      ref={room}
      className="note-check"
      data-testid={place === "strip" ? "note-check-place" : "note-check-line"}
      data-place={place}
      data-running={view.kind === "checking" ? "" : undefined}
      style={held === null ? undefined : ({ "--note-check-held": `${held}px` } as CSSProperties)}
    >
      <button
        type="button"
        data-testid="note-check"
        data-state={view.kind}
        data-tone={view.tone}
        title={view.title === "" ? undefined : view.title}
        aria-haspopup={opensCard ? "dialog" : undefined}
        aria-expanded={opensCard ? open : undefined}
        className="note-check-button"
        onClick={(event) => onPress(event.currentTarget)}
      >
        <Mark mark={view.mark} />
        <span className="note-check-words">{view.words}</span>
        {view.count !== null && <span className="note-check-count">{view.count}</span>}
        {view.short !== null && (
          <span aria-hidden="true" className="note-check-short">
            {view.short}
          </span>
        )}
      </button>
      {onStop && (
        <button
          type="button"
          data-testid="note-check-stop"
          aria-label={t("checks.stop")}
          title={t("checks.stop")}
          className="note-check-stop"
          onClick={onStop}
        >
          <StopLineIcon className="size-3.5" />
        </button>
      )}
    </span>
  );
}

/** What a tab's Check button is now, for the line above that tab's input. */
interface ShownCheck {
  view: CheckButtonView;
  /** A run is on that the button's Stop stops. */
  stoppable: boolean;
}

const useShownChecks = create<{ byPlace: Readonly<Record<string, ShownCheck>> }>(() => ({
  byPlace: {},
}));

/** What each tab's Check button does, by its place: read at the press, so it draws nothing. */
const pressesByPlace = new Map<
  string,
  { press(from: HTMLElement): void; stop: (() => void) | null }
>();

/** Where the Checks card opens from, by place, when that is not the tab strip's button. */
export const useCheckCardFrom = create<{ byPlace: Readonly<Record<string, HTMLElement>> }>(() => ({
  byPlace: {},
}));

export function setCheckCardFrom(place: string, from: HTMLElement | null): void {
  useCheckCardFrom.setState(({ byPlace }) => {
    if ((byPlace[place] ?? null) === from) return { byPlace };
    const next = { ...byPlace };
    if (from) next[place] = from;
    else delete next[place];
    return { byPlace: next };
  });
}

/** The tab strip's Check button, shown on the line above the input too (`CheckOnLine`). */
export function useShareCheckButton(
  place: string,
  shown: ShownCheck | null,
  press: (from: HTMLElement) => void,
  stop: (() => void) | null,
): void {
  useLayoutEffect(() => {
    pressesByPlace.set(place, { press, stop });
  });
  const key = shown === null ? "" : JSON.stringify(shown);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for what is shown.
  useLayoutEffect(() => {
    useShownChecks.setState(({ byPlace }) => {
      const next = { ...byPlace };
      if (shown) next[place] = shown;
      else delete next[place];
      return { byPlace: next };
    });
  }, [place, key]);
  useEffect(
    () => () => {
      pressesByPlace.delete(place);
      useShownChecks.setState(({ byPlace }) => {
        const { [place]: _gone, ...rest } = byPlace;
        return { byPlace: rest };
      });
    },
    [place],
  );
}

/**
 * The same Check on the line that says what the User's AI just wrote, beside Undo (#3794): the User
 * is looking there. It shows while sentences wait, through the run, and with what the run found
 * until the User types.
 */
export function CheckOnLine({ mindId }: { mindId: string }) {
  const place = useCardPlace(mindId);
  const shown = useShownChecks((state) => state.byPlace[place]);
  const open = useChecks((state) => state.cardOpen[place] === true);
  const fromHere = useCheckCardFrom((state) => state.byPlace[place] !== undefined);
  if (!shown || (shown.view.kind !== "check" && !shown.view.fresh)) return null;
  return (
    <CheckButton
      view={shown.view}
      open={open && fromHere}
      place="line"
      onPress={(from) => pressesByPlace.get(place)?.press(from)}
      onStop={shown.stoppable ? () => pressesByPlace.get(place)?.stop?.() : null}
    />
  );
}
