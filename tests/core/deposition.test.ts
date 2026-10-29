import { describe, expect, test } from "vitest";
import { stripBoilerplate } from "../../src/core/documents/boilerplate";
import {
  addDepositionAnchors,
  type DepositionLocation,
  resolveDeposition,
} from "../../src/core/documents/deposition";
import type { Anchor, UnitText } from "../../src/shared/units";

const pdfPage = (page: number, text: string, anchors: Anchor[] | null = null): UnitText => ({
  page,
  kind: "page",
  label: null,
  text,
  anchors,
});

const cite = (fromPage: number, fromLine: number, toPage = fromPage, toLine = fromLine) =>
  ({
    kind: "page",
    from: fromPage,
    to: toPage,
    printed: { from: String(fromPage), to: String(toPage) },
    lines: { from: fromLine, to: toLine },
  }) satisfies DepositionLocation;

function found(units: readonly UnitText[], location: DepositionLocation) {
  const result = resolveDeposition(units, location);
  expect(result.status).toBe("found");
  if (result.status !== "found") throw new Error("Expected a deposition range.");
  return result;
}

const digital = () => [
  pdfPage(
    8,
    [
      "Page 45",
      "1 Q. First question?",
      "2 A. Yes.",
      "3 Q. Third question?",
      "4 A. Last answer.",
    ].join("\n"),
  ),
  pdfPage(
    9,
    ["Page 46", "1 Q. Next page?", "2 A. Yes.", "3 Q. Beyond the cite?", "4 A. Beyond too."].join(
      "\n",
    ),
  ),
  pdfPage(10, ["Page 47", "1 Q. Third page?", "2 A. Do not include."].join("\n")),
];

const depositionAnchors = (unit: UnitText | undefined) =>
  (unit?.anchors ?? []).filter((anchor) => anchor.target.startsWith("deposition:"));

describe("Printed deposition source anchors (#1709)", () => {
  test("ordered digital rows gain exact source identities without changing the Units' text", () => {
    const units = digital();
    const before = units.map((unit) => unit.text);
    const mapped = addDepositionAnchors(units);

    expect(mapped.map((unit) => unit.text)).toEqual(before);
    expect(depositionAnchors(mapped[0]).map((anchor) => anchor.target)).toEqual([
      "deposition:page:45",
      "deposition:line:45:1",
      "deposition:line:45:2",
      "deposition:line:45:3",
      "deposition:line:45:4",
    ]);
    for (const anchor of mapped.flatMap((unit) => depositionAnchors(unit))) {
      expect(anchor.quad).toBeUndefined();
    }
    const third = depositionAnchors(mapped[0]).find(
      (anchor) => anchor.target === "deposition:line:45:3",
    );
    expect(third && mapped[0]?.text.slice(third.start, third.end)).toBe("Q. Third question?");

    const result = found(mapped, cite(45, 2, 45, 3));
    expect(result.units.map((unit) => unit.text)).toEqual(["A. Yes.", "Q. Third question?"]);
    expect(result.location).toEqual({ ...cite(45, 2, 45, 3), from: 8, to: 8 });
  });

  test("mapping is idempotent and preserves existing deposition anchors", () => {
    const existing = pdfPage(3, "Yes.", [{ start: 0, end: 4, target: "deposition:line:45:1" }]);
    expect(addDepositionAnchors([existing])[0]).toBe(existing);
    expect(found([existing], cite(45, 1)).units[0]?.text).toBe("Yes.");

    const once = addDepositionAnchors(digital());
    const twice = addDepositionAnchors(once);
    expect(twice).toEqual(once);
    expect(twice[0]).toBe(once[0]);
  });

  test("an explicit Page N region without printed line labels has no invented line map", () => {
    const labelled = pdfPage(1, "Page 45\nQ. First?\nYes.\nA. Last.");
    const oldKept = pdfPage(2, "Q. Not a new layout\n2 Not inherited");
    const mapped = addDepositionAnchors([labelled, oldKept]);

    expect(mapped[0]).toBe(labelled);
    expect(mapped[1]).toBe(oldKept);
    expect(resolveDeposition(mapped, cite(45, 1))).toEqual({ status: "not-found" });
  });

  test("an ordinary PDF's Page N footers stay boilerplate, so its Passages are unchanged", () => {
    const bodies = [
      "Revenue grew in every region.",
      "Costs were flat against the plan.",
      "Cash rose after the bond sale.",
      "The board approved the dividend.",
    ];
    const report = bodies.map((body, index) =>
      pdfPage(index + 1, ["ACME Corp Annual Report", body, `Page ${index + 1}`].join("\n")),
    );

    const cleaned = stripBoilerplate(addDepositionAnchors(report));
    expect(cleaned).toEqual(stripBoilerplate(report));
    expect(cleaned.map((page) => page.text)).toEqual(bodies);
  });

  test("a report page whose rows only start with numbers keeps its page number as boilerplate", () => {
    const bodies = [
      ["2019 revenue grew in every region.", "12 months ended in June."],
      ["2020 costs were flat.", "3 plants closed."],
      ["2021 cash rose.", "40 staff joined."],
      ["2022 the board approved the dividend.", "7 directors met."],
    ];
    const report = bodies.map((lines, index) =>
      pdfPage(index + 1, [`Page ${index + 1}`, "ACME Corp Annual Report", ...lines].join("\n")),
    );

    expect(addDepositionAnchors(report)).toEqual(report);
    expect(stripBoilerplate(addDepositionAnchors(report)).map((page) => page.text)).toEqual(
      bodies.map((lines) => lines.join("\n")),
    );
  });

  test("a region whose numbered lines skip one, or don't start at 1, gets no line map", () => {
    for (const text of [
      "Page 45\n1 Q. One?\n2 A. Two.\n4 Q. Four?",
      "Page 45\n2 A. Two.\n3 Q. Three?",
    ]) {
      const page = pdfPage(1, text);
      expect(addDepositionAnchors([page])[0]).toBe(page);
    }
  });

  test("a header above margin line 1 is Not found, never lines shifted by one", () => {
    const unit = pdfPage(
      2,
      "Page 45\nDeposition caption\n1\nQ. First?\n2\nA. Second.\n3\nQ. Third?\n4\nA. Fourth.",
    );
    // Each number could go with the row after it or, the caption taken as line 1, before it.
    expect(resolveDeposition([unit], cite(45, 3, 45, 4))).toEqual({ status: "not-found" });
  });

  test("a margin number goes with the one side that gives every number its own row", () => {
    const after = pdfPage(2, "Page 45\n1\nQ. First?\n2\nA. Second.\n3\nQ. Third?\nFooter");
    expect(found([after], cite(45, 2, 45, 3)).units.map((each) => each.text)).toEqual([
      "A. Second.",
      "Q. Third?",
    ]);
    const before = pdfPage(2, "Page 45\nCaption\nQ. First?\n1\nA. Second.\n2\nQ. Third?\n3");
    expect(found([before], cite(45, 2, 45, 3)).units.map((each) => each.text)).toEqual([
      "A. Second.",
      "Q. Third?",
    ]);
  });

  test("an unnumbered row between numbered lines is Not found, not added to a line", () => {
    const unit = pdfPage(2, "Page 45\n1 Q. First?\ncontinued without a number\n2 A. Second.");
    expect(resolveDeposition([unit], cite(45, 1, 45, 2))).toEqual({ status: "not-found" });
  });

  test("one ambiguous margin label invalidates the whole region", () => {
    const unit = pdfPage(
      2,
      "Page 45\n1 Q. First\nCaption\n2\nQ. Could be before\nA. Could be after\n3 Q. Otherwise valid",
    );
    expect(resolveDeposition([unit], cite(45, 2))).toEqual({ status: "not-found" });
  });

  test("margin labels pair with their source rows", () => {
    const unit = pdfPage(2, "Page 45\n1\nQ. From the margin?\n2\nA. From the next row.");
    const result = found([unit], cite(45, 1, 45, 2));
    expect(result.units.map((each) => each.text)).toEqual([
      "Q. From the margin?",
      "A. From the next row.",
    ]);
  });

  test("content-first margin labels pair with the previous row", () => {
    const unit = pdfPage(2, "Page 45\nQ. First?\n1\nA. Second.\n2");
    const result = found([unit], cite(45, 1, 45, 2));
    expect(result.units.map((each) => each.text)).toEqual(["Q. First?", "A. Second."]);
  });

  test("out-of-order labelled rows resolve in printed-line order", () => {
    const unit = pdfPage(2, "Page 45\n2 A. Second in the citation.\n1 Q. First in the citation?");
    const result = found([unit], cite(45, 1, 45, 2));
    expect(result.units.map((each) => each.text)).toEqual([
      "Q. First in the citation?",
      "A. Second in the citation.",
    ]);
  });

  test("shuffled OCR lines use printed labels while lineN anchors stay untouched", () => {
    const rows = ["Page 45", "3 Yes.", "1 Q. Shuffled?", "2 Yes."];
    const text = rows.join("\n");
    let offset = 0;
    const ocrAnchors = rows.map((row, index) => {
      const anchor = {
        start: offset,
        end: offset + row.length,
        target: `line${index + 1}`,
        quad: [0, index / 10, 1, index / 10, 1, (index + 1) / 10, 0, (index + 1) / 10],
      };
      offset += row.length + 1;
      return anchor;
    });
    const unit: UnitText = {
      ...pdfPage(5, text, ocrAnchors),
      label: { scan: { reader: "test/1" } },
    };
    const mapped = addDepositionAnchors([unit]);

    expect(mapped[0]?.anchors?.slice(0, ocrAnchors.length)).toEqual(ocrAnchors);
    expect(mapped[0]?.anchors?.slice(0, ocrAnchors.length).every((anchor) => anchor.quad)).toBe(
      true,
    );
    expect(depositionAnchors(mapped[0]).every((anchor) => anchor.quad === undefined)).toBe(true);

    const result = found(mapped, cite(45, 1, 45, 3));
    expect(result.units.map((each) => each.text)).toEqual(["Q. Shuffled?", "Yes.", "Yes."]);
    expect(result.units.map((each) => each.page)).toEqual([5, 5, 5]);
  });

  test("repeated Yes. rows resolve by printed line, not by their text", () => {
    const unit = pdfPage(1, "Page 45\n1 Q. First?\n2 Yes.\n3 Q. Again?\n4 Yes.");
    const second = found([unit], cite(45, 2));
    const fourth = found([unit], cite(45, 4));

    expect(second.units[0]?.text).toBe("Yes.");
    expect(fourth.units[0]?.text).toBe("Yes.");
    expect(depositionAnchors(second.units[0]).map((anchor) => anchor.target)).toEqual([
      "deposition:line:45:2",
    ]);
    expect(depositionAnchors(fourth.units[0]).map((anchor) => anchor.target)).toEqual([
      "deposition:line:45:4",
    ]);
    expect(second.units[0]?.anchors).not.toEqual(fourth.units[0]?.anchors);
  });

  test("45:3-46:2 crosses a page break and excludes the third page", () => {
    const request = { ...cite(45, 3, 46, 2), from: 1, to: 1 };
    const result = found(digital(), request);

    expect(result.units.map((unit) => unit.text)).toEqual([
      "Q. Third question?",
      "A. Last answer.",
      "Q. Next page?",
      "A. Yes.",
    ]);
    expect(result.units.map((unit) => unit.page)).toEqual([8, 8, 9, 9]);
    expect(result.location).toEqual({ ...request, from: 8, to: 9 });
    expect(
      result.units.flatMap((unit) => depositionAnchors(unit)).map((anchor) => anchor.target),
    ).toEqual([
      "deposition:line:45:3",
      "deposition:line:45:4",
      "deposition:line:46:1",
      "deposition:line:46:2",
    ]);
  });

  test("multiple logical pages on one physical Unit resolve without their markers or neighbours", () => {
    const unit = pdfPage(
      4,
      "Page 45\n1 Q. One?\n2 A. Two.\nPage 46\n1 Q. Three?\n2 A. Four.\nPage 47\n1 Q. Excluded?",
    );
    const result = found([unit], cite(45, 2, 46, 2));

    expect(result.units.map((each) => each.text)).toEqual(["A. Two.", "Q. Three?", "A. Four."]);
    expect(result.units.every((each) => each.page === 4)).toBe(true);
    expect(result.location.from).toBe(4);
    expect(result.location.to).toBe(4);
  });

  test("duplicate pages are not-found even when their line labels do not overlap", () => {
    const unit = pdfPage(1, "Page 45\n1 Q. First copy?\nPage 45\n2 A. Conflicting copy.");
    expect(resolveDeposition([unit], cite(45, 2))).toEqual({ status: "not-found" });
  });

  test("duplicate lines are not-found instead of taking the first match", () => {
    const unit = pdfPage(1, "Page 45\n1 Yes.\n1 No.\n2 Unique.");
    expect(resolveDeposition([unit], cite(45, 1))).toEqual({ status: "not-found" });
    expect(found([unit], cite(45, 2)).units[0]?.text).toBe("Unique.");
  });

  test("contradictory existing markers invalidate both claimed pages", () => {
    const text = "Page 45\n1 Yes.";
    const unit = pdfPage(1, text, [
      { start: 0, end: 7, target: "deposition:page:45" },
      { start: text.indexOf("Yes."), end: text.length, target: "deposition:line:46:1" },
    ]);

    expect(addDepositionAnchors([unit])[0]).toBe(unit);
    expect(resolveDeposition([unit], cite(45, 1))).toEqual({ status: "not-found" });
    expect(resolveDeposition([unit], cite(46, 1))).toEqual({ status: "not-found" });
  });

  test("missing lines, pages and out-of-range requests are not-found", () => {
    const unit = pdfPage(1, "Page 45\n1 Q. One?\n3 A. Three.");
    expect(resolveDeposition([unit], cite(45, 1, 45, 2))).toEqual({ status: "not-found" });
    expect(resolveDeposition([unit], cite(45, 3, 45, 4))).toEqual({ status: "not-found" });
    expect(resolveDeposition([unit], cite(45, 1, 46, 1))).toEqual({ status: "not-found" });
    expect(resolveDeposition([unit], cite(45, 3, 45, 1))).toEqual({ status: "not-found" });
  });

  test("a markerless old kept Unit never inherits its neighbour's layout", () => {
    const first = pdfPage(1, "Page 45\n1 Q. Only mapped line?");
    const kept = pdfPage(2, "2 A. Old text without a marker.");
    const last = pdfPage(3, "Page 46\n1 Q. Next page?");
    const mapped = addDepositionAnchors([first, kept, last]);

    expect(mapped[1]).toBe(kept);
    expect(depositionAnchors(mapped[1])).toEqual([]);
    expect(resolveDeposition(mapped, cite(45, 2))).toEqual({ status: "not-found" });
  });

  test("no Page N markers means no deposition map, including ordinary TXT lines", () => {
    const plainPdf = pdfPage(1, "1 Yes.\n2 No.");
    const txt: UnitText = {
      page: null,
      kind: "lines",
      label: { from: 1, to: 2 },
      text: "Page 45\n1 Yes.",
      anchors: null,
    };

    expect(addDepositionAnchors([plainPdf])[0]).toBe(plainPdf);
    expect(addDepositionAnchors([txt])[0]).toBe(txt);
    expect(resolveDeposition([plainPdf], cite(45, 1))).toEqual({ status: "not-found" });
    expect(resolveDeposition([txt], cite(45, 1))).toEqual({ status: "not-found" });
    expect(txt.text).toBe("Page 45\n1 Yes.");
  });
});
