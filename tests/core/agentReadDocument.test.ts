/**
 * An agent reads a whole Document (#3573): through the same interface Claude Code or Codex use,
 * one within `READ_PART_TOKENS` comes back whole in one call, and a longer one in parts that join
 * with no gap and no overlap, each Passage with its id and place so it is cited as before. What the
 * agent may read is what it read before; a Document changed between two parts says so.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { MAX_CITES, READ_PART_TOKENS } from "../../src/core/agents/access";
import { estimateTokens } from "../../src/core/answers/context";
import { NOT_IN_A_FOLDER_ID } from "../../src/core/api";
import { translate } from "../../src/shared/i18n";
import { buildAgentShim, connectLegacyAgent, resultText, startAgentsCore } from "../helpers/agents";
import {
  createSourceFolder,
  linkAndProcess,
  waitForDocuments,
  writeSourceFile,
} from "../helpers/documents";
import { replyingModel } from "../helpers/models";

interface Read {
  documentId: string;
  document: string;
  passages: { passageId: string; location: string | null; text: string; timedText?: string }[];
  previous: string | null;
  next: string | null;
}

const PLACES = ["Kendal", "Leeds", "Preston", "Bristol", "Inverness", "Lancaster"];

/** An interview of `turns` turns, each said once: no two lines of it are alike. */
const interview = (turns: number, said = "said") =>
  Array.from({ length: turns }, (_, at) =>
    at % 2 === 0
      ? `Imogen Hale: Question ${at + 1}, about the shop in ${PLACES[at % PLACES.length]}: what happened in week ${at + 3}?`
      : `Dorothy Pennick: In week ${at + 2} we ${said} ${at * 7 + 11} tents came back from ${PLACES[(at * 5) % PLACES.length]}, and ${at + 4} of them had a torn pole sleeve.`,
  ).join("\n");

const words = (text: string) => text.replace(/\s+/g, " ").trim();

/** Two transcripts, short and long, in "Interviews", and one in "Private": the agent may read "Interviews". */
async function library() {
  const { core } = await startAgentsCore(replyingModel());
  const source = await createSourceFolder();
  const shortText = interview(60);
  const longText = interview(800);
  await writeSourceFile(source, "Short interview.txt", shortText);
  const longPath = await writeSourceFile(source, "Long interview.txt", longText);
  await writeSourceFile(source, "Private interview.txt", interview(40, "counted"));
  const documents = await linkAndProcess(core, source);
  const named = (name: string) => {
    const found = documents.find((each) => each.name === name);
    if (!found) throw new Error(`No Document ${name}.`);
    return found;
  };
  const [short, long, own] = [
    named("Short interview"),
    named("Long interview"),
    named("Private interview"),
  ];
  const shared = await core.createLibraryGroup({ name: "Interviews", description: "" });
  const kept = await core.createLibraryGroup({ name: "Private", description: "" });
  for (const each of [short, long]) await core.assignDocumentGroup(each.id, shared.id);
  await core.assignDocumentGroup(own.id, kept.id);
  await core.setAgentsEnabled(true);
  const { launch } = await core.connectAgent({ name: "Claude Code", folderIds: [shared.id] });
  const agent = await connectLegacyAgent(launch);
  const read = async (args: Record<string, unknown>) => {
    const result = await agent.callTool({ name: "read_passages", arguments: args });
    return { result, read: result.structuredContent as Read, text: resultText(result) };
  };
  /** Every part of a Document, from its start to its end. */
  const parts = async (documentId: string) => {
    const all = [await read({ documentId })];
    for (let last = all[0]; last?.read.next; last = all.at(-1)) {
      all.push(await read({ from: last.read.next }));
    }
    return all;
  };
  return {
    core,
    agent,
    read,
    parts,
    source,
    longPath,
    shortText,
    longText,
    short,
    long,
    own,
    kept,
  };
}

describe("an agent reading a Document", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  // protects=a Document within the size comes back whole in one call, each Passage with its id and place; fails_when=a Document from its start gives only its first few Passages
  it("reads one within the size whole, in one call, each Passage with its id and place", async () => {
    const { agent, read, short, shortText } = await library();
    const whole = await read({ documentId: short.id });
    expect(whole.result.isError ?? false).toBe(false);
    expect(estimateTokens(whole.text)).toBeLessThanOrEqual(READ_PART_TOKENS);
    expect(whole.read).toMatchObject({ documentId: short.id, previous: null, next: null });
    expect(whole.read.passages.length).toBeGreaterThan(4);
    expect(words(whole.read.passages.map((each) => each.text).join("\n"))).toBe(words(shortText));

    // Each Passage is the one read around it, at the same place, and holds the text it shows.
    for (const passage of whole.read.passages) {
      const [around] = (await read({ passageId: passage.passageId })).read.passages;
      expect(around?.location).toBe(passage.location);
      expect(around?.text).toContain(passage.text);
    }
    const last = whole.read.passages.at(-1);
    const quote = last?.text.split("\n").at(-1) ?? "";
    const cited = await agent.callTool({
      name: "cite",
      arguments: { citations: [{ passageId: last?.passageId, quote }] },
    });
    expect((cited.structuredContent as { citations: { check: string }[] }).citations).toEqual([
      expect.objectContaining({ check: "found", cite: expect.stringMatching(/^\[cite:/) }),
    ]);
  });

  // protects=a longer Document comes in parts within the size that join with no gap and no overlap, each read on from the part before's next; fails_when=a part repeats what the one before ended with, leaves a Passage out, or grows past the size
  it("reads a longer one in parts within the size that join with no gap and no overlap", async () => {
    const { parts, long, longText, agent } = await library();
    const read = await parts(long.id);
    expect(read.length).toBeGreaterThanOrEqual(3);
    expect(read.length).toBeLessThanOrEqual(
      Math.ceil(estimateTokens(longText) / READ_PART_TOKENS) + 1,
    );
    for (const part of read) {
      expect(part.result.isError ?? false).toBe(false);
      expect(estimateTokens(part.text)).toBeLessThanOrEqual(READ_PART_TOKENS);
      expect(part.read.document).toBe("Long interview");
    }
    for (const [at, part] of read.entries()) {
      const before = read[at - 1]?.read;
      expect(part.read.previous).toBe(before?.passages.at(-1)?.passageId ?? null);
      if (before) expect(part.read.passages[0]?.passageId).toBe(before.next);
    }
    expect(read.at(-1)?.read.next).toBeNull();
    const ids = read.flatMap((part) => part.read.passages.map((each) => each.passageId));
    expect(new Set(ids).size).toBe(ids.length);
    const joined = read.flatMap((part) => part.read.passages.map((each) => each.text)).join("\n");
    expect(words(joined)).toBe(words(longText));

    // A Passage of a later part is cited as any Passage is.
    const middle = read[1]?.read.passages[2];
    const quote = middle?.text.split("\n").find((line) => line.startsWith("Dorothy")) ?? "";
    const cited = await agent.callTool({
      name: "cite",
      arguments: { citations: [{ passageId: middle?.passageId, quote }] },
    });
    expect(
      (cited.structuredContent as { citations: { check: string }[] }).citations[0]?.check,
    ).toBe("found");
  });

  // protects=reading on reaches only what reading around a Passage does: a Document outside the share is refused as before, from its start or from one of its Passages, and one unshared between two parts stops there; fails_when=reading on from a Passage passes over the pairing's Folders
  it("reads nothing more than before: outside the share is refused, from its start or from any Passage of it", async () => {
    const { core, read, own, long, kept } = await library();
    const other = await connectLegacyAgent(
      (await core.connectAgent({ name: "Codex", folderIds: [kept.id] })).launch,
    );
    const ownPassage = (
      (await other.callTool({ name: "read_passages", arguments: { documentId: own.id } }))
        .structuredContent as Read
    ).passages[0]?.passageId;
    for (const args of [{ documentId: own.id }, { from: ownPassage }, { passageId: ownPassage }]) {
      const refused = await read(args);
      expect(refused.result.isError).toBe(true);
      expect(refused.text).toMatch(/No such passage, Document, note or Citation/);
      expect(refused.text).not.toContain("Private");
    }

    const first = await read({ documentId: long.id });
    await core.assignDocumentGroup(long.id, kept.id);
    const after = await read({ from: first.read.next });
    expect(after.result.isError).toBe(true);
    expect(after.text).toMatch(/No such passage, Document, note or Citation/);
  });

  // protects=a Document whose file changed between two parts says so, and reads again from its start; fails_when=reading on from a Passage of the version before reads on in the new one, or answers as if the Document weren't there
  it("says a Document changed between two parts, and reads it again from its start", async () => {
    const { core, read, long, longPath } = await library();
    const first = await read({ documentId: long.id });
    expect(first.read.next).not.toBeNull();

    const revised = interview(800, "reckoned");
    await writeSourceFile(
      longPath.slice(0, longPath.lastIndexOf("/")),
      "Long interview.txt",
      revised,
    );
    await core.reconcileDocuments();
    await waitForDocuments(core, (documents) => {
      const now = documents.find((each) => each.id === long.id);
      expect(now?.status).toBe("ready");
      expect(now?.contentHash).not.toBe(long.contentHash);
    });

    const on = await read({ from: first.read.next });
    expect(on.result.isError).toBe(true);
    expect(on.text).toBe(
      "“Long interview” changed since you began reading it. Read it again from its start.",
    );
    const again = await read({ documentId: long.id });
    expect(again.read.passages[0]?.text).toContain("we reckoned");
  });

  // protects=reading around a Passage is as it was: up to three before and after it, each Passage whole; fails_when=a passageId read takes a part's size or leaves out a Passage's overlap
  it("reads around a Passage as before: at most three before and three after, each whole", async () => {
    const { read, long } = await library();
    const part = await read({ documentId: long.id });
    const middle = part.read.passages[10];
    const around = await read({ passageId: middle?.passageId, before: 3, after: 3 });
    expect(around.read.passages.map((each) => each.passageId)).toEqual(
      part.read.passages.slice(7, 14).map((each) => each.passageId),
    );
    for (const [at, passage] of around.read.passages.entries()) {
      expect(passage.text).toContain(part.read.passages[7 + at]?.text ?? "");
    }
    expect(around.read.passages[1]?.text.length).toBeGreaterThan(
      part.read.passages[8]?.text.length ?? 0,
    );
    expect(around.read.previous).toBe(part.read.passages[6]?.passageId);
    expect(around.read.next).toBe(part.read.passages[14]?.passageId);
  });

  // protects=an agent citing what it read is told how to go on when a call is refused: more quotes than one call takes, or a Passage it doesn't have, named; fails_when=a refusal leaves the agent to send the same call again
  it("tells an agent citing what it read how to go on: too many quotes for one call, or a Passage it doesn't have", async () => {
    const { agent, read, short } = await library();
    const whole = await read({ documentId: short.id });
    const quotes = whole.read.passages.flatMap((passage) =>
      passage.text
        .split("\n")
        .filter((line) => line.startsWith("Dorothy"))
        .map((quote) => ({ passageId: passage.passageId, quote })),
    );
    expect(quotes.length).toBeGreaterThan(MAX_CITES);
    const cite = (citations: unknown[]) =>
      agent.callTool({ name: "cite", arguments: { citations } });

    const tooMany = await cite(quotes.slice(0, MAX_CITES + 1));
    expect(tooMany.isError).toBe(true);
    expect(resultText(tooMany)).toContain(
      `At most ${MAX_CITES} quotes a call: cite the first ${MAX_CITES}, then the rest in another call.`,
    );
    for (const some of [quotes.slice(0, MAX_CITES), quotes.slice(MAX_CITES)]) {
      const cited = (await cite(some)).structuredContent as { citations: { check: string }[] };
      expect(cited.citations.map((each) => each.check)).toEqual(some.map(() => "found"));
    }

    const madeUp = "0001da17-5c2f-463f-a18d-5ee8be66219e";
    const named = await cite([quotes[0], { passageId: madeUp, quote: quotes[1]?.quote }]);
    expect(named.isError).toBe(true);
    // The User has a Folder this agent wasn't given, so the refusal says that too (#3544).
    expect(resultText(named)).toBe(
      `${translate("en", "agents.problem.citeNotFound", { passageId: madeUp })} ${translate("en", "agents.notShared")}`,
    );
  });

  // protects=a Transcript read whole, in parts, keeps every turn's time and speaker, in the interface's words as reading around a Passage gives them (#3582); fails_when=a part leaves out a turn's speaker mark where it leaves out the overlap, or names its speaker as the file does
  it("reads a long Transcript in parts with every turn's time and speaker, in the User's language", async () => {
    const { core } = await startAgentsCore(replyingModel());
    await core.updateSettings({ user: { language: "zh-CN" } });
    const speakers = ["Me", "Them", "Bob Treloar"];
    const turns = Array.from({ length: 400 }, (_, at) => ({
      speaker: speakers[at % 3] ?? "",
      text: `Turn ${at + 1}: the ferry to ${PLACES[at % PLACES.length]} leaves at ${(at % 12) + 1} o'clock.`,
    }));
    const clock = (seconds: number) =>
      `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}.000`;
    const vtt = [
      "WEBVTT",
      "",
      ...turns.flatMap((turn, at) => [
        `${clock(at * 5)} --> ${clock(at * 5 + 4)}`,
        `<v ${turn.speaker}>${turn.text}`,
        "",
      ]),
    ].join("\n");
    const source = await createSourceFolder();
    await writeSourceFile(source, "Ferry call.vtt", vtt);
    const [call] = await linkAndProcess(core, source);
    expect(call?.kind).toBe("transcript");
    await core.setAgentsEnabled(true);
    const agent = await connectLegacyAgent(
      (await core.connectAgent({ name: "Claude Code", folderIds: [NOT_IN_A_FOLDER_ID] })).launch,
    );
    const parts: { read: Read; text: string }[] = [];
    for (let args: Record<string, unknown> = { documentId: call?.id }; ; ) {
      const result = await agent.callTool({ name: "read_passages", arguments: args });
      const part = { read: result.structuredContent as Read, text: resultText(result) };
      expect(estimateTokens(part.text)).toBeLessThanOrEqual(READ_PART_TOKENS);
      parts.push(part);
      if (!part.read.next) break;
      args = { from: part.read.next };
    }
    expect(parts.length).toBeGreaterThan(1);
    const said = parts
      .flatMap((part) => part.read.passages.map((each) => each.timedText ?? ""))
      .join("\n");
    const shown: Record<string, string> = {
      Me: translate("zh-CN", "transcript.speaker.me"),
      Them: translate("zh-CN", "transcript.speaker.them"),
    };
    for (const [at, turn] of turns.entries()) {
      const time = `${Math.floor((at * 5) / 60)}:${String((at * 5) % 60).padStart(2, "0")}`;
      expect(said).toContain(`[${time} ${shown[turn.speaker] ?? turn.speaker}] ${turn.text}`);
    }
  });
});
