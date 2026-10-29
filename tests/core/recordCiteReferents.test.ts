import { describe, expect, test } from "vitest";
import { recordCiteTokens } from "../../src/core/recordCites/parser";
import {
  linkRecordCites,
  type NoteParagraph,
  sentenceRecordCites,
} from "../../src/core/recordCites/referents";

const linked = (text: string) =>
  linkRecordCites(recordCiteTokens(text)).map((cite) =>
    cite.referent === undefined ? cite.raw : `${cite.raw} → ${cite.referent}`,
  );

const DECISION = "Hallmark v. Rio Grande, 512 S.W.3d 101 (Tex. 2017)";

describe("what an Id. or a supra refers to", () => {
  test("an Id. is the record item just before it, and a chain goes on through it", () => {
    expect(linked("(Smith Dep. 45:3–4; Ex. 7 at 3; id. at 4; id.)")).toEqual([
      "Smith Dep. 45:3–4",
      "Ex. 7 at 3",
      "id. at 4 → 1",
      "id. → 2",
    ]);
  });

  test("a court decision's Id. isn't a record cite, and its citation ends the chain", () => {
    expect(linked(`Smith Dep. 45:3–4; ${DECISION}; Id. at 105.`)).toEqual(["Smith Dep. 45:3–4"]);
    expect(linked(`${DECISION}; Smith Dep. 45:3–4; Id. at 46:1.`)).toEqual([
      "Smith Dep. 45:3–4",
      "Id. at 46:1 → 0",
    ]);
  });

  test("an Id. with nothing before it refers to no record item, and is listed only at a deposition's lines", () => {
    expect(linked("Id. at 7 says so.")).toEqual([]);
    expect(linked("Id. at 47:5-9. He left.")).toEqual(["Id. at 47:5-9 → null"]);
  });

  test("a statute, a regulation, a Restatement or an inline node ends the chain", () => {
    for (const between of [
      "The law is 42 U.S.C. § 1983.",
      "See 29 C.F.R. § 1604.11(a).",
      "The rule \uFFFC applies.",
      "Restatement (Second) of Contracts § 90 (1981).",
    ]) {
      expect(linked(`He said yes (Smith Dep. 45:3). ${between} Smith said no. Id.`)).toEqual([
        "Smith Dep. 45:3",
      ]);
      expect(linked(`He said yes (Smith Dep. 45:3). ${between} Id. at 46:1.`)).toEqual([
        "Smith Dep. 45:3",
      ]);
    }
    expect(linked("(Smith Dep. 45:3). Restatement (Second) of Contracts § 90. Id. § 4.")).toEqual([
      "Smith Dep. 45:3",
    ]);
  });

  test("a Citation chip beside a record cite in its sentence cites the same place", () => {
    expect(linked("ECF No. 41 at 3 states the deadline \uFFFC. Id. at 2 states another.")).toEqual([
      "ECF No. 41 at 3",
      "Id. at 2 → 0",
    ]);
  });

  test("a supra of another authority is never a record cite and ends the chain", () => {
    expect(
      linked("He said yes (Smith Dep. 45:3). Courts disagree. Smith, supra note 3, at 46."),
    ).toEqual(["Smith Dep. 45:3"]);
    expect(linked("(Smith Dep. 45:3). Hallmark, supra, at 105. Id. at 106.")).toEqual([
      "Smith Dep. 45:3",
    ]);
  });

  test("a short form with a pin cite it can't read is kept, unread, never read without it", () => {
    const found = linkRecordCites(
      recordCiteTokens("(Smith Dep. 45:3). Id. § 4. Smith Dep., supra note 3, at 46."),
    );
    expect(found.map((cite) => cite.raw)).toEqual(["Smith Dep. 45:3", "Id.", "Smith Dep., supra"]);
    expect(found.slice(1).map((cite) => cite.result.status)).toEqual(["error", "error"]);
  });

  test("an Id. after a cite that can't be read still refers to it, so it can't be placed either", () => {
    expect(linked("(Smith Dep. 45:12–3; id. at 46:1)")).toEqual([
      "Smith Dep. 45:12–3",
      "id. at 46:1 → 0",
    ]);
  });

  test("a named supra goes back to the latest cite of its source, past others", () => {
    expect(
      linked("(Smith Decl. ¶ 3; Ex. 7 at 3; Jones Decl. ¶ 4; Smith Decl., supra; id.)"),
    ).toEqual([
      "Smith Decl. ¶ 3",
      "Ex. 7 at 3",
      "Jones Decl. ¶ 4",
      "Smith Decl., supra → 0",
      "id. → 3",
    ]);
  });

  test("a court decision's citation doesn't end what a supra can name", () => {
    expect(linked(`(Ex. 7 at 3; ${DECISION}; Ex. 7, supra)`)).toEqual([
      "Ex. 7 at 3",
      "Ex. 7, supra → 0",
    ]);
  });

  test("a supra naming no record source is a decision's; one naming a record item is kept unplaced", () => {
    expect(linked("Hallmark, supra, at 105.")).toEqual([]);
    expect(linked("Smith Decl., supra.")).toEqual(["Smith Decl., supra → null"]);
  });

  test("a supra two earlier sources could be is left unplaced", () => {
    expect(linked("(Smith Decl. ¶ 3; Smith Decl. Ex. 2 at 1; Smith Decl., supra)")).toEqual([
      "Smith Decl. ¶ 3",
      "Smith Decl. Ex. 2 at 1",
      "Smith Decl., supra → null",
    ]);
  });
});

describe("a sentence's record cites read from its Note", () => {
  const note: NoteParagraph[] = [
    { blockId: "facts", text: "The courier arrived early (Smith Dep. 45:3–4). He left at noon." },
    { blockId: "more", text: "The sheet was signed. Id. at 46:1–2." },
    { blockId: "case", text: `The rule is settled. ${DECISION}.` },
    { blockId: "after", text: "It was late. Id. at 105." },
  ];

  test("an Id. in a later paragraph refers to the last record item before it", () => {
    const claim = "The sheet was signed. Id. at 46:1–2.";
    const { cites, own } = sentenceRecordCites(claim, { blockId: "more", from: 0 }, () => note);
    expect(own).toBe(1);
    expect(cites.map((cite) => cite.raw)).toEqual(["Smith Dep. 45:3–4", "Id. at 46:1–2"]);
    expect(cites[1]).toMatchObject({
      referent: 0,
      from: claim.indexOf("Id."),
      to: claim.length - 1,
    });
  });

  test("after a court decision's citation, an Id. is the decision's", () => {
    const claim = "It was late. Id. at 105.";
    expect(sentenceRecordCites(claim, { blockId: "after", from: 0 }, () => note)).toEqual({
      cites: [],
      own: 0,
    });
  });

  test("the Note is read only when a sentence's short form may refer back", () => {
    let reads = 0;
    const read = () => {
      reads++;
      return note;
    };
    sentenceRecordCites("The courier arrived early (Smith Dep. 45:3–4).", undefined, read);
    sentenceRecordCites("(Smith Dep. 45:3–4; id. at 46:1)", undefined, read);
    expect(reads).toBe(0);
    sentenceRecordCites("Id. at 46:1–2.", { blockId: "more", from: 22 }, read);
    expect(reads).toBe(1);
  });

  test("a sentence whose place moved is found by its words, once", () => {
    const claim = "The sheet was signed. Id. at 46:1–2.";
    expect(sentenceRecordCites(claim, { blockId: "more", from: 9 }, () => note).own).toBe(1);
    expect(sentenceRecordCites(claim, undefined, () => note).own).toBe(1);
    const twice = [...note, { blockId: "copy", text: claim }];
    expect(sentenceRecordCites(claim, undefined, () => twice).cites).toMatchObject([
      { raw: "Id. at 46:1–2", referent: null },
    ]);
  });

  test("an Id. after a statute in an earlier paragraph is the statute's", () => {
    const statute: NoteParagraph[] = [
      { blockId: "said", text: "He said yes (Smith Dep. 45:3)." },
      { blockId: "law", text: "The law is 42 U.S.C. § 1983." },
      { blockId: "no", text: "Smith said no. Id." },
    ];
    expect(
      sentenceRecordCites("Smith said no. Id.", { blockId: "no", from: 0 }, () => statute),
    ).toEqual({ cites: [], own: 0 });
  });

  test("checks read the same in any order: nothing of an earlier check is used", () => {
    const later = sentenceRecordCites("Id. at 105.", { blockId: "after", from: 13 }, () => note);
    const earlier = sentenceRecordCites(
      "The sheet was signed. Id. at 46:1–2.",
      { blockId: "more", from: 0 },
      () => note,
    );
    expect(later.own).toBe(0);
    expect(earlier.cites.map((cite) => cite.raw)).toEqual(["Smith Dep. 45:3–4", "Id. at 46:1–2"]);
  });

  test("reads Chinese sentences the same way", () => {
    const chinese: NoteParagraph[] = [
      {
        blockId: "zh",
        text: "快递员提前到达（Smith Dep. 45:3–4）。签收单已签字（Id. at 46:1–2）。",
      },
    ];
    const claim = "签收单已签字（Id. at 46:1–2）。";
    const found = sentenceRecordCites(
      claim,
      { blockId: "zh", from: chinese[0]?.text.indexOf(claim) ?? 0 },
      () => chinese,
    );
    expect(found.cites.map((cite) => cite.raw)).toEqual(["Smith Dep. 45:3–4", "Id. at 46:1–2"]);
    expect(found.cites[1]?.referent).toBe(0);
  });
});
