import type * as Y from "yjs";

/**
 * A pure function's results for the last `size` inputs it was given, by `key`: a long Note's
 * paragraphs are read again on every change, and all but the one typed in read the same.
 */
export function memoized<Args extends unknown[], Result>(
  size: number,
  key: (...args: Args) => string,
  compute: (...args: Args) => Result,
): (...args: Args) => Result {
  const results = new Map<string, { value: Result }>();
  return (...args: Args) => {
    const id = key(...args);
    const known = results.get(id);
    if (known) {
      // The most recently used goes last, so the oldest is the one to forget.
      results.delete(id);
      results.set(id, known);
      return known.value;
    }
    const value = compute(...args);
    results.set(id, { value });
    if (results.size > size) {
      const oldest = results.keys().next().value;
      if (oldest !== undefined) results.delete(oldest);
    }
    return value;
  };
}

/** A Yjs type, where it sits in its document. */
interface Placed {
  readonly parent: Placed | null;
}

/** What has been read from each top-level Block of a document, by the function that read it. */
interface BlockReads {
  reads: WeakMap<Placed, Map<unknown, unknown>>;
  /** The Blocks the transaction still going on has changed so far, and how many types that was. */
  changing: { transaction: Y.Transaction; types: number; blocks: Set<Placed> } | null;
}

const documents = new WeakMap<Y.Doc, BlockReads>();

/** The top-level Block a changed type is in, or null for a root type itself. */
function blockOf(type: Placed): Placed | null {
  let at = type;
  for (let parent = at.parent; parent !== null; parent = at.parent) {
    if (parent.parent === null) return at;
    at = parent;
  }
  return null;
}

function changedBlocks(transaction: Y.Transaction): Set<Placed> {
  const blocks = new Set<Placed>();
  for (const type of transaction.changed.keys()) {
    const block = blockOf(type);
    if (block) blocks.add(block);
  }
  return blocks;
}

function readsOf(doc: Y.Doc): BlockReads {
  const known = documents.get(doc);
  if (known) return known;
  const made: BlockReads = { reads: new WeakMap(), changing: null };
  // Before the observers run, since they read the Blocks too.
  doc.on("beforeObserverCalls", (transaction) => {
    for (const block of changedBlocks(transaction)) made.reads.delete(block);
    made.changing = null;
  });
  documents.set(doc, made);
  return made;
}

/**
 * Whether the transaction still going on has changed the Block, or made it: what it reads now
 * may change again before the transaction ends, so it isn't kept.
 */
function changingNow(state: BlockReads, block: Y.XmlElement, transaction: Y.Transaction): boolean {
  const item = block._item;
  if (item === null || item.id.clock >= (transaction.beforeState.get(item.id.client) ?? 0))
    return true;
  // A type changed again is already counted, and one made in the transaction counts through the
  // type it was put in, so the Blocks are worked out again only when another type changes.
  const { changing } = state;
  if (changing?.transaction !== transaction || changing.types !== transaction.changed.size)
    state.changing = {
      transaction,
      types: transaction.changed.size,
      blocks: changedBlocks(transaction),
    };
  return state.changing?.blocks.has(block) ?? true;
}

/**
 * `read` of a top-level Block of a Note's document, read again only once a change touches that
 * Block: a long Note is read again on every change, and all but the Blocks it changed read the
 * same. `read` must depend only on the Block; any other element is read each time.
 */
export function perBlock<T>(read: (block: Y.XmlElement) => T): (block: Y.XmlElement) => T {
  return (block) => {
    const doc = block.doc;
    if (doc === null || block.parent?.parent !== null) return read(block);
    const state = readsOf(doc);
    if (doc._transaction && changingNow(state, block, doc._transaction)) return read(block);
    const known = state.reads.get(block);
    if (known?.has(read)) return known.get(read) as T;
    const value = read(block);
    if (known) known.set(read, value);
    else state.reads.set(block, new Map([[read, value]]));
    return value;
  };
}
