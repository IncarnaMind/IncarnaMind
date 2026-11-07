import type { FactReply, MeetingFact, MeetingOverview, OmitReason } from "./factProtocol";

export function createFactLedger() {
  const facts = new Map<string, MeetingFact>();
  const accepted = new Map<string, MeetingFact>();
  const omitted = new Map<string, OmitReason | "changed" | "supersedes">();
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
        if (!accepted.has(id)) omitted.set(id, reply.omittedReasons[id] ?? "metadata");
      }
      invalidFrames += reply.invalidFrames;
      overview ??= reply.overview;
      for (const fact of reply.facts) {
        const before = accepted.get(fact.id);
        if (before) {
          if (facts.has(fact.id) && JSON.stringify(before) !== JSON.stringify(fact))
            omitted.set(fact.id, "changed");
          continue;
        }
        if (fact.supersedes.some((id) => id === fact.id || !facts.has(id))) {
          omitted.set(fact.id, "supersedes");
          continue;
        }
        for (const id of fact.supersedes) {
          facts.delete(id);
          omitted.delete(id);
        }
        accepted.set(fact.id, fact);
        facts.set(fact.id, fact);
        omitted.delete(fact.id);
      }
    },
  };
}
