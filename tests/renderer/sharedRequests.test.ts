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

test("another key in flight at the same time gets a request and a reply of its own", async () => {
  const ask = sharedRequests<string>();
  const all = held();
  const folder = held();
  const sent: string[] = [];
  const first = ask("all|1", () => {
    sent.push("all");
    return all.promise;
  });
  const second = ask("folder|1", () => {
    sent.push("folder");
    return folder.promise;
  });
  expect(sent).toEqual(["all", "folder"]);
  folder.resolve("Contract.doc");
  all.resolve("Contract.doc, Locked.pdf");
  expect(await first).toBe("Contract.doc, Locked.pdf");
  expect(await second).toBe("Contract.doc");
});

test("the same key, once it has settled, sends again", async () => {
  const ask = sharedRequests<string>();
  let sent = 0;
  const asking = () => {
    sent += 1;
    return Promise.resolve(`reply ${sent}`);
  };
  expect(await ask("all|1", asking)).toBe("reply 1");
  expect(await ask("all|1", asking)).toBe("reply 2");
  expect(sent).toBe(2);
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
