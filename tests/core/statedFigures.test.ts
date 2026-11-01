/**
 * A figure its quote states is no calculation (#2311): a sheet row's cell takes its unit from its
 * column's heading, and a number the Document writes in words is the same number. A check whose
 * model says Supported, citing such a quote, is supported, never Not checked for a calculation
 * nobody needs. A figure the quote doesn't hold still needs one.
 */
import { describe, expect, test } from "vitest";
import type { Core } from "../../src/core";
import { checkGenerate, type Plan, sentenceOf } from "../helpers/checks";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { type ModelCall, type ScriptedReply, scriptedModel } from "../helpers/models";

const STATIONS = {
  name: "Bike Share Stations September 2026.csv",
  contents: [
    "Station ID,Station,Area,Docks,Trips",
    "BS-1015,Harbour Gate,Docklands,20,3120",
    "BS-1016,Clock Tower,Central,12,4005",
    "BS-1017,Mill Road,North,15,2210",
    "",
  ].join("\n"),
};
const SORTING = {
  name: "小区垃圾分类统计2026年9月.csv",
  contents: [
    "小区,街道,户数,分类准确率,厨余垃圾(吨)",
    "金桂家园,南岸街道,1062,92%,17.5",
    "兰亭雅居,南岸街道,1230,85%,18.0",
    "",
  ].join("\n"),
};
const MEETING = {
  name: "Riverside Library Steering Meeting.md",
  contents: [
    "# Steering meeting",
    "",
    "We approved forty-two thousand pounds for furniture in January.",
    "",
    "The committee approved twelve new posts.",
    "",
  ].join("\n"),
};
const COMMITTEE = {
  name: "委员会会议纪要.md",
  contents: ["# 委员会会议纪要", "", "委员会批准了十二个新岗位。", ""].join("\n"),
};

/** Where a quote of a sheet is: its row, as the Passage numbers them. */
const ROWS: Record<string, string> = {
  "BS-1016 Clock Tower Central 12 4005": "row 3",
  "金桂家园 南岸街道 1062 92%": "row 2",
  "兰亭雅居 南岸街道 1230 85% 18.0": "row 3",
};

/** Each sentence's quote, as Find support's labels give it. */
const QUOTES: Record<string, string> = {
  "Clock Tower station, in Central, logged 4,005 trips in September.":
    "BS-1016 Clock Tower Central 12 4005",
  "Clock Tower station has 12 docks.": "BS-1016 Clock Tower Central 12 4005",
  "Clock Tower station logged 4,500 trips in September.": "BS-1016 Clock Tower Central 12 4005",
  "金桂家园有1062户，9月分类准确率为92%。": "金桂家园 南岸街道 1062 92%",
  "兰亭雅居9月厨余垃圾为18.0吨。": "兰亭雅居 南岸街道 1230 85% 18.0",
  "兰亭雅居9月厨余垃圾为19.0吨。": "兰亭雅居 南岸街道 1230 85% 18.0",
  "The steering group approved £42,000 for furniture in January.":
    "We approved forty-two thousand pounds for furniture in January.",
  "The committee approved 12 new posts.": "The committee approved twelve new posts.",
  "委员会批准了12个新岗位。": "委员会批准了十二个新岗位。",
};

/** A check that searches, cites its sentence's quote, and says Supported without calculating. */
function supporting(call: ModelCall): ScriptedReply {
  const sentence = sentenceOf(call);
  const quote = QUOTES[sentence] ?? sentence;
  const searches = call.results.filter((result) => result.tool === "search_documents");
  if (searches.length === 0) {
    const search = { tool: "search_documents", input: { query: quote } };
    if (call.system.includes("Parts:")) {
      const parts = [{ kind: "fact", text: sentence.replace(/[.。]$/u, "") }];
      return { text: `Parts: ${JSON.stringify(parts)}`, calls: [search] };
    }
    return { calls: [search] };
  }
  if (!call.results.some((result) => result.tool === "cite")) {
    const shown = shownPassages(searches.at(-1)?.text ?? "");
    const words = quote.split(/\s+/u);
    const passage = shown.find((each) => words.every((word) => each.text.includes(word)));
    return {
      calls: [
        {
          tool: "cite",
          input: { citations: [{ marker: 1, passage: passage?.id, location: ROWS[quote], quote }] },
        },
      ],
    };
  }
  return { text: "Verdict: supported\nAbsence: no\nThe Document says so [^1].\nEvidence: [1]" };
}

/** A core on a model billed on a service, as a check offered calculate runs, with the four Documents. */
async function coreWithDocuments(): Promise<Core> {
  // Asked which of a row's numbers its figure is, it can't tell them apart, as Haiku couldn't for
  // "4,005 trips": the column's heading has to say it.
  const unsure = Object.fromEntries(
    Object.keys(QUOTES).map((each): [string, Plan] => [each, { judgement: "conflict" }]),
  );
  const model = scriptedModel(supporting, { generate: checkGenerate(unsure) });
  const core = startCore(await createTempDataFolder(), { createChatModel: () => model });
  core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
  const saved = await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "sk-ant-test",
    modelId: "claude-haiku-5-5",
  });
  for (const flow of ["chat", "checks"] as const) {
    if (saved.service) await core.allowDataFlow(flow, saved.service.id);
  }
  const sources = await createTempDataFolder();
  await addAndProcess(
    core,
    await Promise.all(
      [STATIONS, SORTING, MEETING, COMMITTEE].map((each) =>
        writeSourceFile(sources, each.name, each.contents),
      ),
    ),
  );
  return core;
}

describe("a figure its quote states needs no calculation", { timeout: 60_000 }, () => {
  test.each([
    {
      case: "a sheet row's count, its unit in the column heading",
      sentence: "Clock Tower station, in Central, logged 4,005 trips in September.",
    },
    {
      case: "a sheet row's cell the sentence states as written",
      sentence: "Clock Tower station has 12 docks.",
    },
    {
      case: "a Chinese sheet row's count and share",
      sentence: "金桂家园有1062户，9月分类准确率为92%。",
    },
    {
      case: "a Chinese sheet row's measure, its unit in the column heading",
      sentence: "兰亭雅居9月厨余垃圾为18.0吨。",
    },
    {
      case: "an amount the Document writes in words",
      sentence: "The steering group approved £42,000 for furniture in January.",
    },
    {
      case: "a count the Document writes in words",
      sentence: "The committee approved 12 new posts.",
    },
    {
      case: "a count the Document writes in Chinese numerals",
      sentence: "委员会批准了12个新岗位。",
    },
  ])("$case is supported", async ({ sentence }) => {
    const core = await coreWithDocuments();

    expect(await core.checkClaim({ claim: sentence })).toMatchObject({ verdict: "supported" });
  });

  test.each([
    {
      case: "a count the row doesn't hold",
      sentence: "Clock Tower station logged 4,500 trips in September.",
    },
    { case: "a Chinese measure the row doesn't hold", sentence: "兰亭雅居9月厨余垃圾为19.0吨。" },
  ])("$case still needs a calculation, so it isn't supported", async ({ sentence }) => {
    const core = await coreWithDocuments();

    expect(await core.checkClaim({ claim: sentence })).not.toMatchObject({ verdict: "supported" });
  });
});
