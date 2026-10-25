import { describe, expect, onTestFinished, test } from "vitest";
import { type Core, connectorDirectoryGroups } from "../../src/core";
import { connectorDirectory } from "../../src/core/connectors/directory";
import { waitForState } from "../helpers/connectors";
import { createMemoryKeychain, createTempDataFolder, startCore } from "../helpers/core";
import {
  createFakeBrowser,
  MANUAL_CLIENT_ID,
  MANUAL_CLIENT_SECRET,
  startFakeRemote,
} from "../helpers/remoteMcp";

/** A directory entry in its JSON form, as directory.json lists them. */
const entry = (fields: Record<string, unknown> = {}) => ({
  id: "wiki",
  name: "Wiki",
  publisher: "Wiki Inc.",
  group: "work",
  summary: { en: "Search the team wiki", "zh-CN": "搜索团队维基" },
  subscription: null,
  url: "https://mcp.wiki.example/mcp",
  signIn: "browser",
  ...fields,
});

/** A core whose directory lists the fake service, with a fake browser. */
async function setUp(fields: Record<string, unknown> = {}) {
  const fake = await startFakeRemote();
  onTestFinished(() => fake.close());
  const browser = createFakeBrowser(fake);
  const core: Core = startCore(await createTempDataFolder(), {
    keychain: createMemoryKeychain(),
    browser,
    connectorDirectory: [entry({ url: fake.url, ...fields })],
  });
  return { core, fake, browser };
}

describe("The directory that ships with the app", () => {
  test("lists each entry once, in a known group, with its words in English and Chinese and an https URL", () => {
    const entries = connectorDirectory();

    expect(entries.length).toBeGreaterThan(0);
    for (const each of entries) {
      expect(connectorDirectoryGroups).toContain(each.group);
      expect(each.summary.en.trim()).not.toBe("");
      expect(each.summary["zh-CN"].trim()).not.toBe("");
      expect(new URL(each.url).protocol).toBe("https:");
    }
    expect(new Set(entries.map((each) => each.id)).size).toBe(entries.length);
    // Led by where the User's files are, as Browse shows it.
    expect(entries[0]?.group).toBe("files");
    // A service that lists its Tools without a sign-in has them reviewed, to show before connecting.
    expect(entries.find((each) => each.id === "pubmed")?.tools?.[0]).toEqual({
      title: { en: "Search articles", "zh-CN": "搜索文章" },
      changes: false,
    });
  });

  test("refuses a broken list, naming what is wrong", () => {
    expect(() => connectorDirectory([entry({ group: "games" })])).toThrow(/unknown group: games/);
    expect(() => connectorDirectory([entry({ summary: { en: "Wiki" } })])).toThrow(/zh-CN/);
    expect(() => connectorDirectory([entry({ url: "http://mcp.wiki.example/mcp" })])).toThrow(
      /https/,
    );
    expect(() => connectorDirectory([entry({ signIn: "password" })])).toThrow(/unknown sign-in/);
    expect(() =>
      connectorDirectory([entry(), entry({ url: "https://other.example/mcp" })]),
    ).toThrow(/Two Connector directory entries have the id "wiki"/);
    expect(() => connectorDirectory({ wiki: entry() })).toThrow(/must be a list/);
    expect(() =>
      connectorDirectory([entry({ tools: [{ title: { en: "Search", "zh-CN": "搜索" } }] })]),
    ).toThrow(/must say whether it changes things/);
  });
});

describe("Connecting from the directory", { timeout: 30_000 }, () => {
  test("adds the service as a remote Connector named as it is, at its URL, which then signs in in the browser", async () => {
    const { core, fake, browser } = await setUp();

    expect(await core.listConnectorDirectory()).toEqual([
      expect.objectContaining({ id: "wiki", name: "Wiki", url: fake.url }),
    ]);
    const added = await core.addConnectorFromDirectory("wiki");

    expect(added).toMatchObject({ name: "Wiki", transport: "http", url: fake.url, enabled: true });
    await waitForState(core, added.id, "needs-sign-in");
    // Nothing opens until the sign-in starts, which Connect does next.
    expect(browser.opened).toEqual([]);
    const result = await core.signInToConnector(added.id);
    expect(result).toMatchObject({ ok: true, connector: { id: added.id, state: "ready" } });
    expect(browser.opened).toHaveLength(1);
  });

  test("connecting an entry again gives the Connector already at its URL, turned on", async () => {
    const { core } = await setUp();
    const first = await core.addConnectorFromDirectory("wiki");
    await core.setConnectorEnabled(first.id, false);

    const again = await core.addConnectorFromDirectory("wiki");

    expect(again).toMatchObject({ id: first.id, enabled: true });
    expect(await core.listConnectors()).toHaveLength(1);
  });

  test("an entry that needs the User's own app is added with its client ID", async () => {
    const { core, fake } = await setUp({ signIn: "own-app" });
    fake.dynamicRegistration = false;

    const added = await core.addConnectorFromDirectory("wiki", {
      clientId: MANUAL_CLIENT_ID,
      clientSecret: MANUAL_CLIENT_SECRET,
    });

    expect(added).toMatchObject({ clientId: MANUAL_CLIENT_ID });
    const result = await core.signInToConnector(added.id);
    expect(result).toMatchObject({ ok: true });
    expect(fake.authorizeRequests[0]?.client_id).toBe(MANUAL_CLIENT_ID);
  });

  test("an id the directory doesn't have is refused", async () => {
    const { core } = await setUp();

    await expect(core.addConnectorFromDirectory("nothing")).rejects.toThrow(
      "That Connector isn’t in the directory.",
    );
    expect(await core.listConnectors()).toEqual([]);
  });
});
