/**
 * What IncarnaMind leaves in the User's agents and database (#3430): the Skill it wrote, brought up
 * to the current text when a release changes it and taken away by Disconnect whichever release
 * wrote it, unless the User changed the file; and a disconnected agent's rows, deleted for good
 * once Recently deleted's days have passed. A release is a core started with that release's Skill
 * text; every path is in a temporary home folder.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { DATABASE_FILE } from "../../src/core";
import { EARLIER_SKILL_HASHES, SKILL_MARKDOWN } from "../../src/core/agents/skill";
import { RECENTLY_DELETED_DAYS } from "../../src/core/api";
import { openDatabase } from "../../src/core/storage";
import { agentsAdapter, buildAgentShim, connectLegacyAgent } from "../helpers/agents";
import {
  createMemoryKeychain,
  createTempDataFolder,
  manualClock,
  queryDatabase,
  startCore,
} from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { note, writeMind } from "../helpers/minds";
import { REPO_ROOT } from "../helpers/skills";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** What an earlier release wrote. */
const OLDER = `${SKILL_MARKDOWN}\nAn earlier release said this too.\n`;
const BRIEF = "\nAlso, be brief.\n";

const claudeFile = (home: string) => join(home, ".claude", "skills", "incarnamind", "SKILL.md");
const sharedFile = (home: string) => join(home, ".agents", "skills", "incarnamind", "SKILL.md");

type CoreHelpers = typeof import("../helpers/core");

/**
 * The core's test helpers as a build with this Skill text loads them. `known` are texts that
 * build lists as earlier ones, as a release lists those that went before its records.
 */
async function release(skill: string, known: readonly string[] = []): Promise<CoreHelpers> {
  vi.resetModules();
  vi.doMock("../../src/core/agents/skill", async (importOriginal) => {
    const real = await importOriginal<typeof import("../../src/core/agents/skill")>();
    return {
      ...real,
      SKILL_MARKDOWN: skill,
      EARLIER_SKILL_HASHES: [...real.EARLIER_SKILL_HASHES, ...known.map(sha256)],
    };
  });
  return import("../helpers/core");
}

interface Place {
  dataDir: string;
  home: string;
  tempDir: string;
  /** The agents' keys, which outlast a restart as the system's keychain does. */
  keychain: ReturnType<typeof createMemoryKeychain>;
}

async function place(): Promise<Place> {
  return {
    dataDir: await createTempDataFolder(),
    home: await createTempDataFolder(),
    tempDir: await createTempDataFolder(),
    keychain: createMemoryKeychain(),
  };
}

const open = ({ startCore: start }: CoreHelpers, at: Place) =>
  start(at.dataDir, {
    keychain: at.keychain,
    paths: {
      dataDir: at.dataDir,
      home: at.home,
      documents: join(at.dataDir, "Documents"),
      tempDir: at.tempDir,
    },
  });

const folderIn = (core: ReturnType<typeof open>) =>
  core.createLibraryGroup({ name: "Coast", description: "The sea." });

async function connected(
  core: ReturnType<typeof open>,
  clients: readonly ("claude-code" | "codex")[],
) {
  const coast = await folderIn(core);
  const pairings = [];
  for (const client of clients) {
    pairings.push((await core.setUpAgent({ client, folderIds: [coast.id] })).pairing);
  }
  return { coast, pairings };
}

describe("the Skill when a release changes its text", () => {
  it("is brought up to the current text when the app starts, in every folder IncarnaMind wrote it to", async () => {
    const at = await place();
    const earlier = open(await release(OLDER), at);
    const {
      pairings: [claude, codex],
    } = await connected(earlier, ["claude-code", "codex"]);
    expect(await readFile(claudeFile(at.home), "utf8")).toBe(OLDER);
    expect(await readFile(sharedFile(at.home), "utf8")).toBe(OLDER);
    earlier.close();

    const core = open(await release(SKILL_MARKDOWN), at);
    await vi.waitFor(async () => {
      expect(await readFile(claudeFile(at.home), "utf8")).toBe(SKILL_MARKDOWN);
      expect(await readFile(sharedFile(at.home), "utf8")).toBe(SKILL_MARKDOWN);
    });
    const agents = await core.getAgents();
    expect(agents.skills.toSorted()).toEqual([claude?.id, codex?.id].toSorted());
    expect(agents.skillsOutOfDate).toEqual([]);
  });

  it("leaves a copy the User changed, says it is out of date, and replaces it only when asked", async () => {
    const at = await place();
    const earlier = open(await release(OLDER), at);
    const {
      pairings: [claude, codex],
    } = await connected(earlier, ["claude-code", "codex"]);
    await writeFile(claudeFile(at.home), `${OLDER}${BRIEF}`);
    earlier.close();

    const core = open(await release(SKILL_MARKDOWN), at);
    await vi.waitFor(async () =>
      expect(await readFile(sharedFile(at.home), "utf8")).toBe(SKILL_MARKDOWN),
    );
    expect(await readFile(claudeFile(at.home), "utf8")).toBe(`${OLDER}${BRIEF}`);
    expect(await core.getAgents()).toMatchObject({
      skills: [codex?.id],
      skillsOutOfDate: [claude?.id],
    });

    const changes: string[][] = [];
    core.on("agents.changed", (settings) => changes.push(settings.skillsOutOfDate));
    await core.replaceAgentSkill(claude?.id ?? "");
    expect(await readFile(claudeFile(at.home), "utf8")).toBe(SKILL_MARKDOWN);
    expect(changes).toEqual([[]]);
    const agents = await core.getAgents();
    expect(agents.skills.toSorted()).toEqual([claude?.id, codex?.id].toSorted());
    expect(agents.skillsOutOfDate).toEqual([]);
  });

  it("is not out of date when the User changed a copy and IncarnaMind's text has not changed since", async () => {
    const at = await place();
    const core = open(await release(SKILL_MARKDOWN), at);
    const { coast } = await connected(core, ["claude-code"]);
    await writeFile(claudeFile(at.home), `${SKILL_MARKDOWN}${BRIEF}`);

    // Connecting another agent looks at every copy IncarnaMind wrote.
    await core.setUpAgent({ client: "codex", folderIds: [coast.id] });
    expect(await readFile(claudeFile(at.home), "utf8")).toBe(`${SKILL_MARKDOWN}${BRIEF}`);
    expect(await core.getAgents()).toMatchObject({ skillsOutOfDate: [] });
  });

  it("is brought up to the current text when an agent connects, in every folder IncarnaMind wrote it to", async () => {
    const at = await place();
    const earlier = open(await release(OLDER), at);
    const { coast } = await connected(earlier, ["claude-code"]);
    earlier.close();

    // The earlier text comes back after the app has started (a restored backup, a synced folder).
    const core = open(await release(SKILL_MARKDOWN, [OLDER]), at);
    await vi.waitFor(async () =>
      expect(await readFile(claudeFile(at.home), "utf8")).toBe(SKILL_MARKDOWN),
    );
    await writeFile(claudeFile(at.home), OLDER);
    await core.setUpAgent({ client: "codex", folderIds: [coast.id] });

    expect(await readFile(claudeFile(at.home), "utf8")).toBe(SKILL_MARKDOWN);
    expect(await readFile(sharedFile(at.home), "utf8")).toBe(SKILL_MARKDOWN);
  });

  it("is recognised as IncarnaMind's when an earlier release wrote it before there was a record", async () => {
    const at = await place();
    const core = open(await release(SKILL_MARKDOWN, [OLDER]), at);
    const coast = await folderIn(core);
    // Connected, with the Skill as a release that kept no record left it.
    const { pairing } = await core.connectAgent({
      name: "Claude Code",
      client: "claude-code",
      folderIds: [coast.id],
    });
    await mkdir(join(at.home, ".claude", "skills", "incarnamind"), { recursive: true });
    await writeFile(claudeFile(at.home), OLDER);
    core.close();

    const restarted = open(await release(SKILL_MARKDOWN, [OLDER]), at);
    await vi.waitFor(async () =>
      expect(await readFile(claudeFile(at.home), "utf8")).toBe(SKILL_MARKDOWN),
    );
    expect(await restarted.getAgents()).toMatchObject({
      skills: [pairing.id],
      skillsOutOfDate: [],
    });
  });

  it("leaves a file IncarnaMind never wrote as it is, and says nothing of it", async () => {
    const at = await place();
    const core = open(await release(SKILL_MARKDOWN, [OLDER]), at);
    const coast = await folderIn(core);
    await core.connectAgent({ name: "Claude Code", client: "claude-code", folderIds: [coast.id] });
    await mkdir(join(at.home, ".claude", "skills", "incarnamind"), { recursive: true });
    await writeFile(claudeFile(at.home), "My own notes on IncarnaMind.\n");

    await core.setUpAgent({ client: "codex", folderIds: [coast.id] });
    expect(await readFile(claudeFile(at.home), "utf8")).toBe("My own notes on IncarnaMind.\n");
    expect(await core.getAgents()).toMatchObject({ skillsOutOfDate: [] });
  });

  it("is recorded as it is when it is already current, so a later release can bring it up to date", async () => {
    const at = await place();
    const helpers = await release(SKILL_MARKDOWN);
    const core = open(helpers, at);
    const coast = await folderIn(core);
    await core.connectAgent({ name: "Claude Code", client: "claude-code", folderIds: [coast.id] });
    await mkdir(join(at.home, ".claude", "skills", "incarnamind"), { recursive: true });
    await writeFile(claudeFile(at.home), SKILL_MARKDOWN);
    core.close();

    const adopting = open(helpers, at);
    await vi.waitFor(() =>
      expect(
        queryDatabase(
          at.dataDir,
          "SELECT 1 FROM device_settings WHERE key = 'agentSkillFiles' AND deleted_at IS NULL",
        ),
      ).toHaveLength(1),
    );
    adopting.close();

    const next = `${SKILL_MARKDOWN}\nA later release adds this.\n`;
    open(await release(next), at);
    await vi.waitFor(async () => expect(await readFile(claudeFile(at.home), "utf8")).toBe(next));
  });

  it("lists the current text's hash, so a change to the Skill adds the new one", () => {
    // Fails when the Skill's text changes until its hash is added to EARLIER_SKILL_HASHES
    // (src/core/agents/skill.ts), so no copy of it goes unrecognised once a later text replaces it.
    expect(EARLIER_SKILL_HASHES).toContain(sha256(SKILL_MARKDOWN));
    expect(EARLIER_SKILL_HASHES.every((hash) => /^[0-9a-f]{64}$/.test(hash))).toBe(true);
    expect(new Set(EARLIER_SKILL_HASHES).size).toBe(EARLIER_SKILL_HASHES.length);
  });

  it("reads, writes and removes the Skill only through the host's files", async () => {
    const at = await place();
    const kept = new Map<string, string>();
    const core = startCore(at.dataDir, {
      keychain: at.keychain,
      paths: { home: at.home, tempDir: at.tempDir },
      agentSkillFiles: {
        read: (path) => kept.get(path) ?? null,
        write: async (path, text) => {
          kept.set(path, text);
        },
        remove: async (path) => {
          kept.delete(path);
        },
      },
    });
    const {
      pairings: [claude],
    } = await connected(core, ["claude-code"]);
    expect([...kept]).toEqual([[claudeFile(at.home), SKILL_MARKDOWN]]);
    // Claude Code's settings file is written (#3487), the Skill is not: no skills folder is made.
    expect(await readdir(at.home)).toEqual([".claude.json"]);
    expect((await core.getAgents()).skills).toEqual([claude?.id]);

    await core.disconnectAgent(claude?.id ?? "");
    expect(kept.size).toBe(0);
    expect(await readdir(at.home)).toEqual([]);
  });

  it("never writes outside the skills folders, whatever its record holds", async () => {
    const at = await place();
    const earlier = open(await release(OLDER), at);
    await connected(earlier, ["claude-code"]);
    earlier.close();
    const stray = join(at.home, ".ssh", "config");
    await mkdir(join(at.home, ".ssh"));
    await writeFile(stray, "Host *\n  ForwardAgent no\n");
    const db = openDatabase(join(at.dataDir, DATABASE_FILE));
    db.run("UPDATE device_settings SET value = ? WHERE key = 'agentSkillFiles'", [
      JSON.stringify({
        ".ssh/config": sha256("Host *\n  ForwardAgent no\n"),
        ".claude/skills/incarnamind/SKILL.md": sha256(OLDER),
      }),
    ]);
    db.close();

    open(await release(SKILL_MARKDOWN), at);
    await vi.waitFor(async () =>
      expect(await readFile(claudeFile(at.home), "utf8")).toBe(SKILL_MARKDOWN),
    );
    expect(await readFile(stray, "utf8")).toBe("Host *\n  ForwardAgent no\n");
  });
});

describe("Disconnect and the Skill", () => {
  it("takes it away whichever release wrote it, and leaves a copy the User changed, saying so", async () => {
    const at = await place();
    const core = open(await release(SKILL_MARKDOWN, [OLDER]), at);
    const {
      pairings: [claude, codex],
    } = await connected(core, ["claude-code", "codex"]);
    // As an earlier release left them: the text it wrote, and that text with a line the User added.
    await writeFile(claudeFile(at.home), OLDER);
    await writeFile(sharedFile(at.home), `${OLDER}${BRIEF}`);

    expect(await core.disconnectAgent(claude?.id ?? "")).toEqual({ skillsLeft: [] });
    await expect(stat(claudeFile(at.home))).rejects.toThrow(/ENOENT/);
    await expect(stat(join(at.home, ".claude", "skills", "incarnamind"))).rejects.toThrow(/ENOENT/);

    expect(await core.disconnectAgent(codex?.id ?? "")).toEqual({
      skillsLeft: [
        {
          path: sharedFile(at.home),
          shown: join("~", ".agents", "skills", "incarnamind", "SKILL.md"),
        },
      ],
    });
    expect(await readFile(sharedFile(at.home), "utf8")).toBe(`${OLDER}${BRIEF}`);
  });

  it("takes away a copy brought up to date by a later release", async () => {
    const at = await place();
    const earlier = open(await release(OLDER), at);
    const {
      pairings: [claude],
    } = await connected(earlier, ["claude-code"]);
    earlier.close();

    const core = open(await release(SKILL_MARKDOWN), at);
    await vi.waitFor(async () =>
      expect(await readFile(claudeFile(at.home), "utf8")).toBe(SKILL_MARKDOWN),
    );
    expect(await core.disconnectAgent(claude?.id ?? "")).toEqual({ skillsLeft: [] });
    await expect(stat(claudeFile(at.home))).rejects.toThrow(/ENOENT/);
  });
});

describe("a disconnected agent's rows", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const OVERSTATED = "Fuel cost doubled over the year.";

  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  it(`are deleted for good ${RECENTLY_DELETED_DAYS} days after Disconnect, at the next start, and not before`, async () => {
    const dataDir = await createTempDataFolder();
    const clock = manualClock();
    const adapters = { agents: await agentsAdapter(dataDir), now: clock.now };
    let core = startCore(dataDir, adapters);
    await core.setAgentsEnabled(true);
    const coast = await core.createLibraryGroup({ name: "Coast", description: "The sea." });
    const mind = await core.createMind({ title: "Ferry report", folderId: coast.id });
    writeMind(await connectToMind(core, mind.id), [note(OVERSTATED)]);
    // What an agent read (its call) and what the User asked it (a request, whose text holds a sentence).
    const used = async (name: string) => {
      const { launch, pairing } = await core.connectAgent({ name, folderIds: [coast.id] });
      const agent = await connectLegacyAgent(launch);
      await agent.callTool({ name: "search", arguments: { query: "spring tides" } });
      await agent.close();
      await core.askAgent({
        pairingId: pairing.id,
        mindId: mind.id,
        ask: {
          kind: "fix",
          sentences: [{ sentence: OVERSTATED, verdict: "overstated", checkId: "check-1" }],
        },
      });
      return pairing.id;
    };
    const owners = (table: "agent_activity" | "agent_requests") =>
      queryDatabase<{ pairing_id: string }>(dataDir, `SELECT DISTINCT pairing_id FROM ${table}`)
        .map((row) => row.pairing_id)
        .toSorted();
    const bothOwnedBy = (...ids: string[]) => {
      expect(owners("agent_activity")).toEqual(ids.toSorted());
      expect(owners("agent_requests")).toEqual(ids.toSorted());
    };
    const restart = () => {
      core.close();
      core = startCore(dataDir, adapters);
    };

    const stays = await used("Stays");
    const first = await used("First");
    await core.disconnectAgent(first);
    clock.advance(20 * DAY);
    const second = await used("Second");
    await core.disconnectAgent(second);
    bothOwnedBy(stays, first, second);

    // The first one's rows are 29 days old: still there, marked deleted, and not in its list.
    clock.advance(9 * DAY);
    restart();
    bothOwnedBy(stays, first, second);
    for (const table of ["agent_activity", "agent_requests"]) {
      expect(
        queryDatabase(
          dataDir,
          `SELECT 1 FROM ${table} WHERE pairing_id = ? AND deleted_at IS NULL`,
          [first],
        ),
      ).toEqual([]);
    }

    // 31 days old: gone. The second one's, 11 days old, stay.
    clock.advance(2 * DAY);
    restart();
    bothOwnedBy(stays, second);

    clock.advance(20 * DAY);
    restart();
    bothOwnedBy(stays);
    expect(await core.listAgentActivity(stays)).toHaveLength(1);
  });
});

describe("the Skill's file in the repository (#3644)", () => {
  // protects=skills/incarnamind/SKILL.md, where a directory of Skills reads it, is the text IncarnaMind installs; fails_when=the Skill changes and the file in the repository keeps an older text
  it("is the text IncarnaMind installs", async () => {
    const file = await readFile(join(REPO_ROOT, "skills", "incarnamind", "SKILL.md"), "utf8");
    expect(file).toBe(SKILL_MARKDOWN);
  });
});
