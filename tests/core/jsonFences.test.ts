import { expect, test } from "vitest";
import { withJsonFencesClosed } from "../../src/core/answers/jsonFences";

type Shape = "closed" | "open" | "blank before the fence" | "fence after the sentence";

const frame = (id: string, body: string, shape: Shape, title = "") =>
  [
    `### FACT ${id}${title}`,
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

// protects=a frame whose opening line writes a title after its id is a frame here too, and its open fence is closed as an untitled frame's is (#3106); fails_when=a titled frame's open fence stays open, or a fence is closed twice; no_claim=how the fact reader takes the id, which tests/core/meetingFacts.test.ts covers.
test.each(Object.entries(bodies))("a titled frame's open fence is closed too (%s)", (_, body) => {
  const titled = (id: string, shape: Shape) => frame(id, body, shape, ` — Fee ${id}`);
  expect(withJsonFencesClosed([titled("F1", "open"), titled("F2", "open")].join("\n\n"))).toBe(
    [titled("F1", "closed"), titled("F2", "closed")].join("\n\n"),
  );
});

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

// protects=a fence still open at a frame's line is closed before it, so a stray fence line after a frame doesn't turn every frame after it into code, and the frames after it get their own open fences closed as usual (in one reply Claude Haiku 5.5 wrote a fence line after a fact's end line, and the ten facts after it were neither kept nor counted, #3145); fails_when=a frame's line stays inside a fence, or a frame after the stray fence keeps an open fence; no_claim=why a model writes the stray line.
test.each(Object.entries(bodies))(
  "a stray fence line after a frame is closed before the next frame (%s)",
  (_, body) => {
    const reply = [
      frame("F1", body, "closed"),
      "```",
      "",
      frame("F2", body, "open"),
      "",
      frame("F3", body, "open"),
    ];
    expect(withJsonFencesClosed(reply.join("\n"))).toBe(
      [
        frame("F1", body, "closed"),
        "```",
        "",
        "```",
        frame("F2", body, "closed"),
        "",
        frame("F3", body, "closed"),
      ].join("\n"),
    );
  },
);

// protects=a fence left open inside a frame, a stray one before its end line or a record of several lines, ends before that frame's end line, so the frames after it are read and the fact reader can count the one frame it can't read (#3145); fails_when=the frame's end line or a later frame stays inside the fence; no_claim=that the frame itself is readable: it isn't.
test.each([
  [
    "a stray fence before the end line",
    ["### FACT F1", "```json", '{"a":1}', "```", "body", "```"],
  ],
  ["a record of several lines", ["### FACT F1", "```json", "{", '"a":1', "}", "body"]],
])("%s is closed before the frame's end line", (_, start) => {
  const rest = ["### END F1", "", frame("F2", bodies.English, "closed")];
  expect(withJsonFencesClosed([...start, ...rest].join("\n"))).toBe(
    [...start, "```", ...rest].join("\n"),
  );
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
