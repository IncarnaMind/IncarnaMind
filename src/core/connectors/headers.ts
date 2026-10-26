import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import type { Secrets } from "../secrets";

export const headerSecret = (id: string, name: string) =>
  `connector:${id}:header:${name.toLowerCase()}`;

export async function saveHeaders(
  secrets: Secrets,
  id: string,
  headers: Record<string, string>,
): Promise<void> {
  const saved: string[] = [];
  try {
    for (const [name, value] of Object.entries(headers)) {
      await secrets.set(headerSecret(id, name), value);
      saved.push(name);
    }
  } catch (error) {
    await Promise.all(saved.map((name) => secrets.delete(headerSecret(id, name))));
    throw error;
  }
}

export function hideHeaders(values: Iterable<string>): (text: string) => string {
  const hidden = [...values]
    .flatMap((value) => [value, value.replace(/^\S+\s+/, "")])
    .flatMap((value) => [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)])
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  return (value) => hidden.reduce((text, secret) => text.split(secret).join("[redacted]"), value);
}

function redactValue(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((each) => redactValue(each, redact));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, each]) => [redact(key), redactValue(each, redact)]),
    );
  }
  return value;
}

export function sanitizedTool(tool: McpTool, redact: (text: string) => string) {
  return {
    name: redact(tool.name),
    title: tool.title
      ? redact(tool.title)
      : tool.annotations?.title
        ? redact(tool.annotations.title)
        : null,
    description: redact(tool.description ?? ""),
    readOnly: tool.annotations?.readOnlyHint === true,
    inputSchema: redactValue(tool.inputSchema, redact) as Record<string, unknown>,
  };
}
