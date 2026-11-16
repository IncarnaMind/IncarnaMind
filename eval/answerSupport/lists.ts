/**
 * Sentences that state more than their one Citation does (#3020, #2809), over a made-up résumé in
 * English and in Chinese whose jobs and projects each sit under their own line
 * (`tests/fixtures/answers/resume`). Frozen before the first run.
 *
 * - fixture: the six-project sentence the issue reports, in each language, citing one project's line.
 * - held-out: other sentences true by the résumé that cite one line of what they state. An Answer's
 *   check must find the rest in the Answer's scope and pass them.
 * - decoy: the same sentences with one item no Document states (a project, an employer, a figure,
 *   a year). They must never show the green check.
 */
export const LIST_DOCUMENTS = ["Sample resume.md", "示例简历.md"] as const;

export interface ListCase {
  id: string;
  set: "list-fixture" | "list-held-out" | "list-decoy";
  language: "en" | "zh-CN";
  sentence: string;
  /** The Document it cites, and the one line of it the sentence cites. */
  document: string;
  quote: string;
  /** Whether the Documents state all of it: only then may it show the green check. */
  supported: boolean;
}

const EN = "Sample resume";
const ZH = "示例简历";

const CRM =
  "2023.05 to 2024.12 · Example Hospital customer management platform and doctor assistant app";
const CRM_ZH = "2023.05–2024.12 示例医院客户管理平台设计和医生助理 App";
const HEALTH = "2022.03 to now · Example Health Tech Ltd · Senior product designer";
const HEALTH_ZH = "2022.03 至今 · 示例健康科技有限公司 · 高级产品设计师";
const FEVER = "2024.01 to 2024.12 · Sampletown First Hospital fever clinic mini program";
const FEVER_ZH = "2024.01–2024.12 示例市第一医院发热门诊小程序";
const DOCTORS = "The doctor assistant app is used by 180 doctors every working day.";
const DOCTORS_ZH = "医生助理 App 每个工作日有 180 名医生在用。";
const LABS = "2017.06 to 2019.06 · Example Chain Labs · Interaction designer";
const LABS_ZH = "2017.06–2019.06 · 示例链实验室 · 交互设计师";

const listed = (
  id: string,
  set: "fixture" | "held-out" | "decoy",
  language: ListCase["language"],
  sentence: string,
  quote: string,
  supported: boolean,
): ListCase => ({
  id,
  set: `list-${set}`,
  language,
  sentence,
  document: language === "en" ? EN : ZH,
  quote,
  supported,
});

export const LIST_CASES: readonly ListCase[] = [
  listed(
    "list-en-six",
    "fixture",
    "en",
    "The main projects include the Sampletown First Hospital fever clinic mini program, the Example Group management cockpit back office, the Example District epidemic data dashboard, and the Example Hospital customer management platform and doctor assistant app, as well as blockchain projects such as the Example Exchange cross-chain data platform and the Example Bond Link back office.",
    CRM,
    true,
  ),
  listed(
    "list-zh-six",
    "fixture",
    "zh-CN",
    "主要项目包括：示例市第一医院发热门诊小程序、示例集团管理驾驶舱后台、示例区疫情数据大屏、示例医院客户管理平台与医生助理 App，以及示例交易所跨链数据平台、示例债券互联互通后台等区块链项目。",
    CRM_ZH,
    true,
  ),
  listed(
    "list-en-employers",
    "held-out",
    "en",
    "Alex has worked at Example Health Tech Ltd, Example Group and Example Chain Labs.",
    HEALTH,
    true,
  ),
  listed(
    "list-en-hospital",
    "held-out",
    "en",
    "The hospital work covers a fever clinic mini program, a customer management platform and a doctor assistant app.",
    FEVER,
    true,
  ),
  listed(
    "list-en-figures",
    "held-out",
    "en",
    "The doctor assistant app is used by 180 doctors every working day, and the bond back office handled about 900 trades a day at launch.",
    DOCTORS,
    true,
  ),
  listed(
    "list-en-years",
    "held-out",
    "en",
    "Alex joined Example Chain Labs in 2017, moved to Example Group in 2019 and has been at Example Health Tech Ltd since 2022.",
    LABS,
    true,
  ),
  listed(
    "list-zh-employers",
    "held-out",
    "zh-CN",
    "林示例先后在示例健康科技有限公司、示例集团和示例链实验室工作。",
    HEALTH_ZH,
    true,
  ),
  listed(
    "list-zh-hospital",
    "held-out",
    "zh-CN",
    "医院方面的项目有发热门诊小程序、客户管理平台和医生助理 App。",
    FEVER_ZH,
    true,
  ),
  listed(
    "list-zh-figures",
    "held-out",
    "zh-CN",
    "医生助理 App 每个工作日有 180 名医生在用，债券互联互通后台上线时每天处理约 900 笔交易。",
    DOCTORS_ZH,
    true,
  ),
  listed(
    "list-zh-years",
    "held-out",
    "zh-CN",
    "林示例 2017 年加入示例链实验室，2019 年转到示例集团，2022 年起在示例健康科技有限公司工作。",
    LABS_ZH,
    true,
  ),
  listed(
    "decoy-en-project",
    "decoy",
    "en",
    "The main projects include the Sampletown First Hospital fever clinic mini program, the Example Group management cockpit back office, the Example District epidemic data dashboard, and the Example Hospital customer management platform and doctor assistant app, as well as blockchain projects such as the Example Exchange cross-chain data platform and the Example Bank mobile wallet.",
    CRM,
    false,
  ),
  listed(
    "decoy-en-employer",
    "decoy",
    "en",
    "Alex has worked at Example Health Tech Ltd, Example Group and Example Insurance Ltd.",
    HEALTH,
    false,
  ),
  listed(
    "decoy-en-figure",
    "decoy",
    "en",
    "The doctor assistant app is used by 180 doctors every working day, and the bond back office handled about 9,000 trades a day at launch.",
    DOCTORS,
    false,
  ),
  listed(
    "decoy-en-year",
    "decoy",
    "en",
    "Alex joined Example Chain Labs in 2016, moved to Example Group in 2019 and has been at Example Health Tech Ltd since 2022.",
    LABS,
    false,
  ),
  listed(
    "decoy-zh-project",
    "decoy",
    "zh-CN",
    "主要项目包括：示例市第一医院发热门诊小程序、示例集团管理驾驶舱后台、示例区疫情数据大屏、示例医院客户管理平台与医生助理 App，以及示例交易所跨链数据平台、示例银行手机钱包等区块链项目。",
    CRM_ZH,
    false,
  ),
  listed(
    "decoy-zh-employer",
    "decoy",
    "zh-CN",
    "林示例先后在示例健康科技有限公司、示例集团和示例保险有限公司工作。",
    HEALTH_ZH,
    false,
  ),
  listed(
    "decoy-zh-figure",
    "decoy",
    "zh-CN",
    "医生助理 App 每个工作日有 180 名医生在用，债券互联互通后台上线时每天处理约 9,000 笔交易。",
    DOCTORS_ZH,
    false,
  ),
  listed(
    "decoy-zh-year",
    "decoy",
    "zh-CN",
    "林示例 2016 年加入示例链实验室，2019 年转到示例集团，2022 年起在示例健康科技有限公司工作。",
    LABS_ZH,
    false,
  ),
];
