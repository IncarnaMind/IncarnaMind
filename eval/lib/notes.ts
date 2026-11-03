/**
 * What an Answer left in a Mind, for an evaluation that has it write a note:
 * the changes it made, and the Citations and text the Mind holds once they are
 * accepted, as the window applies them.
 */
import * as Y from "yjs";
import { CITATION_NODE, type CitationAttributes, type Core } from "../../src/core";
import { plainText } from "../../src/core/mindText";
import { decideProposals } from "../../src/shared/proposals";
import { connectToMind } from "../../tests/helpers/mindClient";

export type Cited = Pick<
  CitationAttributes,
  | "passageId"
  | "documentId"
  | "documentName"
  | "contentHash"
  | "pageFrom"
  | "pageTo"
  | "location"
  | "quote"
>;

/** Accepts every Proposal the Answer left in the Mind, as the window applies them at once. */
export async function acceptChanges(core: Core, mindId: string): Promise<void> {
  const client = await connectToMind(core, mindId);
  client.doc.transact(() => decideProposals(client.blocks, () => true, "accept"));
  await client.settled();
}

/** The Citations a Mind holds, and its text, as the model wrote it there. */
export async function citationNodes(
  core: Core,
  mindId: string,
): Promise<{ citations: (Partial<Cited> & { check?: string })[]; text: string }> {
  const { blocks } = await connectToMind(core, mindId);
  const citations: (Partial<Cited> & { check?: string })[] = [];
  const visit = (element: Y.XmlElement | Y.XmlFragment) => {
    for (const child of element.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName === CITATION_NODE) citations.push(child.getAttributes());
      visit(child);
    }
  };
  visit(blocks);
  const text = blocks
    .toArray()
    .map((block) => (block instanceof Y.XmlElement ? plainText(block) : ""))
    .join("\n");
  return { citations, text };
}
