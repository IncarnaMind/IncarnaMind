import { expect, test } from "vitest";
import { withUserName } from "../../src/core/meetings/userName";
import type { NodeJSON } from "../../src/shared/blockJson";

const text = (value: string, ...marks: string[]): NodeJSON => ({
  type: "text",
  text: value,
  ...(marks.length > 0 && { marks: marks.map((type) => ({ type })) }),
});
const paragraph = (...content: NodeJSON[]): NodeJSON => ({ type: "paragraph", content });

// protects=the pass that names the User touches only what means them: other double-braced text ("{{first_name}}", "{{ }}") stays exactly as written, and inline code and code blocks are never changed, while {{user}}, ｛｛用户｝｝ and a token split by formatting become the name and are counted (#2306); fails_when=other braced text loses its braces or vanishes, code is rewritten, or a User token is left; no_claim=what a model writes, which tests/core/meetingFillName.test.ts covers through the fill.
test.each([
  {
    name: "Avery Lin",
    other: "Mail merge fills {{first_name}} and {{ }} for each guest.",
    code: ["Type ", " into the template."],
    sends: " sends the invoice.",
  },
  {
    name: "林安",
    other: "邮件合并会给每位客人填 {{first_name}} 和 {{ }}。",
    code: ["在模板里输入 ", " 即可。"],
    sends: "发送发票。",
  },
])("only what means the User is named: $name", ({ name, other, code, sends }) => {
  const untouched = [
    paragraph(text(other)),
    paragraph(text(code[0] ?? ""), text("{{me}}", "code"), text(code[1] ?? "")),
    { type: "codeBlock", attrs: { language: "text" }, content: [text("{{me}} {{user}} {{用户}}")] },
  ];
  expect(withUserName(untouched, name)).toEqual({ nodes: untouched, leftovers: 0 });

  const meant = [
    paragraph(text("{{"), text("user", "bold"), text(`}}${sends}`)),
    paragraph(text(`｛｛用户｝｝${sends}`)),
    paragraph(text("{{"), text("me", "italic"), text(`}}${sends}`)),
  ];
  const { nodes, leftovers } = withUserName(meant, name);
  const spaced = /\p{Script=Han}/u.test(name) || sends.startsWith(" ") ? name : `${name} `;
  expect(nodes.map((node) => (node.content ?? []).map((each) => each.text).join(""))).toEqual([
    `${spaced}${sends}`,
    `${spaced}${sends}`,
    `${spaced}${sends}`,
  ]);
  expect(leftovers).toBe(2);
});
