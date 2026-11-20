/**
 * The deck set (#3455): invented decks laid out as an AI often lays them out, each right and with
 * three wrong figures planted, checked against the invented Documents in `documents/`. Stat cards
 * (a label box, a number box and a unit box), tables with a column of two periods ("Passengers
 * 2025 (2024)" with "412,600 (398,100)"), and plain bullet slides, in English and Chinese.
 */
import { para, pptxOf, sp, txBody, xfrm } from "../../tests/helpers/pptx";

/** A stat card: its label above its number, and the number's unit or note below. */
interface Card {
  label: string;
  number: string;
  unit: string;
}

interface Slide {
  title: string;
  cards?: readonly Card[];
  table?: readonly (readonly string[])[];
  bullets?: readonly string[];
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
  layout: "stat cards" | "two periods" | "bullets";
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

/** A slide's shapes as an AI's deck tool would place them on a 16:9 slide. */
function shapesOf(slide: Slide): string {
  const shapes = [
    sp({
      id: 2,
      name: "Title",
      ph: `<p:ph type="title"/>`,
      spPr: xfrm(457200, 250000, 8229600, 600000),
      body: txBody(para(escaped(slide.title))),
    }),
  ];
  let id = 10;
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
