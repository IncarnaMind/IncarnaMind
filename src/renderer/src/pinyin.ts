/**
 * Pinyin for Chinese characters, without tones, read from the order a pinyin
 * collator sorts them in, as Chromium's does: each syllable's characters sort
 * together, so the first character of each syllable in that order is enough to
 * tell any character's. The table lists those first characters, then the
 * syllables they start (ü written v), then where pinyin ends: what sorts after
 * it has no reading. A character with several readings sorts by one of them,
 * which is the first `pinyinReadings` gives. Derived once from a pinyin
 * dictionary; right for 99.95% of the 3,755 most common characters.
 */

const STARTS = Array.from(
  "吖哎安肮凹丷挀扳邦勹卑奔伻屄边标憋汃冫癶卜擦偲参仓撡冊嵾噌叉芆辿伥抄车抻阷吃充抽出揣巛刅" +
    "吹旾逴呲匆凑粗汆崔邨搓咑呆丹当刀嘚扥灯氐嗲敁刁爹丁丟东吺厾偳垖吨多妸诶奀鞥儿发帆匚飞分丰" +
    "仏紑夫旮侅甘冈皋戈给根刯工勾估瓜乖关光归丨呙哈咍佄夯茠诃黒拫亨叿齁乎花怀欢巟灰昏吙讥加戋" +
    "江艽阶巾坕冂丩凥姢噘军咔开刊忼尻匼肎劥空抠刳夸蒯宽匡亏坤扩垃来兰啷捞仂雷塄哩俩奁良撩毟拎" +
    "伶溜龙瞜噜驴娈掠抡啰呣妈埋嫚牤猫嚒坆椚擝咪宀喵吀民名谬摸哞毪拏腉囡囔孬疒娞恁能嗯妮拈娘鸟" +
    "捏囜宁妞农羺奴女奻疟挪噢讴妑拍眅乓抛呸喷匉丕囨剽氕姘乒钋剖仆七掐千呛悄苆亲靑卭丘区奍炔夋" +
    "呥穣娆惹人扔日戎禸邚堧桵闰捼仨毢三桒掻閪森僧杀筛山伤弰奢申升尸収书刷衰闩双脽吮说厶忪凁苏" +
    "狻夊孙唆他囼坍汤夲忑熥剔天旫帖厅炵偷凸湍推吞乇屲歪弯尢危昷翁挝乌夕呷仙乡灱些心星凶休吁吅" +
    "疶坃丫恹央幺倻一囙应哟佣优込囦曰晕帀災兂匨傮则贼怎囎扎夈枬张佋蜇贞凧之中州朱抓跩专妆隹宒" +
    "拙孜宗邹租钻厜尊嘬鿖",
);

const SYLLABLES = (
  "a ai an ang ao ba bai ban bang bao bei ben beng bi bian biao bie bin bing bo bu ca cai c" +
  "an cang cao ce cen ceng cha chai chan chang chao che chen cheng chi chong chou chu chuai" +
  " chuan chuang chui chun chuo ci cong cou cu cuan cui cun cuo da dai dan dang dao de den " +
  "deng di dia dian diao die ding diu dong dou du duan dui dun duo e ei en eng er fa fan fa" +
  "ng fei fen feng fo fou fu ga gai gan gang gao ge gei gen geng gong gou gu gua guai guan " +
  "guang gui gun guo ha hai han hang hao he hei hen heng hong hou hu hua huai huan huang hu" +
  "i hun huo ji jia jian jiang jiao jie jin jing jiong jiu ju juan jue jun ka kai kan kang " +
  "kao ke ken keng kong kou ku kua kuai kuan kuang kui kun kuo la lai lan lang lao le lei l" +
  "eng li lia lian liang liao lie lin ling liu long lou lu lv luan lve lun luo m ma mai man" +
  " mang mao me mei men meng mi mian miao mie min ming miu mo mou mu na nai nan nang nao ne" +
  " nei nen neng ng ni nian niang niao nie nin ning niu nong nou nu nv nuan nve nuo o ou pa" +
  " pai pan pang pao pei pen peng pi pian piao pie pin ping po pou pu qi qia qian qiang qia" +
  "o qie qin qing qiong qiu qu quan que qun ran rang rao re ren reng ri rong rou ru ruan ru" +
  "i run ruo sa sai san sang sao se sen seng sha shai shan shang shao she shen sheng shi sh" +
  "ou shu shua shuai shuan shuang shui shun shuo si song sou su suan sui sun suo ta tai tan" +
  " tang tao te teng ti tian tiao tie ting tong tou tu tuan tui tun tuo wa wai wan wang wei" +
  " wen weng wo wu xi xia xian xiang xiao xie xin xing xiong xiu xu xuan xue xun ya yan yan" +
  "g yao ye yi yin ying yo yong you yu yuan yue yun za zai zan zang zao ze zei zen zeng zha" +
  " zhai zhan zhang zhao zhe zhen zheng zhi zhong zhou zhu zhua zhuai zhuan zhuang zhui zhu" +
  "n zhuo zi zong zou zu zuan zui zun zuo"
).split(" ");

/**
 * Characters read more than one way, besides the reading the collation gives
 * them (#1416): a person types "chongming" for 重命名, whose 重 sorts as "zhong".
 * The common ones a name or an action is likely to hold; a rarer reading isn't
 * worth a table of its own.
 */
const OTHER_READINGS: Readonly<Record<string, readonly string[]>> = {
  重: ["chong"],
  行: ["hang"],
  长: ["chang"],
  乐: ["yue"],
  了: ["liao"],
  还: ["huan"],
  都: ["du"],
  得: ["dei"],
  着: ["zhao", "zhuo"],
  调: ["tiao"],
  没: ["mo"],
  朝: ["zhao"],
  差: ["chai", "ci"],
};

const collator = new Intl.Collator("zh-CN-u-co-pinyin");
const known = new Map<string, string | null>();
const readings = new Map<string, readonly string[]>();

/** A Chinese character's pinyin syllable, without its tone, or null for any other character. */
export function pinyinOf(character: string): string | null {
  const cached = known.get(character);
  if (cached !== undefined) return cached;
  let syllable: string | null = null;
  if (/^\p{Script=Han}$/u.test(character)) {
    let low = 0;
    let high = STARTS.length - 1;
    let found = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (collator.compare(STARTS[middle] ?? "", character) <= 0) {
        found = middle;
        low = middle + 1;
      } else high = middle - 1;
    }
    syllable = SYLLABLES[found] || null;
  }
  known.set(character, syllable);
  return syllable;
}

/**
 * A Chinese character's pinyin syllables, without tones: the one it sorts by
 * first, then any other common reading (#1416); none for any other character.
 */
export function pinyinReadings(character: string): readonly string[] {
  const cached = readings.get(character);
  if (cached) return cached;
  const first = pinyinOf(character);
  const all = first === null ? [] : [first, ...(OTHER_READINGS[character] ?? [])];
  readings.set(character, all);
  return all;
}
