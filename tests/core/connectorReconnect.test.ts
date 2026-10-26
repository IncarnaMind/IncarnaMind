import { expect, onTestFinished, test, vi } from "vitest";
import { connectionFetch } from "../../src/core/connectors/remote";
import { waitForState } from "../helpers/connectors";
import {
  createMemoryKeychain,
  createTempDataFolder,
  queryDatabase,
  startCore,
} from "../helpers/core";
import { startHeaderMcp } from "../helpers/headerMcp";

test("a refused header is never sent again by a stale transport", async () => {
  const fetcher = vi.fn(async () => new Response("refused", { status: 403 }));
  const refused = vi.fn();
  const send = connectionFetch({
    url: "https://synthetic.example.test/mcp",
    headers: { "X-Key": "synthetic-device-key" },
    signal: new AbortController().signal,
    fetch: fetcher,
    check: () => {},
    opening: false,
    onKeyRefused: refused,
  });
  for (let index = 0; index < 8; index++) {
    await expect(send("https://synthetic.example.test/mcp")).rejects.toMatchObject({
      name: "KeyRefusedError",
    });
  }
  expect(fetcher).toHaveBeenCalledOnce();
  expect(refused).toHaveBeenCalledOnce();
});

test.each([
  { connection: "http", legacy: undefined },
  { connection: "sse", legacy: true },
  { connection: "http", legacy: 404 },
] as const)(
  "a ready $connection (legacy: $legacy) Connector stops at the first refused reconnect",
  async ({ connection, legacy }) => {
    const server = await startHeaderMcp({
      legacy,
      header: "X-Key",
      value: "synthetic-device-key",
    });
    onTestFinished(() => server.close());
    const core = startCore(await createTempDataFolder());
    const added = await core.addConnector({
      name: "Tides",
      url: server.url,
      connection,
      headers: { "X-Key": "synthetic-device-key" },
    });
    const ready = await waitForState(core, added.id, "ready");
    if (ready.transport !== "http") throw new Error("Expected a remote Connector.");
    await vi.waitFor(() => expect(server.activeStreams).toBe(1));
    const before = server.requests.length;
    server.setRefusal(403);
    server.dropStreams();
    await vi.waitFor(
      async () =>
        expect((await core.listConnectors()).find((it) => it.id === added.id)).toMatchObject({
          state: "error",
          connection: ready.connection,
          error: { kind: "key-refused", retrying: false },
          tools: null,
        }),
      { timeout: 15_000 },
    );
    expect(server.requests.slice(before)).toHaveLength(1);
    await vi.waitFor(() => expect(server.activeStreams).toBe(0));
  },
);

test("a down SSE server is unreachable rather than a generic restarting problem", async () => {
  const server = await startHeaderMcp({ legacy: true });
  await server.close();
  const core = startCore(await createTempDataFolder());
  const added = await core.addConnector({
    name: "Tides",
    url: server.url,
    connection: "sse",
    headers: { "X-Key": "synthetic-device-key" },
  });
  expect((await waitForState(core, added.id, "error")).error?.kind).toBe("unreachable");
});

test("rotation stores no device secret reference in the sync row", async () => {
  const dataDir = await createTempDataFolder();
  const keychain = createMemoryKeychain();
  const core = startCore(dataDir, { keychain });
  const added = await core.addConnector({
    name: "Tides",
    url: "http://127.0.0.1:9/mcp",
    headers: { "X-Key": "synthetic-device-key" },
  });
  await core.setConnectorHeaders(added.id, { "X-Key": "synthetic-new-key" });
  const row = queryDatabase<{ config: string }>(
    dataDir,
    "SELECT config FROM connectors WHERE id = ?",
    [added.id],
  )[0];
  expect(JSON.parse(row?.config ?? "null")).toEqual({
    url: "http://127.0.0.1:9/mcp",
    clientId: null,
    connection: "http",
    headers: ["X-Key"],
  });
  expect([...keychain.secrets.keys()].filter((name) => name.includes(":header:"))).toEqual([
    `connector:${added.id}:header:x-key`,
  ]);
});

test("a partial key write restores every original value and metadata before reconnecting", async () => {
  const headers = { "X-Key": "synthetic-original-key", "X-Tenant": "synthetic-original-tenant" };
  const server = await startHeaderMcp({ expectedHeaders: headers });
  onTestFinished(() => server.close());
  const dataDir = await createTempDataFolder();
  const keychain = createMemoryKeychain();
  const core = startCore(dataDir, { keychain });
  const added = await core.addConnector({ name: "Tides", url: server.url, headers });
  await waitForState(core, added.id, "ready");
  const before = queryDatabase(dataDir, "SELECT config, updated_at FROM connectors");
  const stored = keychain.set;
  const change = vi.spyOn(keychain, "set").mockImplementation(async (name, value) => {
    if (value === "synthetic-refused-write") throw new Error("Synthetic keychain write failure");
    await stored(name, value);
  });
  onTestFinished(() => change.mockRestore());
  await expect(
    core.setConnectorHeaders(added.id, {
      "X-Key": "synthetic-new-key",
      "X-Tenant": "synthetic-refused-write",
      "X-New": "synthetic-new-value",
    }),
  ).rejects.toThrow("Synthetic keychain write failure");
  await waitForState(core, added.id, "ready");
  expect(queryDatabase(dataDir, "SELECT config, updated_at FROM connectors")).toEqual(before);
  expect(keychain.secrets.get(`connector:${added.id}:header:x-key`)).toBe(headers["X-Key"]);
  expect(keychain.secrets.get(`connector:${added.id}:header:x-tenant`)).toBe(headers["X-Tenant"]);
  expect(keychain.secrets.has(`connector:${added.id}:header:x-new`)).toBe(false);
  expect(server.requests.every((request) => request.authenticated)).toBe(true);
});

test.each(["http", "sse"] as const)(
  "%s stream loss leaves ready and retries with the existing backoff and cap",
  async (connection) => {
    const server = await startHeaderMcp({ legacy: connection === "sse" ? true : undefined });
    onTestFinished(() => server.close());
    let failing = false;
    let attempts = 0;
    const core = startCore(await createTempDataFolder(), {
      connectorFetch: async (input, init) => {
        if (failing) {
          attempts++;
          throw new TypeError("fetch failed");
        }
        return fetch(input, init);
      },
    });
    const added = await core.addConnector({
      name: "Tides",
      url: server.url,
      connection,
      headers: { "X-Key": "synthetic-device-key" },
    });
    await waitForState(core, added.id, "ready");
    await vi.waitFor(() => expect(server.activeStreams).toBe(1));
    let ended = Promise.withResolvers<void>();
    core.on("connectors.changed", (list) => {
      if (list.find((it) => it.id === added.id)?.state === "error") ended.resolve();
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      failing = true;
      server.endStreams();
      await ended.promise;
      expect((await core.listConnectors()).find((it) => it.id === added.id)?.state).toBe("error");
      for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000]) {
        ended = Promise.withResolvers<void>();
        await vi.advanceTimersByTimeAsync(delay);
        await ended.promise;
      }
      expect(attempts).toBe(5);
      expect((await core.listConnectors()).find((it) => it.id === added.id)).toMatchObject({
        state: "error",
        tools: null,
        error: { kind: "unreachable", retrying: false },
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(attempts).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  },
);

test("Local mode toggling never resends a key already refused by a remote server", async () => {
  const server = await startHeaderMcp({ refusal: 401 });
  onTestFinished(() => server.close());
  const core = startCore(await createTempDataFolder(), {
    connectorFetch: async (_input, init) => fetch(server.url, init),
  });
  const added = await core.addConnector({
    name: "Tides",
    url: "https://synthetic.example.test/mcp",
    headers: { "X-Key": "synthetic-device-key" },
  });
  await waitForState(core, added.id, "error");
  const count = server.requests.length;
  await core.setLocalOnly(true);
  await core.setLocalOnly(false);
  expect((await core.listConnectors()).find((it) => it.id === added.id)?.error).toMatchObject({
    kind: "key-refused",
    retrying: false,
  });
  expect(server.requests).toHaveLength(count);
});
