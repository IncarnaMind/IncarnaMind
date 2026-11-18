/**
 * Which rows of a Word file's or a deck's table head its columns (#3318): a table of labels and
 * values with no heading row keeps its first row as a row, and a table with a real heading row is
 * headed as before.
 */
import { describe, expect, test } from "vitest";
import { slideBlocks } from "../../src/core/answers/checks/verifySlides";
import { cellTable, headingRowsOf } from "../../src/core/documents/tableCells";

const KEY_FACTS = [
  ["Founded", "2019"],
  ["Head office", "Port Ellery"],
  ["Chair", "Dana Reyes"],
  ["Staff", "240"],
];

describe("a table of labels and values with no heading row (#3318)", () => {
  // protects=a table of labels and values keeps every row as a row, none said under another row's cells (#3318); fails_when=its first row, a year beside a label, is read as the columns' headings
  test.each([
    ["a year", KEY_FACTS],
    [
      "a year, three rows",
      [
        ["Founded", "2019"],
        ["Head office", "Port Ellery"],
        ["Staff", "240"],
      ],
    ],
    [
      "a date",
      [
        ["Opened", "2019-03-01"],
        ["Head office", "Port Ellery"],
        ["Chair", "Dana Reyes"],
        ["Staff", "240"],
      ],
    ],
    [
      "a year in Chinese",
      [
        ["成立年份", "2019"],
        ["总部", "东港"],
        ["董事长", "林岚"],
        ["员工人数", "240"],
      ],
    ],
  ])("with %s in its first row has no heading row", (_name, rows) => {
    expect(headingRowsOf(rows)).toBe(0);
  });

  test("its rows are read as rows of the table, with no headings", () => {
    const read = cellTable(KEY_FACTS);
    expect(read?.headings).toEqual(["", ""]);
    expect(read?.rows).toEqual(KEY_FACTS);
  });

  test("a deck's table of the same shape checks every row, with no heading above them", () => {
    const blocks = slideBlocks([
      {
        number: 1,
        hidden: false,
        title: "Key facts",
        blocks: [],
        tables: [KEY_FACTS],
        charts: [],
        images: [],
        notes: [],
      },
    ]);
    const table = blocks.find((block) => block.node.type === "table");
    const rows = table?.node.content ?? [];
    expect(rows.map((row) => row.content?.map((cell) => cell.type))).toEqual(
      KEY_FACTS.map(() => ["tableCell", "tableCell"]),
    );
    expect(rows.map((row) => row.content?.[0]?.content?.[0]?.content?.[0]?.text)).toEqual(
      KEY_FACTS.map(([label]) => label),
    );
  });
});

describe("a table with a real heading row (#3318)", () => {
  const headed: [string, string[][], number][] = [
    [
      "years over figures",
      [
        ["Region", "2023", "2024"],
        ["North", "1,200", "1,500"],
        ["South", "660", "900"],
      ],
      1,
    ],
    [
      "one year over figures",
      [
        ["Region", "2024"],
        ["North", "1,500"],
        ["South", "900"],
        ["East", "700"],
      ],
      1,
    ],
    [
      "years over figures with a placeholder and a blank",
      [
        ["Region", "2023", "2024"],
        ["North", "1,200", "n/a"],
        ["South", "—", "900"],
        ["East", "", "700"],
      ],
      1,
    ],
    [
      "years over figures with one word among many figures",
      [
        ["Region", "2023", "2024"],
        ["North", "1,200", "1,500"],
        ["South", "see note", "900"],
        ["East", "300", "700"],
        ["West", "410", "520"],
      ],
      1,
    ],
    [
      "one year over figures with a word among them",
      [
        ["Region", "2024"],
        ["North", "1,500"],
        ["South", "see note"],
        ["East", "700"],
        ["West", "520"],
      ],
      1,
    ],
    [
      "two years over figures, one column with a word beside a figure",
      [
        ["Region", "2023", "2024"],
        ["North", "1,200", "1,500"],
        ["South", "see note", "900"],
      ],
      1,
    ],
    [
      "words over figures",
      [
        ["Region", "Sales"],
        ["North", "1,200"],
        ["South", "660"],
      ],
      1,
    ],
    [
      "a year row over a units row",
      [
        ["", "2023", "2024"],
        ["", "£m", "£m"],
        ["North", "1.2", "1.5"],
        ["South", "0.7", "0.9"],
      ],
      2,
    ],
    [
      "a title row over a year row",
      [
        ["", "Revenue", "Revenue"],
        ["", "2023", "2024"],
        ["North", "1.2", "1.5"],
        ["South", "0.7", "0.9"],
      ],
      2,
    ],
    [
      "dates over figures",
      [
        ["Site", "2024-01-31", "2024-02-29"],
        ["North", "12", "15"],
        ["South", "7", "9"],
      ],
      1,
    ],
  ];

  // protects=a table with a heading row is headed as before, a year over a column of figures still names it (#3318); fails_when=the rule for a table with no heading row takes a real heading row for a row of values
  test.each(headed)("%s stays headed", (_name, rows, count) => {
    expect(headingRowsOf(rows)).toBe(count);
    const read = cellTable(rows);
    expect(read?.rows).toHaveLength(rows.length - count);
    expect(read?.headings[0]).toBe(rows[0]?.[0] ?? "");
  });
});
