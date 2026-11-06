/**
 * A development set for an Analysis's figure in a list item (#2584): a list the Answer writes into
 * a Note, or gives in the assistant for the User to add to a Note, bulleted, numbered, nested under
 * an item of its own, or with several figures in one item, most with no full stop after the figure
 * that ends them, as Answers write lists. Written before any run on it, on #2544's made-up
 * Documents, in English and Chinese; a wrong name is another group's or another measure's, a
 * subset or a target. An item's figures are all named rightly or all wrongly, so each case has one
 * answer. No case is one of #2544's sentences.
 */
import {
  wordsFigure as f,
  type WordsCase,
  type WordsFigure,
  type WordsShape,
} from "./analysisFigureWords";

type Row = [
  right: boolean,
  kind: string,
  figures: readonly [WordsFigure, ...WordsFigure[]],
  shape: WordsShape,
  sentence: string,
];

const bullet: WordsShape = { kind: "list", form: "bullet" };
const numbered: WordsShape = { kind: "list", form: "numbered" };
const nested: WordsShape = { kind: "list", form: "nested" };
const several: WordsShape = { kind: "list", form: "several" };
const added = (form: "bullet" | "numbered"): WordsShape => ({ kind: "list", form, added: true });

const RIGHT = "right";
const GROUP = "another group";
const MEASURE = "another measure";
const SUBSET = "subset";
const TARGET = "target";

const EN: readonly Row[] = [
  [
    true,
    RIGHT,
    [f("ferries", "Bayline", "passengers")],
    bullet,
    "- Bayline: total passengers [=1]",
  ],
  [
    true,
    RIGHT,
    [f("bakery", "Birch Lane", "loaves")],
    bullet,
    "- Total loaves at Birch Lane: [=1]",
  ],
  [true, RIGHT, [f("meters", "Hilltop", "usage")], bullet, "- Hilltop's total usage: [=1]"],
  [
    false,
    GROUP,
    [f("ferries", "Bayline", "passengers")],
    bullet,
    "- Cliffside: total passengers [=1]",
  ],
  [false, MEASURE, [f("volunteers", "Kitchen", "hours")], bullet, "- Kitchen: average hours [=1]"],
  [
    false,
    SUBSET,
    [f("parcels", "Westbury", "parcels")],
    bullet,
    "- Westbury's returned parcels: [=1]",
  ],
  [
    true,
    RIGHT,
    [f("ferries", "Dunmore", "passengers")],
    numbered,
    "1. Dunmore carried [=1] passengers in total",
  ],
  [
    true,
    RIGHT,
    [f("bakery", "Cedar Row", "loaves", "max")],
    numbered,
    "2. Cedar Row's highest loaves: [=1]",
  ],
  [
    false,
    TARGET,
    [f("volunteers", "Transport", "hours")],
    numbered,
    "1. Transport's total hours must reach [=1]",
  ],
  [
    true,
    RIGHT,
    [f("parcels", "Northgate", "parcels")],
    nested,
    "- By hub:\n  - Northgate: total parcels [=1]",
  ],
  [
    true,
    RIGHT,
    [f("meters", "Riverbank", "usage")],
    nested,
    "- Water use:\n  - Riverbank's total usage was [=1].",
  ],
  [
    false,
    MEASURE,
    [f("bakery", "Alder Street", "loaves")],
    nested,
    "- By shop:\n  - Alder Street: total takings [=1]",
  ],
  [
    true,
    RIGHT,
    [f("parcels", "Eastfield", "parcels"), f("parcels", "Eastfield", "weight")],
    several,
    "- Eastfield: total parcels [=1], total weight [=2]",
  ],
  [
    true,
    RIGHT,
    [f("volunteers", "Garden", "hours"), f("volunteers", "Garden", "hours", "max")],
    several,
    "- Garden's total hours were [=1], and Garden's highest hours were [=2]",
  ],
  [
    false,
    GROUP,
    [f("meters", "Upper Marsh", "usage", "mean"), f("meters", "Upper Marsh", "usage", "max")],
    several,
    "- Lower Marsh: average usage [=1], highest usage [=2]",
  ],
  [
    true,
    RIGHT,
    [f("bakery", "Dove Yard", "takings")],
    added("bullet"),
    "- Dove Yard: total takings [=1]",
  ],
  [
    true,
    RIGHT,
    [f("parcels", "Southgate", "weight")],
    added("numbered"),
    "1. Southgate's total weight: [=1]",
  ],
  [
    false,
    GROUP,
    [f("volunteers", "Garden", "hours")],
    added("bullet"),
    "- Reading Room: total hours [=1]",
  ],
];

const ZH: readonly Row[] = [
  [true, RIGHT, [f("ferries", "Cliffside", "passengers")], bullet, "- 崖畔航线：乘客人数合计 [=1]"],
  [true, RIGHT, [f("bakery", "Alder Street", "loaves")], bullet, "- 桤木街店面包数量合计：[=1]"],
  [true, RIGHT, [f("meters", "Lower Marsh", "usage")], bullet, "- 下沼片区用水量合计 [=1]"],
  [
    false,
    GROUP,
    [f("ferries", "Eastreach", "passengers")],
    bullet,
    "- 丹莫航线：乘客人数合计 [=1]",
  ],
  [
    false,
    MEASURE,
    [f("volunteers", "Transport", "hours")],
    bullet,
    "- 交通小组：平均服务时长 [=1]",
  ],
  [
    false,
    SUBSET,
    [f("parcels", "Northgate", "parcels")],
    bullet,
    "- 北门枢纽已退回包裹数量合计 [=1]",
  ],
  [
    true,
    RIGHT,
    [f("ferries", "Bayline", "passengers")],
    numbered,
    "1. 海湾航线乘客人数合计为 [=1]",
  ],
  [
    true,
    RIGHT,
    [f("bakery", "Dove Yard", "loaves", "max")],
    numbered,
    "2. 鸽子院店最高面包数量：[=1]",
  ],
  [
    false,
    TARGET,
    [f("volunteers", "Garden", "hours")],
    numbered,
    "1. 园艺小组服务时长合计须达到 [=1]",
  ],
  [
    true,
    RIGHT,
    [f("parcels", "Westbury", "parcels")],
    nested,
    "- 按枢纽：\n  - 西伯枢纽：包裹数量合计 [=1]",
  ],
  [
    true,
    RIGHT,
    [f("meters", "Upper Marsh", "usage")],
    nested,
    "- 用水情况：\n  - 上沼片区用水量合计为 [=1]。",
  ],
  [
    false,
    MEASURE,
    [f("bakery", "Birch Lane", "loaves")],
    nested,
    "- 按门店：\n  - 桦树巷店：营业收入合计 [=1]",
  ],
  [
    true,
    RIGHT,
    [f("parcels", "Southgate", "parcels"), f("parcels", "Southgate", "weight")],
    several,
    "- 南门枢纽：包裹数量合计 [=1]，重量合计 [=2]",
  ],
  [
    true,
    RIGHT,
    [f("volunteers", "Kitchen", "hours"), f("volunteers", "Kitchen", "hours", "max")],
    several,
    "- 厨房小组服务时长合计为 [=1]，厨房小组最高服务时长为 [=2]",
  ],
  [
    false,
    GROUP,
    [f("meters", "Riverbank", "usage", "mean"), f("meters", "Riverbank", "usage", "max")],
    several,
    "- 山顶片区：平均用水量 [=1]，最高用水量 [=2]",
  ],
  [
    true,
    RIGHT,
    [f("bakery", "Cedar Row", "takings")],
    added("bullet"),
    "- 雪松路店：营业收入合计 [=1]",
  ],
  [
    true,
    RIGHT,
    [f("parcels", "Eastfield", "weight")],
    added("numbered"),
    "1. 东田枢纽重量合计：[=1]",
  ],
  [
    false,
    GROUP,
    [f("volunteers", "Kitchen", "hours")],
    added("bullet"),
    "- 阅览小组：服务时长合计 [=1]",
  ],
];

const cases = (language: WordsCase["language"], rows: readonly Row[]): WordsCase[] =>
  rows.map(([right, kind, [figure, ...also], shape, sentence], at) => ({
    name: `${language} list ${right ? "right" : "wrong"} ${at + 1}`,
    language,
    kind,
    right,
    figure,
    ...(also.length > 0 && { also }),
    shape,
    sentence,
  }));

export const FIGURE_LISTS: readonly WordsCase[] = [...cases("en", EN), ...cases("zh-CN", ZH)];
