import { expect, test } from "vitest";
import { translate } from "../../src/shared/i18n";
import { isNamedSpeaker, speakerName } from "../../src/shared/speakers";
import { setUpWithDocuments, shownPassages } from "../helpers/citations";
import { createTempDataFolder, manualClock } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { type ModelCall, scriptedModel } from "../helpers/models";

type Kind =
  | "correct"
  | "wrong"
  | "anonymous"
  | "mixed"
  | "mixed-same-time"
  | "same-voice"
  | "overlapping-cue"
  | "reported"
  | "truthful-anonymous"
  | "document-correct"
  | "document-wrong"
  | "document-anonymous";

const CASES = (["en", "zh-CN"] as const).flatMap((language) =>
  (
    [
      "correct",
      "wrong",
      "anonymous",
      "mixed",
      "mixed-same-time",
      "same-voice",
      "overlapping-cue",
      "reported",
      "truthful-anonymous",
      "document-correct",
      "document-wrong",
      "document-anonymous",
    ] as const
  ).map((kind) => ({ language, kind })),
);

function scenario(language: "en" | "zh-CN", kind: Kind) {
  const en = language === "en";
  const nora = en ? "Nora" : "诺拉";
  const li = en ? "Li" : "李四";
  const zhang = en ? "Zhang" : "张三";
  const document = kind.startsWith("document-");
  const combined = kind === "mixed" || kind === "mixed-same-time" || kind === "same-voice";
  const claimed =
    kind === "reported"
      ? li
      : kind === "truthful-anonymous"
        ? "Speaker 1"
        : document || kind === "wrong" || kind === "anonymous"
          ? zhang
          : nora;
  const voice =
    kind === "wrong"
      ? li
      : kind === "anonymous" || kind === "truthful-anonymous"
        ? "Speaker 1"
        : nora;
  const actual =
    kind === "document-wrong"
      ? li
      : kind === "document-anonymous"
        ? en
          ? "Speaker 1"
          : "发言者1"
        : document
          ? zhang
          : kind === "reported"
            ? li
            : voice;
  const qualifier = en ? `${claimed} said` : `${claimed}说`;
  const fact = document
    ? en
      ? "the deal is off."
      : "交易取消了。"
    : combined
      ? en
        ? "the first rate is 5% and the second rate is 3%."
        : "第一项利率为5%，第二项利率为3%。"
      : en
        ? "the rate is 5%."
        : "利率为5%。";
  const claim = en ? `${qualifier} ${fact}` : `${qualifier}${fact}`;
  const first = document
    ? en
      ? `${actual} said, ‘The deal is off.’`
      : `${actual}说：“交易取消了。”`
    : kind === "reported"
      ? claim
      : combined
        ? en
          ? "The first rate is 5%."
          : "第一项利率为5%。"
        : en
          ? "The rate is 5%."
          : "利率为5%。";
  const second = en ? "The second rate is 3%." : "第二项利率为3%。";
  const quote = combined ? `${first}\n${second}` : first;
  const interval =
    kind === "mixed-same-time"
      ? "00:00:00.000 --> 00:00:01.000"
      : kind === "overlapping-cue"
        ? "00:00:00.500 --> 00:00:01.500"
        : "00:00:02.000 --> 00:00:03.000";
  const vtt =
    `WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n<v ${voice}>${first}\n` +
    (combined || kind === "overlapping-cue"
      ? `\n${interval}\n<v ${kind === "same-voice" ? nora : li}>${second}\n`
      : "");
  return { claimed, actual, document, voice, qualifier, fact, claim, quote, vtt };
}

async function checkSpeaker(
  language: "en" | "zh-CN",
  kind: Kind,
  metadata: Record<string, unknown> = {},
) {
  const row = scenario(language, kind);
  const frames: ModelCall[] = [];
  const wire = [
    { kind: "fact", text: row.qualifier, facet: { kind: "speaker" } },
    { kind: "fact", text: row.fact },
  ];
  const model = scriptedModel((call) => {
    frames.push(call);
    const searched = call.results.find(({ tool }) => tool === "search_documents");
    if (!searched)
      return {
        text: `Parts: ${JSON.stringify(wire)}`,
        calls: [
          {
            tool: "search_documents",
            input: {
              query: row.document
                ? language === "en"
                  ? "deal"
                  : "交易"
                : language === "en"
                  ? "rate"
                  : "利率",
            },
          },
        ],
      };
    if (!call.results.some(({ tool }) => tool === "cite")) {
      const passage = shownPassages(searched.text).find((passage) =>
        row.quote.split("\n").every((line) => passage.text.includes(line)),
      );
      if (!passage) throw new Error("The speaker check did not receive its real VTT quote.");
      return {
        calls: [
          {
            tool: "cite",
            input: { citations: [{ marker: 1, passage: passage.id, quote: row.quote }] },
          },
        ],
      };
    }
    return {
      text: [
        "Verdict: supported",
        "Scope: none, same",
        "Topic: found",
        "Roles: none, same",
        "Calculation: none",
        "Evidence: [1]",
        `${row.quote} [^1]`,
        `Facets: ${JSON.stringify({
          items: [
            {
              text: row.qualifier,
              occurrence: 1,
              kind: "speaker",
              verdict: "supported",
              scope: "same",
              topic: "found",
              roles: "same",
              says: row.quote,
              evidence: [1],
              claimedSpeaker: row.claimed,
              actualSpeaker: row.document ? row.actual : row.claimed,
              actualSpeakerNamed: kind !== "document-anonymous",
              speakerOrigin: row.document || kind === "reported" ? "quote" : "cue",
              ...metadata,
            },
          ],
        })}`,
      ].join("\n"),
    };
  });
  const { core } = await setUpWithDocuments(model, [], {
    now: manualClock("2026-10-30T12:00:00.000Z").now,
  });
  const { settings } = await core.getLibrary();
  await core.saveLibrarySettings({ ...settings, automatic: false });
  const folder = await createTempDataFolder();
  const path = await writeSourceFile(
    folder,
    row.document
      ? language === "en"
        ? "Deal meeting record.md"
        : "交易会议记录.md"
      : language === "en"
        ? "Rate meeting.vtt"
        : "利率会议.vtt",
    row.document
      ? `# ${language === "en" ? "Deal meeting record" : "交易会议记录"}\n\n${row.quote}`
      : row.vtt,
  );
  const [document] = await addAndProcess(core, [path]);
  if (!document) throw new Error("The actual VTT Source was not imported.");
  expect(document.tagging).toBe("off");
  await core.updateSettings({ user: { language } });
  const before = model.doStreamCalls.length + model.doGenerateCalls.length;
  const frameStart = frames.length;

  const result = await core.checkClaim({ claim: row.claim });

  expect(model.doStreamCalls.length + model.doGenerateCalls.length - before).toBe(3);
  const calls = frames.slice(frameStart);
  expect(calls.map((call) => call.results.map(({ tool }) => tool))).toEqual([
    [],
    ["search_documents"],
    ["search_documents", "cite"],
  ]);
  for (const call of calls) expect(call.prompt).toContain(row.claim);
  expect(calls.at(-1)?.results.find(({ tool }) => tool === "cite")?.text).toContain(
    "Recorded [^1]",
  );
  const speaker = result.parts?.find((part) => part.facet?.kind === "speaker");
  expect(result.parts?.find((part) => !part.facet)).toMatchObject({
    verdict: "supported",
    evidence: [{ documentId: document.id, quote: row.quote, check: "found" }],
  });
  return { result, speaker, row, document };
}

test.each(CASES)(
  "checked attribution respects $kind speech ($language)",
  async ({ language, kind }) => {
    const { result, speaker, row, document } = await checkSpeaker(language, kind);
    expect(speaker).toMatchObject({
      kind: "fact",
      span: { start: 0, end: row.qualifier.length },
      facet: { kind: "speaker" },
      evidence: [
        {
          documentId: document.id,
          quote: row.quote,
          check: "found",
          ...(!row.document && {
            location: {
              kind: "time",
              from: 0,
              to: kind === "mixed" || kind === "same-voice" ? 3000 : 1000,
              speaker: row.voice,
            },
          }),
        },
      ],
    });
    if (kind === "mixed" || kind === "mixed-same-time") {
      expect(result.verdict).not.toBe("supported");
      expect(speaker?.verdict).not.toBe("supported");
    } else if (
      kind === "wrong" ||
      kind === "anonymous" ||
      kind === "document-wrong" ||
      kind === "document-anonymous"
    ) {
      expect(result.verdict).toBe("unsupported");
      expect(speaker?.verdict).toBe("unsupported");
      if (kind === "anonymous" || kind === "document-anonymous") {
        const t = (
          key: Parameters<typeof translate>[1],
          params?: Parameters<typeof translate>[2],
        ) => translate(language, key, params);
        expect(speaker?.unsupported?.reason).toBe(
          translate(language, "claim.speaker.unknown", {
            document: document.name,
            speaker: speakerName(row.actual, t),
          }),
        );
      } else expect(speaker?.unsupported?.reason ?? speaker?.says).toContain(row.actual);
    } else {
      expect(result.verdict).toBe("supported");
      expect(speaker?.verdict).toBe("supported");
      if (kind === "reported") expect(row.voice).not.toBe(row.claimed);
    }
  },
);

test.each(
  (["en", "zh-CN"] as const).flatMap((language) => [
    { language, field: "claimedSpeaker", value: "Elsewhere" },
    { language, field: "actualSpeaker", value: 42 },
    { language, field: "actualSpeaker", value: undefined },
    { language, field: "actualSpeakerNamed", value: "yes" },
    { language, field: "speakerOrigin", value: "first" },
  ]),
)(
  "malformed $field cannot be rescued by cue metadata ($language)",
  async ({ language, field, value }) => {
    const { result, speaker } = await checkSpeaker(language, "correct", { [field]: value });
    expect(result).toMatchObject({ verdict: "not-checked" });
    expect(speaker).toMatchObject({ verdict: "not-checked" });
  },
);

test.each(["Me", "Them", "Speaker ?", "Speaker 1", "Them 2"])(
  "the existing voice label %s is not a named person",
  (label) => {
    expect(isNamedSpeaker(label)).toBe(false);
  },
);

test.each(["Nora", "Li", "张三", "李四"])("the named label %s remains named", (label) => {
  expect(isNamedSpeaker(label)).toBe(true);
});

test.each(["en", "zh-CN"] as const)(
  "quote origin cannot borrow an absent actual name (%s)",
  async (language) => {
    const { result, speaker } = await checkSpeaker(language, "reported", {
      actualSpeaker: "Elsewhere",
    });
    expect(result.verdict).toBe("not-checked");
    expect(speaker?.verdict).toBe("not-checked");
  },
);
