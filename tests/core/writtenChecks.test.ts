import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import type { Core } from "../../src/core";
import { OLLAMA_CLOUD } from "../../src/core/providers/ollamaCloud";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { claimCheckShown, SENTENCES_CHECKED_AT_MOST } from "../../src/shared/claimChecks";
import { INLINE_NODE } from "../../src/shared/sentences";
import { askAssistant, changesIn, lastResult } from "../helpers/assistant";
import { checkReply, isCheckRun, type Plan, sentenceOf, unsupportedReply } from "../helpers/checks";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind, type MindClient, typeInto } from "../helpers/mindClient";
import { readMind, resolveChanges, shownWithChanges, writeMind } from "../helpers/minds";
import {
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";

/**
 * What the assistant writes into a Mind is checked against its own Citations
 * before it lands (#1111): a part they don't support is cut, keeping the
 * Citations and each word's formatting, and the sentence shows it needs a
 * check again; a sentence still unsupported, or one that couldn't be checked,
 * lands marked; at most `SENTENCES_CHECKED_AT_MOST` are checked a write; and
 * words the User types meanwhile stay. The model's verdicts and cuts are
 * scripted; Claude Haiku's were tried by hand.
 */

const MOON = "Spring tides come at new and full moon.";
const OVERSTATED = "Spring tides come at new and full moon, and they flood the harbour every year";
const UNBACKED = "Neap tides are twice as strong";
const FAILING = "The harbour floods at every spring tide";
const YEARLY = "Every year the harbour floods, and spring tides come at new and full moon";
const OVERSTATED_ZH = "大潮出现在新月和满月时，并且每年都会淹没港口";
const TWO_CITED =
  "Spring tides come at new and full moon [^1], and they flood the harbour every year [^1].";
const TWO_CITED_ZH = "公司营收增长了5%[^1]，所有地区成本都大幅下降[^1]。";
const NOT_RISE = "Revenue did not rise in 2023 [^1].";
const NOT_RISE_ZH = "公司营收没有在所有地区增长[^1]。";
const STOP_BEFORE =
  "Spring tides come at new and full moon, and they flood the harbour every year.[^1]";
const COMMA_TAIL = "The harbour floods in spring[^1], in every region.";
const COMMA_TAIL_ZH = "大潮出现在新月和满月时[^1]，每年如此。";

/** A sentence as a check reads it: the Citation after its words as U+FFFC. */
const asChecked = (words: string) => `${words} ${INLINE_NODE}.`;
const asCheckedZh = (words: string) => `${words}${INLINE_NODE}。`;

/** A check's reply for a sentence a Passage states in part, naming what it covers and what it doesn't. */
const partly = (covered: string, uncovered: string) => ({
  reply: {
    text: `Verdict: unsupported\nNo Passage says all of it.\nCovered: ${covered}\nNot covered: ${uncovered}`,
  },
});

/** A check's reply for a cut its Citations support once the unsupported part is out. */
const supported: Plan = { verdict: "supported", quote: MOON, says: MOON };

const PLANS: Record<string, Plan> = {
  [asChecked(OVERSTATED)]: {
    reply: {
      text: "Verdict: unsupported\nNo Passage says the harbour floods every year.\nCovered: when spring tides come\nNot covered: the yearly floods",
    },
  },
  [asChecked(UNBACKED)]: {
    reply: { text: "Verdict: unsupported\nNo Passage compares the strength of the tides." },
  },
  [asChecked(FAILING)]: { reply: { error: { status: 500, message: "The service broke." } } },
  [asChecked(YEARLY)]: {
    reply: {
      text: "Verdict: unsupported\nNo Passage says the harbour floods every year.\nCovered: when spring tides come\nNot covered: the yearly floods",
    },
  },
  [TWO_CITED.replaceAll(" [^1]", ` ${INLINE_NODE}`)]: {
    reply: {
      text: "Verdict: unsupported\nNo Passage says the harbour floods every year.\nCovered: when spring tides come\nNot covered: the yearly floods",
    },
  },
  [asCheckedZh(OVERSTATED_ZH)]: {
    reply: {
      text: "Verdict: unsupported\n没有段落说港口每年被淹没。\nCovered: 大潮出现的时间\nNot covered: 每年淹没港口",
    },
  },
  // Its 5% is a figure, which the check asks about one by one.
  [TWO_CITED_ZH.replaceAll("[^1]", INLINE_NODE)]: {
    reply: (call) => ({
      text: unsupportedReply(
        call,
        "没有段落说两个数字都成立。\nCovered: 增长与成本\nNot covered: 两个数字",
      ),
    }),
  },
  [asChecked("Revenue did not rise in 2023")]: partly("the revenue", "not"),
  [asCheckedZh("公司营收没有在所有地区增长")]: partly("营收增长", "没有"),
  [`Spring tides come at new and full moon, and they flood the harbour every year.${INLINE_NODE}`]:
    partly("when spring tides come", "the yearly floods"),
  [`The harbour floods in spring${INLINE_NODE}, in every region.`]: partly(
    "the flood in spring",
    "every region",
  ),
  [`大潮出现在新月和满月时${INLINE_NODE}，每年如此。`]: partly("春季大潮", "每年如此"),
  // The cut sentences a re-check reads: the ones above the Citations now support, and the two whose cut changed what the sentence said.
  [asChecked("Spring tides come at new and full moon")]: supported,
  [asChecked("And spring tides come at new and full moon")]: supported,
  [`Spring tides come at new and full moon.${INLINE_NODE}`]: supported,
  [`The harbour floods in spring${INLINE_NODE}.`]: supported,
  [`大潮出现在新月和满月时${INLINE_NODE}。`]: supported,
  [`港口在春季会淹水${INLINE_NODE}。`]: supported,
  [`Revenue did rise in 2023 ${INLINE_NODE}.`]: { reply: { text: "Verdict: unsupported" } },
  [`公司营收在所有地区增长${INLINE_NODE}。`]: { reply: { text: "Verdict: unsupported" } },
};

const CUT = /<task action="cut-unsupported">/;

interface Writing {
  content: string;
  /** Into the Mind in focus, after its text, rather than a new one. */
  into?: boolean;
  /** Runs while the first check waits for its reply. */
  during?: () => Promise<void>;
  /** A check's reply in place of `PLANS`', given the core; null: `PLANS`'. */
  check?: (call: ModelCall, core: Core) => ScriptedReply | null;
  /** A model on a service, not on this computer. */
  cloud?: { kind: "anthropic"; modelId: string } | { kind: "ollama"; modelId: string };
  /** How the Answer ends: a spending cap reached during the check stops it too. */
  ends?: "finished" | "failed";
  /** The model's cut of a sentence, in place of its first clause and its marker. */
  cut?: string;
}

/**
 * A model that searches, cites the moon line, writes `content`, and replies;
 * checks a sentence as `PLANS` says; and, asked to cut a sentence, keeps its
 * first clause and its marker.
 */
function writingModel(
  {
    content,
    into = false,
    during,
    check,
    cut = "Spring tides come at new and full moon [1].",
  }: Writing,
  calls: ModelCall[],
  coreOf: () => Core | null,
) {
  let waited: Promise<void> | null = null;
  const tool = into ? "add_to_mind" : "create_mind";
  return scriptedModel((call): ScriptedReply => {
    calls.push(call);
    if (isCheckRun(call)) {
      const core = coreOf();
      const reply = (check && core && check(call, core)) || checkReply(call, PLANS);
      if (!during || waited || "error" in reply) return reply;
      waited = during();
      return { ...reply, pause: { after: 0, until: waited } };
    }
    if (CUT.test(call.prompt)) {
      return { text: `${cut}\n<why>Only what the source says.</why>` };
    }
    const { results } = call;
    const search = results.find((result) => result.tool === "search_documents");
    if (!search) return { calls: [{ tool: "search_documents", input: { query: "spring tides" } }] };
    if (!results.some((result) => result.tool === "cite")) {
      const [passage] = shownPassages(search.text);
      const record = { marker: 1, passage: passage?.id, quote: MOON };
      return { calls: [{ tool: "cite", input: { citations: [record] } }] };
    }
    const writes = results.filter((result) => result.tool === tool);
    // Told its text has no Citation (#1415), it writes it again as it was: it says nothing the Documents say.
    const refused = writes.length === 1 && writes[0]?.text.includes("content has no Citation");
    if (writes.length === 0 || refused) {
      const input = into ? { content } : { title: "Tide notes", content };
      return { calls: [{ tool, input }] };
    }
    return { text: "Wrote it from your Documents." };
  });
}

/** The scripted model finds the English line a Chinese cut cites, as a real model does: it searches in English, then quotes it. */
const englishEvidence =
  (claim: string) =>
  (call: ModelCall): ScriptedReply | null => {
    if (sentenceOf(call) !== claim) return null;
    const searches = call.results.filter((result) => result.tool === "search_documents");
    if (searches.length === 0)
      return { calls: [{ tool: "search_documents", input: { query: "spring tides" } }] };
    if (!call.results.some((result) => result.tool === "cite")) {
      const [shown] = shownPassages(searches.at(-1)?.text ?? "");
      return {
        calls: [
          { tool: "cite", input: { citations: [{ marker: 1, passage: shown?.id, quote: MOON }] } },
        ],
      };
    }
    return { text: `Verdict: supported\nThe Document says: ${MOON} [^1]` };
  };

/** A core with the tides line in a Folder, and a Mind there with a heading and a line. */
async function harbour(model: ReturnType<typeof writingModel>, cloud: Writing["cloud"]) {
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  let service: string | undefined;
  if (cloud) {
    core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
    const saved = await core.saveChatProvider(
      cloud.kind === "anthropic" ? { ...cloud, apiKey: "sk-ant-test" } : cloud,
    );
    // A cloud model in Ollama sends to ollama.com, not to the Ollama on this computer.
    service = cloud.kind === "ollama" ? OLLAMA_CLOUD.id : saved.service?.id;
    for (const flow of ["chat", "checks"] as const) {
      if (service) await core.allowDataFlow(flow, service);
    }
  } else await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const sources = await createTempDataFolder();
  const documents = await addAndProcess(core, [
    await writeSourceFile(sources, "Tides.md", `# Tides\n\n${MOON}\n`),
  ]);
  const folder = await core.createLibraryGroup({ name: "Coast", description: "" });
  await core.moveToFolder({ documentIds: documents.map((each) => each.id), folderId: folder.id });
  const mind = await core.createMind({ title: "Harbour notes", folderId: folder.id });
  const client = await connectToMind(core, mind.id);
  writeMind(client, [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Harbour" }] },
    { type: "paragraph", content: [{ type: "text", text: "Boats moor by the quay." }] },
  ]);
  await client.settled();
  return { core, folderId: folder.id, mindId: mind.id, client, service };
}

async function write(
  writing: Writing,
  onStart?: (started: {
    core: Core;
    client: MindClient;
    service: string | undefined;
    calls: readonly ModelCall[];
  }) => void,
) {
  const calls: ModelCall[] = [];
  let started: Core | null = null;
  const model = writingModel(writing, calls, () => started);
  const { core, folderId, mindId, client, service } = await harbour(model, writing.cloud);
  started = core;
  onStart?.({ core, client, service, calls });
  const answer = await askAssistant(
    core,
    {
      text: writing.into
        ? "Add a short note on tides to this Mind"
        : "Summarise these Documents into a new note",
      ...(writing.into && { mindId }),
      scope: { folderIds: [folderId], tagIds: [], documentIds: [] },
    },
    writing.ends,
  );
  const [change] = changesIn(answer);
  const page = writing.into ? client : await connectToMind(core, change?.mindId ?? "");
  await page.settled();
  return { core, model, calls, answer, change, client: page };
}

/** A paragraph of the Mind as checks read it: each Citation as U+FFFC. */
function paragraphText(client: MindClient, index: number): string {
  let text = "";
  readMind(client)
    .child(index)
    .forEach((node) => {
      text += node.isText ? (node.text ?? "") : INLINE_NODE;
    });
  return text;
}

/** Each check's mark in the Mind and how it shows, by its sentence. */
async function marksIn(core: Core, client: MindClient) {
  await client.settled();
  const versions = new Map((await core.listDocuments()).map((each) => [each.id, each.contentHash]));
  return claimSpans(readMind(client)).map((span) => ({
    sentence: span.sentence.text.replaceAll(INLINE_NODE, "").trim(),
    check: span.check,
    shown: claimCheckShown(span.check, {
      text: span.sentence.text,
      versions,
      folderId: span.check.scope.folderId,
      scope: null,
    }),
  }));
}

describe("What the assistant writes is checked before it lands", { timeout: 30_000 }, () => {
  // protects=a written sentence that overstates its Citations lands with that part cut, its Citation kept, and marked to be checked again (#1111's acceptance); fails_when=the overstated words land, the Citation goes, it lands unmarked or unsupported, or the model isn't told; no_claim=how well a real model cuts.
  test("a part its Citations don't support is cut before it lands, the Citation kept, and it shows it needs a check again", async () => {
    const { core, model, calls, change, client } = await write({
      content: `## Tides\n\n${OVERSTATED} [^1].`,
    });

    expect(shownWithChanges(client)).toEqual([
      "+ Tides",
      "+ Spring tides come at new and full moon ⟨found⟩.",
    ]);
    const marks = await marksIn(core, client);
    expect(marks.map(({ shown }) => shown)).toEqual([{ state: "needs-recheck", why: "edited" }]);
    expect(change).toMatchObject({ created: true, proposals: 2 });
    expect(change).not.toHaveProperty("checking");
    expect(change?.selfCheck).toMatchObject({ cited: 1, sent: 1, failed: 0 });
    // A check of the sentence and a check of the cut, and one edit for the cut, told what the Citation quotes.
    expect(calls.filter((call) => isCheckRun(call) && call.results.length === 0)).toHaveLength(2);
    const cuts = calls.filter((call) => CUT.test(call.prompt));
    expect(cuts).toHaveLength(1);
    expect(cuts[0]?.prompt).toContain("the yearly floods");
    expect(cuts[0]?.prompt).toContain(`[1] “${MOON}”`);
    expect(lastResult(model)).toContain(
      "What their Citations don't support was taken out: “the yearly floods”.",
    );
  });

  // protects=a cut keeps each word's own formatting rather than giving all of it the first word's; fails_when=the plain words turn bold; no_claim=none beyond protects.
  test("a cut keeps each word's own formatting", async () => {
    const { client } = await write({
      content: `## Tides\n\n**Spring tides** come at new and full moon, and they flood the harbour every year [^1].`,
    });

    const paragraph = readMind(client).child(1);
    const runs: { text: string; bold: boolean }[] = [];
    paragraph.forEach((node) => {
      if (node.isText) {
        runs.push({
          text: node.text ?? "",
          bold: node.marks.some((mark) => mark.type.name === "bold"),
        });
      }
    });
    expect(runs.filter((run) => run.bold).map((run) => run.text.trim())).toEqual(["Spring tides"]);
    expect(runs.map((run) => run.text).join("")).toBe("Spring tides come at new and full moon .");
  });

  // protects=a cut that rewords the sentence, as Kimi K2.6's did ("across all tested crime categories" became "in all cases", #1397), moves its Citation or keeps one on words it didn't follow, or leaves no claim, isn't used: the sentence lands as the assistant wrote it, marked unsupported, in English and Chinese; fails_when=the cut's words land, or the model is told a part was taken out; no_claim=how often a real model rewords.
  test.each([
    {
      language: "en",
      content: `## Tides\n\n${OVERSTATED} [^1].`,
      cut: "Spring tides come at new and full moon in all cases [1].",
      written: asChecked(OVERSTATED),
    },
    {
      language: 'en, no claim left, as Claude Haiku 5.5\'s "Crime:"',
      content: `## Tides\n\n${OVERSTATED} [^1].`,
      cut: "Spring tides [1].",
      written: asChecked(OVERSTATED),
    },
    {
      language: "en, a Citation kept on words it didn't follow",
      content: `## Tides\n\n${TWO_CITED}`,
      cut: "Spring tides come at new and full moon [2].",
      written: TWO_CITED.replaceAll(" [^1]", ` ${INLINE_NODE}`),
    },
    {
      language: "en, its Citation moved",
      content: `## Tides\n\n${OVERSTATED} [^1].`,
      cut: "Spring tides [1] come at new and full moon.",
      written: asChecked(OVERSTATED),
    },
    {
      language: "zh-CN",
      content: `## 潮汐\n\n${OVERSTATED_ZH}[^1]。`,
      cut: "大潮在所有情况下都出现在新月和满月时[1]。",
      written: asCheckedZh(OVERSTATED_ZH),
    },
  ])(
    "a cut that does more than take a part out isn't used, and the sentence lands as written, marked ($language)",
    async ({ content, cut, written }) => {
      const { model, client } = await write({ content, cut });

      expect(paragraphText(client, 1)).toBe(written);
      const [mark] = claimSpans(readMind(client));
      expect(mark?.check).toMatchObject({ state: "unsupported", text: written });
      expect(lastResult(model)).toContain("1 sentence is still not supported by its Citations");
      expect(lastResult(model)).not.toContain("was taken out");
    },
  );

  // protects=only the part the cut takes out goes: every other word, mark, space and Citation lands byte for byte as the assistant wrote it, whatever spaces the model's reply has inside what it kept, and with its own full stop when the reply leaves it out, in English and Chinese (#1397); fails_when=any other byte of the sentence changes; no_claim=none beyond protects.
  test.each([
    {
      language: "en",
      content: `## Tides\n\n${OVERSTATED} [^1].`,
      cut: "Spring tides  come at new and full\nmoon [1].",
      written: asChecked(OVERSTATED),
      part: ", and they flood the harbour every year",
      check: undefined,
    },
    {
      language: "en, its full stop left out, with a sentence after it",
      content: `## Tides\n\n${OVERSTATED} [^1]. Neap tides come between.`,
      cut: "Spring tides come at new and full moon [1]",
      written: `${asChecked(OVERSTATED)} Neap tides come between.`,
      part: ", and they flood the harbour every year",
      check: undefined,
    },
    {
      language: "zh-CN",
      content: `## 潮汐\n\n${OVERSTATED_ZH}[^1]。`,
      cut: "大潮出现在 新月和满月时[1]。",
      written: asCheckedZh(OVERSTATED_ZH),
      part: "，并且每年都会淹没港口",
      check: englishEvidence(`大潮出现在新月和满月时${INLINE_NODE}。`),
    },
  ])(
    "a cut takes out only its part, and the rest lands byte for byte ($language)",
    async ({ content, cut, written, part, check }) => {
      const { core, model, client } = await write({ content, cut, check });

      expect(written).toContain(part);
      expect(paragraphText(client, 1)).toBe(written.replace(part, ""));
      const marks = await marksIn(core, client);
      expect(marks.map(({ shown }) => shown.state)).toEqual(["needs-recheck"]);
      expect(lastResult(model)).toContain("was taken out");
    },
  );

  // protects=a cut that takes a sentence's first words out may start it with the next word's capital, and is used; fails_when=it is refused for the capital; no_claim=none beyond protects.
  test("a cut that takes the first words out starts with the next word's capital", async () => {
    const { client } = await write({ content: `## Tides\n\n${YEARLY} [^1].` });

    expect(paragraphText(client, 1)).toBe(asChecked("Spring tides come at new and full moon"));
  });

  // protects=a cut that drops the first words lands with the next word's capital even when the model gives it in lower case (#1397's review); fails_when=the sentence starts in lower case; no_claim=none beyond protects.
  test("a cut that drops the first words lands with the next word's capital", async () => {
    const { client } = await write({
      content: `## Tides\n\n${YEARLY} [^1].`,
      cut: "and spring tides come at new and full moon [1].",
    });

    expect(paragraphText(client, 1)).toBe(asChecked("And spring tides come at new and full moon"));
  });

  // protects=a Citation a cut leaves out takes all its words with it, so none reads as backed by the next Citation (#1397's review), in English and Chinese; fails_when=a dropped Citation's words land under the next one; no_claim=how often a real model cuts one.
  test.each([
    {
      language: "en",
      content: `## Tides\n\n${TWO_CITED}`,
      cut: "Spring tides come at new and full moon, and they flood the harbour every year [2].",
      written: TWO_CITED.replaceAll(" [^1]", ` ${INLINE_NODE}`),
    },
    {
      language: "zh-CN",
      content: `## 潮汐\n\n${TWO_CITED_ZH}`,
      cut: "公司营收增长了5%，所有地区成本都大幅下降[2]。",
      written: TWO_CITED_ZH.replaceAll("[^1]", INLINE_NODE),
    },
  ])(
    "a cut that leaves a dropped Citation's words isn't used, and the sentence lands as written, marked ($language)",
    async ({ content, cut, written }) => {
      const { model, calls, client } = await write({ content, cut });

      expect(paragraphText(client, 1)).toBe(written);
      const [mark] = claimSpans(readMind(client));
      expect(mark?.check).toMatchObject({ state: "unsupported", text: written });
      // The rule refused it, not the check of the cut.
      expect(calls.filter((call) => isCheckRun(call) && call.results.length === 0)).toHaveLength(1);
      expect(lastResult(model)).toContain("1 sentence is still not supported by its Citations");
      expect(lastResult(model)).not.toContain("was taken out");
    },
  );

  // protects=a cut that changes what the sentence says ("did not rise" to "did rise", 没有 dropped) isn't used, because the cut is checked once as it would land (#1397's review), in English and Chinese; fails_when=the changed claim lands; no_claim=how often a real model cuts like that.
  test.each([
    {
      language: "en",
      content: `## Tides\n\n${NOT_RISE}`,
      cut: "Revenue did rise in 2023 [1].",
      checked: `Revenue did rise in 2023 ${INLINE_NODE}.`,
      written: asChecked("Revenue did not rise in 2023"),
    },
    {
      language: "zh-CN",
      content: `## 潮汐\n\n${NOT_RISE_ZH}`,
      cut: "公司营收在所有地区增长[1]。",
      checked: `公司营收在所有地区增长${INLINE_NODE}。`,
      written: asCheckedZh("公司营收没有在所有地区增长"),
    },
  ])(
    "a cut that changes what the sentence says isn't used, and the sentence lands as written, marked ($language)",
    async ({ content, cut, checked, written }) => {
      const { model, calls, client } = await write({ content, cut });

      expect(paragraphText(client, 1)).toBe(written);
      const [mark] = claimSpans(readMind(client));
      expect(mark?.check).toMatchObject({ state: "unsupported", text: written });
      expect(calls.some((call) => isCheckRun(call) && sentenceOf(call) === checked)).toBe(true);
      expect(lastResult(model)).toContain("1 sentence is still not supported by its Citations");
      expect(lastResult(model)).not.toContain("was taken out");
    },
  );

  // protects=a restored full stop takes the place of a comma or colon the cut kept before it, so "…[1],." and "…[1]，。" never land (#1397's review), in English and Chinese; fails_when=the stop dangles after the mark; no_claim=none beyond protects.
  test.each([
    {
      language: "en",
      content: `## Tides\n\n${COMMA_TAIL}`,
      cut: "The harbour floods in spring [1],",
      written: `The harbour floods in spring${INLINE_NODE}.`,
      check: undefined,
    },
    {
      language: "zh-CN",
      content: `## 潮汐\n\n${COMMA_TAIL_ZH}`,
      cut: "大潮出现在新月和满月时 [1]，",
      written: `大潮出现在新月和满月时${INLINE_NODE}。`,
      check: englishEvidence(`大潮出现在新月和满月时${INLINE_NODE}。`),
    },
  ])(
    "a restored full stop replaces a kept comma or colon ($language)",
    async ({ content, cut, written, check }) => {
      const { core, client } = await write({ content, cut, check });

      expect(paragraphText(client, 1)).toBe(written);
      const marks = await marksIn(core, client);
      expect(marks.map(({ shown }) => shown.state)).toEqual(["needs-recheck"]);
    },
  );

  // protects=a sentence whose full stop comes before its Citation ("…regions.[1]") keeps it when a cut leaves it out, so the next sentence stays apart (#1397's review); fails_when=the two sentences merge; no_claim=none beyond protects.
  test("a cut that leaves out the stop before its Citation keeps it, and the next sentence stays apart", async () => {
    const { client } = await write({
      content: `## Tides\n\n${STOP_BEFORE} Neap tides come between.`,
      cut: "Spring tides come at new and full moon [1]",
    });

    expect(paragraphText(client, 1)).toBe(
      `Spring tides come at new and full moon.${INLINE_NODE} Neap tides come between.`,
    );
  });

  // protects=a written sentence its Citations don't support at all lands marked unsupported, with the check's reason, so Check this note has nothing more to find; fails_when=it lands unmarked, is cut, or Check this note sends it again; no_claim=none beyond protects.
  test("a sentence still unsupported lands marked, and Check this note leaves it", async () => {
    const { core, model, calls, change, client } = await write({
      content: `## Tides\n\n${UNBACKED} [^1].`,
    });

    expect(shownWithChanges(client)).toEqual([
      "+ Tides",
      "+ Neap tides are twice as strong ⟨found⟩.",
    ]);
    const [mark] = claimSpans(readMind(client));
    expect(mark?.check).toMatchObject({
      state: "unsupported",
      action: "check-against-documents",
      text: asChecked(UNBACKED),
      unsupported: { reason: "No Passage compares the strength of the tides." },
    });
    expect(calls.some((call) => CUT.test(call.prompt))).toBe(false);
    expect(lastResult(model)).toContain(
      "1 sentence is still not supported by its Citations, and marked so in the Note",
    );
    await resolveChanges(client, "accept");
    expect(claimSpans(readMind(client))).toHaveLength(1);
    expect(await core.planMindCheck(change?.mindId ?? "", "changed")).toMatchObject({
      kind: "unchanged",
    });
  });

  // protects=a check that fails lands its sentence marked not checked, with why, and the reply and the card's line say so; fails_when=it lands unmarked, which reads as supported; no_claim=the words of the line.
  test("a sentence whose check fails lands marked not checked, and the model is told", async () => {
    const { core, model, change, client } = await write({
      content: `## Tides\n\n${FAILING} [^1].`,
    });

    const [mark] = await marksIn(core, client);
    expect(mark?.check).toMatchObject({ state: "not-checked", reason: "failed" });
    expect(change?.selfCheck).toMatchObject({ cited: 1, sent: 1, failed: 1 });
    expect(lastResult(model)).toContain(
      "1 sentence couldn't be checked, and is marked so in the Note: say so.",
    );
  });

  // protects=the spending cap reached during the check stops it: the sentences left land not checked for that reason, and the change says what stopped it, for the line that offers Change the cap; fails_when=they land unmarked, or the stop isn't kept; no_claim=the line's words.
  test("the spending cap reached during the check stops it, and its sentences say why", async () => {
    let capped = false;
    const { core, change, client } = await write({
      content: `## Tides\n\n${UNBACKED} [^1]. ${OVERSTATED} [^1].`,
      cloud: { kind: "anthropic", modelId: "claude-haiku-5-5" },
      ends: "failed",
      check: (_call, started) => {
        if (!capped) {
          capped = true;
          void started.updateSettings({ user: { monthlyCap: { amount: 0, currency: "USD" } } });
        }
        return null;
      },
    });

    const marks = await marksIn(core, client);
    expect(marks.map(({ check }) => [check.state, check.reason])).toEqual([
      ["not-checked", "cost-cap"],
      ["not-checked", "cost-cap"],
    ]);
    expect(change?.selfCheck).toMatchObject({
      cited: 2,
      sent: 2,
      checked: 0,
      failed: 2,
      stop: { reason: "cost-cap" },
    });
  });

  // protects=a plan's limit reached during the check stops it the same way, keeping the stop for the line that says when it resumes; fails_when=the sentences land unmarked, or the stop isn't kept; no_claim=the line's words.
  test("a plan's limit reached during the check stops it, and its sentences say why", async () => {
    const { core, change, client } = await write({
      content: `## Tides\n\n${UNBACKED} [^1].`,
      cloud: { kind: "ollama", modelId: "glm-5.3:cloud" },
      check: () => ({
        error: { status: 402, message: "You have reached your weekly usage limit" },
      }),
    });

    const [mark] = await marksIn(core, client);
    expect(mark?.check).toMatchObject({ state: "not-checked", reason: "plan-limit" });
    expect(change?.selfCheck).toMatchObject({
      sent: 1,
      checked: 0,
      failed: 1,
      stop: { reason: "plan-limit" },
    });
  });

  // protects=turning the checks flow off while the check runs stops it at once: no request after it reaches the model's service, and the sentences land not checked, saying why (#1206); fails_when=the remaining sentences are still sent, or land unmarked; no_claim=the Privacy page.
  test("turning the checks flow off while the check runs sends nothing more, and the sentences land not checked", async () => {
    let turnOff: (() => Promise<void>) | null = null;
    let sentBefore = -1;
    const { core, calls, change, client } = await write(
      {
        content: `## Tides\n\n${UNBACKED} [^1]. Neap tide 2 is twice as strong [^1]. Neap tide 3 is twice as strong [^1].`,
        cloud: { kind: "anthropic", modelId: "claude-haiku-5-5" },
        during: () => turnOff?.() ?? Promise.resolve(),
      },
      ({ core: started, service, calls: made }) => {
        turnOff = async () => {
          if (service) await started.revokeConsent("checks", service);
          sentBefore = made.filter(isCheckRun).length;
        };
      },
    );

    // The checks' first requests were on their way, a cloud model's several at once; none went after.
    const checks = calls.filter(isCheckRun);
    expect(sentBefore).toBeGreaterThan(0);
    expect(checks).toHaveLength(sentBefore);
    expect(checks.every((call) => call.results.length === 0)).toBe(true);
    const marks = await marksIn(core, client);
    expect(marks.map(({ check }) => [check.state, check.reason])).toEqual([
      ["not-checked", "consent-revoked"],
      ["not-checked", "consent-revoked"],
      ["not-checked", "consent-revoked"],
    ]);
    expect(change?.selfCheck).toMatchObject({
      cited: 3,
      sent: 3,
      checked: 0,
      failed: 3,
      blocked: { reason: "consent-revoked", count: 3 },
    });
  });

  // protects=one write checks at most SENTENCES_CHECKED_AT_MOST sentences; the rest land marked not checked, and the reply says so; fails_when=a long draft sends a check for every sentence, or the rest land unmarked; no_claim=how long each check takes.
  test("one write checks at most the first sentences; the rest land marked not checked", async () => {
    const many = SENTENCES_CHECKED_AT_MOST + 1;
    const sentences = Array.from(
      { length: many },
      (_, index) => `Neap tide ${index + 1} is twice as strong [^1].`,
    );
    const { core, model, calls, change, client } = await write({
      content: `## Tides\n\n${sentences.join(" ")}`,
    });

    expect(calls.filter((call) => isCheckRun(call) && call.results.length === 0)).toHaveLength(
      SENTENCES_CHECKED_AT_MOST,
    );
    const marks = await marksIn(core, client);
    expect(marks).toHaveLength(many);
    expect(marks.at(-1)?.check).toMatchObject({ state: "not-checked", reason: "too-many" });
    expect(change?.selfCheck).toMatchObject({ cited: many, sent: SENTENCES_CHECKED_AT_MOST });
    expect(lastResult(model)).toContain(
      `Only the first ${SENTENCES_CHECKED_AT_MOST} of its ${many} sentences with Citations were checked`,
    );
  });

  // protects=words the User types into what the assistant wrote while the check runs stay: only the sentences cut or marked are written, each only while unchanged (one with no cut too); fails_when=the User's words vanish, or a sentence they changed is cut over; no_claim=none beyond protects.
  test("words the User types while the check runs stay, and a sentence they changed is only marked", async () => {
    let client: MindClient | null = null;
    const { core } = await write(
      {
        content: `${OVERSTATED} [^1]. Neap tides come between.\n\nThe harbour office posts the times.\n\n${UNBACKED} [^1].`,
        into: true,
        during: async () => {
          const typing = client;
          if (!typing) return;
          await typing.settled();
          // After the cut sentence, in its paragraph; at the start of a paragraph with no cut; and in a marked sentence.
          const paragraph = typing.blocks.get(2);
          const texts =
            paragraph instanceof Y.XmlElement
              ? paragraph.toArray().filter((each) => each instanceof Y.XmlText)
              : [];
          const last = texts.at(-1);
          if (last instanceof Y.XmlText) last.insert(last.length, " Quiet.");
          typeInto(typing, 3, 0, "Today ");
          typeInto(typing, 4, 0, "All ");
          await typing.settled();
        },
      },
      ({ client: connected }) => {
        client = connected;
      },
    );
    const page = client as MindClient | null;
    if (!page) throw new Error("No client.");
    await page.settled();

    expect(shownWithChanges(page)).toEqual([
      "Harbour",
      "Boats moor by the quay.",
      "+ Spring tides come at new and full moon ⟨found⟩. Neap tides come between. Quiet.",
      "+ Today The harbour office posts the times.",
      "+ All Neap tides are twice as strong ⟨found⟩.",
    ]);
    const marks = await marksIn(core, page);
    expect(marks.map(({ sentence, shown }) => [sentence, shown.state])).toEqual([
      ["Spring tides come at new and full moon .", "needs-recheck"],
      ["All Neap tides are twice as strong .", "needs-recheck"],
    ]);
  });

  // protects=a sentence with a Citation is checked even when it is too short to make a claim (#1909), as "€12 million" in a table; fails_when=isClaim leaves it unchecked; no_claim=the verdict.
  test("a short sentence with a Citation is checked", async () => {
    const { core, change, client } = await write({ content: "## Tides\n\n€12 million [^1]." });

    expect(change?.selfCheck).toMatchObject({
      checkable: 1,
      cited: 1,
      sent: 1,
      checked: 1,
      failed: 0,
    });
    const marks = await marksIn(core, client);
    expect(marks.map(({ sentence, shown }) => [sentence, shown.state])).toEqual([
      ["€12 million .", "unsupported"],
    ]);
  });

  // protects=a sentence with no Citation isn't checked as it lands (#1909: it is left to the one count and the one Check), as its Citations are what the written check reads; fails_when=a check Run is made for it, or it lands marked; no_claim=none beyond protects.
  test("a sentence with no Citation isn't checked as it lands", async () => {
    const { calls, client } = await write({
      content: "## Tides\n\nThe harbour is quiet in winter.",
    });

    expect(shownWithChanges(client)).toEqual(["+ Tides", "+ The harbour is quiet in winter."]);
    expect(calls.some(isCheckRun)).toBe(false);
  });
});
