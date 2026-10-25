import { describe, expect, test } from "vitest";
import { coverageOf, type ShownClaim } from "../../src/renderer/src/editor/claimChecks";

type Scope = { folderId: string | null; widened: boolean };

const claim = (
  state: string,
  at: number,
  scope: Scope = { folderId: "f", widened: false },
): ShownClaim =>
  ({
    from: at,
    to: at + 10,
    shown: { state },
    check: { action: "check-against-documents", scope },
  }) as unknown as ShownClaim;

describe("how the checks cover the Documents (#764)", () => {
  test("says so when more than half of the sentences that got a verdict found nothing", () => {
    const coverage = coverageOf([
      claim("unsupported", 0),
      claim("supported", 20),
      claim("unsupported", 40),
      claim("not-checked", 60),
    ]);
    expect(coverage).toMatchObject({
      mostlyUncovered: true,
      canWiden: true,
      range: { from: 0, to: 50 },
      action: "check-against-documents",
    });
  });

  test("does not at half, with a single sentence, or with none", () => {
    expect(coverageOf([claim("unsupported", 0), claim("supported", 20)]).mostlyUncovered).toBe(
      false,
    );
    expect(coverageOf([claim("unsupported", 0)]).mostlyUncovered).toBe(false);
    expect(coverageOf([]).mostlyUncovered).toBe(false);
  });

  test("offers Check against all Documents only when a check was limited to a Folder", () => {
    const everywhere = { folderId: null, widened: false };
    const widened = { folderId: "f", widened: true };
    const all = coverageOf([
      claim("unsupported", 0, everywhere),
      claim("unsupported", 20, widened),
      claim("supported", 40),
    ]);
    expect(all).toMatchObject({ mostlyUncovered: true, canWiden: false });
  });
});
