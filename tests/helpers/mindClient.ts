import { onTestFinished } from "vitest";
import * as Y from "yjs";
import { type CoreBridge, MIND_CONTENT_FIELD } from "../../src/core";

/** Marks changes that came from the core, so the client doesn't send them back. */
const FROM_CORE = Symbol("from the core");

export interface MindClient {
  doc: Y.Doc;
  /** The Mind's Blocks, as the editor binds to them. */
  blocks: Y.XmlFragment;
  /** Holds this client's changes back and stops taking in the core's, as if the client went offline. */
  goOffline(): void;
  /** Takes in what the core pushed meanwhile, sends what this client held back, and waits for the core. */
  goOnline(): Promise<void>;
  /** Waits until the core has taken every change this client sent. */
  settled(): Promise<void>;
}

/**
 * Connects a Yjs client to a Mind through the core's public interface, the way
 * the editor does: open the Mind, send local changes, apply the core's pushes.
 */
export async function connectToMind(core: CoreBridge, mindId: string): Promise<MindClient> {
  const doc = new Y.Doc();
  const sent: Promise<void>[] = [];
  let offline: { outgoing: Uint8Array[]; incoming: Uint8Array[] } | null = null;

  const send = (update: Uint8Array) => {
    sent.push(core.applyMindUpdate(mindId, update));
  };
  core.on("mind.update", (event) => {
    if (event.mindId !== mindId) return;
    if (offline) offline.incoming.push(event.update);
    else Y.applyUpdate(doc, event.update, FROM_CORE);
  });
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === FROM_CORE) return;
    if (offline) offline.outgoing.push(update);
    else send(update);
  });

  const { state } = await core.openMind(mindId);
  Y.applyUpdate(doc, state, FROM_CORE);

  const settled = async () => {
    await Promise.all(sent);
  };
  return {
    doc,
    blocks: doc.getXmlFragment(MIND_CONTENT_FIELD),
    goOffline() {
      offline ??= { outgoing: [], incoming: [] };
    },
    async goOnline() {
      if (!offline) return;
      const { outgoing, incoming } = offline;
      offline = null;
      for (const update of incoming) Y.applyUpdate(doc, update, FROM_CORE);
      for (const update of outgoing) send(update);
      await settled();
    },
    settled,
  };
}

/** Appends a paragraph holding `text`, the way Tiptap stores one. */
export function appendParagraph(client: MindClient, text: string): void {
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.insert(0, [new Y.XmlText(text)]);
  client.blocks.push([paragraph]);
}

/** Types `text` into the paragraph at `index`, `offset` characters in. */
export function typeInto(client: MindClient, index: number, offset: number, text: string): void {
  const paragraph = client.blocks.get(index);
  const content = paragraph instanceof Y.XmlElement ? paragraph.get(0) : undefined;
  if (!(content instanceof Y.XmlText)) throw new Error(`Block ${index} isn't a paragraph.`);
  content.insert(offset, text);
}

/**
 * A window's copy of the Mind in `doc`, kept in step as the core keeps a window's copy: each gets
 * the other's changes only as encoded updates, so each holds only what an update carries.
 */
export function copyInStep(doc: Y.Doc): Y.Doc {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc), doc);
  copy.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== doc) Y.applyUpdate(doc, update, copy);
  });
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== copy) Y.applyUpdate(copy, update, doc);
  });
  onTestFinished(() => copy.destroy());
  return copy;
}
