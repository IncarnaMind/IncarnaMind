import { expect, test } from "vitest";
import { statedRoom } from "../../src/core/providers/statedRoom";

// protects=a reply's room is read only when it states both what is left of the key's requests and of its input tokens, as whole counts; a reply that states one, neither, or something that isn't a count states no room; fails_when=a missing or malformed header is read as zero or as plenty, or another service's differently named headers are read as Anthropic's; no_claim=that the service's stated counts are true.
test("a reply states room only with both of Anthropic's remaining counts", () => {
  expect(
    statedRoom({
      "anthropic-ratelimit-requests-remaining": "3999",
      "anthropic-ratelimit-input-tokens-remaining": "1988000",
      "anthropic-ratelimit-output-tokens-remaining": "400000",
    }),
  ).toEqual({ requests: 3999, inputTokens: 1_988_000 });
  expect(
    statedRoom({
      "anthropic-ratelimit-requests-remaining": "0",
      "anthropic-ratelimit-input-tokens-remaining": "0",
    }),
  ).toEqual({ requests: 0, inputTokens: 0 });

  expect(statedRoom(undefined)).toBeNull();
  expect(statedRoom({})).toBeNull();
  expect(statedRoom({ "anthropic-ratelimit-requests-remaining": "3999" })).toBeNull();
  expect(statedRoom({ "anthropic-ratelimit-input-tokens-remaining": "1988000" })).toBeNull();
  expect(
    statedRoom({
      "anthropic-ratelimit-requests-remaining": "",
      "anthropic-ratelimit-input-tokens-remaining": "1988000",
    }),
  ).toBeNull();
  expect(
    statedRoom({
      "anthropic-ratelimit-requests-remaining": "many",
      "anthropic-ratelimit-input-tokens-remaining": "-1",
    }),
  ).toBeNull();
  expect(
    statedRoom({
      "x-ratelimit-remaining-requests": "4999",
      "x-ratelimit-remaining-tokens": "900000",
    }),
  ).toBeNull();
});
