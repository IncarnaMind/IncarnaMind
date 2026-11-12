import * as Y from "yjs";
import { KEYED_MARKS, markKeyOf } from "../shared/markKeys";

/**
 * Moves each check, comment and assistant's change a Note saved before kept under its mark's name
 * to the key of its own (#2996), wherever the old key comes back: a Note opened, a Checkpoint
 * restored. True when it moved any; a Note with none is left untouched, so a second pass writes
 * nothing.
 */
export function keyMarks(blocks: Y.XmlFragment): boolean {
  let moved = false;
  const visit = (node: Y.XmlElement | Y.XmlText | Y.XmlHook) => {
    if (node instanceof Y.XmlElement) {
      for (const child of node.toArray()) visit(child);
      return;
    }
    if (!(node instanceof Y.XmlText)) return;
    const old: { at: number; length: number; formats: Record<string, unknown> }[] = [];
    let at = 0;
    for (const run of node.toDelta() as {
      insert: unknown;
      attributes?: Record<string, unknown>;
    }[]) {
      const length = typeof run.insert === "string" ? run.insert.length : 1;
      const formats: Record<string, unknown> = {};
      for (const name of KEYED_MARKS) {
        const value = run.attributes?.[name];
        const id = typeof value === "object" && value !== null && "id" in value ? value.id : null;
        if (typeof id !== "string" || id === "") continue;
        formats[name] = null;
        formats[markKeyOf(name, id)] = value;
      }
      if (Object.keys(formats).length > 0) old.push({ at, length, formats });
      at += length;
    }
    for (const { at: from, length, formats } of old) {
      node.format(from, length, formats);
      moved = true;
    }
  };
  for (const node of blocks.toArray()) visit(node);
  return moved;
}
