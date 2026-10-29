import { describe, expect, test } from "vitest";
import { pickedSince } from "../../src/renderer/src/modelMenu";

const FAILED = { providerId: "local", modelId: "gone:latest" };
const WORKING = { providerId: "local", modelId: "qwen3.5:4b" };
const at = (iso: string) => Date.parse(iso);
const SINCE = "2026-10-29T10:00:00Z";

describe("A failed Answer is asked again with the model picked after it failed", () => {
  test("a model picked since the failure counts", () => {
    const pick = { choice: WORKING, at: at("2026-10-29T10:00:05Z") };
    expect(pickedSince(pick, SINCE, FAILED)).toEqual(WORKING);
  });

  test("one picked before the failure, or at the same moment, doesn't", () => {
    expect(
      pickedSince({ choice: WORKING, at: at("2026-10-29T09:59:59Z") }, SINCE, FAILED),
    ).toBeNull();
    expect(pickedSince({ choice: WORKING, at: at(SINCE) }, SINCE, FAILED)).toBeNull();
  });

  test("the model that failed doesn't count when it is picked again", () => {
    expect(
      pickedSince({ choice: FAILED, at: at("2026-10-29T10:00:05Z") }, SINCE, FAILED),
    ).toBeNull();
  });

  test("a model on another provider with the same id counts", () => {
    const other = { providerId: "hosted", modelId: FAILED.modelId };
    expect(pickedSince({ choice: other, at: at("2026-10-29T10:00:05Z") }, SINCE, FAILED)).toEqual(
      other,
    );
  });

  test("nothing picked is none", () => {
    expect(pickedSince(null, SINCE, FAILED)).toBeNull();
  });
});
