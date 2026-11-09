import { describe, expect, test } from "vitest";
import {
  borrowedInto,
  shareAWord,
  spokenLanguageOf,
  unnamedLatin,
  writtenOutside,
} from "../../src/core/transcription/spokenLanguage";

describe("The language a reading's words are in (#1031)", () => {
  // protects=English is named English, Chinese with a Latin-letter term in it Chinese, and Cantonese, Japanese and Korean by their own names, so a call's short readings are told the language its long ones are in; fails_when=an English call's language isn't found, or a Chinese line with "KPI" in it reads as mixed; no_claim=how well the model hears, which eval/meetings measures.
  test.each([
    ["Okay, you want me to start right now. Could you put my slides up?", "English"],
    ["I think that's the budget we agreed on, and it should be fine.", "English"],
    ["我们先看一下这个季度的预算，然后再讨论下周的安排。", "Chinese"],
    ["我们这个KPI要在deadline之前完成，然后发邮件给他们。", "Chinese"],
    ["我哋今日嘅會議係講預算，佢話下個月先至搞掂。", "Cantonese"],
    ["来週の会議では予算について話しましょう。", "Japanese"],
    ["다음 주 회의에서 예산에 대해 이야기합시다.", "Korean"],
  ])("%s is %s", (text, language) => {
    expect(spokenLanguageOf(text)).toBe(language);
  });

  // protects=Latin-script speech that isn't English is never named English, so a call in French, German, Spanish, Italian, Dutch, Polish, Czech or Danish never has its short readings told English and translated into it; fails_when=words those languages write too (a, in, on, so, was, do, German "will", "Not" and "just", French "but", "for" and "if", "are", Italian "be'", their "IT", Dutch "we", "of" and "is", Polish and Czech "my" and "to", Danish "at" and "have") or an English phrase they borrow whole ("Nice-to-have", "State of the Art") name a reading English; no_claim=naming those languages, which no reading here does, or a sentence that borrows two of English's own words ("you know").
  test.each([
    "Je pense que nous devons revoir le budget avant la réunion de demain, OK?",
    "On a parlé du planning, mais le client veut une réponse aujourd'hui.",
    "Wir müssen das Budget vor dem Meeting morgen noch einmal prüfen, was meinst du?",
    "So war das nicht geplant, aber in der nächsten Woche haben wir mehr Zeit.",
    "Creo que tenemos que revisar el presupuesto antes de la reunión de mañana.",
    "OK, entonces vamos a hablar del meeting y del budget a las diez.",
    "Penso che dobbiamo rivedere il budget prima della riunione di domani.",
    "Do il report al cliente domani, se va bene a tutti.",
    "Die IT will das Meeting auf morgen verschieben.",
    "In der Not hat sie just den Bericht geschickt, aber ich will ihn erst lesen.",
    "Le but, c'est de planter un if devant le bureau avant la visite du client.",
    "Le terrain fait un are, et le for intérieur du client dit non.",
    "Be', sono solo due are di terreno, ma il cliente vuole aspettare.",
    "We weten nog niet of het is gelukt, maar morgen horen we meer.",
    "My to zrobimy we wtorek, a potem to sprawdzimy.",
    "My to víme, ale klient to ještě neviděl.",
    "Det er godt at have to dage mere til at blive færdig.",
    "Das ist für uns nur ein Nice-to-have, kein Must-have.",
    "Für den Kunden ist das State of the Art, sagt er.",
  ])("never names English: %s", (text) => {
    expect(spokenLanguageOf(text)).toBeNull();
  });

  test("a reading mixed half and half, or with no letters, has no language", () => {
    expect(spokenLanguageOf("这个 feature 我们 next week 再 discuss 一下 okay")).toBeNull();
    expect(spokenLanguageOf("……")).toBeNull();
    expect(spokenLanguageOf("")).toBeNull();
  });

  // protects=Latin letters whose words name no language are told apart from scripts mixed in one reading: the first may be English said without the words that tell it ("Tabs are nice."), the second shows the call isn't in one language; fails_when=an English reading without those words counts against its call being English, or a mixed reading counts as saying nothing; no_claim=what a stream makes of either, which tests/core/shortSpeech.test.ts covers.
  test("Latin letters that name no language are not a mix of scripts", () => {
    for (const unnamed of [
      "Tabs are nice. I like tabs, Mozilla style, to be fair.",
      "Okay. Um. Actually, Monday. Monday might be good.",
      "Wir müssen das Budget vor dem Meeting morgen noch einmal prüfen.",
      "Li Ming 说 okay, fine, Monday morning it is.",
    ]) {
      expect(spokenLanguageOf(unnamed)).toBeNull();
      expect(unnamedLatin(unnamed)).toBe(true);
    }
    for (const shown of [
      "I think that's the budget we agreed on, and it should be fine.",
      "这个 feature 我们 next week 再 discuss 一下 okay",
      "我们先看一下这个季度的预算。",
      "Привет, как дела?",
      "……",
      "",
    ]) {
      expect(unnamedLatin(shown)).toBe(false);
    }
  });

  test("a reading is outside a language only when none of its words is in that language's script", () => {
    expect(writtenOutside("shit。", "Chinese")).toBe(true);
    expect(writtenOutside("OK。", "Chinese")).toBe(true);
    expect(writtenOutside("OK的。", "Chinese")).toBe(false);
    expect(writtenOutside("PPT发我。", "Chinese")).toBe(false);
    expect(writtenOutside("王总。", "English")).toBe(true);
    expect(writtenOutside("Yeah.", "English")).toBe(false);
    expect(writtenOutside("。", "Chinese")).toBe(false);
    expect(writtenOutside("Bonjour.", "French")).toBe(false);
  });

  test("two readings share a word by a Latin word in any case, or a Chinese character", () => {
    expect(shareAWord("OK。", "ok, ok")).toBe(true);
    expect(shareAWord("OK。", "Okay.")).toBe(true);
    expect(shareAWord("王总。", "王总")).toBe(true);
    expect(shareAWord("shit。", "system")).toBe(false);
    expect(shareAWord("对。", "是。")).toBe(false);
  });

  // protects=Latin letters a Chinese speaker says on their own (OK, email, an abbreviation said letter by letter) count as said in a Chinese call, so they are never left out as the model's slip; other Latin words, and any in an English call, don't; fails_when="OK" or "KPI" said in a Chinese call is dropped, or "shit" passes as a word Chinese speech borrows; no_claim=which of them the model hears right, which the short-phrase runs count.
  test("words Chinese speech says on its own in Latin letters", () => {
    for (const said of [
      "OK。",
      "okay",
      "Email.",
      "deadline",
      "KPI。",
      "PPT",
      "k p i",
      "O K",
      "OK, OK。",
    ]) {
      expect(borrowedInto(said, "Chinese")).toBe(true);
    }
    for (const said of ["shit。", "kitty。", "bullshit", "P.", "Go on, Ranger."]) {
      expect(borrowedInto(said, "Chinese")).toBe(false);
    }
    expect(borrowedInto("OK。", "English")).toBe(false);
  });
});
