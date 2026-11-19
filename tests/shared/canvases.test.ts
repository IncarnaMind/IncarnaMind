/**
 * What a Canvas may send out (#3406): one message, checked by its shape alone, and everything else
 * dropped with its reason; the address of a showing; the links offered to the User.
 */
import { describe, expect, it } from "vitest";
import {
  canvasFrameUrl,
  canvasHostOf,
  offeredLink,
  readCanvasMessage,
} from "../../src/shared/canvases";

const HOST = "0123456789abcdef0123456789abcdef";

describe("A message from a Canvas", () => {
  it("is the token of a Citation the User pressed, and nothing more", () => {
    expect(readCanvasMessage({ kind: "cite", token: "k3x9a2b7" })).toEqual({
      message: { kind: "cite", token: "k3x9a2b7" },
    });
  });

  it("of any other shape is dropped, with why", () => {
    const shapes: [unknown, string][] = [
      [null, "not-an-object"],
      ["k3x9a2b7", "not-an-object"],
      [42, "not-an-object"],
      [[{ kind: "cite", token: "k3x9a2b7" }], "not-an-object"],
      [new Date(), "not-an-object"],
      [Object.create({ kind: "cite", token: "k3x9a2b7" }), "not-an-object"],
      [{}, "unknown-kind"],
      [{ kind: "height", height: 10 }, "unknown-kind"],
      [{ kind: "open", url: "https://example.com" }, "unknown-kind"],
      [{ kind: "navigate", to: "file:///etc/passwd" }, "unknown-kind"],
      [{ kind: "CITE", token: "k3x9a2b7" }, "unknown-kind"],
      [{ kind: "cite" }, "extra-fields"],
      [{ kind: "cite", token: "k3x9a2b7", html: "<img src=x onerror=alert(1)>" }, "extra-fields"],
      [{ kind: "cite", cite: "[cite:k3x9a2b7]" }, "extra-fields"],
      [{ kind: "cite", token: "[cite:k3x9a2b7]" }, "bad-token"],
      [{ kind: "cite", token: "K3X9A2B7" }, "bad-token"],
      [{ kind: "cite", token: "k3x9a2b7 more" }, "bad-token"],
      [{ kind: "cite", token: "x".repeat(33) }, "bad-token"],
      [{ kind: "cite", token: "" }, "bad-token"],
      [{ kind: "cite", token: 42 }, "bad-token"],
      [{ kind: "cite", token: { toString: () => "k3x9a2b7" } }, "bad-token"],
    ];
    for (const [shape, reason] of shapes) {
      expect(readCanvasMessage(shape), JSON.stringify(shape)).toEqual({ dropped: reason });
    }
  });
});

describe("A showing's address", () => {
  it("is known by its random host, and no other address is a Canvas's", () => {
    expect(canvasHostOf(canvasFrameUrl(HOST))).toBe(HOST);
    expect(canvasHostOf(`${canvasFrameUrl(HOST)}chart.png`)).toBe(HOST);
    for (const url of [
      `incarnamind-canvas://${HOST}:8080/`,
      `incarnamind-canvas://user@${HOST}/`,
      "incarnamind-canvas://not-a-host/",
      `https://${HOST}/`,
      `incarnamind-document://${HOST}/`,
      "about:blank",
      "not a url",
    ]) {
      expect(canvasHostOf(url), url).toBeNull();
    }
  });
});

describe("A link a Canvas tries to open", () => {
  it("is offered to the User only for a website or a mail address", () => {
    expect(offeredLink("https://example.com/a?b=c")).toBe("https://example.com/a?b=c");
    expect(offeredLink("mailto:someone@example.com")).toBe("mailto:someone@example.com");
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      `incarnamind-canvas://${HOST}/`,
      "data:text/html,<p>x</p>",
      "smb://server/share",
      "ftp://example.com/",
    ]) {
      expect(offeredLink(url), url).toBeNull();
    }
  });
});
