import { describe, expect, test } from "vitest";
import {
  joinCjkLineWraps,
  joinPrintedLines,
  onlyCjkLineWrapChange,
} from "../../src/core/documents/lineWrap";
import { normaliseText } from "../../src/shared/text";

describe("CJK PDF line wraps", () => {
  test("joins the film's digit-to-Han break without a space", () => {
    expect(joinCjkLineWraps("配送成本上升，7\n月起免运费门槛又下调至 40 英镑")).toBe(
      "配送成本上升，7月起免运费门槛又下调至 40 英镑",
    );
  });

  test.each([
    ["7\n月", "7月"],
    ["月\n7", "月7"],
    ["cost\n月", "cost月"],
    ["月\ncost", "月cost"],
    ["，\n7", "，7"],
    ["37.5%\n降至", "37.5%降至"],
    ["か\n7", "か7"],
    ["7\n한", "7 한"],
    ["한\n7", "한 7"],
    ["한\n中", "한中"],
    ["월\n부터", "월부터"],
  ])("joins a wrapped line beside Chinese, Japanese or Korean text: %s", (before, after) => {
    expect(joinCjkLineWraps(before)).toBe(after);
  });

  test("keeps one space beside Hangul where the old text had a space or a break", () => {
    for (const [before, after] of [
      ["7\n월", "7 월"],
      ["월\n7", "월 7"],
      ["배송비는 증가했습니다. 7\n월부터", "배송비는 증가했습니다. 7 월부터"],
    ] as const) {
      expect(joinCjkLineWraps(before)).toBe(after);
      expect(normaliseText(before)).toBe(normaliseText(after));
    }
  });

  test("keeps a break after a sentence or a list item ends", () => {
    for (const text of [
      "第一段结束了。\n第二段开始。",
      "问题？\n回答。",
      "如下：\n1. 第一项",
      "完了！\n下一句",
      "他说：“好。”\n下一段开始。",
      "（见附注）\n下一段开始。",
    ])
      expect(joinCjkLineWraps(text)).toBe(text);
  });

  test("keeps a break between two Latin words, and a blank line", () => {
    expect(joinCjkLineWraps("delivery\ncosts")).toBe("delivery\ncosts");
    expect(joinCjkLineWraps("37.5% a year\nearlier")).toBe("37.5% a year\nearlier");
    expect(joinCjkLineWraps("第一段。\n\n第二段。")).toBe("第一段。\n\n第二段。");
  });

  test.each(["甲\n\n乙", "Latin\n\n月", "甲\n \n乙"])("keeps a blank line's break: %s", (text) =>
    expect(joinCjkLineWraps(text)).toBe(text),
  );

  test("joins beyond the basic plane, and before a closing mark", () => {
    expect(joinCjkLineWraps("𠀀\n月")).toBe("𠀀月");
    expect(joinCjkLineWraps("7\n。")).toBe("7。");
    expect(joinCjkLineWraps("한\n。")).toBe("한。");
  });

  test("recognises only the new join rule, not another text change", () => {
    expect(onlyCjkLineWrapChange("配送成本上升，7\n月起免运费", "配送成本上升，7月起免运费")).toBe(
      true,
    );
    expect(onlyCjkLineWrapChange("配送成本上升，7\n月起免运费", "配送成本上升，8月起免运费")).toBe(
      false,
    );
    expect(onlyCjkLineWrapChange("delivery\ncosts", "delivery costs")).toBe(false);
    expect(onlyCjkLineWrapChange("배송비 7\n월부터", "배송비 7 월부터")).toBe(true);
    expect(onlyCjkLineWrapChange("배송비는\n증가했습니다", "배송비는증가했습니다")).toBe(true);
    expect(onlyCjkLineWrapChange("월부터", "월 부터")).toBe(false);
  });
});

describe("a line the page ended itself", () => {
  /** Lines set one under the other at the left margin, in 11 pt unless given, each ending at `right`. */
  const page = (...lines: { text: string; right: number; size?: number; left?: number }[]) => {
    let baseline = 760;
    return lines.map(({ text, right, size = 11, left = 72 }) => {
      const line = { text, right, size, left, baseline };
      baseline -= Math.round(size * 1.6);
      return line;
    });
  };
  const line = (text: string, right: number, size = 11, left = 72) => ({ text, right, size, left });

  // protects=a title and headings with no full stop keep their lines though each is the size of the text and longer than the line under it (#3288); fails_when=a line is judged by whether the line under it reaches farther, so a title runs into a shorter heading
  test("a line well short of where its block's lines end was ended by the page, whatever the line under it", () => {
    const report = [
      "老旧小区加装电梯情况报告",
      "概述",
      "全市今年共有一百八十六个老旧小区申请加装电梯，其中已经完工的有七十四个。",
      "主要发现",
      "晚间平均每小时到馆的有四十六人，下午为三十一人，周末的人数高于工作日，需要",
      "继续观察到年底，再决定是否推广。",
      "建议",
      "继续试行延长开放时间，并在明年第一季度复查到馆人数，公布每个社区的结果。",
    ];
    const { text, kept } = joinPrintedLines(
      page(...report.map((each) => line(each, 72 + [...each].length * 11))),
    );
    expect(joinCjkLineWraps(text, kept).split("\n")).toEqual([
      report[0],
      report[1],
      report[2],
      report[3],
      `${report[4]}${report[5]}`,
      report[6],
      report[7],
    ]);
  });

  // protects=a line that reaches its block's edge is wrapped though the next line reaches farther, so a sentence is not cut (#3288); fails_when=the next line reaching farther than the line before keeps the break, as "增加一⏎倍" was kept
  test("a line that reaches its measure is wrapped, though the line under it reaches farther", () => {
    const { text, kept } = joinPrintedLines(
      page(
        line("在西元二〇三〇年前，使农村的生产力与小规模粮食生产者的收入增加一", 531, 10),
        line("倍，尤其是妇女、原住民、家族式农夫、牧民与渔夫，包括让他们有安全及公", 542.5, 10),
        line("平的土地、生产资源、知识、财务服务、市场、增值机会以及非农业就业机会", 542.5, 10),
        line("的管道。", 242, 10),
      ),
    );
    expect(joinCjkLineWraps(text, kept)).toBe(
      "在西元二〇三〇年前，使农村的生产力与小规模粮食生产者的收入增加一倍，尤其是妇女、原住民、家族式农夫、牧民与渔夫，包括让他们有安全及公平的土地、生产资源、知识、财务服务、市场、增值机会以及非农业就业机会的管道。",
    );
  });

  // protects=a paragraph the PDF wrapped stays one, however short its last line (#3288); fails_when=the measure is taken from the last line or a line short of the edge by a character is kept
  test("the lines of a wrapped paragraph are joined, its last line short", () => {
    const { text, kept } = joinPrintedLines(
      page(
        line("志愿者每次值班前都要在前台签到，并由值班组长复核当天", 400),
        line("的记录，记录保存至少三年，期间任何人都不得修改或删", 389),
        line("除。", 94),
      ),
    );
    expect(joinCjkLineWraps(text, kept)).toBe(
      "志愿者每次值班前都要在前台签到，并由值班组长复核当天的记录，记录保存至少三年，期间任何人都不得修改或删除。",
    );
  });

  // protects=text set beside a figure is wrapped at the figure, not cut where it ends short of the column (#3288); fails_when=lines narrowed by a figure are measured against the full column and each keeps its break
  test("lines set beside a figure are measured where they end together", () => {
    const { text, kept } = joinPrintedLines(
      page(
        line("自二〇二〇年以来，软件和硬件的进步大大降低了成本，以", 342.4, 12, 43.5),
        line("至于在二〇二三年，训练一个百亿参数的模型的计算成", 342.4, 12, 43.5),
        line("本为七万多小时，而在二〇二〇年，训练一个", 342.4, 12, 43.5),
        line(
          "十五亿参数的模型的成本在八万美元到一百六十万美元之间，自那以来大量资金",
          552.7,
          12,
          43.5,
        ),
        line(
          "投入到越来越大的模型中，例如训练一个五千亿参数的模型花费了八百万美元",
          552.7,
          12,
          43.5,
        ),
        line("以上。", 79.5, 12, 43.5),
      ),
    );
    expect(joinCjkLineWraps(text, kept)).not.toContain("\n");
  });

  // protects=a wrapped paragraph in a second column is joined by its own column's edge, not the page's (#3288); fails_when=a column that ends short of the page's widest line has every wrapped line kept apart
  test("a column is measured by its own lines", () => {
    const left = page(
      line("左栏的第一行文字在这里换行并且继续写到", 200),
      line("下一行，直到这一段结束为止。", 150),
    );
    const right = page(
      line("右栏的文字很长，一直排到页面最右边这里换", 520, 11, 300),
      line("行继续。", 380, 11, 300),
    );
    const { text, kept } = joinPrintedLines([...left, ...right]);
    expect(joinCjkLineWraps(text, kept)).toBe(
      "左栏的第一行文字在这里换行并且继续写到下一行，直到这一段结束为止。\n右栏的文字很长，一直排到页面最右边这里换行继续。",
    );
  });

  test("a heading in a size of its own keeps its break, however far it reaches", () => {
    const { text, kept } = joinPrintedLines(
      page(
        line("北桥社区信托志愿者手册的说明与使用", 400, 16),
        line("志愿者每次值班前都要在前台签到。", 280),
      ),
    );
    expect(joinCjkLineWraps(text, kept)).toBe(
      "北桥社区信托志愿者手册的说明与使用\n志愿者每次值班前都要在前台签到。",
    );
  });

  // protects=before a Latin word, a number or Hangul the page can only break before the whole word, so a line short by that word is still wrapped (#3288); fails_when=a ragged line before a long word is kept apart and cuts its sentence
  test("before a Latin word, a number or Hangul, the word the page couldn't fit is room it left", () => {
    const latin = joinPrintedLines(
      page(
        line("这项议程由联合国于二〇一五年提出，又称", 72 + 19 * 11),
        line(
          "Sustainable Development Goals，共有十七项目标，涵盖贫困、饥饿与健康等。",
          72 + 25 * 11,
        ),
        line("各国须在期限前完成。", 72 + 10 * 11),
      ),
    );
    expect(joinCjkLineWraps(latin.text, latin.kept)).toBe(
      "这项议程由联合国于二〇一五年提出，又称Sustainable Development Goals，共有十七项目标，涵盖贫困、饥饿与健康等。\n各国须在期限前完成。",
    );
    const hangul = joinPrintedLines(
      page(line("배송비는 증가했습니다. 7", 226), line("월부터 물류비가 감소했습니다.", 248)),
    );
    expect(joinCjkLineWraps(hangul.text, hangul.kept)).toBe(
      "배송비는 증가했습니다. 7 월부터 물류비가 감소했습니다.",
    );
  });

  test("a line set at an angle has no edges to measure, and only its size tells", () => {
    const tilted = (text: string, size: number) => ({ text, size, right: 0 });
    expect(
      joinPrintedLines([tilted("志愿者手册", 20), tilted("志愿者每次值班前都要在前台签到。", 11)])
        .text,
    ).toBe("志愿者手册\n志愿者每次值班前都要在前台签到。");
    expect(
      joinPrintedLines([tilted("志愿者每次值班前都要", 11), tilted("在前台签到。", 11)]).text,
    ).toBe("志愿者每次值班前都要在前台签到。");
  });

  test("the page's text names the newline it ended itself, and the wider join keeps that break", () => {
    const { text, kept } = joinPrintedLines(
      page(
        line("北桥社区信托志愿者手册", 193),
        line("志愿者每次值班前都要在前台签到，并由", 270),
        line("值班组长复核当天的记录。", 204),
      ),
    );
    expect(text).toBe(
      "北桥社区信托志愿者手册\n志愿者每次值班前都要在前台签到，并由值班组长复核当天的记录。",
    );
    expect([...kept]).toEqual([11]);
    expect(joinCjkLineWraps(text, kept)).toBe(text);
    expect(joinCjkLineWraps(text)).toBe(
      "北桥社区信托志愿者手册志愿者每次值班前都要在前台签到，并由值班组长复核当天的记录。",
    );
  });

  test("a kept break is one newline, not every line that reads the same", () => {
    const { text, kept } = joinPrintedLines(
      page(
        line("7", 92, 20),
        line("月是单位。", 127),
        line("本季度收入较上年增长，自7", 72 + 13 * 11),
        line("月起收入增长。", 149),
      ),
    );
    expect(text).toBe("7\n月是单位。\n本季度收入较上年增长，自7\n月起收入增长。");
    expect([...kept]).toEqual([1, 7]);
    expect(joinCjkLineWraps(text, kept)).toBe(
      "7\n月是单位。\n本季度收入较上年增长，自7月起收入增长。",
    );
  });

  test("a repeated line beside a blank line keeps only the break the page chose there", () => {
    const { text, kept } = joinPrintedLines(
      page(line("7", 92, 20), line("", 0), line("7", 83), line("月", 94)),
    );
    expect(joinCjkLineWraps(text, kept)).toBe("7\n\n7月");
  });
});
