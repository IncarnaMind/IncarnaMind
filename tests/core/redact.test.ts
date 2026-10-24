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

  test("leaves nothing of a quote that isn't closed on its first line, or has an apostrophe inside", () => {
    expect(
      redactMessage('messages.0.content: "Acme plans to buy Beta Corp\nfor 40m" can\'t be taken'),
    ).toBe("messages.0.content: [redacted]");
    expect(
      redactMessage(
        "error parsing tool call: raw='Acme's merger with Beta closes in May', err=invalid character 'A'",
      ),
    ).toBe("error parsing tool call: raw=[redacted]");
    expect(redactMessage("内容不合规：“Acme 计划收购\nBeta 公司”")).toBe("内容不合规：[redacted]");
  });

  test("keeps the apostrophes of ordinary words and the rest of a message with no quote open", () => {
    expect(redactMessage("The model's reply can't be read: 'bad' field")).toBe(
      "The model's reply can't be read: [redacted] field",
    );
    expect(redactMessage("Your credit balance is too low to access the Anthropic API.")).toBe(
      "Your credit balance is too low to access the Anthropic API.",
    );
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
