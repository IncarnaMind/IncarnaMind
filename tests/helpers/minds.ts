import { randomUUID } from "node:crypto";
import { getSchema, type JSONContent } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import { GENERATED_MARK, PROPOSAL_ATTRIBUTE, type SearchScope } from "../../src/core";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { decideProposals, pendingProposals } from "../../src/shared/proposals";
import { SCOPE_ATTRIBUTES } from "../../src/shared/searchScope";
import type { MindClient } from "./mindClient";

/** The schema of the renderer's editor: what a Mind can hold. */
const mindSchema = getSchema(noteExtensions());

/**
 * The Mind's Blocks as the editor reads them from Yjs. Throws if anything in
 * them breaks the editor's schema.
 */
export function readMind(client: Pick<MindClient, "blocks">): ProseMirrorNode {
  const doc = yXmlFragmentToProseMirrorRootNode(client.blocks, mindSchema);
  if (doc.childCount > 0) doc.check();
  return doc;
}

/** Writes a whole Mind, as JSON, into its Yjs document the way the editor's binding does. */
export function writeMind(client: MindClient, blocks: JSONContent[]): void {
  const doc = mindSchema.nodeFromJSON({ type: "doc", content: blocks });
  client.doc.transact(() =>
    updateYFragment(client.doc, client.blocks, doc, { mapping: new Map(), isOMark: new Map() }),
  );
}

/** Changes the Mind's top-level Blocks, as JSON, and writes them back as the editor would. */
export function editMind(
  client: MindClient,
  change: (blocks: JSONContent[]) => JSONContent[],
): void {
  const current = client.blocks.length > 0 ? (readMind(client).toJSON().content ?? []) : [];
  writeMind(client, change(current));
}

const inline = (text: string): JSONContent[] => (text ? [{ type: "text", text }] : []);

/** A paragraph Note. `off` switches it out of Question context. */
export function note(text: string, { off = false } = {}): JSONContent {
  return {
    type: "paragraph",
    attrs: { id: randomUUID(), ...(off ? { includeInContext: false } : {}) },
    content: inline(text),
  };
}

export function heading(level: number, text: string): JSONContent {
  return { type: "heading", attrs: { id: randomUUID(), level }, content: inline(text) };
}

/** A Question Block, optionally with a model picked for it and a Search scope. */
export function question(
  text: string,
  model?: { providerId: string; modelId: string },
  scope?: Partial<SearchScope>,
): JSONContent & { attrs: { id: string } } {
  return {
    type: "question",
    attrs: { id: randomUUID(), ...model, ...(scope && scopeAttributes(scope)) },
    content: inline(text),
  };
}

/** A Search scope as a Question Block's attributes, the way the editor stores it. */
export function scopeAttributes(scope: Partial<SearchScope>): Record<string, string[] | null> {
  const list = (ids: string[] | undefined) => (ids && ids.length > 0 ? ids : null);
  return {
    [SCOPE_ATTRIBUTES.folder]: list(scope.folderIds),
    [SCOPE_ATTRIBUTES.tag]: list(scope.tagIds),
    [SCOPE_ATTRIBUTES.document]: list(scope.documentIds),
  };
}

/** Each top-level Block's type, with an Answer's status. */
export function outline(client: MindClient): string[] {
  const types: string[] = [];
  readMind(client).forEach((block) => {
    types.push(block.type.name === "answer" ? `answer:${block.attrs.status}` : block.type.name);
  });
  return types;
}

/** The top-level Answer with this Block ID. */
export function answerIn(client: MindClient, answerId: string): ProseMirrorNode {
  let found: ProseMirrorNode | null = null;
  readMind(client).forEach((block) => {
    if (block.type.name === "answer" && block.attrs.id === answerId) found = block;
  });
  if (!found) throw new Error(`No Answer ${answerId} in the Mind.`);
  return found;
}

/** An Answer's text, its Blocks separated by blank lines. */
export function answerText(client: MindClient, answerId: string): string {
  const answer = answerIn(client, answerId);
  return answer.textBetween(0, answer.content.size, "\n\n");
}

/**
 * The Mind's text, Proposals shown: removed words as [-…-], added words as
 * {+…+}, a Citation as ⟨its check⟩, Blocks a Proposal adds or removes after
 * "+ " or "- ", one line per paragraph or heading.
 */
export function shownWithChanges(client: Pick<MindClient, "blocks">): string[] {
  const lines: string[] = [];
  readMind(client).descendants((node: ProseMirrorNode) => {
    if (!node.isTextblock) return true;
    let line = "";
    node.forEach((child) => {
      const kind = (child.attrs[PROPOSAL_ATTRIBUTE] as { kind?: string } | null)?.kind;
      const inline = child.isText
        ? (child.text ?? "")
        : child.type.name === "citation"
          ? `⟨${child.attrs.check}⟩`
          : "\uFFFC";
      const marks = child.marks.map((mark) => mark.type.name);
      if (marks.includes("proposalDelete") || kind === "delete") line += `[-${inline}-]`;
      else if (marks.includes("proposalInsert") || kind === "insert") line += `{+${inline}+}`;
      else line += inline;
    });
    const block = (node.attrs[PROPOSAL_ATTRIBUTE] as { kind?: string } | null)?.kind;
    lines.push(`${block === "insert" ? "+ " : block === "delete" ? "- " : ""}${line}`);
    return false;
  });
  return lines.map((line) => line.replace(/-\]\[-|\+\}\{\+/g, ""));
}

/** A Block's text, its AI text (`GENERATED_MARK`) in «…», an inline node as U+FFFC. */
export function shownWithAiText(block: ProseMirrorNode): string {
  let shown = "";
  block.descendants((node) => {
    if (node.isText) {
      const ai = node.marks.some((mark) => mark.type.name === GENERATED_MARK);
      shown += ai ? `«${node.text}»` : (node.text ?? "");
    } else if (node.isInline) shown += "\uFFFC";
    return true;
  });
  return shown.replace(/»«/g, "");
}

/**
 * Accepts or rejects Proposals in the client's copy, as the editor does, and
 * sends it to the core. `which` picks them by id and by their order in the Mind.
 */
export async function resolveChanges(
  client: MindClient,
  outcome: "accept" | "reject",
  which: (id: string, index: number) => boolean = () => true,
) {
  const order = pendingProposals(client.blocks).map((proposal) => proposal.id);
  let resolved: ReturnType<typeof decideProposals> = [];
  client.doc.transact(() => {
    resolved = decideProposals(
      client.blocks,
      (proposal) => which(proposal.id, order.indexOf(proposal.id)),
      outcome,
    );
  }, "editor");
  await client.settled();
  return resolved;
}
