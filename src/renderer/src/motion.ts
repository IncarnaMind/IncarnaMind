/**
 * How the window moves (DESIGN.md, Motion): the one module that animates.
 * Every screen moves through these helpers, with the design's tokens, and
 * nothing else imports the Motion library (Biome enforces it). The rules
 * they keep:
 *
 * - Only transform and opacity animate (`Keyframes` can't name anything
 *   else): a thing is laid out at its new place and size at once, and its box
 *   moves there by transform.
 * - Nothing waits for an animation: no helper returns anything to await. A
 *   click during an animation reaches the new state, and what leaves is a copy
 *   in a layer that can't be clicked, focused or found, so the real element
 *   is gone at once.
 * - Reduced (the system's Reduce motion, or Settings) swaps movement for short
 *   fades; Off makes every change instant. If an animation can't run, the
 *   change is instant and the failure is logged.
 *
 * The `plan…` functions say what each helper animates in a mode, and touch no
 * DOM; the helpers apply them.
 */
import { type AnimationOptions, type AnimationPlaybackControlsWithThen, animate } from "motion";
import { type RefObject, useLayoutEffect, useRef } from "react";
import type { MotionPreference } from "../../core/api";
import { typesText } from "./undo";

// Tokens (DESIGN.md, Motion, Tokens) ------------------------------------------

/** A spring as the design gives it: how long it looks, in seconds, and how much it bounces. */
export interface SpringToken {
  readonly visualDuration: number;
  readonly bounce: number;
}

export const spring = {
  /** Small things: menus, popovers, tabs, rows, chips, checks. */
  snappy: { visualDuration: 0.24, bounce: 0 },
  /** Panels and layout: the assistant, the sidebar, groups, proposals, the change card, scrolling. */
  smooth: { visualDuration: 0.34, bounce: 0 },
  /** A release after a drag: a tab, a row, the assistant. */
  drop: { visualDuration: 0.4, bounce: 0.22 },
} as const satisfies Record<string, SpringToken>;

export type SpringName = keyof typeof spring;

export interface FadeToken {
  /** Seconds. */
  readonly duration: number;
  readonly ease: "easeIn" | "easeOut";
}

/** `fade`: entering opacity, streamed words, reduced-motion cross-fades of panels. */
export const fade: FadeToken = { duration: 0.2, ease: "easeOut" };
/** `fade.quick`: exits, and reduced-motion cross-fades of small things. */
export const fadeQuick: FadeToken = { duration: 0.12, ease: "easeIn" };

export interface PhysicsSpring {
  type: "spring";
  stiffness: number;
  damping: number;
  mass: 1;
  /** Units per second; left out, a retarget keeps the velocity the value has. */
  velocity?: number;
}

/**
 * The same spring as stiffness and damping (mass 1), resolved from its
 * visual duration and bounce as Motion resolves them. Every spring here runs
 * in this form: Motion ignores `velocity` for a spring given by duration and
 * bounce, and a release after a drag, or a retarget, must keep it.
 */
export function physics(token: SpringToken, velocity?: number): PhysicsSpring {
  const root = (2 * Math.PI) / (token.visualDuration * 1.2);
  return {
    type: "spring",
    stiffness: root * root,
    damping: 2 * (1 - token.bounce) * root,
    mass: 1,
    ...(velocity === undefined ? {} : { velocity }),
  };
}

/** A thing growing from its source starts at this scale, this many pixels toward it. */
export const SOURCE_SCALE = 0.96;
export const SOURCE_SHIFT = 4;

// Modes -----------------------------------------------------------------------

export type MotionMode = "on" | "reduced" | "off";

/** The mode in effect for a preference: until the User chooses, the system's Reduce motion picks. */
export const resolveMotion = (preference: MotionPreference, systemReduces: boolean): MotionMode =>
  preference === "system" ? (systemReduces ? "reduced" : "on") : preference;

// Plans: what each helper animates in each mode -------------------------------

/** What animates, from the first value to the second: only transform (x, y, scale) and opacity. */
export type Keyframes = Partial<Record<"x" | "y" | "scale" | "opacity", readonly [number, number]>>;

export interface Plan {
  keyframes: Keyframes;
  transition: AnimationOptions;
}

/** Where a thing is, relative to where it rests: moved by x and y pixels, at a scale. */
export interface Offset {
  x?: number;
  y?: number;
  scale?: number;
}

interface Pose {
  x: number;
  y: number;
  scale: number;
  opacity: number;
}

const REST: Pose = { x: 0, y: 0, scale: 1, opacity: 1 };

/** `base`, with what `change` gives instead (a value left undefined keeps the base's). */
const posed = (base: Pose, change: Partial<Pose>): Pose => ({
  x: change.x ?? base.x,
  y: change.y ?? base.y,
  scale: change.scale ?? base.scale,
  opacity: change.opacity ?? base.opacity,
});

/** The transform keyframes between two poses, for what differs. */
function between(from: Pose, to: Pose): Keyframes {
  const keyframes: Keyframes = {};
  for (const key of ["x", "y", "scale"] as const) {
    if (from[key] !== to[key]) keyframes[key] = [from[key], to[key]];
  }
  return keyframes;
}

const tween = (token: FadeToken, delay = 0) => ({ ...token, delay });

/**
 * A live dot's breath: its opacity eases down to 0.45 and back, 1.6 s a round, for as long as it
 * lives. Reduced keeps it, as DESIGN.md has it; Off stills it.
 */
export function planBreathe(mode: MotionMode): Plan | null {
  if (mode === "off") return null;
  return {
    keyframes: { opacity: [1, 0.45] },
    transition: {
      duration: 0.8,
      ease: "easeInOut",
      repeat: Number.POSITIVE_INFINITY,
      repeatType: "reverse",
    },
  };
}

/**
 * Entering from an offset: On, a spring there with the opacity fading in;
 * Reduced, the fade alone; Off, nothing (it is simply there).
 */
export function planEnter(
  mode: MotionMode,
  from: Offset,
  { spring: name = "snappy", delay = 0 }: { spring?: SpringName; delay?: number } = {},
): Plan | null {
  if (mode === "off") return null;
  const opacity = tween(fade, delay);
  if (mode === "reduced") return { keyframes: { opacity: [0, 1] }, transition: opacity };
  return {
    keyframes: { opacity: [0, 1], ...between(posed(REST, from), REST) },
    // From rest: a velocity left over from an earlier animation would overshoot.
    transition: { ...physics(spring[name], 0), delay, opacity },
  };
}

/**
 * Leaving toward an offset, from where it is now (`from`, e.g. half way in):
 * On, moving there while it fades (`fade.quick`); Reduced, the fade alone;
 * Off, nothing (it is simply gone).
 */
export function planExit(mode: MotionMode, to: Offset, from: Partial<Pose> = {}): Plan | null {
  if (mode === "off") return null;
  const start = posed(REST, from);
  const opacity: Keyframes = { opacity: [start.opacity, 0] };
  if (mode === "reduced") return { keyframes: opacity, transition: tween(fadeQuick) };
  return {
    keyframes: { ...opacity, ...between(start, posed(start, to)) },
    transition: tween(fadeQuick),
  };
}

/**
 * Moving to a new place, from `delta` away (the old place less the new): On,
 * a spring, with `velocity` if given (a release), or else keeping the velocity
 * of a move it interrupts; Reduced and Off, nothing, as what moves is placed
 * at once.
 */
export function planMove(
  mode: MotionMode,
  delta: { x: number; y: number },
  {
    spring: name = "snappy",
    velocity,
  }: { spring?: SpringName; velocity?: { x: number; y: number } } = {},
): Plan | null {
  if (mode !== "on") return null;
  const keyframes: Keyframes = {};
  const transition: { x?: PhysicsSpring; y?: PhysicsSpring } = {};
  for (const axis of ["x", "y"] as const) {
    if (Math.abs(delta[axis]) < 0.5) continue;
    keyframes[axis] = [delta[axis], 0];
    transition[axis] = physics(spring[name], velocity?.[axis]);
  }
  return keyframes.x || keyframes.y ? { keyframes, transition } : null;
}

/**
 * A release after a drag, from where it was let go: On, `spring.drop` with
 * the pointer's velocity; Reduced, it fades in where it lands (a panel with
 * `fade`, anything smaller with `fade.quick`); Off, nothing.
 */
export function planRelease(
  mode: MotionMode,
  delta: { x: number; y: number },
  velocity: { x: number; y: number },
  { panel = false }: { panel?: boolean } = {},
): Plan | null {
  if (mode === "reduced") {
    return { keyframes: { opacity: [0, 1] }, transition: tween(panel ? fade : fadeQuick) };
  }
  return planMove(mode, delta, { spring: "drop", velocity });
}

/**
 * When each of `count` new items enters, `step` seconds apart, the first
 * `max` only; the rest (null) are there at once.
 */
export function staggerDelays(count: number, step = 0.015, max = 12): (number | null)[] {
  return Array.from({ length: count }, (_, index) => (index < max ? index * step : null));
}

// Geometry ----------------------------------------------------------------------

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Which way to `source` from `box`, as the edge that faces it. */
export interface Toward {
  /** The point on that edge nearest the source, as a CSS transform-origin. */
  origin: string;
  /** A few pixels toward the source. */
  x: number;
  y: number;
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const px = (value: number) => `${Math.round(value * 10) / 10}px`;

/**
 * The edge of `box` that faces `source` (above, below, or to a side, else by
 * their centres) and the point on it nearest the source's centre. With no
 * source, the top edge's middle.
 */
export function towardSource(box: Box, source: Box | null): Toward {
  if (!source) return { origin: `50% 0px`, x: 0, y: -SOURCE_SHIFT };
  const centreX = clamp(source.left + source.width / 2 - box.left, 0, box.width);
  const centreY = clamp(source.top + source.height / 2 - box.top, 0, box.height);
  const sourceBottom = source.top + source.height;
  const sourceRight = source.left + source.width;
  const sideways = box.left >= sourceRight - 1 || box.left + box.width <= source.left + 1;
  const stacked = box.top >= sourceBottom - 1 || box.top + box.height <= source.top + 1;
  if (sideways && !stacked) {
    const right = box.left >= sourceRight - 1;
    return {
      origin: `${right ? "0px" : px(box.width)} ${px(centreY)}`,
      x: right ? -SOURCE_SHIFT : SOURCE_SHIFT,
      y: 0,
    };
  }
  const below = stacked
    ? box.top >= sourceBottom - 1
    : box.top + box.height / 2 >= source.top + source.height / 2;
  return {
    origin: `${px(centreX)} ${below ? "0px" : px(box.height)}`,
    x: 0,
    y: below ? -SOURCE_SHIFT : SOURCE_SHIFT,
  };
}

/**
 * A panel's box at `progress` of its move from `from` to `to`, as a transform
 * of the box laid out at `to` (origin top left): moved by x and y, scaled by
 * scaleX and scaleY. Its content takes the inverse scale, so it keeps its size.
 */
export function frameAt(from: Box, to: Box, progress: number) {
  const along = (a: number, b: number) => a + (b - a) * progress;
  return {
    x: along(from.left, to.left) - to.left,
    y: along(from.top, to.top) - to.top,
    scaleX: Math.max(0.02, along(from.width, to.width) / to.width),
    scaleY: Math.max(0.02, along(from.height, to.height) / to.height),
  };
}

// Running animations ------------------------------------------------------------

/** The longest anything here takes to settle, with room: past it, an animation counts as over. */
const CEILING_MS = 2000;

let preference: MotionPreference = "system";
let mode: MotionMode = "on";
let speed = 1;
const listeners = new Set<() => void>();
/** What runs now, and how each one ends: so the tests can wait for it, and Off can finish it. */
const running = new Map<AnimationPlaybackControlsWithThen, () => void>();
/** Leaving copies taken, to start in the next frame. */
let pending = 0;
/** The latest animation of each element, which a newer one replaces. */
const latest = new WeakMap<Element, AnimationPlaybackControlsWithThen>();
/** Where each thing entered from, for its exit when its source has gone. */
const sources = new WeakMap<Element, Toward>();

const REDUCE_QUERY = "(prefers-reduced-motion: reduce)";

/** The mode in effect: the User's choice, or until they choose, the system's. */
export const motionMode = (): MotionMode => mode;

/** Calls `listener` when the mode changes; returns how to stop. */
export function subscribeMotion(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function update(): void {
  const next = resolveMotion(preference, window.matchMedia(REDUCE_QUERY).matches);
  document.documentElement.dataset.motion = next;
  if (next === mode) return;
  mode = next;
  // Off: whatever is moving is where it was going, at once.
  if (next === "off") for (const [controls] of running) controls.complete();
  for (const listener of listeners) listener();
}

/** Follows the system's Reduce motion, and says the mode on <html data-motion> for styles.css. */
export function installMotion(): void {
  window.matchMedia(REDUCE_QUERY).addEventListener("change", update);
  document.addEventListener("focusout", discardRetired);
  update();
}

/** The User's choice in Settings, or "system". */
export function setMotionPreference(next: MotionPreference): void {
  preference = next;
  update();
}

/** How many animations are running, leaving copies included: the tests wait for none. */
export const motionRunning = (): number => running.size + pending;

/** Plays every animation at this speed (0.25: four times slower), for tests and recordings. */
export function setMotionSpeed(next: number): void {
  speed = next;
  for (const [controls] of running) controls.speed = next;
}

function report(error: unknown): void {
  // Nothing in the window can act on it: logged with the rest (errorLog.ts), and the change shows at once.
  window.reportError(
    new Error("An animation couldn't run, so the change was shown at once.", { cause: error }),
  );
}

/** Writes a pose as Motion will, so the first frame shows it before Motion's first render. */
function pose(element: HTMLElement, keyframes: Keyframes): void {
  const first = (key: keyof Keyframes) => keyframes[key]?.[0];
  const x = first("x");
  const y = first("y");
  const scale = first("scale");
  const opacity = first("opacity");
  const transform = [
    x === undefined ? "" : `translateX(${x}px)`,
    y === undefined ? "" : `translateY(${y}px)`,
    scale === undefined ? "" : `scale(${scale})`,
  ].join(" ");
  if (transform.trim()) element.style.transform = transform.trim();
  if (opacity !== undefined) element.style.opacity = String(opacity);
}

/** At rest again: the styles Motion leaves behind are taken off, so the element's own CSS holds. */
function tidy(element: HTMLElement): void {
  if (element.style.opacity === "1") element.style.removeProperty("opacity");
  if (element.style.transform === "none") element.style.removeProperty("transform");
  element.style.removeProperty("transform-origin");
}

/**
 * Counts `controls` as running until it settles, or until its end in
 * `running` is called (a newer animation replaced it); then `done` runs, once.
 */
function track(controls: AnimationPlaybackControlsWithThen, done: () => void): void {
  controls.speed = speed;
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    running.delete(controls);
    done();
  };
  running.set(controls, end);
  // An animation stopped by a newer one may never settle its promise: the ceiling ends it then.
  controls.finished.then(end, end);
  window.setTimeout(end, CEILING_MS / Math.min(1, speed));
}

/** Back to the elements' own styles, as if they had never moved (`opacity`: or faded). */
function unstyle(elements: readonly HTMLElement[], opacity = true): void {
  for (const element of elements) {
    if (opacity) element.style.removeProperty("opacity");
    element.style.removeProperty("transform");
    element.style.removeProperty("transform-origin");
  }
}

function haltUncounted(element: HTMLElement): void {
  const previous = latest.get(element);
  if (!previous) return;
  previous.stop();
  running.get(previous)?.();
}

/**
 * Runs `plan` on `element`. A newer animation of the same element replaces
 * it and starts from where it is; `done` runs when it settles, or is replaced.
 */
function run(element: HTMLElement, plan: Plan, origin?: string, done?: () => void): void {
  try {
    if (origin) element.style.transformOrigin = origin;
    pose(element, plan.keyframes);
    const controls = animate(element, plan.keyframes, {
      ...plan.transition,
      // This module decides, by the mode: Motion would otherwise follow the system's setting alone.
      reduceMotion: false,
    });
    // The one it replaces ends uncounted, leaving its styles to this one.
    const previous = latest.get(element);
    latest.set(element, controls);
    if (previous) running.get(previous)?.();
    track(controls, () => {
      if (latest.get(element) === controls) {
        latest.delete(element);
        tidy(element);
      }
      done?.();
    });
  } catch (error) {
    unstyle([element]);
    done?.();
    report(error);
  }
}

const boxOf = (rect: DOMRectReadOnly | Box): Box => ({
  left: rect.left,
  top: rect.top,
  width: rect.width,
  height: rect.height,
});

/** What a source is, as a box: an element's (if it's still on screen), or the box given. */
function sourceBox(source: Element | Box | null | undefined): Box | null {
  if (!source) return null;
  if (!(source instanceof Element)) return source;
  if (!source.isConnected) return null;
  const rect = source.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0 ? boxOf(rect) : null;
}

// Leaving copies ----------------------------------------------------------------

let layer: { host: HTMLElement; root: ShadowRoot; sheets: number } | null = null;

/**
 * Where leaving copies fade: a closed shadow root, so nothing can query them,
 * in an inert, pointer-less popover, so nothing can click or focus them, raised
 * to the top layer each time, so they show over any dialog or menu open.
 */
function leavingLayer(): ShadowRoot {
  if (!layer) {
    const host = document.createElement("div");
    host.setAttribute("popover", "manual");
    host.setAttribute("aria-hidden", "true");
    host.inert = true;
    Object.assign(host.style, {
      position: "fixed",
      inset: "0 auto auto 0",
      width: "0",
      height: "0",
      margin: "0",
      padding: "0",
      border: "0",
      background: "transparent",
      overflow: "visible",
      pointerEvents: "none",
    });
    document.body.append(host);
    layer = { host, root: host.attachShadow({ mode: "closed" }), sheets: -1 };
  }
  // The app's styles, so a copy looks as it did, read again when a stylesheet has come since.
  if (layer.sheets !== document.styleSheets.length) {
    let css = "";
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        for (const rule of Array.from(sheet.cssRules)) css += `${rule.cssText}\n`;
      } catch {
        // A stylesheet from another origin can't be read; the app has none of its own there.
      }
    }
    const styles = new CSSStyleSheet();
    styles.replaceSync(
      `${css}\n* { pointer-events: none !important; user-select: none !important; }`,
    );
    layer.root.adoptedStyleSheets = [styles];
    layer.sheets = document.styleSheets.length;
  }
  if (layer.host.matches(":popover-open")) layer.host.hidePopover();
  layer.host.showPopover();
  return layer.root;
}

/** A still copy of `element` as it shows now, at `box`, carrying the text's look it inherited. */
function copyOf(element: HTMLElement, box: Box): HTMLElement {
  const style = getComputedStyle(element);
  const frame = document.createElement("div");
  Object.assign(frame.style, {
    position: "fixed",
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${box.width}px`,
    height: `${box.height}px`,
    margin: "0",
    color: style.color,
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    lineHeight: style.lineHeight,
    letterSpacing: style.letterSpacing,
    direction: style.direction,
  });
  const copy = element.cloneNode(true) as HTMLElement;
  copy.removeAttribute("popover");
  copy.removeAttribute("id");
  Object.assign(copy.style, {
    position: "absolute",
    inset: "0",
    margin: "0",
    width: "100%",
    height: "100%",
    minWidth: "0",
    minHeight: "0",
    maxWidth: "none",
    maxHeight: "none",
    transform: "none",
    translate: "none",
    scale: "none",
    opacity: "1",
    visibility: "visible",
    display: style.display === "none" ? "block" : style.display,
  });
  frame.append(copy);
  return frame;
}

/** Finished copies still on the page because the User is typing: see `retire`. Oldest first. */
const retiring = new Set<HTMLElement>();
/** More than this many and the oldest go at once: a long stay in one field mustn't pile them up. */
const MOST_RETIRING = 16;

function discard(copy: HTMLElement): void {
  copy.remove();
  if (layer && !layer.root.childElementCount && layer.host.matches(":popover-open")) {
    layer.host.hidePopover();
  }
}

/**
 * Takes a finished leaving copy off the page. Chromium ends the run of typing that Undo takes back
 * as one whenever a node leaves the page, any node (FrameSelection::NodeWillBeRemoved), so while the
 * User is in a field that takes text the copy only hides, and goes once the focus has left it (#1140).
 */
function retire(copy: HTMLElement): void {
  if (!typesText(document.activeElement)) {
    discard(copy);
    return;
  }
  copy.style.display = "none";
  retiring.add(copy);
  for (const oldest of retiring) {
    if (retiring.size <= MOST_RETIRING) break;
    retiring.delete(oldest);
    discard(oldest);
  }
}

function discardRetired(event: FocusEvent): void {
  if (typesText(event.relatedTarget)) return;
  for (const copy of retiring) discard(copy);
  retiring.clear();
}

/**
 * Takes a copy of `element` as it shows now, to leave toward `to`, or
 * (`source`) toward what it came from; returns what plays it, or null when
 * nothing would show (Off, or nothing on screen).
 */
function leaving(
  element: HTMLElement,
  how: { source?: Element | Box | null; to?: Offset; origin?: string },
): (() => void) | null {
  const current = mode;
  if (current === "off" || !element.isConnected) return null;
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const opacity = Number(style.opacity);
  if (rect.width < 1 || rect.height < 1 || style.visibility === "hidden" || opacity < 0.01) {
    return null;
  }
  const box = boxOf(rect);
  const at = sourceBox(how.source);
  const toward = how.to
    ? null
    : at
      ? towardSource(box, at)
      : (sources.get(element) ?? towardSource(box, null));
  const to = how.to ?? (toward ? { x: toward.x, y: toward.y, scale: SOURCE_SCALE } : {});
  const plan = planExit(current, to, { opacity });
  if (!plan) return null;
  const copy = copyOf(element, box);
  const scrollTop = element.scrollTop;
  // The element itself is at rest at once, whatever it was doing: it is going.
  haltUncounted(element);
  unstyle([element]);
  return () => {
    pending++;
    // In the next frame, before it paints, so the copy is there as the element goes: the
    // browser won't show the layer (a popover) while it is still hiding another.
    requestAnimationFrame(() => {
      pending--;
      if (mode === "off") return;
      try {
        leavingLayer().append(copy);
      } catch (error) {
        report(error);
        return;
      }
      copy.firstElementChild?.scrollTo({ top: scrollTop });
      run(copy, plan, toward?.origin ?? how.origin, () => retire(copy));
    });
  };
}

// Helpers -----------------------------------------------------------------------

/**
 * Enters from an offset (e.g. a dialog's panel from 8px above at 0.98):
 * `origin` is the transform's, `delay` in seconds (a stagger).
 */
export function enter(
  element: HTMLElement,
  from: Offset,
  options: { spring?: SpringName; delay?: number; origin?: string } = {},
): void {
  const plan = planEnter(mode, from, options);
  if (plan) run(element, plan, options.origin);
}

/**
 * Grows from what opened it (DESIGN.md: menus, popovers, the Citation card):
 * from the edge that faces it, 4px toward it at 0.96. `box`: where the
 * element is laid out, if it isn't showing yet to be measured.
 */
export function enterFrom(element: HTMLElement, source: Element | Box | null, box?: Box): void {
  if (mode === "off") return;
  const toward = towardSource(box ?? boxOf(element.getBoundingClientRect()), sourceBox(source));
  sources.set(element, toward);
  enter(element, { x: toward.x, y: toward.y, scale: SOURCE_SCALE }, { origin: toward.origin });
}

/**
 * Leaves toward an offset: a copy of the element as it shows now fades there,
 * where nothing can click or find it, so the element itself can go at once.
 * Call it before the element is hidden or removed.
 */
export function exit(element: HTMLElement, to: Offset, origin?: string): void {
  leaving(element, { to, origin })?.();
}

/**
 * Goes back to what opened it, shrinking toward it: toward `source`, or, if
 * it has gone, toward where the element came from. Call it before the
 * element is hidden or removed.
 */
export function exitToward(element: HTMLElement, source?: Element | Box | null): void {
  leaving(element, { source })?.();
}

/**
 * When the component holding `ref` goes, what it showed leaves toward
 * `source()`. For an element React removes, which can't be asked to leave
 * first: call it before the effect that hides the element, so it is copied
 * while it still shows.
 */
export function useExitToward(
  ref: RefObject<HTMLElement | null>,
  source: () => Element | Box | null,
): void {
  const latestSource = useRef(source);
  latestSource.current = source;
  useLayoutEffect(() => {
    const element = ref.current;
    return () => {
      if (!element) return;
      const play = leaving(element, { source: latestSource.current() });
      // Only once it's gone: React runs effects twice in development, and the element stays.
      if (play) queueMicrotask(() => element.isConnected || play());
    };
  }, [ref]);
}

/**
 * Fades in when the component holding `ref` shows, and out when it goes, in
 * place (DESIGN.md: status lines and the undo line). A new one shown as the old
 * one goes cross-fades with it. `on` off: what it holds fades instead, and it
 * stays as it is.
 */
export function useFade(ref: RefObject<HTMLElement | null>, on = true): void {
  useLayoutEffect(() => {
    if (!on) return;
    const element = ref.current;
    if (element) enter(element, {});
    return () => {
      if (!element) return;
      const play = leaving(element, { to: {} });
      // Only once it's gone: React runs effects twice in development, and the element stays.
      if (play) queueMicrotask(() => element.isConnected || play());
    };
  }, [ref, on]);
}

/**
 * Makes the element of `ref` breathe while `active`: a live dot. It never settles, so it isn't
 * among the animations the tests wait for (`motionRunning`).
 */
export function useBreathing(ref: RefObject<Element | null>, active: boolean): void {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!active || !element) return;
    let controls: AnimationPlaybackControlsWithThen | null = null;
    const rest = () => {
      controls?.stop();
      controls = null;
      if (element instanceof HTMLElement || element instanceof SVGElement) {
        element.style.removeProperty("opacity");
      }
    };
    const start = () => {
      rest();
      const plan = planBreathe(motionMode());
      if (!plan) return;
      try {
        controls = animate(element, plan.keyframes, { ...plan.transition, reduceMotion: false });
        controls.speed = speed;
      } catch (error) {
        report(error);
      }
    };
    start();
    const unsubscribe = subscribeMotion(start);
    return () => {
      unsubscribe();
      rest();
    };
  }, [ref, active]);
}

/**
 * Moves from the box it had to the one it has (both measured, the new one
 * once laid out there), by transform. A panel's box scales too, its content
 * counter-scaled so it keeps its size, anchored top left; clip it with the
 * panel's own overflow. `velocity`: of a release, in pixels per second.
 */
export function move(
  element: HTMLElement,
  from: Box,
  to: Box,
  options: { spring?: SpringName; velocity?: { x: number; y: number }; panel?: boolean } = {},
): void {
  if (options.panel) {
    moveFrame(element, from, to, options);
    return;
  }
  const plan = planMove(
    mode,
    { x: from.left - to.left, y: from.top - to.top },
    { spring: options.spring, velocity: options.velocity },
  );
  if (plan) run(element, plan);
}

/** A panel's move: its box springs from the old one, its children counter-scaled. */
function moveFrame(
  element: HTMLElement,
  from: Box,
  to: Box,
  options: { spring?: SpringName; velocity?: { x: number; y: number } },
): void {
  if (mode === "off" || to.width < 1 || to.height < 1) return;
  // Reduced: placed at once, and the panel fades in there.
  if (mode === "reduced") {
    enter(element, {});
    return;
  }
  moveFrames([{ element, from, to }], options);
}

interface Moving {
  element: HTMLElement;
  from: Box;
  to: Box;
}

const differ = (a: Box, b: Box) =>
  Math.max(
    Math.abs(a.left - b.left),
    Math.abs(a.top - b.top),
    Math.abs(a.width - b.width),
    Math.abs(a.height - b.height),
  ) >= 0.5;

// A transform on an element with no box of its own (display: contents) does nothing: its children take it.
function boxedChildren(parent: Element): HTMLElement[] {
  return Array.from(parent.children).flatMap((child) => {
    if (!(child instanceof HTMLElement)) return [];
    return getComputedStyle(child).display === "contents" ? boxedChildren(child) : [child];
  });
}

/**
 * Boxes moving on one spring, each from its old box to its new one; one that
 * changes size has its children counter-scaled. `velocity` is the first box's.
 */
function moveFrames(
  moves: readonly Moving[],
  options: { spring?: SpringName; velocity?: { x: number; y: number } },
): void {
  // A move it interrupts stops where it is, and is measured from there.
  for (const { element } of moves) haltUncounted(element);
  const frames = moves.map(({ element, from, to }) => {
    const box = element.getBoundingClientRect();
    const resized = from.width !== to.width || from.height !== to.height;
    const children = (resized ? boxedChildren(element) : []).map((child) => {
      const rect = child.getBoundingClientRect();
      return { child, x: rect.left - box.left, y: rect.top - box.top };
    });
    return { element, from, to, children };
  });
  // A box inside another moving box is already carried by its translation (its
  // children are counter-scaled), so it adds only the rest of its own move.
  const carriers = new Map(
    frames.map((inner) => {
      let carrier: (typeof frames)[number] | undefined;
      for (const outer of frames) {
        if (outer === inner || !outer.element.contains(inner.element)) continue;
        if (!carrier || carrier.element.contains(outer.element)) carrier = outer;
      }
      return [inner, carrier];
    }),
  );
  const apply = (progress: number) => {
    const at = new Map(frames.map((moving) => [moving, frameAt(moving.from, moving.to, progress)]));
    for (const [moving, frame] of at) {
      const carrier = carriers.get(moving);
      const carried = carrier ? at.get(carrier) : undefined;
      const x = frame.x - (carried?.x ?? 0);
      const y = frame.y - (carried?.y ?? 0);
      moving.element.style.transform = `translate(${x}px, ${y}px) scale(${frame.scaleX}, ${frame.scaleY})`;
      for (const { child, x, y } of moving.children) {
        child.style.transform = `translate(${x / frame.scaleX - x}px, ${y / frame.scaleY - y}px) scale(${1 / frame.scaleX}, ${1 / frame.scaleY})`;
      }
    }
  };
  // How fast, in progress per second, the release's velocity carries the box along its path.
  const first = moves[0];
  const dx = first ? first.to.left - first.from.left : 0;
  const dy = first ? first.to.top - first.from.top : 0;
  const distance = dx * dx + dy * dy;
  const velocity = options.velocity;
  const progressVelocity =
    velocity && distance >= 1
      ? clamp((velocity.x * dx + velocity.y * dy) / distance, -12, 12)
      : undefined;
  const all = frames.flatMap(({ element, children }) => [
    element,
    ...children.map(({ child }) => child),
  ]);
  try {
    for (const node of all) node.style.transformOrigin = "0 0";
    apply(0);
    const controls = animate(0, 1, {
      ...physics(spring[options.spring ?? "smooth"], progressVelocity),
      onUpdate: apply,
    });
    for (const { element } of frames) latest.set(element, controls);
    track(controls, () => {
      for (const { element } of frames) {
        if (latest.get(element) === controls) latest.delete(element);
      }
      unstyle(all, false);
    });
  } catch (error) {
    unstyle(all, false);
    report(error);
  }
}

/**
 * The sidebar hides, shows or peeks (DESIGN.md, Motion), in two steps: call
 * this just before the change, with the boxes beside the sidebar that may move
 * with its edge and whether the sidebar shows after it; then, once the change
 * is laid out, call what it returns with any bands inside those boxes. On,
 * they slide together from where they are now, on the panel spring, and a
 * band laid out to its box's right edge stretches with it rather than riding
 * along, so it never falls short of that edge; Reduced, the sidebar fades and
 * the rest is placed at once; Off, nothing moves.
 */
export function slideSidebar(
  sidebar: HTMLElement,
  beside: readonly HTMLElement[],
  shows: boolean,
): (bands: readonly HTMLElement[]) => void {
  if (mode === "off") return () => {};
  if (mode === "reduced") {
    const seen = () => sidebar.checkVisibility({ opacityProperty: true });
    const was = seen();
    const goes = was && !shows ? leaving(sidebar, { to: {} }) : null;
    return () => {
      const now = seen();
      if (was && !now) goes?.();
      else if (!was && now) enter(sidebar, {});
    };
  }
  const elements = [sidebar, ...beside];
  // Held where they are until the change is laid out, so a turn mid-way starts exactly there.
  for (const element of elements) latest.get(element)?.stop();
  const before = elements.map((element) => ({
    element,
    from: boxOf(element.getBoundingClientRect()),
  }));
  return (bands) => {
    for (const element of [...elements, ...bands]) haltUncounted(element);
    const moves = before
      .filter(({ element }) => element.isConnected)
      .map((move) => ({ ...move, to: boxOf(move.element.getBoundingClientRect()) }))
      .filter(({ from, to }) => to.width >= 1 && to.height >= 1 && differ(from, to));
    const stretched = bands.flatMap((band) => {
      const pane = moves.find(({ element }) => element.contains(band));
      const to = boxOf(band.getBoundingClientRect());
      if (!pane || Math.abs(to.left + to.width - (pane.to.left + pane.to.width)) >= 1) return [];
      const from = {
        left: pane.from.left + to.left - pane.to.left,
        top: pane.from.top + to.top - pane.to.top,
        width: to.width + pane.from.width - pane.to.width,
        height: to.height,
      };
      return [{ element: band, from, to }];
    });
    if (moves.length > 0) moveFrames([...moves, ...stretched], { spring: "smooth" });
  };
}

/**
 * Settles where it was dropped, from where the pointer let it go, with the
 * pointer's velocity (pixels per second). Reduced, it fades in there.
 */
export function release(
  element: HTMLElement,
  from: Box,
  to: Box,
  velocity: { x: number; y: number },
  { panel = false }: { panel?: boolean } = {},
): void {
  if (panel && mode === "on") {
    moveFrame(element, from, to, { spring: "drop", velocity });
    return;
  }
  const plan = planRelease(mode, { x: from.left - to.left, y: from.top - to.top }, velocity, {
    panel,
  });
  if (plan) run(element, plan);
}

/**
 * New items of a list enter one after another (DESIGN.md: rows from 4px
 * above, 15ms apart, the first 12 only); Reduced, they fade, still apart.
 */
export function stagger(
  elements: readonly HTMLElement[],
  from: Offset,
  {
    step = 0.015,
    max = 12,
    spring: name = "snappy",
  }: { step?: number; max?: number; spring?: SpringName } = {},
): void {
  const delays = staggerDelays(elements.length, step, max);
  elements.forEach((element, index) => {
    const delay = delays[index];
    if (delay !== null && delay !== undefined) enter(element, from, { delay, spring: name });
  });
}

// For the tests ---------------------------------------------------------------

/** How each leaving copy shows now: where it is, how far it has faded and shrunk, toward which point. */
export function leavingCopies(): {
  box: Box;
  opacity: number;
  transform: string;
  origin: string;
}[] {
  if (!layer) return [];
  return Array.from(layer.root.children)
    .filter((child): child is HTMLElement => child instanceof HTMLElement && !retiring.has(child))
    .map((copy) => {
      const style = getComputedStyle(copy);
      return {
        box: boxOf(copy.getBoundingClientRect()),
        opacity: Number(style.opacity),
        transform: style.transform,
        origin: style.transformOrigin,
      };
    });
}
