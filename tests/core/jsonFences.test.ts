import { expect, test } from "vitest";
import { withJsonFencesClosed } from "../../src/core/answers/jsonFences";

type Shape = "closed" | "open" | "blank before the fence" | "fence after the sentence";

const frame = (id: string, body: string, shape: Shape) =>
  [
    `### FACT ${id}`,
    "```json",
    `{"topic":"${id}","citations":[1]}`,
    ...(shape === "closed" ? ["```"] : shape === "blank before the fence" ? ["", "```"] : []),
    body,
    ...(shape === "fence after the sentence" ? ["```"] : []),
    `### END ${id}`,
  ].join("\n");

const bodies = {
  English: "The fee is 2.5% [^1].",
  Chinese: "费用是 2.5% [^1]。",
} as const;

// protects=a fact's json fence a model left open after its one JSON line is closed there, so its paragraph and every frame after it aren't read as code, and a fence the model closed anywhere before its frame ends is left as written, so a well-formed reply never loses a fact (#2306); fails_when=an open fence stays open, or a closed one gets a second fence that opens a code block over the next fact; no_claim=how a model writes its frames.
test.each(Object.entries(bodies))(
  "open fences are closed after their JSON line (%s)",
  (_, body) => {
    const open = [
      frame("F1", body, "closed"),
      frame("F2", body, "open"),
      frame("F3", body, "open"),
    ];
    const closed = [frame("F1", body, "closed"), frame("F2", body, "closed")];
    expect(withJsonFencesClosed(open.join("\n\n"))).toBe(
      [...closed, frame("F3", body, "closed")].join("\n\n"),
    );
  },
);

test.each(
  Object.entries(bodies).flatMap(([language, body]) =>
    (["closed", "blank before the fence", "fence after the sentence"] as const).map(
      (shape) => [language, shape, body] as const,
    ),
  ),
)("a reply in %s whose fences are %s, two facts in a row, is left as written", (_, shape, body) => {
  const reply = [frame("F1", body, shape), frame("F2", body, shape)].join("\n\n");
  expect(withJsonFencesClosed(reply)).toBe(reply);
});

test.each([
  ["code of several lines", '### FACT F1\n```json\n{"a":1}\n{"b":2}\n```\nafter'],
  ["a fence under another heading", '### Example\n```json\n{"a":1}\nafter'],
  ["another language", "```ts\nconst a = {};\nafter"],
  ["a fence closed with tildes", '~~~json\n{"a":1}\n~~~\nafter'],
  ["json in a paragraph", '{"a":1}\nafter'],
  ["a fence at the end", '```json\n{"a":1}'],
])("leaves %s as written", (_, text) => {
  expect(withJsonFencesClosed(text)).toBe(text);
});
