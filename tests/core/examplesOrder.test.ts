import { describe, expect, test } from "vitest";
import { createExamples } from "../../src/core/examples";

/** Examples with nothing made, over a device store the test can hand to the next start. */
function examplesOver(store: Map<string, unknown>, random: () => number) {
  const unused = () => {
    throw new Error("not used");
  };
  return createExamples({
    source: "unused",
    dataDir: "unused",
    language: () => "en",
    readValue: (key) => store.get(key),
    writeValue: (key, value) => void store.set(key, value),
    createMind: unused,
    renameMind: unused,
    mindTitle: () => "",
    mindExists: () => false,
    deleteMind: unused,
    editMind: unused,
    linkFolder: unused,
    unlinkFolder: unused,
    linkedFolderExists: () => false,
    documentsIn: () => [],
    mindFolder: () => null,
    now: () => "2026-10-14T09:00:00.000Z",
    checksRelyOn: () => false,
    citationsRelyOn: () => false,
    recheck: unused,
    changed: () => undefined,
    random,
  });
}

describe("the examples a banner offers (#123)", () => {
  test("the first-run example offers the other three, in an order picked once per install", () => {
    const first = new Map<string, unknown>();
    const second = new Map<string, unknown>();
    const orderA = examplesOver(first, () => 0).status("credit").more;
    const orderB = examplesOver(second, () => 0.99).status("credit").more;
    expect([...orderA].sort()).toEqual(["contracts", "meetings", "papers"]);
    expect([...orderB].sort()).toEqual(["contracts", "meetings", "papers"]);
    expect(orderA).not.toEqual(orderB);
  });

  test("the order is the same after a restart, and for every example", () => {
    const store = new Map<string, unknown>();
    const before = examplesOver(store, () => 0).status("credit").more;
    const after = examplesOver(store, () => 0.99);
    expect(after.status("credit").more).toEqual(before);
    for (const group of before) {
      expect(after.status(group).more).toEqual([
        "credit",
        ...before.filter((each) => each !== group),
      ]);
    }
  });
});
