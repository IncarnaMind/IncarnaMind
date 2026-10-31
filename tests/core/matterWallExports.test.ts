import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { askAssistant } from "../helpers/assistant";
import { setUpWithDocuments } from "../helpers/citations";
import { indexed, linkWithExports } from "../helpers/evidence";
import { connectToMind } from "../helpers/mindClient";
import { note, writeMind } from "../helpers/minds";
import { type ModelCall, type ScriptedReply, scriptedModel } from "../helpers/models";

/**
 * A file IncarnaMind writes from a walled Note stays behind the wall when it comes back as a
 * Document, as an export into a Linked folder that holds the Output location does (#1934).
 */

const OFFER = "Client A settlement offer: 2.5 million zeta.";

async function setUp() {
  const calls: ModelCall[] = [];
  const model = scriptedModel((call): ScriptedReply => {
    calls.push(call);
    const done = (tool: string) => call.results.some((each) => each.tool === tool);
    const exporting = /Export note (\S+)/.exec(call.prompt);
    if (exporting && !done("run_command")) {
      const input = { command: "mind.export", ids: [exporting[1]], format: "markdown" };
      return { calls: [{ tool: "run_command", input }] };
    }
    if (!exporting && !done("search_documents")) {
      return { calls: [{ tool: "search_documents", input: { query: "settlement offer" } }] };
    }
    return { text: "Done." };
  });
  const setup = await setUpWithDocuments(model, []);
  const { core } = setup;
  const { papers } = await linkWithExports(core, [
    { name: "General memo.txt", contents: "The general memo has no offer in it.\n" },
  ]);
  const folder = await core.createLibraryGroup({ name: "Client A", description: "" });
  await core.updateLibraryGroup(folder.id, { name: "Client A", description: "", keepInside: true });
  const walled = await core.createMind({ title: "Client A privileged", folderId: folder.id });
  writeMind(await connectToMind(core, walled.id), [note(OFFER)]);
  const exported = join(papers, "Exports", "Client A privileged.md");
  return { core, calls, walled, outside: setup.mind, exported };
}

type Setup = Awaited<ReturnType<typeof setUp>>;

/** What search_documents gave the model in the requests from `from` on. */
const searched = (calls: readonly ModelCall[], from: number) =>
  calls
    .slice(from)
    .flatMap((call) => call.results.filter((each) => each.tool === "search_documents"))
    .map((each) => each.text)
    .join("\n");

const sent = (calls: readonly ModelCall[], from: number) =>
  calls
    .slice(from)
    .map((call) => `${call.system}\n${call.prompt}`)
    .join("\n");

async function askBothSides(s: Setup) {
  const from = s.calls.length;
  await askAssistant(s.core, { text: "What is the settlement offer?", mindId: s.outside.id });
  const found = searched(s.calls, from);
  expect(found).toContain("has no offer in it");
  expect(found).not.toContain("2.5 million zeta");
  const inside = s.calls.length;
  await askAssistant(s.core, { text: "What is the settlement offer?", mindId: s.walled.id });
  expect(sent(s.calls, inside)).toContain("2.5 million zeta");
}

describe("an export of walled work, indexed again through a Linked folder", () => {
  test("the User's own export stays behind the wall", async () => {
    const s = await setUp();
    const saved = await s.core.saveMindExport(s.walled.id, { format: "markdown" });
    if (saved.status !== "saved") throw new Error(`The export wasn't saved: ${saved.status}.`);
    const copy = await indexed(s.core, saved.file.path);
    expect(copy.ownFile?.kind).toBe("export");
    await askBothSides(s);
  });

  test("the assistant's export stays behind the wall", async () => {
    const s = await setUp();
    await askAssistant(s.core, { text: `Export note ${s.walled.id}`, mindId: s.walled.id });
    const copy = await indexed(s.core, s.exported);
    expect(copy.ownFile?.kind).toBe("export");
    await askBothSides(s);
  });
});
