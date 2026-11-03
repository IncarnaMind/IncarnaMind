import { expectTypeOf, test } from "vitest";
import type {
  CheckContradictionsResult,
  CheckMindResult,
  CheckSentencesResult,
  FindClaimsResult,
  FindMindClaimsResult,
  VerifyClaimsResult,
} from "../../src/core/api";

test("cannot-read belongs only to a direct check against a picked Document", () => {
  expectTypeOf<Extract<CheckSentencesResult, { kind: "cannot-read" }>>().not.toEqualTypeOf<never>();
  expectTypeOf<
    Extract<CheckContradictionsResult, { kind: "cannot-read" }>
  >().toEqualTypeOf<never>();
  expectTypeOf<Extract<CheckMindResult, { kind: "cannot-read" }>>().toEqualTypeOf<never>();
  expectTypeOf<Extract<FindMindClaimsResult, { kind: "cannot-read" }>>().toEqualTypeOf<never>();
  expectTypeOf<Extract<FindClaimsResult, { kind: "cannot-read" }>>().toEqualTypeOf<never>();
  expectTypeOf<Extract<VerifyClaimsResult, { kind: "cannot-read" }>>().toEqualTypeOf<never>();
});
