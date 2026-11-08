import { describe, expect, test } from "vitest";
import { proposedText } from "../../src/core/tools/commands/organize";

/*
 * What Organize proposed, as the app writes the assistant's reply (#1569): the model doesn't, since
 * models that did wrote "filed" and "moved" of Documents that only wait in Suggested Folders.
 */
describe("The app's reply to an Organize request", () => {
  test("one Folder", () => {
    expect(proposedText("en", [{ name: "Leases", count: 4 }])).toBe(
      "Proposed 1 Folder for 4 Documents: “Leases” (4). Nothing has moved yet: review them to file them.",
    );
  });

  test("one Document", () => {
    expect(proposedText("en", [{ name: "Leases", count: 1 }])).toBe(
      "Proposed 1 Folder for 1 Document: “Leases” (1). Nothing has moved yet: review it to file it.",
    );
  });

  test("several Folders", () => {
    expect(
      proposedText("en", [
        { name: "Leases", count: 4 },
        { name: "Board and governance", count: 3 },
      ]),
    ).toBe(
      "Proposed 2 Folders for 7 Documents: “Leases” (4), “Board and governance” (3). Nothing has moved yet: review them to file them.",
    );
  });

  test("subfolders, each by its path", () => {
    expect(
      proposedText("en", [
        { name: "Contracts › Leases", count: 4 },
        { name: "Contracts › Employment", count: 3 },
      ]),
    ).toBe(
      "Proposed 2 Folders for 7 Documents: “Contracts › Leases” (4), “Contracts › Employment” (3). Nothing has moved yet: review them to file them.",
    );
  });

  test("in Chinese", () => {
    expect(
      proposedText("zh-CN", [
        { name: "租约", count: 4 },
        { name: "Board and governance", count: 3 },
      ]),
    ).toBe(
      "已建议 2 个文件夹，共 7 个文档：“租约”（4 个）、“Board and governance”（3 个）。还没有移动任何文档：查看并确认后才会归入文件夹。",
    );
  });
});
