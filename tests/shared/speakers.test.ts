import { describe, expect, test } from "vitest";
import { citedLocation, citedSpeakers } from "../../src/shared/citations";
import { translate } from "../../src/shared/i18n";
import { formatLocation } from "../../src/shared/locations";
import {
  isTheirs,
  looksLikeLabel,
  markWords,
  numberedVoice,
  parseTranscriptSpeakers,
  readStoredSpeakers,
  SPEAKER_ME,
  SPEAKER_THEM,
  SPEAKER_UNKNOWN,
  shownSpeaker,
  speakerKey,
  speakerMark,
  speakerName,
  speakersIn,
  withSpeakerChosen,
} from "../../src/shared/speakers";

describe("The words for who said a live line (#941)", () => {
  test.each([
    [SPEAKER_ME, "Me", "我"],
    [SPEAKER_THEM, "Them", "对方"],
    [SPEAKER_UNKNOWN, "Speaker ?", "发言人 ?"],
  ])("%s is worded in English and Chinese", (speaker, english, chinese) => {
    const key = speakerKey(speaker);
    expect(key).not.toBeNull();
    if (!key) return;
    expect(translate("en", key)).toBe(english);
    expect(translate("zh-CN", key)).toBe(chinese);
  });

  test("a person's name is shown as it is", () => {
    expect(speakerKey("Dana")).toBeNull();
    expect(speakerKey("Speaker 1")).toBeNull();
  });

  test('voices told apart are "Speaker n" in the interface\'s language, and so are those a Transcript saved before #138 numbered "Them n"', () => {
    const en = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
      translate("en", key, params);
    const zh = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
      translate("zh-CN", key, params);
    expect(speakerName(numberedVoice(2), en)).toBe("Speaker 2");
    expect(speakerName(numberedVoice(2), zh)).toBe("发言人 2");
    expect(speakerName("Them 2", en)).toBe("Speaker 2");
    expect(speakerName("Them 2", zh)).toBe("发言人 2");
  });

  test("every line but the User's microphone and an unknown speaker's is another person's", () => {
    expect([numberedVoice(2), SPEAKER_THEM, "Them 2", "Dana"].every(isTheirs)).toBe(true);
    expect([SPEAKER_ME, SPEAKER_UNKNOWN, null].some(isTheirs)).toBe(false);
  });
});

const en = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
  translate("en", key, params);
const zh = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
  translate("zh-CN", key, params);

/** A call: Me at 0 s and 4 s, Speaker 1 at 2 s and 6 s, Speaker 2 at 8 s. */
const CALL = [
  { startMs: 0, label: "Me" },
  { startMs: 2000, label: "Speaker 1" },
  { startMs: 4000, label: "Me" },
  { startMs: 6000, label: "Speaker 1" },
  { startMs: 8000, label: "Speaker 2" },
];
const at = (startMs: number) => CALL.find((line) => line.startMs === startMs) as (typeof CALL)[0];

describe("Who's who in a Transcript (#138)", () => {
  // protects=Apply to all with a new name names the line's Speaker, without it a new "Speaker N" takes the line, and renaming that Speaker later renames the line; fails_when=a name is stored on a line, the new label reuses one the file has, or the rename misses the moved line; no_claim=what the window shows, which the renderer test covers.
  test("a new name with Apply to all names the Speaker, and alone gives the line a new Speaker that a later rename follows", () => {
    const named = withSpeakerChosen(null, CALL, at(2000), { name: "Dana" }, true);
    expect(named).toEqual({ labels: { "Speaker 1": "Dana" }, lines: {} });
    expect(shownSpeaker(named, 6000, "Speaker 1", en)).toBe("Dana");

    const moved = withSpeakerChosen(named, CALL, at(8000), { name: "Priya" }, false);
    expect(moved).toEqual({
      labels: { "Speaker 1": "Dana", "Speaker 3": "Priya" },
      lines: { "8000 Speaker 2": "Speaker 3" },
    });
    const renamed = withSpeakerChosen(moved, CALL, at(8000), { name: "Priya Shah" }, true);
    expect(shownSpeaker(renamed, 8000, "Speaker 2", en)).toBe("Priya Shah");
    expect(renamed.lines).toEqual({ "8000 Speaker 2": "Speaker 3" });
  });

  // protects=picking a Speaker moves one line, or with Apply to all every line by the line's Speaker now, and a line given back to its file's label keeps no entry; fails_when=Apply to all moves lines by another Speaker, or leaves an entry that says what the file says; no_claim=the menu's keys.
  test("picking a Speaker moves the line, or every line by its Speaker, and giving a line back leaves no entry", () => {
    const one = withSpeakerChosen(null, CALL, at(6000), { label: "Speaker 2" }, false);
    expect(one.lines).toEqual({ "6000 Speaker 1": "Speaker 2" });
    const all = withSpeakerChosen(one, CALL, at(8000), { label: "Me" }, true);
    expect(all.lines).toEqual({ "6000 Speaker 1": "Me", "8000 Speaker 2": "Me" });
    expect(speakersIn(all, CALL)).toEqual(["Me", "Speaker 1"]);
    const back = withSpeakerChosen(all, CALL, at(6000), { label: "Speaker 1" }, false);
    expect(back.lines).toEqual({ "8000 Speaker 2": "Me" });
  });

  // protects=Me is the User: a new name for every line by Me moves them to a new Speaker, so Me is never named, and the model still reads Me; fails_when=Me takes a name, or a model reads a name for the User; no_claim=the fill's wording, which the real-model check covers.
  test('"Me" is never named: its lines go to a new Speaker, and a model reads "Me" for the User', () => {
    const moved = withSpeakerChosen(null, CALL, at(0), { name: "Sam" }, true);
    expect(moved).toEqual({
      labels: { "Speaker 3": "Sam" },
      lines: { "0 Me": "Speaker 3", "4000 Me": "Speaker 3" },
    });
    const given = withSpeakerChosen(null, CALL, at(2000), { label: SPEAKER_ME }, false);
    expect(speakerMark(given, 2000, "Speaker 1")).toBe("Me");
    expect(shownSpeaker(given, 2000, "Speaker 1", zh)).toBe("我");
    expect(parseTranscriptSpeakers({ labels: { Me: "Joey" }, lines: {} })).toEqual({
      speakers: null,
      dropped: 1,
    });
  });

  // protects=a Citation's Location words its Speaker by the name as it is now, from the label it stores, in English and Chinese, and keeps the label's words when nobody is named; fails_when=a Location shows the stored label for a named Speaker, or a name in place of "Me"; no_claim=where each place gets the map from, which the core tests cover.
  test("a Citation's Location names its Speaker as the User named them, from the label it stores", () => {
    const speakers = withSpeakerChosen(null, CALL, at(2000), { name: "王丽" }, true);
    const location = { kind: "time" as const, from: 2000, to: 3000, speaker: "Speaker 1" };
    expect(formatLocation(location, en, { speakers })).toBe("王丽 · 0:02");
    expect(formatLocation(location, zh, { speakers })).toBe("王丽 · 0:02");
    expect(formatLocation(location, zh)).toBe("发言人 1 · 0:02");
    expect(formatLocation({ ...location, from: 0, speaker: "Me" }, zh, { speakers })).toBe(
      "我 · 0:00",
    );
    expect(formatLocation(location, en, { speakers, speaker: false })).toBe("0:02");
    // The Location as a Note keeps it, JSON text, and as an object.
    const documents = [{ id: "t", contentHash: "h", speakers }];
    for (const stored of [JSON.stringify(location), location]) {
      const found = citedSpeakers(
        { documentId: "t", contentHash: "h", location: stored },
        documents,
      );
      expect(found).toEqual(speakers);
      expect(formatLocation(location, en, { speakers: found })).toBe("王丽 · 0:02");
    }
    expect(citedLocation({ documentId: "t", contentHash: "h", location }, en, documents)).toBe(
      "王丽 · 0:02",
    );
  });

  // protects=who's who as stored or sent keeps only what holds: a line known by its start and label, names of 1 to 200 characters, a label like "__proto__" kept as a label; text that isn't JSON is said as dropped; fails_when=a bad entry is kept, a good one dropped, or a label reaches the object's prototype; no_claim=the core's refusal, which the core test covers.
  test("who's who keeps only what holds, a label named like an object's own key included", () => {
    expect(
      parseTranscriptSpeakers({
        labels: { "Speaker 1": "Dana", "Speaker 2": " ", "Speaker 3": "x".repeat(201) },
        lines: { "2000 Speaker 1": "Me", "no start": "Me" },
      }),
    ).toEqual({
      speakers: { labels: { "Speaker 1": "Dana" }, lines: { "2000 Speaker 1": "Me" } },
      dropped: 3,
    });
    const odd = withSpeakerChosen(
      null,
      [{ startMs: 0, label: "__proto__" }],
      { startMs: 0, label: "__proto__" },
      { name: "Dana" },
      true,
    );
    expect(Object.keys(odd.labels)).toEqual(["__proto__"]);
    expect(shownSpeaker(odd, 0, "__proto__", en)).toBe("Dana");
    expect(shownSpeaker(null, 0, "constructor", en)).toBe("constructor");
    expect(readStoredSpeakers("{")).toEqual({ speakers: null, dropped: 1 });
    // A name a label's words make, one a format character hides, or one past what a mark carries.
    expect(
      parseTranscriptSpeakers({
        labels: {
          "Speaker 1": "发言人 2",
          "Speaker 2": "Dana\u202E",
          "Speaker 3": "x".repeat(61),
          "Speaker 4": "y".repeat(60),
        },
        lines: {},
      }),
    ).toEqual({ speakers: { labels: { "Speaker 4": "y".repeat(60) }, lines: {} }, dropped: 3 });
  });

  // protects=the words of every label a Meeting's Transcript can have, in English and Chinese, half-width or full-width, are known as a label's, and a person's name with a digit or brackets isn't; a mark makes brackets spaces; fails_when=a label's words pass as a name, or a name is refused; no_claim=a .vtt the User added, whose own labels can be any words.
  test("a label's words are known in either language, and a mark makes brackets spaces", () => {
    for (const words of [
      "Me",
      "me",
      "我",
      "Them",
      "对方",
      "Speaker ?",
      "Speaker 12",
      "Them 3",
      "发言人 2",
      "发言人２",
      "发言人？",
    ]) {
      expect(looksLikeLabel(words)).toBe(true);
    }
    for (const name of [
      "Dana",
      "3M rep",
      "(Client) Dana",
      "Dana [CFO]",
      "王总（客户）",
      "Meg",
      "Speaker Lin",
    ]) {
      expect(looksLikeLabel(name)).toBe(false);
    }
    expect(markWords("Dana [CFO]")).toBe("Dana CFO");
    expect(markWords("[Lin]\nWu")).toBe("Lin Wu");
    expect(readStoredSpeakers(null)).toEqual({ speakers: null, dropped: 0 });
  });
});
