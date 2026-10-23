import { describe, expect, test } from "vitest";
import { redactMessage } from "../../src/core/redact";

describe("What a log keeps of a message", () => {
  test("is its first line, without what is quoted or shaped like a key", () => {
    expect(
      redactMessage(
        'Bad input "The harbour master\'s code is lantern-42." for key sk-ant-api03-4f9b2c7e1d8a6053b2e9f4c1a7d0e3b5\nsecond line',
      ),
    ).toBe("Bad input [redacted] for key [redacted]");
  });

  describe("given the secrets the run has handled", () => {
    test("takes each out wherever it stands, however short or plain, in or out of quotes", () => {
      const secrets = ["sk-1234", "abcdefghijklmnopqrstuvwxyzabcdef"];
      expect(redactMessage("Authentication failed for key sk-1234", secrets)).toBe(
        "Authentication failed for key [redacted]",
      );
      expect(redactMessage("Bad key abcdefghijklmnopqrstuvwxyzabcdef, sk-1234 too", secrets)).toBe(
        "Bad key [redacted], [redacted] too",
      );
      expect(redactMessage("Bad key abcdefghijklmnopqrstuvwxyzabcdef")).toContain("abcdefghij");
    });

    test("takes out every occurrence, and a key made of characters a pattern would read as syntax", () => {
      const key = "a+b/c.d*e(f)[g]";
      expect(redactMessage(`${key} and again ${key}`, [key])).toBe(
        "[redacted] and again [redacted]",
      );
    });

    test("takes the longer one first when one holds another", () => {
      expect(redactMessage("key abcdefghij here", ["abcdef", "abcdefghij"])).toBe(
        "key [redacted] here",
      );
    });

    test("leaves a value too short to be told from words alone", () => {
      expect(redactMessage("A short word stays", ["short"])).toBe("A short word stays");
    });
  });
});
