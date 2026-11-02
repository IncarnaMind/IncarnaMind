import { between, csv, random, utf8 } from "../../inputs";
import type { Task, TaskLanguage } from "../../task";

const NAMES = { en: "Survey comments 2026.csv", zh: "2026年用户调查评论.csv" } as const;
const HEADINGS = { en: ["ID", "Language", "Comment"], zh: ["编号", "语言", "评论"] } as const;
const LANGUAGE = { en: { en: "English", zh: "Chinese" }, zh: { en: "英文", zh: "中文" } } as const;

/**
 * Five themes and how many comments each has; every comment is about exactly one of them, in
 * plain words, so a count by code is exact and a count by eye isn't far off.
 */
const THEMES = {
  price: {
    count: 214,
    en: [
      "Far too expensive for what you get.",
      "The price went up again this year and I'm thinking of leaving.",
      "Good service but the monthly cost is hard to justify.",
      "Please offer a cheaper plan, the price is too high.",
    ],
    zh: [
      "价格太贵了，性价比不高。",
      "今年又涨价了，考虑换别家。",
      "服务不错，但月费太高。",
      "希望有更便宜的套餐，价格偏高。",
    ],
  },
  delivery: {
    count: 187,
    en: [
      "My delivery arrived three days late.",
      "The parcel was left at the wrong address by the courier.",
      "Delivery took over a week, much slower than promised.",
      "Tracking showed delivered but nothing arrived.",
    ],
    zh: [
      "快递晚到了三天。",
      "快递员把包裹送错了地址。",
      "配送花了一个多星期，比承诺的慢很多。",
      "物流显示已签收，但我没收到。",
    ],
  },
  support: {
    count: 163,
    en: [
      "Customer support never answered my email.",
      "Waited 40 minutes on the phone to reach support.",
      "The support agent was rude and didn't solve anything.",
      "Support closed my ticket without fixing the problem.",
    ],
    zh: [
      "客服一直没回复我的邮件。",
      "打客服电话等了四十分钟。",
      "客服态度很差，什么也没解决。",
      "客服没解决问题就把工单关了。",
    ],
  },
  quality: {
    count: 139,
    en: [
      "The product broke after two weeks.",
      "Poor build quality, the handle cracked straight away.",
      "Quality has gone down, the fabric tears easily.",
      "It stopped working after a month of normal use.",
    ],
    zh: [
      "产品用了两周就坏了。",
      "做工质量差，把手一下就裂了。",
      "质量越来越差，面料很容易破。",
      "正常使用一个月就不能用了。",
    ],
  },
  app: {
    count: 97,
    en: [
      "The app crashes every time I open my orders.",
      "Can't log in to the app since the last update.",
      "The app is slow and keeps freezing on checkout.",
      "The app logs me out every day.",
    ],
    zh: [
      "每次打开订单，App 就闪退。",
      "上次更新后 App 登录不了。",
      "App 很卡，结账时总是卡住。",
      "App 每天都把我退出登录。",
    ],
  },
} as const;

type Theme = keyof typeof THEMES;

function comments(): { theme: Theme; language: "en" | "zh"; text: string }[] {
  const next = random(5401);
  const pool = (Object.keys(THEMES) as Theme[]).flatMap((theme) =>
    Array.from({ length: THEMES[theme].count }, () => theme),
  );
  for (let index = pool.length - 1; index > 0; index--) {
    const other = between(next, 0, index);
    [pool[index], pool[other]] = [pool[other] ?? "price", pool[index] ?? "price"];
  }
  return pool.map((theme) => {
    const language = next() < 0.6 ? "en" : "zh";
    const texts = THEMES[theme][language];
    return { theme, language, text: texts[between(next, 0, texts.length - 1)] ?? texts[0] };
  });
}

function inputs(language: TaskLanguage) {
  const rows = comments();
  return {
    files: [
      {
        name: NAMES[language],
        bytes: utf8(
          csv([
            [...HEADINGS[language]],
            ...rows.map((row, index) => [index + 1, LANGUAGE[language][row.language], row.text]),
          ]),
        ),
      },
    ],
    data: { "comments.csv": csv([["theme"], ...rows.map((row) => [row.theme])]) },
  };
}

export const task: Task = {
  id: "L04",
  title: "Themes in survey comments",
  needs: ["P"],
  seed: 5401,
  question: {
    en: "Survey comments 2026.csv has 800 comments from our customer survey, in English and Chinese. What are the main themes? For each theme give how many comments are about it, counted so the count can be reproduced, and quote one comment as an example.",
    zh: "《2026年用户调查评论.csv》里有 800 条用户调查评论，有英文也有中文。主要有哪些主题？请给出每个主题的评论条数（统计方式要能复现），并各引用一条评论作为例子。",
  },
  inputs,
  expect: [
    {
      id: "themes",
      kind: "rows",
      label: "Each theme and its count",
      key: /\b(?:pric(?:e|es|ing)|cost|expensive|deliver(?:y|ies)|shipping|courier|logistics|support|customer service|quality|defects?|app|mobile app)\b|价格|涨价|配送|快递|物流|客服|质量|应用|App/gi,
      aliases: {
        price: /pric|cost|expensive|价格|涨价/i,
        delivery: /deliver|shipping|courier|logistics|配送|快递|物流/i,
        support: /support|customer service|客服/i,
        quality: /quality|defect|质量/i,
        app: /\bapp\b|mobile|应用/i,
      },
      // A count by keywords a model picks may miss a phrasing or two of a theme.
      columns: [{ id: "count", unit: "plain", tolerance: { rel: 0.1 } }],
    },
  ],
  sources: { documents: [NAMES.en] },
};
