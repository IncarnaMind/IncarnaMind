import { beforeAll, describe, expect, test } from "vitest";
import type { Mind } from "../../src/core/api";
import type * as AddToNote from "../../src/renderer/src/addToNote";

let noteChoices: typeof AddToNote.noteChoices;

beforeAll(async () => {
  // The picker reaches the store, which reads the bridge the preload exposes.
  const bridge = new Proxy({}, { get: () => () => () => undefined });
  (globalThis as unknown as { window: unknown }).window = {
    incarnamind: bridge,
    incarnamindFiles: bridge,
  };
  ({ noteChoices } = await import("../../src/renderer/src/addToNote"));
});

const AT = "2026-11-20T09:00:00.000Z";
const note = (id: string, title: string, more: Partial<Mind> = {}): Mind => ({
  id,
  title,
  autoTitle: "",
  kind: "mind",
  createdAt: AT,
  updatedAt: AT,
  folderId: null,
  ...more,
});

const NEWEST = note("m-v2", "Checking: Harbour review");
const EARLIER = note("m-v1", "Checking version 1: Harbour review", { supersededBy: "m-v2" });
const PLAN = note("m-plan", "Harbour plan");
const EXAMPLE = note("m-example", "Tea tasting");

describe("the Notes an Answer can be added to", () => {
  // protects=the check of an earlier version of a file an agent handed over is offered in no picker, and takes an Answer only while it is the Note in front (#3412); fails_when=the picker lists every version's check, or refuses the earlier one when the User has it open
  test("leave out an earlier version's check, unless it is the Note in front", () => {
    const minds = [NEWEST, EARLIER, PLAN, EXAMPLE];

    const elsewhere = noteChoices(minds, "m-plan", ["m-example"]);
    expect(elsewhere.focused?.id).toBe("m-plan");
    expect(elsewhere.others.map((mind) => mind.id)).toEqual(["m-v2"]);

    const onIt = noteChoices(minds, "m-v1", ["m-example"]);
    expect(onIt.focused?.id).toBe("m-v1");
    expect(onIt.others.map((mind) => mind.id)).toEqual(["m-v2", "m-plan"]);
  });
});
