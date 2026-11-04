/**
 * Names in text IncarnaMind already holds (#1031): who and what a Meeting's Note and its Folder's
 * Documents talk about, for the transcriber to know. No model reads them, and nothing is read
 * again from the files. In English, a run of capitalised words that isn't one word starting a
 * sentence or a line; in Chinese, a surname and a given name the word splitter had no word for
 * and cut into single characters (王|丽), a surname before a title (王总, 陈经理), and a company
 * before what it is (星河科技).
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

const LATIN_WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*|&/gu;
/** What comes before a sentence's or a list item's first word. */
const OPENING = /(?:^|[.!?"“(]|\n[ \t]*(?:[-*•]|\d+[.)])?)[ \t]*$/u;

const isCapitalised = (word: string) => /^\p{Lu}/u.test(word) && /\p{Ll}/u.test(word);
const isNotName = (word: string) => NOT_NAMES.has(word.toLowerCase());

function latinNames(text: string, add: (name: string) => void): void {
  let run: string[] = [];
  let opens = false;
  let lastEnd = 0;
  const end = () => {
    while (run.length > 0 && isNotName(run[0] as string)) {
      run.shift();
      opens = false;
    }
    while (
      run.length > 0 &&
      (isNotName(run.at(-1) as string) || JOINERS.has(run.at(-1) as string))
    ) {
      run.pop();
    }
    if (run.length > 1 || (run.length === 1 && !opens)) add(run.join(" "));
    run = [];
  };
  for (const match of text.matchAll(LATIN_WORD)) {
    const word = match[0];
    const at = match.index;
    const joined = run.length > 0 && /^[ \t]$/u.test(text.slice(lastEnd, at));
    lastEnd = at + word.length;
    if (joined && (isCapitalised(word) || JOINERS.has(word.toLowerCase()))) {
      run.push(word);
      continue;
    }
    end();
    if (isCapitalised(word)) {
      opens = OPENING.test(text.slice(Math.max(0, at - 8), at));
      run.push(word);
    }
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

const HAN_WORD = /^\p{Script=Han}+$/u;

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

/** The names in `text`, each with how often it is there, the most frequent first. */
export function namesIn(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  const add = (name: string) => counts.set(name, (counts.get(name) ?? 0) + 1);
  latinNames(text, add);
  if (/\p{Script=Han}/u.test(text)) hanNames(text, add);
  return new Map([...counts].sort((a, b) => b[1] - a[1]));
}
