/**
 * The parts of the MCP SDK the Connectors use, which the other modules import
 * dynamically: the SDK takes ~100 ms to load (its schemas and its JSON Schema
 * validator), so it loads with the first connection or sign-in rather than at
 * every startup.
 */
export { auth } from "@modelcontextprotocol/sdk/client/auth.js";
export { Client } from "@modelcontextprotocol/sdk/client/index.js";
export { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
export {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
export { ChildProcessTransport } from "./transport";
