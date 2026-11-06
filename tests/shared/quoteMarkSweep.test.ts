/**
 * A sweep of decoys across the shapes a review has used to make a changed quote read found (#2504):
 * SQL's boundaries, sentence ends inside a pair, characters the normaliser drops, possessives, code
 * characters and nested pairs, in English and Chinese. Each decoy writes the page's quotation marks
 * in the other kind where that changes what the words mean; main never matches it, so neither may
 * this matcher. Each positive keeps the page's own marks and is found.
 */
import { describe, expect, test } from "vitest";
import { findQuote } from "../../src/shared/quoteMatch";

const cases: { family: string; lang: string; page: string; decoy: string; positive: string }[] = [];
const add = (family: string, lang: string, page: string, decoy: string, positive: string) =>
  cases.push({ family, lang, page, decoy, positive });
const swap = (s: string) => s.replaceAll("“", "‘").replaceAll("”", "’");
const low = (s: string) => s.replace(/[.。]$/, "");
const pair = (family: string, lang: string, page: string) =>
  add(family, lang, page, swap(low(page)), low(page));

const sqlMiddles = [
  "'semi;colon'",
  "'a\n\nb'",
  "users. id",
  "users.\nid",
  "users.\r\nid",
  "users.\tid",
  "/* note; here */ id",
  "-- c\n id",
  "'x' || 'y'",
  '"a;b"',
  "COUNT(*)",
  "users .id",
  "'it''s'",
  "CASE WHEN a THEN 'b;' END",
];
for (const m of sqlMiddles) {
  pair("SQL", "en", `SELECT “name”, ${m} FROM users;`);
  pair("SQL", "en", `select “name”, ${m} from users;`);
}
for (const s of [
  "SeLeCt “name” FrOm users;",
  "UPDATE t SET “name” = 'x;y';",
  "update t\n\nset “name” = 1;",
  "UPDATE t SET “name”\n\n= 1;",
  "update t set “name”\n\n= 'x';",
  "INSERT INTO “users” VALUES ('a;b');",
  "DELETE FROM “users” WHERE a = 'b';",
  "SELECT a FROM t ORDER BY “name”;",
  "SELECT a FROM t GROUP BY “name”;",
  "WITH x AS (SELECT “name” FROM t) SELECT * FROM x;",
  "select\n\n“name”\n\nfrom users;",
  "SEL\u00adECT “name” FROM users;",
  "SELECT “name” FR\u200bOM users;",
  "Run this: select “name” from users. Then stop.",
  "First line.\n\nselect “name”\n\nfrom users;",
])
  pair("SQL", "en", s);
for (const m of ["'分号;'", "users. id", "users.\nid"])
  pair("SQL", "zh", `运行 SELECT “name”, ${m} FROM users 读取名字。`);
pair("SQL", "zh", "运行 select\n\n“name”\n\nfrom users 读取名字。");
for (const end of [". ", "! ", "? ", ".\n", "!\n"])
  pair("sentence end", "en", `Run echo “hello${end}$name” now.`);
for (const end of ["。", "！", "？"])
  pair("sentence end", "zh", `运行 echo “你好${end}$name” 现在。`);
pair("sentence end", "en", "Set x = 3.5 and call it “total”;");
pair("sentence end", "en", "Set x = 2\nand call it “total”;");
pair("sentence end", "en", "Set x = 2\r\nand call it “total”;");
pair("sentence end", "zh", "设 x = 2，把它叫做“总数”。");
const hidden = ["\u00ad", "\u200b", "\u200c", "\u200d", "\u2060", "\ufeff"];
for (const h of hidden) {
  pair("hidden", "en", `Set name =${h} “total”; then run it.`);
  pair("hidden", "en", `Type “ls -${h}la” to list.`);
  pair("hidden", "en", `Use a 6${h}” pipe and “go” on.`);
  add(
    "hidden",
    "en",
    `The ‘girls’ ${h} notes’ are missing.`,
    `the “girls” ${h} notes’ are missing`,
    `the ‘girls’ ${h} notes’ are missing`,
  );
  add(
    "hidden",
    "en",
    `The ‘girls’${h} notes’ are missing.`,
    `the “girls”${h} notes’ are missing`,
    `the ‘girls’${h} notes’ are missing`,
  );
}
pair("hidden", "zh", "设 name =\u200b “总数”；然后运行。");
for (const gap of [
  "  ",
  "\t",
  "\r\n",
  "\n",
  " \n ",
  "\u00a0",
  "\u2009",
  "\u3000",
  " \u200b ",
  " \u00ad ",
]) {
  add(
    "possessive",
    "en",
    `The ‘girls’${gap}notes’ are missing.`,
    `the “girls”${gap}notes’ are missing`,
    `the ‘girls’${gap}notes’ are missing`,
  );
}
for (const after of ["2024 plan", "3 rooms", "new car", "Q3 report"]) {
  add(
    "possessive",
    "en",
    `‘The bosses’ ${after} failed,’ she said.`,
    `“the bosses” ${after} failed`,
    `‘the bosses’ ${after} failed`,
  );
}
add(
  "possessive",
  "en",
  "He read ‘the Joneses’ notes’ aloud.",
  "he read “the joneses” notes",
  "he read ‘the joneses’ notes’ aloud",
);
add(
  "possessive",
  "en",
  "He read ‘James’ notes’ aloud.",
  "he read “james” notes",
  "he read ‘james’ notes’ aloud",
);
for (const c of "$`\\{}<>|=^~@#/*+_[]") {
  pair("code", "en", `Run x ${c} “total” now.`);
  pair("code", "en", `Run “to${c}tal” now.`);
}
for (const opt of ["-la", "--force", "-x"]) pair("code", "en", `Type “ls ${opt}” to list.`);
pair("code", "zh", "运行 x = “总数” 现在。");
pair("code", "zh", "运行 “总$数” 现在。");
const nestedChanged: [string, string, string][] = [
  [
    "“He said ‘no’ twice,” she wrote.",
    "‘he said “yes” twice,’ she wrote",
    "“he said ‘no’ twice,” she wrote",
  ],
  ["“He said ‘a 6” pipe’ twice.”", "‘he said “a 6’ pipe” twice.’", "“he said ‘a 6” pipe’ twice.”"],
  ["「她说『不行』两次」。", "“她说‘可以’两次”", "「她说『不行』两次」"],
  ["„Er sagte ‚nein‘ zweimal.“", "“er sagte ‘ja’ zweimal.”", "„er sagte ‚nein‘ zweimal.“"],
  ["«Il a dit “non” deux fois.»", "‘il a dit “oui” deux fois.’", "«il a dit “non” deux fois.»"],
  ["“Use a 5’10” door,” he said.", "use a 5’10’ door", "use a 5’10” door"],
  ["“The ‘Top 10’ list,” she said.", "the “top 11” list", "the ‘top 10’ list"],
  ["他说：“‘冷静期’为14天。”", "‘“冷静期”为15天", "“‘冷静期’为14天"],
];
for (const [page, decoy, positive] of nestedChanged)
  add("nested", /[一-鿿]/.test(page) ? "zh" : "en", page, decoy, positive);

const families = [...new Set(cases.map(({ family, lang }) => `${family} (${lang})`))];

describe.each(families)("the %s decoys", (name) => {
  const ofFamily = cases.filter(({ family, lang }) => `${family} (${lang})` === name);

  test("a decoy isn't found", () => {
    const found = ofFamily.filter(({ page, decoy }) => findQuote(page, decoy) !== null);
    expect(found.map(({ page, decoy }) => `${page} || ${decoy}`)).toEqual([]);
  });

  test("the page's own marks are found", () => {
    const missed = ofFamily.filter(({ page, positive }) => findQuote(page, positive) === null);
    expect(missed.map(({ page, positive }) => `${page} || ${positive}`)).toEqual([]);
  });
});

test("the sweep holds 157 decoys", () => {
  expect(cases).toHaveLength(157);
});
