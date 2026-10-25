import { describe, expect, test } from "vitest";
import { formatDate, formatShortDate } from "../../src/shared/dates";
import { translate } from "../../src/shared/i18n";
import { shortenMiddle } from "../../src/shared/naming";
import { savedPageSource } from "../../src/shared/webSource";

const ADDRESS =
  "https://www.txcourts.example/opinions/2017/supreme-court/hallmark-builders-v-rio-grande-supply-512-sw3d-101.html";
const THIS_YEAR = new Date().toISOString();
const IN_2017 = "2017-06-02T10:00:00Z";

describe.each(["en", "zh-CN"] as const)("A saved web page's source line, %s", (language) => {
  const t = (
    ...args: Parameters<typeof translate> extends [unknown, ...infer Rest] ? Rest : never
  ) => translate(language, ...args);

  test("on a card shortens the address in the middle and leaves this year out of the date", () => {
    const line = savedPageSource({ address: ADDRESS, savedAt: THIS_YEAR }, language, t, {
      compact: true,
    });
    const expected = {
      en: `Saved web page · ${shortenMiddle(ADDRESS, 40)} · saved ${formatShortDate(THIS_YEAR, language)}`,
      "zh-CN": `保存的网页 · ${shortenMiddle(ADDRESS, 40)} · 保存于 ${formatShortDate(THIS_YEAR, language)}`,
    }[language];
    expect(line).toBe(expected);
    expect(line).not.toContain(ADDRESS);
    expect(line).not.toContain(String(new Date().getFullYear()));
  });

  test("in a record keeps the whole address and gives the year", () => {
    const line = savedPageSource({ address: ADDRESS, savedAt: IN_2017 }, language, t, {
      compact: false,
    });
    const expected = {
      en: `Saved web page · ${ADDRESS} · saved ${formatDate(IN_2017, language)}`,
      "zh-CN": `保存的网页 · ${ADDRESS} · 保存于 ${formatDate(IN_2017, language)}`,
    }[language];
    expect(line).toBe(expected);
    expect(line).toContain("2017");
  });

  test("on a card gives a past year's date its year", () => {
    const line = savedPageSource({ address: ADDRESS, savedAt: IN_2017 }, language, t, {
      compact: true,
    });
    expect(line).toContain("2017");
  });
});
