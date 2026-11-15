/**
 * A number right after a label ending in 数 is a figure the check holds to its source (#3109): a
 * Note's "用户数860万。" or "员工总数五千二百人。" cited to a Document that gives another number
 * gets a figure part that says what the Document gives, a number a Document writes after 人数
 * backs a sentence that states it, and days after 天数 are held to the Document's days.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { checkingModel, type Plan } from "../helpers/checks";
import { citationOf, setUpWithDocuments } from "../helpers/citations";
import { readMind, writeMind } from "../helpers/minds";

const USERS = "截至2025年底，平台用户数达到900万。";
const ATTENDANCE = "本次年会参会人数215人。";
const STAFF = "截至年末，公司员工总数为5,300人。";
const DAYS = "本季度应收账款周转天数45天。";
const DAYS_EN = "Receivables were collected in 45 days on average this quarter.";
const DOCUMENTS = [
  { name: "平台运营报告.txt", contents: `平台运营报告\n${USERS}\n` },
  { name: "年会纪要.txt", contents: `年会纪要\n${ATTENDANCE}\n` },
  { name: "人事年报.txt", contents: `人事年报\n${STAFF}\n` },
  { name: "季度财务摘要.txt", contents: `季度财务摘要\n${DAYS}\n` },
  { name: "Quarterly summary.txt", contents: `Quarterly summary\n${DAYS_EN}\n` },
];

interface Line {
  text: string;
  cites: string;
  quote: string;
  /** The number the model names in the quote, as written there. */
  number: string;
}

const LINES = {
  wrongUsers: { text: "用户数860万。", cites: "平台运营报告", quote: USERS, number: "900万" },
  rightUsers: { text: "用户数900万。", cites: "平台运营报告", quote: USERS, number: "900万" },
  wrongAttendance: {
    text: "本次年会有251人参会。",
    cites: "年会纪要",
    quote: ATTENDANCE,
    number: "215人",
  },
  rightAttendance: {
    text: "本次年会有215人参会。",
    cites: "年会纪要",
    quote: ATTENDANCE,
    number: "215人",
  },
  wrongStaff: { text: "员工总数五千二百人。", cites: "人事年报", quote: STAFF, number: "5,300人" },
  rightStaff: { text: "员工总数五千三百人。", cites: "人事年报", quote: STAFF, number: "5,300人" },
  wrongDays: {
    text: "本季度应收账款周转天数30天。",
    cites: "季度财务摘要",
    quote: DAYS,
    number: "45天",
  },
  rightDays: { text: DAYS, cites: "季度财务摘要", quote: DAYS, number: "45天" },
  wrongDaysEn: {
    text: "Receivables were collected in 30 days on average this quarter.",
    cites: "Quarterly summary",
    quote: DAYS_EN,
    number: "45 days",
  },
  rightDaysEn: { text: DAYS_EN, cites: "Quarterly summary", quote: DAYS_EN, number: "45 days" },
} satisfies Record<string, Line>;

/** Each line Supported by the model on its quote: whether it stands is its figure's to decide. */
async function checkedNote(lines: readonly Line[]) {
  const plans = Object.fromEntries(
    lines.map((line): [string, Plan] => [
      line.text,
      { verdict: "supported", quote: line.quote, number: line.number, says: line.quote },
    ]),
  );
  const setup = await setUpWithDocuments(checkingModel(plans), DOCUMENTS);
  await setup.core.updateSettings({ user: { language: "zh-CN" } });
  const byName = (name: string) => {
    const document = setup.documents.find((each) => each.name === name);
    if (!document) throw new Error(`No Document named ${name}.`);
    return document;
  };
  writeMind(
    setup.client,
    await Promise.all(
      lines.map(async (line, index) => ({
        type: "paragraph",
        attrs: { id: `line-${index}` },
        content: [
          { type: "text", text: line.text },
          await citationOf(setup.core, byName(line.cites), line.quote),
        ],
      })),
    ),
  );
  await setup.client.settled();
  await setup.core.checkSentences({
    requestId: randomUUID(),
    mindId: setup.mind.id,
    action: "check-against-documents",
    from: { blockId: "line-0", offset: 0 },
    to: { blockId: `line-${lines.length - 1}`, offset: (lines.at(-1)?.text.length ?? 0) + 1 },
  });
  await setup.client.settled();
  const checks = new Map(
    claimSpans(readMind(setup.client)).map(({ sentence, check }) => [sentence.text, check]),
  );
  setup.core.close();
  return checks;
}

describe("a number right after a label ending in 数, through a Note's check (#3109)", () => {
  // protects=a Note's sentence that writes its number right after 用户数 is checked figure by figure, so 860万 cited to a Document that gives 900万 is Contradicted, its figure part saying the Document gives 900万, while 900万 reads Supported; fails_when=the sentence has no figure part and takes the model's Supported as it is; no_claim=a real model's verdict.
  test("用户数860万 cited to a Document that gives 900万 has a figure part that says so", async () => {
    const checks = await checkedNote([LINES.wrongUsers, LINES.rightUsers]);
    const wrong = checks.get(LINES.wrongUsers.text);
    expect(wrong?.state).toBe("contradicted");
    expect(wrong?.figures?.map((each) => [each.reading.chars, each.state, each.says])).toEqual([
      ["860万", "contradicted", "文档写的是“900万”，不是“860万”。"],
    ]);
    const right = checks.get(LINES.rightUsers.text);
    expect(right?.figures?.map((each) => [each.reading.chars, each.state])).toEqual([
      ["900万", "supported"],
    ]);
    expect(right?.state).toBe("supported");
  });

  // protects=a number a Document writes right after 人数 is read where the check looks for it, so a sentence that states 215人 reads Supported and one that states 251人 is Contradicted, its figure part saying the Document gives 215人; fails_when=the Document's number is not found, so the right sentence is not Supported and the wrong one's figure part names no number; no_claim=a real model's verdict.
  test("a number the Document writes after 人数 backs the sentence that states it", async () => {
    const checks = await checkedNote([LINES.wrongAttendance, LINES.rightAttendance]);
    const right = checks.get(LINES.rightAttendance.text);
    expect(right?.figures?.map((each) => [each.reading.chars, each.state])).toEqual([
      ["215人", "supported"],
    ]);
    expect(right?.state).toBe("supported");
    const wrong = checks.get(LINES.wrongAttendance.text);
    expect(wrong?.state).toBe("contradicted");
    expect(wrong?.figures?.map((each) => [each.reading.chars, each.state, each.says])).toEqual([
      ["251人", "contradicted", "文档写的是“215人”，不是“251人”。"],
    ]);
  });

  // protects=a count in Chinese numerals right after 员工总数 is checked figure by figure, so 五千二百人 cited to a Document that gives 5,300人 is Contradicted, its figure part saying the Document gives 5,300人, while 五千三百人 reads Supported; fails_when=the sentence has no figure part and takes the model's Supported as it is; no_claim=a real model's verdict.
  test("员工总数五千二百人 cited to a Document that gives 5,300人 has a figure part that says so", async () => {
    const checks = await checkedNote([LINES.wrongStaff, LINES.rightStaff]);
    const wrong = checks.get(LINES.wrongStaff.text);
    expect(wrong?.state).toBe("contradicted");
    expect(wrong?.figures?.map((each) => [each.reading.chars, each.state, each.says])).toEqual([
      ["五千二百人", "contradicted", "文档写的是“5,300人”，不是“五千二百人”。"],
    ]);
    const right = checks.get(LINES.rightStaff.text);
    expect(right?.figures?.map((each) => [each.reading.chars, each.state])).toEqual([
      ["五千三百人", "supported"],
    ]);
    expect(right?.state).toBe("supported");
  });

  // protects=days written right after 天数, in the Note and in the Document, are held to each other by the check's count of periods, so 30天 against the Document's 45天 is not Supported and 45天 is, and the wrong and right days read as the same days do in English; fails_when=the wrong days read Supported, the right days don't, or Chinese reads otherwise than English; no_claim=which verdict short of Supported the wrong days get (Not checked today, in both languages), or a real model's verdict.
  test("days after 天数 are held to the days the Document writes after 天数, as in English", async () => {
    const checks = await checkedNote([
      LINES.wrongDays,
      LINES.rightDays,
      LINES.wrongDaysEn,
      LINES.rightDaysEn,
    ]);
    const wrong = checks.get(LINES.wrongDays.text)?.state;
    expect(wrong).toBeDefined();
    expect(wrong).not.toBe("supported");
    expect(wrong).toBe(checks.get(LINES.wrongDaysEn.text)?.state);
    expect(checks.get(LINES.rightDays.text)?.state).toBe("supported");
    expect(checks.get(LINES.rightDaysEn.text)?.state).toBe("supported");
  });
});
