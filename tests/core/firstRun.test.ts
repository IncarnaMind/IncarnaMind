import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  type Core,
  EXAMPLE_GROUPS,
  type ExampleGroup,
  InvalidInputError,
  type UsageDataSender,
  type UsageEventMessage,
  WORK_KINDS,
} from "../../src/core";
import { EXAMPLE_SETS } from "../../src/core/exampleSets";
import { createTempDataFolder, startCore } from "../helpers/core";

/** The example Documents the app ships. */
const EXAMPLES = resolve(__dirname, "../../resources/examples");

type Options = { setupOnFirstRun?: boolean; usageData?: UsageDataSender; examples?: boolean };

const startOn = (dataDir: string, { examples = true, ...rest }: Options = {}) =>
  startCore(dataDir, {
    paths: { dataDir, ...(examples && { examples: EXAMPLES }) },
    ...rest,
  });

async function fresh(options: Options = {}) {
  const dataDir = await createTempDataFolder();
  return { core: startOn(dataDir, options), dataDir };
}

/** A sender that records what reaches it: through usage data, or once by itself. */
function fakeSender({ testerBuild = false } = {}) {
  const sent: UsageEventMessage[] = [];
  const once: UsageEventMessage[] = [];
  const switched: boolean[] = [];
  const sender: UsageDataSender = {
    service: { id: "https://analytics.example.com", name: "PostHog (analytics.example.com)" },
    testerBuild,
    appVersion: "1.2.3",
    setEnabled: (enabled) => {
      switched.push(enabled);
    },
    capture: (message) => {
      sent.push(message);
    },
    captureOnce: (message) => {
      once.push(message);
    },
  };
  const picks = () => [...sent, ...once].filter((message) => message.event === "work_picked");
  return { sender, sent, once, switched, picks };
}

const titleOf = (group: ExampleGroup) => EXAMPLE_SETS[group].en.title;

async function madeGroups(core: Core): Promise<ExampleGroup[]> {
  const all = await Promise.all(EXAMPLE_GROUPS.map((group) => core.getExamples(group)));
  return all.flatMap((each, index) => (each.mindId ? [EXAMPLE_GROUPS[index] as ExampleGroup] : []));
}

describe("the first run's setup: when it shows (#3296)", { timeout: 30_000 }, () => {
  test("a fresh profile shows it, with every kind of work once and Something else last", async () => {
    const { core } = await fresh();
    const setup = await core.firstRunSetup();
    expect(setup.show).toBe(true);
    if (!setup.show) return;
    expect([...setup.workOrder].sort()).toEqual([...WORK_KINDS].sort());
    expect(setup.workOrder.at(-1)).toBe("other");
  });

  test("the order is picked once per install and kept across launches", async () => {
    const dataDir = await createTempDataFolder();
    const first = startOn(dataDir);
    const before = await first.firstRunSetup();
    first.close();
    const again = await startOn(dataDir).firstRunSetup();
    expect(again).toEqual(before);
  });

  test("asking consumes nothing: no example is made, and a setup left halfway shows again", async () => {
    const dataDir = await createTempDataFolder();
    const first = startOn(dataDir);
    expect((await first.firstRunSetup()).show).toBe(true);
    // The model steps save as they go; quitting before the end still leaves the setup to come.
    await first.updateSettings({ device: { transcriptionRoute: "local" } });
    expect(await madeGroups(first)).toEqual([]);
    expect((await first.listMinds()).length).toBe(0);
    first.close();
    const again = startOn(dataDir);
    expect((await again.firstRunSetup()).show).toBe(true);
    expect((await again.getSettings()).device).toMatchObject({ setupFinished: false, work: [] });
  });

  test("it never shows once finished, nor on a profile with a Note, opened before, or offered the examples", async () => {
    const finished = await fresh();
    await finished.core.finishFirstRunSetup([]);
    expect(await finished.core.firstRunSetup()).toEqual({ show: false });

    const withNote = await fresh();
    await withNote.core.createMind({ title: "Mine" });
    expect(await withNote.core.firstRunSetup()).toEqual({ show: false });

    const openedBefore = await fresh();
    await openedBefore.core.updateSettings({ device: { openedBefore: true } });
    expect(await openedBefore.core.firstRunSetup()).toEqual({ show: false });

    const offered = await fresh();
    await offered.core.offerExamples();
    expect(await offered.core.firstRunSetup()).toEqual({ show: false });
  });

  test("a copy with no examples, or a host that doesn't offer it, never shows it", async () => {
    const none = await fresh({ examples: false });
    expect(await none.core.firstRunSetup()).toEqual({ show: false });
    const notOffered = await fresh({ setupOnFirstRun: false });
    expect(await notOffered.core.firstRunSetup()).toEqual({ show: false });
  });
});

describe("the first run's setup: what finishing makes (#3296)", { timeout: 60_000 }, () => {
  test("two picks: the first pick's example is made and returned, the other's too", async () => {
    const { core } = await fresh();
    const lead = await core.finishFirstRunSetup(["legal", "research"]);
    expect(lead?.group).toBe("contracts");
    expect(lead?.mindId).toBeTruthy();
    expect((await madeGroups(core)).sort()).toEqual(["contracts", "papers"]);
    const titles = (await core.listMinds()).map((mind) => mind.title).sort();
    expect(titles).toEqual([titleOf("contracts"), titleOf("papers")].sort());
    expect((await core.getSettings()).device).toMatchObject({
      work: ["legal", "research"],
      setupFinished: true,
    });
  });

  test("nothing picked, or Something else, makes the credit paper alone", async () => {
    const skipped = await fresh();
    expect((await skipped.core.finishFirstRunSetup([]))?.group).toBe("credit");
    expect(await madeGroups(skipped.core)).toEqual(["credit"]);
    const other = await fresh();
    expect((await other.core.finishFirstRunSetup(["other"]))?.group).toBe("credit");
    expect(await madeGroups(other.core)).toEqual(["credit"]);
  });

  test("finance and Something else lead to one credit paper, made once", async () => {
    const { core } = await fresh();
    await core.finishFirstRunSetup(["reports", "finance"]);
    expect((await madeGroups(core)).sort()).toEqual(["credit", "reports"]);
  });

  test("Something else beside another pick is kept, and the first pick still leads", async () => {
    const { core } = await fresh();
    expect((await core.finishFirstRunSetup(["legal", "other"]))?.group).toBe("contracts");
    expect((await madeGroups(core)).sort()).toEqual(["contracts", "credit"]);
    expect((await core.getSettings()).device.work).toEqual(["legal", "other"]);
  });

  test("only the setup's own kinds are kept, each kind once", async () => {
    const { core } = await fresh();
    for (const work of [["legal", "legal"], ["tax"], "legal"]) {
      await expect(core.finishFirstRunSetup(work as never)).rejects.toThrow(InvalidInputError);
    }
    expect((await core.firstRunSetup()).show).toBe(true);
    expect(await madeGroups(core)).toEqual([]);
  });

  test("the credit paper's ready Question is the card's only while that example leads", async () => {
    const credit = await fresh();
    await credit.core.finishFirstRunSetup(["finance", "legal"]);
    await expect
      .poll(async () => (await credit.core.readyQuestion())?.ready?.question ?? null)
      .not.toBeNull();
    const legal = await fresh();
    await legal.core.finishFirstRunSetup(["legal", "finance"]);
    expect((await legal.core.readyQuestion())?.ready ?? null).toBeNull();
  });
});

describe("the first run's picks as usage data (#3296)", { timeout: 30_000 }, () => {
  test("Send and continue in a release build sends the picks once, holding only flags, and turns nothing on", async () => {
    const { sender, sent, once, switched, picks } = fakeSender();
    const { core } = await fresh({ usageData: sender });
    expect(await core.sendWorkPicked(["meetings", "legal"])).toBe(true);
    expect(sent).toEqual([]);
    expect(once).toHaveLength(1);
    expect(picks()[0]?.properties).toEqual({
      finance: false,
      legal: true,
      research: false,
      reports: false,
      meetings: true,
      other: false,
      app_version: "1.2.3",
      os: expect.stringMatching(/^(darwin|win32|linux|other)$/),
      arch: expect.stringMatching(/^(arm64|x64|other)$/),
      build: "release",
    });
    // Usage data stays off, and still asks later.
    expect(switched).not.toContain(true);
    expect((await core.getPrivacySettings()).usageData).toMatchObject({
      enabled: false,
      asked: false,
    });
    await core.createMind();
    expect([...sent, ...once].map((message) => message.event)).toEqual(["work_picked"]);
  });

  test("the picks go once per install: never again, in this launch or the next", async () => {
    const dataDir = await createTempDataFolder();
    const first = fakeSender();
    const core = startOn(dataDir, { usageData: first.sender });
    expect(await core.firstRunSetup()).toMatchObject({ show: true, picksSent: false });
    expect(await core.sendWorkPicked(["legal"])).toBe(true);
    expect(await core.sendWorkPicked(["finance", "research"])).toBe(false);
    expect(first.picks()).toHaveLength(1);
    core.close();

    const second = fakeSender({ testerBuild: true });
    const again = startOn(dataDir, { usageData: second.sender });
    expect(await again.firstRunSetup()).toMatchObject({ show: true, picksSent: true });
    expect(await again.sendWorkPicked(["legal"])).toBe(false);
    expect(second.picks()).toEqual([]);
  });

  test("a tester build sends them with its usage data while that is on", async () => {
    const { sender, sent, once, picks } = fakeSender({ testerBuild: true });
    const { core } = await fresh({ usageData: sender });
    expect(await core.sendWorkPicked(["research"])).toBe(true);
    expect(once).toEqual([]);
    expect(sent.map((message) => message.event)).toContain("work_picked");
    expect(picks()[0]?.properties).toMatchObject({ research: true, build: "tester" });
  });

  test("never in Local mode, never from a copy that can't send, and only the setup's kinds", async () => {
    const local = fakeSender();
    const { core } = await fresh({ usageData: local.sender });
    await core.setLocalOnly(true);
    expect(await core.sendWorkPicked(["legal"])).toBe(false);
    expect(local.picks()).toEqual([]);

    const noSender = await fresh();
    expect(await noSender.core.sendWorkPicked(["legal"])).toBe(false);

    const strict = fakeSender();
    const checked = await fresh({ usageData: strict.sender });
    for (const work of [[], ["My tax return.pdf"]]) {
      await expect(checked.core.sendWorkPicked(work as never)).rejects.toThrow(InvalidInputError);
    }
    expect(strict.picks()).toEqual([]);
  });

  test("finishing the setup, or skipping it, sends nothing", async () => {
    const { sender, picks } = fakeSender();
    const { core } = await fresh({ usageData: sender });
    await core.finishFirstRunSetup(["finance", "meetings"]);
    const skipped = fakeSender();
    const other = await fresh({ usageData: skipped.sender });
    await other.core.finishFirstRunSetup([]);
    expect([...picks(), ...skipped.picks()]).toEqual([]);
  });
});
