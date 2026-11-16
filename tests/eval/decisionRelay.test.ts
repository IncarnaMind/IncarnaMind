import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, onTestFinished, test } from "vitest";
import { startRelay } from "../../eval/speed/decisionRelay";

async function startHost(reply: (body: string) => { status: number; body: unknown }) {
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const { status, body } = reply(text);
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  onTestFinished(
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const ask = (url: string, state: object) =>
  fetch(`${url}/v1/decide`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ state, questions: {} }),
  });

// protects=a measurement's relay counts every request the decision host was asked, sums the input tokens of the answered ones, keeps each sentence's first scores apart from its later answers, and lists a refused request by its status, which is what makes a paid run void; fails_when=a refused request is counted as answered or not listed, an answered one is listed as refused, or a later request's answers are read as the sentence's first scores; no_claim=what the real host answers, or that a request the app gave up on is listed (that needs a host that never answers).
test("the relay counts what the host answered and lists what it refused", async () => {
  let refuse = false;
  const host = await startHost((body) => {
    if (refuse) return { status: 429, body: { error: { message: "Too many." } } };
    const { state } = JSON.parse(body) as { state: { passages?: object } };
    return {
      status: 200,
      body: {
        usage: { input_tokens: 100 },
        answers: state.passages
          ? { B_p1: { noul: 0.9 }, C_p1: { noul: 0.1 }, B_p2: { noul: 0.2 }, C_p2: { noul: 0.3 } }
          : { B: { noul: 0.95 }, C: { noul: 0.02 } },
      },
    };
  });
  const relay = await startRelay(host);
  onTestFinished(() => relay.close());
  const passages = { p1: { document: "A", text: "one" }, p2: { document: "B", text: "two" } };

  expect((await ask(relay.url, { sentence: "S", passages })).status).toBe(200);
  expect((await ask(relay.url, { sentence: "S", passage: passages.p1 })).status).toBe(200);
  refuse = true;
  expect((await ask(relay.url, { sentence: "T", passages })).status).toBe(429);

  expect(relay.asked()).toBe(3);
  expect(relay.inputTokens()).toBe(200);
  expect(relay.refused()).toEqual([429]);
  expect(relay.scores()).toEqual([
    { sentence: "S", states: 0.9, opposes: 0.1 },
    { sentence: "S", states: 0.2, opposes: 0.3 },
  ]);
  expect(relay.later()).toEqual([{ sentence: "S", several: 0, answers: { B: 0.95, C: 0.02 } }]);
  expect(relay.passagesRead("S")).toEqual(Object.values(passages));
});
