/**
 * The fix-the-sentence set (#3383): invented Documents, and sentences about them written for each
 * kind of verdict a Note's check gives, each its own line of a Note, some with a Citation of the
 * Document's sentence they rest on. Every Document, name and figure is invented for this
 * repository.
 *
 * What each sentence is written to get (`written`), as the issue's rows name them: a cited
 * sentence with a part its Citation doesn't back (`part`); one number or wording the check can
 * correct (`one-number`); a sentence the Documents say otherwise (`different`); one that goes
 * further than they do (`further`); one nothing in them is about (`not-found`); and one they back
 * (`supported`). What the check then finds is the model's, and counted as it comes.
 */
import type { Language } from "../../src/core/language";

export type Written = "part" | "one-number" | "different" | "further" | "not-found" | "supported";

export interface FixDocument {
  name: string;
  language: Language;
  text: string;
}

export interface FixSentence {
  id: string;
  language: Language;
  /** The Document it is about, by name. */
  document: string;
  text: string;
  /** The Document's own sentence the sentence cites, word for word; none for an uncited one. */
  cites?: string;
  written: Written;
}

const doc = (name: string, language: Language, ...paragraphs: string[]): FixDocument => ({
  name,
  language,
  text: `# ${name}\n\n${paragraphs.join("\n\n")}\n`,
});

const FERRIES = "Harlow Bay Ferries annual review 2025";
const MONITOR = "Kestle K2 air monitor product sheet";
const WATER = "青澜水务2025年度报告摘要";
const LOCK = "云帆K9智能门锁产品说明";

export const FIX_DOCUMENTS: readonly FixDocument[] = [
  doc(
    FERRIES,
    "en",
    "Harlow Bay Ferries carried 1.42 million passengers in 2025, up from 1.31 million in 2024.",
    "The new Eastgate terminal opened in September 2025, six months later than planned.",
    "92% of sailings left within five minutes of their timetabled time.",
    "The board approved a fare rise of 4.5% from April 2026 by five votes to two.",
    "Fuel made up 38% of operating costs. The company runs four vessels on two routes.",
    "| Route | Sailings a day | Crossing (hours) | Demand |\n|---|---:|---:|---|\n| Central | 4 | 3.2 | Medium |\n| North | 6 | 1.5 | High |",
  ),
  doc(
    MONITOR,
    "en",
    "The K2 measures PM2.5 and carbon dioxide every 30 seconds.",
    "Its battery lasts up to 14 hours on a single charge.",
    "The K2 is certified for indoor use only. It costs £189 including VAT.",
  ),
  doc(
    WATER,
    "zh-CN",
    "2025年供水总量为8,640万立方米，较上年增长3.2%。",
    "新建的东区水厂于2025年10月投入运行，比原计划推迟四个月。",
    "管网漏损率由2024年的11.8%降至9.6%。",
    "董事会以七票赞成、两票反对通过了2026年水价调整方案。",
    "公司共有员工1,240人，其中一线运维人员612人。",
    "| 水厂 | 日供水能力（万立方米） | 投运年份 |\n|---|---:|---:|\n| 西区水厂 | 12 | 2009 |\n| 东区水厂 | 15 | 2025 |",
  ),
  doc(
    LOCK,
    "zh-CN",
    "K9支持指纹、密码和NFC三种开锁方式。",
    "电池在正常使用下可用约八个月。",
    "K9仅适用于室内门。建议零售价为1,299元。",
  ),
];

const en = (
  id: string,
  document: string,
  written: Written,
  text: string,
  cites?: string,
): FixSentence => ({ id, language: "en", document, text, written, ...(cites && { cites }) });

const zh = (
  id: string,
  document: string,
  written: Written,
  text: string,
  cites?: string,
): FixSentence => ({ id, language: "zh-CN", document, text, written, ...(cites && { cites }) });

const PASSENGERS =
  "Harlow Bay Ferries carried 1.42 million passengers in 2025, up from 1.31 million in 2024.";
const TERMINAL =
  "The new Eastgate terminal opened in September 2025, six months later than planned.";
const MEASURES = "The K2 measures PM2.5 and carbon dioxide every 30 seconds.";
const BATTERY = "Its battery lasts up to 14 hours on a single charge.";
const INDOOR = "The K2 is certified for indoor use only.";
const SUPPLY = "2025年供水总量为8,640万立方米，较上年增长3.2%。";
const PLANT = "新建的东区水厂于2025年10月投入运行，比原计划推迟四个月。";
const LEAKS = "管网漏损率由2024年的11.8%降至9.6%。";
const UNLOCK = "K9支持指纹、密码和NFC三种开锁方式。";
const LOCK_BATTERY = "电池在正常使用下可用约八个月。";

export const FIX_SENTENCES: readonly FixSentence[] = [
  en(
    "en-part-1",
    FERRIES,
    "part",
    "Harlow Bay Ferries carried 1.42 million passengers in 2025, making it the busiest ferry operator in the region.",
    PASSENGERS,
  ),
  en(
    "en-part-2",
    MONITOR,
    "part",
    "The K2 measures PM2.5 and carbon dioxide every 30 seconds and sends alerts to a phone app.",
    MEASURES,
  ),
  en(
    "en-part-3",
    FERRIES,
    "part",
    "The Eastgate terminal opened in September 2025 and has already cut boarding times by half.",
    TERMINAL,
  ),
  en(
    "en-number-1",
    FERRIES,
    "one-number",
    "Harlow Bay Ferries carried 1.24 million passengers in 2025.",
    PASSENGERS,
  ),
  en(
    "en-number-2",
    MONITOR,
    "one-number",
    "The K2's battery lasts up to 16 hours on a single charge.",
  ),
  en(
    "en-number-3",
    FERRIES,
    "one-number",
    "Fuel made up 33% of Harlow Bay Ferries' operating costs.",
  ),
  en(
    "en-different-1",
    FERRIES,
    "different",
    "The Eastgate terminal opened on schedule in 2025.",
    TERMINAL,
  ),
  en("en-different-2", FERRIES, "different", "The board approved the 2026 fare rise unanimously."),
  en("en-different-3", MONITOR, "different", "The K2 can be used outdoors.", INDOOR),
  en(
    "en-different-4",
    FERRIES,
    "different",
    "The Central route has more sailings a day than the North route.",
  ),
  en("en-further-1", FERRIES, "further", "Harlow Bay Ferries' sailings always leave on time."),
  en(
    "en-further-2",
    MONITOR,
    "further",
    "The K2's battery lasts for days between charges.",
    BATTERY,
  ),
  en(
    "en-further-3",
    FERRIES,
    "further",
    "Passenger numbers at Harlow Bay Ferries have grown every year for a decade.",
    PASSENGERS,
  ),
  en(
    "en-notfound-1",
    FERRIES,
    "not-found",
    "Harlow Bay Ferries plans to open a route to Norway in 2027.",
  ),
  en("en-notfound-2", MONITOR, "not-found", "The K2 won a design award in 2024."),
  en("en-notfound-3", FERRIES, "not-found", "Harlow Bay Ferries' chief executive is Maria Lund."),
  en(
    "en-supported-1",
    FERRIES,
    "supported",
    "Harlow Bay Ferries runs four vessels on two routes.",
    "Fuel made up 38% of operating costs. The company runs four vessels on two routes.",
  ),
  en("en-supported-2", MONITOR, "supported", "The K2 costs £189 including VAT."),
  zh(
    "zh-part-1",
    WATER,
    "part",
    "2025年供水总量为8,640万立方米，较上年增长3.2%，增速为全省最高。",
    SUPPLY,
  ),
  zh(
    "zh-part-2",
    LOCK,
    "part",
    "K9支持指纹、密码和NFC三种开锁方式，并可通过手机远程开锁。",
    UNLOCK,
  ),
  zh(
    "zh-part-3",
    WATER,
    "part",
    "管网漏损率由2024年的11.8%降至9.6%，主要得益于智能水表的全面推广。",
    LEAKS,
  ),
  zh("zh-number-1", WATER, "one-number", "2025年供水总量为8,460万立方米。", SUPPLY),
  zh("zh-number-2", LOCK, "one-number", "K9的建议零售价为1,399元。"),
  zh("zh-number-3", WATER, "one-number", "公司共有员工1,420人。"),
  zh("zh-different-1", WATER, "different", "东区水厂于2025年10月按计划投入运行。", PLANT),
  zh("zh-different-2", WATER, "different", "董事会全票通过了2026年水价调整方案。"),
  zh("zh-different-3", LOCK, "different", "K9可以安装在室外大门上。"),
  zh("zh-different-4", WATER, "different", "西区水厂的日供水能力高于东区水厂。"),
  zh("zh-further-1", WATER, "further", "青澜水务已经彻底解决了管网漏损问题。", LEAKS),
  zh("zh-further-2", LOCK, "further", "K9的电池可以使用好几年。", LOCK_BATTERY),
  zh("zh-further-3", WATER, "further", "青澜水务的供水量连续十年保持增长。"),
  zh("zh-notfound-1", WATER, "not-found", "青澜水务计划于2027年在香港上市。"),
  zh("zh-notfound-2", LOCK, "not-found", "K9获得了2024年红点设计奖。"),
  zh("zh-notfound-3", WATER, "not-found", "青澜水务的董事长是陈明远。"),
  zh("zh-supported-1", WATER, "supported", "东区水厂的日供水能力为15万立方米。"),
  zh(
    "zh-supported-2",
    LOCK,
    "supported",
    "K9仅适用于室内门。",
    "K9仅适用于室内门。建议零售价为1,299元。",
  ),
];
