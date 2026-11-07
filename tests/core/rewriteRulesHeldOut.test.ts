import { describe, expect, test } from "vitest";
import type { Citation } from "../../src/core";
import { rewriteOf } from "../../src/core/answers/checks/rewrite";
import { REWRITE_RULE_CASES } from "../helpers/rewriteRulesHeldOut";

const quoted = (quote: string): Citation => ({
  passageId: "passage-held-out",
  documentId: "held-out",
  documentName: "Held-out terms",
  contentHash: "hash-held-out",
  pageFrom: null,
  pageTo: null,
  location: null,
  quote,
  check: "found",
  checkReason: null,
});

describe("The held-out rewrite rules", () => {
  test.each(REWRITE_RULE_CASES.map((each) => [each.id, each] as const))("%s", (_, each) => {
    expect(rewriteOf(each.sentence, each.reply, quoted(each.quote), () => null).kind).toBe(
      each.kind,
    );
  });
});
