import { describe, expect, test } from "vitest";
import type {
  LibraryGroup,
  OrganizeReview,
  OrganizeReviewFolder,
  OrganizeReviewItem,
  OrganizeReviewPlacement,
} from "../../src/core/api";
import {
  cardPath,
  confirmCounts,
  leftOutText,
  reviewLayout,
  willMoveText,
} from "../../src/renderer/src/organizeReviewView";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

/*
 * The Review's page as it lays out the Suggestions (#1569): the cards in the sidebar's order,
 * what Confirm would do, and the words for it, in English and Chinese.
 */

const en = (key: MessageKey, params?: MessageParams) => translate("en", key, params);
const zh = (key: MessageKey, params?: MessageParams) => translate("zh-CN", key, params);

const folder = (id: string, name: string, parentId: string | null = null): LibraryGroup => ({
  id,
  name,
  description: "",
  parentId,
  countsOwnFiles: false,
  keepInside: false,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
});

const proposedFolder = (
  id: string,
  name: string,
  parents: { parentId?: string; parentNewFolderId?: string } = {},
): OrganizeReviewFolder => ({
  id,
  name,
  description: "",
  parentId: parents.parentId ?? null,
  parentNewFolderId: parents.parentNewFolderId ?? null,
});

const item = (
  id: string,
  placement: OrganizeReviewPlacement,
  over: Partial<OrganizeReviewItem> = {},
): OrganizeReviewItem => ({
  id,
  documentId: `d-${id}`,
  placement,
  ticked: true,
  origin: "library",
  edited: false,
  tags: [],
  ...over,
});

const into = (folderId: string): OrganizeReviewPlacement => ({ kind: "folder", folderId });
const intoNew = (newFolderId: string): OrganizeReviewPlacement => ({
  kind: "newFolder",
  newFolderId,
});

const review = (
  items: OrganizeReviewItem[],
  folders: OrganizeReviewFolder[] = [],
): OrganizeReview => ({ items, folders, count: items.length });

const filed = (documentId: string, groupId: string | null) => ({ documentId, groupId });

const finance = folder("finance", "Finance");
const legal = folder("legal", "Legal");
const tax = folder("tax", "Tax", "finance");
const empty = folder("empty", "Empty");
const library = [finance, legal, tax, empty];

describe("the Review's cards", () => {
  test("your Folders in the sidebar's order, each subfolder straight after its parent", () => {
    const layout = reviewLayout(
      review([
        item("1", into("legal")),
        item("2", into("tax")),
        item("3", into("finance")),
        item("4", into("legal")),
      ]),
      library,
      [],
    );
    expect(layout.yours.map((card) => card.id)).toEqual(["finance", "tax", "legal"]);
    expect(layout.yours.map((card) => card.items.map((each) => each.id))).toEqual([
      ["3"],
      ["2"],
      ["1", "4"],
    ]);
    expect(layout.yours[1]).toMatchObject({
      name: "Tax",
      parentPath: "Finance",
      parentId: "finance",
      proposed: false,
      target: { kind: "folder", folderId: "tax" },
    });
    expect(layout.proposed).toEqual([]);
  });

  test("proposed Folders after yours, a proposed subfolder straight after its proposed parent", () => {
    const layout = reviewLayout(
      review(
        [
          item("1", intoNew("nf-leases")),
          item("2", intoNew("nf-invoices")),
          item("3", intoNew("nf-receipts")),
          item("4", into("legal")),
        ],
        [
          proposedFolder("nf-leases", "Leases", { parentNewFolderId: "nf-contracts" }),
          proposedFolder("nf-invoices", "Invoices"),
          proposedFolder("nf-contracts", "Contracts"),
          proposedFolder("nf-receipts", "Receipts", { parentId: "finance" }),
        ],
      ),
      library,
      [],
    );
    expect(layout.yours.map((card) => card.id)).toEqual(["legal"]);
    expect(layout.proposed.map((card) => card.id)).toEqual([
      "nf-receipts",
      "nf-invoices",
      "nf-contracts",
      "nf-leases",
    ]);
    const [receipts, invoices, contracts, leases] = layout.proposed;
    expect(leases).toMatchObject({
      name: "Leases",
      parentPath: "Contracts",
      parentId: "nf-contracts",
      proposed: true,
      target: { kind: "newFolder", newFolderId: "nf-leases" },
    });
    expect(contracts).toMatchObject({ parentPath: null, parentId: null, items: [] });
    expect(invoices?.items.map((each) => each.id)).toEqual(["2"]);
    expect(receipts).toMatchObject({ name: "Receipts", parentPath: "Finance", proposed: true });
  });

  test("what is left out, in the order the runs added it; Confirm acts on every row", () => {
    const layout = reviewLayout(
      review([
        item("1", { kind: "leftOut", leftOut: { reason: "doesntFit" } }),
        item("2", into("finance")),
        item("3", { kind: "leftOut", leftOut: null }),
        item("4", { kind: "unchanged" }),
      ]),
      library,
      [],
    );
    expect(layout.leftOut.map((each) => each.id)).toEqual(["1", "3"]);
    expect(layout.yours.map((card) => card.id)).toEqual(["finance"]);
    expect(layout.itemIds).toEqual(["1", "2", "3", "4"]);
  });

  test("the scope is a Folder only when every row came from that Folder's own run", () => {
    const contracts = folder("contracts", "Contracts");
    const folders = [...library, contracts];
    const fromFolder = [
      item("1", into("tax"), { origin: "folder" }),
      item("2", into("tax"), { origin: "folder" }),
    ];
    const inContracts = [filed("d-1", "contracts"), filed("d-2", "contracts")];

    expect(reviewLayout(review(fromFolder), folders, inContracts).scope).toEqual(contracts);
    expect(
      reviewLayout(
        review([fromFolder[0] as OrganizeReviewItem, item("2", into("tax"))]),
        folders,
        inContracts,
      ).scope,
    ).toBeNull();
    expect(
      reviewLayout(review(fromFolder), folders, [filed("d-1", "contracts"), filed("d-2", "legal")])
        .scope,
    ).toBeNull();
    expect(
      reviewLayout(review(fromFolder), folders, [filed("d-1", null), filed("d-2", null)]).scope,
    ).toBeNull();
    expect(reviewLayout(review([]), folders, inContracts).scope).toBeNull();
  });

  test("a card's path: its parents' names, then its own", () => {
    expect(cardPath({ name: "Leases", parentPath: "Contracts" })).toBe("Contracts › Leases");
    expect(cardPath({ name: "Invoices", parentPath: null })).toBe("Invoices");
  });
});

/** Yours: Finance. Proposed: Contracts with its subfolder Leases. */
const mixed = (ticks: { finance: boolean[]; leases: boolean[] }) =>
  reviewLayout(
    review(
      [
        ...ticks.finance.map((ticked, at) => item(`f${at}`, into("finance"), { ticked })),
        ...ticks.leases.map((ticked, at) => item(`l${at}`, intoNew("nf-leases"), { ticked })),
        item("out", { kind: "leftOut", leftOut: { reason: "doesntFit" } }),
      ],
      [
        proposedFolder("nf-contracts", "Contracts"),
        proposedFolder("nf-leases", "Leases", { parentNewFolderId: "nf-contracts" }),
      ],
    ),
    library,
    [],
  );

describe("what Confirm would do", () => {
  test("counts the ticked Documents, and a proposed parent made only for its subfolder", () => {
    expect(confirmCounts(mixed({ finance: [true, false], leases: [true, true] }))).toEqual({
      documents: 3,
      yours: 1,
      proposed: 2,
      tagged: 0,
    });
    expect(confirmCounts(mixed({ finance: [true, false], leases: [false, false] }))).toEqual({
      documents: 1,
      yours: 1,
      proposed: 0,
      tagged: 0,
    });
    expect(confirmCounts(mixed({ finance: [false], leases: [true] }))).toEqual({
      documents: 1,
      yours: 0,
      proposed: 2,
      tagged: 0,
    });
  });
});

describe("the line under the Review's title", () => {
  const both = (layout: ReturnType<typeof reviewLayout>) => [
    willMoveText(layout, en),
    willMoveText(layout, zh),
  ];

  test("with nothing ticked", () => {
    expect(both(mixed({ finance: [false], leases: [false] }))).toEqual([
      "No Documents are ticked. Nothing has moved yet.",
      "没有勾选任何文档。还没有移动任何文档。",
    ]);
  });

  test("into your Folders only", () => {
    expect(both(mixed({ finance: [true], leases: [false] }))).toEqual([
      "1 Document will move into 1 of your Folders. Nothing has moved yet.",
      "1 个文档将放入 1 个已有文件夹。还没有移动任何文档。",
    ]);
    const two = reviewLayout(
      review([item("1", into("finance")), item("2", into("legal")), item("3", into("legal"))]),
      library,
      [],
    );
    expect(both(two)).toEqual([
      "3 Documents will move into 2 of your Folders. Nothing has moved yet.",
      "3 个文档将放入 2 个已有文件夹。还没有移动任何文档。",
    ]);
  });

  test("into new Folders only", () => {
    expect(both(mixed({ finance: [false], leases: [true, true] }))).toEqual([
      "2 Documents will move into 2 new Folders. Nothing has moved yet.",
      "2 个文档将放入 2 个新文件夹。还没有移动任何文档。",
    ]);
    const one = reviewLayout(
      review([item("1", intoNew("nf-invoices"))], [proposedFolder("nf-invoices", "Invoices")]),
      library,
      [],
    );
    expect(both(one)).toEqual([
      "1 Document will move into 1 new Folder. Nothing has moved yet.",
      "1 个文档将放入 1 个新文件夹。还没有移动任何文档。",
    ]);
  });

  test("into yours and new ones", () => {
    expect(both(mixed({ finance: [true], leases: [true, true] }))).toEqual([
      "3 Documents will move into 1 of your Folders and 2 new ones. Nothing has moved yet.",
      "3 个文档将放入 1 个已有文件夹和 2 个新文件夹。还没有移动任何文档。",
    ]);
    const one = reviewLayout(
      review(
        [item("1", into("finance")), item("2", intoNew("nf-invoices"))],
        [proposedFolder("nf-invoices", "Invoices")],
      ),
      library,
      [],
    );
    expect(both(one)).toEqual([
      "2 Documents will move into 1 of your Folders and 1 new one. Nothing has moved yet.",
      "2 个文档将放入 1 个已有文件夹和 1 个新文件夹。还没有移动任何文档。",
    ]);
  });

  test("into subfolders, when a Folder's own Organize sorted it", () => {
    const contracts = folder("contracts", "Contracts");
    const leases = folder("leases", "Leases", "contracts");
    const sub = (placements: OrganizeReviewPlacement[]) =>
      reviewLayout(
        review(
          placements.map((placement, at) => item(`${at}`, placement, { origin: "folder" })),
          [proposedFolder("nf-ndas", "NDAs", { parentId: "contracts" })],
        ),
        [contracts, leases],
        placements.map((_, at) => filed(`d-${at}`, "contracts")),
      );
    expect(both(sub([into("leases"), intoNew("nf-ndas")]))).toEqual([
      "2 Documents will move into 1 of its Subfolders and 1 new one. Nothing has moved yet.",
      "2 个文档将放入 1 个已有子文件夹和 1 个新子文件夹。还没有移动任何文档。",
    ]);
    expect(both(sub([into("leases"), into("leases")]))).toEqual([
      "2 Documents will move into 1 of its Subfolders. Nothing has moved yet.",
      "2 个文档将放入 1 个已有子文件夹。还没有移动任何文档。",
    ]);
    expect(both(sub([intoNew("nf-ndas"), intoNew("nf-ndas")]))).toEqual([
      "2 Documents will move into 1 new Subfolder. Nothing has moved yet.",
      "2 个文档将放入 1 个新子文件夹。还没有移动任何文档。",
    ]);
  });
});

describe("a Review with no Folder in it (#2339)", () => {
  const contract = {
    id: "row-1",
    tagId: null,
    kind: "contract" as const,
    name: "Contract",
    colour: "red" as const,
    description: "",
    addedByUser: false,
  };
  const tooFew: OrganizeReviewPlacement = { kind: "leftOut", leftOut: { reason: "tooFew" } };

  test("Tags waiting beside Documents too few like each other for a Folder: Tags only", () => {
    const layout = reviewLayout(
      review([
        item("1", { kind: "unchanged" }, { tags: [contract] }),
        item("2", tooFew),
        item("3", tooFew),
      ]),
      library,
      [],
      "Not in a Folder",
    );

    expect(layout.onlyTags).toBe(true);
    expect(layout.tagsOnly.map((card) => card.items.map((each) => each.id))).toEqual([["1"]]);
    expect(layout.leftOut.map((each) => each.id)).toEqual(["2", "3"]);
    expect([willMoveText(layout, en), willMoveText(layout, zh)]).toEqual([
      "1 Document will get Tags. Nothing has changed yet.",
      "1 个文档将添加标签。还没有做任何更改。",
    ]);
  });

  test("a Document that doesn't fit Folders there are isn't Tags only", () => {
    const layout = reviewLayout(
      review([
        item("1", { kind: "unchanged" }, { tags: [contract] }),
        item("2", { kind: "leftOut", leftOut: { reason: "doesntFit" } }),
      ]),
      library,
      [],
      "Not in a Folder",
    );

    expect(layout.onlyTags).toBe(false);
  });
});

describe("why a Document is left out", () => {
  const folderNames = new Map([
    ["matter", "Matter"],
    ["zh-matter", "案件"],
  ]);
  const names = (id: string) => folderNames.get(id) ?? id;
  const said = (
    leftOut: Parameters<typeof leftOutText>[0],
    stays: string | null = null,
  ): [string | null, string | null] => [
    leftOutText(leftOut, names, stays, en),
    leftOutText(leftOut, names, stays, zh),
  ];

  test("each reason in the app's own words", () => {
    expect(said({ reason: "doesntFit" })).toEqual([
      "Doesn’t fit these Folders",
      "不属于这些文件夹",
    ]);
    expect(said({ reason: "staysInFolder" }, "Contracts")).toEqual([
      "Stays in “Contracts”",
      "留在“Contracts”中",
    ]);
    expect(said({ reason: "tooFew" })).toEqual([
      "Too few like it for a Folder yet",
      "相近的文档太少，还不能建文件夹",
    ]);
    expect(said({ reason: "noTag" })).toEqual(["No Tag fits", "没有合适的标签"]);
    expect(said({ reason: "noText" })).toEqual(["No text to read", "没有可读取的文字"]);
    expect(said({ reason: "unreachable", service: "OpenAI" })).toEqual([
      "Couldn’t reach OpenAI",
      "无法连接 OpenAI",
    ]);
    expect(said({ reason: "walled", folderId: "matter" })).toEqual([
      "“Matter” keeps its work inside it",
      "“Matter”只在本文件夹内工作",
    ]);
    expect(said({ reason: "walled", folderId: "zh-matter" })[1]).toBe("“案件”只在本文件夹内工作");
  });

  test("nothing to say when the User moved it there, or it stays with no Folder named", () => {
    expect(said(null)).toEqual([null, null]);
    expect(said({ reason: "staysInFolder" })).toEqual([null, null]);
  });
});
