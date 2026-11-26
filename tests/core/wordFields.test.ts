/**
 * Word's cross-references and tables of contents after an edit (#746): a clause added above the
 * one a REF names gives the REF its new number in the file, and Word is asked to refresh REF,
 * PAGEREF and TOC fields whose result the edit can have changed; one it can't have changed is
 * left as the file had it. A result that can't be known stays as the file showed it, for Word to
 * work out.
 */
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import { inspectPackage } from "../../eval/word/corpus";
import { createTempDataFolder, startCore } from "../helpers/core";
import { acceptedParagraphs, numbersIn, part, rejectedParagraphs, unzip } from "../helpers/docx";
import { editMind } from "../helpers/minds";
import { escapeXml, field, paragraph, run, STYLES, wordFile } from "../helpers/word";
import {
  addItemAfter,
  bookmarked,
  CHINESE_CONTRACT,
  CHINESE_PAST_NINE,
  type Contract,
  clause,
  clauseNumbering,
  contractFile,
  ENGLISH_CONTRACT,
  sub,
} from "../helpers/wordContracts";
import { importWordBytes } from "../helpers/wordMinds";

const simple = (instruction: string, result: string) =>
  `<w:fldSimple w:instr=" ${escapeXml(instruction)} ">${run(result)}</w:fldSimple>`;

const LANGUAGES = [
  ["English", ENGLISH_CONTRACT],
  ["Chinese", CHINESE_CONTRACT],
] as const;

const textOf = (node: JSONContent): string =>
  node.text ?? (node.content ?? []).map(textOf).join("");

/** Each field of a part, complex or simple: its instruction, the result it shows, and whether Word is asked to refresh it. */
function fieldsOf(xml: string): { instruction: string; result: string; dirty: boolean }[] {
  const texts = (from: string, tag: string) =>
    [...from.matchAll(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, "g"))].map((m) => m[1]).join("");
  const fields: { at: number; instruction: string; result: string; dirty: boolean }[] = [];
  for (const found of xml.matchAll(
    /<w:fldChar w:fldCharType="begin"([^>]*)\/>(.*?)<w:fldChar w:fldCharType="separate"\/>(.*?)<w:fldChar w:fldCharType="end"\/>/g,
  )) {
    fields.push({
      at: found.index,
      instruction: texts(found[2] ?? "", "w:instrText").trim(),
      result: texts(found[3] ?? "", "w:t"),
      dirty: /w:dirty="(?:true|1)"/.test(found[1] ?? ""),
    });
  }
  for (const found of xml.matchAll(/<w:fldSimple w:instr="([^"]*)"([^>]*)>(.*?)<\/w:fldSimple>/g)) {
    fields.push({
      at: found.index,
      instruction: (found[1] ?? "").trim(),
      result: texts(found[3] ?? "", "w:t"),
      dirty: /w:dirty="(?:true|1)"/.test(found[2] ?? ""),
    });
  }
  return fields.sort((a, b) => a.at - b.at).map(({ at: _at, ...each }) => each);
}

async function exported(
  bytes: Buffer,
  edit: (blocks: JSONContent[]) => JSONContent[],
  trackChanges = false,
) {
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir);
  const { mindId, client } = await importWordBytes(core, dataDir, bytes, { origin: "own" });
  editMind(client, edit);
  await client.settled();
  const data = (await core.exportMind(mindId, { format: "docx", trackChanges })).data;
  return { data, document: part(unzip(data), "word/document.xml") };
}

const fieldsIn = (bytes: Buffer) => fieldsOf(part(unzip(bytes), "word/document.xml"));
const renumber = (contract: Contract) => addItemAfter(contract.after, contract.added);

describe("a Word file's cross-references after its clauses are renumbered", () => {
  // protects=a sub-clause added above the bookmarked one gives a REF to it the new number as its shown result, and asks Word to refresh the REF and the PAGEREF to it, in English and Chinese; fails_when=the REF still shows 2.3 or （三）, or either field isn't marked to refresh, or the package has a problem Word's repair prompt is about; no_claim=what Word shows after it refreshes, which is the manual check.
  test.each([
    ["English", ENGLISH_CONTRACT, "2.4"],
    ["Chinese", CHINESE_CONTRACT, "（四）"],
  ] as const)(
    "%s: a clause added above the one a REF names",
    async (_language, contract, number) => {
      const { data, document } = await exported(contractFile(contract), renumber(contract));
      const [ref, pageRef] = fieldsOf(document);
      expect(ref).toMatchObject({ result: number, dirty: true });
      expect(ref?.instruction).toMatch(/^REF _Ref\d+ \\r \\h$/);
      expect(pageRef).toMatchObject({ result: "1", dirty: true });
      expect((await inspectPackage(data)).problems).toEqual([]);
    },
  );

  // protects=a clause added below the bookmarked one changes neither its number nor its page: the REF and PAGEREF stay as the file had them, not asked to refresh; fails_when=either is marked dirty or its result rewritten; no_claim=fields in headers, footers or notes.
  test.each(LANGUAGES)(
    "%s: a clause added after the referred one leaves the REF as it was",
    async (_language, contract) => {
      const bytes = contractFile(contract);
      const referring = contract === ENGLISH_CONTRACT ? "Either party" : "未按第";
      const { document } = await exported(bytes, (blocks) => {
        const lastItem = (node: JSONContent): JSONContent => {
          const content = node.content ?? [];
          const at = content.findIndex(
            (each) => each.type === "listItem" && textOf(each).startsWith(referring),
          );
          if (at < 0) return { ...node, content: content.map(lastItem) };
          const item = {
            type: "listItem",
            content: [{ type: "paragraph", content: [{ type: "text", text: contract.added }] }],
          };
          return { ...node, content: [...content, item] };
        };
        return blocks.map(lastItem);
      });
      expect(fieldsOf(document)).toEqual(fieldsIn(bytes));
    },
  );

  // protects=a simple field (w:fldSimple) is marked and given its new number as a complex one is; fails_when=it keeps 2.3 or isn't marked dirty; no_claim=a simple field's own formatting switches.
  test("a simple REF field is marked and renumbered too", async () => {
    const reference = `${run("Either party may end this agreement under clause ")}${simple("REF _Ref201 \\r \\h", "2.3")}${run(".")}`;
    const { document } = await exported(
      contractFile(ENGLISH_CONTRACT, reference),
      renumber(ENGLISH_CONTRACT),
    );
    expect(fieldsOf(document)).toEqual([
      { instruction: "REF _Ref201 \\r \\h", result: "2.4", dirty: true },
    ]);
  });

  // protects=a REF whose shown result no way of writing its number gives (a full-context number the author typed over) is asked to refresh but keeps what it showed, rather than a number IncarnaMind would guess; fails_when=its result is rewritten, or it isn't marked; no_claim=what Word writes when it refreshes it.
  test("a REF whose result can't be known is marked and keeps its result", async () => {
    const reference = `${run("See ")}${field("REF _Ref201 \\w \\h", "Clause 2.3 of the Fees")}${run(".")}`;
    const { document } = await exported(
      contractFile(ENGLISH_CONTRACT, reference),
      renumber(ENGLISH_CONTRACT),
    );
    expect(fieldsOf(document)).toEqual([
      { instruction: "REF _Ref201 \\w \\h", result: "Clause 2.3 of the Fees", dirty: true },
    ]);
  });

  // protects=a Chinese sub-clause renumbered from （九） to （十）, a number whose writing in Word's Chinese counting isn't certain, is asked to refresh and keeps （九） rather than a guess; fails_when=its result is rewritten, or it isn't marked; no_claim=what Word writes when it refreshes it.
  test("a REF whose new number can't be written for certain is marked and keeps its result", async () => {
    const { document } = await exported(
      contractFile(CHINESE_PAST_NINE),
      renumber(CHINESE_PAST_NINE),
    );
    expect(fieldsOf(document)).toEqual([
      { instruction: "REF _Ref301 \\r \\h", result: "（九）", dirty: true },
    ]);
  });

  // protects=a REF whose number goes from （十） to （十一）, neither of which Word's Chinese counting is certain to write so, is still asked to refresh, its result kept; fails_when=it isn't marked because no written form of either number could be compared; no_claim=what Word writes when it refreshes it.
  test("a REF whose number changes where neither number can be written is marked", async () => {
    const contract: Contract = {
      ...CHINESE_CONTRACT,
      numbering: clauseNumbering(["chineseCounting", "第%1条"], ["chineseCounting", "（%2）"], 8),
      reference: `${run("未按第")}${field("REF _Ref301 \\r \\h", "（十）")}${run("项支付利息的，任何一方可解除本合同。")}`,
    };
    const { document } = await exported(contractFile(contract), renumber(contract));
    expect(fieldsOf(document)).toEqual([
      { instruction: "REF _Ref301 \\r \\h", result: "（十）", dirty: true },
    ]);
  });

  // protects=a `\r` number leaves out the levels the bookmarked paragraph shares with the one the REF is in, so when a clause heading added between them moves the REF's paragraph to another clause, the REF is asked to refresh though its bookmark keeps 2.3, and its result is kept; fails_when=it isn't marked, or its result is rewritten; no_claim=what Word writes for a relative number, which the export doesn't work out.
  test("a `\\r` REF whose own paragraph moves to another clause is marked", async () => {
    const reference = `${run("Interest under clause ")}${field("REF _Ref201 \\r \\h", "2.3")}${run(" is due monthly.")}`;
    const contract: Contract = {
      ...ENGLISH_CONTRACT,
      body: (words) =>
        [
          clause("Services"),
          sub("Brightwater Studio designs the packaging Alder & Finch Ltd orders."),
          clause("Fees"),
          sub("Alder & Finch Ltd pays the fee each month."),
          sub(ENGLISH_CONTRACT.after),
          bookmarked("_Ref201", "Unpaid fees carry interest at 2% a month."),
          sub(words),
        ].join(""),
      reference,
    };
    const { data, document } = await exported(contractFile(contract), (blocks) =>
      blocks.flatMap((block) => {
        const items = block.content ?? [];
        const at = items.findIndex((each) => textOf(each).startsWith("Interest under clause"));
        if (block.type !== "orderedList" || at <= 0) return [block];
        const { id: _id, ...attrs } = block.attrs ?? {};
        return [
          { ...block, content: items.slice(0, at) },
          { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Interest" }] },
          { ...block, attrs, content: items.slice(at) },
        ];
      }),
    );
    expect(numbersIn(data).find((line) => line.includes("Interest under clause"))).toMatch(
      /^3\.1 /,
    );
    expect(fieldsOf(document)).toEqual([
      { instruction: "REF _Ref201 \\r \\h", result: "2.3", dirty: true },
    ]);
  });

  // protects=a `\r` REF in a paragraph with no number of its own stands where the paragraph before it in the list does: a clause heading added just before it moves it out of clause 2, so the REF is asked to refresh though its bookmark keeps 2.3, its result kept; fails_when=it isn't marked because neither its paragraph before nor after has a number; no_claim=what Word writes for a relative number.
  test("a `\\r` REF in an unnumbered paragraph that moves to another clause is marked", async () => {
    const reference = `${run("Interest under clause ")}${field("REF _Ref201 \\r \\h", "2.3")}${run(" is due monthly.")}`;
    const contract: Contract = {
      ...ENGLISH_CONTRACT,
      body: (words) =>
        [
          clause("Services"),
          sub("Brightwater Studio designs the packaging Alder & Finch Ltd orders."),
          clause("Fees"),
          sub("Alder & Finch Ltd pays the fee each month."),
          bookmarked("_Ref201", "Unpaid fees carry interest at 2% a month."),
          paragraph(words),
        ].join(""),
      reference,
    };
    const { document } = await exported(contractFile(contract), (blocks) => {
      const at = blocks.findIndex((each) => textOf(each).startsWith("Interest under clause"));
      const heading = {
        type: "heading",
        attrs: { level: 1 },
        content: [{ type: "text", text: "Interest" }],
      };
      return at < 0 ? blocks : [...blocks.slice(0, at), heading, ...blocks.slice(at)];
    });
    expect(fieldsOf(document)).toEqual([
      { instruction: "REF _Ref201 \\r \\h", result: "2.3", dirty: true },
    ]);
  });

  // protects=a field locked against updating (w:fldLock) keeps the result the file saved and isn't marked, as Word keeps it; fails_when=its result is rewritten or it is marked dirty; no_claim=unlocking it, which is the User's in Word.
  test("a locked REF keeps its result", async () => {
    const reference = `${run("Either party may end this agreement under clause ")}${simple("REF _Ref201 \\r \\h", "2.3").replace(' ">', ' " w:fldLock="true">')}${run(".")}`;
    const { document } = await exported(
      contractFile(ENGLISH_CONTRACT, reference),
      renumber(ENGLISH_CONTRACT),
    );
    expect(fieldsOf(document)).toEqual([
      { instruction: "REF _Ref201 \\r \\h", result: "2.3", dirty: false },
    ]);
  });

  // protects=a `\w` REF shows its paragraph's number in full context: when the clause heading it names becomes a sub-heading, a lettered "(b)" under clause 1, the export doesn't write the sub-heading's own "(b)" over the file's "2" but asks Word to refresh, keeping "2"; fails_when=it writes "(b)" or isn't marked; no_claim=how Word writes the full context.
  test("a `\\w` REF whose clause becomes a sub-clause is marked, its result kept", async () => {
    const heading = `<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:bookmarkStart w:id="5" w:name="_Ref500"/>${run("Fees")}<w:bookmarkEnd w:id="5"/></w:p>`;
    const contract: Contract = {
      ...ENGLISH_CONTRACT,
      numbering: clauseNumbering(["decimal", "%1."], ["lowerLetter", "(%2)"]),
      body: (words) =>
        [
          clause("Services"),
          sub("Brightwater Studio designs the packaging Alder & Finch Ltd orders."),
          heading,
          sub("Alder & Finch Ltd pays the fee each month."),
          clause("Termination"),
          sub(words),
        ].join(""),
      reference: `${run("Either party may end this agreement under clause ")}${field("REF _Ref500 \\w \\h", "2")}${run(".")}`,
    };
    const { document } = await exported(contractFile(contract), (blocks) =>
      blocks.map((block) =>
        block.type === "heading" && textOf(block) === "Fees"
          ? { ...block, attrs: { ...block.attrs, level: 2 } }
          : block,
      ),
    );
    expect(fieldsOf(document)).toEqual([
      { instruction: "REF _Ref500 \\w \\h", result: "2", dirty: true },
    ]);
  });

  // protects=a level whose format is "none" is counted as Word counts it, so the levels under it start again: with Heading 1 unnumbered and Heading 2 numbered "%2.", a Heading 2 added above the first Heading 1 leaves Scope "2" under it, so a `\n` REF to Scope keeps "2", unmarked; fails_when=the REF is written "3", the number Scope would have if the unnumbered heading weren't counted; no_claim=what the Note draws.
  test("a level that draws no number is still counted", async () => {
    const heading = (level: number) =>
      `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr><w:outlineLvl w:val="${level - 1}"/></w:pPr></w:style>`;
    const styles = `${STYLES.replace(/<w:style w:type="paragraph" w:styleId="Heading[12]">.*?<\/w:style>/g, "")}${heading(1)}${heading(2)}`;
    const level = (ilvl: number, format: string, text: string, style: string) =>
      `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${format}"/><w:pStyle w:val="${style}"/><w:lvlText w:val="${text}"/></w:lvl>`;
    const bytes = wordFile({
      styles,
      numbering: `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="multilevel"/>${level(0, "none", "", "Heading1")}${level(1, "decimal", "%2.", "Heading2")}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>`,
      body: [
        paragraph(run("Introduction"), { style: "Heading1" }),
        paragraph(run("Purpose"), { style: "Heading2" }),
        `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:bookmarkStart w:id="6" w:name="_Ref600"/>${run("Scope")}<w:bookmarkEnd w:id="6"/></w:p>`,
        paragraph(run("Terms"), { style: "Heading1" }),
        paragraph(run("Fees"), { style: "Heading2" }),
        paragraph(
          `${run("The fees follow section ")}${field("REF _Ref600 \\n \\h", "2")}${run(".")}`,
        ),
      ].join(""),
    });
    const { document } = await exported(bytes, (blocks) => [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Summary" }] },
      ...blocks,
    ]);
    expect(fieldsOf(document)).toEqual([
      { instruction: "REF _Ref600 \\n \\h", result: "2", dirty: false },
    ]);
  });

  // protects=a `\p` REF says "above" or "below" its bookmark, so when the User moves its paragraph past the bookmark it is asked to refresh, its result kept for Word; fails_when=it isn't marked; no_claim=the words Word writes.
  test("a `\\p` REF moved past its bookmark is marked", async () => {
    const reference = paragraph(
      `${run("The interest clause is ")}${field("REF _Ref201 \\p \\h", "below")}${run(".")}`,
    );
    const bytes = wordFile({
      styles: STYLES,
      numbering: ENGLISH_CONTRACT.numbering,
      body: `${reference}${ENGLISH_CONTRACT.body(run("Either party may end this agreement."))}`,
    });
    const { document } = await exported(bytes, (blocks) => {
      const at = blocks.findIndex((each) => textOf(each).startsWith("The interest clause is"));
      const moved = blocks[at];
      return moved ? [...blocks.slice(0, at), ...blocks.slice(at + 1), moved] : blocks;
    });
    expect(fieldsOf(document)).toEqual([
      { instruction: "REF _Ref201 \\p \\h", result: "below", dirty: true },
    ]);
  });

  // protects=a REF to words that hold another REF written again in the same export reads that REF's old number, so it is marked for Word and keeps its result rather than staying unmarked beside a stale copy; fails_when=it isn't marked or is rewritten; no_claim=what Word writes for it.
  test("a REF to words that hold a renumbered REF is marked", async () => {
    const quoted = `<w:p><w:bookmarkStart w:id="8" w:name="_Ref800"/>${run("interest under clause ")}${field("REF _Ref201 \\r \\h", "2.3")}<w:bookmarkEnd w:id="8"/></w:p>`;
    const contract: Contract = {
      ...ENGLISH_CONTRACT,
      body: (words) =>
        `${ENGLISH_CONTRACT.body(words)}${quoted}${paragraph(`${run("As said: ")}${field("REF _Ref800 \\h", "interest under clause 2.3")}`)}`,
      reference: run("Either party may end this agreement."),
    };
    const { document } = await exported(contractFile(contract), renumber(contract));
    expect(fieldsOf(document)).toEqual([
      { instruction: "REF _Ref201 \\r \\h", result: "2.4", dirty: true },
      { instruction: "REF _Ref800 \\h", result: "interest under clause 2.3", dirty: true },
    ]);
  });

  // protects=a simple field holding another, both naming a renumbered clause: each text of a result is the innermost field's, so the inner one gets the new number, and the outer one is only asked to refresh, rather than both writing the same text and the export failing; fails_when=the export throws, the inner result keeps 2.3, or either field isn't marked; no_claim=what Word shows in the outer field.
  test("a simple field inside another is renumbered, the outer one only marked", async () => {
    const inner = `<w:fldSimple w:instr=" REF _Ref201 \\r \\h ">${run("2.3")}</w:fldSimple>`;
    const reference = `${run("Either party may end this agreement under clause ")}<w:fldSimple w:instr=" REF _Ref201 \\r \\h ">${inner}</w:fldSimple>${run(".")}`;
    const { data, document } = await exported(
      contractFile(ENGLISH_CONTRACT, reference),
      renumber(ENGLISH_CONTRACT),
    );
    const nested =
      /<w:fldSimple ([^>]*)><w:fldSimple ([^>]*)>(.*?)<\/w:fldSimple><\/w:fldSimple>/.exec(
        document,
      );
    expect(nested?.[1]).toContain('w:dirty="true"');
    expect(nested?.[2]).toContain('w:dirty="true"');
    expect(nested?.[3]).toContain(">2.4<");
    expect((await inspectPackage(data)).problems).toEqual([]);
  });

  // protects=a field the file already marks not dirty with single quotes (w:dirty='false') gets one w:dirty="true", not a second attribute, which would make the part malformed; fails_when=the begin holds two w:dirty, or none set to true; no_claim=other attributes' quoting, which is kept as the file had it.
  test("a field marked not dirty in single quotes is marked once", async () => {
    const reference = `${run("Either party may end this agreement under clause ")}${field("REF _Ref201 \\r \\h", "2.3").replace('w:fldCharType="begin"/>', "w:fldCharType=\"begin\" w:dirty='false'/>")}${run(".")}`;
    const { document } = await exported(
      contractFile(ENGLISH_CONTRACT, reference),
      renumber(ENGLISH_CONTRACT),
    );
    const begin = /<w:fldChar w:fldCharType="begin"[^>]*\/>/.exec(document)?.[0] ?? "";
    expect(begin.match(/w:dirty/g)).toHaveLength(1);
    expect(fieldsOf(document)).toEqual([
      { instruction: "REF _Ref201 \\r \\h", result: "2.4", dirty: true },
    ]);
  });

  // protects=with the User's edits tracked, the REF's new number is the User's own tracked change beside the sub-clause they added: every change accepted, the referring clause says 2.4 / （四）; every change rejected, it says 2.3 / （三） with no trace of the new number, in English and Chinese; fails_when=the new number is written untracked, so rejecting the added clause leaves 2.4, or the REF isn't marked; no_claim=what Word writes when it refreshes it.
  test.each([
    ["English", ENGLISH_CONTRACT, "2.4"],
    ["Chinese", CHINESE_CONTRACT, "（四）"],
  ] as const)(
    "%s: with the User's edits tracked, the new number is their tracked change",
    async (_language, contract, number) => {
      const { data, document } = await exported(contractFile(contract), renumber(contract), true);
      const [ref] = fieldsOf(document);
      expect(ref).toMatchObject({ result: number, dirty: true });
      const accepted = acceptedParagraphs(document).join("\n");
      const rejected = rejectedParagraphs(document).join("\n");
      expect(accepted).toContain(contract.renumbered);
      expect(rejected).toContain(contract.before);
      expect(rejected).not.toContain(number);
      expect(rejected).not.toContain(contract.added);
      expect((await inspectPackage(data)).problems).toEqual([]);
    },
  );

  // protects=with the User's edits tracked, a simple field's result can't hold a tracked change in its place, so its REF is marked and keeps the file's 2.3 rather than an untracked 2.4; fails_when=its result is rewritten or it isn't marked; no_claim=what Word writes when it refreshes it.
  test("with the User's edits tracked, a simple REF is marked and keeps its result", async () => {
    const reference = `${run("Either party may end this agreement under clause ")}${simple("REF _Ref201 \\r \\h", "2.3")}${run(".")}`;
    const { document } = await exported(
      contractFile(ENGLISH_CONTRACT, reference),
      renumber(ENGLISH_CONTRACT),
      true,
    );
    expect(fieldsOf(document)).toEqual([
      { instruction: "REF _Ref201 \\r \\h", result: "2.3", dirty: true },
    ]);
  });

  // protects=a sub-clause deleted above the referred one renumbers it (2.2) when the deletion is made, but with the User's edits tracked the deleted clause still counts until the change is accepted: the REF is asked to refresh and keeps the file's 2.3, never a number one of the two views would show wrong; fails_when=the untracked export keeps 2.3, or the tracked one is rewritten or not marked; no_claim=what Word shows once it refreshes.
  test.each([
    [false, "2.2"],
    [true, "2.3"],
  ] as const)(
    "a clause deleted above the one a REF names (tracked: %s)",
    async (trackChanges, number) => {
      const deleted = (blocks: JSONContent[]): JSONContent[] => {
        const visit = (node: JSONContent): JSONContent => ({
          ...node,
          content: (node.content ?? [])
            .filter(
              (each) => !(each.type === "listItem" && textOf(each) === ENGLISH_CONTRACT.after),
            )
            .map(visit),
        });
        return blocks.map(visit);
      };
      const { data, document } = await exported(
        contractFile(ENGLISH_CONTRACT),
        deleted,
        trackChanges,
      );
      const [ref] = fieldsOf(document);
      expect(ref).toMatchObject({ result: number, dirty: true });
      expect((await inspectPackage(data)).problems).toEqual([]);
    },
  );

  // protects=a REF to a bookmark's text, the bookmarked words changed, shows the new words and is asked to refresh, in English and Chinese; fails_when=it shows the old words or isn't marked; no_claim=a bookmark over several paragraphs, whose text is left to Word.
  test.each([
    ["English", "Unpaid fees carry interest", "Unpaid fees carry a charge"],
    ["Chinese", "逾期未付的服务费", "逾期未付的费用"],
  ] as const)(
    "%s: a REF to a bookmark's words shows the new words",
    async (_language, words, now) => {
      const reference = `${run("As the clause says: ")}${field("REF _Ref700 \\h", words)}${run(".")}`;
      const body = [
        `<w:p><w:bookmarkStart w:id="7" w:name="_Ref700"/>${run(words)}<w:bookmarkEnd w:id="7"/>${run(" at 2% a month.")}</w:p>`,
        paragraph(reference),
      ].join("");
      const { document } = await exported(wordFile({ styles: STYLES, body }), (blocks) =>
        blocks.map((block) =>
          textOf(block).startsWith(words)
            ? {
                ...block,
                content: (block.content ?? []).map((each) => ({
                  ...each,
                  text: (each.text ?? "").replace(words, now),
                })),
              }
            : block,
        ),
      );
      expect(fieldsOf(document)).toEqual([
        { instruction: "REF _Ref700 \\h", result: now, dirty: true },
      ]);
    },
  );
});

/** A table of contents as Word writes one: the field from the first entry's paragraph to the last's, each entry its heading and page. */
const contents = (entries: readonly string[]) =>
  entries
    .map((entry, at) => {
      const begin =
        at === 0
          ? `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>`
          : "";
      const end = at === entries.length - 1 ? '<w:r><w:fldChar w:fldCharType="end"/></w:r>' : "";
      return `<w:p><w:pPr><w:pStyle w:val="TOC1"/></w:pPr>${begin}${run(entry)}<w:r><w:tab/></w:r>${run("1")}${end}</w:p>`;
    })
    .join("");

describe("a Word file's table of contents after an edit", () => {
  const withContents = (headings: readonly [string, string]) =>
    wordFile({
      body: [
        contents(headings),
        paragraph(run(headings[0]), { style: "Heading1" }),
        paragraph("The studio designs the packaging."),
        paragraph(run(headings[1]), { style: "Heading1" }),
        paragraph("The fee is due each month."),
      ].join(""),
    });

  // protects=a heading renamed asks Word to refresh the table of contents, whose entries stay as the file had them until it does, in English and Chinese; fails_when=the TOC isn't marked dirty, or its entries are rewritten; no_claim=the page numbers, which need Word's layout.
  test.each([
    ["English", ["Services", "Fees"], "Fees and costs"],
    ["Chinese", ["服务内容", "费用"], "费用与支付"],
  ] as const)(
    "%s: a heading renamed marks the table of contents",
    async (_language, headings, renamed) => {
      const file = withContents(headings);
      const { document } = await exported(file, (blocks) =>
        blocks.map((block) =>
          block.type === "heading" && textOf(block) === headings[1]
            ? { ...block, content: [{ type: "text", text: renamed }] }
            : block,
        ),
      );
      const [toc] = fieldsOf(document);
      expect(toc).toMatchObject({ dirty: true, result: fieldsIn(file)[0]?.result });
    },
  );

  // protects=an edit after the last heading can change neither a heading nor a page the table lists: the TOC stays as the file had it; fails_when=it is marked dirty; no_claim=an edit that makes the last page longer, which can't move a heading.
  test("an edit after the last heading leaves the table of contents as it was", async () => {
    const file = withContents(["Services", "Fees"]);
    const { document } = await exported(file, (blocks) =>
      blocks.map((block) =>
        textOf(block) === "The fee is due each month."
          ? {
              ...block,
              content: [{ type: "text", text: "The fee is due on the first of each month." }],
            }
          : block,
      ),
    );
    expect(fieldsOf(document)).toEqual(fieldsIn(file));
  });
});
