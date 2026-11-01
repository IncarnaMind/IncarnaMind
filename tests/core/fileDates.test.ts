import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import type { ConversationAnswer } from "../../src/core";
import { datedDocumentsNote, fileDatesNote } from "../../src/core/answers/prompt";
import type { Language } from "../../src/core/language";
import { askAssistant } from "../helpers/assistant";
import { type ShownPassage, shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import {
  answerRequests,
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
} from "../helpers/models";
import { buildPdf } from "../helpers/pdf";

/**
 * A summary and an Answer state only what the Document's text says (#1173):
 * a contract whose text gives no date is never said to be signed on the day
 * its file was made. Through the core's public interface, in the assistant,
 * as a newcomer asks: what the model is sent, and what the User sees.
 */

const FILE_CREATED = "2026-03-18";

interface Walk {
  system: string;
  pdf: Uint8Array;
  summarise: string;
  signed: string;
  heading: string;
  /** Each summary sentence, with the line of the contract its Citation quotes. */
  sentences: readonly { text: string; quote: string }[];
  blank: { text: string; quote: string };
  /** What a model that takes the Passages' date for the contract's writes. */
  signedOn: (date: string) => string;
}

const WALKS: Record<Language, Walk> = {
  en: {
    system: "en-US",
    pdf: buildPdf(
      [
        {
          lines: [
            "Employment contract",
            "Employer: Harbour Logistics",
            "Employee: Wei Chen",
            "Position: Warehouse supervisor",
            "Term: three years, with a probation period of three months",
            "Salary: 3,200 pounds a month",
            "Date of signing: ______________",
          ],
        },
      ],
      { info: { CreationDate: "D:20260318101500+08'00'" } },
    ),
    summarise: "Summarise this contract.",
    signed: "When was this contract signed?",
    heading: "## Employment contract",
    sentences: [
      {
        text: "Harbour Logistics employs Wei Chen as a warehouse supervisor.",
        quote: "Position: Warehouse supervisor",
      },
      {
        text: "The term is three years, with a probation period of three months.",
        quote: "Term: three years, with a probation period of three months",
      },
      { text: "The salary is 3,200 pounds a month.", quote: "Salary: 3,200 pounds a month" },
    ],
    blank: {
      text: "The contract leaves its date of signing blank.",
      quote: "Date of signing:",
    },
    signedOn: (date) => `It was signed on ${date}.`,
  },
  "zh-CN": {
    system: "zh-CN",
    pdf: buildPdf(
      [
        {
          chineseLines: [
            "劳动合同",
            "甲方：海港物流有限公司",
            "乙方：陈伟",
            "工作岗位：仓库主管",
            "合同期限：三年，其中试用期三个月",
            "劳动报酬：每月八千元",
            "签订日期：　　年　　月　　日",
          ],
        },
      ],
      { info: { CreationDate: "D:20260318101500+08'00'" } },
    ),
    summarise: "总结一下这份合同。",
    signed: "这份合同是什么时候签订的？",
    heading: "## 劳动合同",
    sentences: [
      { text: "海港物流有限公司聘用陈伟担任仓库主管。", quote: "工作岗位：仓库主管" },
      { text: "合同期限为三年，其中试用期三个月。", quote: "合同期限：三年，其中试用期三个月" },
      { text: "劳动报酬为每月八千元。", quote: "劳动报酬：每月八千元" },
    ],
    blank: { text: "合同中的签订日期是空白的。", quote: "签订日期：" },
    signedOn: (date) => `签订日期为 ${date}。`,
  },
};

const withMarker = (sentence: string, marker: number) =>
  sentence.replace(/([.。])$/u, `[^${marker}]$1`);

/** Everything a request sent the model: its instructions, messages and Tool results. */
function sentText(model: MockLanguageModelV4, from: number): string {
  const own = answerRequests(model);
  return model.doStreamCalls
    .slice(from)
    .filter((call) => own.includes(call))
    .flatMap((call) =>
      call.prompt.flatMap((message) =>
        typeof message.content === "string"
          ? [message.content]
          : message.content.flatMap((part) =>
              part.type === "text"
                ? [part.text]
                : part.type === "tool-result" && part.output.type === "text"
                  ? [part.output.value]
                  : [],
            ),
      ),
    )
    .join("\n\n");
}

/**
 * A model that summarises from the contract's text, and that, like the model
 * the issue was seen with, takes a Passage's `date` for the day the contract
 * was signed. It cites each sentence it writes.
 */
function contractReader(walk: Walk) {
  return scriptedModel(
    (call: ModelCall): ScriptedReply => {
      const passages = shownPassages(
        [call.prompt, ...call.results.map((each) => each.text)].join("\n\n"),
      );
      const contract = passages.find((passage) => passage.document === "Contract");
      if (!contract) return { calls: [{ tool: "search_documents", input: { query: "contract" } }] };
      const asksSigned = call.prompt.includes(walk.signed);
      const lines = asksSigned ? [walk.blank] : walk.sentences;
      if (!citedSince(call)) {
        return {
          calls: [
            {
              tool: "cite",
              input: {
                citations: lines.map((line, index) => record(contract, index + 1, line.quote)),
              },
            },
          ],
        };
      }
      const stated = /^date="([^"]+)"$/.exec(contract.date ?? "")?.[1];
      const cited = lines.map((line, index) => withMarker(line.text, index + 1)).join(" ");
      const said = stated ? `${cited} ${walk.signedOn(stated)}` : cited;
      return { text: asksSigned ? said : `${walk.heading}\n\n${said}` };
    },
    { judgesItsAnswers: true },
  );
}

const citedSince = (call: ModelCall) => call.results.some((result) => result.tool === "cite");

const record = (passage: ShownPassage, marker: number, quote: string) => ({
  marker,
  passage: passage.id,
  pageFrom: 1,
  pageTo: 1,
  quote,
});

async function setUp(language: Language) {
  const walk = WALKS[language];
  const model = contractReader(walk);
  const core = startCore(await createTempDataFolder(), {
    systemLanguages: () => [walk.system],
    createChatModel: () => model,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  await addAndProcess(core, [
    await writeSourceFile(await createSourceFolder(), "Contract.pdf", walk.pdf),
  ]);
  return { walk, core, model };
}

function sentencesOf(answer: ConversationAnswer): { text: string; markers: number[] }[] {
  return answer.text
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("#"))
    .flatMap((line) => line.match(/[^.。!?！？]+[.。!?！？]?/gu) ?? [])
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== "")
    .map((text) => ({
      text,
      markers: [...text.matchAll(/\[\^(\d+)\]/g)].map((match) => Number(match[1])),
    }));
}

const SIGNED_OR_MADE = /signed on|made on|dated|签订日期为|签订于|签署于|订立于|日期为/i;

for (const language of ["en", "zh-CN"] as const) {
  describe(`A contract whose text gives no date, in ${language === "en" ? "English" : "Chinese"}`, {
    timeout: 60_000,
  }, () => {
    // protects=the day a contract's file was made reaches the model only labelled as the file's, with the note that it is no date of the Document, so a summary and an Answer that take a Passage's date for the signing date have none to take; fails_when=a Passage carries the file's creation date as date="…", the note is missing, or the date appears unlabelled anywhere the model is sent; no_claim=whether a real model follows the note, which the hand test and the everyday-requests eval cover.
    test("its summary and an Answer about its signing give no signing or creation date", async () => {
      const { walk, core, model } = await setUp(language);

      const summary = await askAssistant(core, { text: walk.summarise });
      const summarySent = sentText(model, 0);
      const seen = model.doStreamCalls.length;
      const answer = await askAssistant(core, {
        conversationId: summary.conversationId,
        text: walk.signed,
      });
      const answerSent = sentText(model, seen);

      for (const sent of [summarySent, answerSent]) {
        const passages = shownPassages(sent).filter((passage) => passage.document === "Contract");
        expect(passages.length).toBeGreaterThan(0);
        for (const passage of passages) {
          expect(passage.date).toBe(`file-created="${FILE_CREATED}"`);
        }
        expect(sent).toContain(fileDatesNote(sent));
        expect(fileDatesNote(sent)).toContain("never give it as the Document's date");
        expect(sent.replaceAll(`file-created="${FILE_CREATED}"`, "")).not.toContain(FILE_CREATED);
      }
      for (const shown of [summary, answer]) {
        expect(shown.status).toBe("done");
        expect(shown.text).not.toContain("2026");
        expect(shown.text).not.toMatch(SIGNED_OR_MADE);
      }
      expect(answer.text).toBe(withMarker(walk.blank.text, 1));
    });

    // protects=every sentence of a summary outside its headings reaches the User with a Citation whose quote was found; fails_when=a sentence's Citation is dropped or its quote isn't found; no_claim=that a real model cites every sentence, which the everyday-requests eval measures.
    test("every sentence of its summary outside a heading carries a Citation", async () => {
      const { walk, core } = await setUp(language);

      const summary = await askAssistant(core, { text: walk.summarise });

      expect(summary.text.split("\n")[0]).toBe(walk.heading);
      const sentences = sentencesOf(summary);
      expect(sentences.map((sentence) => sentence.text.replace(/\[\^\d+\]/g, ""))).toEqual(
        walk.sentences.map((sentence) => sentence.text),
      );
      const cited = new Map(summary.citations.map((citation) => [citation.marker, citation]));
      for (const sentence of sentences) {
        expect(sentence.markers.length, sentence.text).toBeGreaterThan(0);
        for (const marker of sentence.markers) {
          expect(cited.get(marker)?.check, sentence.text).toBe("found");
        }
      }
    });
  });
}

describe("Passages dated by their file", () => {
  const handed = (...documents: readonly [string, string][]) =>
    documents
      .map(
        ([document, date], index) =>
          `<passage id="P${index + 1}" document="${document}" ${date} pages="1">\nOutages must be reported.\n</passage>`,
      )
      .join("\n\n");

  test("are followed by the note that a file's date is no date of the Document", () => {
    for (const date of ['file-created="2026-03-18"', 'file-modified="2024-03-01"']) {
      expect(fileDatesNote(handed(["Contract", date]))).toBe(
        'A Passage\'s file-created or file-modified date is when its file was made or last changed, not a date the Document states: never give it as the Document\'s date, such as when it was signed, issued or takes effect. Mention it only as the file\'s, with no marker: "file created on …" / "文件创建于 …".',
      );
    }
    expect(fileDatesNote(handed(["Memo", 'date="2025-05-14"']))).toBe("");
    expect(fileDatesNote('<passage id="P1" document="Memo">\nText\n</passage>')).toBe("");
  });

  test("are named as the file's when Documents of different dates are compared", () => {
    expect(
      datedDocumentsNote(
        handed(
          ["Contract", 'file-created="2026-03-18"'],
          ["Memo", 'date="2025"'],
          ["Handbook", 'file-modified="2024-03-01"'],
        ),
      ),
    ).toMatch(
      /^These Passages come from Documents of different dates: "Contract" \(file created 2026-03-18\), "Memo" \(2025\), "Handbook" \(file modified 2024-03-01\)\./,
    );
  });
});
