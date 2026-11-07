import type { FactReply, MeetingFact, MeetingOverview, OmitReason } from "./factProtocol";

export function createFactLedger() {
  const facts = new Map<string, MeetingFact>();
  const accepted = new Map<string, MeetingFact>();
  const omitted = new Map<string, OmitReason | "changed" | "supersedes">();
  /** Ids a fact replaced: whether or not they were kept, they don't come back. */
  const retired = new Set<string>();
  let overview: MeetingOverview | null = null;
  let invalidFrames = 0;
  return {
    get facts() {
      return [...facts.values()];
    },
    get overview() {
      return overview;
    },
    get invalidFrames() {
      return invalidFrames;
    },
    omitted(complete: boolean) {
      return omitted.size + (complete && overview === null ? 1 : 0);
    },
    /** How many were left out for each reason, for the log. */
    omittedReasons(complete: boolean): Record<string, number> {
      const counts: Record<string, number> = {};
      for (const reason of omitted.values()) counts[reason] = (counts[reason] ?? 0) + 1;
      if (complete && overview === null) counts.overview = 1;
      return counts;
    },
    accept(reply: FactReply) {
      for (const id of reply.omittedIds) {
        if (!accepted.has(id) && !retired.has(id))
          omitted.set(id, reply.omittedReasons[id] ?? "metadata");
      }
      invalidFrames += reply.invalidFrames;
      overview ??= reply.overview;
      const fresh = reply.facts.filter((fact) => {
        const before = accepted.get(fact.id);
        if (before && facts.has(fact.id) && JSON.stringify(before) !== JSON.stringify(fact))
          omitted.set(fact.id, "changed");
        return !before && !retired.has(fact.id);
      });
      // A fact may replace one written after it in the same reply, or one left out: the ids are
      // read whole, before any fact is kept.
      const known = (id: string) =>
        accepted.has(id) ||
        omitted.has(id) ||
        fresh.some((fact) => fact.id === id) ||
        reply.omittedIds.includes(id);
      const valid = fresh.filter((fact) =>
        fact.supersedes.every((id) => id !== fact.id && known(id)),
      );
      const kept = valid.filter((fact) => !replacesItself(fact, valid));
      for (const fact of fresh) if (!kept.includes(fact)) omitted.set(fact.id, "supersedes");
      const replaced = new Set(kept.flatMap((fact) => fact.supersedes));
      for (const fact of kept) {
        accepted.set(fact.id, fact);
        if (!replaced.has(fact.id)) facts.set(fact.id, fact);
        omitted.delete(fact.id);
      }
      for (const id of replaced) {
        facts.delete(id);
        omitted.delete(id);
        retired.add(id);
      }
    },
  };
}

/** Whether `fact` replaces, through the facts it replaces in `reply`, itself: neither of a loop is kept. */
function replacesItself(fact: MeetingFact, reply: readonly MeetingFact[]): boolean {
  const seen = new Set<string>();
  const next = [...fact.supersedes];
  for (let id = next.pop(); id !== undefined; id = next.pop()) {
    if (id === fact.id) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    next.push(...(reply.find((each) => each.id === id)?.supersedes ?? []));
  }
  return false;
}
