/**
 * A batch of a file's lines whose sort reply can't be read leaves those lines not checked without
 * losing the rest of the check (#3506).
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { claimCheckShown } from "../../src/shared/claimChecks";
import { buildAgentShim, connectLegacyAgent } from "../helpers/agents";
import { checkGenerate, checkReply, isCheckRun, sentenceOf } from "../helpers/checks";
import { sortReply } from "../helpers/claimSentences";
import {
  type Handed,
  handOver,
  NORTH,
  OFFICE,
  PLANS,
  started,
  structured,
} from "../helpers/handedFiles";
import { connectToMind } from "../helpers/mindClient";
import { readMind } from "../helpers/minds";
import { type ModelCall, scriptedModel } from "../helpers/models";
import { plainDeck } from "../helpers/pptx";

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
  sortReply(prompt, (text) => (text in PLANS ? "claim" : "no"));

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

describe("a batch of lines the sort can't read (#3506)", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);
  afterEach(() => vi.restoreAllMocks());

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
