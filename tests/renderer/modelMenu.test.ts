import { describe, expect, test } from "vitest";
import { retryModel } from "../../src/renderer/src/modelMenu";

const FAILED = { providerId: "local", modelId: "gone:latest" };
const WORKING = { providerId: "local", modelId: "qwen3.5:4b" };

describe("A failed Answer is asked again with the model the composer shows", () => {
  test("a model the chip shows that isn't the one that failed is the one to ask with", () => {
    expect(retryModel(FAILED, WORKING)).toEqual(WORKING);
  });

  test("while the chip still shows the model that failed, there is none", () => {
    expect(retryModel(FAILED, FAILED)).toBeNull();
  });

  test("a model on another provider with the same id counts", () => {
    const other = { providerId: "hosted", modelId: FAILED.modelId };
    expect(retryModel(FAILED, other)).toEqual(other);
  });

  test("with no model shown there is none", () => {
    expect(retryModel(FAILED, null)).toBeNull();
  });

  test("an Answer that names no model is asked again with the one shown", () => {
    expect(retryModel({ providerId: null, modelId: null }, WORKING)).toEqual(WORKING);
  });
});
