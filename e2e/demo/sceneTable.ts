/**
 * The recording's plan, one row for each scene, in the order it runs: what the scene shows in each
 * language, whether the film keeps it, and the feature picture cut from it. The recorder runs the
 * scenes this table lists, and the stills it names, so the film and the pictures come from one
 * plan rather than from each scene's own choice. Nothing here is a model's words: each row names
 * the app's state and the caption the script gives it.
 */
import type { DemoLanguage } from "./documents";
import type { DemoScript } from "./script";
import type { Feature } from "./stills";

export interface SceneRow {
  /** The scene's name, as the recorder marks it and the take logs it. */
  scene: string;
  /** Whether the film keeps its frames; false: it is run for its picture only. */
  film: boolean;
  /** The feature picture this scene captures, if it captures one. */
  still: Feature | null;
  /** The caption the film shows from the scene's first frame; null for none. */
  caption: keyof DemoScript["captions"] | null;
  /** What the scene shows, as the README's card says it, in each language. */
  shows: Readonly<Record<DemoLanguage, string>>;
}

export const SCENE_TABLE: readonly SceneRow[] = [
  {
    scene: "hook",
    film: true,
    still: null,
    caption: "hook",
    shows: {
      en: "The paper says 36.8%; the Q3 results say 38.6%, and the figure is marked Contradicted with its card open.",
      "zh-CN": "报告里写 36.8%，Q3 业绩里是 38.6%，这个数字被标为“与文档矛盾”，卡片打开着。",
    },
  },
  {
    scene: "organize",
    film: true,
    still: "sort",
    caption: "organize",
    shows: {
      en: "Both linked folders are read; Organize suggests a Folder and Tags for each new Document, and one click accepts them.",
      "zh-CN": "关联的两个文件夹都已读入；“整理”为每个新文件建议文件夹和标签，一键全部接受。",
    },
  },
  {
    scene: "ask",
    film: false,
    still: "ask",
    caption: "ask",
    shows: {
      en: "An Answer about the covenant, with its Citations; one Citation opens its page with the quote lit up.",
      "zh-CN": "关于杠杆率条款的回答带着引用；点开一条引用，原页上的引文亮起来。",
    },
  },
  {
    scene: "add to note",
    film: true,
    still: "write",
    caption: "addToNote",
    shows: {
      en: "The Answer goes into the paper as grey AI text with its Undo line.",
      "zh-CN": "回答作为灰色 AI 文字进入报告，带撤销提示。",
    },
  },
  {
    scene: "analyse",
    film: true,
    still: "analyse",
    caption: "chart",
    shows: {
      en: "Python Analysis checks the workbook's 2026 totals by region; the paper gets the cited table and a bar chart, one bar's source open.",
      "zh-CN":
        "Python 数据分析核对工作簿里 2026 年各地区销售额；报告里出现带引用的表格和柱状图，打开一根柱子的来源。",
    },
  },
  {
    scene: "check",
    film: true,
    still: "check",
    caption: "check",
    shows: {
      en: "The whole paper checked at once; the figure the sources contradict is marked and its card opens.",
      "zh-CN": "整份报告一次核对；与来源矛盾的数字被标出，卡片打开。",
    },
  },
  {
    scene: "formula",
    film: true,
    still: null,
    caption: "working",
    shows: {
      en: "The calculated figure's card shows its formula and the page each input came from.",
      "zh-CN": "计算出来的数字，卡片给出算式和每个输入来自哪一页。",
    },
  },
  {
    scene: "compare",
    film: false,
    still: "compare",
    caption: "compare",
    shows: {
      en: "Compare Documents fills one table across the term sheets, every cell cited.",
      "zh-CN": "“对比文档”把三份条款清单填进一张表，每个单元格都有引用。",
    },
  },
  {
    scene: "export",
    film: true,
    still: "export",
    caption: "export",
    shows: {
      en: "The paper saved as Word; the Saved line, then the file's footnotes in the viewer.",
      "zh-CN": "报告导出为 Word；先是保存提示，再是查看器里文件自己的脚注。",
    },
  },
  {
    scene: "call",
    film: true,
    still: "meet",
    caption: "call",
    shows: {
      en: "An expert interview with the guide among the Documents: A follow-up question, then Not covered yet, its lines cited to the guide.",
      "zh-CN": "专家访谈，提纲就在资料库里：先“追问一个问题”，再“还没问到的”，每一点都引用提纲。",
    },
  },
  {
    scene: "notes",
    film: true,
    still: null,
    caption: "callNotes",
    shows: {
      en: "After Stop, the notes fill in from the transcript, each point citing a time; one citation opens its transcript line.",
      "zh-CN": "停止后，纪要按转写补全，每一点都标出时间；点开一条引用，显示对应的转写行。",
    },
  },
  {
    scene: "end card",
    film: true,
    still: null,
    caption: null,
    shows: {
      en: "The README's first line, free and open source on macOS, Windows and Linux, and the address.",
      "zh-CN": "README 的第一句，免费开源、macOS／Windows／Linux，以及地址。",
    },
  },
];

/** The scenes the film keeps, in order. */
export const FILMED_SCENES = SCENE_TABLE.filter((row) => row.film).map((row) => row.scene);

/** A row's name, for a scene that has none in the table: the recorder asks the table, never itself. */
export function sceneRow(name: string): SceneRow {
  const row = SCENE_TABLE.find((each) => each.scene === name);
  if (!row) throw new Error(`The scene table has no “${name}”.`);
  return row;
}
