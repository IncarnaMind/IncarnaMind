import { expect, test } from "vitest";
import { sharedRequests } from "../../src/renderer/src/sharedRequests";

// Every Answer shown over one scope asks for its unread files at the same moment (#2772).

function held() {
  let resolve: (value: string) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<string>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test("callers asking the same thing while it is in flight share one request", async () => {
  const ask = sharedRequests<string>();
  const sent: string[] = [];
  const reply = held();
  const asking = () => {
    sent.push("all");
    return reply.promise;
  };
  const answers = [ask("all|1", asking), ask("all|1", asking), ask("all|1", asking)];
  expect(sent).toEqual(["all"]);
  reply.resolve("Contract.doc");
  expect(await Promise.all(answers)).toEqual(["Contract.doc", "Contract.doc", "Contract.doc"]);
});

test("another key, or the same one once it has settled, sends again", async () => {
  const ask = sharedRequests<string>();
  let sent = 0;
  const asking = () => {
    sent += 1;
    return Promise.resolve(`reply ${sent}`);
  };
  await ask("all|1", asking);
  expect(await ask("folder|1", asking)).toBe("reply 2");
  expect(await ask("all|1", asking)).toBe("reply 3");
  expect(sent).toBe(3);
});

test("a request that fails fails for every caller sharing it, and the next ask sends again", async () => {
  const ask = sharedRequests<string>();
  const reply = held();
  let sent = 0;
  const asking = () => {
    sent += 1;
    return sent === 1 ? reply.promise : Promise.resolve("read");
  };
  const first = ask("all|1", asking);
  const second = ask("all|1", asking);
  reply.reject(new Error("The core is closing."));
  await expect(first).rejects.toThrow("The core is closing.");
  await expect(second).rejects.toThrow("The core is closing.");
  expect(await ask("all|1", asking)).toBe("read");
  expect(sent).toBe(2);
});
