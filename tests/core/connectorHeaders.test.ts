import { randomUUID } from "node:crypto";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import { createScrubber } from "../../src/main/crashScrubber";
import { askAndFinish } from "../helpers/citations";
import { waitForState } from "../helpers/connectors";
import {
  createMemoryKeychain,
  createTempDataFolder,
  queryDatabase,
  startCore,
} from "../helpers/core";
import { startHeaderMcp } from "../helpers/headerMcp";
import { connectToMind } from "../helpers/mindClient";
import { scriptedModel, scriptedModels } from "../helpers/models";

const planted = () => `test-${randomUUID()}`;

async function setup(options: Parameters<typeof startHeaderMcp>[0] = {}) {
  const server = await startHeaderMcp(options);
  onTestFinished(() => server.close());
  const dataDir = await createTempDataFolder();
  const keychain = createMemoryKeychain();
  const core = startCore(dataDir, { keychain });
  return { server, core, keychain, dataDir };
}

describe("Remote Connector keys and older connections", () => {
  test.each([false, true])(
    "one planted value stays out of preview, bridge events, logs, usage, exports, crash reports and all sync metadata (structured: %s)",
    async (structured) => {
      const secret = structured ? `${planted()}"\\` : planted();
      const server = await startHeaderMcp({
        header: "X-Key",
        value: secret,
        echo: `${"x".repeat(19_970)}${secret}`,
        structured,
      });
      onTestFinished(() => server.close());
      const outputs: unknown[] = [];
      const consoleError = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
        outputs.push(args);
      });
      onTestFinished(() => consoleError.mockRestore());
      const dataDir = await createTempDataFolder();
      const model = scriptedModel((call) =>
        call.results.length > 0
          ? { text: call.results.map((result) => result.text).join(" ") }
          : { calls: [{ tool: "tides__lookup", input: {} }] },
      );
      const record = (event: string, fields?: unknown) => {
        outputs.push({ event, fields });
      };
      const core = startCore(dataDir, {
        createChatModel: scriptedModels(model).createChatModel,
        log: { info: record, warn: record, error: record },
        usageData: {
          service: { id: "https://analytics.example.test", name: "Synthetic analytics" },
          testerBuild: false,
          appVersion: "1.0.0",
          setEnabled: () => {},
          capture: (message) => {
            outputs.push(message);
          },
        },
      });
      await core.updatePrivacySettings({ usageData: true });
      await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
      core.on("connectors.changed", (list) => outputs.push(list));
      const json = JSON.stringify({
        mcpServers: { Tides: { url: server.url, headers: { "X-Key": secret } } },
      });
      outputs.push(await core.previewConnectorImport(json));
      expect(server.requests).toHaveLength(0);
      const result = await core.importConnectors(json);
      outputs.push(result);
      const connector = result.added[0];
      if (!connector) throw new Error("No Connector was imported.");
      await waitForState(core, connector.id, "ready");
      const mind = await core.createMind({ title: "Synthetic tides" });
      const client = await connectToMind(core, mind.id);
      await askAndFinish(core, client, mind.id, "Look up the synthetic tide.");
      expect(server.toolCalls).toBe(1);
      const exported = new TextDecoder().decode(
        (await core.exportMind(mind.id, { format: "markdown" })).data,
      );
      expect(exported.includes(secret.slice(0, 12))).toBe(false);
      expect(exported.includes("redacted")).toBe(true);
      outputs.push(exported);
      server.setKey(planted());
      await core.restartConnector(connector.id);
      outputs.push(await waitForState(core, connector.id, "error"));
      server.setKey(secret);
      server.setFailure(500);
      await core.restartConnector(connector.id);
      outputs.push(await waitForState(core, connector.id, "error"));
      await core.setConnectorEnabled(connector.id, false);
      const scrubber = createScrubber({ homeDir: dataDir, dataDir });
      for (const item of [...outputs])
        outputs.push(scrubber.event({ type: undefined, message: JSON.stringify(item) }));
      const tables = queryDatabase<{ name: string }>(
        dataDir,
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      );
      for (const { name } of tables)
        outputs.push(queryDatabase(dataDir, `SELECT * FROM "${name}"`));
      expect(JSON.stringify(outputs).includes(secret)).toBe(false);
      expect(outputs.length).toBeGreaterThan(tables.length);
    },
  );

  test.each(["Authorization", "X-API-Key"])(
    "%s connects with the installed SDK, keeping only names and references in stored metadata",
    async (name) => {
      const secret = planted();
      const value = name === "Authorization" ? `Bearer ${secret}` : secret;
      const { core, server, keychain, dataDir } = await setup({
        header: name,
        value,
        echo: secret,
      });
      const events: unknown[] = [];
      core.on("connectors.changed", (value) => events.push(value));
      const added = await core.addConnector({
        name: "Tides",
        url: server.url,
        headers: { [name]: value },
      });
      const ready = await waitForState(core, added.id, "ready");
      expect(ready.tools).toMatchObject([{ name: "lookup", description: "[redacted]" }]);
      expect(server.requests.every((request) => request.authenticated)).toBe(true);
      expect([...keychain.secrets.values()].some((stored) => stored.includes(secret))).toBe(true);
      const stored = queryDatabase(dataDir, "SELECT * FROM connectors");
      expect(JSON.stringify([stored, events, await core.listConnectors()]).includes(secret)).toBe(
        false,
      );
    },
  );

  test.each([404, 405] as const)(
    "only the opening %s falls back to SSE and closes when disabled",
    async (status) => {
      const value = planted();
      const { core, server } = await setup({ legacy: status, header: "X-Key", value });
      const added = await core.addConnector({
        name: "Tides",
        url: server.url,
        headers: { "X-Key": value },
      });
      const ready = await waitForState(core, added.id, "ready");
      expect(ready).toMatchObject({ connection: "sse", headers: ["X-Key"] });
      expect(server.requests.slice(0, 2).map(({ method }) => method)).toEqual(["POST", "GET"]);
      expect(server.requests.every((request) => request.authenticated)).toBe(true);
      await core.setConnectorEnabled(added.id, false);
      await vi.waitFor(() => expect(server.activeStreams).toBe(0));
    },
  );

  test("explicit SSE imports directly, preserving header names and masking preview values", async () => {
    const value = planted();
    const { core, server } = await setup({ legacy: true, header: "X-Custom-Key", value });
    const json = JSON.stringify({
      mcpServers: { Tides: { type: "sse", url: server.url, headers: { "X-Custom-Key": value } } },
    });
    const preview = await core.previewConnectorImport(json);
    expect(preview).toMatchObject([
      { action: "add", connection: "sse", headers: ["X-Custom-Key"] },
    ]);
    expect(JSON.stringify(preview).includes(value)).toBe(false);
    const { added } = await core.importConnectors(json);
    const first = added[0];
    if (!first) throw new Error("Import added no Connector.");
    await waitForState(core, first.id, "ready");
    expect(server.requests[0]?.method).toBe("GET");
  });

  test("multiple imported headers retain their names and send their own secret values", async () => {
    const first = planted();
    const second = planted();
    const headers = { Authorization: `Bearer ${first}`, "X-Tenant-Key": second };
    const { core, server, dataDir } = await setup({ expectedHeaders: headers });
    const json = JSON.stringify({ mcpServers: { Tides: { url: server.url, headers } } });
    const preview = await core.previewConnectorImport(json);
    expect(preview[0]?.headers).toEqual(["Authorization", "X-Tenant-Key"]);
    const imported = await core.importConnectors(json);
    const connector = imported.added[0];
    if (!connector) throw new Error("No Connector was imported.");
    const ready = await waitForState(core, connector.id, "ready");
    expect(server.requests.every((request) => request.authenticated)).toBe(true);
    const outputs = JSON.stringify([
      preview,
      imported,
      ready,
      queryDatabase(dataDir, "SELECT * FROM connectors"),
    ]);
    expect(outputs.includes(first) || outputs.includes(second)).toBe(false);
  });

  test.each([
    { status: 401, connection: "http" },
    { status: 403, connection: "http" },
    { status: 401, connection: "sse" },
    { status: 403, connection: "sse" },
  ] as const)(
    "a refused key ($status, $connection) never discovers OAuth or retries another transport",
    async ({ status, connection }) => {
      const value = planted();
      const { core, server } = await setup({ refusal: status });
      const added = await core.addConnector({
        name: "Tides",
        url: server.url,
        headers: { Authorization: `Bearer ${value}` },
        connection,
      });
      const failed = await waitForState(core, added.id, "error");
      expect(failed.error).toMatchObject({ kind: "key-refused", retrying: false });
      expect(server.requests.map(({ method, path }) => [method, path])).toEqual([
        [connection === "http" ? "POST" : "GET", "/mcp"],
      ]);
      expect(JSON.stringify(failed).includes(value)).toBe(false);
    },
  );

  test("a tools/list 404 never switches transport", async () => {
    const { core, server } = await setup({ late404: true });
    const added = await core.addConnector({ name: "Tides", url: server.url });
    await waitForState(core, added.id, "error");
    expect(server.requests.some((request) => request.path === "/messages")).toBe(false);
    expect(server.toolCalls).toBe(0);
    await core.setConnectorEnabled(added.id, false);
  });

  test("a down server has a reachable retry action's error kind without disclosing request data", async () => {
    const { core, server } = await setup();
    await server.close();
    const added = await core.addConnector({
      name: "Tides",
      url: server.url,
      headers: { "X-Key": planted() },
    });
    expect((await waitForState(core, added.id, "error")).error?.kind).toBe("unreachable");
    await core.setConnectorEnabled(added.id, false);
  });

  test.each(["redirect", "endpoint"] as const)(
    "an unrelated origin's %s never receives a header or request",
    async (kind) => {
      const unrelated = await startHeaderMcp();
      onTestFinished(() => unrelated.close());
      const { core, server } = await setup(
        kind === "redirect"
          ? { redirect: unrelated.url }
          : { legacy: true, endpoint: unrelated.url },
      );
      const added = await core.addConnector({
        name: "Tides",
        url: server.url,
        headers: { "X-Key": planted() },
        ...(kind === "endpoint" ? { connection: "sse" as const } : {}),
      });
      await waitForState(core, added.id, "error");
      expect(unrelated.requests).toHaveLength(0);
      await core.setConnectorEnabled(added.id, false);
    },
  );

  test("rotating, removing, revoking and closing a key stop the old SSE socket", async () => {
    const value = planted();
    const { core, server, keychain } = await setup({ legacy: true, header: "X-Key", value });
    const added = await core.addConnector({
      name: "Tides",
      url: server.url,
      connection: "sse",
      headers: { "X-Key": value },
    });
    await waitForState(core, added.id, "ready");
    const next = planted();
    server.setKey(next);
    await core.setConnectorHeaders(added.id, { "X-Key": next });
    await waitForState(core, added.id, "ready");
    expect([...keychain.secrets.values()].some((stored) => stored.includes(value))).toBe(false);
    await core.revokeConsent("connectors", new URL(server.url).origin);
    await vi.waitFor(() => expect(server.activeStreams).toBe(0));
    const count = server.requests.length;
    await core.restartConnector(added.id);
    expect((await core.listConnectors()).find((each) => each.id === added.id)).toMatchObject({
      state: "connecting",
      error: null,
    });
    expect(server.requests).toHaveLength(count);
    await core.allowDataFlow("connectors", new URL(server.url).origin);
    await waitForState(core, added.id, "ready");
    await core.setConnectorHeaders(added.id, {});
    await vi.waitFor(() => expect(server.activeStreams).toBe(0));
    expect([...keychain.secrets.values()].some((stored) => stored.includes(next))).toBe(false);
    await core.close();
  });

  test("reopening without consent waits without requests or prompts, then resumes when allowed", async () => {
    const value = planted();
    const { core, server, keychain, dataDir } = await setup({
      legacy: true,
      header: "X-Key",
      value,
    });
    const added = await core.addConnector({
      name: "Tides",
      url: server.url,
      connection: "sse",
      headers: { "X-Key": value },
    });
    await waitForState(core, added.id, "ready");
    await core.revokeConsent("connectors", new URL(server.url).origin);
    await core.close();
    const count = server.requests.length;
    const restarted = startCore(dataDir, { keychain });
    await restarted.restartConnector(added.id);
    expect((await restarted.listConnectors()).find((each) => each.id === added.id)).toMatchObject({
      state: "connecting",
      error: null,
    });
    expect(await restarted.listConsentRequests()).toEqual([]);
    expect(server.requests).toHaveLength(count);
    await restarted.allowDataFlow("connectors", new URL(server.url).origin);
    await waitForState(restarted, added.id, "ready");
    expect(server.activeStreams).toBe(1);
  });

  test("unavailable key storage leaves the working SSE connection and key intact", async () => {
    const value = planted();
    const { core, server, keychain } = await setup({ legacy: true, header: "X-Key", value });
    const added = await core.addConnector({
      name: "Tides",
      url: server.url,
      connection: "sse",
      headers: { "X-Key": value },
    });
    await waitForState(core, added.id, "ready");
    const count = server.requests.length;
    const protection = vi.spyOn(keychain, "protection").mockReturnValue("unavailable");
    onTestFinished(() => protection.mockRestore());
    await expect(core.setConnectorHeaders(added.id, { "X-Key": planted() })).rejects.toMatchObject({
      name: "SecretStorageError",
    });
    expect((await core.listConnectors()).find((each) => each.id === added.id)?.state).toBe("ready");
    expect(server.activeStreams).toBe(1);
    expect(server.requests).toHaveLength(count);
    expect([...keychain.secrets.values()].some((stored) => stored.includes(value))).toBe(true);
  });

  test("unrelated consent changes do not retry a refused key", async () => {
    const { core, server } = await setup({ refusal: 401 });
    const added = await core.addConnector({
      name: "Tides",
      url: server.url,
      headers: { "X-Key": planted() },
    });
    await waitForState(core, added.id, "error");
    const count = server.requests.length;
    const revoked = await core.revokeConsent("chat", "https://example.test");
    if (revoked) await core.restoreConsent("chat", "https://example.test", revoked);
    await core.allowDataFlow("connectors", new URL(server.url).origin);
    expect((await core.listConnectors()).find((each) => each.id === added.id)?.error).toMatchObject(
      {
        kind: "key-refused",
        retrying: false,
      },
    );
    expect(server.requests).toHaveLength(count);
  });

  test("an unrelated consent change leaves the in-progress opening request alone", async () => {
    const server = await startHeaderMcp();
    onTestFinished(() => server.close());
    let entered = () => {};
    let release = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    onTestFinished(() => release());
    const signals: (AbortSignal | null | undefined)[] = [];
    const core = startCore(await createTempDataFolder(), {
      connectorFetch: async (input, init) => {
        signals.push(init?.signal);
        if (signals.length === 1) {
          entered();
          await waiting;
        }
        return fetch(input, init);
      },
    });
    const added = await core.addConnector({ name: "Tides", url: server.url });
    await started;
    await core.revokeConsent("chat", "https://example.test");
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    release();
    await waitForState(core, added.id, "ready");
  });

  test("closing and reopening loads device-only keys once, then deletion removes them and the socket", async () => {
    const value = planted();
    const { core, server, keychain, dataDir } = await setup({
      legacy: true,
      header: "X-Key",
      value,
    });
    const added = await core.addConnector({
      name: "Tides",
      url: server.url,
      connection: "sse",
      headers: { "X-Key": value },
    });
    await waitForState(core, added.id, "ready");
    await core.close();
    await vi.waitFor(() => expect(server.activeStreams).toBe(0));
    const restarted = startCore(dataDir, { keychain });
    await waitForState(restarted, added.id, "ready");
    expect(server.activeStreams).toBe(1);
    await restarted.deleteConnector(added.id);
    await vi.waitFor(() => expect(server.activeStreams).toBe(0));
    expect([...keychain.secrets.values()].some((stored) => stored.includes(value))).toBe(false);
    expect(await restarted.listConnectors()).toEqual([]);
  });

  test("malformed imported JSON and invalid headers never echo a secret", async () => {
    const { core } = await setup();
    const value = planted();
    for (const input of [
      `{"mcpServers":{"Tides":{"headers":{"X-Key":"${value}"}}`,
      JSON.stringify({
        mcpServers: {
          Tides: { url: "https://example.test/mcp", headers: { "X-Key": `${value}\n` } },
        },
      }),
    ]) {
      let result: unknown;
      try {
        result = await core.previewConnectorImport(input);
      } catch (error) {
        result = error instanceof Error ? error.message : String(error);
      }
      expect(JSON.stringify(result).includes(value)).toBe(false);
    }
  });

  test("overlapping key changes discard a superseded staged secret", async () => {
    const value = planted();
    const { core, server, keychain } = await setup({ header: "X-Key", value });
    const connector = await core.addConnector({
      name: "Tides",
      url: server.url,
      headers: { "X-Key": value },
    });
    await waitForState(core, connector.id, "ready");
    const earlier = planted();
    const latest = planted();
    const save = keychain.set;
    let release = () => {};
    let entered = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = vi.spyOn(keychain, "set").mockImplementation(async (name, value) => {
      if (value === earlier) {
        entered();
        await waiting;
      }
      return save(name, value);
    });
    onTestFinished(() => {
      release();
      spy.mockRestore();
    });
    const first = core.setConnectorHeaders(connector.id, { "X-Key": earlier });
    const settled = first.then(
      () => "saved",
      () => "superseded",
    );
    await started;
    server.setKey(latest);
    await core.setConnectorHeaders(connector.id, { "X-Key": latest });
    release();
    expect(await settled).toBe("superseded");
    await waitForState(core, connector.id, "ready");
    expect(
      [...keychain.secrets.values()].some(
        (stored) => stored.includes(earlier) || stored.includes(value),
      ),
    ).toBe(false);
    expect([...keychain.secrets.values()].some((stored) => stored.includes(latest))).toBe(true);
  });

  test("a key unavailable on this device never reaches the server, and entering a replacement restores it", async () => {
    const value = planted();
    const { core, server, dataDir } = await setup({ header: "X-Key", value });
    const connector = await core.addConnector({
      name: "Tides",
      url: server.url,
      headers: { "X-Key": value },
    });
    await waitForState(core, connector.id, "ready");
    await core.close();
    const count = server.requests.length;
    const restarted = startCore(dataDir, { keychain: createMemoryKeychain() });
    expect((await waitForState(restarted, connector.id, "error")).error).toMatchObject({
      kind: "missing-secrets",
      retrying: false,
    });
    expect(server.requests).toHaveLength(count);
    await restarted.setConnectorHeaders(connector.id, { "X-Key": value });
    await waitForState(restarted, connector.id, "ready");
  });

  test("Local mode sends zero requests, including when restarted, then resumes and stops an open stream", async () => {
    const value = planted();
    const server = await startHeaderMcp({ legacy: true, header: "X-Key", value });
    onTestFinished(() => server.close());
    const core = startCore(await createTempDataFolder(), {
      connectorFetch: async (input, init) => {
        const requested = new URL(input instanceof Request ? input.url : String(input));
        const local = new URL(server.url);
        requested.protocol = local.protocol;
        requested.hostname = local.hostname;
        requested.port = local.port;
        return fetch(requested, init);
      },
    });
    await core.setLocalOnly(true);
    const added = await core.addConnector({
      name: "Tides",
      url: "https://synthetic.example.test/mcp",
      connection: "sse",
      headers: { "X-Key": value },
    });
    await core.restartConnector(added.id);
    expect(server.requests).toEqual([]);
    await core.setLocalOnly(false);
    await waitForState(core, added.id, "ready");
    await core.setLocalOnly(true);
    await vi.waitFor(() => expect(server.activeStreams).toBe(0));
    const count = server.requests.length;
    await core.restartConnector(added.id);
    expect(server.requests).toHaveLength(count);
  });
});
