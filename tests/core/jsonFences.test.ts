import { expect, test } from "vitest";
import { withJsonFencesClosed } from "../../src/core/answers/jsonFences";

const frame = (id: string, body: string, closed: boolean) =>
  [
    `### FACT ${id}`,
    "```json",
    `{"topic":"${id}","citations":[1]}`,
    ...(closed ? ["```"] : []),
    body,
    `### END ${id}`,
  ].join("\n");

// protects=a fact's json fence a model left open after its one JSON line is closed there, so its paragraph and every frame after it aren't read as code, and nothing else changes (#2306); fails_when=a closed fence, another language's fence or code of several lines is changed, or an open one stays open; no_claim=how a model writes its frames.
test.each([
  ["English", "The fee is 2.5% [^1]."],
  ["Chinese", "费用是 2.5% [^1]。"],
])("a json fence left open after its one line is closed there (%s)", (_, body) => {
  const open = [frame("F1", body, true), frame("F2", body, false), frame("F3", body, false)].join(
    "\n\n",
  );
  const closed = [frame("F1", body, true), frame("F2", body, true), frame("F3", body, true)].join(
    "\n\n",
  );
  expect(withJsonFencesClosed(open)).toBe(closed);
  expect(withJsonFencesClosed(closed)).toBe(closed);
});

test.each([
  ["code of several lines", '```json\n{"a":1}\n{"b":2}\n```\nafter'],
  ["another language", "```ts\nconst a = {};\nafter"],
  ["a fence closed with tildes", '~~~json\n{"a":1}\n~~~\nafter'],
  ["json in a paragraph", '{"a":1}\nafter'],
  ["a fence at the end", '```json\n{"a":1}'],
])("leaves %s as written", (_, text) => {
  expect(withJsonFencesClosed(text)).toBe(text);
});
