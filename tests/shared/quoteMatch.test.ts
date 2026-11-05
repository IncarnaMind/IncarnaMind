import { describe, expect, test } from "vitest";
import { findQuote, findQuoteInPieces, lostLigatures } from "../../src/shared/quoteMatch";

/** The original text a match covers: one string, or one for each part of a quote with an ellipsis. */
const covered = (text: string, quote: string) => {
  const ranges = findQuote(text, quote);
  if (!ranges) return null;
  const parts = ranges.map((range) => text.slice(range.start, range.end));
  return parts.length === 1 ? parts[0] : parts;
};

describe("finding a quote", () => {
  test("finds it across line breaks and returns the span of the original text", () => {
    const text = "Results\nRevenue grew by ten percent\nin the third quarter, led by exports.";
    expect(covered(text, "Revenue grew by ten percent in the third quarter")).toBe(
      "Revenue grew by ten percent\nin the third quarter",
    );
  });

  test("finds Chinese quotes broken across lines", () => {
    const text = "第一章\n卷积神经网络擅长处理图像。\n循环神经网络擅长处理序列数据。";
    expect(covered(text, "擅长处理图像。循环神经网络")).toBe("擅长处理图像。\n循环神经网络");
  });

  test("maps back through characters NFKC changes", () => {
    const text = "The ﬁrst “quoted” word";
    expect(covered(text, 'first "quoted"')).toBe("ﬁrst “quoted”");
  });

  test("is an exact match: a near miss, or an empty quote, isn't found", () => {
    expect(findQuote("Revenue grew by ten percent.", "Revenue grew by 10 percent")).toBeNull();
    expect(findQuote("Revenue grew.", "Revenue grow")).toBeNull();
    expect(findQuote("Revenue grew.", "Revenue, grew")).toBeNull();
    expect(findQuote("Revenue grew.", "  \n ")).toBeNull();
    expect(findQuote("Revenue grew.", " … ")).toBeNull();
  });

  test("ignores letter case, and maps back to the letters as the text has them", () => {
    const text =
      "In practice we find that if the initial hyper-step sizes are too large,\nthe computation diverges";
    expect(covered(text, "If the initial hyper-step sizes are too large, the computation")).toBe(
      "if the initial hyper-step sizes are too large,\nthe computation",
    );
    expect(covered("ΟΔΟΣ", "οδος")).toBe("ΟΔΟΣ");
  });

  test("reads a reference mark written [^36] as [36], on either side", () => {
    const text = "of value ϵls = 0.1 [36]. This\nhurts perplexity";
    expect(covered(text, "value εls = 0.1 [^36]. This hurts")).toBe(
      "value ϵls = 0.1 [36]. This\nhurts",
    );
    expect(covered("as noted.[^1] Then", "noted.[1] Then")).toBe("noted.[^1] Then");
    expect(findQuote(text, "value εls = 0.1 [^3]. This")).toBeNull();
    expect(findQuote(text, "value εls = 0.1 ^36. This")).toBeNull();
  });

  test("matches a line-end hyphen the quote keeps with a space after it", () => {
    const text = "if the initial hyper-\nstep sizes are too large";
    expect(covered(text, "initial hyper- step sizes")).toBe("initial hyper-\nstep sizes");
    expect(findQuote("the hyper-step sizes", "the hyper- step sizes")).toBeNull();
  });

  test("joins a word split by a soft hyphen at a line end", () => {
    const text = "growth in inter\u00ad\nnational trade";
    expect(covered(text, "international trade")).toBe("inter\u00ad\nnational trade");
    expect(covered("inter\u00adnational", "international")).toBe("inter\u00adnational");
  });

  test("unifies the quote marks and dashes the shared normaliser leaves alone", () => {
    expect(covered("the teamʼs ‹fixed› ones ⸺ here", "the team's 'fixed' ones - here")).toBe(
      "the teamʼs ‹fixed› ones ⸺ here",
    );
  });

  // The cases the retrieval prototype (#21) found in real PDFs.
  test("matches CJK radical look-alikes with the ideographs they stand for", () => {
    // A browser-made PDF encodes 大 and 言 as Kangxi radicals, and 长 as a CJK Radicals Supplement character.
    const text = "⼤型语⾔模型的上下⽂⻓度";
    expect(covered(text, "大型语言模型的上下文长度")).toBe(text);
    expect(covered("大型语言模型", "⼤型语⾔模型")).toBe("大型语言模型");
  });

  test("ignores the spaces pdf.js puts around Latin words and numbers in Chinese", () => {
    const text = "例如 GPT-3 含 1750 亿参数，是一个 大型语言模型。";
    expect(covered(text, "GPT-3含1750亿参数")).toBe("GPT-3 含 1750 亿参数");
    expect(covered(text, "例如GPT-3含1750亿参数,是一个大型语言模型")).toBe(
      "例如 GPT-3 含 1750 亿参数，是一个 大型语言模型",
    );
    expect(covered("统 计 语 言 模 型", "统计语言模型")).toBe("统 计 语 言 模 型");
  });

  test("matches a hyphenated compound broken at a line end, with or without its hyphen", () => {
    const text = "On the WMT 2014 English-\nto-German translation task";
    expect(covered(text, "English-to-German translation")).toBe("English-\nto-German translation");
    expect(covered(text, "Englishto-German")).toBe("English-\nto-German");
  });

  test("matches a word split at a line end, with or without the hyphen", () => {
    const text = "growth in inter-\nnational trade";
    expect(covered(text, "international trade")).toBe("inter-\nnational trade");
    expect(covered(text, "inter-national")).toBe("inter-\nnational");
    expect(findQuote(text, "inter national")).toBeNull();
  });
});

describe("a table's row, with or without the pipes between its cells (#76)", () => {
  const MARKDOWN = [
    "| Item | Weight | Bag | Note |",
    "|------|--------|-----|------|",
    "| Water filter | 0.4 kg | Bag B | Replace the cartridge after 1,000 litres |",
  ].join("\n");
  /** A slide's or a Word file's table row, as stored: its cells separated by tabs. */
  const STORED =
    "Plans by tier\nTier\tBags per month\tPrice\nRegular\t2\t£22.00\nOffice\t6\t£58.00";

  test("a Markdown table's row is found without its pipes, and as written", () => {
    expect(covered(MARKDOWN, "Water filter 0.4 kg Bag B")).toBe("Water filter | 0.4 kg | Bag B");
    expect(covered(MARKDOWN, "| Water filter | 0.4 kg | Bag B |")).toBe(
      "Water filter | 0.4 kg | Bag B",
    );
    expect(covered(MARKDOWN, "Bag B Replace the cartridge")).toBe("Bag B | Replace the cartridge");
  });

  test("a stored row is found with pipes between its cells, as models write rows", () => {
    expect(covered(STORED, "Regular | 2 | £22.00")).toBe("Regular\t2\t£22.00");
    expect(covered(STORED, "| Regular | 2 | £22.00 |")).toBe("Regular\t2\t£22.00");
    expect(covered(STORED, "Regular|2|£22.00")).toBeNull();
  });

  test("a row whose words aren't on the page isn't found, with pipes or without", () => {
    expect(findQuote(MARKDOWN, "Water filter 0.5 kg Bag B")).toBeNull();
    expect(findQuote(MARKDOWN, "Water filter Bag B")).toBeNull();
    expect(findQuote(MARKDOWN, "Water filter | Bag A")).toBeNull();
    expect(findQuote(STORED, "Regular | 3 | £22.00")).toBeNull();
    expect(findQuote(STORED, "Regular | £22.00")).toBeNull();
    expect(findQuote(STORED, "Regular | 2 | £58.00")).toBeNull();
  });

  test("Chinese rows too, whose cells have no spaces around them once read", () => {
    const markdown =
      "| 数据类型 | 存放位置 | 保存期限 | 负责人 |\n|---|---|---|---|\n| 显微图像 | 影像服务器 | 5年 | 王丽华 |";
    expect(covered(markdown, "显微图像 影像服务器 5年 王丽华")).toBe(
      "显微图像 | 影像服务器 | 5年 | 王丽华",
    );
    expect(covered(markdown, "显微图像影像服务器5年")).toBe("显微图像 | 影像服务器 | 5年");
    expect(findQuote(markdown, "显微图像 影像服务器 6年")).toBeNull();
    expect(findQuote(markdown, "显微图像 5年 王丽华")).toBeNull();
    const slide = "线路运营情况\n线路\t车辆数\t日均客流\n9路\t28\t11,300\n26路\t19\t7,450";
    expect(covered(slide, "9路 | 28 | 11,300")).toBe("9路\t28\t11,300");
    expect(findQuote(slide, "9路 | 19 | 11,300")).toBeNull();
  });

  test("a pipe inside a word, or doubled, stays a pipe", () => {
    expect(findQuote("if a|b holds", "if a b holds")).toBeNull();
    expect(covered("if a|b holds", "if a|b holds")).toBe("if a|b holds");
    expect(findQuote("x || y", "x y")).toBeNull();
    expect(covered("x || y", "x || y")).toBe("x || y");
  });
});

describe("a quote with an ellipsis", () => {
  const text = [
    "Where the use of a medicine requires specific testing prior to",
    "prescription, companies can arrange to provide such testing",
    "as a package deal even when the outcome of the testing does",
    "not support the use of the medicine in some of those tested.",
    "Clause 19.1 (18.1) Outcome or Risk Sharing Agreements",
  ].join("\n");

  test("is found part by part, in order, and each part is returned for highlighting", () => {
    expect(
      covered(
        text,
        "companies can arrange to provide such testing... Clause 19.1 (18.1) Outcome or Risk Sharing Agreements",
      ),
    ).toEqual([
      "companies can arrange to provide such testing",
      "Clause 19.1 (18.1) Outcome or Risk Sharing Agreements",
    ]);
    // "…", and a Chinese ellipsis "……", work the same way.
    expect(
      covered(text, "Where the use of a medicine … even when the outcome of the testing"),
    ).toEqual(["Where the use of a medicine", "even when the outcome of the testing"]);
    expect(
      covered(
        "到 2030 年，為所有地⽅的所有⼈消除極端貧窮，⽬前標準按照每天⽣活費不⾜ 1.25 美元計算。",
        "到2030年,為所有地方的所有人消除極端貧窮……目前標準按照每天生活費不足1.25美元計算",
      ),
    ).toEqual([
      "到 2030 年，為所有地⽅的所有⼈消除極端貧窮",
      "⽬前標準按照每天⽣活費不⾜ 1.25 美元計算",
    ]);
  });

  test("needs every part to have at least 3 words and 15 letters or digits", () => {
    expect(findQuote(text, "Where the use of a medicine ... those tested")).toBeNull();
    expect(findQuote(text, "Where the use of a medicine ... the use of")).toBeNull();
    expect(findQuote(text, "Where the use of a medicine ... of those tested.")).toBeNull();
    const last = text.indexOf("in some of those tested.");
    expect(findQuote(text, "Where the use of a medicine ... in some of those tested.")).toEqual([
      { start: 0, end: 27 },
      { start: last, end: last + 24 },
    ]);
  });

  test("isn't found when the parts are out of order, or one isn't there", () => {
    expect(
      findQuote(text, "Clause 19.1 (18.1) Outcome or Risk ... companies can arrange to provide"),
    ).toBeNull();
    expect(
      findQuote(text, "companies can arrange to provide ... the result of the testing does"),
    ).toBeNull();
  });

  test("a quote with an ellipsis that is in the text as it is matches as a whole", () => {
    expect(covered("for x1, x2, ..., xn in turn", "x1, x2, ..., xn")).toBe("x1, x2, ..., xn");
    expect(covered("Wait… what?", "Wait… what")).toBe("Wait… what");
  });

  test("an ellipsis at the start or end only leaves the rest of the quote to match", () => {
    expect(covered(text, "… some of those tested.")).toBe("some of those tested.");
    expect(covered(text, "Clause 19.1...")).toBe("Clause 19.1");
  });
});

describe("finding a quote across pieces of text", () => {
  test("returns the part of each piece the quote covers", () => {
    const pieces = [
      { text: "Results", breakAfter: true },
      { text: "Revenue grew by ten percent", breakAfter: true },
      { text: "in the third quarter, led by exports.", breakAfter: true },
      { text: "Next page", breakAfter: false },
    ];
    expect(findQuoteInPieces(pieces, "ten percent in the third quarter")).toEqual([
      { piece: 1, start: 16, end: 27 },
      { piece: 2, start: 0, end: 20 },
    ]);
    expect(findQuoteInPieces(pieces, "Results Revenue")).toEqual([
      { piece: 0, start: 0, end: 7 },
      { piece: 1, start: 0, end: 7 },
    ]);
  });

  test("joins pieces without a break directly, as a PDF's text runs on one line", () => {
    const pieces = [{ text: "Reve" }, { text: "nue grew" }];
    expect(findQuoteInPieces(pieces, "Revenue")).toEqual([
      { piece: 0, start: 0, end: 4 },
      { piece: 1, start: 0, end: 3 },
    ]);
    expect(findQuoteInPieces(pieces, "Profit")).toBeNull();
  });

  test("matches across a line-end hyphen between pieces", () => {
    const pieces = [
      { text: "the English-", breakAfter: true },
      { text: "to-German task", breakAfter: true },
    ];
    expect(findQuoteInPieces(pieces, "English-to-German")).toEqual([
      { piece: 0, start: 4, end: 12 },
      { piece: 1, start: 0, end: 9 },
    ]);
  });

  test("returns the parts of a quote with an ellipsis, two in one piece if need be", () => {
    const pieces = [
      { text: "Revenue grew by ten percent in the third quarter,", breakAfter: true },
      { text: "led by exports to Europe and Asia.", breakAfter: true },
    ];
    expect(
      findQuoteInPieces(pieces, "Revenue grew by ten percent … the third quarter, led by exports"),
    ).toEqual([
      { piece: 0, start: 0, end: 27 },
      { piece: 0, start: 31, end: 49 },
      { piece: 1, start: 0, end: 14 },
    ]);
  });
});

describe("a Document whose text lost its f-ligatures", () => {
  /** As JP Morgan's ESG report reads: every "fi", "ff" and "ffi" kept only its "f". */
  const LOST = "The frm's fnancial eforts beneft its ofce and fve nonproft partners. ".repeat(40);
  /** English that keeps them: about a fifth of its "f"s come before "f", "i" or "l". */
  const KEPT =
    "The first financial effort of the office was flawed, so staff found a different flow for the fund. ".repeat(
      40,
    );

  test("shows it in its text: many f's before a letter, hardly any before f, i or l", () => {
    expect(lostLigatures(LOST)).toBe(true);
    expect(lostLigatures(KEPT)).toBe(false);
    // Too few f's to tell, whatever their share.
    expect(lostLigatures("The frm's fnancial eforts.")).toBe(false);
  });

  test("its text matches a quote's ligature letters with the lone f it kept, only when told", () => {
    const text = "the goal to fnance and facilitate more than $2.5 trillion over 10 years";
    const quote = "to finance and facilitate";
    expect(findQuote(text, quote)).toBeNull();
    expect(findQuote(text, quote, { lostLigatures: true })).toEqual([
      {
        start: text.indexOf("to fnance"),
        end: text.indexOf("to fnance") + "to fnance and facilitate".length,
      },
    ]);
    // "office" with its ffi kept as one f, and the same in a sheet's row of numbers.
    expect(
      findQuote("Reduce ofce paper use by 90%", "office paper", { lostLigatures: true }),
    ).not.toBeNull();
    expect(
      findQuote("Ofce\t1,250", "Office 1250", { lostLigatures: true, numbers: true }),
    ).not.toBeNull();
    // A quote as the text reads it is found as it is, either way.
    expect(findQuote(text, "to fnance and", { lostLigatures: true })).not.toBeNull();
  });
});

describe("a quote nested in a quote, in the other kind of mark (#2504)", () => {
  test("single and double quotation marks read as one, in English and Chinese", () => {
    expect(
      covered("The “cooling-off period” lasts 14 days.", "the ‘cooling-off period’ lasts 14 days"),
    ).toBe("The “cooling-off period” lasts 14 days");
    expect(covered("它的“软权重”特性，即这种权重可以改变。", "它的‘软权重’特性，即这种权重")).toBe(
      "它的“软权重”特性，即这种权重",
    );
  });

  test("after a digit in any script, with or without a space, a mark is a measure's: not one for the other", () => {
    expect(findQuote('Leave a 12 " gap at the edge.', "leave a 12 ' gap at the edge")).toBeNull();
    expect(covered('Leave a 12 " gap at the edge.', 'leave a 12 " gap')).toBe('Leave a 12 " gap');
    expect(findQuote('أنبوب قطره ٦" هنا', "أنبوب قطره ٦' هنا")).toBeNull();
    expect(findQuote('पाइप ६" चौड़ा है', "पाइप ६' चौड़ा है")).toBeNull();
    expect(covered('पाइप ६" चौड़ा है', 'पाइप ६" चौड़ा')).toBe('पाइप ६" चौड़ा');
  });

  test("after a digit the marks are inches and feet, or seconds and minutes: not one for the other", () => {
    expect(findQuote('Use a 6" pipe under the road.', "use a 6' pipe under the road")).toBeNull();
    expect(findQuote("Use a 6” pipe under the road.", "use a 6′ pipe under the road")).toBeNull();
    expect(findQuote('The mast stands at 51°30" N.', "the mast stands at 51°30' N")).toBeNull();
    expect(covered('Use a 6" pipe under the road.', 'use a 6" pipe')).toBe('Use a 6" pipe');
  });

  test("a changed word or number, or an added not, still isn't found", () => {
    const text = "The “cooling-off period” lasts 14 days.";
    expect(findQuote(text, "the ‘cooling-off period’ lasts 15 days")).toBeNull();
    expect(findQuote(text, "the ‘cooling-off period’ does not last 14 days")).toBeNull();
    expect(findQuote(text, "the ‘refund period’ lasts 14 days")).toBeNull();
  });
});

describe("which double marks are quotation marks (#2504)", () => {
  test("an ASCII double quote, a double prime, and a ” that closes nothing stay apart from '", () => {
    expect(
      findQuote(
        'The second derivative f"(x) is positive.',
        "the second derivative f'(x) is positive",
      ),
    ).toBeNull();
    expect(
      findQuote(
        "The second derivative f”(x) is positive.",
        "the second derivative f’(x) is positive",
      ),
    ).toBeNull();
    expect(
      findQuote(
        "Run echo '$HOME' to print the word itself.",
        'run echo "$HOME" to print the word itself',
      ),
    ).toBeNull();
    expect(
      findQuote(
        'Filter with WHERE name = "total" on the column.',
        "filter with where name = 'total' on the column",
      ),
    ).toBeNull();
    expect(findQuote('二阶导数f"(x)在区间上为正。', "二阶导数f'(x)在区间上为正")).toBeNull();
    expect(findQuote("管道直径为6”。", "管道直径为6’")).toBeNull();
    // The same marks as the page has are found.
    expect(covered('Run echo "$HOME" to print it.', 'run echo "$HOME" to print it')).toBe(
      'Run echo "$HOME" to print it',
    );
    expect(covered('二阶导数f"(x)在区间上为正。', '二阶导数f"(x)在区间上为正')).toBe(
      '二阶导数f"(x)在区间上为正',
    );
  });

  test("an opening mark after a number and a space is a quote's", () => {
    expect(
      covered(
        "In 2024 “growth” slowed in every region.",
        "in 2024 ‘growth’ slowed in every region",
      ),
    ).toBe("In 2024 “growth” slowed in every region");
    expect(covered("报告说 2024 “增长”放缓了。", "报告说 2024 ‘增长’放缓了")).not.toBeNull();
    expect(
      findQuote(
        "In 2024 “growth” slowed in every region.",
        "in 2025 ‘growth’ slowed in every region",
      ),
    ).toBeNull();
    expect(findQuote("报告说 2024 “增长”放缓了。", "报告说 2025 ‘增长’放缓了")).toBeNull();
  });

  test("a ” after a digit that closes a quote opened before it is a quote's", () => {
    expect(covered("The “Top 10” list is out.", "the ‘Top 10’ list is out")).toBe(
      "The “Top 10” list is out",
    );
    expect(covered("这是“愿景2030”计划的一部分。", "这是‘愿景2030’计划的一部分")).toBe(
      "这是“愿景2030”计划的一部分",
    );
    expect(covered("他称之为「方案3」。", "他称之为‘方案3’")).toBe("他称之为「方案3」");
    expect(findQuote("The “Top 10” list is out.", "the ‘Top 11’ list is out")).toBeNull();
    expect(findQuote("这是“愿景2030”计划的一部分。", "这是‘愿景2035’计划的一部分")).toBeNull();
    expect(findQuote("Use a 6” pipe under the road.", "use a 6’ pipe under the road")).toBeNull();
  });

  test("a ” after a number inside quoted speech is inches or seconds, not the quote's end", () => {
    const fitter = "“Use a 6” pipe under the drive,” the fitter said.";
    expect(findQuote(fitter, "use a 6’ pipe under the drive")).toBeNull();
    expect(findQuote("“He is 5’10” tall,” she said.", "he is 5’10’ tall")).toBeNull();
    expect(
      findQuote("“The lap took 9’58” in all,” he said.", "the lap took 9’58’ in all"),
    ).toBeNull();
    expect(findQuote("他说：“管道直径为6”。”", "管道直径为6’")).toBeNull();
    const german = "„Benutze ein 6” Rohr“, sagte er.";
    expect(findQuote(german, "benutze ein 6’ rohr")).toBeNull();
    expect(covered(german, "‘benutze ein 6” rohr’")).toBe("„Benutze ein 6” Rohr“");
    expect(findQuote("师傅说：“车道下面要用6”的管子。”", "车道下面要用6’的管子")).toBeNull();
    expect(covered(fitter, "use a 6” pipe under the drive")).toBe("Use a 6” pipe under the drive");
    expect(covered(fitter, "‘use a 6” pipe under the drive,’ the fitter said")).toBe(
      "“Use a 6” pipe under the drive,” the fitter said",
    );
    expect(covered("他说：“管道直径为6”。”", "管道直径为6”")).toBe("管道直径为6”");
    expect(findQuote('“Use a 6" pipe,” he said.', "use a 6' pipe")).toBeNull();
    expect(findQuote('他说：“用6"的管子。”', "用6'的管子")).toBeNull();
  });

  test("a ” between a Latin letter and a letter, digit or ( is a prime", () => {
    const derivative = "“The second derivative f”(x) is positive,” he said.";
    expect(findQuote(derivative, "the second derivative f’(x) is positive")).toBeNull();
    expect(covered(derivative, "the second derivative f”(x) is positive")).toBe(
      "The second derivative f”(x) is positive",
    );
  });

  test("a “ alone after a number and a space is inches", () => {
    expect(findQuote("Leave a 12 “ gap at the edge.", "leave a 12 ’ gap at the edge")).toBeNull();
    expect(covered("Leave a 12 “ gap at the edge.", "leave a 12 “ gap at the edge")).toBe(
      "Leave a 12 “ gap at the edge",
    );
  });

  test("a closing mark closes only its own kind of opening mark", () => {
    expect(findQuote("他称之为「方案」。管道直径为6”。", "管道直径为6’")).toBeNull();
    expect(findQuote("Il a dit «non». Un tuyau de 6” ici.", "un tuyau de 6’ ici")).toBeNull();
    expect(findQuote("「安い」と言った。管は6”である。", "管は6’である")).toBeNull();
    expect(
      findQuote("Er nannte es „Plan“. Das Rohr ist 6” breit.", "das rohr ist 6’ breit"),
    ).toBeNull();
    expect(
      findQuote("Er sagte »ja« dazu. Das Rohr ist 6” breit.", "das rohr ist 6’ breit"),
    ).toBeNull();
    expect(covered("他称之为「方案」。管道直径为6”。", "管道直径为6”")).toBe("管道直径为6”");
    expect(covered("Er nannte es „Plan“ dort.", "er nannte es ‘plan’ dort")).toBe(
      "Er nannte es „Plan“ dort",
    );
    expect(covered("Er sagte »ja« dazu.", "er sagte ‘ja’ dazu")).toBe("Er sagte »ja« dazu");
    expect(covered("Powiedział „tak” wczoraj.", "powiedział ‘tak’ wczoraj")).toBe(
      "Powiedział „tak” wczoraj",
    );
    expect(covered("他称之为「方案」和“愿景”。", "和‘愿景’")).toBe("和“愿景”");
    expect(findQuote("他说「方案未定。管道直径为6”。", "管道直径为6’")).toBeNull();
    expect(findQuote("Il a dit « peut-être. Un tuyau de 6” ici.", "un tuyau de 6’ ici")).toBeNull();
    expect(
      covered(
        "“He called it «Plan B» and left,” she said.",
        "‘he called it «plan b» and left,’ she said",
      ),
    ).toBe("“He called it «Plan B» and left,” she said");
  });

  test("a quote's typographic marks match the page's straight ones, guillemets and a leading mark", () => {
    expect(covered('The first "quoted" word is here.', "the first “quoted” word")).toBe(
      'The first "quoted" word',
    );
    expect(covered("Il a dit «non» hier.", "il a dit ‘non’ hier")).toBe("Il a dit «non» hier");
    expect(covered("Il a dit «non» hier.", 'il a dit "non" hier')).toBe("Il a dit «non» hier");
    expect(covered("The “soft weights” property holds.", "‘soft weights’ property holds")).toBe(
      "“soft weights” property holds",
    );
    expect(covered("这是“软权重”特性。", "‘软权重’特性")).toBe("“软权重”特性");
  });
});
