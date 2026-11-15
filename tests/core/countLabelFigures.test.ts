/**
 * A number right after a label ending in 数 is a figure the check holds to its source (#3109): a
 * Note's "用户数860万。" cited to a Document that gives another number gets a figure part that
 * says what the Document gives, and a number a Document writes after 人数 backs a sentence that
 * states it.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { checkingModel, type Plan } from "../helpers/checks";
import { citationOf, setUpWithDocuments } from "../helpers/citations";
import { readMind, writeMind } from "../helpers/minds";

const USERS = "截至2025年底，平台用户数达到900万。";
const ATTENDANCE = "本次年会参会人数215人。";
const DOCUMENTS = [
  { name: "平台运营报告.txt", contents: `平台运营报告\n${USERS}\n` },
  { name: "年会纪要.txt", contents: `年会纪要\n${ATTENDANCE}\n` },
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
});
