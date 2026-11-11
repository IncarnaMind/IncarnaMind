/**
 * The assistant's Organize with no Folder named, outside every wall, plans the Documents as the
 * Library's Organize does, at any size (#1569). A plan over $1 proposes nothing and says where the
 * User starts it; a model that can't name Folders sorts into those there are, one by one. Through
 * the command's own check and run, on a real core, with the host's Organize scripted.
 */
import { describe, expect, test } from "vitest";
import type { OrganizeLibraryResult } from "../../src/core";
import type { Findable } from "../../src/core/tools/commands/find";
import { organizeChecker } from "../../src/core/tools/commands/organize";
import { type CommandsHost, parseCommandInput } from "../../src/core/tools/commands/run";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";

const NOTHING: Findable = {
  documents: [],
  minds: [],
  library: { groups: [], assignments: [] },
  tags: [],
  deleted: [],
};

/** A host whose plan returns `planned`, recording which Organize ran. */
async function setUp(planned: OrganizeLibraryResult | null) {
  const core = startCore(await createTempDataFolder());
  const sources = await createSourceFolder();
  const documents = await addAndProcess(core, [
    await writeSourceFile(sources, "Lease Harbour Street.md", "The rent is 900 euros a month."),
    await writeSourceFile(sources, "Lease Mill Lane.md", "The tenant pays rent quarterly."),
  ]);
  const ran: string[] = [];
  const host = {
    core,
    organizeByPlan: async (ids: readonly string[]) => {
      ran.push(`plan ${ids.length}`);
      return planned;
    },
    organizeAtOnce: async (ids: readonly string[]) => {
      ran.push(`one by one ${ids.length}`);
      return { failed: null, untouched: 0, tagChanges: [] };
    },
    proposeFolder: () => null,
    withdrawOrganizeRun: () => ({ before: [], after: [] }),
    offeredOrganizeModel: async () => null,
    localOnly: () => false,
  } as unknown as CommandsHost;
  const organize = async (input: Record<string, unknown>, wallId: string | null = null) => {
    const checked = await organizeChecker(
      parseCommandInput({ command: "documents.organize", ...input }),
      host,
      { wallId, filing: () => null, findable: async () => NOTHING },
    );
    return checked.run(null, new AbortController().signal);
  };
  return { core, documents, ran, organize };
}

describe("The assistant's Organize with no Folder named (#1569)", () => {
  // protects=what else the User asked, as an Organize call names it, is one line of at most 200 characters (#1569); fails_when=a long or many-line request reaches the model or the reply whole; no_claim=how it is shown.
  test("what else the User asked is one line of at most 200 characters", () => {
    const named = (alsoAsked: unknown) =>
      parseCommandInput({ command: "documents.organize", alsoAsked }).alsoAsked;

    expect(named("  tell me\n\nthe rent\tat  Harbour Street ")).toBe(
      "tell me the rent at Harbour Street",
    );
    expect(named("  \n ")).toBeNull();
    const long = named(`tell me the rents ${"0123456789".repeat(30)}`);
    expect(long).toHaveLength(200);
    expect(long?.startsWith("tell me the rents 0123456789")).toBe(true);
    expect(long?.endsWith("…")).toBe(true);
    expect(named(`tell me ${"the rent and ".repeat(40)}`)?.length).toBeLessThanOrEqual(200);
  });

  test("a plan estimated over $1 proposes nothing and says what it would cost and where to start it", async () => {
    const { core, ran, organize } = await setUp({
      status: "estimate",
      estimate: {
        billing: "per-token",
        providerId: "provider-1",
        calls: 3,
        tokens: 420_000,
        cost: { amount: 1.26, currency: "USD" },
        spentTowardCap: null,
        setAsideTowardCap: null,
        cap: null,
      },
    });

    const result = await organize({});

    expect(ran).toEqual(["plan 2"]);
    expect(result.step).toBeNull();
    expect(result.done.items).toEqual([]);
    expect(result.said).toContain("about 1.26 USD");
    expect(result.said).toContain("start Organize from the Library");
    expect((await core.getOrganizeReview()).items).toEqual([]);
  });

  test("a model that can't name Folders sorts one by one, as with a Folder named or inside a wall", async () => {
    const plain = await setUp(null);
    await plain.organize({});
    expect(plain.ran).toEqual(["plan 2", "one by one 2"]);

    const named = await setUp(null);
    await named.organize({ folder: "Leases" });
    expect(named.ran).toEqual(["one by one 2"]);

    const walled = await setUp(null);
    await walled.organize({}, "a-walled-folder");
    expect(walled.ran).toEqual(["one by one 2"]);
  });
});

describe("The assistant's Organize asks where the Library's card would (#1569)", () => {
  const anthropic = { id: "https://api.anthropic.com", name: "Anthropic" };
  const checkedWith = async (localOnly: boolean) => {
    const core = startCore(await createTempDataFolder());
    const sources = await createSourceFolder();
    await addAndProcess(core, [
      await writeSourceFile(sources, "Lease Harbour Street.md", "The rent is 900 euros a month."),
    ]);
    const host = {
      core,
      offeredOrganizeModel: async () => ({
        classifier: { kind: "chat", choice: { providerId: "p", modelId: "haiku" } },
        route: { where: "cloud", service: anthropic },
      }),
      localOnly: () => localOnly,
    } as unknown as CommandsHost;
    return organizeChecker(parseCommandInput({ command: "documents.organize" }), host, {
      wallId: null,
      filing: () => null,
      findable: async () => NOTHING,
    });
  };

  // protects=a cloud service not yet allowed makes the assistant's card ask, and in Local mode nothing asks; fails_when=Local mode shows the card, or it never asks; no_claim=the run's own refusal.
  test("a cloud service not yet allowed asks, and in Local mode nothing asks", async () => {
    expect((await checkedWith(false)).cloud).toEqual(anthropic);
    const local = await checkedWith(true);
    expect(local.cloud).toBeUndefined();
    expect(local.cloudDeclined).toBeUndefined();
  });
});
