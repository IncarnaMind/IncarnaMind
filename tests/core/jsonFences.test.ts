import { expect, test } from "vitest";
import { withJsonFencesClosed, withMarkersAgreed } from "../../src/core/answers/jsonFences";

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

const numbered = (id: string, declared: number[], body: string) =>
  [
    id === "OVERVIEW" ? "### OVERVIEW" : `### FACT ${id}`,
    "```json",
    JSON.stringify({ topic: id, citations: declared }),
    "```",
    body,
    `### END ${id}`,
  ].join("\n");

const sentences = {
  English: (marker: string) => `The fee is 2.5%. ${marker}`,
  Chinese: (marker: string) => `费用是 2.5%。${marker}`,
} as const;

// protects=a reply that writes one marker after every fact, as the instructions' example fact has it, while each fact's record declares its own number, has each fact's marker written as that number, in English and Chinese
test.each(Object.entries(sentences))(
  "a marker written after every fact becomes the number each fact declares (%s)",
  (_, sentence) => {
    const reply = (written: (declared: number) => number) =>
      [
        numbered("F1", [1], sentence("[^1]")),
        numbered("F2", [4], sentence(`[^${written(4)}]`)),
        numbered("F3", [5], sentence(`[^${written(5)}]`)),
        numbered("OVERVIEW", [2, 3], `${sentence("[^2]")} ${sentence("[^3]")}`),
      ].join("\n\n");
    expect(withMarkersAgreed(reply(() => 1))).toBe(reply((declared) => declared));
  },
);

// protects=a record that declares other numbers than its sentences write (the example's 1, then 2 and 3 for the overview, then 4) comes to declare the sentences' markers, when no other frame writes them: a Citation's record goes by the marker in the text
test.each([
  [
    "records numbered after the example, markers counted from 1",
    [
      ["F1", [1], [1]],
      ["F2", [4], [2]],
      ["F3", [5], [3]],
      ["OVERVIEW", [2, 3], [4, 5]],
    ],
  ],
  [
    "the declared number repeated, the markers written right",
    [
      ["F1", [1], [1]],
      ["F2", [1], [2]],
    ],
  ],
  [
    "a record that declares one marker more than its sentence writes",
    [
      ["F1", [1], [1]],
      ["F2", [15, 3], [15]],
      ["OVERVIEW", [2, 3], [2, 3]],
    ],
  ],
] as const)("a record comes to declare the markers its sentences write: %s", (_, frames) => {
  const reply = (declares: "declared" | "written") =>
    frames
      .map(([id, declared, written]) =>
        numbered(
          id,
          [...(declares === "declared" ? declared : written)],
          written.map((marker) => `Said. [^${marker}]`).join(" "),
        ),
      )
      .join("\n\n");
  expect(withMarkersAgreed(reply("declared"))).toBe(reply("written"));
});

// protects=a frame is changed only where the reply shows which of its two lists is right: a marker several frames write with two declared numbers, a declared number that is another frame's, a frame with no marker and one whose record can't be read stay as written
test.each([
  [
    "a shared marker under a record that declares two",
    [numbered("F1", [1], "One. [^1]"), numbered("F2", [4, 5], "Two. [^1] More. [^1]")],
  ],
  [
    "a shared marker whose declared number is another frame's",
    [
      numbered("F1", [1], "One. [^1]"),
      numbered("F2", [4], "Two. [^1]"),
      numbered("F3", [4], "Three. [^4]"),
    ],
  ],
  [
    "markers that are the declared ones",
    [numbered("F1", [1], "One. [^1]"), numbered("F2", [2], "Two. [^2]")],
  ],
  ["a frame with no marker", [numbered("F1", [1], "One. [^1]"), numbered("F2", [4], "Two.")]],
  [
    "a record that can't be read",
    [numbered("F1", [1], "One. [^1]"), "### FACT F2\n```json\n{topic}\n```\nTwo. [^2]\n### END F2"],
  ],
])("leaves %s as written", (_, frames) => {
  const reply = frames.join("\n\n");
  expect(withMarkersAgreed(reply)).toBe(reply);
});
