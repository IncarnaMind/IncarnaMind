/**
 * The slide editor bake-off's decks (README.md): the PowerPoint patch
 * spike's corpus, and public decks whose text is Chinese, from university
 * course repositories, each pinned by its URL at a commit and its SHA-256.
 * Fetched when the run starts, never committed.
 */
import { CORPUS, type CorpusDeck } from "../pptx/corpus";

export const CHINESE_DECKS: readonly CorpusDeck[] = [
  {
    id: "z00",
    name: "第3章 词法分析.pptx",
    url: "https://raw.githubusercontent.com/HITLittleZheng/HITCS/934080de30080e5b56d3593f6f77ea72e4dd4cfb/%E5%85%AC%E5%85%B1%E8%AF%BE%E7%A8%8B/%E7%BC%96%E8%AF%91%E5%8E%9F%E7%90%86/%E5%8D%95%E8%80%81%E5%B8%88%E8%AF%BE%E4%BB%B6/%E7%AC%AC3%E7%AB%A0%20%E8%AF%8D%E6%B3%95%E5%88%86%E6%9E%90.pptx",
    sha256: "739e897323d8793d1c7393809f135a6b4e83a90679718045137ad64b3d918485",
    bytes: 1370362,
    origin: "university",
    savedBy: "Microsoft Office PowerPoint",
    has: ["masters:4", "animations", "notes", "media:wav", "cjk"],
  },
  {
    id: "z01",
    name: "人工智能数学基础-第5章-贝叶斯公式与检测准则.pptx",
    url: "https://raw.githubusercontent.com/HITLittleZheng/HITCS/934080de30080e5b56d3593f6f77ea72e4dd4cfb/%E4%BA%BA%E5%B7%A5%E6%99%BA%E8%83%BD/%E4%BA%BA%E5%B7%A5%E6%99%BA%E8%83%BD%E6%95%B0%E5%AD%A6%E5%9F%BA%E7%A1%80/%E4%BA%BA%E5%B7%A5%E6%99%BA%E8%83%BD%E6%95%B0%E5%AD%A6%E5%9F%BA%E7%A1%80%E8%AF%BE%E4%BB%B6/%E4%BA%BA%E5%B7%A5%E6%99%BA%E8%83%BD%E6%95%B0%E5%AD%A6%E5%9F%BA%E7%A1%80-%E7%AC%AC5%E7%AB%A0-%E8%B4%9D%E5%8F%B6%E6%96%AF%E5%85%AC%E5%BC%8F%E4%B8%8E%E6%A3%80%E6%B5%8B%E5%87%86%E5%88%99.pptx",
    sha256: "c8a25f0b1b6d66c2735fda949163d82e9b87b7cce92e0d425c429f00bd0c29de",
    bytes: 4530983,
    origin: "university",
    savedBy: "Microsoft Office PowerPoint",
    has: ["animations", "cjk"],
  },
  {
    id: "z02",
    name: "ppt-DBMS-设计篇-ch5new.pptx",
    url: "https://raw.githubusercontent.com/HITLittleZheng/HITCS/934080de30080e5b56d3593f6f77ea72e4dd4cfb/%E5%85%AC%E5%85%B1%E8%AF%BE%E7%A8%8B/%E6%95%B0%E6%8D%AE%E5%BA%93%E7%B3%BB%E7%BB%9F/csy%E8%AF%BE%E4%BB%B6/ppt-DBMS-%E8%AE%BE%E8%AE%A1%E7%AF%87-ch5new.pptx",
    sha256: "5fe65d86cd465f138ed5ba7e14b5be7f08ef40f1b293f59641a9f6bba146817a",
    bytes: 1075136,
    origin: "university",
    savedBy: "Microsoft Office PowerPoint",
    has: ["masters:2", "animations", "notes", "cjk"],
  },
  {
    id: "z03",
    name: "10RSA加解密机制.pptx",
    url: "https://raw.githubusercontent.com/HITLittleZheng/HITCS/934080de30080e5b56d3593f6f77ea72e4dd4cfb/%E4%BF%A1%E6%81%AF%E5%AE%89%E5%85%A8/%E5%AF%86%E7%A0%81%E5%AD%A6/%E8%AF%BE%E7%A8%8B%E5%AD%A6%E4%B9%A0%E8%B5%84%E6%BA%90/%E5%AF%86%E7%A0%81%E5%AD%A6%E5%8E%9F%E7%90%86-2025%E7%A7%8B-%E8%AF%BE%E4%BB%B6/10RSA%E5%8A%A0%E8%A7%A3%E5%AF%86%E6%9C%BA%E5%88%B6.pptx",
    sha256: "9b3ff0742f037241222b82ed7f461aa7f7e7e94db3917eb08e912ef91fc2df04",
    bytes: 3042265,
    origin: "university",
    savedBy: "Microsoft Office PowerPoint",
    has: ["animations", "notes", "cjk"],
  },
  {
    id: "z04",
    name: "内卷时代：绩点下的人生突围.pptx",
    url: "https://raw.githubusercontent.com/PKUanonym/REKCARC-TSC-UHT/37cd19f7a9fb80dc846a7016b3fd482ed5fe7cc0/%E5%A4%A7%E4%B8%80%E4%B8%8A/%E5%BD%A2%E5%BC%8F%E4%B8%8E%E6%94%BF%E7%AD%96/hw/%E5%86%85%E5%8D%B7%E6%97%B6%E4%BB%A3%EF%BC%9A%E7%BB%A9%E7%82%B9%E4%B8%8B%E7%9A%84%E4%BA%BA%E7%94%9F%E7%AA%81%E5%9B%B4.pptx",
    sha256: "8bf6753143ac54b5b9a6b379968bd3d7b6bd555e414c149aeeb7a5379f65257c",
    bytes: 2770763,
    origin: "university",
    savedBy: "Microsoft Office PowerPoint",
    has: ["notes", "cjk"],
  },
  {
    id: "z05",
    name: "第2章 数据表示与信息编码-1.pptx",
    url: "https://raw.githubusercontent.com/QSCTech/zju-icicles/ed653c62efb2f8e2803ba30103b73131fd88628b/%E5%A4%A7%E8%AE%A1%E5%9F%BAA_23.1.6/%E8%AE%A1%E7%AE%97%E6%9C%BA%E6%8A%80%E6%9C%AF%E5%9F%BA%E7%A1%80/%E8%AF%BE%E4%BB%B6/%E7%AC%AC2%E7%AB%A0%20%E6%95%B0%E6%8D%AE%E8%A1%A8%E7%A4%BA%E4%B8%8E%E4%BF%A1%E6%81%AF%E7%BC%96%E7%A0%81-1.pptx",
    sha256: "7fd5df9442a8e59b2806ce2dcf81f6769d5d62af8cc97d66c3f43d6de773d15e",
    bytes: 1113354,
    origin: "university",
    savedBy: "WPS 文字",
    has: ["animations", "cjk"],
  },
  {
    id: "z06",
    name: "2016数算期中考试试题评讲.pptx",
    url: "https://raw.githubusercontent.com/lib-pku/libpku/03118218556158430178d25497ed9804dfafe9ac/%E4%B8%93%E4%B8%9A%E8%AF%BE/%E6%95%B0%E6%8D%AE%E7%BB%93%E6%9E%84%E4%B8%8E%E7%AE%97%E6%B3%95/2016%E6%95%B0%E7%AE%97%E6%9C%9F%E4%B8%AD%E8%80%83%E8%AF%95%E8%AF%95%E9%A2%98%E8%AF%84%E8%AE%B2.pptx",
    sha256: "271578b50f62771cd594a57669821f2bfe01071a992f2c8e248b24ac0e4b9832",
    bytes: 695550,
    origin: "university",
    savedBy: "Microsoft Office PowerPoint",
    has: ["masters:2", "animations", "notes", "cjk"],
  },
  {
    id: "z07",
    name: "微机原理习题课part1.pptx",
    url: "https://raw.githubusercontent.com/USTC-Resource/USTC-Course/d091d4d43df88d6744e4c914825afa8f5019d95f/%E5%BE%AE%E6%9C%BA%E5%8E%9F%E7%90%86%E4%B8%8E%E7%B3%BB%E7%BB%9F/notes/%E5%BE%AE%E6%9C%BA%E5%8E%9F%E7%90%86%E4%B9%A0%E9%A2%98%E8%AF%BEpart1.pptx",
    sha256: "69a92b7495b64c958abdc98053a9d5b5e27eed9dfbfed1ee4889ffa762867b00",
    bytes: 2368593,
    origin: "university",
    savedBy: "Microsoft Office PowerPoint",
    has: ["animations", "notes", "cjk"],
  },
];

export const DECKS: readonly CorpusDeck[] = [...CORPUS, ...CHINESE_DECKS];
