/**
 * The deck set (#3455): invented decks laid out as an AI often lays them out, each right and with
 * three wrong figures planted, checked against the invented Documents in `documents/`. Stat cards
 * (a label box, a number box and a unit box), tables with a column of two periods ("Passengers
 * 2025 (2024)" with "412,600 (398,100)"), plain bullet slides, tables built of separate text boxes
 * and charts drawn from shapes, as agents' own decks are, each with a title in a text box and a
 * page number in text, in English and Chinese.
 */
import { para, pptxOf, sp, txBody, xfrm } from "../../tests/helpers/pptx";

/** A stat card: its label above its number, and the number's unit or note below. */
interface Card {
  label: string;
  number: string;
  unit: string;
}

/** A bar chart drawn from shapes: a rectangle a bar, its value in a box above, its label below. */
interface ShapeChart {
  bars: readonly { label: string; value: string; height: number }[];
}

interface Slide {
  title: string;
  cards?: readonly Card[];
  table?: readonly (readonly string[])[];
  /** A table built of one text box a cell, as agents' decks build them. */
  boxTable?: readonly (readonly string[])[];
  chart?: ShapeChart;
  bullets?: readonly string[];
  /** The title in a text box, not a title placeholder, and the page number in text. */
  page?: string;
}

/** A wrong figure planted in a deck: `from` in its text becomes `to`; `marker` finds its line. */
export interface Plant {
  from: string;
  to: string;
  marker: string;
}

export interface Deck {
  id: string;
  language: "en" | "zh";
  layout: "stat cards" | "two periods" | "bullets" | "box tables" | "shape charts";
  name: string;
  slides: readonly Slide[];
  plants: readonly Plant[];
}

const plant = (from: string, to: string, marker = to): Plant => ({ from, to, marker });

export const DECKS: readonly Deck[] = [
  {
    id: "en-stats",
    language: "en",
    layout: "stat cards",
    name: "Merrow 2025 at a glance",
    slides: [
      {
        title: "Merrow Strait Ferries: 2025 at a glance",
        cards: [
          { label: "Passengers carried", number: "599,900", unit: "passengers in 2025" },
          { label: "Total income", number: "£11.17m", unit: "fares and freight" },
          { label: "Crossings", number: "9,840", unit: "on both routes" },
          { label: "Operating profit", number: "£4.29m", unit: "a 38.4% margin" },
        ],
      },
      {
        title: "Fuel",
        cards: [
          { label: "Fuel burned", number: "3,450", unit: "tonnes of marine gas oil" },
          { label: "Average price", number: "£684", unit: "per tonne" },
          { label: "Fuel cost", number: "£2.36m", unit: "of £6.88m operating costs" },
        ],
      },
    ],
    plants: [plant("599,900", "959,900"), plant("£4.29m", "£2.49m"), plant("3,450", "4,350")],
  },
  {
    id: "en-periods",
    language: "en",
    layout: "two periods",
    name: "Merrow routes",
    slides: [
      {
        title: "Passengers by route",
        table: [
          ["Route", "Passengers 2025 (2024)", "Crossings 2025", "Punctuality 2025"],
          ["West (Harlow Quay to Penvarra)", "412,600 (398,100)", "6,120", "96.2%"],
          ["East (Harlow Quay to Skerran Isle)", "187,300 (191,900)", "3,720", "93.8%"],
        ],
      },
      {
        title: "Vehicles and fares",
        table: [
          ["Route", "Vehicles 2025", "Fare income 2025"],
          ["West", "61,200", "£6.84m"],
          ["East", "22,450", "£2.91m"],
        ],
      },
    ],
    plants: [
      plant("412,600 (398,100)", "421,600 (398,100)", "421,600"),
      plant("187,300 (191,900)", "187,300 (119,900)", "119,900"),
      plant("22,450", "24,250"),
    ],
  },
  {
    id: "en-bullets",
    language: "en",
    layout: "bullets",
    name: "Merrow income and costs",
    slides: [
      {
        title: "Income and costs",
        bullets: [
          "Fare income was £9.75m: West £6.84m and East £2.91m.",
          "Freight brought in £1.42m more.",
          "Operating costs were £6.88m, of which crew £3.10m and fuel £2.36m.",
          "Maintenance cost £0.88m and port dues £0.54m.",
        ],
      },
      {
        title: "Service",
        bullets: [
          "Punctuality was 96.2% on the West route.",
          "Punctuality was 93.8% on the East route.",
          "The fleet burned 3,450 tonnes of marine gas oil.",
        ],
      },
    ],
    plants: [plant("£1.42m", "£1.24m"), plant("£3.10m", "£3.01m"), plant("96.2%", "92.6%")],
  },
  {
    id: "zh-stats",
    language: "zh",
    layout: "stat cards",
    name: "汐澜轮渡经营概览",
    slides: [
      {
        title: "汐澜轮渡 2025 年经营概览",
        cards: [
          { label: "旅客运送", number: "423,300", unit: "人次（2025 年）" },
          { label: "营业收入", number: "7,120", unit: "万元" },
          { label: "营业利润", number: "1,870", unit: "万元，利润率 26.3%" },
          { label: "燃油耗用", number: "2,210", unit: "吨" },
        ],
      },
      {
        title: "成本",
        cards: [
          { label: "营业成本", number: "5,250", unit: "万元" },
          { label: "船员薪酬", number: "2,380", unit: "万元" },
          { label: "燃油", number: "1,540", unit: "万元" },
        ],
      },
    ],
    plants: [plant("423,300", "243,300"), plant("1,870", "1,780"), plant("2,380", "2,830")],
  },
  {
    id: "zh-periods",
    language: "zh",
    layout: "two periods",
    name: "汐澜轮渡分航线",
    slides: [
      {
        title: "分航线客运量",
        table: [
          ["航线", "2025 年旅客（2024 年）", "2025 年车辆"],
          ["A 线（东港至白沙岛）", "268,400（251,700）", "38,600"],
          ["B 线（东港至青屿）", "154,900（160,200）", "12,300"],
        ],
      },
      {
        title: "准点率",
        table: [
          ["航线", "2025 年准点率"],
          ["A 线", "95.4%"],
          ["B 线", "92.1%"],
        ],
      },
    ],
    plants: [
      plant("268,400（251,700）", "286,400（251,700）", "286,400"),
      plant("154,900（160,200）", "154,900（106,200）", "106,200"),
      plant("95.4%", "94.5%"),
    ],
  },
  {
    id: "zh-bullets",
    language: "zh",
    layout: "bullets",
    name: "汐澜轮渡收入与成本",
    slides: [
      {
        title: "收入",
        bullets: [
          "票务收入 A 线 4,120 万元，B 线 2,060 万元，合计 6,180 万元。",
          "货运收入 940 万元。",
          "营业收入合计 7,120 万元。",
        ],
      },
      {
        title: "成本与燃油",
        bullets: [
          "营业成本 5,250 万元，其中燃油 1,540 万元。",
          "全年耗用燃油 2,210 吨。",
          "B 线准点率 92.1%。",
        ],
      },
    ],
    plants: [
      plant("货运收入 940", "货运收入 490", "490"),
      plant("1,540", "1,450"),
      plant("92.1%", "91.2%"),
    ],
  },
  {
    id: "en-boxes",
    language: "en",
    layout: "box tables",
    name: "Merrow Strait Ferries costs and traffic",
    slides: [
      {
        title: "Operating costs, 2025",
        page: "1 / 2",
        boxTable: [
          ["Cost line", "£m", "Share of costs"],
          ["Crew", "3.10", "45.1%"],
          ["Fuel", "2.36", "34.3%"],
          ["Maintenance", "0.88", "12.8%"],
          ["Port dues", "0.54", "7.8%"],
          ["Total", "6.88", "100%"],
        ],
      },
      {
        title: "Traffic by route, 2025",
        page: "2 / 2",
        boxTable: [
          ["Route", "Crossings", "Passengers"],
          ["West", "6,120", "412,600"],
          ["East", "3,720", "187,300"],
          ["Total", "9,840", "599,900"],
        ],
      },
    ],
    plants: [plant("3.10", "3.01"), plant("187,300", "178,300"), plant("9,840", "9,480")],
  },
  {
    id: "zh-boxes",
    language: "zh",
    layout: "box tables",
    name: "汐澜轮渡成本与客运",
    slides: [
      {
        title: "2025 年营业成本",
        page: "1 / 2",
        boxTable: [
          ["成本项目", "万元"],
          ["船员薪酬", "2,380"],
          ["燃油", "1,540"],
          ["维修保养", "820"],
          ["港口费用", "510"],
          ["合计", "5,250"],
        ],
      },
      {
        title: "2025 年分航线客运",
        page: "2 / 2",
        boxTable: [
          ["航线", "旅客（人次）", "车辆（辆次）"],
          ["A 线", "268,400", "38,600"],
          ["B 线", "154,900", "12,300"],
        ],
      },
    ],
    plants: [plant("2,380", "2,830"), plant("5,250", "5,520"), plant("38,600", "36,800")],
  },
  {
    id: "en-chart",
    language: "en",
    layout: "shape charts",
    name: "Merrow Strait Ferries in charts",
    slides: [
      {
        title: "Passengers by route, 2025",
        page: "1 / 2",
        chart: {
          bars: [
            { label: "West", value: "412,600", height: 2400000 },
            { label: "East", value: "187,300", height: 1100000 },
          ],
        },
      },
      {
        title: "Income by line, 2025 (£m)",
        page: "2 / 2",
        chart: {
          bars: [
            { label: "West fares", value: "6.84", height: 2400000 },
            { label: "East fares", value: "2.91", height: 1020000 },
            { label: "Freight", value: "1.42", height: 500000 },
          ],
        },
      },
    ],
    plants: [plant("187,300", "178,300"), plant("2.91", "2.19"), plant("1.42", "1.24")],
  },
  {
    id: "zh-chart",
    language: "zh",
    layout: "shape charts",
    name: "汐澜轮渡图表",
    slides: [
      {
        title: "2025 年分航线旅客（人次）",
        page: "1 / 2",
        chart: {
          bars: [
            { label: "A 线", value: "268,400", height: 2400000 },
            { label: "B 线", value: "154,900", height: 1380000 },
          ],
        },
      },
      {
        title: "2025 年收入构成（万元）",
        page: "2 / 2",
        chart: {
          bars: [
            { label: "A 线票务", value: "4,120", height: 2400000 },
            { label: "B 线票务", value: "2,060", height: 1200000 },
            { label: "货运", value: "940", height: 550000 },
          ],
        },
      },
    ],
    plants: [plant("268,400", "286,400"), plant("2,060", "2,600"), plant("4,120", "4,210")],
  },
];

const escaped = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const textBox = (id: number, name: string, at: readonly number[], lines: readonly string[]) =>
  sp({
    id,
    name,
    txBox: true,
    spPr: xfrm(at[0] ?? 0, at[1] ?? 0, at[2] ?? 0, at[3] ?? 0),
    body: txBody(lines.map((line) => para(escaped(line))).join("")),
  });

function tableFrame(id: number, rows: readonly (readonly string[])[]): string {
  const width = Math.max(1, ...rows.map((row) => row.length));
  const cell = (text: string) =>
    `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${para(escaped(text))}</a:txBody><a:tcPr/></a:tc>`;
  const grid = `<a:gridCol w="${Math.floor(8229600 / width)}"/>`.repeat(width);
  const body = rows
    .map(
      (row) =>
        `<a:tr h="400000">${Array.from({ length: width }, (_, at) => cell(row[at] ?? "")).join("")}</a:tr>`,
    )
    .join("");
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="457200" y="1200000"/><a:ext cx="8229600" cy="${400000 * rows.length}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1"/><a:tblGrid>${grid}</a:tblGrid>${body}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}

/** A bar of a chart drawn from shapes: a filled rectangle with no text. */
const barShape = (id: number, at: readonly number[]) =>
  sp({
    id,
    name: "Rectangle",
    spPr: `${xfrm(at[0] ?? 0, at[1] ?? 0, at[2] ?? 0, at[3] ?? 0)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="2A9D8F"/></a:solidFill>`,
  });

/** A slide's shapes as an AI's deck tool would place them on a 16:9 slide. */
function shapesOf(slide: Slide): string {
  const shapes = [
    slide.page === undefined
      ? sp({
          id: 2,
          name: "Title",
          ph: `<p:ph type="title"/>`,
          spPr: xfrm(457200, 250000, 8229600, 600000),
          body: txBody(para(escaped(slide.title))),
        })
      : textBox(2, "TextBox", [457200, 250000, 8229600, 600000], [slide.title]),
  ];
  if (slide.page !== undefined)
    shapes.push(textBox(3, "TextBox", [8000000, 4700000, 900000, 300000], [slide.page]));
  let id = 10;
  (slide.boxTable ?? []).forEach((row, at) => {
    const width = Math.floor(8229600 / Math.max(1, row.length));
    row.forEach((text, column) => {
      shapes.push(
        textBox(
          id++,
          "TextBox",
          [457200 + column * width, 1200000 + at * 420000, width, 400000],
          [text],
        ),
      );
    });
  });
  const bars = slide.chart?.bars ?? [];
  bars.forEach((bar, at) => {
    const x = 1200000 + at * 2400000;
    const top = 4200000 - bar.height;
    shapes.push(textBox(id++, "TextBox", [x, top - 420000, 1600000, 400000], [bar.value]));
    shapes.push(barShape(id++, [x, top, 1600000, bar.height]));
    shapes.push(textBox(id++, "TextBox", [x, 4250000, 1600000, 400000], [bar.label]));
  });
  (slide.cards ?? []).forEach((card, column) => {
    const x = 457200 + column * 2133600;
    shapes.push(textBox(id++, "Label", [x, 1300000, 1900000, 400000], [card.label]));
    shapes.push(textBox(id++, "Number", [x, 1750000, 1900000, 700000], [card.number]));
    shapes.push(textBox(id++, "Unit", [x, 2500000, 1900000, 500000], [card.unit]));
  });
  if (slide.table) shapes.push(tableFrame(id++, slide.table));
  if (slide.bullets) {
    shapes.push(textBox(id++, "Content", [457200, 1200000, 8229600, 3200000], slide.bullets));
  }
  return shapes.join("");
}

/** A deck as a .pptx, right or with its wrong figures planted, each once, where it first stands. */
export function deckFile(deck: Deck, planted: boolean): Buffer {
  const shapes = deck.slides.map(shapesOf);
  if (planted) {
    for (const each of deck.plants) {
      const at = shapes.findIndex((slide) => slide.includes(escaped(each.from)));
      if (at < 0) throw new Error(`${deck.id}: "${each.from}" isn't in the deck.`);
      shapes[at] = (shapes[at] ?? "").replace(escaped(each.from), escaped(each.to));
    }
  }
  return pptxOf({ slides: shapes.map((slide) => ({ shapes: slide })) });
}
