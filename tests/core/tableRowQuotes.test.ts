/**
 * A check whose model gives its verdict without a record is asked for that record, and quotes a
 * table's row as its Passage gives it, raw tabs and all (#3125). JSON refuses a raw control
 * character inside a string, so the reply read as unreadable and the sentence ended Not checked,
 * quote not found, though the row was the Passage's word for word.
 */
import { describe, expect, test } from "vitest";
import { checkGenerate, checkReply, type Plan } from "../helpers/checks";
import { setUpWithDocuments } from "../helpers/citations";
import { type GenerateCall, scriptedModel } from "../helpers/models";

const LANGUAGES = [
  {
    language: "English",
    table: {
      name: "Site staff.csv",
      contents: "Name,Role,Office\nPriya Shah,Site manager,Leeds\nTom Reed,Surveyor,York\n",
    },
    row: "Priya Shah\tSite manager\tLeeds",
    notOnThePage: "Priya Shah\tSite manager\tYork",
    contradicted: "Priya Shah is the site manager in York.",
    supported: "Priya Shah is the site manager in Leeds.",
  },
  {
    language: "Chinese",
    table: {
      name: "项目人员.csv",
      contents: "姓名,职务,办公地点\n王丽,项目经理,杭州\n陈刚,测量师,宁波\n",
    },
    row: "王丽\t项目经理\t杭州",
    notOnThePage: "王丽\t项目经理\t宁波",
    contradicted: "王丽是宁波的项目经理。",
    supported: "王丽是杭州的项目经理。",
  },
] as const;

/** The record as a model writes it when asked: `quote` copied into the JSON string as it is. */
const recordOf = (quote: string) => (call: GenerateCall) => {
  const passage = /<passage id="([^"]+)"/.exec(call.prompt)?.[1];
  return `{"passage":"${passage}","location":"rows 1–3","quote":"${quote}"}`;
};

/**
 * A model that checks `claim` as `verdict` without recording a Passage, gives `evidence` when asked
 * for the record, and confirms what it quotes: the same for a Supported, a conflict otherwise.
 */
function checking(
  claim: string,
  verdict: "supported" | "contradicted",
  evidence: (call: GenerateCall) => string,
) {
  const plans: Record<string, Plan> = {
    [claim]: { verdict, judgement: verdict === "supported" ? "same" : "conflict" },
  };
  const judged = checkGenerate(plans);
  return scriptedModel((call) => checkReply(call, plans), {
    generate: (call) => (call.question === "evidence" ? { text: evidence(call) } : judged(call)),
  });
}

describe.each(LANGUAGES)("A record asked for again quotes a table row ($language)", (example) => {
  // protects=a verdict given without a record reads as that verdict when the record it gives when asked quotes the table's row with its raw tabs (#3125); fails_when=the reply's raw tabs make it unreadable and the sentence ends Not checked, quote not found; no_claim=how often a real model copies a row's tabs.
  test.each([
    ["contradicted", "contradicted"],
    ["supported", "supported"],
  ] as const)("its raw tabs are read as tabs: the %s verdict stands", async (_, verdict) => {
    const claim = example[verdict];
    const { core } = await setUpWithDocuments(checking(claim, verdict, recordOf(example.row)), [
      example.table,
    ]);

    expect(await core.checkClaim({ claim })).toMatchObject({
      verdict,
      evidence: { quote: example.row, check: "found" },
    });
  });

  // protects=a record read with its raw tabs still counts only when the Citation check finds its quote on the page, and a reply cut off is still never repaired (#2275), so the fix reads only what the model wrote whole; fails_when=a row the table doesn't hold, or a reply cut short, backs the verdict; no_claim=none beyond protects.
  test.each([
    ["a row the table doesn't hold", () => recordOf(example.notOnThePage)],
    [
      "a reply cut off inside the quote",
      () => (call: GenerateCall) => recordOf(example.row)(call).slice(0, -6),
    ],
  ])("%s, raw tabs and all, leaves it Not checked", async (_, evidence) => {
    const claim = example.contradicted;
    const { core } = await setUpWithDocuments(checking(claim, "contradicted", evidence()), [
      example.table,
    ]);

    expect(await core.checkClaim({ claim })).toMatchObject({
      verdict: "not-checked",
      reason: "no-evidence",
    });
  });
});
