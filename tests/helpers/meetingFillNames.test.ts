/**
 * Where the fill check finds a name in a line it counts (#3013): the name opens the line, or
 * stands later, and why a person should read the line. Made-up calls in English and Chinese, each
 * kind of line beside a twin that goes the other way.
 */
import { describe, expect, test } from "vitest";
import { type NamedCall, type NamePlace, placeName } from "./meetingFillNames";

const OPENS: NamePlace = { where: "opens", read: [] };
const LATER: NamePlace = { where: "later", read: ["later"] };
const BREAK: NamePlace = { where: "opens", read: ["afterBreak"] };
const ALONE: NamePlace = { where: "opens", read: ["aloneAcross"] };

/** Hannah across with colleagues never named; Priya on the User's side. */
const PRINT_RUN: NamedCall = {
  turns: [{ side: "me" }, { side: "them" }, { side: "them" }, { side: "me" }],
  facts: [
    { said: [1], notBy: /Hannah/iu },
    { said: [2], owner: /Hannah/iu },
    { said: [3], owner: /Priya/iu },
  ],
};
const WEIGHT = { name: /Hannah/iu, pattern: [/340/i, /grams?/i] };

/** 孙悦 across with colleagues never named; 王磊 on the User's side. */
const CHECKUPS: NamedCall = {
  turns: [{ side: "me" }, { side: "them" }, { side: "them" }, { side: "me" }],
  facts: [
    { said: [1], notBy: /孙悦|孙经理|小孙/iu },
    { said: [2], owner: /孙悦|孙经理|小孙/iu },
    { said: [3], owner: /王磊/iu },
  ],
};
const LINKS = { name: /孙悦|孙经理|小孙/iu, pattern: [/链接|预约/i, /13 ?[号日]/i] };

describe.each<{
  call: NamedCall;
  line: { name: RegExp; pattern: RegExp[] };
  rows: [string, NamePlace][];
}>([
  {
    call: PRINT_RUN,
    line: WEIGHT,
    rows: [
      ["Hannah confirmed each copy is about 340 grams.", OPENS],
      ["Each copy is about 340 grams, which Hannah weighed on a dummy.", LATER],
      ["- Hannah confirmed each copy is about 340 grams.", OPENS],
      ["1. Hannah confirmed each copy is about 340 grams.", OPENS],
      ["(2) “Hannah confirmed each copy is about 340 grams.”", OPENS],
      ["- Then Hannah confirmed each copy is about 340 grams.", LATER],
      ["Paper weight: Hannah confirmed each copy is about 340 grams.", LATER],
      ["Hannah: each copy is about 340 grams.", BREAK],
      ["Account manager Hannah confirmed each copy is about 340 grams.", LATER],
      ["Hannah the account manager confirmed each copy is about 340 grams.", OPENS],
      ["Priya and Hannah agreed each copy is about 340 grams.", OPENS],
      ["Priya, Hannah and the buyer agreed each copy is about 340 grams.", OPENS],
      ["The buyer and Hannah agreed each copy is about 340 grams.", LATER],
      ["Priya told Hannah each copy is about 340 grams.", LATER],
      ["Hannah's colleague said each copy is about 340 grams.", LATER],
      ["Hannah’s team said each copy is about 340 grams.", LATER],
      ["Priya and Hannah's colleague agreed each copy is about 340 grams.", LATER],
      ["Hannah said each copy is about 340 grams.", OPENS],
      ["Hannah asked about the paper; each copy is about 340 grams.", BREAK],
      ["Hannah asked about the paper, and each copy is about 340 grams.", BREAK],
      ["Hannah weighed a dummy at 340 grams; the proof follows.", OPENS],
      ["Hannah (the account manager) confirmed each copy is about 340 grams.", OPENS],
      ["Hannah said 1,200 copies come out at 340 grams each.", OPENS],
    ],
  },
  {
    call: CHECKUPS,
    line: LINKS,
    rows: [
      ["孙悦在周五 13 号之前把预约链接发给我。", OPENS],
      ["周五 13 号之前，孙悦会把预约链接发给我。", LATER],
      ["- 孙悦在 13 号之前发预约链接。", OPENS],
      ["（1）孙经理在 13 号之前发预约链接。", OPENS],
      ["【小孙】13 号之前发预约链接。", OPENS],
      ["- 随后孙悦在 13 号之前发预约链接。", LATER],
      ["预约：孙悦在 13 号之前发链接。", LATER],
      ["孙悦：13 号之前发预约链接。", BREAK],
      ["体检科的孙经理在 13 号之前发预约链接。", LATER],
      ["孙经理在 13 号之前发预约链接。", OPENS],
      ["王磊和孙悦约好 13 号之前发预约链接。", OPENS],
      ["我和孙悦约好 13 号之前发预约链接。", OPENS],
      ["王磊、孙悦与排期约好 13 号之前发预约链接。", OPENS],
      ["排期和孙悦约好 13 号之前发预约链接。", LATER],
      ["我请孙悦在 13 号之前发预约链接。", LATER],
      ["孙悦的同事会在 13 号之前发预约链接。", LATER],
      ["孙悦那边会在 13 号之前发预约链接。", LATER],
      ["孙悦团队会在 13 号之前发预约链接。", LATER],
      ["孙悦会在 13 号之前发预约链接。", OPENS],
      ["孙悦确认13号前发预约链接", OPENS],
      ["周五孙悦确认13号前发预约链接", LATER],
      ["孙悦问了时间，13 号之前会发预约链接。", BREAK],
      ["孙悦 13 号之前发预约链接，我再转给同事。", OPENS],
      ["孙悦在周五（13 号）之前把预约链接发给我。", OPENS],
    ],
  },
])("where the name stands in a counted line", ({ call, line, rows }) => {
  test.each(rows)("%s", (text, expected) => {
    expect(placeName(call, { ...line, text })).toEqual(expected);
  });
});

/** Marta alone across from the User; the fact was said on the User's side. */
const CONTRACT: NamedCall = {
  turns: [{ side: "me" }, { side: "them" }, { side: "me" }],
  facts: [
    { said: [1], owner: /Marta/iu },
    { said: [2], notBy: /Marta/iu },
  ],
};
const SIGNING = { name: /Marta/iu, pattern: [/contract/i, /Friday/i] };

/** 陈晓梅 alone across from the User. */
const LEASE: NamedCall = {
  turns: [{ side: "me" }, { side: "them" }, { side: "them" }, { side: "me" }],
  facts: [
    { said: [1], owner: /陈晓梅|晓梅|陈女士/iu },
    { said: [1, 2], owner: /陈晓梅|晓梅|陈女士/iu },
    { said: [3], notBy: /陈晓梅|晓梅|陈女士/iu },
  ],
};
const DEPOSIT = { name: /陈晓梅|晓梅|陈女士/iu, pattern: [/合同/i, /周五/i] };

describe("a name-led line on a call with one named person alone across", () => {
  test.each<[string, NamedCall, { name: RegExp; pattern: RegExp[] }, string, NamePlace]>([
    ["Marta alone across", CONTRACT, SIGNING, "Marta will send the contract by Friday.", ALONE],
    [
      "Marta alone, the name later",
      CONTRACT,
      SIGNING,
      "The contract comes from Marta by Friday.",
      LATER,
    ],
    [
      "someone never named across as well",
      { ...CONTRACT, facts: [...CONTRACT.facts, { said: [1], notBy: /Marta/iu }] },
      SIGNING,
      "Marta will send the contract by Friday.",
      OPENS,
    ],
    [
      "the one across never named",
      {
        ...CONTRACT,
        facts: [{ said: [1], owner: /the other side|\bthey\b|对方/iu }, ...CONTRACT.facts.slice(1)],
      },
      SIGNING,
      "Marta will send the contract by Friday.",
      OPENS,
    ],
    [
      "two named people across",
      { ...CONTRACT, facts: [...CONTRACT.facts, { said: [1], owner: /Okafor/iu }] },
      SIGNING,
      "Marta will send the contract by Friday.",
      OPENS,
    ],
    ["陈晓梅 alone across", LEASE, DEPOSIT, "晓梅会在周五前把合同发过来。", ALONE],
    [
      "陈晓梅 alone, after a clause break",
      LEASE,
      DEPOSIT,
      "陈女士问了押金，周五前发合同。",
      { where: "opens", read: ["afterBreak", "aloneAcross"] },
    ],
    ["陈晓梅 alone, the name later", LEASE, DEPOSIT, "周五前陈晓梅会把合同发过来。", LATER],
  ])("%s", (_case, call, line, text, expected) => {
    expect(placeName(call, { ...line, text })).toEqual(expected);
  });
});
