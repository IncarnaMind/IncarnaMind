/**
 * How the lines of a file are sorted into claims (#3506): a file an outside agent hands over is its
 * writer's own text, so its words about itself make no claim for a Document to confirm, and a
 * batch whose reply can't be read leaves its lines not checked without losing the whole check.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  FIND_CLAIMS_INSTRUCTIONS,
  FIND_OWN_CLAIMS_INSTRUCTIONS,
} from "../../src/core/answers/checks/claims";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { claimCheckShown } from "../../src/shared/claimChecks";
import { buildAgentShim, connectLegacyAgent } from "../helpers/agents";
import { checkGenerate, checkReply, isCheckRun, sentenceOf } from "../helpers/checks";
import { sortReply } from "../helpers/claimSentences";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import {
  type Handed,
  handOver,
  NORTH,
  OFFICE,
  PLANS,
  SOUTH,
  SURVEY,
  started,
  structured,
} from "../helpers/handedFiles";
import { connectToMind } from "../helpers/mindClient";
import { readMind } from "../helpers/minds";
import { type ModelCall, scriptedModel, scriptedModels } from "../helpers/models";
import { plainDeck } from "../helpers/pptx";

const SOURCES = "Sources: the harbour survey; the totals are my own calculation.";
const FILLERS = Array.from({ length: 10 }, (_, index) => `Remark ${index + 1} on the quays.`);

/** A model that sorts and checks as PLANS say, with `sort` choosing what a sort replies. */
function model(sort: (call: { system: string; prompt: string }) => string, calls: ModelCall[]) {
  return scriptedModel(
    (call) => {
      calls.push(call);
      return checkReply(call, PLANS);
    },
    {
      generate(call) {
        if (call.question === "find-claims") return { text: sort(call) };
        return checkGenerate(PLANS)(call);
      },
    },
  );
}

const sortedAsPlanned = ({ prompt }: { prompt: string }) =>
  sortReply(prompt, (text) =>
    text.startsWith("Sources:") ? "note" : text in PLANS ? "claim" : "no",
  );

async function shown(core: Awaited<ReturnType<typeof started>>["core"], mindId: string) {
  const client = await connectToMind(core, mindId);
  await client.settled();
  const versions = new Map((await core.listDocuments()).map((each) => [each.id, each.contentHash]));
  return claimSpans(readMind(client)).map((span) => [
    span.sentence.text,
    claimCheckShown(span.check, {
      footing: "not-yet-known",
      text: span.sentence.text,
      versions,
      folderId: null,
      scope: null,
    }),
  ]);
}

describe("the sort of a file's lines into claims (#3506)", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);
  afterEach(() => vi.restoreAllMocks());

  // protects=a file an agent hands over is sorted as its writer's own text: a line about its sources or method is left out as words about the file, so no check is spent on it; fails_when=the line is checked and comes back Not found, or the sort is the one for someone else's document
  it("leaves the words an agent's file says about itself out of its checks", async () => {
    const calls: ModelCall[] = [];
    const sorts: string[] = [];
    const { coast, writer, files } = await started(calls, {
      model: model((call) => {
        sorts.push(call.system);
        return sortedAsPlanned(call);
      }, calls),
    });
    const agent = await connectLegacyAgent(writer.launch);
    const path = join(files, "Harbour review.pptx");
    await writeFile(
      path,
      plainDeck([{ title: "Harbour review" }, { lines: [NORTH, SOUTH, SOURCES] }]),
    );

    const first = structured<Handed>(await handOver(agent, { path, folderId: coast.id }));
    expect(first).toMatchObject({ status: "checked", supported: 1, needLook: 1 });
    expect(first.claims.map((claim) => claim.text)).toEqual([SOUTH]);
    expect(new Set(calls.filter(isCheckRun).map(sentenceOf))).toEqual(new Set([NORTH, SOUTH]));
    expect(new Set(sorts)).toEqual(new Set([FIND_OWN_CLAIMS_INSTRUCTIONS]));
  });

  // protects=a file the User checks themselves is someone else's: its sort keeps the sentences about the document, which may be the claim being checked; fails_when=the handed-file sort is used for every file
  it("sorts a file the User verifies as someone else's", async () => {
    const sorts: string[] = [];
    const core = startCore(await createTempDataFolder(), {
      createChatModel: scriptedModels(
        model((call) => {
          sorts.push(call.system);
          return sortedAsPlanned(call);
        }, []),
      ).createChatModel,
    });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const sources = await createTempDataFolder();
    await addAndProcess(core, [await writeSourceFile(sources, "Harbour survey.md", SURVEY)]);
    const path = await writeSourceFile(
      sources,
      "Harbour review.pptx",
      plainDeck([{ title: "Harbour review" }, { lines: [NORTH, SOURCES] }]),
    );
    const verified = await core.verifyDocument({ path });
    if (!verified.ok) throw new Error(`The deck wasn't verified: ${verified.reason}`);
    await core.findClaims({ requestId: crypto.randomUUID(), mindId: verified.mind.id });
    expect(new Set(sorts)).toEqual(new Set([FIND_CLAIMS_INSTRUCTIONS]));
  });

  // protects=one batch of lines whose sort reply can't be read, twice, leaves those lines not checked and logs what the model gave, while the other batches' lines are checked, and the next check sorts them again; fails_when=the whole check fails, the lines are shown checked, nothing is logged, or they are never sorted again
  it("leaves a batch whose reply can't be read not checked, checks the rest, and sorts it again at the next check", async () => {
    let readable = false;
    const warnings: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...said: unknown[]) => {
      warnings.push(said.map(String).join(" "));
    });
    const calls: ModelCall[] = [];
    const { core, coast, writer, files } = await started(calls, {
      model: model((call) => {
        // The batch that holds the last line, alone in its own, gets no sort at all.
        if (!readable && call.prompt.includes(OFFICE)) return "I'm sorry, I can't sort these.";
        return sortedAsPlanned(call);
      }, calls),
    });
    const agent = await connectLegacyAgent(writer.launch);
    const path = join(files, "Harbour review.pptx");
    await writeFile(
      path,
      plainDeck([{ title: "Harbour review", lines: [NORTH, ...FILLERS] }, { lines: [OFFICE] }]),
    );

    const first = structured<Handed>(await handOver(agent, { path, folderId: coast.id }));
    expect(first).toMatchObject({ status: "checked", supported: 1 });
    const mindId = first.mindId ?? "";
    expect(new Set(calls.filter(isCheckRun).map(sentenceOf))).toEqual(new Set([NORTH]));
    expect(warnings.join("\n")).toMatch(/couldn't be read, twice.*I'm sorry, I can't sort these/);
    const marks = await shown(core, mindId);
    expect(marks.map(([text, check]) => [text, (check as { state: string }).state])).toEqual([
      [NORTH, "supported"],
      [OFFICE, "not-checked"],
    ]);
    expect(JSON.stringify(marks[1])).toContain("malformed");

    readable = true;
    const again = await core.verifyClaims({ requestId: crypto.randomUUID(), mindId });
    expect(again).toMatchObject({ kind: "checked" });
    const later = await shown(core, mindId);
    expect(later.map(([text, check]) => [text, (check as { state: string }).state])).toEqual([
      [NORTH, "supported"],
      [OFFICE, "supported"],
    ]);
  });
});
