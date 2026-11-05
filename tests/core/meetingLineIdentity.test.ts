import { expect, test, vi } from "vitest";
import * as Y from "yjs";
import type { MeetingFill } from "../../src/core";
import { mindCitations, shownPassages } from "../helpers/citations";
import { createTempDataFolder } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { exactly, heading, note, readMind, writeMind } from "../helpers/minds";
import { scriptedModel } from "../helpers/models";
import { transcribingCore } from "../helpers/transcription";

for (const language of ["en", "zh-CN"] as const) {
  test.each([
    { deleted: 0, withoutIds: false },
    { deleted: 1, withoutIds: false },
    { deleted: 0, withoutIds: true },
    { deleted: 1, withoutIds: true },
  ])(
    `deleting identical line $deleted preserves the other occurrence's fact and exact Undo (missing IDs: $withoutIds, ${language})`,
    async ({ deleted, withoutIds }) => {
      const words =
        language === "en"
          ? {
              heading: "Review",
              line: "Follow-up",
              purpose: "We are sharing the review work",
              facts: [
                { topic: "draft", text: "Dana sends the draft on Monday" },
                { topic: "checklist", text: "Alex brings the checklist on Tuesday" },
              ],
              actions: "Action items",
              decisions: "Decisions",
              above: " — see above",
              below: " — see below",
            }
          : {
              heading: "评审",
              line: "后续跟进",
              purpose: "今天分一下评审的工作",
              facts: [
                { topic: "草稿", text: "王芳周一发草稿" },
                { topic: "检查清单", text: "李明周二带来检查清单" },
              ],
              actions: "待办事项",
              decisions: "决定",
              above: "，详见上文",
              below: "，详见下文",
            };
      const text = [
        "HEADINGS: H1=NONE",
        ...words.facts.map((fact, index) =>
          [
            `### FACT F${index + 1}`,
            "```json",
            JSON.stringify({
              topic: fact.topic,
              citations: [index + 1],
              lines: [`L${index + 1}`],
              sections: ["actions", "decisions"],
              claim: false,
            }),
            "```",
            `${fact.text} [^${index + 1}].`,
            `### END F${index + 1}`,
          ].join("\n"),
        ),
        "### OVERVIEW",
        "```json",
        JSON.stringify({ citations: [3] }),
        "```",
        `${words.purpose} [^3].`,
        "### END OVERVIEW",
      ].join("\n\n");
      const pending = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const model = scriptedModel((call) => {
        const shown = shownPassages(call.prompt);
        if (shown.length === 0) return { text: "OK" };
        if (call.results.some((result) => result.tool === "cite")) {
          pending.resolve();
          return { text, pause: { after: 1, until: resume.promise } };
        }
        const citations = [...words.facts.map((fact) => fact.text), words.purpose].map(
          (quote, index) => {
            const passage = shown.find((each) => each.text.includes(quote));
            const cue = passage?.text.split("\n").find((line) => line.includes(quote));
            const location = /^\[([^\]]+)\]/.exec(cue ?? "")?.[1];
            if (!passage || !location) throw new Error("The selected Transcript cue is missing.");
            return { marker: index + 1, passage: passage.id, quote, location };
          },
        );
        return { calls: [{ tool: "cite", input: { citations } }] };
      });
      const { core, record } = await transcribingCore(await createTempDataFolder(), {
        model,
        engine: { lines: [words.purpose, ...words.facts.map((fact) => fact.text)] },
      });
      try {
        await core.saveLibrarySettings({ ...(await core.getLibrary()).settings, automatic: false });
        await core.updateSettings({ user: { language } });
        await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
        const meeting = await core.createMeeting();
        const client = await connectToMind(core, meeting.mindId);
        writeMind(client, [
          heading(1, words.heading),
          { ...note(words.line), attrs: { id: "first" } },
          { ...note(words.line), attrs: { id: "second" } },
        ]);
        if (withoutIds) {
          client.doc.transact(() => {
            for (const block of client.blocks.toArray()) {
              if (block instanceof Y.XmlElement) block.removeAttribute("id");
            }
          });
        }
        await client.settled();
        const original = exactly(client);
        const survivor = client.blocks.get(deleted === 0 ? 2 : 1);
        expect(survivor).toBeInstanceOf(Y.XmlElement);
        await core.startMeeting({ meetingId: meeting.id, systemAudio: false });
        record(8_000, ["microphone"]);
        await vi.waitFor(async () => {
          const current = (await core.listMeetings()).find((each) => each.id === meeting.id);
          expect(current?.transcript?.lines ?? 0).toBeGreaterThanOrEqual(3);
        });
        await core.stopMeeting(meeting.id);
        await pending.promise;
        expect(exactly(client)).toEqual(original);
        client.doc.transact(() => client.blocks.delete(deleted + 1, 1));
        await client.settled();
        expect(client.blocks.get(1)).toBe(survivor);
        const concurrent = exactly(client);
        const concurrentJSON = readMind(client).toJSON();
        resume.resolve();
        const fill = await vi.waitFor(async (): Promise<MeetingFill> => {
          const current = (await core.listMeetings()).find((each) => each.id === meeting.id)?.fill;
          if (!current || current.state === "waiting" || current.state === "filling") {
            throw new Error("The meeting notes are not settled.");
          }
          return current;
        });
        expect(fill).toMatchObject({ state: "filled", omitted: 0, problem: null });
        const kept = words.facts[1 - deleted];
        const removed = words.facts[deleted];
        if (!kept || !removed) throw new Error("The two original facts are missing.");
        const paragraphs: string[] = [];
        readMind(client).forEach((node) => {
          paragraphs.push(node.textContent);
        });
        const line = paragraphs.indexOf(words.line);
        expect(paragraphs[line + 1]).toContain(kept.text);
        expect(paragraphs[line + 1]).not.toContain(removed.text);
        const actions = paragraphs.slice(paragraphs.indexOf(words.actions) + 1).join("\n");
        expect(actions).toContain(removed.text);
        expect(actions).not.toContain(kept.text);
        expect(actions).toContain(`${kept.topic}${words.above}`);
        const decisions = paragraphs
          .slice(paragraphs.indexOf(words.decisions) + 1, paragraphs.indexOf(words.actions))
          .join("\n");
        expect(decisions).toContain(`${kept.topic}${words.above}`);
        expect(decisions).toContain(`${removed.topic}${words.below}`);
        for (const fact of words.facts) {
          expect(readMind(client).textContent.split(fact.text)).toHaveLength(2);
          const citations = mindCitations(client).filter(
            (citation) => citation.quote === fact.text,
          );
          expect(citations).toHaveLength(fact === kept ? 3 : 2);
          for (const citation of citations) {
            expect(citation.check).toBe("found");
            expect(citation.location).not.toBeNull();
            expect(citation).toEqual({ ...citations[0], id: citation.id });
          }
        }
        expect(client.blocks.get(1)).toBe(survivor);
        await core.undoMeetingFill(meeting.id);
        await vi.waitFor(() => expect(exactly(client)).toEqual(concurrent));
        expect(readMind(client).toJSON()).toEqual(concurrentJSON);
        expect(client.blocks.get(1)).toBe(survivor);
      } finally {
        resume.resolve();
        core.close();
      }
    },
  );
}
