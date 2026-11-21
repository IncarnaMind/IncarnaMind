/**
 * A check's Run starts from a search of the Documents for the sentence itself, made by code, and
 * shows the model those Passages first (#3512). A model that never searches itself here is handed
 * exactly the Passages its own search would have been: the check's scope, without the Documents
 * the User keeps as their own workings, never the copy of a file an outside agent handed over, and
 * for an agent's check only what the agent reaches, as it was admitted when the check began.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Core, SearchScope } from "../../src/core";
import { mindScopeOf, setMindScope } from "../../src/shared/mindScope";
import { buildAgentShim, connectLegacyAgent } from "../helpers/agents";
import { checkGenerate, checkingModel, isCheckRun, sentenceOf } from "../helpers/checks";
import { shownPassages } from "../helpers/citations";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import {
  DECK,
  type Handed,
  handOver,
  NORTH,
  PLANS,
  started,
  structured,
} from "../helpers/handedFiles";
import { connectToMind } from "../helpers/mindClient";
import { writeMind } from "../helpers/minds";
import { type ModelCall, scriptedModel } from "../helpers/models";

const LOG = "# Quay log\n\nThe north quay holds 42 boats, the log says.\n";
const SURVEY = "Harbour survey";
const DECOY = "Quay log";
const HANDED = "Harbour review";

/** A model that never searches: it says the sentence is the writer's own view, so only the code's search reaches it. */
function silent(calls: ModelCall[]) {
  return scriptedModel(
    (call) => {
      calls.push(call);
      return isCheckRun(call)
        ? { text: "Verdict: own view\nExplanation: A remark.\nEvidence: []" }
        : { text: "" };
    },
    { generate: checkGenerate(PLANS) },
  );
}

/** The Documents the Passages shown to a check's Run name, from request number `from` of `calls`. */
const shown = (calls: readonly ModelCall[], from = 0) =>
  new Set(
    calls
      .slice(from)
      .filter(isCheckRun)
      .flatMap((call) =>
        call.results
          .filter((result) => result.tool === "search_documents")
          .flatMap((result) => shownPassages(result.text).map((each) => each.document)),
      ),
  );

const documentsScope = (...documentIds: string[]): SearchScope => ({
  folderIds: [],
  tagIds: [],
  documentIds,
});

async function setUp() {
  const calls: ModelCall[] = [];
  const library = await started(calls, { model: silent(calls) });
  const sources = library.files;
  const [decoy] = await addAndProcess(library.core, [
    await writeSourceFile(sources, "Quay log.md", LOG),
  ]);
  if (!decoy) throw new Error("The log wasn't added.");
  const survey = library.added.find((each) => each.name === SURVEY || each.name.startsWith(SURVEY));
  if (!survey) throw new Error("The survey wasn't added.");
  return { ...library, calls, decoy, survey };
}

/** The User's own Note holding NORTH, checked in the window's way; the Passages it was handed are returned. */
async function checkedNote(core: Core, calls: ModelCall[], scope?: SearchScope) {
  const before = calls.length;
  const mind = await core.createMind({ title: "Quays", folderId: null });
  const client = await connectToMind(core, mind.id);
  writeMind(client, [
    { type: "paragraph", attrs: { id: "one" }, content: [{ type: "text", text: NORTH }] },
  ]);
  if (scope) setMindScope(client.doc, scope);
  await client.settled();
  expect(scope ? mindScopeOf(client.doc) : null).toEqual(scope ?? null);
  await core.checkMind({ requestId: crypto.randomUUID(), mindId: mind.id, mode: "all" });
  return shown(calls, before);
}

describe("a check starts from the sentence's own search, in the scope its model's search has", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  // protects=a check whose Note has no scope of its own is handed Passages of every Document, which is the control for the cases below; fails_when=the code's search isn't made, or shows nothing
  it("hands a Note with no scope the Passages of every Document that holds the sentence's words", async () => {
    const { core, calls } = await setUp();

    expect(await checkedNote(core, calls)).toEqual(new Set([SURVEY, DECOY]));
  });

  // protects=the Search scope the User set for a Note is the scope of the first search too; fails_when=the first search looks in Documents the scope leaves out
  it("looks only in the Note's chosen scope", async () => {
    const { core, calls, survey } = await setUp();

    expect(await checkedNote(core, calls, documentsScope(survey.id))).toEqual(new Set([SURVEY]));
  });

  // protects=a Document the User keeps as their own workings is never shown to a check, by the first search either; fails_when=the first search shows a Not cited Document
  it("leaves out a Document the User keeps as their own workings", async () => {
    const { core, calls, decoy } = await setUp();
    expect(await checkedNote(core, calls)).toContain(DECOY);

    await core.setNotCited(decoy.id, true);

    expect(await checkedNote(core, calls)).toEqual(new Set([SURVEY]));
  });

  // protects=the copy of a file an outside agent handed over is never a source for another sentence, in the first search too (#3492); fails_when=the first search shows the handed deck's lines
  it("never shows the copy of a file an agent handed over", async () => {
    const { core, calls, writer, coast, files } = await setUp();
    const agent = await connectLegacyAgent(writer.launch);
    const path = join(files, `${HANDED}.pptx`);
    await writeFile(path, DECK);
    structured<Handed>(await handOver(agent, { path, folderId: coast.id }));
    expect((await core.listDocuments()).map((each) => each.name.replace(/\.pptx$/, ""))).toContain(
      HANDED,
    );

    expect(await checkedNote(core, calls)).toEqual(new Set([SURVEY, DECOY]));
  });

  // protects=a check an agent starts is handed only what the agent reaches; fails_when=the first search shows a Document outside the agent's Folders
  it("holds an agent's check to the Documents the agent reaches", async () => {
    const { calls, writer } = await setUp();
    const agent = await connectLegacyAgent(writer.launch);
    const made = structured<{ mindId: string }>(
      await agent.callTool({ name: "create_mind", arguments: { title: "Quays", markdown: NORTH } }),
    );
    const before = calls.length;

    await agent.callTool({ name: "check_mind", arguments: { mindId: made.mindId } });

    expect(calls.length).toBeGreaterThan(before);
    expect(shown(calls, before)).toEqual(new Set([SURVEY]));
  });

  // protects=a check for an agent reads only the Documents admitted as it began, in its first search and in the model's later ones, whatever is filed outside the agent's reach while its first request waits; fails_when=either search shows the Document filed during the run
  it("searches, before and after a wait, only what the agent reached as the check began", async () => {
    let release = () => {};
    const waiting = {
      until: new Promise<void>((resolve) => {
        release = resolve;
      }),
      arrived: 0,
    };
    const calls: ModelCall[] = [];
    // It says the sentence isn't found, so the check asks it to search again once it has waited.
    const model = checkingModel(
      {
        [NORTH]: {
          verdict: "unsupported",
          again: { query: "north quay boats", plan: { verdict: "unsupported" } },
        },
        ...PLANS,
      },
      calls,
    );
    const generate = model.doGenerate.bind(model);
    const stream = model.doStream.bind(model);
    model.doGenerate = async (options) => {
      waiting.arrived++;
      await waiting.until;
      return generate(options);
    };
    model.doStream = async (options) => {
      waiting.arrived++;
      await waiting.until;
      return stream(options);
    };
    const { core, writer } = await started(calls, { model });
    const agent = await connectLegacyAgent(writer.launch);
    const made = structured<{ mindId: string }>(
      await agent.callTool({ name: "create_mind", arguments: { title: "Quays", markdown: NORTH } }),
    );
    const before = calls.length;

    const checking = agent.callTool({ name: "check_mind", arguments: { mindId: made.mindId } });
    await vi.waitFor(() => expect(waiting.arrived).toBeGreaterThan(0));
    // Under way: a Document that holds the sentence's words lands in a Folder the agent wasn't given.
    const finance = await core.createLibraryGroup({ name: "Finance", description: "Money." });
    const [secret] = await addAndProcess(core, [
      await writeSourceFile(await createSourceFolder(), "Quay log.md", LOG),
    ]);
    if (!secret) throw new Error("The log wasn't added.");
    await core.assignDocumentGroup(secret.id, finance.id);
    release();
    await checking;

    const searches = calls
      .slice(before)
      .filter(isCheckRun)
      .flatMap((call) => call.results.filter((result) => result.tool === "search_documents"));
    // The first by code, then the model's own, which the check asked for after the wait.
    expect(searches.length).toBeGreaterThanOrEqual(2);
    expect(shown(calls, before)).toEqual(new Set([SURVEY]));
    for (const call of calls.slice(before)) {
      expect(call.prompt).not.toContain("the log says");
      expect(JSON.stringify(call.results)).not.toContain("the log says");
    }
  });

  const EAST = "The east quay holds 31 boats.";
  const EAST_OTHER = "The east quay holds 35 boats.";
  const FILE = "Quay notes";

  // protects=a sentence an agent writes from a file outside the Library still gets that file, shown with the sentence, and no other sentence's first search is handed it (#3509); fails_when=the code's search hands the file to a sentence that doesn't cite it, or the sentence that cites it loses it
  it("still gives a sentence the file it cites by path, and hands that file to no other sentence", async () => {
    const calls: ModelCall[] = [];
    const { writer, coast, files } = await started(calls, {
      plans: {
        ...PLANS,
        [EAST]: {
          verdict: "supported",
          quote: "The east quay holds 31 boats",
          says: "Quay notes say the east quay holds 31 boats.",
        },
        [EAST_OTHER]: { verdict: "unsupported" },
      },
    });
    const agent = await connectLegacyAgent(writer.launch);
    const path = join(files, `${FILE}.md`);
    await writeFile(path, `# ${FILE}\n\n${EAST}\n\nThe slipway closes at dusk.\n`);
    const { citations } = structured<{ citations: { cite: string | null }[] }>(
      await agent.callTool({
        name: "cite",
        arguments: { citations: [{ path, quote: "The east quay holds 31 boats" }] },
      }),
    );
    const made = structured<{ mindId: string }>(
      await agent.callTool({
        name: "create_mind",
        arguments: {
          title: "Quays",
          markdown: `${EAST} ${citations[0]?.cite}\n\n${EAST_OTHER}`,
          folderId: coast.id,
        },
      }),
    );
    const before = calls.length;

    const checked = structured<{ status: string; supported: number }>(
      await agent.callTool({ name: "check_mind", arguments: { mindId: made.mindId } }),
    );

    expect(checked).toMatchObject({ status: "checked", supported: 1 });
    const runs = calls.slice(before).filter(isCheckRun);
    // The sentence that cites the file has it, shown with the sentence.
    expect(runs.find((call) => sentenceOf(call) === EAST)?.prompt).toContain(FILE);
    // No search of any check showed the file, the code's first search included.
    for (const call of runs) expect(JSON.stringify(call.results)).not.toContain(FILE);
    // The other sentence's first search found Documents, and not the file.
    const other = runs.filter((call) => sentenceOf(call) === EAST_OTHER);
    expect(shown(other).size).toBeGreaterThan(0);
    expect(shown(other)).not.toContain(FILE);
  });
});
