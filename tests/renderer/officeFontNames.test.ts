import { describe, expect, it } from "vitest";
import {
  officeFontFamilyList,
  officeFontName,
} from "../../src/renderer/src/viewer/officeFontNames";

describe("the viewer's names for Office's fonts", () => {
  it("names the viewer's own face for each Office font, in any case", () => {
    expect(officeFontName("Segoe UI")).toBe("IncarnaMind Office Segoe UI");
    expect(officeFontName("segoe ui")).toBe("IncarnaMind Office Segoe UI");
    expect(officeFontName("Calibri")).toBe("IncarnaMind Office Calibri");
    expect(officeFontName("Calibri Light")).toBe("IncarnaMind Office Calibri Light");
    expect(officeFontName("CAMBRIA")).toBe("IncarnaMind Office Cambria");
    expect(officeFontName("Aptos")).toBe("IncarnaMind Office Aptos");
    expect(officeFontName("Aptos Display")).toBe("IncarnaMind Office Aptos Display");
    expect(officeFontName("Aptos Narrow")).toBe("IncarnaMind Office Aptos Narrow");
  });

  it("leaves every other font alone, so a document keeps the fonts it names", () => {
    expect(officeFontName("Times New Roman")).toBe("Times New Roman");
    expect(officeFontName("Carlito")).toBe("Carlito");
    expect(officeFontName("Arial")).toBe("Arial");
  });

  it("maps a whole family list, quoting each mapped name and keeping the rest", () => {
    expect(officeFontFamilyList('"Segoe UI", Carlito, sans-serif')).toBe(
      '"IncarnaMind Office Segoe UI", Carlito, sans-serif',
    );
    expect(officeFontFamilyList("'Calibri Light'")).toBe('"IncarnaMind Office Calibri Light"');
    expect(officeFontFamilyList("Times New Roman, serif")).toBe("Times New Roman, serif");
  });
});
