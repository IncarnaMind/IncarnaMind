import { describe, expect, test } from "vitest";
import { ALL_PROBES } from "../../eval/everyday/claimProbes";
import { newMeter, runArms } from "../../eval/everyday/privacyRun";
import { unbackedClaims } from "../../src/core/answers/claimedChanges";
import { scriptedModel } from "../helpers/models";

// The run of the gate for #2969 (eval/everyday/gates/privacy-record.md), driven by a scripted
// model: the order of the arms, what counts, that nothing is asked again, and the stop.

const IDS = ["backed-rename-command-en", "unbacked-delete-command-en", "held-partial-command-zh"];
const PROBES = IDS.map((id) => {
  const probe = ALL_PROBES.find((each) => each.id === id);
  if (!probe) throw new Error(`No probe ${id}.`);
  return probe;
});
const ARMS = ["main", "branch", "nosentences"].map((name) => ({ name, check: unbackedClaims }));
const dollarsOf = (input: number, output: number) => (input + output) / 1000;

/** A judge that flags a reply that says it deleted something, and answers the second question "no". */
const judge = (fail: (nth: number) => boolean = () => false) => {
  let nth = 0;
  return scriptedModel(() => ({ text: "" }), {
    generate: (call) => {
      nth += 1;
      if (fail(nth)) return { error: { status: 503, message: "Offline." } };
      if (call.question === "request-done")
        return { text: '{"asks_change":"no","request":"none"}' };
      const flagged = call.prompt.includes("I deleted");
      return {
        text: JSON.stringify({
          claims: flagged
            ? [{ sentence: "I deleted “周报”.", kind: "removed", about: "mind", backed: false }]
            : [],
        }),
      };
    },
  });
};

describe("The run of the gate's three arms", () => {
  test("each probe goes through each arm in each run, the arms in an order that shifts", async () => {
    const meter = newMeter();

    const { rows, stopped } = await runArms({
      arms: ARMS,
      probes: PROBES,
      runs: 2,
      stop: 0,
      model: judge(),
      meter,
      dollarsOf,
    });

    expect(stopped).toBeNull();
    expect(rows).toHaveLength(PROBES.length * ARMS.length * 2);
    for (const probe of PROBES) {
      for (const run of [1, 2]) {
        const mine = rows.filter((row) => row.probe === probe.id && row.run === run);
        expect(mine.map((row) => row.arm).sort()).toEqual(["branch", "main", "nosentences"]);
      }
    }
    const firsts = new Set(
      PROBES.map((probe) => rows.find((row) => row.probe === probe.id && row.run === 1)?.arm),
    );
    expect(firsts.size).toBeGreaterThan(1);
    expect(rows.every((row) => row.counted)).toBe(true);
    expect(rows.filter((row) => row.flagged).map((row) => row.probe)).toContain(
      "unbacked-delete-command-en",
    );
  });

  test("a check whose request was refused is counted apart, and nothing is asked again", async () => {
    const quiet = newMeter();
    await runArms({
      arms: ARMS,
      probes: PROBES,
      runs: 1,
      stop: 0,
      model: judge(),
      meter: quiet,
      dollarsOf,
    });
    const meter = newMeter();

    const { rows } = await runArms({
      arms: ARMS,
      probes: PROBES,
      runs: 1,
      stop: 0,
      model: judge((nth) => nth === 4),
      meter,
      dollarsOf,
    });

    const apart = rows.filter((row) => !row.counted);
    expect(apart).toHaveLength(1);
    expect(apart[0]?.refused.join(" ")).toContain("Offline");
    expect(rows.filter((row) => row.counted)).toHaveLength(rows.length - 1);
    expect(meter.requests).toBe(quiet.requests);
  });

  test("it stops, and says so, when the spend reaches the stop", async () => {
    const meter = newMeter();

    const { rows, stopped } = await runArms({
      arms: ARMS,
      probes: PROBES,
      runs: 3,
      stop: 0.05,
      model: judge(),
      meter,
      dollarsOf,
    });

    expect(stopped).toContain("$0.05");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(PROBES.length * ARMS.length * 3);
  });
});
