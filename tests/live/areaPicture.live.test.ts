/**
 * A figure the User picked on a page reaches a real image-reading model (#118): the picture is a
 * plain red square, so only a model that read the image can say what colour it is.
 */
import { deflateSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { createAiSdkChatModel } from "../../src/core";
import { answerEnded } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL = process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ?? "claude-haiku-5-5";

const CRC_TABLE = Array.from({ length: 256 }, (_, at) => {
  let value = at;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = (value >>> 8) ^ (CRC_TABLE[(value ^ byte) & 0xff] as number);
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const name = Buffer.from(type);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}

/** A 64 × 64 red PNG, red in every pixel. */
function redPng(): Buffer {
  const width = 64;
  const height = 64;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    rows.push(Buffer.from([0, ...Array.from({ length: width }, () => [255, 0, 0]).flat()]));
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("an area's picture, live", () => {
  test.skipIf(KEY === undefined)(
    `${MODEL}: reads a red figure picked on a page`,
    { timeout: 600_000 },
    async () => {
      const core = startCore(await createTempDataFolder(), {
        createChatModel: createAiSdkChatModel,
      });
      core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
      await core.saveChatProvider({ kind: "anthropic", apiKey: KEY ?? "", modelId: MODEL });
      const sources = await createTempDataFolder();
      const [paper] = await addAndProcess(core, [
        await writeSourceFile(
          sources,
          "Rates.md",
          "# Rates\n\nThe panel covers eleven chains over eight quarters.\n",
        ),
      ]);
      if (!paper) throw new Error("The Document wasn't added.");
      const mind = await core.createMind({ title: "Area" });
      const cited = await core.citeSelection({
        documentId: paper.id,
        parts: [],
        area: { x: 0.2, y: 0.2, width: 0.4, height: 0.4 },
        unit: 1,
      });
      expect(cited.checkReason).toBe("picture");
      const png = redPng();
      const before = await core.getCostSummary();
      const asked = await core.askInConversation({
        text: "What colour is the picture? Answer with one word.",
        mindId: mind.id,
        quotes: [
          {
            documentId: paper.id,
            documentName: paper.name,
            quote: cited.quote,
            pageFrom: cited.pageFrom,
            pageTo: cited.pageTo,
            location: cited.location,
            pick: "area",
            picture: {
              src: `data:image/png;base64,${png.toString("base64")}`,
              width: 64,
              height: 64,
            },
            check: cited.check,
            checkReason: cited.checkReason,
          },
        ],
      });
      if (!asked.asked) throw new Error("The Question wasn't asked.");
      const ended = await answerEnded(core, asked.answerId);
      expect(ended.event).toBe("finished");
      const { messages } = await core.getConversation(asked.conversation.id);
      const answer = messages.find((message) => message.id === asked.answerId);
      if (answer?.kind !== "answer") throw new Error("No Answer.");
      const after = await core.getCostSummary();
      console.log(`model ${MODEL}: "${answer.text.trim()}"`);
      console.log(
        `spent before ${JSON.stringify(before.spent)} after ${JSON.stringify(after.spent)}`,
      );
      expect(answer.text.toLowerCase()).toContain("red");
    },
  );
});
