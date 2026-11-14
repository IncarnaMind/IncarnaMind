import { expect, test } from "vitest";
import type {
  ConversationAskResult,
  Core,
  MeetingHelpKind,
  MeetingHelpTemplate,
} from "../../src/core";
import { translate } from "../../src/shared/i18n";
import { isCheckRun } from "../helpers/checks";
import { answerEnded, shownPassages } from "../helpers/citations";
import { createTempDataFolder } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { appendParagraph, connectToMind } from "../helpers/mindClient";
import { type ModelCall, scriptedModel, scriptedModels } from "../helpers/models";
import { transcribingCore, until } from "../helpers/transcription";

const actions: {
  kind: MeetingHelpKind;
  documents: boolean;
  template: MeetingHelpTemplate | null;
}[] = [
  { kind: "say", documents: true, template: null },
  { kind: "answer", documents: true, template: null },
  { kind: "want", documents: false, template: null },
  { kind: "sum", documents: false, template: null },
  { kind: "no", documents: true, template: null },
  { kind: "ask", documents: true, template: null },
  { kind: "check", documents: true, template: null },
  { kind: "objection", documents: true, template: "sales" },
  { kind: "nextStep", documents: true, template: "sales" },
  { kind: "facts", documents: true, template: "sales" },
  { kind: "followUp", documents: false, template: "interview" },
  { kind: "leading", documents: false, template: "interview" },
  { kind: "notCovered", documents: true, template: "interview" },
  { kind: "decisions", documents: false, template: "team" },
  { kind: "disagree", documents: false, template: "team" },
];

async function answerOf(core: Core, result: ConversationAskResult) {
  if (!result.asked) throw new Error(`Not asked: ${JSON.stringify(result)}`);
  expect((await answerEnded(core, result.answerId)).event).toBe("finished");
  const { messages } = await core.getConversation(result.conversation.id);
  const answer = messages.find((message) => message.id === result.answerId);
  if (answer?.kind !== "answer") throw new Error("Missing Answer.");
  return answer;
}

async function setup(language: "en" | "zh-CN", heard = true) {
  const calls: ModelCall[] = [];
  const fact =
    language === "en"
      ? "The guide asks whether supplier payments are due in forty-five days."
      : "提纲要求询问供应商的付款期是否为四十五天。";
  const spoken = language === "en" ? "We will talk about the store today." : "今天我们来谈谈门店。";
  const note =
    language === "en"
      ? "Unasked note: the board meets in November."
      : "未问及的笔记：董事会将在十一月开会。";
  const name = language === "en" ? "Interview guide" : "访谈提纲";
  const models = scriptedModels(
    scriptedModel(
      (call) => {
        calls.push(call);
        const passages = shownPassages(call.prompt);
        const library = passages.find((passage) => passage.document === name);
        const source = library ?? passages.find((passage) => passage.text.includes(spoken));
        if (!source)
          return { text: language === "en" ? "Not enough call content yet." : "通话内容还不够。" };
        const quote = library ? fact : spoken;
        if (!call.results.some((result) => result.tool === "cite")) {
          return {
            calls: [
              { tool: "cite", input: { citations: [{ marker: 1, passage: source.id, quote }] } },
            ],
          };
        }
        // A reading's own first line cites nothing (#2847): what was said is its moment, below it.
        if (call.prompt.includes("Each reading is three lines")) {
          const reading = language === "en" ? "★ They want it settled" : "★ 对方想把事情定下来";
          return { text: `${reading}\n${quote} [^1]\n→ ${language === "en" ? "ask" : "问清楚"}` };
        }
        return { text: `- ${quote} [^1]` };
      },
      { judgesItsAnswers: true },
    ),
  );
  const { core, record } = await transcribingCore(await createTempDataFolder(), {
    createChatModel: models.createChatModel,
    engine: {
      maxSpeechMs: 1500,
      lines:
        language === "en"
          ? [
              spoken,
              "Did customers move their visits earlier?",
              "Leave supplier terms for another day.",
            ]
          : [spoken, "顾客改在上午来了吗？", "供应商条款改天再谈。"],
      theirLines:
        language === "en"
          ? [
              "Afternoon visits dropped last month.",
              "Most of the lost visits were after four.",
              "I will send the breakdown on Friday.",
            ]
          : ["上个月下午的到访减少了。", "下午四点以后的减少最明显。", "我会在周五发送明细。"],
    },
  });
  await core.updateSettings({ user: { language } });
  const provider = await core.saveChatProvider({
    kind: "anthropic",
    modelId: "claude-haiku-5-5",
    apiKey: "sk-test",
  });
  if (provider.service) await core.allowDataFlow("chat", provider.service.id);
  const folder = await createSourceFolder();
  const [guide] = await addAndProcess(core, [await writeSourceFile(folder, `${name}.txt`, fact)]);
  if (!guide) throw new Error("Missing guide.");
  const meeting = await core.createMeeting();
  await core.startMeeting({ meetingId: meeting.id, systemAudio: true });
  if (heard) {
    await until(core, meeting.id, (transcript) => transcript.state === "live");
    record(4500);
    await core.pauseMeeting(meeting.id);
    await until(core, meeting.id, (transcript) => transcript.lines >= 6);
  }
  return { core, meeting, guide, calls, fact, spoken, note };
}

for (const language of ["en", "zh-CN"] as const) {
  test(`${language}: an explicit request for all Documents during an empty call keeps their text without Tools`, async () => {
    const fact =
      language === "en"
        ? "Zircon vessels stabilize in forty-five days"
        : "锆石容器在四十五天内稳定";
    const model = scriptedModel(
      (call) => {
        if (call.tools.length > 0) {
          return { error: { status: 400, message: "This model does not support tools" } };
        }
        const answer = call.prompt.includes(fact) ? fact : "No readable source.";
        return { text: call.json ? JSON.stringify({ answer, citations: [] }) : answer };
      },
      { judgesItsAnswers: true },
    );
    const { core } = await transcribingCore(await createTempDataFolder(), { model });
    await core.updateSettings({ user: { language } });
    const provider = await core.saveChatProvider({
      kind: "anthropic",
      modelId: "claude-haiku-5-5",
      apiKey: "sk-test",
    });
    if (provider.service) await core.allowDataFlow("chat", provider.service.id);
    const folder = await createSourceFolder();
    await addAndProcess(core, [await writeSourceFile(folder, "Zircon.txt", fact)]);
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id, systemAudio: true });
    const answer = await answerOf(
      core,
      await core.askInConversation({
        mindId: meeting.mindId,
        text: language === "en" ? "Summarize all Documents." : "请总结所有文档。",
      }),
    );
    expect(answer.text).toContain(fact);
  });

  test(`${language}: Not covered yet has the whole guide even outside retrieved excerpts`, async () => {
    const { core, meeting, guide, calls, fact } = await setup(language);
    await core.setMeetingTemplate({ meetingId: meeting.id, template: "interview" });
    const answer = await answerOf(
      core,
      await core.askMeetingHelp({ meetingId: meeting.id, kind: "notCovered" }),
    );
    const first = calls.find((call) => call.prompt.includes("<help>"));
    const supplied = first?.prompt.replace(
      /<found-in-documents>[\s\S]*?<\/found-in-documents>/g,
      "",
    );
    expect(supplied).toContain(fact);
    expect(answer.citations.some((citation) => citation.documentId === guide.id)).toBe(true);
  });

  test(`${language}: a recap after guide help keeps the call's scope beside the Question, and the guide stays for follow-ups`, async () => {
    const { core, meeting, guide, calls, fact } = await setup(language);
    await core.setMeetingTemplate({ meetingId: meeting.id, template: "interview" });
    const recap = translate(language, "meeting.ask.recap");
    const first = await answerOf(
      core,
      await core.askInConversation({ mindId: meeting.mindId, text: recap }),
    );
    const firstCall = calls.find(
      (call) => call.prompt.includes(recap) && call.prompt.includes("<live-transcript>"),
    );
    expect(firstCall).toBeDefined();
    expect(firstCall?.prompt).not.toContain("<call>");
    expect(first.citations.length).toBeGreaterThan(0);
    const prior = await core.askMeetingHelp({ meetingId: meeting.id, kind: "notCovered" });
    const priorAnswer = await answerOf(core, prior);
    const helpCall = calls.find(
      (call) =>
        call.prompt.includes("<help>") &&
        call.prompt.includes(translate(language, "meetings.help.notCovered")),
    );
    expect(helpCall).toBeDefined();
    expect(helpCall?.prompt).not.toContain("<call>");
    const typed = language === "en" ? "What have we covered so far?" : "我们聊到哪了？";
    const before = calls.length;
    const second = await answerOf(
      core,
      await core.askInConversation({
        conversationId: priorAnswer.conversationId,
        mindId: meeting.mindId,
        text: typed,
      }),
    );
    const secondCall = calls
      .slice(before)
      .find((call) => call.prompt.includes(typed) && call.prompt.includes("<live-transcript>"));
    expect(secondCall).toBeDefined();
    const scope = secondCall?.prompt ?? "";
    expect(scope).toContain("<call>");
    expect(scope).toContain(
      "The live transcript above is what was said in this call. An earlier reply is not part of the call: it is there for follow-ups about it.",
    );
    expect(scope).toContain(
      "When a recap or summary of the call is asked and <live-transcript> is empty, say there is no call content yet rather than summarizing Library Documents or the earlier reply.",
    );
    expect(scope).toContain(
      "A recap or summary of the call is what was said in it: a short list, each line citing the live-transcript passage it rests on, plus the written notes when the Question asks for them.",
    );
    expect(scope).toContain(
      "A recap has no heading or closing line, and adds no unrequested suggestion, question to ask, or topic still to cover.",
    );
    expect(scope).toContain("</call>");
    expect(scope.indexOf("</live-transcript>")).toBeLessThan(scope.indexOf("<call>"));
    expect(scope.indexOf("<call>")).toBeLessThan(scope.indexOf(typed));
    const guideSaid =
      language === "en"
        ? "supplier payments are due in forty-five days"
        : "提纲要求询问供应商的付款期是否为四十五天";
    expect(secondCall?.prompt).toContain(guideSaid);
    expect(second.text).not.toContain(fact);
    expect(second.citations.length).toBeGreaterThan(0);
    expect(second.citations.every((citation) => citation.documentId !== guide.id)).toBe(true);
    const retryFrom = calls.length;
    const retried = await answerOf(
      core,
      await core.regenerateConversationAnswer({
        conversationId: second.conversationId,
        answerId: second.id,
      }),
    );
    const retryCall = calls
      .slice(retryFrom)
      .find((call) => call.prompt.includes(typed) && call.prompt.includes("<live-transcript>"));
    expect(retryCall).toBeDefined();
    expect(retryCall?.prompt).toContain("<call>");
    expect(retried.citations.every((citation) => citation.documentId !== guide.id)).toBe(true);
    const follow =
      language === "en"
        ? "Which of those guide topics should I ask about first?"
        : "上一条回答里列的问题，先问哪一个好？";
    const from = calls.length;
    await answerOf(
      core,
      await core.askInConversation({
        conversationId: priorAnswer.conversationId,
        mindId: meeting.mindId,
        text: follow,
      }),
    );
    const followCall = calls
      .slice(from)
      .find((call) => call.prompt.includes(follow) && call.prompt.includes("<live-transcript>"));
    expect(followCall).toBeDefined();
    expect(followCall?.prompt).toContain(guideSaid);
    await core.stopMeeting(meeting.id);
    const endedFrom = calls.length;
    await answerOf(
      core,
      await core.askInConversation({
        conversationId: priorAnswer.conversationId,
        mindId: meeting.mindId,
        text: typed,
      }),
    );
    const endedCall = calls
      .slice(endedFrom)
      .find((call) => call.prompt.includes(typed) && !call.prompt.includes("<live-transcript>"));
    expect(endedCall).toBeDefined();
    expect(endedCall?.prompt).not.toContain("<call>");
    expect(endedCall?.prompt).not.toContain("The User is in a meeting that is being recorded");
    expect(endedCall?.prompt).toContain(guideSaid);
  });

  test(`${language}: a recap before speech says there is no call content, with no Library summary`, async () => {
    const { core, meeting, calls, fact } = await setup(language, false);
    await core.setMeetingTemplate({ meetingId: meeting.id, template: "interview" });
    const prior = await core.askMeetingHelp({ meetingId: meeting.id, kind: "notCovered" });
    const priorAnswer = await answerOf(core, prior);
    const recap = translate(language, "meeting.ask.recap");
    const before = calls.length;
    const answer = await answerOf(
      core,
      await core.askInConversation({
        conversationId: priorAnswer.conversationId,
        mindId: meeting.mindId,
        text: recap,
      }),
    );
    const call = calls
      .slice(before)
      .find((each) => each.prompt.includes(recap) && each.prompt.includes("<live-transcript>"));
    expect(call).toBeDefined();
    expect(call?.prompt).toContain("<call>");
    expect(call?.prompt).toContain(
      "When a recap or summary of the call is asked and <live-transcript> is empty, say there is no call content yet rather than summarizing Library Documents or the earlier reply.",
    );
    expect(answer.text).toBe(
      language === "en" ? "Not enough call content yet." : "通话内容还不够。",
    );
    expect(answer.text).not.toContain(fact);
  });

  for (const heard of [false, true]) {
    test(`${language}: an ordinary recap ${heard ? "with speech" : "before speech"} leaves Library facts out on ask and retry`, async () => {
      const { core, meeting, calls, fact, spoken } = await setup(language, heard);
      const first = await answerOf(
        core,
        await core.askInConversation({
          mindId: meeting.mindId,
          text: translate(language, "meeting.ask.recap"),
        }),
      );
      const retried = await answerOf(
        core,
        await core.regenerateConversationAnswer({
          conversationId: first.conversationId,
          answerId: first.id,
        }),
      );
      for (const answer of [first, retried]) {
        expect(answer.text).not.toContain(fact);
        expect(answer.citations).toHaveLength(heard ? 1 : 0);
        if (heard) {
          expect(answer.citations[0]?.quote).toBe(spoken);
          expect(answer.citations[0]?.check).toBe("found");
        }
      }
      // The Answer's sentence is then checked against its quote alone (#2311).
      expect(
        calls
          .filter((call) => !isCheckRun(call))
          .every((call) => call.prompt.includes("<live-transcript>")),
      ).toBe(true);
      expect(calls.some((call) => call.prompt.includes(fact))).toBe(false);
    });
  }

  for (const action of actions) {
    test(`${language}: ${action.kind} ${action.documents ? "may cite Documents for its task" : "cites only the call"}`, async () => {
      const { core, meeting, guide, calls, fact, spoken } = await setup(language);
      await core.setMeetingTemplate({ meetingId: meeting.id, template: action.template });
      const answer = await answerOf(
        core,
        await core.askMeetingHelp({ meetingId: meeting.id, kind: action.kind }),
      );
      expect(answer.citations.length).toBeGreaterThan(0);
      expect(answer.citations.every((citation) => citation.check === "found")).toBe(true);
      expect(
        answer.citations.every(
          (citation) => (citation.documentId === guide.id) === action.documents,
        ),
      ).toBe(true);
      expect(answer.text.replace(/\[\^\d+\]/g, "")).toContain(action.documents ? fact : spoken);
      expect(
        calls
          .filter((call) => call.prompt.includes("<help>"))
          .some((call) => call.prompt.includes(fact)),
      ).toBe(action.documents);
    });
  }

  test(`${language}: an empty call never substitutes Library facts`, async () => {
    const { core, meeting, calls, fact } = await setup(language, false);
    const answer = await answerOf(
      core,
      await core.askMeetingHelp({ meetingId: meeting.id, kind: "sum" }),
    );
    expect(answer.citations).toEqual([]);
    expect(answer.text).not.toContain(fact);
    expect(calls.some((call) => call.prompt.includes(fact))).toBe(false);
  });

  for (const scope of ["folder", "selection"] as const) {
    test(`${language}: ${scope} keeps the guide for Document actions and the call for a summary`, async () => {
      const { core, meeting, guide, calls, fact, spoken } = await setup(language);
      await core.setMeetingTemplate({ meetingId: meeting.id, template: "interview" });
      if (scope === "folder") {
        const folder = await core.createLibraryGroup({ name: "Call sources", description: "" });
        await core.moveToFolder({
          documentIds: [guide.id],
          mindIds: [meeting.mindId],
          folderId: folder.id,
        });
      }
      const ask = (kind: MeetingHelpKind) =>
        scope === "folder"
          ? core.askMeetingHelp({ meetingId: meeting.id, kind })
          : core.askInConversation({
              mindId: meeting.mindId,
              text: translate(language, `meetings.help.${kind}`),
              scope: { folderIds: [], tagIds: [], documentIds: [guide.id] },
            });
      const summary = await answerOf(core, await ask("sum"));
      expect(summary.text.replace(/\[\^\d+\]/g, "")).toContain(spoken);
      expect(summary.citations.length).toBeGreaterThan(0);
      expect(summary.citations.every((citation) => citation.documentId !== guide.id)).toBe(true);
      expect(calls.some((call) => call.prompt.includes(fact))).toBe(false);
      const uncovered = await answerOf(core, await ask("notCovered"));
      expect(uncovered.citations.length).toBeGreaterThan(0);
      expect(uncovered.citations.every((citation) => citation.documentId === guide.id)).toBe(true);
      expect(uncovered.citations.every((citation) => citation.check === "found")).toBe(true);
    });
  }

  test(`${language}: summary, typed button name and Try again leave out prior Library help, open Documents and unasked notes`, async () => {
    const { core, meeting, guide, calls, fact, note } = await setup(language);
    await core.setMeetingTemplate({ meetingId: meeting.id, template: "interview" });
    const prior = await core.askMeetingHelp({ meetingId: meeting.id, kind: "notCovered" });
    expect((await answerOf(core, prior)).citations[0]?.documentId).toBe(guide.id);
    const client = await connectToMind(core, meeting.mindId);
    appendParagraph(client, note);
    await client.settled();
    const first = calls.length;
    const summary = await answerOf(
      core,
      await core.askMeetingHelp({ meetingId: meeting.id, kind: "sum" }),
    );
    const typed = await answerOf(
      core,
      await core.askInConversation({
        mindId: meeting.mindId,
        text: translate(language, "meetings.help.sum"),
        onScreen: [guide.id],
        quotes: [
          {
            documentId: guide.id,
            documentName: guide.name,
            quote: fact,
            pageFrom: 1,
            pageTo: 1,
            location: { kind: "lines", from: 1, to: 1 },
          },
        ],
      }),
    );
    const retried = await answerOf(
      core,
      await core.regenerateConversationAnswer({
        conversationId: summary.conversationId,
        answerId: summary.id,
        onScreen: [guide.id],
      }),
    );
    for (const answer of [summary, typed, retried]) {
      expect(answer.citations.length).toBeGreaterThan(0);
      expect(answer.citations.every((citation) => citation.documentId !== guide.id)).toBe(true);
    }
    for (const call of calls.slice(first).filter((call) => call.prompt.includes("<help>"))) {
      expect(call.prompt).not.toContain(fact);
      expect(call.prompt).not.toContain(note);
      expect(call.prompt).not.toContain(guide.name);
    }
    const ordinary = calls.length;
    await answerOf(
      core,
      await core.askInConversation({
        mindId: meeting.mindId,
        text: language === "en" ? "Read my written notes as well." : "也请阅读我的书面笔记。",
      }),
    );
    expect(calls.slice(ordinary).some((call) => call.prompt.includes(note))).toBe(true);
  });
}
