import { vi } from "vitest";

export type Reply = { text: string } | { call: { name: string; input: unknown } };

export interface Captured {
  url: string;
  body: Record<string, unknown>;
}

/**
 * Stands in for OpenAI's Responses API: records every request and answers from `replies`, in turn
 * (the last again), or from a function of the request's body.
 */
export function stubOpenAI(replies: Reply[] | ((body: Record<string, unknown>) => Reply)) {
  const requests: Captured[] = [];
  const respond = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push({ url, body });
    const reply =
      typeof replies === "function"
        ? replies(body)
        : (replies[Math.min(requests.length - 1, replies.length - 1)] as Reply);
    const output =
      "text" in reply
        ? {
            id: "msg_1",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: reply.text, annotations: [] }],
          }
        : {
            id: "fc_1",
            type: "function_call",
            call_id: "call_1",
            name: reply.call.name,
            arguments: JSON.stringify(reply.call.input),
            status: "completed",
          };
    const response = {
      id: "resp_1",
      object: "response",
      created_at: 1_790_000_000,
      model: String(body.model),
      status: "completed",
      output: [output],
      usage: {
        input_tokens: 10,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 4,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 14,
      },
    };
    if (body.stream !== true) {
      return new Response(JSON.stringify(response), {
        headers: { "content-type": "application/json" },
      });
    }
    const events: object[] = [
      { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: "text" in reply ? { ...output, status: "in_progress", content: [] } : output,
      },
    ];
    if ("text" in reply) {
      events.push({
        type: "response.content_part.added",
        item_id: "msg_1",
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
      events.push({
        type: "response.output_text.delta",
        item_id: "msg_1",
        output_index: 0,
        content_index: 0,
        delta: reply.text,
      });
    }
    events.push(
      { type: "response.output_item.done", output_index: 0, item: output },
      { type: "response.completed", response },
    );
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    });
  };
  vi.stubGlobal("fetch", vi.fn(respond));
  return requests;
}
