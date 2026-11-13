/**
 * A sentence check's reply that corrects itself with a later Verdict block (#3029, #3019): the
 * later whole block alone is read; a later Supported after a block that said otherwise stays
 * unread, and a later lowering stands.
 */
import { describe, expect, test } from "vitest";
import { readCheckReply, readVerdict } from "../../src/core/answers/checks/prompt";

const block = (verdict: string, roles = "same", label = "Verdict") =>
  [
    `${label}: ${verdict}`,
    "Absence: no",
    "Scope: none, same",
    "Topic: found",
    `Roles: the table lists / the table lists, ${roles}`,
    "Duty: none / none, same",
    "Condition: none / none, same",
    `Explanation: The table gives it as ${verdict}.`,
    "Evidence: [1]",
  ].join("\n");

describe("A check reply with two Verdict blocks", () => {
  // protects=a reply that says contradicted, then a corrected Supported block, stays unread, as the four table rows of #3019's record did, in English and Chinese labels; fails_when=its later Supported is taken; no_claim=none beyond protects.
  test.each(["Verdict", "结论"])(
    "a later Supported after a block that said otherwise stays unread (%s)",
    (label) => {
      const reply = `${block("contradicted", "same", label)}\n\nCorrection: on re-reading, both values match.\n\n${block("supported", "same", label)}`;
      expect(readVerdict(reply)).toBeNull();
      expect(readCheckReply(reply)).toBeNull();
    },
  );

  // protects=a later Supported whose block differs from the earlier Supported in one field stays unread; fails_when=a field changed between the blocks is ignored; no_claim=none beyond protects.
  test("a later Supported that judged a field otherwise stays unread", () => {
    expect(readCheckReply(`${block("supported", "differs")}\n\n${block("supported")}`)).toBeNull();
  });

  // protects=a later Unsupported or Contradicted after an earlier Supported stands, read from the later block alone, in English and Chinese labels; fails_when=the lowering is lost or mixed with the earlier block's fields; no_claim=none beyond protects.
  test.each([
    ["unsupported", "Verdict"],
    ["contradicted", "结论"],
  ])("a later %s stands (%s)", (lowered, label) => {
    const read = readCheckReply(
      `${block("supported", "same", label)}\n\n${block(lowered, "differs", label)}`,
    );
    expect(read?.verdict).toBe(lowered);
    expect(read?.roles).toBe("differs");
  });

  // protects=a later block that doesn't read whole leaves the reply unread, never half read; fails_when=a broken later block reads; no_claim=none beyond protects.
  test("a later block that doesn't read whole leaves the reply unread", () => {
    expect(readCheckReply(`${block("supported")}\n\nVerdict: not supported`)).toBeNull();
  });

  // protects=one block, and the same block given twice, read as before; fails_when=the corrected-reply rule changes a reply that doesn't correct itself; no_claim=none beyond protects.
  test("one block, or the same one twice, reads as before", () => {
    expect(readCheckReply(block("supported"))).toEqual(readVerdict(block("supported")));
    const twice = `${block("supported")}\n\n${block("supported")}`;
    expect(readCheckReply(twice)?.verdict).toBe("supported");
  });
});
