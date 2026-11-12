/**
 * Names in text IncarnaMind already holds (#1031): who and what a Meeting's Note and its Folder's
 * Documents talk about, for the transcriber to know. No model reads them, and nothing is read
 * again from the files. In English, a run of capitalised words that isn't one word starting a
 * sentence or a line; in Chinese, a surname and a given name the word splitter had no word for
 * and cut into single characters (王|丽), a surname before a title (王总, 陈经理), and a company
 * before what it is (星河科技).
 *
 * Two kinds of capitalised word are a name as often as an ordinary word, and are given apart from
 * the names: one English word written against a Chinese character (跟Priya确认, 这个Plan), and
 * one word that opens a line before a colon or is a list item alone ("Priya: send the deck",
 * "- Risks").
 */

const segmenter = new Intl.Segmenter("zh", { granularity: "word" });

/** Capitalised words that start sentences, headings and list items, not names. */
const NOT_NAMES = new Set(
  (
    "i a an the this that these those we our us you your he his she her it its they their them my me " +
    "in on at for and but or if so to of by with as from into about after before then there here " +
    "what when where which who why how yes no ok okay hi hello dear thanks thank regards best " +
    "mr mrs ms dr prof " +
    "monday tuesday wednesday thursday friday saturday sunday " +
    "january february march april may june july august september october november december " +
    "jan feb mar apr jun jul aug sep sept oct nov dec " +
    "page pages table figure section chapter appendix note notes total summary agenda minutes " +
    "attendees meeting call action actions items next date time"
  ).split(" "),
);

/** Words that join the parts of a name: Bank of America, Procter & Gamble. */
const JOINERS = new Set(["of", "&"]);

/** A word in a script with capitals: it ends where Chinese characters begin (跟Priya确认). */
const LATIN_WORD = /(?:(?!\p{Script=Han})[\p{L}\p{N}])(?:(?!\p{Script=Han})[\p{L}\p{N}'’-])*|&/gu;
/** What comes before a sentence's or a list item's first word. */
const OPENING = /(?:^|[.!?"“(]|\n[ \t]*(?:[-*•]|\d+[.)])?)[ \t]*$/u;
/** What a line holds before its first word: nothing, or list markers, numbers and checkboxes. */
const ITEM_START = /^[ \t]*((?:(?:[-*•]|\d+[.)]|\[[ xX]?\])[ \t]*)*)$/u;
const POSSESSIVE = /['’]s$/u;

const isCapitalised = (word: string) => /^\p{Lu}/u.test(word) && /\p{Ll}/u.test(word);
const isNotName = (word: string) => NOT_NAMES.has(word.toLowerCase());

interface Word {
  text: string;
  at: number;
  end: number;
}

const besideChinese = (text: string, word: Word) =>
  /\p{Script=Han}$/u.test(text.slice(Math.max(0, word.at - 2), word.at)) ||
  /^\p{Script=Han}/u.test(text.slice(word.end, word.end + 2));

/** Whether the word, a line's first, stands before a colon or is a list item alone. */
function opensItem(text: string, word: Word): boolean {
  const markers = ITEM_START.exec(text.slice(text.lastIndexOf("\n", word.at - 1) + 1, word.at));
  if (!markers) return false;
  if (/^[:：]/u.test(text.slice(word.end, word.end + 1))) return true;
  const lineEnd = text.indexOf("\n", word.end);
  const rest = text.slice(word.end, lineEnd < 0 ? text.length : lineEnd);
  return markers[1] !== "" && rest.trim() === "";
}

type Kind = keyof NamesFound;

function latinNames(text: string, add: (kind: Kind, name: string) => void): void {
  let run: Word[] = [];
  let opens = false;
  let lastEnd = 0;
  const end = () => {
    while (run[0] && isNotName(run[0].text)) {
      run.shift();
      opens = false;
    }
    for (
      let last = run.at(-1);
      last && (isNotName(last.text) || JOINERS.has(last.text));
      last = run.at(-1)
    ) {
      run.pop();
    }
    const [only] = run;
    if (run.length > 1) add("names", run.map((each) => each.text).join(" "));
    else if (only && !opens) add(besideChinese(text, only) ? "besideChinese" : "names", only.text);
    else if (only && opensItem(text, only)) add("itemOpeners", only.text);
    run = [];
  };
  for (const match of text.matchAll(LATIN_WORD)) {
    const at = match.index;
    const owned = POSSESSIVE.test(match[0]);
    // "Tom's" is Tom, and what Tom has is not part of the name.
    const word = { text: owned ? match[0].slice(0, -2) : match[0], at, end: at + match[0].length };
    const joined = run.length > 0 && /^[ \t]$/u.test(text.slice(lastEnd, at));
    lastEnd = word.end;
    if (joined && (isCapitalised(word.text) || JOINERS.has(word.text.toLowerCase()))) {
      run.push(word);
    } else {
      end();
      if (!isCapitalised(word.text)) continue;
      opens = OPENING.test(text.slice(Math.max(0, at - 8), at));
      run.push(word);
    }
    if (owned) end();
  }
  end();
}

/** Common surnames, for names the splitter cut into characters and names with a title. */
const SURNAMES = new Set(
  "王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤华".split(
    "",
  ),
);

const TITLES = new Set(
  "总 经理 总监 老师 律师 先生 女士 小姐 主任 博士 教授 董事长 医生 会计师 部长 处长 总裁".split(
    " ",
  ),
);

/** What a company is, said as the end of its name. */
const COMPANY_ENDS = new Set(
  "科技 集团 银行 证券 资本 基金 传媒 地产 物流 医药 汽车 能源 电子 网络 软件".split(" "),
);

/** Characters too common to be a given name's: a run with one is ordinary words. */
const COMMON_HAN = new Set(
  "的了是在和与及或我你您他她它们这那有不也就都而被把对于为从到给让向个上下中会能要说来去吗呢吧啊呀哦嗯很更最还又再已没并但一二三四五六七八九十百千万年月日号点元第每各".split(
    "",
  ),
);

/** Words that join two names: the splitter reads 总和 ("sum") as one word in 王总和李总. */
const NAME_JOINERS = new Set("和与及跟或".split(""));

const HAN_WORD = /^\p{Script=Han}+$/u;

/** The title a word starts with when all that follows it joins names: 总 of 总和. */
const titleJoined = (word: string) =>
  [...TITLES].find(
    (title) =>
      word.startsWith(title) &&
      word.length > title.length &&
      [...word.slice(title.length)].every((character) => NAME_JOINERS.has(character)),
  );

function hanNames(text: string, add: (name: string) => void): void {
  const words = [...segmenter.segment(text)].map((each) => each.segment);
  let single = "";
  const endSingle = () => {
    if (single.length >= 2 && single.length <= 3 && SURNAMES.has(single[0] as string)) add(single);
    single = "";
  };
  for (const [at, word] of words.entries()) {
    const before = words[at - 1] ?? "";
    if (TITLES.has(word) && SURNAMES.has(before)) add(before + word);
    const title = SURNAMES.has(before) ? titleJoined(word) : undefined;
    if (title) add(before + title);
    if (
      COMPANY_ENDS.has(word) &&
      before.length >= 2 &&
      HAN_WORD.test(before) &&
      ![...before].some((char) => COMMON_HAN.has(char))
    ) {
      add(before + word);
    }
    const nameCharacter =
      word.length === 1 && HAN_WORD.test(word) && !COMMON_HAN.has(word) && !TITLES.has(word);
    if (nameCharacter && (single !== "" || SURNAMES.has(word))) single += word;
    else endSingle();
  }
  endSingle();
}

export interface NamesFound {
  /** The names, each with how often it is there, the most frequent first. */
  names: Map<string, number>;
  /** One English word written against a Chinese character, with how often it is. */
  besideChinese: Map<string, number>;
  /** One word that opens a line before a colon, or is a list item alone, with how often it is. */
  itemOpeners: Map<string, number>;
}

export function namesIn(text: string): NamesFound {
  const found: NamesFound = { names: new Map(), besideChinese: new Map(), itemOpeners: new Map() };
  const add = (kind: Kind, name: string) => found[kind].set(name, (found[kind].get(name) ?? 0) + 1);
  latinNames(text, add);
  if (/\p{Script=Han}/u.test(text)) hanNames(text, (name) => add("names", name));
  return { ...found, names: new Map([...found.names].sort((a, b) => b[1] - a[1])) };
}
