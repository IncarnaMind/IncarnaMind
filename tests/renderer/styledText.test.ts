import { describe, expect, test } from "vitest";
import { bibliographyClipboard, runsHtml } from "../../src/renderer/src/editor/styledText";

describe("References on the clipboard", () => {
  test("keep the style's formatting as HTML, and read as plain text with each number first and a thin entry marked as in an export", () => {
    const copied = bibliographyClipboard(
      [
        {
          documentId: "a",
          workDocumentId: "a",
          label: [{ text: "[1]" }],
          runs: [
            { text: "KAHNEMAN D. Prospect theory[J]. " },
            { text: "Econometrica", italic: true },
            { text: ", 1979, 47(2)." },
          ],
          needsDetails: false,
        },
        {
          documentId: "b",
          workDocumentId: "b",
          label: [{ text: "[2]" }],
          runs: [{ text: "钱学森. 工程控制论[M]. 1958." }],
          needsDetails: false,
        },
        {
          documentId: "c",
          workDocumentId: "c",
          label: [{ text: "[3]" }],
          runs: [{ text: "城市绿地调查笔记." }],
          needsDetails: true,
        },
      ],
      "[信息待补充]",
    );
    expect(copied.text).toBe(
      "[1] KAHNEMAN D. Prospect theory[J]. Econometrica, 1979, 47(2).\n[2] 钱学森. 工程控制论[M]. 1958.\n[3] 城市绿地调查笔记. [信息待补充]",
    );
    expect(copied.html).toBe(
      "<p>[1] KAHNEMAN D. Prospect theory[J]. <i>Econometrica</i>, 1979, 47(2).</p><p>[2] 钱学森. 工程控制论[M]. 1958.</p><p>[3] 城市绿地调查笔记. [信息待补充]</p>",
    );
  });

  test("never read a field's text as markup, and link only web addresses", () => {
    expect(
      runsHtml([
        { text: 'Cats & dogs <img src=x onerror="alert(1)">', bold: true },
        { text: "doi", link: "javascript:alert(1)" },
        { text: "x²", script: "sup", link: 'https://example.org/"q"' },
      ]),
    ).toBe(
      '<b>Cats &amp; dogs &lt;img src=x onerror=&quot;alert(1)&quot;&gt;</b>doi<a href="https://example.org/&quot;q&quot;"><sup>x²</sup></a>',
    );
  });
});
