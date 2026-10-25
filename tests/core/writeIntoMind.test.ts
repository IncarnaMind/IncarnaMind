import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { type Core, GENERATED_MARK } from "../../src/core";
import { askedFor } from "../../src/shared/askedChanges";
import { readChart } from "../../src/shared/charts";
import { pendingProposals, proposalRequestOf } from "../../src/shared/proposals";
import { askAssistant, changesIn, lastResult, mindCalls } from "../helpers/assistant";
import { answerEnded, setUpWithDocuments, shownPassages } from "../helpers/citations";
import { connectToMind } from "../helpers/mindClient";
import { note, readMind, resolveChanges, shownWithChanges, writeMind } from "../helpers/minds";
import { type ModelCall, type ScriptedReply, scriptedModel } from "../helpers/models";

/**
 * A request to write something goes into a Mind, and "make it a document"
 * after an Answer puts that Answer in a new one as it is (#1109), through the
 * core's public interface as the assistant asks: the model is told where a
 * piece goes (#1559), and the Answer's text, Citations and scope come over
 * with no new search. The model's choices are scripted; real models' are checked by hand.
 */

const LEASES = Array.from({ length: 7 }, (_, index) => ({
  name: `Lease ${index + 1}.md`,
  contents: `# Lease ${index + 1}\n\nThe rent for unit ${index + 1} is ${1000 + index * 100} euros a month.\n`,
}));
const QUOTES = LEASES.map(
  (_, index) => `The rent for unit ${index + 1} is ${1000 + index * 100} euros a month`,
);
const CITED = QUOTES.map((quote, index) => `${quote} [^${index + 1}].`).join("\n\n");

const WRITE_COMMAND = "The write command is create_mind for a new Mind";
const AS_A_DOCUMENT = "To put your last Answer into a Mind as it is";

/** The instructions of the request that offers the Minds' Tools. */
const withMindTools = (systems: readonly string[]) =>
  systems.find((system) => system.includes("read_mind")) ?? "";

const called = (call: ModelCall, tool: string) => call.results.some((each) => each.tool === tool);

/** Searches for every lease, then cites each one's rent, then `next`. */
function citingAll(call: ModelCall, next: () => ScriptedReply): ScriptedReply {
  if (!called(call, "search_documents")) {
    return {
      calls: LEASES.map((_, index) => ({
        tool: "search_documents",
        input: { query: `rent for unit ${index + 1}` },
      })),
    };
  }
  if (!called(call, "cite")) {
    const shown = call.results
      .filter((each) => each.tool === "search_documents")
      .flatMap((each) => shownPassages(each.text));
    const citations = QUOTES.map((quote, index) => ({
      marker: index + 1,
      passage: shown.find((passage) => passage.text.includes(quote))?.id ?? "",
      quote,
    }));
    return { calls: [{ tool: "cite", input: { citations } }] };
  }
  return next();
}

function checks(doc: ProseMirrorNode): string[] {
  const found: string[] = [];
  doc.descendants((node) => {
    if (node.type.name === "citation") found.push(String(node.attrs.check));
    return true;
  });
  return found;
}

async function madeBy(core: Core, answer: Awaited<ReturnType<typeof askAssistant>>) {
  const made = changesIn(answer).find((change) => change.created);
  if (!made) throw new Error("The Answer made no Mind.");
  const client = await connectToMind(core, made.mindId);
  await client.settled();
  return { mindId: made.mindId, doc: readMind(client) };
}

describe("A request to write something (#1109)", { timeout: 60_000 }, () => {
  // protects=the owner's "根据我现有的文件帮我写一份summary", and its English, tell the model where a piece goes, and the Mind made holds every Document's Citation, checked; fails_when=the model is told nothing, or the Mind made leaves Documents or Citations out; no_claim=that a real model writes it there.
  test.each(["根据我现有的文件帮我写一份summary", "Based on my files, write a summary"])(
    "“%s” goes into a new Mind, every Document cited",
    async (request) => {
      const systems: string[] = [];
      const model = scriptedModel((call) => {
        systems.push(call.system);
        return citingAll(call, () =>
          called(call, "create_mind")
            ? { text: "Done." }
            : { calls: [{ tool: "create_mind", input: { title: "Summary", content: CITED } }] },
        );
      });
      const { core, mind, client } = await setUpWithDocuments(model, LEASES);
      writeMind(client, [note("Notes on the leases.")]);
      await client.settled();

      const answer = await askAssistant(core, { text: request, mindId: mind.id });

      expect(withMindTools(systems)).toContain(WRITE_COMMAND);
      const made = await madeBy(core, answer);
      expect(checks(made.doc)).toEqual(QUOTES.map(() => "found"));
    },
  );

  // protects=in an empty Mind, the model is told it is the page the User is in, where a piece goes; fails_when=it isn't told the Mind is open and empty; no_claim=none beyond protects.
  test("in an empty Mind, it fills that Mind", async () => {
    const systems: string[] = [];
    const model = scriptedModel((call) => {
      systems.push(call.system);
      return { text: "Done." };
    });
    const { core } = await setUpWithDocuments(model, LEASES.slice(0, 1));
    const empty = await core.createMind({ title: "" });

    await askAssistant(core, { text: "根据我现有的文件帮我写一份summary", mindId: empty.id });

    expect(withMindTools(systems)).toContain("The Mind in <mind> is open and still empty");
    expect(withMindTools(systems)).toContain(WRITE_COMMAND);
  });
});

describe("“Make it a document” after an Answer (#1109)", { timeout: 60_000 }, () => {
  // protects=after a panel Answer citing all seven Documents, asking for it as a document, in the owner's words or in English, makes a Mind of that Answer as it is: the same Citations, checked, with no new search, in the Folder the Answer searched; fails_when=the model searches again, the Mind covers fewer Documents, its Citations are lost, or it lands in another Folder; no_claim=that a real model gives answer: true.
  test.each(["把这个做成文档", "Make it a document"])(
    "“%s” makes a Mind of the Answer, every Citation kept, nothing searched again",
    async (request) => {
      const systems: string[] = [];
      let second: ModelCall[] = [];
      const model = scriptedModel((call) => {
        if (call.prompt.includes(request)) {
          second = [...second, call];
          systems.push(call.system);
          return called(call, "create_mind")
            ? { text: "Done." }
            : { calls: [{ tool: "create_mind", input: { title: "Leases", answer: true } }] };
        }
        return citingAll(call, () => ({ text: CITED }));
      });
      const { core, mind, client, documents } = await setUpWithDocuments(model, LEASES);
      writeMind(client, [note("Notes on the leases.")]);
      await client.settled();
      const folder = await core.createLibraryGroup({ name: "Leases", description: "" });
      await core.moveToFolder({
        documentIds: documents.map((document) => document.id),
        folderId: folder.id,
      });
      const scope = { folderIds: [folder.id], tagIds: [], documentIds: [] };

      const first = await askAssistant(core, {
        text: "What are the rents?",
        mindId: mind.id,
        scope,
      });
      expect(first.citations).toHaveLength(7);
      const answer = await askAssistant(core, {
        text: request,
        mindId: mind.id,
        conversationId: first.conversationId,
      });

      expect(withMindTools(systems)).toContain(AS_A_DOCUMENT);
      expect(withMindTools(systems)).toContain(
        "give answer: true to add_to_mind for the Mind in <mind>, or to create_mind",
      );
      expect(second.flatMap((call) => call.results.map((each) => each.tool))).not.toContain(
        "search_documents",
      );
      expect(mindCalls(answer)[0]?.input).toEqual({ title: "Leases", answer: true });
      const made = await madeBy(core, answer);
      expect(checks(made.doc)).toEqual(QUOTES.map(() => "found"));
      const minds = await core.listMinds();
      expect(minds.find((each) => each.id === made.mindId)?.folderId).toBe(folder.id);
    },
  );
});

/** Searches for every lease, cites the rents it was shown, and writes those into a new Mind. */
function summaryOfShown(call: ModelCall): ScriptedReply {
  if (!called(call, "search_documents")) return citingAll(call, () => ({ text: "" }));
  const shown = call.results
    .filter((each) => each.tool === "search_documents")
    .flatMap((each) => shownPassages(each.text));
  const citations = QUOTES.flatMap((quote, index) => {
    const passage = shown.find((each) => each.text.includes(quote));
    return passage ? [{ marker: index + 1, passage: passage.id, quote }] : [];
  });
  if (!called(call, "cite")) return { calls: [{ tool: "cite", input: { citations } }] };
  if (called(call, "create_mind") || called(call, "add_to_mind")) return { text: "Done." };
  const content = citations.map((each) => `${each.quote} [^${each.marker}].`).join("\n\n");
  // As a model does, it writes where it is told: into the empty Mind in front, or into a new Mind.
  return call.system.includes("The Mind in <mind> is open and still empty")
    ? { calls: [{ tool: "add_to_mind", input: { content } }] }
    : { calls: [{ tool: "create_mind", input: { title: "Summary", content } }] };
}

/** Two of the seven leases in a Folder, and a Mind there whose scope that Folder is. */
async function inAFolderOfTwo(model: ReturnType<typeof scriptedModel>, { empty = false } = {}) {
  const { core, documents } = await setUpWithDocuments(model, LEASES);
  const folder = await core.createLibraryGroup({ name: "Two leases", description: "" });
  await core.moveToFolder({
    documentIds: documents.slice(0, 2).map((document) => document.id),
    folderId: folder.id,
  });
  const mind = await core.createMind({ title: "Lease notes", folderId: folder.id });
  const client = await connectToMind(core, mind.id);
  if (!empty) writeMind(client, [note("Notes on the leases.")]);
  await client.settled();
  const scope = { folderIds: [folder.id], tagIds: [], documentIds: [] };
  return { core, mind, folder, scope, client };
}

describe("A request to write from part of the Documents (#1149)", { timeout: 60_000 }, () => {
  // protects=from a Mind whose scope holds 2 of 7 Documents, a request to write, in English or the owner's Chinese, writes from those 2 and says 2 of 7; Use all writes that same Mind again from all 7 as one change, applied as asked, which rejected leaves the 2-Document text; the Mind keeps its Folder; fails_when=no count, the text covers more than the scope, Use all makes a second Mind, the rewrite isn't one asked change, or Undo can't get the 2-Document text back; no_claim=the window's own Undo step, which the e2e checks.
  test.each(["Based on my files, write a summary", "根据我现有的文件帮我写一份summary"])(
    "“%s” from 2 of 7 says so, and Use all writes the same Mind again from all 7",
    async (request) => {
      const model = scriptedModel(summaryOfShown);
      const { core, mind, folder, scope } = await inAFolderOfTwo(model);

      const first = await askAssistant(core, { text: request, mindId: mind.id, scope });

      expect(first.steps?.writtenFrom).toEqual({ documents: 2, total: 7 });
      const made = changesIn(first).find((change) => change.created);
      const summary = await connectToMind(core, made?.mindId ?? "");
      await resolveChanges(summary, "accept");
      await summary.settled();
      expect(checks(readMind(summary))).toEqual(["found", "found"]);

      const again = await core.regenerateConversationAnswer({
        conversationId: first.conversationId,
        answerId: first.id,
        clearScope: true,
      });
      if (!again.asked) throw new Error("Not asked again.");
      expect((await answerEnded(core, again.answerId)).event).toBe("finished");
      const { messages } = await core.getConversation(first.conversationId);
      const rewritten = messages.find((message) => message.id === again.answerId);
      if (rewritten?.kind !== "answer") throw new Error("No Answer.");

      expect(rewritten.steps?.writtenFrom).toBeUndefined();
      const changes = changesIn(rewritten);
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({ mindId: made?.mindId, created: false });
      await summary.settled();
      expect(proposalRequestOf(summary.doc, changes[0]?.request ?? "")).toMatchObject({
        requested: "write",
      });
      expect(lastResult(model)).toContain("applies in the Mind at once");
      const summaries = (await core.listMinds()).filter((each) => each.title === "Summary");
      expect(summaries.map((each) => each.id)).toEqual([made?.mindId]);
      await resolveChanges(summary, "accept");
      expect(checks(readMind(summary))).toEqual(QUOTES.map(() => "found"));
      expect(shownWithChanges(summary)[0]).toBe("Summary");
      expect((await core.listMinds()).find((each) => each.id === mind.id)?.folderId).toBe(
        folder.id,
      );
    },
  );

  // protects=the rewrite from all Documents is one change: rejecting it leaves the 2-Document text exactly; fails_when=any of the old text is lost or the new text stays; no_claim=none beyond protects.
  test("rejected, the rewrite leaves the 2-Document text as it was", async () => {
    const model = scriptedModel(summaryOfShown);
    const { core, mind, scope } = await inAFolderOfTwo(model);
    const first = await askAssistant(core, {
      text: "Based on my files, write a summary",
      mindId: mind.id,
      scope,
    });
    const made = changesIn(first).find((change) => change.created);
    const summary = await connectToMind(core, made?.mindId ?? "");
    await resolveChanges(summary, "accept");
    await summary.settled();
    const fromTwo = shownWithChanges(summary);

    const again = await core.regenerateConversationAnswer({
      conversationId: first.conversationId,
      answerId: first.id,
      clearScope: true,
    });
    if (!again.asked) throw new Error("Not asked again.");
    await answerEnded(core, again.answerId);
    await summary.settled();
    expect(shownWithChanges(summary)).not.toEqual(fromTwo);
    await resolveChanges(summary, "reject");

    expect(shownWithChanges(summary)).toEqual(fromTwo);
  });

  // protects=with every Document in scope, or for a Question that writes nothing, no count is given; fails_when=the line shows when nothing was left out, or on an ordinary Question; no_claim=none beyond protects.
  test("with every Document in scope, or for a Question, no line", async () => {
    const model = scriptedModel((call) =>
      call.prompt.includes("What is the rent") ? { text: "1000 euros." } : summaryOfShown(call),
    );
    const { core, mind, scope } = await inAFolderOfTwo(model);

    const everything = await askAssistant(core, {
      text: "Based on my files, write a summary",
      mindId: mind.id,
    });
    const question = await askAssistant(core, {
      text: "What is the rent for unit 1?",
      mindId: mind.id,
      scope,
    });

    expect(everything.steps?.writtenFrom).toBeUndefined();
    expect(question.steps?.writtenFrom).toBeUndefined();
  });
});

/** Writes the Answer again from every Document, as Use all does, and gives it once it has ended. */
async function useAll(core: Core, answer: Awaited<ReturnType<typeof askAssistant>>) {
  const again = await core.regenerateConversationAnswer({
    conversationId: answer.conversationId,
    answerId: answer.id,
    clearScope: true,
  });
  if (!again.asked) throw new Error("Not asked again.");
  expect((await answerEnded(core, again.answerId)).event).toBe("finished");
  const { messages } = await core.getConversation(answer.conversationId);
  const rewritten = messages.find((message) => message.id === again.answerId);
  if (rewritten?.kind !== "answer") throw new Error("No Answer.");
  return rewritten;
}

/**
 * Searches, then writes the rents into a Mind with no Citation; told it has none (#1415), it
 * writes it again as it was.
 */
function uncitedSummary(call: ModelCall): ScriptedReply {
  if (!called(call, "search_documents")) {
    return { calls: [{ tool: "search_documents", input: { query: "monthly rent" } }] };
  }
  const writes = call.results.filter((each) => each.tool === "create_mind");
  const refused = writes.length === 1 && writes[0]?.text.includes("content has no Citation");
  if (writes.length > 0 && !refused) return { text: "Done." };
  return {
    calls: [{ tool: "create_mind", input: { title: "Summary", content: QUOTES.join("\n\n") } }],
  };
}

describe("Use all of a summary with no Citation (#1415)", { timeout: 60_000 }, () => {
  // protects=Use all writes an accepted uncited summary again in place through the same check as a new write: refused once, then, written again as it was, marked uncited, so the line under the Answer stays; fails_when=the rewrite in place is taken unchecked or unmarked, or makes a second Mind; no_claim=the line's words (tests/renderer/changeProblems.test.ts).
  test("refused once, and written again as it was, marked uncited", async () => {
    const model = scriptedModel(uncitedSummary);
    const { core, mind, scope } = await inAFolderOfTwo(model);
    const first = await askAssistant(core, {
      text: "Based on my files, write a summary",
      mindId: mind.id,
      scope,
    });
    const writes = (answer: Awaited<ReturnType<typeof askAssistant>>) =>
      mindCalls(answer).map((call) => [call.status, call.mindProblem?.kind ?? null]);
    expect(writes(first)).toEqual([
      ["failed", "uncited"],
      ["done", null],
    ]);
    const made = changesIn(first)[0];
    expect(made).toMatchObject({ created: true, uncited: true });
    const summary = await connectToMind(core, made?.mindId ?? "");
    await resolveChanges(summary, "accept");

    const rewritten = await useAll(core, first);

    expect(writes(rewritten)).toEqual([
      ["failed", "uncited"],
      ["done", null],
    ]);
    expect(changesIn(rewritten)).toEqual([
      expect.objectContaining({ mindId: made?.mindId, created: false, uncited: true }),
    ]);
    const summaries = (await core.listMinds()).filter((each) => each.title === "Summary");
    expect(summaries.map((each) => each.id)).toEqual([made?.mindId]);
  });
});

describe("Use all, where the text went (#1171 review)", { timeout: 60_000 }, () => {
  // protects=in an empty Mind, a request to write fills it, and Use all writes that same text again from every Document in its place, as one asked change, with no new Mind; rejected, it leaves the 2-Document text; fails_when=Use all makes a new Mind, or Undo leaves an empty Mind; no_claim=the window's own Undo step.
  test("in an empty Mind the request filled, Use all writes it again there", async () => {
    const model = scriptedModel(summaryOfShown);
    const { core, mind, scope, client } = await inAFolderOfTwo(model, { empty: true });
    const minds = (await core.listMinds()).length;
    const first = await askAssistant(core, {
      text: "Based on my files, write a summary",
      mindId: mind.id,
      scope,
    });
    expect(changesIn(first)[0]).toMatchObject({ mindId: mind.id, created: false });
    await resolveChanges(client, "accept");
    await client.settled();
    const fromTwo = shownWithChanges(client);

    const rewritten = await useAll(core, first);
    await client.settled();

    expect(changesIn(rewritten)).toEqual([
      expect.objectContaining({ mindId: mind.id, created: false }),
    ]);
    expect((await core.listMinds()).length).toBe(minds);
    expect(shownWithChanges(client)).not.toEqual(fromTwo);
    await resolveChanges(client, "reject");
    expect(shownWithChanges(client)).toEqual(fromTwo);
  });

  // protects=text the User typed in since isn't taken away at once by Use all: the rewrite waits for them, as changes that would remove their words wait (#880), and the model is told it waits; fails_when=the rewrite applies at once over their words; no_claim=the window's line, which shows what waits.
  test("text the User typed in since makes the rewrite wait", async () => {
    const model = scriptedModel(summaryOfShown);
    const { core, mind, scope } = await inAFolderOfTwo(model);
    const first = await askAssistant(core, {
      text: "Based on my files, write a summary",
      mindId: mind.id,
      scope,
    });
    const made = changesIn(first).find((change) => change.created);
    const summary = await connectToMind(core, made?.mindId ?? "");
    await resolveChanges(summary, "accept");
    await summary.settled();
    const [, paragraph] = summary.blocks.toArray();
    const words = paragraph instanceof Y.XmlElement ? paragraph.get(0) : null;
    if (!(words instanceof Y.XmlText)) throw new Error("No paragraph.");
    // Typed, as the editor writes it: not marked as AI text.
    words.insert(words.length, " My own words.", { [GENERATED_MARK]: null });
    await summary.settled();

    const rewritten = await useAll(core, first);
    await summary.settled();

    const [change] = changesIn(rewritten);
    expect(proposalRequestOf(summary.doc, change?.request ?? "")).not.toHaveProperty("requested");
    expect(lastResult(model)).toContain("wait");
    expect(shownWithChanges(summary).join("\n")).toContain("My own words.");
  });
});

/** Searches each lease, cites the rents it was shown, and adds them as a table with a bar chart. */
function chartOfShown(call: ModelCall): ScriptedReply {
  if (!called(call, "search_documents")) return citingAll(call, () => ({ text: "" }));
  const shown = call.results
    .filter((each) => each.tool === "search_documents")
    .flatMap((each) => shownPassages(each.text));
  const citations = QUOTES.flatMap((quote, index) => {
    const passage = shown.find((each) => each.text.includes(quote));
    return passage ? [{ marker: index + 1, passage: passage.id, quote }] : [];
  });
  if (!called(call, "cite")) return { calls: [{ tool: "cite", input: { citations } }] };
  if (called(call, "add_to_mind")) return { text: "" };
  const content = [
    "| Unit | Rent |",
    "|---|---|",
    ...citations.map(
      (each) =>
        `| Unit ${each.marker} | ${1000 + (each.marker - 1) * 100} euros [^${each.marker}] |`,
    ),
  ].join("\n");
  return {
    calls: [{ tool: "add_to_mind", input: { chart: { kind: "bar", title: "Rents" }, content } }],
  };
}

/** The Mind's charts' row labels, as they read now. */
function chartRows(doc: ProseMirrorNode): string[][] {
  const charts: string[][] = [];
  doc.forEach((node) => {
    if (node.type.name === "chart")
      charts.push(readChart(node.attrs).data.rows.map((row) => row.label));
  });
  return charts;
}

describe("Use all of a chart asked for", { timeout: 60_000 }, () => {
  // protects=a chart asked for over 2 of 7 Documents, written again from all 7 with Use all, gets its chart drawn again from the new cited table, the table and the chart one change the User asked for, so it applies at once; rejecting it brings back both as they were; fails_when=Use all leaves the old chart, drops it, waits as the User's edited text would, or Undo can't bring back the 2-Document table and chart; no_claim=the window's own Undo step.
  test("Use all redraws the chart from the rewritten table, and rejecting brings both back", async () => {
    const model = scriptedModel(chartOfShown);
    const { core, mind, scope, client } = await inAFolderOfTwo(model);
    const first = await askAssistant(core, {
      text: "make a bar chart of the rents",
      mindId: mind.id,
      scope,
    });
    expect(first.steps?.writtenFrom).toEqual({ documents: 2, total: 7 });
    await resolveChanges(client, "accept");
    await client.settled();
    const fromTwo = shownWithChanges(client);
    expect(chartRows(readMind(client))).toEqual([["Unit 1", "Unit 2"]]);

    const rewritten = await useAll(core, first);
    await client.settled();

    const changes = changesIn(rewritten);
    expect(changes).toEqual([expect.objectContaining({ mindId: mind.id, tables: 1, charts: 1 })]);
    expect(new Set(pendingProposals(client.blocks).map((each) => each.request))).toEqual(
      new Set([changes[0]?.request]),
    );
    expect(askedFor(client.doc, changes[0]?.request ?? "")).toBe(true);
    await resolveChanges(client, "reject");
    expect(shownWithChanges(client)).toEqual(fromTwo);
    expect(chartRows(readMind(client))).toEqual([["Unit 1", "Unit 2"]]);
  });

  // protects=accepted, the rewrite holds the table of all 7 and one chart of it, no second chart; fails_when=the old chart stays beside the new; no_claim=none beyond protects.
  test("accepted, the rewrite holds one chart, of all 7", async () => {
    const model = scriptedModel(chartOfShown);
    const { core, mind, scope, client } = await inAFolderOfTwo(model);
    const first = await askAssistant(core, {
      text: "make a bar chart of the rents",
      mindId: mind.id,
      scope,
    });
    await resolveChanges(client, "accept");
    await client.settled();

    await useAll(core, first);
    await client.settled();
    await resolveChanges(client, "accept");

    expect(chartRows(readMind(client))).toEqual([LEASES.map((_, index) => `Unit ${index + 1}`)]);
  });
});
