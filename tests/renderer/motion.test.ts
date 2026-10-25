import { spring as motionSpring } from "motion";
import { describe, expect, test } from "vitest";
import {
  fade,
  fadeQuick,
  frameAt,
  type MotionMode,
  type Plan,
  physics,
  planBreathe,
  planEnter,
  planExit,
  planMove,
  planRelease,
  resolveMotion,
  SOURCE_SCALE,
  SOURCE_SHIFT,
  spring,
  staggerDelays,
  towardSource,
} from "../../src/renderer/src/motion";

const MODES: MotionMode[] = ["on", "reduced", "off"];

/** Where a spring is at `seconds`, from 0 to 1, as Motion runs it. */
const springAt = (options: Record<string, number>, seconds: number) =>
  motionSpring({ keyframes: [0, 1], ...options }).next(seconds * 1000).value as number;

describe("the tokens are DESIGN.md's (Motion, Tokens)", () => {
  test("three springs, by visual duration and bounce", () => {
    expect(spring).toEqual({
      snappy: { visualDuration: 0.24, bounce: 0 },
      smooth: { visualDuration: 0.34, bounce: 0 },
      drop: { visualDuration: 0.4, bounce: 0.22 },
    });
  });

  test("two fades: fade.quick 120 ms ease-in, fade 200 ms ease-out", () => {
    expect(fadeQuick).toEqual({ duration: 0.12, ease: "easeIn" });
    expect(fade).toEqual({ duration: 0.2, ease: "easeOut" });
  });

  test.each([
    { name: "snappy", stiffness: 476, damping: 43.6 },
    { name: "smooth", stiffness: 237, damping: 30.8 },
    { name: "drop", stiffness: 171, damping: 20.4 },
  ] as const)(
    "$name as physics: stiffness $stiffness, damping $damping, mass 1",
    ({ name, stiffness, damping }) => {
      const form = physics(spring[name]);
      expect(form.type).toBe("spring");
      expect(form.mass).toBe(1);
      expect(form.stiffness).toBeCloseTo(stiffness, 0);
      expect(form.damping).toBeCloseTo(damping, 1);
    },
  );

  test.each(["snappy", "smooth", "drop"] as const)(
    "%s as physics moves exactly as the spring given by duration and bounce",
    (name) => {
      const { type: _, velocity: __, ...form } = physics(spring[name]);
      for (let seconds = 0; seconds <= 1; seconds += 0.02) {
        expect(springAt(form, seconds)).toBeCloseTo(springAt({ ...spring[name] }, seconds), 6);
      }
    },
  );

  test("only the physics form carries a velocity, as a release needs", () => {
    const { type: _, ...still } = physics(spring.drop);
    const { type: __, ...thrown } = physics(spring.drop, 5);
    expect(springAt(thrown, 0.05)).toBeGreaterThan(springAt(still, 0.05) + 0.1);
    // Given by duration and bounce, Motion drops it: the reason everything here runs as physics.
    expect(springAt({ ...spring.drop, velocity: 5 }, 0.05)).toBeCloseTo(
      springAt({ ...spring.drop }, 0.05),
      6,
    );
  });
});

describe("the mode", () => {
  test("follows the system's Reduce motion until the User chooses", () => {
    expect(resolveMotion("system", false)).toBe("on");
    expect(resolveMotion("system", true)).toBe("reduced");
  });

  test.each(["on", "reduced", "off"] as const)(
    "the User's %s holds whatever the system says",
    (choice) => {
      expect(resolveMotion(choice, false)).toBe(choice);
      expect(resolveMotion(choice, true)).toBe(choice);
    },
  );
});

/** Every value a plan animates. */
const valuesOf = (plan: Plan | null) => Object.keys(plan?.keyframes ?? {}).sort();

describe("each helper, On, Reduced and Off", () => {
  const plans = (mode: MotionMode) => [
    planEnter(mode, { y: -4, scale: 0.96 }),
    planExit(mode, { y: -4, scale: 0.96 }),
    planMove(mode, { x: 30, y: -12 }),
    planRelease(mode, { x: 30, y: -12 }, { x: 900, y: 0 }),
    planRelease(mode, { x: 30, y: -12 }, { x: 900, y: 0 }, { panel: true }),
  ];

  test.each(MODES)("%s: only transform and opacity animate", (mode) => {
    for (const plan of plans(mode)) {
      for (const value of valuesOf(plan)) expect(["opacity", "scale", "x", "y"]).toContain(value);
    }
  });

  test("Off: every change is instant", () => {
    expect(plans("off")).toEqual([null, null, null, null, null]);
  });

  test("Reduced: what appears or goes fades, and what moves is placed at once", () => {
    const [enter, exit, move, release, panelRelease] = plans("reduced");
    expect(enter).toEqual({ keyframes: { opacity: [0, 1] }, transition: { ...fade, delay: 0 } });
    expect(exit).toEqual({
      keyframes: { opacity: [1, 0] },
      transition: { ...fadeQuick, delay: 0 },
    });
    expect(move).toBeNull();
    expect(release).toEqual({
      keyframes: { opacity: [0, 1] },
      transition: { ...fadeQuick, delay: 0 },
    });
    expect(panelRelease).toEqual({
      keyframes: { opacity: [0, 1] },
      transition: { ...fade, delay: 0 },
    });
  });

  test("On: entering springs from its offset while its opacity fades in", () => {
    const plan = planEnter("on", { y: -SOURCE_SHIFT, scale: SOURCE_SCALE });
    expect(plan?.keyframes).toEqual({ opacity: [0, 1], y: [-4, 0], scale: [0.96, 1] });
    expect(plan?.transition).toMatchObject({
      ...physics(spring.snappy, 0),
      opacity: { ...fade, delay: 0 },
    });
    expect(planEnter("on", {}, { spring: "smooth", delay: 0.05 })?.transition).toMatchObject({
      ...physics(spring.smooth, 0),
      delay: 0.05,
      opacity: { ...fade, delay: 0.05 },
    });
  });

  test("an offset left undefined keeps where it rests", () => {
    expect(planEnter("on", { x: undefined, y: -4 })?.keyframes).toEqual({
      opacity: [0, 1],
      y: [-4, 0],
    });
    expect(planExit("on", { x: undefined, scale: 0.96 })?.keyframes).toEqual({
      opacity: [1, 0],
      scale: [1, 0.96],
    });
  });

  test("On: leaving shrinks toward its offset as it fades, from where it is", () => {
    expect(planExit("on", { y: -4, scale: 0.96 })).toEqual({
      keyframes: { opacity: [1, 0], y: [0, -4], scale: [1, 0.96] },
      transition: { ...fadeQuick, delay: 0 },
    });
    // Closed half way in: it leaves from the opacity it had.
    expect(planExit("on", { scale: 0.96 }, { opacity: 0.6 })?.keyframes.opacity).toEqual([0.6, 0]);
  });

  test("On: a move springs back from the old place, and a release keeps the pointer's velocity", () => {
    expect(planMove("on", { x: 30, y: -12 })).toEqual({
      keyframes: { x: [30, 0], y: [-12, 0] },
      transition: { x: physics(spring.snappy), y: physics(spring.snappy) },
    });
    expect(planMove("on", { x: 0.2, y: -0.1 })).toBeNull();
    expect(planRelease("on", { x: 30, y: 0 }, { x: 900, y: 0 })).toEqual({
      keyframes: { x: [30, 0] },
      transition: { x: physics(spring.drop, 900) },
    });
  });

  test("a list's stagger: 15 ms apart, the first 12 only; Reduced keeps the delays", () => {
    const delays = staggerDelays(14);
    expect(delays.slice(0, 3)).toEqual([0, 0.015, 0.03]);
    expect(delays[11]).toBeCloseTo(0.165, 6);
    expect(delays.slice(12)).toEqual([null, null]);
    expect(planEnter("reduced", { y: -4 }, { delay: 0.03 })?.transition).toMatchObject({
      delay: 0.03,
    });
  });
});

describe("a live dot", () => {
  test("breathes in On and Reduced, 1.6 s a round between full and 0.45, and is still in Off", () => {
    for (const mode of ["on", "reduced"] as const) {
      expect(planBreathe(mode)).toEqual({
        keyframes: { opacity: [1, 0.45] },
        transition: {
          duration: 0.8,
          ease: "easeInOut",
          repeat: Number.POSITIVE_INFINITY,
          repeatType: "reverse",
        },
      });
    }
    expect(planBreathe("off")).toBeNull();
  });
});

describe("where a thing grows from", () => {
  const button = { left: 100, top: 40, width: 28, height: 28 };

  test("a menu below its button grows from its top edge, under the button's middle", () => {
    expect(towardSource({ left: 90, top: 72, width: 200, height: 160 }, button)).toEqual({
      origin: "24px 0px",
      x: 0,
      y: -4,
    });
  });

  test("a menu above its button grows from its bottom edge", () => {
    const above = { left: 90, top: 300, width: 200, height: 160 };
    expect(towardSource(above, { ...button, top: 470 })).toEqual({
      origin: "24px 160px",
      x: 0,
      y: 4,
    });
  });

  test("a submenu to the right of its button grows from its left edge", () => {
    expect(towardSource({ left: 132, top: 30, width: 200, height: 160 }, button)).toEqual({
      origin: "0px 24px",
      x: -4,
      y: 0,
    });
  });

  test("with no source left, from the top edge's middle", () => {
    expect(towardSource({ left: 0, top: 0, width: 10, height: 10 }, null)).toEqual({
      origin: "50% 0px",
      x: 0,
      y: -4,
    });
  });
});

describe("a panel's frame", () => {
  const from = { left: 900, top: 100, width: 320, height: 500 };
  const to = { left: 0, top: 0, width: 640, height: 400 };

  test("starts as the old box and ends as the new, by transform alone", () => {
    expect(frameAt(from, to, 0)).toEqual({ x: 900, y: 100, scaleX: 0.5, scaleY: 1.25 });
    expect(frameAt(from, to, 1)).toEqual({ x: 0, y: 0, scaleX: 1, scaleY: 1 });
  });
});
