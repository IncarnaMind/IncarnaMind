import { describe, expect, test } from "vitest";
import {
  cleanShortTitle,
  cutAtWord,
  cutTitle,
  fitName,
  mindName,
  NAME_LENGTH,
  numberedName,
  shortenMiddle,
} from "../../src/shared/naming";

describe("cutting a title", () => {
  test("a short line is kept, without trailing punctuation", () => {
    expect(cutTitle("How much cooler are parks at night?")).toBe(
      "How much cooler are parks at night",
    );
    expect(cutTitle("公园夜间降温多少？")).toBe("公园夜间降温多少");
  });

  test("only the first line counts", () => {
    expect(cutTitle("\n\n  Park cooling  \nsecond line")).toBe("Park cooling");
  });

  test("a short line keeps its last word, even one like the", () => {
    expect(cutTitle("What is the")).toBe("What is the");
  });

  test("a long English line is cut at a word boundary, with no word left hanging", () => {
    const question =
      "How much cooler are large irrigated parks than the surrounding built-up streets during clear windless summer nights?";
    const title = cutTitle(question);
    expect(title).toBe("How much cooler are large irrigated parks");
    expect(question.startsWith(`${title} `)).toBe(true);
  });

  test("a cut falls back to the last clause when what follows it is a half sentence", () => {
    expect(
      cutTitle(
        "How many days of holiday does the employee get, and how much notice after probation?",
      ),
    ).toBe("How many days of holiday does the employee get");
    expect(
      cutTitle(
        "The employee gets 27 days of paid holiday per year, plus bank holidays and the notice period after probation.",
      ),
    ).toBe("The employee gets 27 days of paid holiday per year");
  });

  test("a clause that is too short to be the name is not used", () => {
    expect(
      cutTitle(
        "Yes, but which clauses limit liability for indirect losses under the agreement signed in spring?",
      ),
    ).toBe("Yes, but which clauses limit liability for indirect losses");
  });

  test("no cut ends on a word like the, of, and, plus, than or how", () => {
    for (const word of ["the", "of", "and", "plus", "than", "how"]) {
      const title = cutTitle(`${"abcdefghi ".repeat(5)}${word} ${"z".repeat(30)}`);
      expect(title).toBe("abcdefghi abcdefghi abcdefghi abcdefghi abcdefghi");
    }
  });

  test("a long Chinese line is cut at a word, with none broken", () => {
    const question =
      "在无风晴朗的夏季夜晚大型灌溉公园比周围建成区的街道最多能低多少摄氏度这个差距在白天是否更小".repeat(
        2,
      );
    const title = cutTitle(question);
    expect(Array.from(title).length).toBeLessThanOrEqual(NAME_LENGTH);
    expect(Array.from(title).length).toBeGreaterThan(NAME_LENGTH - 6);
    expect(question.startsWith(title)).toBe(true);
  });

  test("a Chinese cut keeps every word whole, even one that ends in 的, 对, 同 or 成", () => {
    expect(cutAtWord("两份合同对比结果", 6)).toBe("两份合同对比");
    expect(cutAtWord("这项研究的目的是什么", 7)).toBe("这项研究的目的");
    expect(cutAtWord("请总结员工参与情况", 6)).toBe("请总结员工");
    expect(cutAtWord("如何与另一份合同对比", 8)).toBe("如何与另一份合同");
    expect(fitName("飞往成都的航班价格", (text) => Array.from(text).length <= 5)).toBe("飞往成都…");
    expect(fitName("存在行为首都成就人才", (text) => Array.from(text).length <= 5)).toBe(
      "存在行为…",
    );
  });

  test("a long Chinese line is cut at a clause mark, never in the middle of a clause", () => {
    expect(
      cutTitle(
        "员工每年享有二十七天带薪年假，另外还享有法定节假日，试用期结束后双方需要提前一个月书面通知对方，否则视为违约，需要承担相应的赔偿责任并支付违约金。",
      ),
    ).toBe(
      "员工每年享有二十七天带薪年假，另外还享有法定节假日，试用期结束后双方需要提前一个月书面通知对方，否则视为违约",
    );
  });

  test("a Chinese cut drops a whole 以及, 和 or 的 left at its end, and nothing else", () => {
    const body = "夜间降温".repeat(14);
    expect(cutTitle(`${body}公园以及湖泊`)).toBe(`${body}公园`);
    expect(cutTitle(`${body}公园和湖泊`)).toBe(`${body}公园`);
    expect(cutTitle(`${body}公园的湖泊`)).toBe(`${body}公园`);
    expect(cutTitle(`${body}公园目的是什么`)).toBe(`${body}公园目的`);
  });

  test("a hyphenated word is kept whole or left out whole", () => {
    expect(cutAtWord("Hire two full-time employees", 18)).toBe("Hire two full-time");
    expect(cutAtWord("Hire two full-time employees", 14)).toBe("Hire two");
  });

  test("a cut doesn't strip back through words that often end a real phrase", () => {
    expect(cutAtWord("Here is a list of the things you could be asked to do now", 53)).toBe(
      "Here is a list of the things you could be asked to do",
    );
    expect(cutAtWord("Here is a list of the things you could be asked to do now", 52)).toBe(
      "Here is a list of the things you could be asked",
    );
  });

  test("a character outside the basic plane is never split", () => {
    const title = cutTitle("𠮷".repeat(100));
    expect(title).toBe("𠮷".repeat(NAME_LENGTH));
  });

  test("a word longer than the limit is cut inside it", () => {
    expect(cutTitle("x".repeat(100))).toBe("x".repeat(NAME_LENGTH));
  });

  test("a model's short title loses its quotes and full stop", () => {
    expect(cleanShortTitle('"Park cooling at night."\n')).toBe("Park cooling at night");
    expect(cleanShortTitle("「公园夜间降温」")).toBe("公园夜间降温");
    expect(cleanShortTitle("  ")).toBe("");
  });
});

describe("cutting a name for a file", () => {
  test("a long name ends at a word, and a short one is kept", () => {
    const name = "Holiday and notice rules for employees on probation ".repeat(4).trim();
    const cut = cutAtWord(name, 120);
    expect(Array.from(cut).length).toBeLessThanOrEqual(120);
    expect(name.startsWith(`${cut} `)).toBe(true);
    expect(cutAtWord("Short name", 120)).toBe("Short name");
  });
});

describe("fitting a name on one line", () => {
  const room = (characters: number) => (text: string) => Array.from(text).length <= characters;

  test("a name that fits is kept", () => {
    expect(fitName("Tides in Bergen", room(20))).toBe("Tides in Bergen");
  });

  test("a long name is cut at a word and ends with an ellipsis", () => {
    const name = "The employee gets 27 days of paid holiday per year, plus bank holidays";
    expect(fitName(name, room(40))).toBe("The employee gets 27 days of paid…");
    expect(fitName(name, room(32))).toBe("The employee gets 27 days…");
  });

  test("a Chinese name is cut at a word", () => {
    const name = "员工每年享有多少天带薪年假，试用期结束后需要提前多久通知公司";
    expect(fitName(name, room(12))).toBe("员工每年享有多少天带薪…");
  });

  test("a word too long for the line is cut inside it", () => {
    expect(fitName("x".repeat(50), room(10))).toBe(`${"x".repeat(9)}…`);
  });
});

describe("shortening in the middle", () => {
  const ADDRESS =
    "https://www.txcourts.example/opinions/2017/supreme-court/hallmark-builders-v-rio-grande-supply-512-sw3d-101.html";

  test("keeps a text that fits whole", () => {
    expect(shortenMiddle("https://example.com/a", 40)).toBe("https://example.com/a");
  });

  test("keeps the start and the end of a long address, to the length asked", () => {
    const shortened = shortenMiddle(ADDRESS, 40);
    expect(Array.from(shortened)).toHaveLength(40);
    expect(shortened.startsWith("https://www.txcourts")).toBe(true);
    expect(shortened.endsWith("sw3d-101.html")).toBe(true);
    expect(shortened.match(/…/g)).toHaveLength(1);
  });

  test("keeps a file's extension", () => {
    const name = "Summary for the manager of the quarterly review of harbour dues.docx";
    expect(shortenMiddle(name, 40)).toBe("Summary for the mana…f harbour dues.docx");
  });

  test("counts characters, not code units", () => {
    expect(shortenMiddle("🙂".repeat(30), 11)).toBe(`${"🙂".repeat(5)}…${"🙂".repeat(5)}`);
  });

  test("counts a Chinese character as two columns, as it is drawn", () => {
    const name = `${"信贷委员会合同审阅笔记".repeat(4)}.docx`;
    expect(shortenMiddle(name, 40)).toBe("信贷委员会合同审阅笔…会合同审阅笔记.docx");
    expect(shortenMiddle("合同审阅笔记.docx", 40)).toBe("合同审阅笔记.docx");
  });
});

describe("the name of a Mind", () => {
  test("a title the User typed wins over the first line", () => {
    expect(mindName({ title: "Reading list", autoTitle: "Notes on tides" })).toBe("Reading list");
    expect(mindName({ title: "", autoTitle: "Notes on tides" })).toBe("Notes on tides");
    expect(mindName({ title: "", autoTitle: "" })).toBe("");
  });
});

describe("a name another Mind has", () => {
  // protects=a second Mind made from the same Answer reads apart, " 2" then " 3", whatever the case of the name; fails_when=it takes the same name, or numbers a free one; no_claim=none beyond protects.
  test("gets the next free number", () => {
    expect(numberedName("Lease summary", ["Q3 review"])).toBeNull();
    expect(numberedName("Lease summary", ["lease summary"])).toBe("Lease summary 2");
    expect(numberedName("租约总结", ["租约总结", "租约总结 2"])).toBe("租约总结 3");
    expect(numberedName("", [""])).toBeNull();
  });
});
