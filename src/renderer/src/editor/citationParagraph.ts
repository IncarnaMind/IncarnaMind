import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { CitationParagraph } from "../../../core/api";
import type { NodeJSON } from "../../../shared/blockJson";
import { paragraphOf } from "../../../shared/noteBlocks";

/** The paragraph of the Citation at `pos`, as the check of its quoted words reads it (#2712). */
export function citationParagraphAt(doc: ProseMirrorNode, pos: number): CitationParagraph | null {
  const at = doc.resolve(pos);
  return at.parent.isTextblock ? paragraphOf(at.parent.toJSON() as NodeJSON, at.index()) : null;
}
