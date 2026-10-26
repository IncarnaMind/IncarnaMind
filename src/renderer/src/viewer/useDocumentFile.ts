import { useEffect, useState } from "react";
import { loadDocumentBytes, MissingDocumentError, TooLargeDocumentError } from "./documentBytes";

/** A Document's file, read for a view and made into what it shows. */
export type LoadedFile<T> =
  | { kind: "loading" }
  | { kind: "ready"; value: T }
  | { kind: "missing" }
  | { kind: "too-large" }
  | { kind: "failed"; message: string };

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Reads a Document's file from the main process and turns its bytes into what
 * a view shows (`read`, which may throw): read again when the Document changes,
 * as `version` (its contentHash) says.
 */
export function useDocumentFile<T>(
  documentId: string,
  version: string,
  read: (bytes: Uint8Array) => Promise<T> | T,
): LoadedFile<T> {
  const [loaded, setLoaded] = useState<LoadedFile<T>>({ kind: "loading" });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `read` is fixed per view
  useEffect(() => {
    const controller = new AbortController();
    setLoaded({ kind: "loading" });
    loadDocumentBytes(documentId, controller.signal)
      .then(async (bytes) => {
        const value = await read(bytes);
        if (!controller.signal.aborted) setLoaded({ kind: "ready", value });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof MissingDocumentError) setLoaded({ kind: "missing" });
        else if (error instanceof TooLargeDocumentError) setLoaded({ kind: "too-large" });
        else setLoaded({ kind: "failed", message: messageOf(error) });
      });
    return () => controller.abort();
  }, [documentId, version]);
  return loaded;
}
