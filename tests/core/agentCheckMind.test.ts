/**
 * An outside agent has the Note it wrote checked (#3317): through the shim the app ships, with the
 * MCP SDK's own client, it calls `check_mind`. Every claim is checked against the Folder's
 * Documents on the User's model, the Note carries the marks, and the agent gets back each claim
 * that needs a look with what the Document says.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { claimCheckShown } from "../../src/shared/claimChecks";
import { buildAgentShim, connectLegacyAgent, startAgentsCore } from "../helpers/agents";
import { checkingModel, type Plan } from "../helpers/checks";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { readMind } from "../helpers/minds";
import type { ModelCall } from "../helpers/models";

const TIDES = [
  "# Tides",
  "",
  "Spring tides happen twice a month, at new moon and full moon.",
  "",
  "The range of a spring tide is the largest of the month.",
].join("\n");

const SPRING = "Spring tides come twice in every month.";
const NEAP = "Neap tides have the largest range of the month.";
const PENGUINS = "Penguins nest on the cliffs above the harbour.";
const NOTE = [SPRING, NEAP, PENGUINS].join("\n\n");

const PLANS: Record<string, Plan> = {
  [SPRING]: {
    verdict: "supported",
    quote: "Spring tides happen twice a month",
    says: "Tides says spring tides happen twice a month.",
  },
  [NEAP]: {
    verdict: "contradicted",
    quote: "The range of a spring tide is the largest of the month.",
    says: "Tides says the spring tide's range is the largest.",
  },
  [PENGUINS]: { verdict: "unsupported" },
};

type Agent = Awaited<ReturnType<typeof connectLegacyAgent>>;

interface Checked {
  mindId: string;
  title: string;
  status: string;
  stopped: string | null;
  models: string[];
  supported: number;
  needLook: number;
  claims: {
    sentence: string;
    result: string;
    reason: string | null;
    says: string | null;
    document: string | null;
    location: string | null;
    quote: string | null;
    cite: string | null;
  }[];
}

function structured<T>(result: unknown): T {
  const { isError, structuredContent, content } = result as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: { text?: string }[];
  };
  expect(isError ?? false, content?.[0]?.text).toBe(false);
  return structuredContent as T;
}

function refusal(result: unknown): string {
  const { isError, content } = result as { isError?: boolean; content?: { text?: string }[] };
  expect(isError).toBe(true);
  return content?.[0]?.text ?? "";
}

const check = (agent: Agent, mindId: string) =>
  agent.callTool({ name: "check_mind", arguments: { mindId } });

/** A core with agents on, Tides in "Coast" and an agent that may write there. */
async function paired({ propose = true, calls = [] as ModelCall[] } = {}) {
  const started = await startAgentsCore(checkingModel(PLANS, calls));
  const { core } = started;
  const sources = await createSourceFolder();
  const [tides] = await addAndProcess(core, [await writeSourceFile(sources, "Tides.md", TIDES)]);
  if (!tides) throw new Error("Tides wasn't added.");
  const coast = await core.createLibraryGroup({ name: "Coast", description: "The sea." });
  await core.assignDocumentGroup(tides.id, coast.id);
  await core.setAgentsEnabled(true);
  const { launch, pairing } = await core.connectAgent({
    name: "Claude Code",
    folderIds: [coast.id],
    propose,
  });
  const agent = await connectLegacyAgent(launch);
  return { ...started, core, coast, agent, pairing };
}

async function written(agent: Agent): Promise<string> {
  const { mindId } = structured<{ mindId: string }>(
    await agent.callTool({
      name: "create_mind",
      arguments: { title: "Tide notes", markdown: NOTE },
    }),
  );
  return mindId;
}

describe("an outside agent has its Note checked (#3317)", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  // protects=an agent learns which of the claims it wrote the User's Documents don't support, and the User sees the same marks in the Note; fails_when=the Tool checks only Citations, returns nothing of what the Document says, or leaves the Note unmarked
  it("checks every claim against the Folder's Documents, marks the Note and lists what needs a look", async () => {
    const { core, agent, pairing, coast } = await paired();
    const mindId = await written(agent);

    const checked = structured<Checked>(await check(agent, mindId));
    expect(checked).toMatchObject({
      mindId,
      title: "Tide notes",
      status: "checked",
      stopped: null,
      supported: 1,
      needLook: 2,
    });
    expect(checked.models).toHaveLength(1);
    expect(checked.claims).toEqual([
      {
        sentence: NEAP,
        result: "contradicted",
        reason: null,
        says: "Tides says the spring tide's range is the largest.",
        document: "Tides",
        location: expect.any(String),
        quote: "The range of a spring tide is the largest of the month.",
        cite: expect.stringMatching(/^\[cite:[^\]]+\]$/),
      },
      {
        sentence: PENGUINS,
        // Nothing in the Folder speaks of it: the record's "Not found".
        result: "not-found",
        reason: null,
        says: null,
        document: null,
        location: null,
        quote: null,
        cite: null,
      },
    ]);
    // The token cites the Passage the claim was judged on: the agent can use it as any other.
    const [{ check: found }] = structured<{ citations: { check: string }[] }>(
      await agent.callTool({
        name: "check_citations",
        arguments: { text: `Spring tides have the largest range ${checked.claims[0]?.cite}.` },
      }),
    ).citations as [{ check: string }];
    expect(found).toBe("found");

    // The User sees the same marks in the Note.
    const client = await connectToMind(core, mindId);
    await client.settled();
    const versions = new Map(
      (await core.listDocuments()).map((each) => [each.id, each.contentHash]),
    );
    expect(
      claimSpans(readMind(client)).map((span) => [
        span.sentence.text,
        claimCheckShown(span.check, {
          footing: "not-yet-known",
          text: span.sentence.text,
          versions,
          folderId: coast.id,
          scope: null,
        }).state,
      ]),
    ).toEqual([
      [SPRING, "supported"],
      [NEAP, "contradicted"],
      [PENGUINS, "unsupported"],
    ]);

    // Asked again with nothing changed, it sends nothing and gives the same result.
    expect(structured<Checked>(await check(agent, mindId))).toMatchObject({
      status: "checked",
      supported: 1,
      needLook: 2,
    });
    expect((await core.listAgentActivity(pairing.id)).map((each) => each.tool)).toContain(
      "check_mind",
    );
  });

  // protects=nothing of a Note goes to a service the User took checks back from, and an agent's call never puts a question on their screen (ADR-0022); fails_when=check_mind raises the consent dialog or sends while checks aren't allowed there
  it("sends nothing and asks the User nothing while checks aren't allowed on that service", async () => {
    const calls: ModelCall[] = [];
    const { core, agent } = await paired({ calls });
    const mindId = await written(agent);
    const asked: string[] = [];
    core.on("consent.requested", (request) => {
      asked.push(request.flow.id);
      void core.respondToConsent(request.requestId, false);
    });
    const saved = await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-ant-test",
      modelId: "claude-haiku-5-5",
    });
    if (!saved.service) throw new Error("The provider has no service.");
    // Choosing the service allowed its checks; the User takes that back in Settings › Privacy.
    await core.revokeConsent("checks", saved.service.id);
    calls.length = 0;

    expect(refusal(await check(agent, mindId))).toBe(
      "IncarnaMind’s AI model isn’t allowed to check yet. Check a note in IncarnaMind to allow it.",
    );
    expect(asked).toEqual([]);
    expect(calls).toEqual([]);

    await core.allowDataFlow("checks", saved.service.id);
    expect(structured<Checked>(await check(agent, mindId))).toMatchObject({
      status: "checked",
      supported: 1,
      needLook: 2,
    });
    expect(asked).toEqual([]);
  });

  // protects=an agent learns nothing of Documents outside its Folders by having a Note checked: an empty Folder doesn't search the whole Library for it, and the User's own wider check isn't passed on; fails_when=check_mind searches Documents the agent can't read, or reports a verdict from a check that did
  it("checks within the agent's Folders only, and keeps the User's wider check to the User", async () => {
    const calls: ModelCall[] = [];
    const { core, agent } = await paired({ calls });
    const sources = await createSourceFolder();
    const [rivers] = await addAndProcess(core, [
      await writeSourceFile(sources, "Rivers.md", "# Rivers\n\nPenguins nest on the cliffs.\n"),
    ]);
    if (!rivers) throw new Error("Rivers wasn't added.");
    const inland = await core.createLibraryGroup({ name: "Inland", description: "Rivers." });
    await core.assignDocumentGroup(rivers.id, inland.id);

    // A Folder with no Document would search every Document: not for an agent.
    const empty = await core.createLibraryGroup({ name: "Empty", description: "Nothing yet." });
    const { launch } = await core.connectAgent({
      name: "Codex",
      folderIds: [empty.id],
      propose: true,
    });
    const other = await connectLegacyAgent(launch);
    const alone = await written(other);
    calls.length = 0;
    expect(refusal(await check(other, alone))).toBe(
      "The note’s Folder has no Documents to check it against.",
    );
    expect(calls).toEqual([]);

    // The User checks the agent's Note against every Document; the agent then asks for its check.
    const mindId = await written(agent);
    const own = await core.checkMind({
      requestId: "the-users-own",
      mindId,
      mode: "changed",
      allDocuments: true,
    });
    expect(own.kind).toBe("checked");
    calls.length = 0;
    const checked = structured<Checked>(await check(agent, mindId));
    expect(checked).toMatchObject({ status: "checked", supported: 0, needLook: 3 });
    expect(
      checked.claims.map(({ result, reason, says, document, quote, cite }) => [
        result,
        reason,
        says,
        document,
        quote,
        cite,
      ]),
    ).toEqual(Array(3).fill(["not-checked", "beyond-reach", null, null, null, null]));
    expect(calls).toEqual([]);
  });

  // protects=an agent can't spend the User's model on, or mark, a Note that isn't its own, and one that may only read checks nothing; fails_when=check_mind runs on the User's own Note or for a read-only pairing
  it("is refused on a Note it didn't write, and for an agent that may only read", async () => {
    const { core, agent, coast } = await paired();
    const own = await core.createMind({ title: "My own", folderId: coast.id });
    expect(refusal(await check(agent, own.id))).toBe(
      "check_mind checks a note this agent wrote with create_mind. It didn’t write this one.",
    );
    expect(refusal(await check(agent, "no-such-note"))).toContain("No such passage");

    const reader = await paired({ propose: false });
    const theirs = await reader.core.createMind({ title: "Theirs", folderId: reader.coast.id });
    expect(refusal(await check(reader.agent, theirs.id))).toContain("This agent may only read.");
  });
});
