import type { FactReply, MeetingFact, MeetingOverview } from "./factProtocol";

export function createFactLedger() {
  const facts = new Map<string, MeetingFact>();
  const accepted = new Map<string, MeetingFact>();
  const omitted = new Set<string>();
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
    accept(reply: FactReply) {
      for (const id of reply.omittedIds) {
        if (!accepted.has(id)) omitted.add(id);
      }
      invalidFrames += reply.invalidFrames;
      overview ??= reply.overview;
      for (const fact of reply.facts) {
        const before = accepted.get(fact.id);
        if (before) {
          if (facts.has(fact.id) && JSON.stringify(before) !== JSON.stringify(fact))
            omitted.add(fact.id);
          continue;
        }
        if (fact.supersedes.some((id) => id === fact.id || !facts.has(id))) {
          omitted.add(fact.id);
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
