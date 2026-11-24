import type { OwnAiModel } from "../core/adapters";
import { stopProcessTree } from "../core/execution";
import { drained, object, processes } from "./agentCommand";

/** How long Claude Code may take to list its models before it counts as no answer. */
const ANSWER_MS = 15_000;

/**
 * The models Claude Code offers, as its `initialize` control request lists them: no model call,
 * no server, no session kept, and stopped once it has answered.
 */
export async function modelsOf(command: string): Promise<OwnAiModel[]> {
  let child: Awaited<ReturnType<typeof processes.spawn>>;
  try {
    child = await processes.spawn(
      command,
      [
        "-p",
        "--safe-mode",
        "--tools",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
        "--no-session-persistence",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--settings",
        '{"disableAllHooks":true,"disableClaudeAiConnectors":true}',
      ],
      { processGroup: true },
    );
  } catch {
    return [];
  }
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  try {
    const answer = await new Promise<Record<string, unknown> | null>((resolve) => {
      let buffered = "";
      const timer = setTimeout(() => resolve(null), ANSWER_MS);
      child.stdout?.on("data", (chunk: Buffer) => {
        buffered += chunk.toString("utf8");
        let at = buffered.indexOf("\n");
        while (at >= 0) {
          const line = buffered.slice(0, at);
          buffered = buffered.slice(at + 1);
          at = buffered.indexOf("\n");
          try {
            const message = object(JSON.parse(line));
            const response = object(message.response);
            if (message.type === "control_response" && response.request_id === "models") {
              clearTimeout(timer);
              resolve(object(response.response));
            }
          } catch {
            // A line that isn't JSON says nothing of the models.
          }
        }
      });
      child.once("close", () => {
        clearTimeout(timer);
        resolve(null);
      });
      child.stdin?.write(
        `${JSON.stringify({ type: "control_request", request_id: "models", request: { subtype: "initialize" } })}\n`,
      );
    });
    const listed = Array.isArray(answer?.models) ? answer.models.map(object) : [];
    return listed
      .filter((each) => typeof each.value === "string" && typeof each.displayName === "string")
      .map((each) => ({
        value: String(each.value),
        resolvedModel: typeof each.resolvedModel === "string" ? each.resolvedModel : "",
        displayName: String(each.displayName),
        description: typeof each.description === "string" ? each.description : "",
      }));
  } finally {
    stopProcessTree(child);
    await drained(child, closed, "Claude Code");
  }
}
