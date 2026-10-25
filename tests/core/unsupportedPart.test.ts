import { describe, expect, test } from "vitest";
import { readJudgement, readVerdict } from "../../src/core/answers/checks/prompt";

describe("What a reply says its Citations cover and don't", () => {
  test("are the phrases on the lines after the reason, whatever the label's markup", () => {
    expect(
      readVerdict(
        "Verdict: unsupported\nThe Passages compare speed, not memory or robustness.\nCovered: the speed comparison\nNot covered: memory and robustness",
      ),
    ).toEqual({
      verdict: "unsupported",
      says: "The Passages compare speed, not memory or robustness.",
      covered: "the speed comparison",
      uncovered: "memory and robustness",
      scope: null,
      topic: null,
      roles: null,
    });
    expect(
      readVerdict(
        "**Verdict:** unsupported\n**Covered:** “速度比较”\n**Not covered:** 内存和鲁棒性。",
      ),
    ).toMatchObject({ covered: "速度比较", uncovered: "内存和鲁棒性" });
    expect(
      readVerdict("Verdict: unsupported\n已涵盖：速度比较\n未涵盖：内存和鲁棒性"),
    ).toMatchObject({
      covered: "速度比较",
      uncovered: "内存和鲁棒性",
    });
  });

  test("never take the place of the reason", () => {
    expect(readVerdict("Verdict: unsupported\nCovered: the speed\nNot covered: memory")).toEqual({
      verdict: "unsupported",
      says: null,
      covered: "the speed",
      uncovered: "memory",
      scope: null,
      topic: null,
      roles: null,
    });
    expect(
      readVerdict("Verdict: unsupported\nNothing here is covered.\nNot covered: memory"),
    ).toMatchObject({ says: "Nothing here is covered.", covered: null, uncovered: "memory" });
  });

  test("read as phrases: no quotes or closing stop, and capitals as written", () => {
    expect(
      readVerdict(
        "Verdict: unsupported\nCovered: “The speed comparison.”\nNot covered: GraphST's memory, TensorFlow and Python runs;",
      ),
    ).toMatchObject({
      covered: "The speed comparison",
      uncovered: "GraphST's memory, TensorFlow and Python runs",
    });
  });

  test.each(["none", "None.", "NOTHING", "N/A", "n/a", "无", "“无。”"])(
    "are none for a side the reply says %j of",
    (said) => {
      expect(
        readVerdict(`Verdict: unsupported\nCovered: ${said}\nNot covered: memory`),
      ).toMatchObject({ covered: null, uncovered: "memory" });
    },
  );

  test("are none when the reply gives none, or one too long to be a phrase", () => {
    expect(readVerdict("Verdict: unsupported")).toEqual({
      verdict: "unsupported",
      says: null,
      covered: null,
      uncovered: null,
      scope: null,
      topic: null,
      roles: null,
    });
    expect(readVerdict("Verdict: unsupported\nNo Passage mentions penguins.")).toEqual({
      verdict: "unsupported",
      says: "No Passage mentions penguins.",
      covered: null,
      uncovered: null,
      scope: null,
      topic: null,
      roles: null,
    });
    expect(readVerdict("Verdict: unsupported\nCovered:\nNot covered: ")).toMatchObject({
      covered: null,
      uncovered: null,
    });
    const long = "x".repeat(200);
    expect(
      readVerdict(`Verdict: unsupported\nCovered: ${long}\nNot covered: memory`),
    ).toMatchObject({
      covered: null,
      uncovered: "memory",
    });
  });

  test("are none for a run of stops and spaces far too long to be a phrase", () => {
    const run = `${".  ".repeat(100_000)}x`;
    expect(readVerdict(`Verdict: unsupported\nCovered: ${run}\nNot covered: memory`)).toMatchObject(
      {
        covered: null,
        uncovered: "memory",
      },
    );
  });

  test("keep the reason only while it is one sentence long", () => {
    expect(
      readVerdict(`Verdict: unsupported\n${"The Documents say little. ".repeat(40)}`),
    ).toMatchObject({
      says: null,
    });
    expect(readVerdict(`Verdict: unsupported\n${"x".repeat(250)}`)?.says).toHaveLength(250);
  });

  test("come with a JSON reply's verdict", () => {
    expect(
      readVerdict(
        '{"verdict": "unsupported", "says": "Not stated.", "covered": "speed", "uncovered": "Memory"}',
      ),
    ).toEqual({
      verdict: "unsupported",
      says: "Not stated.",
      covered: "speed",
      uncovered: "Memory",
      scope: null,
      topic: null,
      roles: null,
    });
  });

  test("a reply's scope is its own line, read apart from the explanation", () => {
    expect(
      readVerdict(
        "Verdict: supported\nScope: wider\nThe agreement says the Employee may work from home [^1].\nCovered: two days a week for the Employee\nNot covered: staff in general",
      ),
    ).toEqual({
      verdict: "supported",
      says: "The agreement says the Employee may work from home.",
      covered: "two days a week for the Employee",
      uncovered: "staff in general",
      scope: "wider",
      topic: null,
      roles: null,
    });
    expect(readVerdict("**Verdict:** supported\n**Scope:** same\nIt says so [^1].")).toMatchObject({
      says: "It says so.",
      scope: "same",
    });
    expect(readVerdict('{"verdict": "supported", "says": "Yes.", "scope": "wider"}')).toMatchObject(
      {
        scope: "wider",
      },
    );
  });

  test("a reply's scope is the field's last word, after the sentence's own word for the party", () => {
    const scopeOf = (line: string) =>
      readVerdict(`Verdict: supported\n${line}\nIt says so.`)?.scope;
    expect(scopeOf("Scope: Staff, wider")).toBe("wider");
    expect(scopeOf("Scope: the Employee, same")).toBe("same");
    expect(scopeOf("Scope: none, same")).toBe("same");
    expect(scopeOf("**Scope:** 员工，wider")).toBe("wider");
    expect(scopeOf("Scope: the same party, wider")).toBe("wider");
    expect(scopeOf("Scope: Staff")).toBeNull();
  });

  test("a reply that ends by repeating its verdict line keeps the fields above it", () => {
    expect(
      readVerdict(
        "Verdict: supported\nScope: 职工, wider\nTopic: found\nRoles: none, same\nCovered: 乙方每周可在家工作两天\nNot covered: 所有职工\n\n合同这样写 [^1]。\n\nVerdict: supported",
      ),
    ).toMatchObject({
      verdict: "supported",
      covered: "乙方每周可在家工作两天",
      uncovered: "所有职工",
      scope: "wider",
      topic: "found",
      roles: "same",
    });
  });

  test("a reply's roles are the field's last word, read apart from the explanation", () => {
    expect(
      readVerdict(
        "Verdict: supported\nScope: the Company, same\nTopic: found\nRoles: the Company must pay / the Company may pay, differs\nThe agreement says the Company may pay [^1].",
      ),
    ).toMatchObject({
      verdict: "supported",
      says: "The agreement says the Company may pay.",
      roles: "differs",
    });
    const rolesOf = (line: string) =>
      readVerdict(`Verdict: supported\n${line}\n文件这样写 [^1]。`)?.roles;
    expect(rolesOf("**Roles:** 乙方为甲方缴纳 / 甲方为乙方缴纳，differs")).toBe("differs");
    expect(rolesOf("Roles: the same party pays / the Tenant pays, same")).toBe("same");
    expect(rolesOf("Roles: none, same")).toBe("same");
    expect(rolesOf("Roles: the Tenant pays")).toBeNull();
    expect(
      rolesOf(
        "Roles: the Tenant may pay / the Tenant may pay, same\nRoles: the Tenant must pay / the Tenant may pay, differs",
      ),
    ).toBe("differs");
    expect(readVerdict("Verdict: supported\nIt says so.")?.roles).toBeNull();
    expect(
      readVerdict('{"verdict": "supported", "says": "Yes.", "roles": "differs"}'),
    ).toMatchObject({ roles: "differs" });
  });
});

describe("What a judgement of a sentence beside its quote says", () => {
  test("is the last “Judgement:” line of a reply that writes the details first, else its first word", () => {
    expect(
      readJudgement(
        "Sentence: on Mondays and Fridays (2 named days)\nQuote: not stated\nJudgement: neither",
      ),
    ).toBe("neither");
    expect(readJudgement("Sentence: 30 days\nQuote: 27 days\n**Judgement:** Conflict")).toBe(
      "conflict",
    );
    expect(readJudgement("same")).toBe("same");
    expect(readJudgement("Sentence: 30 days\nQuote: 27 days")).toBeNull();
    expect(readJudgement("It depends.")).toBeNull();
  });

  test("a supported reply's explanation is still its line", () => {
    expect(readVerdict("Verdict: supported\nThe Document says so [^1].")).toEqual({
      verdict: "supported",
      says: "The Document says so.",
      covered: null,
      uncovered: null,
      scope: null,
      topic: null,
      roles: null,
    });
  });
});
