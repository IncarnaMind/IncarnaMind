import { decodeVector } from "../documents/vectors";
import type { Database } from "../storage";
import { meanVector, wordVectors } from "./plan";

/** How many Passages make a Document's word vector, and its mean of vectors. */
export const VECTOR_PASSAGES = 30;

export interface VectorSubject {
  id: string;
  name: string;
  status: string;
  embedding_model: string | null;
}

/**
 * Each readable Document's vector: the search embeddings when every one has them from the
 * model in use, else its words. Never the two mixed.
 */
export function storedDocumentVectors(
  db: Database,
  subjects: readonly VectorSubject[],
  embedding?: { enabled(): boolean; readonly id: string },
): Float32Array[] {
  const embedded =
    embedding?.enabled() &&
    subjects.every((each) => each.status === "ready" && each.embedding_model === embedding.id);
  if (embedded) {
    const vectors = subjects.map((each) =>
      meanVector(
        db
          .all<{ embedding: Uint8Array }>(
            `SELECT embedding FROM passages WHERE document_id = ? AND deleted_at IS NULL
               AND embedding IS NOT NULL ORDER BY position LIMIT ?`,
            [each.id, BigInt(VECTOR_PASSAGES)],
          )
          .map((row) => decodeVector(row.embedding)),
      ),
    );
    if (vectors.every((vector) => vector !== null)) return vectors as Float32Array[];
  }
  return wordVectors(
    subjects.map((each) =>
      [
        each.name,
        ...db
          .all<{ text: string }>(
            "SELECT text FROM passages WHERE document_id = ? AND deleted_at IS NULL ORDER BY position LIMIT ?",
            [each.id, BigInt(VECTOR_PASSAGES)],
          )
          .map((row) => row.text),
      ].join("\n"),
    ),
  );
}
