import { describe, expect, test } from "vitest";
import { type Core, messageReference } from "../../src/core";
import { createTempDataFolder, startCore } from "../helpers/core";
import { appendParagraph, connectToMind, typeInto } from "../helpers/mindClient";

describe("a Mind without a title", () => {
  test("is named by its first line of text, which follows the edits", async () => {
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind();
    const client = await connectToMind(core, mind.id);

    expect((await core.listMinds())[0]?.autoTitle).toBe("");

    appendParagraph(client, "Tides and the moon");
    appendParagraph(client, "A second paragraph");
    await client.settled();
    expect((await core.listMinds())[0]?.autoTitle).toBe("Tides and the moon");

    typeInto(client, 0, "Tides".length, " in Bergen");
    await client.settled();
    expect((await core.listMinds())[0]?.autoTitle).toBe("Tides in Bergen and the moon");
  });

  test("is named from a long Chinese first line, cut at a character", async () => {
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind();
    const client = await connectToMind(core, mind.id);

    appendParagraph(client, "夜间降温".repeat(30));
    await client.settled();

    const title = (await core.listMinds())[0]?.autoTitle ?? "";
    expect(title).toBe("夜间降温".repeat(15));
  });

  test("is told to the app as it is typed", async () => {
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind();
    const client = await connectToMind(core, mind.id);
    const names: string[][] = [];
    core.on("minds.changed", (minds) => names.push(minds.map((each) => each.autoTitle)));

    appendParagraph(client, "Hello");
    await client.settled();

    expect(names.at(-1)).toEqual(["Hello"]);
  });

  test("a title the User typed is never replaced", async () => {
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind();
    const client = await connectToMind(core, mind.id);
    appendParagraph(client, "First line");
    await client.settled();

    await core.renameMind(mind.id, "My title");
    typeInto(client, 0, 0, "The ");
    await client.settled();

    const [listed] = await core.listMinds();
    expect(listed?.title).toBe("My title");
    expect(listed?.autoTitle).toBe("The First line");
  });

  test("an empty Mind has no name of its own", async () => {
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind();
    const client = await connectToMind(core, mind.id);
    appendParagraph(client, "   ");
    await client.settled();

    expect((await core.listMinds())[0]?.autoTitle).toBe("");
  });

  test("is listed in Recently deleted by that name once deleted", async () => {
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind();
    const client = await connectToMind(core, mind.id);
    appendParagraph(client, "Tides and the moon");
    await client.settled();

    await core.deleteMind(mind.id);

    const deleted = (await core.listDeleted()).find((item) => item.id === mind.id);
    expect(deleted?.name).toBe("Tides and the moon");
  });
});

describe("a Mind whose first Note was added from an Answer (#1174)", () => {
  const addAnswer = (
    core: Core,
    mindId: string,
    question: string,
    answer: string,
    type: "paragraph" | "heading" = "paragraph",
  ) =>
    core.addToNote({
      mindId,
      blocks: [
        {
          type,
          ...(type === "heading" && { attrs: { level: 2 } }),
          content: [{ type: "text", text: answer }],
        },
      ],
      origin: { from: messageReference("conversation-1", "answer-1"), question },
      model: null,
    });
  const nameOf = async (core: Core) => (await core.listMinds())[0]?.autoTitle;

  test("is named by the Note's first line, cut at a clause, not by the Question", async () => {
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind();
    await addAnswer(
      core,
      mind.id,
      "How many days of holiday does the employee get, and how much notice after probation?",
      "The employee gets 27 days of paid holiday per year, plus bank holidays, and the notice after probation is one month.",
    );

    expect(await nameOf(core)).toBe("The employee gets 27 days of paid holiday per year");
  });

  test("is named by a Chinese first line, cut cleanly", async () => {
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind();
    await addAnswer(
      core,
      mind.id,
      "员工每年享有多少天带薪年假？",
      "员工每年享有二十七天带薪年假，另外还享有法定节假日，试用期结束后双方需要提前一个月书面通知对方，并且需要在合同中写明相关的补偿安排。",
    );

    expect(await nameOf(core)).toBe(
      "员工每年享有二十七天带薪年假，另外还享有法定节假日，试用期结束后双方需要提前一个月书面通知对方",
    );
  });

  test("is named by the heading, never by the instruction the assistant was given for it", async () => {
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind();
    await addAnswer(core, mind.id, "Make the summary longer.", "Summary", "heading");
    expect(await nameOf(core)).toBe("Summary");

    await addAnswer(core, mind.id, "Write a short summary of this agreement.", "A second note.");
    expect(await nameOf(core)).toBe("Summary");

    const chinese = await core.createMind();
    await core.addToNote({
      mindId: chinese.id,
      blocks: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "摘要" }] }],
      origin: { from: messageReference("conversation-1", "answer-2"), question: "把摘要写长一点" },
      model: null,
    });
    const names = (await core.listMinds()).map((each) => each.autoTitle);
    expect(names).toContain("摘要");
    expect(names).not.toContain("把摘要写长一点");
  });

  test("keeps the name of a line the User wrote above it", async () => {
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind();
    const client = await connectToMind(core, mind.id);
    appendParagraph(client, "Holiday rules");
    await client.settled();
    await addAnswer(core, mind.id, "How many days of holiday?", "Twenty-seven days.");

    expect(await nameOf(core)).toBe("Holiday rules");
  });

  test("never replaces a title the User typed", async () => {
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind({ title: "My title" });
    await addAnswer(core, mind.id, "How many days of holiday?", "Twenty-seven days.");

    const [listed] = await core.listMinds();
    expect(listed?.title).toBe("My title");
  });

  test("goes again when the Note is taken out", async () => {
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind();
    const added = await addAnswer(core, mind.id, "How many days of holiday?", "Twenty-seven days.");
    expect(await nameOf(core)).toBe("Twenty-seven days");

    await core.undoAddToNote({ mindId: mind.id, blockIds: added.blockIds });

    expect(await nameOf(core)).toBe("");
  });
});
