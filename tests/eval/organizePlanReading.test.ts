import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  type Area,
  areasOf,
  byArea,
  type DocumentAreas,
  parseAreas,
  readAreas,
} from "../../eval/organize/lib/areas";
import type { Cover, FolderReading } from "../../eval/organize/lib/folderReader";
import {
  askKey,
  asksOf,
  type ReadDocument,
  type ReadFolder,
  readPlan,
} from "../../eval/organize/lib/planReading";
import { readSet } from "../../eval/organize/lib/set";

const root = fileURLToPath(new URL("../..", import.meta.url));

const covering = (yes: Area[], options: { part?: Area[]; arrangedBy?: string } = {}) =>
  ({
    areas: byArea(
      (area): Cover => (yes.includes(area) ? "yes" : options.part?.includes(area) ? "part" : "no"),
    ),
    arrangedBy: options.arrangedBy ?? "",
  }) satisfies FolderReading;

const folder = (key: string, reading: FolderReading): ReadFolder => ({ key, reading });

const doc = (
  id: string,
  areas: DocumentAreas,
  where: string | null,
  readable = true,
): ReadDocument => ({ id, readable, folder: where, areas });

const outcomes = (reading: ReturnType<typeof readPlan>) =>
  Object.fromEntries(reading.documents.map((each) => [each.id, each.outcome]));

describe("the areas the tuning half is read by", () => {
  test("are the second reader's, for exactly the set's 40 tuning Documents, as counted", async () => {
    const areas = await readAreas(root);
    const set = await readSet(root);
    const tune = set.documents.filter((each) => each.split === "tune");
    expect([...areas.keys()].sort()).toEqual(tune.map((each) => each.id).sort());
    const count = (language: "en" | "zh", area: Area, scansOnly = false) =>
      tune.filter(
        (each) =>
          each.language === language &&
          areasOf(areas.get(each.id) ?? { area: null }).includes(area) &&
          (!scansOnly || each.scanned === true),
      ).length;
    const order: Area[] = ["research", "reports", "contracts", "finance", "meetings", "personal"];
    const english = order.map((area) => count("en", area));
    const chinese = order.map((area) => count("zh", area));
    // A second area counts in both, so the English counts hold 4 Documents twice.
    expect(english).toEqual([4, 4, 5, 6, 4, 4]);
    expect(chinese).toEqual([3, 4, 2, 3, 3, 2]);
    expect([count("en", "research", true), count("en", "finance", true)]).toEqual([1, 1]);
    expect(count("zh", "finance", true)).toBe(1);
    const firsts = (language: "en" | "zh") =>
      tune
        .filter((each) => each.language === language)
        .map((each) => areas.get(each.id)?.area)
        .reduce<Record<string, number>>((tally, area) => {
          tally[area ?? "none"] = (tally[area ?? "none"] ?? 0) + 1;
          return tally;
        }, {});
    expect(firsts("en")).toEqual({
      research: 4,
      reports: 3,
      contracts: 4,
      finance: 5,
      meetings: 3,
      personal: 4,
    });
    expect(firsts("zh")).toEqual({
      research: 3,
      reports: 4,
      contracts: 2,
      finance: 3,
      meetings: 3,
      personal: 2,
    });
    expect([...areas.values()].filter((each) => each.second).length).toBe(4);
    expect(areas.get("zh-project-weekly-deck")).toEqual({ area: "reports" });
    expect(areas.get("en-stats-textbook")).toEqual({ area: "research" });
  });

  test("refuse a word that is no area, and a second area that isn't another one beside a first", () => {
    expect(() => parseAreas({ areas: { a: { area: "books" } } })).toThrow('"books" is no area');
    expect(() => parseAreas({ areas: { a: { area: null, second: "finance" } } })).toThrow(
      "second area",
    );
    expect(() => parseAreas({ areas: { a: { area: "finance", second: "finance" } } })).toThrow(
      "second area",
    );
    expect(parseAreas({ areas: { a: { area: null } } }).get("a")).toEqual({ area: null });
  });
});

describe("a plan read by the ruling's definitions", () => {
  test("a Folder of a person's own papers holds its four personal Documents rightly", () => {
    const reading = readPlan(
      ["coffee-manual", "journal", "recipe", "near-empty"].map((id) =>
        doc(id, { area: "personal" }, "home"),
      ),
      [folder("home", covering(["personal"]))],
    );
    expect(reading.counts).toEqual({
      right: 4,
      wrong: 0,
      rightlyLeftOut: 0,
      missed: 0,
      waiting: 0,
    });
  });

  test("工作项目与会议 holds the meetings Documents and the decks, the weekly deck as reports", () => {
    const reading = readPlan(
      [
        doc("action-tracker", { area: "meetings" }, "work"),
        doc("weekly-meeting", { area: "meetings" }, "work"),
        doc("launch-meeting", { area: "meetings" }, "work"),
        doc("project-weekly-deck", { area: "reports" }, "work"),
        doc("strategy-deck", { area: "reports" }, "work"),
      ],
      [folder("work", covering(["meetings", "reports"]))],
    );
    expect(reading.counts.right).toBe(5);
    expect(reading.counts.wrong).toBe(0);
  });

  test("财务与合同 holds two invoices and two contracts rightly", () => {
    const reading = readPlan(
      [
        doc("e-invoice", { area: "finance" }, "money"),
        doc("receipt", { area: "finance" }, "money"),
        doc("labor-contract", { area: "contracts" }, "money"),
        doc("lease", { area: "contracts" }, "money"),
      ],
      [folder("money", covering(["finance", "contracts"]))],
    );
    expect(reading.counts.right).toBe(4);
  });

  test("the coffee machine's manual under a research Folder is wrong; the textbook is right", () => {
    const reading = readPlan(
      [
        doc("anomaly-paper", { area: "research" }, "research"),
        doc("battery-paper", { area: "research" }, "research"),
        doc("stats-textbook", { area: "research" }, "research"),
        doc("coffee-manual", { area: "personal" }, "research"),
      ],
      [folder("research", covering(["research"]))],
    );
    expect(outcomes(reading)).toEqual({
      "anomaly-paper": "right",
      "battery-paper": "right",
      "stats-textbook": "right",
      "coffee-manual": "wrong",
    });
  });

  test("an e-invoice and a novel's reading notes under 学术研究 are wrong", () => {
    const reading = readPlan(
      [
        doc("heat-island-survey", { area: "research" }, "research"),
        doc("thesis-chapter", { area: "research" }, "research"),
        doc("battery-paper", { area: "research" }, "research"),
        doc("e-invoice", { area: "finance" }, "research"),
        doc("book-notes", { area: "personal" }, "research"),
      ],
      [folder("research", covering(["research"]))],
    );
    expect(reading.counts).toEqual({
      right: 3,
      wrong: 2,
      rightlyLeftOut: 0,
      missed: 0,
      waiting: 0,
    });
  });

  test("the labour contract under 工作与项目 is wrong, the meetings and reports in it right", () => {
    const work = (id: string, area: Area) => doc(id, { area }, "work");
    const reading = readPlan(
      [
        work("action-tracker", "meetings"),
        work("weekly-meeting", "meetings"),
        work("launch-meeting", "meetings"),
        work("survey-results", "reports"),
        work("strategy-deck", "reports"),
        work("project-weekly-deck", "reports"),
        work("prepared-food-report", "reports"),
        work("labor-contract", "contracts"),
      ],
      [folder("work", covering(["reports", "meetings"]))],
    );
    expect(reading.counts.right).toBe(7);
    expect(outcomes(reading)["labor-contract"]).toBe("wrong");
  });

  test("four personal Documents left out together, with no Folder for them, are missed", () => {
    const reading = readPlan(
      [
        ...["coffee-manual", "journal", "recipe", "near-empty"].map((id) =>
          doc(id, { area: "personal" }, null),
        ),
        doc("lease", { area: "contracts" }, "legal"),
      ],
      [folder("legal", covering(["contracts"]))],
    );
    expect(reading.counts).toEqual({
      right: 1,
      wrong: 0,
      rightlyLeftOut: 0,
      missed: 4,
      waiting: 0,
    });
  });

  test("two finance Documents left out, the third a scan, with no Folder for finance, are rightly left out", () => {
    const reading = readPlan(
      [
        doc("e-invoice", { area: "finance" }, null),
        doc("receipt", { area: "finance" }, null),
        doc("vat-invoice-scan", { area: "finance" }, null, false),
        doc("thesis", { area: "research" }, "research"),
      ],
      [folder("research", covering(["research"]))],
    );
    expect(reading.counts.rightlyLeftOut).toBe(2);
    expect(reading.scans).toEqual({ count: 1, filed: 0 });
    expect(reading.documents.map((each) => each.id)).not.toContain("vat-invoice-scan");
  });

  test("a scan a plan filed is on the scans' line, not among the outcomes", () => {
    const reading = readPlan(
      [
        doc("paper", { area: "research" }, "research"),
        doc("paper-scan", { area: "research" }, "research", false),
      ],
      [folder("research", covering(["research"]))],
    );
    expect(reading.scans).toEqual({ count: 1, filed: 1 });
    expect(reading.counts.right).toBe(1);
  });

  test("a left-out Document is missed when a Folder of the plan covers its area", () => {
    const reading = readPlan(
      [doc("one-invoice", { area: "finance" }, null), doc("ledger", { area: "finance" }, "money")],
      [folder("money", covering(["finance"]))],
    );
    expect(outcomes(reading)["one-invoice"]).toBe("missed");
  });

  test("with no Folder for its area, three of a kind is missed wherever the plan put the others", () => {
    const reading = readPlan(
      [
        doc("invoice-a", { area: "finance" }, null),
        doc("invoice-b", { area: "finance" }, "research"),
        doc("invoice-c", { area: "finance" }, "research"),
        doc("paper", { area: "research" }, "research"),
      ],
      [folder("research", covering(["research"]))],
    );
    expect(outcomes(reading)).toEqual({
      "invoice-a": "missed",
      "invoice-b": "wrong",
      "invoice-c": "wrong",
      paper: "right",
    });
  });

  test("a two-area Document is right under either area and counts in both", () => {
    const reading = readPlan(
      [
        doc("status-with-notes", { area: "reports", second: "meetings" }, "meetings"),
        doc("minutes-a", { area: "meetings" }, null),
        doc("minutes-b", { area: "meetings" }, null),
        doc("deck", { area: "reports" }, "work"),
      ],
      [folder("meetings", covering(["meetings"])), folder("work", covering(["reports"]))],
    );
    expect(outcomes(reading)["status-with-notes"]).toBe("right");
    expect(outcomes(reading)["minutes-a"]).toBe("missed");
    const without = readPlan(
      [
        doc("status-with-notes", { area: "reports", second: "meetings" }, "work"),
        doc("minutes-a", { area: "meetings" }, null),
        doc("minutes-b", { area: "meetings" }, null),
      ],
      [folder("work", covering(["reports"]))],
    );
    // minutes-b and the two-area report are two others of the meetings area.
    expect(outcomes(without)["minutes-a"]).toBe("missed");
  });

  test("a Document nobody could place is rightly left out when left out, and wrong when filed", () => {
    const reading = readPlan(
      [
        doc("unplaced-a", { area: null }, null),
        doc("unplaced-b", { area: null }, "any"),
        doc("unplaced-c", { area: null }, null),
      ],
      [
        folder(
          "any",
          covering(["research", "reports", "contracts", "finance", "meetings", "personal"]),
        ),
      ],
    );
    expect(outcomes(reading)).toEqual({
      "unplaced-a": "rightlyLeftOut",
      "unplaced-b": "wrong",
      "unplaced-c": "rightlyLeftOut",
    });
  });

  test("a Folder whose name says nothing covers no area, so what is filed there is wrong", () => {
    const reading = readPlan(
      [doc("invoice", { area: "finance" }, "other"), doc("journal", { area: "personal" }, "other")],
      [folder("other", covering([]))],
    );
    expect(reading.counts.wrong).toBe(2);
    expect(reading.counts.waiting).toBe(0);
  });

  test("a Folder arranged by something else waits for each Document's answer", () => {
    const documents = [
      doc("one-on-one", { area: "meetings" }, "team"),
      doc("employment", { area: "contracts" }, "team"),
      doc("journal", { area: "personal" }, null),
      doc("recipe", { area: "personal" }, null),
    ];
    const folders = [folder("team", covering([], { arrangedBy: "a team" }))];
    const waiting = readPlan(documents, folders);
    expect(waiting.counts.waiting).toBe(4);
    expect(asksOf(documents, folders)).toEqual([
      { document: "one-on-one", folder: "team" },
      { document: "employment", folder: "team" },
      { document: "journal", folder: "team" },
      { document: "recipe", folder: "team" },
    ]);
    const answered = readPlan(
      documents,
      folders,
      new Map([
        [askKey("one-on-one", "team"), true],
        [askKey("employment", "team"), false],
        [askKey("journal", "team"), false],
        [askKey("recipe", "team"), true],
      ]),
    );
    expect(outcomes(answered)).toEqual({
      "one-on-one": "right",
      employment: "wrong",
      journal: "rightlyLeftOut",
      recipe: "missed",
    });
  });

  test("a Folder covering part of an area asks only about Documents of that area", () => {
    const documents = [
      doc("industry-report", { area: "reports" }, "projects"),
      doc("minutes", { area: "meetings" }, "projects"),
    ];
    const folders = [folder("projects", covering(["meetings"], { part: ["reports"] }))];
    expect(asksOf(documents, folders)).toEqual([
      { document: "industry-report", folder: "projects" },
    ]);
    const answered = readPlan(
      documents,
      folders,
      new Map([[askKey("industry-report", "projects"), false]]),
    );
    expect(answered.counts).toEqual({
      right: 1,
      wrong: 1,
      rightlyLeftOut: 0,
      missed: 0,
      waiting: 0,
    });
  });
});
