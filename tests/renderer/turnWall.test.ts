import { describe, expect, test } from "vitest";
import { scopeWithin } from "../../src/renderer/src/scope";
import { folderScope, NO_SCOPE } from "../../src/shared/searchScope";

/** The composer's scope behind a wall is the wall's Folder alone, whatever was chosen (#1934). */
describe("the composer's scope and the turn's wall", () => {
  test("behind a wall, the wall's Folder; outside every wall, what the composer had", () => {
    const chosen = { folderIds: ["memos"], tagIds: [], documentIds: ["lease"] };
    expect(scopeWithin("client-a", chosen)).toEqual(folderScope("client-a"));
    expect(scopeWithin("client-a", NO_SCOPE)).toEqual(folderScope("client-a"));
    expect(scopeWithin(null, chosen)).toBe(chosen);
  });
});
