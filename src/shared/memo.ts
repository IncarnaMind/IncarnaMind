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

interface Placed {
  readonly parent: Placed | null;
}

interface BlockReads {
  reads: WeakMap<Placed, Map<unknown, unknown>>;
  /** Transactions whose observers have been called: what they changed is read afresh since. */
  told: WeakSet<Y.Transaction>;
  changing: WeakMap<Y.Transaction, { types: number; deletions: number; blocks: Set<Placed> }>;
}

const documents = new WeakMap<Y.Doc, BlockReads>();

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

function deletionsIn(transaction: Y.Transaction): number {
  let count = 0;
  for (const deleted of transaction.deleteSet.clients.values()) count += deleted.length;
  return count;
}

function readsOf(doc: Y.Doc): BlockReads {
  const known = documents.get(doc);
  if (known) return known;
  const made: BlockReads = { reads: new WeakMap(), told: new WeakSet(), changing: new WeakMap() };
  // Before the observers run, since they read the Blocks too.
  doc.on("beforeObserverCalls", (transaction) => {
    for (const block of changedBlocks(transaction)) made.reads.delete(block);
    made.told.add(transaction);
  });
  documents.set(doc, made);
  return made;
}

/**
 * Whether a transaction whose observers haven't been called yet has changed the Block, or made
 * it: what it reads now isn't kept. That is the one still going on, and one an observer started,
 * which runs at once but is told only once the observers of the one before it are done.
 */
function changingNow(state: BlockReads, block: Y.XmlElement, doc: Y.Doc): boolean {
  for (const transaction of doc._transactionCleanups) {
    if (state.told.has(transaction)) continue;
    const item = block._item;
    if (item === null || item.id.clock >= (transaction.beforeState.get(item.id.client) ?? 0))
      return true;
    // A type changed again is already counted, and one made in the transaction counts through the
    // type it was put in. A deleted type leaves `changed`, so its size alone can come back to an
    // earlier count; deletions only add up.
    const types = transaction.changed.size;
    const deletions = deletionsIn(transaction);
    let known = state.changing.get(transaction);
    if (known?.types !== types || known.deletions !== deletions) {
      known = { types, deletions, blocks: changedBlocks(transaction) };
      state.changing.set(transaction, known);
    }
    if (known.blocks.has(block)) return true;
  }
  return false;
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
    if (changingNow(state, block, doc)) return read(block);
    const known = state.reads.get(block);
    if (known?.has(read)) return known.get(read) as T;
    const value = read(block);
    if (known) known.set(read, value);
    else state.reads.set(block, new Map([[read, value]]));
    return value;
  };
}
