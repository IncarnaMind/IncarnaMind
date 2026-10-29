import { describe, expect, test, vi } from "vitest";
import type {
  ApprovalRequest,
  ConversationAnswer,
  Core,
  WindowCommandRequest,
  WindowCommandResult,
} from "../../src/core";
import type { OfferedCommand } from "../../src/shared/commands";
import { answerRequests, askAssistant } from "../helpers/assistant";
import { setUpWithDocuments } from "../helpers/citations";
import { createTempDataFolder } from "../helpers/core";
import { type ModelCall, scriptedModel } from "../helpers/models";

/**
 * The assistant does what the User can in the app (#1421), from the one command list: the
 * window's, as ⌘K offers it, sent with each Question. The core runs its own commands (Folders,
 * Tags, Organize, styles, settings); the window runs the rest as ⌘K does, asked through the core's
 * interface; what only the User changes is never run, and the reply says where it is. The
 * model's choices are scripted; the window is this test, answering as the window would.
 */

const DOCUMENTS = [
  {
    name: "Lease Harbour Street.md",
    contents: "# Harbour Street\n\nThe rent is 900 euros a month.\n",
  },
  { name: "Lease Mill Lane.md", contents: "# Mill Lane\n\nThe tenant pays rent quarterly.\n" },
  { name: "Q3 commentary.md", contents: "# Q3\n\nRevenue grew 4%.\n" },
  {
    name: "Scan 0042.md",
    contents: "# Agreement\n\nThe landlord lets the flat; rent is due monthly.\n",
  },
];

const entry = (id: OfferedCommand["id"], label: string, more: Partial<OfferedCommand> = {}) => ({
  id,
  label,
  purpose: null,
  on: null,
  deletes: false,
  final: false,
  yours: null,
  ...more,
});

/** What a window offers: as the renderer's list makes it, in English. */
const OFFERED: OfferedCommand[] = [
  entry("document.openBeside", "Open in a split on the right", { on: ["document"] }),
  entry("mind.openBeside", "Open in a split on the right", { on: ["mind"] }),
  entry("document.rename", "Rename", { on: ["document"] }),
  entry("mind.check", "Check"),
  entry("tab.split", "Split to the Right"),
  entry("examples.remove", "Remove the examples", { deletes: true }),
  entry("meeting.stop", "Stop recording", { final: true }),
  entry("settings.localMode", "Keep everything on this computer", { yours: "privacy" }),
];

type Step = (results: ModelCall["results"]) => { tool: string; input: unknown };

/** A model that makes these calls, one a step, each from what the earlier ones returned, then replies. */
const calling = (...steps: Step[]) =>
  scriptedModel((call) => {
    const made = call.results.filter((each) => /^(?:list_commands|run_command)$/.test(each.tool));
    const step = steps[made.length];
    return step ? { calls: [step(call.results)] } : { text: "Done." };
  });

const idsFound = (results: ModelCall["results"]): string[] => {
  const listed = results.filter((each) => each.tool === "list_commands").at(-1)?.text ?? "";
  return [...listed.matchAll(/^- (\S+): /gm)].map((match) => match[1] ?? "");
};

const find =
  (name: string, kind = "document"): Step =>
  () => ({ tool: "list_commands", input: { kind, name } });

const run =
  (command: string, input: Record<string, unknown> = {}, found = true): Step =>
  (results) => ({
    tool: "run_command",
    input: { command, ...(found && { ids: idsFound(results) }), ...input },
  });

const commandCalls = (answer: ConversationAnswer) =>
  answer.toolCalls.filter((call) => call.source === "commands");

/** Answers the core's window requests as the window would, and keeps them. */
function windowOf(core: Core, answer: (request: WindowCommandRequest) => WindowCommandResult) {
  const asked: WindowCommandRequest[] = [];
  core.on("command.windowRun", (request) => {
    asked.push(request);
    void core.answerWindowCommand(request.requestId, answer(request));
  });
  return asked;
}

const approvals = (core: Core, response: "allow-once" | "deny") => {
  const asked: ApprovalRequest[] = [];
  core.on("approval.requested", (request) => {
    asked.push(request);
    void core.respondToApproval(request.requestId, response);
  });
  return asked;
};

const runOf = (answer: ConversationAnswer): string => {
  const ran = commandCalls(answer).find((call) => call.command)?.command?.run;
  if (!ran) throw new Error("No command ran.");
  return ran;
};

describe("The window's commands run in the window, as ⌘K runs them (#1421)", {
  timeout: 60_000,
}, () => {
  // protects="open the Q3 commentary beside this one" finds it and has the window run its Open in a split on the right on it, and the card's one line is the reply; fails_when=the core runs it, it acts on another Document, or the model is asked to reply after it; no_claim=how the window lays out the split.
  test("Open in a split on the right runs in the window on what was found, and ends the turn", async () => {
    const model = calling(find("Q3 commentary"), run("document.openBeside"));
    const { core, mind, documents } = await setUpWithDocuments(model, DOCUMENTS);
    const asked = windowOf(core, () => ({ ran: true, changed: false }));
    const q3 = documents.find((each) => each.name.startsWith("Q3"));

    const answer = await askAssistant(core, {
      text: "Open the Q3 commentary beside this one",
      mindId: mind.id,
      commands: OFFERED,
    });

    expect(asked.map(({ command, targets }) => ({ command, targets }))).toEqual([
      { command: "document.openBeside", targets: [{ kind: "document", id: q3?.id }] },
    ]);
    expect(commandCalls(answer).at(-1)?.command).toMatchObject({
      command: "document.openBeside",
      items: [{ kind: "document", id: q3?.id, name: "Q3 commentary" }],
      window: { changed: false },
    });
    // The card says what it did: no closing reply follows the call.
    expect(answerRequests(model)).toHaveLength(2);
    expect(answer.text).toBe("");
  });

  // protects="check this note" has the window run Check on the note in front, with nothing found; fails_when=it needs a list_commands first, or the window isn't asked; no_claim=what the check finds.
  test("Check runs on the window in front", async () => {
    const model = calling(run("mind.check", {}, false));
    const { core, mind } = await setUpWithDocuments(model, DOCUMENTS);
    const asked = windowOf(core, () => ({ ran: true, changed: false }));

    const answer = await askAssistant(core, {
      text: "Check this Note",
      mindId: mind.id,
      commands: OFFERED,
    });

    expect(asked.map(({ command, targets }) => ({ command, targets }))).toEqual([
      { command: "mind.check", targets: [] },
    ]);
    expect(commandCalls(answer)[0]?.command?.window).toEqual({ changed: false });
  });

  // protects=list_commands with kind "window" gives the window's own commands, not those of the User's alone as runnable; fails_when=one is missing or Local mode is listed among them; no_claim=their order.
  test("list_commands lists what acts on the window, and names what is the User's", async () => {
    const model = calling(() => ({ tool: "list_commands", input: { kind: "window" } }));
    const { core, mind } = await setUpWithDocuments(model, DOCUMENTS);

    await askAssistant(core, { text: "What can you do here?", mindId: mind.id, commands: OFFERED });

    const listed =
      model.doStreamCalls
        .flatMap((call) => call.prompt)
        .flatMap((message) => (message.role === "tool" ? message.content : []))
        .map((part) => (part.type === "tool-result" ? JSON.stringify(part.output) : ""))
        .join("\n") ?? "";
    const [windowLine = "", yoursLine = ""] = listed.split("The User's alone");
    expect(windowLine).toContain("mind.check");
    expect(windowLine).toContain("tab.split");
    expect(windowLine).not.toContain("settings.localMode");
    expect(yoursLine).toContain("settings.localMode");
  });

  // protects=a command of the window's that deletes asks first, and one that can't be undone asks first, each with Allow or Don't allow; fails_when=either runs without asking, or runs after Don't allow; no_claim=the card's words.
  test("one that deletes, or can't be undone, waits for the User; denied, the window never runs it", async () => {
    const model = calling(run("examples.remove", {}, false), run("meeting.stop", {}, false));
    const { core, mind } = await setUpWithDocuments(model, DOCUMENTS);
    const asked = windowOf(core, () => ({ ran: true, changed: true }));
    const approved = approvals(core, "deny");

    const answer = await askAssistant(core, {
      text: "Remove the examples and stop recording",
      mindId: mind.id,
      commands: OFFERED,
    });

    expect(approved.map((request) => ("ask" in request ? request.ask : null))).toEqual([
      expect.objectContaining({ kind: "change", command: "examples.remove", reason: "delete" }),
      { kind: "final", command: "meeting.stop", items: [] },
    ]);
    expect(asked).toEqual([]);
    expect(commandCalls(answer).map((call) => call.approval)).toEqual(["denied", "denied"]);
  });

  // protects=a window command the window couldn't run fails on its card, with the window's words; fails_when=the card says done; no_claim=the reply.
  test("one the window couldn't run is failed on its card, in the window's words", async () => {
    const model = calling(run("tab.split", {}, false));
    const { core, mind } = await setUpWithDocuments(model, DOCUMENTS);
    windowOf(core, () => ({
      ran: false,
      why: "“Split to the Right” doesn't apply here now, so it didn't run.",
      wording: { key: "commands.window.notOffered", values: { command: "Split to the Right" } },
    }));

    const answer = await askAssistant(core, {
      text: "Split this to the right",
      mindId: mind.id,
      commands: OFFERED,
    });

    const [call] = commandCalls(answer);
    expect(call?.status).toBe("failed");
    expect(call?.commandProblem?.wording).toEqual({
      key: "commands.window.notOffered",
      values: { command: "Split to the Right" },
    });
  });

  // protects=a command neither the core nor the window offers is refused before anything runs; fails_when=the window is asked to run it; no_claim=its words.
  test("one the window doesn't offer is refused", async () => {
    const model = calling(run("palette.open", {}, false));
    const { core, mind } = await setUpWithDocuments(model, DOCUMENTS);
    const asked = windowOf(core, () => ({ ran: true, changed: false }));

    const answer = await askAssistant(core, {
      text: "Open search",
      mindId: mind.id,
      commands: OFFERED,
    });

    expect(asked).toEqual([]);
    expect(commandCalls(answer)[0]?.commandProblem?.wording?.key).toBe("error.commands.unknown");
  });
});

describe("What only the User changes is never run (#1421)", { timeout: 60_000 }, () => {
  // protects="turn on Local mode" changes nothing, asks nothing, and its card says where the User changes it, as the turn's one line; fails_when=Local mode changes, an approval shows, or a closing reply follows; no_claim=the card's words, which the renderer's tests hold.
  test("Local mode, by its setting or by the window's command, is the User's", async () => {
    for (const step of [
      run("settings.change", { setting: "localMode", value: "on" }, false),
      run("settings.localMode", {}, false),
    ]) {
      const model = calling(step);
      const { core, mind } = await setUpWithDocuments(model, DOCUMENTS);
      const asked = windowOf(core, () => ({ ran: true, changed: true }));
      const approved = approvals(core, "allow-once");
      const before = (await core.getEmbeddingSettings()).localOnly;

      const answer = await askAssistant(core, {
        text: "Turn on Local mode",
        mindId: mind.id,
        commands: OFFERED,
      });

      expect(commandCalls(answer)[0]?.command).toMatchObject({ yours: "privacy", items: [] });
      expect((await core.getEmbeddingSettings()).localOnly).toBe(before);
      expect(asked).toEqual([]);
      expect(approved).toEqual([]);
      expect(answerRequests(model)).toHaveLength(1);
    }
  });

  // protects=the spending cap and the assistant's own approval rules are the User's, by their settings' names; fails_when=either changes; no_claim=every name a model might use.
  test("the spending cap and the approval rules are the User's", async () => {
    // Both in one step: either ends the turn, as its card is the reply.
    const model = scriptedModel((call) =>
      call.results.length === 0
        ? {
            calls: [
              {
                tool: "run_command",
                input: { command: "settings.change", setting: "monthlyCap", value: "50" },
              },
              {
                tool: "run_command",
                input: { command: "settings.change", setting: "approvals", value: "always" },
              },
            ],
          }
        : { text: "Done." },
    );
    const { core, mind } = await setUpWithDocuments(model, DOCUMENTS);
    const before = (await core.getSettings()).user.monthlyCap;

    const answer = await askAssistant(core, {
      text: "Raise my cap to $50 and stop asking me",
      mindId: mind.id,
      commands: OFFERED,
    });

    expect(commandCalls(answer).map((call) => call.command?.yours)).toEqual([
      "spending",
      "approvals",
    ]);
    expect((await core.getSettings()).user.monthlyCap).toEqual(before);
  });
});

describe("Folders, Organize, styles and settings run in the core, each one Undo (#1421)", {
  timeout: 60_000,
}, () => {
  // protects="make a Folder called Leases and move the lease papers into it" makes it and moves them as one Undo, which takes both back; fails_when=Undo leaves the Folder, or a Document in it; no_claim=a real model's ids.
  test("a new Folder and a move into it are one Undo", async () => {
    const model = calling(
      run("folder.new", { name: "Leases" }, false),
      find("Lease"),
      run("document.moveTo", { folder: "Leases" }),
    );
    const { core, mind } = await setUpWithDocuments(model, DOCUMENTS);

    const answer = await askAssistant(core, {
      text: "Make a Folder called Leases and move the lease PDFs into it",
      mindId: mind.id,
      commands: OFFERED,
    });

    const library = await core.getLibrary();
    const leases = library.groups.find((each) => each.name === "Leases");
    expect(library.assignments.filter((each) => each.groupId === leases?.id)).toHaveLength(2);
    expect(new Set(commandCalls(answer).flatMap((call) => call.command?.run ?? [])).size).toBe(1);

    await core.undoCommands(runOf(answer));
    const after = await core.getLibrary();
    expect(after.groups.map((each) => each.name)).not.toContain("Leases");
    expect(after.assignments.filter((each) => each.groupId !== null)).toEqual([]);
  });

  // protects="put the documents about leases together" runs the Library's Organize, which reads what each says (the scan's name says nothing), and its suggestions wait in To review: nothing moves; one Undo takes them and the Folder back; fails_when=a Document is filed as the User's choice, the scan is left out, or Undo leaves a suggestion; no_claim=a real classifier's choices.
  test("Organize by content suggests, and nothing moves before the User accepts", async () => {
    const answers = scriptedModel(
      (call) => {
        const made = call.results.filter((each) => each.tool === "run_command").length;
        return made === 0
          ? {
              calls: [
                {
                  tool: "run_command",
                  input: {
                    command: "documents.organize",
                    folder: "Leases",
                    about: "Lease papers: tenancies and rent",
                  },
                },
              ],
            }
          : { text: "Organize is sorting them." };
      },
      {
        generate: ({ prompt }) => {
          const data = JSON.parse(prompt) as {
            groups?: { id: string; name: string }[];
            document?: { text?: string };
          };
          if (!data.groups) return { text: JSON.stringify({ tags: [] }) };
          const leases = data.groups.find((each) => each.name === "Leases");
          const aboutRent = /rent/i.test(JSON.stringify(data.document ?? {}));
          return {
            text: JSON.stringify({
              groupId: aboutRent && leases ? leases.id : "__unsorted__",
              tags: [],
            }),
          };
        },
      },
    );
    const { core, mind, documents } = await setUpWithDocuments(answers, DOCUMENTS);
    const provider = (await core.listChatProviders())[0];
    if (!provider) throw new Error("No provider.");
    const settings = (await core.getLibrary()).settings;
    await core.saveLibrarySettings({
      classifier: { kind: "chat", choice: { providerId: provider.id, modelId: "local-model" } },
      automatic: settings.automatic,
    });

    const answer = await askAssistant(core, {
      text: "Put the documents about leases together",
      mindId: mind.id,
      commands: OFFERED,
    });

    const leases = (await core.getLibrary()).groups.find((each) => each.name === "Leases");
    expect(leases?.description).toBe("Lease papers: tenancies and rent");
    const aboutRent = documents
      .filter((each) => !each.name.startsWith("Q3"))
      .map((each) => each.id)
      .sort();
    const waiting = async () =>
      (await core.getLibrary()).assignments
        .filter((each) => each.groupId === leases?.id)
        .map((each) => ({ id: each.documentId, suggested: each.suggested, source: each.source }));
    await vi.waitFor(
      async () =>
        expect((await waiting()).sort((a, b) => a.id.localeCompare(b.id))).toEqual(
          aboutRent.map((id) => ({ id, suggested: true, source: "automatic" })),
        ),
      { timeout: 30_000 },
    );

    await core.undoCommands(runOf(answer));
    const after = await core.getLibrary();
    expect(after.groups.map((each) => each.name)).not.toContain("Leases");
    expect(after.assignments.filter((each) => each.suggested)).toEqual([]);
  });

  // protects=a setting the User could change in Settings changes, and Undo puts it back; fails_when=it stays after Undo; no_claim=every setting.
  test("a setting changes, and Undo puts it back", async () => {
    const model = calling(run("settings.change", { setting: "motion", value: "reduced" }, false));
    const { core, mind } = await setUpWithDocuments(model, DOCUMENTS);
    const before = (await core.getSettings()).device.motion;

    const answer = await askAssistant(core, {
      text: "Reduce the motion",
      mindId: mind.id,
      commands: OFFERED,
    });

    expect((await core.getSettings()).device.motion).toBe("reduced");
    expect(commandCalls(answer)[0]?.command?.setting).toEqual({
      name: "motion",
      from: before,
      to: "reduced",
    });
    await core.undoCommands(runOf(answer));
    expect((await core.getSettings()).device.motion).toBe(before);
  });

  // protects=a new Output location asks first, since files are then saved there without asking; fails_when=it changes without Allow; no_claim=the card's words.
  test("a new Output location asks first", async () => {
    const elsewhere = await createTempDataFolder();
    const model = calling(
      run("settings.change", { setting: "outputLocation", value: elsewhere }, false),
    );
    const { core, mind } = await setUpWithDocuments(model, DOCUMENTS);
    const approved = approvals(core, "deny");
    const before = (await core.getOutputSettings()).location;

    await askAssistant(core, { text: `Save new files in ${elsewhere}`, mindId: mind.id });

    expect(approved.map((request) => ("ask" in request ? request.ask.kind : null))).toEqual([
      "output",
    ]);
    expect((await core.getOutputSettings()).location).toBe(before);
  });

  // protects=a note's citation style is set by name, and Undo puts back the one before; fails_when=it stays after Undo; no_claim=every style's name.
  test("a note's citation style, by its name", async () => {
    const model = calling(find("Tides", "mind"), run("mind.citationStyle", { style: "APA 7" }));
    const { core, mind } = await setUpWithDocuments(model, DOCUMENTS);
    const before = await core.getMindCitationStyle(mind.id);

    const answer = await askAssistant(core, { text: "Cite in APA here", mindId: mind.id });

    expect((await core.getMindCitationStyle(mind.id)).style).toBe("apa");
    await core.undoCommands(runOf(answer));
    expect(await core.getMindCitationStyle(mind.id)).toEqual(before);
  });

  // protects="bring back the Q3 commentary I deleted" finds it in Recently deleted by its name and puts it back where it was, asking nothing, and one Undo deletes it again; fails_when=it asks, another item comes back, or Undo leaves it in the Library; no_claim=a real model's choice of name.
  test("what is in Recently deleted comes back by its name, and Undo deletes it again", async () => {
    const model = calling(find("Q3", "deleted"), run("deleted.restore"));
    const { core, mind, documents } = await setUpWithDocuments(model, DOCUMENTS);
    const q3 = documents.find((each) => each.name.startsWith("Q3"));
    const lease = documents.find((each) => each.name.startsWith("Lease Mill"));
    if (!q3 || !lease) throw new Error("No Documents.");
    await core.deleteDocuments([q3.id, lease.id]);
    const approved = approvals(core, "deny");
    const live = async () => (await core.listDocuments()).map((each) => each.id);

    const answer = await askAssistant(core, {
      text: "Bring back the Q3 commentary I deleted",
      mindId: mind.id,
      commands: OFFERED,
    });

    expect(approved).toEqual([]);
    expect(await live()).toContain(q3.id);
    expect(await live()).not.toContain(lease.id);
    expect(commandCalls(answer).at(-1)?.command).toMatchObject({
      command: "deleted.restore",
      items: [{ kind: "deleted", id: q3.id, name: "Q3 commentary" }],
    });
    await core.undoCommands(runOf(answer));
    expect(await live()).not.toContain(q3.id);
    expect((await core.listDeleted()).map((each) => each.id)).toContain(q3.id);
  });

  // protects=deleting a Folder or a Tag asks first, as every delete the assistant starts does; fails_when=either goes without Allow; no_claim=Recently deleted's own tests.
  test("deleting a Folder or a Tag asks first", async () => {
    const model = calling(find("Leases", "folder"), run("folder.delete"));
    const { core, mind } = await setUpWithDocuments(model, DOCUMENTS);
    await core.createLibraryGroup({ name: "Leases", description: "" });
    const approved = approvals(core, "deny");

    await askAssistant(core, { text: "Delete the Leases folder", mindId: mind.id });

    expect(approved.map((request) => ("ask" in request ? request.ask.kind : null))).toEqual([
      "change",
    ]);
    expect((await core.getLibrary()).groups.map((each) => each.name)).toContain("Leases");
  });
});
