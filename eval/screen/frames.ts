import { existsSync } from "node:fs";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";

const cjk =
  process.env.INCARNAMIND_SCREEN_CJK_FONT ||
  [
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "C:/Windows/Fonts/msyh.ttc",
  ].find(existsSync);
if (!cjk || !GlobalFonts.registerFromPath(cjk, "ScreenChinese"))
  throw new Error("Set INCARNAMIND_SCREEN_CJK_FONT to an installed Simplified Chinese font.");
interface FrameCase {
  title: string;
  lines: string[];
  question: string;
  expected: string[];
  layout?: "table" | "chart" | "unlabelled" | "diagram" | "blur";
}

export const frames: FrameCase[] = [
  {
    title: "Launch budget",
    lines: [
      "Design and research     £287,000",
      "Distribution     £164,000",
      "Contingency     £42,000",
    ],
    question: "How much is set aside for distribution?",
    expected: ["164,000", "164000", "164k"],
  },
  {
    title: "发货计划",
    lines: ["广州仓到货 180 箱", "成都仓到货 265 箱", "杭州仓到货 314 箱"],
    question: "成都仓将收到多少箱？",
    expected: ["265", "二百六十五"],
  },
  {
    title: "Customer survey",
    lines: [
      "Customers invited   4,075",
      "Completed surveys   2,184",
      "Customers with follow-up   637",
    ],
    question: "How many customers completed the survey?",
    expected: ["2,184", "2184"],
  },
  {
    title: "Expected runway",
    lines: [
      "January projections   14 months",
      "April projections   19 months",
      "July projections   17 months",
    ],
    question: "What was the April runway estimate?",
    expected: ["19", "nineteen"],
  },
  {
    title: "上海试点",
    lines: ["试点门店总数         126 家", "已经开通        93 家", "预计新增        17 家"],
    question: "已经开通几家门店？",
    expected: ["93", "九十三"],
  },
  {
    title: "Returns review",
    lines: ["Original plan      6.3%", "Updated target     4.7%", "Current average     5.2%"],
    question: "What is the updated target for returns?",
    expected: ["4.7", "4.70"],
  },
  {
    title: "客服响应",
    lines: [
      "电话平均等待时间       35 秒",
      "邮件平均回复时间       83 分钟",
      "线上咨询平均等待时间       12 秒",
    ],
    question: "邮件平均多久回复？",
    expected: ["83", "八十三"],
  },
  {
    title: "Delivery schedule",
    lines: [
      "Discovery       12 October",
      "First trial       27 October",
      "General availability       16 November",
    ],
    question: "On which October day does the first trial start?",
    expected: ["27"],
  },
  {
    title: "Quarterly shipments",
    lines: [
      "Region        April       May",
      "Coast         128        256",
      "Inland        175        301",
    ],
    layout: "table",
    question: "How many units went to Inland in May?",
    expected: ["301"],
  },
  {
    title: "门店月报",
    lines: [
      "地区         三月         四月",
      "华东         540         715",
      "华北         385         428",
    ],
    layout: "table",
    question: "华北四月份是多少？",
    expected: ["428", "四百二十八"],
  },
  {
    title: "Capital costs",
    lines: [
      "Item          Budget      Actual",
      "Shelving      21,600      18,950",
      "Forklifts     31,400      32,125",
    ],
    layout: "table",
    question: "What was actual forklift expenditure?",
    expected: ["32,125", "32125"],
  },
  {
    title: "班次人数",
    lines: [
      "班次        周五       周六",
      "白班         67         81",
      "晚班         48         56",
    ],
    layout: "table",
    question: "周五晚班几人？",
    expected: ["48", "四十八"],
  },
  {
    title: "Labelled revenue chart",
    lines: ["North 63%", "South 79%", "West 56%"],
    layout: "chart",
    question: "What percentage is labelled for South?",
    expected: ["79"],
  },
  {
    title: "工厂利用率",
    lines: ["甲厂 62%", "乙厂 83%", "丙厂 71%"],
    layout: "chart",
    question: "乙厂利用率是多少？",
    expected: ["83", "八十三"],
  },
  {
    title: "Training backlog",
    lines: ["Requests completed: 289", "Outstanding requests: 112", "New requests expected: 76"],
    layout: "blur",
    question: "How many training requests are still outstanding?",
    expected: ["112"],
  },
  {
    title: "预算更新",
    lines: ["培训预算：84 万元", "仓储预算：56 万元", "差旅预算：37 万元"],
    layout: "blur",
    question: "差旅预算为多少万元？",
    expected: ["37", "三十七"],
  },
  {
    title: "Quality review",
    lines: [
      "Checked items: 2,917",
      "Items approved for delivery: 2,630",
      "Items retained for review: 287",
    ],
    question: "How many items were retained for review?",
    expected: ["287"],
  },
  {
    title: "志愿者排班",
    lines: ["早班签到：146 人", "午班签到：208 人", "夜班签到：115 人"],
    question: "午班有多少人签到？",
    expected: ["208", "二百零八"],
  },
  {
    title: "Capacity",
    lines: ["A", "B", "C"],
    layout: "unlabelled",
    question: "Which bar is tallest in this chart?",
    expected: ["B"],
  },
  {
    title: "交接流程",
    lines: ["申请", "核对", "签收"],
    layout: "diagram",
    question: "看一下屏幕，申请之后箭头指向哪一步？",
    expected: ["核对"],
  },
];

export function drawFrame(frame: FrameCase) {
  const canvas = createCanvas(1280, 720);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, 1280, 720);
  ctx.fillStyle = "#17253c";
  const family = /\p{Script=Han}/u.test(frame.title) ? "ScreenChinese" : "Arial";
  ctx.font = `bold 48px ${family}`;
  ctx.fillText(frame.title, 70, 92);
  ctx.font = `34px ${family}`;
  frame.lines.forEach((line, i) => {
    if (frame.layout === "chart" || frame.layout === "unlabelled") {
      const x = 190 + i * 300;
      const height =
        (frame.layout === "unlabelled" ? [155, 340, 225][i] : Number(line.match(/\d+/)?.[0]) * 4) ??
        0;
      ctx.fillStyle = "#256985";
      ctx.fillRect(x, 590 - height, 135, height);
      ctx.fillStyle = "#17253c";
      ctx.fillText(line, x, 650);
    } else if (frame.layout === "diagram") {
      const x = 80 + i * 400;
      ctx.strokeStyle = "#256985";
      ctx.lineWidth = 4;
      ctx.strokeRect(x, 280, 220, 110);
      ctx.fillText(line, x + 52, 353);
      if (i < 2) {
        ctx.beginPath();
        ctx.moveTo(x + 230, 334);
        ctx.lineTo(x + 367, 334);
        ctx.lineTo(x + 345, 318);
        ctx.moveTo(x + 367, 334);
        ctx.lineTo(x + 345, 350);
        ctx.stroke();
      }
    } else {
      const y = 215 + i * 125;
      if (frame.layout === "table") {
        ctx.strokeStyle = "#a1b2c1";
        ctx.beginPath();
        ctx.moveTo(60, y + 32);
        ctx.lineTo(1140, y + 32);
        ctx.stroke();
      }
      ctx.fillText(line, 85, y);
    }
  });
  if (frame.layout === "blur") {
    const smaller = createCanvas(800, 450);
    smaller.getContext("2d").drawImage(canvas, 0, 0, 800, 450);
    ctx.drawImage(smaller, 0, 0, 1280, 720);
  }
  const rgb = ctx.getImageData(0, 0, 1280, 720).data;
  const pixels = new Uint8Array(1280 * 720);
  for (let i = 0; i < pixels.length; i++) {
    const j = i * 4;
    pixels[i] = Math.round(
      0.299 * (rgb[j] ?? 0) + 0.587 * (rgb[j + 1] ?? 0) + 0.114 * (rgb[j + 2] ?? 0),
    );
  }
  return {
    picture: { width: 1280, height: 720, pixels },
    image: { bytes: 1280 * 720 * 4, jpeg: () => new Uint8Array(canvas.toBuffer("image/jpeg", 80)) },
  };
}
