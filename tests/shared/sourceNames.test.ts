import { describe, expect, test } from "vitest";
import { citedSentences } from "../../src/shared/citedSentences";
import { namesOneOf } from "../../src/shared/namedSources";
import { INLINE_NODE } from "../../src/shared/sentences";
import { citedNameStretches, isNameNumber, onlyNamesItsSource } from "../../src/shared/sourceNames";

const ROW_12 = { kind: "rows", sheet: null, from: 12, to: 12 };
const SECTION_4 = { kind: "section", heading: "4. Termination" };
const AT_12_30 = { kind: "time", from: 745_000, to: 760_000 };
const lease = (name: string, page?: number) => ({
  documentName: name,
  ...(page !== undefined && { pageFrom: page, pageTo: page, location: null }),
});

describe("a sentence that only names the Document it cites (#3093)", () => {
  // protects=the words that are only a cited Document's name, with or without its extension (a version or a date after a dot is the name's), in brackets, quotation or title marks (an apostrophe inside), after a source label, before its Citation's chip, or with the Citation's own place after a comma, in brackets or after the closing mark, are the name and nothing else, and a bare name holding no measured figure is one; fails_when=one of them reads as a sentence to check; no_claim=the checks that use it, tested through the core.
  test.each([
    ["Lease 1", [lease("Lease 1")]],
    [`Lease 1${INLINE_NODE}`, [lease("Lease 1")]],
    ["Lease 1.txt", [lease("Lease 1")]],
    ["Lease 1", [lease("Lease 1.pdf")]],
    ["lease 1", [lease("Lease 1")]],
    ["(Lease 3)", [lease("Lease 3")]],
    ["[Lease 2].", [lease("Lease 2")]],
    ["Lease 4, p. 2", [lease("Lease 4", 2)]],
    ["附件3", [lease("附件3")]],
    ["（附件5）", [lease("附件5")]],
    ["【合同2】", [lease("合同2")]],
    ["附件4，第2页", [lease("附件4", 2)]],
    ["Lease 3", [lease("Lease 2"), lease("Lease 3")]],
    ["Annual Report 2024", [lease("Annual Report 2024")]],
    ["Invoice 1043", [lease("Invoice 1043")]],
    ["Net profit fell sharply", [lease("Net profit fell sharply")]],
    ["Source: Lease 2", [lease("Lease 2")]],
    ["see Lease 2", [lease("Lease 2")]],
    ["See also: Lease 3", [lease("Lease 3")]],
    ["Sources: Lease 3", [lease("Lease 3")]],
    ["Cf. Lease 1", [lease("Lease 1")]],
    ["REF Lease 1", [lease("Lease 1")]],
    ["Reference: Lease 1", [lease("Lease 1")]],
    ["From Lease 1", [lease("Lease 1")]],
    ["Per Lease 4, p. 2", [lease("Lease 4", 2)]],
    ["(Source: Lease 2)", [lease("Lease 2")]],
    ["Source: Northwind revenue rose 12% in Q3", [lease("Northwind revenue rose 12% in Q3")]],
    ["“Lease 1”", [lease("Lease 1")]],
    ['"Lease 1"', [lease("Lease 1")]],
    ["Lease 1 (p. 2)", [lease("Lease 1", 2)]],
    ["来源：附件2", [lease("附件2")]],
    ["来源附件2", [lease("附件2")]],
    ["见附件2", [lease("附件2")]],
    ["参见合同2", [lease("合同2")]],
    ["详见附件3", [lease("附件3")]],
    ["出处：附件3", [lease("附件3")]],
    ["资料来源：附件3", [lease("附件3")]],
    ["数据来源：三季度收入增长12%", [lease("三季度收入增长12%")]],
    ["《附件3》", [lease("附件3")]],
    ["「附件3」", [lease("附件3")]],
    ["附件3（第2页）", [lease("附件3", 2)]],
    ["Lease 2.1", [lease("Lease 2.1.pdf")]],
    ["Policy v1.2", [lease("Policy v1.2.pdf")]],
    ["Minutes 2026.11.14", [lease("Minutes 2026.11.14.docx")]],
    ["Budget 2024.2", [lease("Budget 2024.2.xlsx")]],
    ["会议纪要2026.11.14", [lease("会议纪要2026.11.14.docx")]],
    ["附件2.1", [lease("附件2.1.pdf")]],
    ["Deck (slide 3)", [{ documentName: "Deck", location: { kind: "slide", from: 3, to: 3 } }]],
    ["Model.xlsx (row 12)", [{ documentName: "Model.xlsx", location: ROW_12 }]],
    ["Model.xlsx (B12)", [{ documentName: "Model.xlsx", location: ROW_12 }]],
    ["Policy (§4)", [{ documentName: "Policy", location: SECTION_4 }]],
    ["Call (12:30)", [{ documentName: "Call", location: AT_12_30 }]],
    ["Notes (lines 3-5)", [{ documentName: "Notes", location: { kind: "lines", from: 3, to: 5 } }]],
    ["Lease 1 (page 2)", [lease("Lease 1", 2)]],
    ["Lease 1 (pp. 2-3)", [{ documentName: "Lease 1", pageFrom: 2, pageTo: 3, location: null }]],
    ["模型.xlsx（B12）", [{ documentName: "模型.xlsx", location: ROW_12 }]],
    ["政策（§4）", [{ documentName: "政策", location: SECTION_4 }]],
    ["会议录音（12:30）", [{ documentName: "会议录音", location: AT_12_30 }]],
    ["《附件3》（第2页）", [lease("附件3", 2)]],
    ["《附件3》，第2页", [lease("附件3", 2)]],
    ["《附件3》第2页", [lease("附件3", 2)]],
    ["“Lease 1”, p. 2", [lease("Lease 1", 2)]],
    ["“Lease 1” (p. 2)", [lease("Lease 1", 2)]],
    ["“Tenant's Lease”", [lease("Tenant's Lease")]],
    ['"Tenant\'s Lease"', [lease("Tenant's Lease")]],
    ["「O'Brien租约」", [lease("O'Brien租约")]],
  ])("%s only names it", (words, cited) => {
    expect(onlyNamesItsSource(words, cited)).toBe(true);
  });

  // protects=any other word, a label off the list, another Document's name ("Lease 2" for "Lease 2.1"), another page or place, what brackets hold that is no place, a place for a Citation with none, a bare name that states a measured figure, two names, a name that is only a number, and a sentence citing nothing keep the sentence read (#3093, #2003); fails_when=one of them is left out of the checks; no_claim=how the model judges it.
  test.each([
    ["Lease 2 sets the rent.", [lease("Lease 2")]],
    ["Lease 3", [lease("Lease 2")]],
    ["Lease 4, p. 1", [lease("Lease 4", 2)]],
    ["Lease 4, p. 2", [lease("Lease 4")]],
    ["附件3规定了租金。", [lease("附件3")]],
    ["Northwind revenue rose 12% in Q3", [lease("Northwind revenue rose 12% in Q3")]],
    ["Rent is 1100 euros a month", [lease("Rent is 1100 euros a month")]],
    ["三季度收入增长12%", [lease("三季度收入增长12%")]],
    ["Not in Lease 2", [lease("Lease 2")]],
    ["Void: Lease 2", [lease("Lease 2")]],
    ["Rent: Lease 2", [lease("Lease 2")]],
    ["租金：附件3", [lease("附件3")]],
    ["Source: Lease 3", [lease("Lease 2")]],
    ["Lease 1 (p. 3)", [lease("Lease 1", 2)]],
    ["《附件4》", [lease("附件3")]],
    ["Lease 1, Lease 2", [lease("Lease 1"), lease("Lease 2")]],
    ["Lease 2", [lease("Lease 2.1")]],
    ["Lease 2.1", [lease("Lease 2")]],
    ["附件2", [lease("附件2.1")]],
    ["附件2.1", [lease("附件2")]],
    ["Lease 1 (2)", [lease("Lease 1", 2)]],
    ["Lease 1 (1100 euros)", [lease("Lease 1")]],
    ["Lease 1 (void)", [lease("Lease 1")]],
    ["Deck (slide 4)", [{ documentName: "Deck", location: { kind: "slide", from: 3, to: 3 } }]],
    ["附件3（作废）", [lease("附件3")]],
    ["附件3（2）", [lease("附件3", 2)]],
    ["附件3第2页", [lease("附件3", 2)]],
    ["《附件3》第3页", [lease("附件3", 2)]],
    ["1043", [lease("1043")]],
    ["2025.pdf", [lease("2025")]],
    ["Lease 1", []],
    ["", [lease("Lease 1")]],
  ])("%s is still read", (words, cited) => {
    expect(onlyNamesItsSource(words, cited)).toBe(false);
  });
});

describe("where a sentence writes the whole name of a Document it cites (#3093)", () => {
  // protects=the whole name, with any case, its extension, CJK text around it, and a number with a decimal of its own name; never a longer number, a word it runs into, or a name that is only a number; fails_when=a stretch is found where the name doesn't stand, or missed where it does; no_claim=which figures the reader then drops.
  test.each([
    ["Unit 2 (Lease 2): 1100 euros", ["Lease 2"], ["Lease 2"]],
    ["see lease 2 for the rent", ["Lease 2"], ["lease 2"]],
    ["Lease 2.txt sets it", ["Lease 2"], ["Lease 2.txt"]],
    ["Lease 2.1 sets it", ["Lease 2.1"], ["Lease 2.1"]],
    ["见附件3。", ["附件3"], ["附件3"]],
    ["Lease 22 sets it", ["Lease 2"], []],
    ["Lease 2.5 months", ["Lease 2"], []],
    ["Lease 2,5 euros", ["Lease 2"], []],
    ["XLease 2 sets it", ["Lease 2"], []],
    ["附件31规定", ["附件3"], []],
    ["The total was 1043.", ["1043"], []],
    ["Lease 3 sets it", ["Lease 2"], []],
  ])("%s, citing %j: %j", (text, names, found) => {
    expect(citedNameStretches(text, names).map(({ from, to }) => text.slice(from, to))).toEqual(
      found,
    );
  });

  // protects=a plain number inside the name is the name's; one with its own unit, currency or scale, or outside the name, is a figure (#3093); fails_when=a figure of its own is dropped, or the name's number is kept; no_claim=how the reader reads a number.
  test("only a plain number inside the name is the name's", () => {
    const stretches = [{ from: 9, to: 16 }];
    const plain = { unit: { kind: "plain" }, currency: null, scale: 1 };
    expect(isNameNumber({ ...plain, start: 15, end: 16 }, stretches)).toBe(true);
    expect(isNameNumber({ ...plain, start: 5, end: 6 }, stretches)).toBe(false);
    expect(isNameNumber({ ...plain, start: 15, end: 18 }, stretches)).toBe(false);
    expect(
      isNameNumber({ ...plain, unit: { kind: "percent" }, start: 15, end: 16 }, stretches),
    ).toBe(false);
    expect(isNameNumber({ ...plain, currency: "euros", start: 15, end: 16 }, stretches)).toBe(
      false,
    );
    expect(isNameNumber({ ...plain, scale: 10_000, start: 15, end: 16 }, stretches)).toBe(false);
  });
});

describe("an Answer's sentence that only names its source (#3093)", () => {
  // protects=an Answer's sentence whose words are only its Citation's Document's name is no cited sentence, its name read without the Markdown its words lose (`*`, `_`, backtick), and a sentence with more words is still read; fails_when=the name-only sentence is judged or the other left out; no_claim=the batch the core sends.
  test("is no cited sentence, its Markdown read as its words are", () => {
    const named = "Annual_Report financial results summary";
    const cited = [{ marker: 1, documentName: named }];
    expect(citedSentences(`${named} [^1]\n`, [], cited)).toEqual([]);
    expect(citedSentences(`**${named}** [^1]\n`, [], cited)).toEqual([]);
    expect(
      citedSentences(`The ${named} shows revenue rose [^1].\n`, [], cited).map(
        (each) => each.sentence,
      ),
    ).toEqual(["The AnnualReport financial results summary shows revenue rose."]);
  });

  // protects=the rule's named cost: the words an Answer's check reads have lost their underscores, so the Document's name less its underscores is taken for the name and left out, while the name written with spaces where they were is other words, and read (#3093); fails_when=the space row is left out; no_claim=that a writer means "AnnualReport2024" as a claim.
  test.each([
    ["AnnualReport2024", "Annual_Report_2024.pdf", []],
    ["Annual Report 2024", "Annual_Report_2024.pdf", ["Annual Report 2024"]],
    ["年报2024年度", "年报_2024年度.pdf", []],
    ["年报 2024年度", "年报_2024年度.pdf", ["年报 2024年度"]],
  ])("%s citing %s: the cost of reading without underscores", (words, name, read) => {
    const cited = [{ marker: 1, documentName: name }];
    expect(citedSentences(`${words} [^1]\n`, [], cited).map((each) => each.sentence)).toEqual(read);
  });
});

describe("one rule for a file's extension (#3093)", () => {
  // protects=a Document's name keeps a number after a dot, a version or a date, and loses only an extension that starts with a letter, alike where a bracketed source is matched to a Document and where a sentence only names one; fails_when=a version or date is taken for an extension, or another Document's name is taken for this one; no_claim=which Citation the write then links.
  test.each([
    ["Lease 2.1", ["Lease 2.pdf"], false],
    ["Lease 2.1", ["Lease 2.1.pdf"], true],
    ["Lease 2", ["Lease 2.pdf"], true],
    ["Lease 2", ["Lease 2.1.pdf"], false],
    ["附件2.1", ["附件2.pdf"], false],
    ["附件2.1", ["附件2.1.pdf"], true],
  ])("%s names one of %j: %s", (name, names, named) => {
    expect(namesOneOf(name, names)).toBe(named);
  });
});
