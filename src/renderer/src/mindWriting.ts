/**
 * Where the assistant is writing each Mind's changes right now (#202), as
 * the core says ("mind.writing"), kept for an editor that opens the Mind
 * while it is being written: a Mind the assistant makes opens just after its
 * first Block goes in. A long selection edited in parts (#2348) says which
 * part it writes too.
 */
import type { EditPart, MindWriting, WritingPlace } from "../../core/api";
import { core } from "./core";

const places = new Map<string, WritingPlace>();
const parts = new Map<string, EditPart>();
const listeners = new Set<(writing: MindWriting) => void>();

core.on("mind.writing", (writing) => {
  if (writing.place) places.set(writing.mindId, writing.place);
  else places.delete(writing.mindId);
  if (writing.part) parts.set(writing.mindId, writing.part);
  else parts.delete(writing.mindId);
  for (const listener of listeners) listener(writing);
});

/** Where the assistant writes next in a Mind, while it does; null when it doesn't. */
export const writingPlaceOf = (mindId: string): WritingPlace | null => places.get(mindId) ?? null;

/** The part of a long selection a Mind's edit writes, while it does; null when it isn't one. */
export const writingPartOf = (mindId: string): EditPart | null => parts.get(mindId) ?? null;

/** Hears each change of where the assistant writes; returns what stops hearing. */
export function onMindWriting(listener: (writing: MindWriting) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
