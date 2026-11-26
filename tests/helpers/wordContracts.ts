/**
 * Invented contracts whose clauses Word numbers, for the round trip of their numbering and
 * cross-references (#746): numbered clause headings, sub-clauses under them, one sub-clause
 * bookmarked and a later clause that refers to it by number and page.
 */
import type { JSONContent } from "@tiptap/core";
import { field, paragraph, run, STYLES, wordFile } from "./word";

/** A clause list as a contract numbers it: "1." at the first level, "1.1" under it, from `start`. */
export const clauseNumbering = (top: [string, string], under: [string, string], start = 1) =>
  `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="multilevel"/>${[top, under]
    .map(
      ([format, text], level) =>
        `<w:lvl w:ilvl="${level}"><w:start w:val="${level === 1 ? start : 1}"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${text}"/></w:lvl>`,
    )
    .join("")}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>`;

/** A clause heading, numbered at the first level; a sub-clause under it; one with a bookmark on it. */
export const clause = (text: string) =>
  paragraph(run(text), { style: "Heading1", numId: 1, ilvl: 0 });
export const sub = (content: string) =>
  paragraph(content.startsWith("<") ? content : run(content), { numId: 1, ilvl: 1 });
export const bookmarked = (name: string, text: string) =>
  `<w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr><w:bookmarkStart w:id="0" w:name="${name}"/>${run(text)}<w:bookmarkEnd w:id="0"/></w:p>`;

export interface Contract {
  numbering: string;
  /** The contract, its last clause the one that refers to the bookmarked sub-clause. */
  body(reference: string): string;
  /** That clause's words around the cross-reference, by default a REF and a PAGEREF. */
  reference: string;
  /** The sub-clause a new one is added after, and the new one's text. */
  after: string;
  added: string;
  /** The referring clause's words as Word shows them once its REF shows the new number. */
  renumbered: string;
  /** The same words as the file showed them, before the sub-clause was added. */
  before: string;
}

/** A services contract: clause 2.3 is bookmarked, and 3.1 refers to it by number and page. */
export const ENGLISH_CONTRACT: Contract = {
  numbering: clauseNumbering(["decimal", "%1."], ["decimal", "%1.%2"]),
  body: (reference) =>
    [
      clause("Services"),
      sub("Brightwater Studio designs the packaging Alder & Finch Ltd orders."),
      clause("Fees"),
      sub("Alder & Finch Ltd pays the fee each month."),
      sub("Fees are due within 30 days of the invoice."),
      bookmarked("_Ref201", "Unpaid fees carry interest at 2% a month."),
      clause("Termination"),
      sub(reference),
    ].join(""),
  reference: `${run("Either party may end this agreement if interest under clause ")}${field("REF _Ref201 \\r \\h", "2.3")}${run(" is unpaid; see page ")}${field("PAGEREF _Ref201 \\h", "1")}${run(".")}`,
  after: "Fees are due within 30 days of the invoice.",
  added: "Late fees are capped at the fee itself.",
  renumbered: "interest under clause 2.4 is unpaid",
  before: "interest under clause 2.3 is unpaid",
};

/** The same contract in Chinese: 第一条 and （一） under it; （三） of 第二条 is bookmarked. */
export const CHINESE_CONTRACT: Contract = {
  numbering: clauseNumbering(["chineseCounting", "第%1条"], ["chineseCounting", "（%2）"]),
  body: (reference) =>
    [
      clause("服务内容"),
      sub("青禾设计工作室为远帆贸易有限公司设计包装。"),
      clause("费用"),
      sub("远帆贸易有限公司按月支付服务费。"),
      sub("服务费应在发票开具后三十日内支付。"),
      bookmarked("_Ref301", "逾期未付的服务费按每月百分之二计收利息。"),
      clause("合同解除"),
      sub(reference),
    ].join(""),
  reference: `${run("未按第")}${field("REF _Ref301 \\r \\h", "（三）")}${run("项支付利息的，任何一方可解除本合同，见第")}${field("PAGEREF _Ref301 \\h", "1")}${run("页。")}`,
  after: "服务费应在发票开具后三十日内支付。",
  added: "滞纳金以服务费金额为限。",
  renumbered: "未按第（四）项支付利息",
  before: "未按第（三）项支付利息",
};

/**
 * The Chinese contract with 第二条's sub-clauses from （七）, so the bookmarked one is （九） and
 * becomes （十）: a number whose writing in Word's Chinese counting isn't certain, so the export
 * keeps the file's （九） and marks the REF for Word to work out.
 */
export const CHINESE_PAST_NINE: Contract = {
  ...CHINESE_CONTRACT,
  numbering: clauseNumbering(["chineseCounting", "第%1条"], ["chineseCounting", "（%2）"], 7),
  reference: `${run("未按第")}${field("REF _Ref301 \\r \\h", "（九）")}${run("项支付利息的，任何一方可解除本合同。")}`,
  renumbered: "未按第（十）项支付利息",
  before: "未按第（九）项支付利息",
};

export const contractFile = (contract: Contract, reference = contract.reference) =>
  wordFile({ styles: STYLES, numbering: contract.numbering, body: contract.body(reference) });

const textOf = (node: JSONContent): string =>
  node.text ?? (node.content ?? []).map(textOf).join("");

/** A new item after the one whose text is `after`, in whichever list holds it: Enter at its end. */
export const addItemAfter =
  (after: string, text: string) =>
  (blocks: JSONContent[]): JSONContent[] => {
    const visit = (node: JSONContent): JSONContent => {
      const content = node.content ?? [];
      const at = content.findIndex(
        (each) => each.type === "listItem" && textOf(each.content?.[0] ?? {}) === after,
      );
      if (at < 0) return { ...node, content: content.map(visit) };
      const item: JSONContent = {
        type: "listItem",
        content: [{ type: "paragraph", content: [{ type: "text", text }] }],
      };
      return { ...node, content: [...content.slice(0, at + 1), item, ...content.slice(at + 1)] };
    };
    return blocks.map(visit);
  };
