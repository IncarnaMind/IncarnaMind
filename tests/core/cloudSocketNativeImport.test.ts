import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

// Node imports the socket module itself, as the transcription process does once built (#1233):
// no bundler's interop. A WebSocket server on this computer, made by hand, takes its upgrade and
// answers one message, so the key's header and both directions are seen working with no network.
const RUN = `
  import { createHash } from "node:crypto";
  import { createServer } from "node:http";
  const { connectWebSocket } = await import("./src/core/transcription/cloud/socket.ts");
  const seen = {};
  const frame = (text) => {
    const body = Buffer.from(text);
    return Buffer.concat([Buffer.from([0x81, body.length]), body]);
  };
  const server = createServer();
  server.on("upgrade", (request, socket) => {
    seen.authorization = request.headers.authorization;
    const accept = createHash("sha1")
      .update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n" +
        "Sec-WebSocket-Accept: " + accept + "\\r\\n\\r\\n",
    );
    socket.on("data", (data) => {
      const length = data[1] & 0x7f;
      const mask = data.subarray(2, 6);
      const text = Buffer.from(data.subarray(6, 6 + length).map((byte, i) => byte ^ mask[i % 4])).toString();
      if (text === "hello") socket.write(frame("world"));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = "ws://127.0.0.1:" + server.address().port + "/";
  await new Promise((resolve) => {
    const socket = connectWebSocket(url, "test-key", {
      open: () => socket.send("hello"),
      message: (text) => {
        seen.message = text;
        socket.close();
        resolve();
      },
      closed: () => resolve(),
    });
  });
  console.log(JSON.stringify(seen));
  // The upgraded connection keeps the process alive: end it once it has spoken.
  process.exit(0);
`;

// A service that turns the key away at the handshake (Qwen's does, with HTTP 401) says nothing a
// WebSocket can read: the module asks it once more, over HTTP, before it calls the key refused.
const REFUSED = `
  import { createServer } from "node:http";
  const { connectWebSocket, HANDSHAKE_REFUSED } = await import("./src/core/transcription/cloud/socket.ts");
  const closedWith = (status) =>
    new Promise((resolve) => {
      const server = createServer((request, response) => {
        response.writeHead(request.headers.authorization === "Bearer good" ? 400 : status);
        response.end();
      });
      server.on("upgrade", (request, socket) => {
        socket.write("HTTP/1.1 " + (request.headers.authorization === "Bearer good" ? 400 : status) + " X\\r\\n\\r\\n");
        socket.destroy();
      });
      server.listen(0, "127.0.0.1", () => {
        const url = "ws://127.0.0.1:" + server.address().port + "/api-ws/v1/inference";
        connectWebSocket(url, status === 401 ? "wrong" : "good", {
          open: () => resolve("opened"),
          message: () => {},
          closed: (code) => resolve(code === HANDSHAKE_REFUSED ? "refused" : "closed " + code),
        });
      });
    });
  console.log(JSON.stringify({ wrong: await closedWith(401), other: await closedWith(503) }));
  process.exit(0);
`;

test("a key turned away at the handshake is told from a connection that failed", {
  timeout: 60_000,
}, () => {
  const output = execFileSync(
    process.execPath,
    [
      "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      "--import",
      "./scripts/tsResolve.mjs",
      "--input-type=module",
      "-e",
      REFUSED,
    ],
    { cwd: ROOT, encoding: "utf8", timeout: 30_000 },
  );
  expect(JSON.parse(output.trim().split("\n").at(-1) ?? "{}")).toEqual({
    wrong: "refused",
    other: "closed 1006",
  });
});

test("the cloud socket module connects with the key in its header and talks both ways when Node imports it", {
  timeout: 60_000,
}, () => {
  const output = execFileSync(
    process.execPath,
    [
      "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      "--import",
      "./scripts/tsResolve.mjs",
      "--input-type=module",
      "-e",
      RUN,
    ],
    { cwd: ROOT, encoding: "utf8", timeout: 30_000 },
  );
  expect(JSON.parse(output.trim().split("\n").at(-1) ?? "{}")).toEqual({
    authorization: "Bearer test-key",
    message: "world",
  });
});
