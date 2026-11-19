/**
 * What a Canvas may send out (#3406): exactly two messages, each checked by its shape alone, and
 * everything else dropped with its reason; the address of a showing; the links offered to the User.
 */
import { describe, expect, it } from "vitest";
import {
  canvasFrameUrl,
  canvasHostOf,
  MAX_CANVAS_HEIGHT,
  offeredLink,
  readCanvasMessage,
} from "../../src/shared/canvases";

const HOST = "0123456789abcdef0123456789abcdef";

describe("A message from a Canvas", () => {
  it("is its height or a Citation to open, and nothing more", () => {
    expect(readCanvasMessage({ kind: "height", height: 1200.4 })).toEqual({
      message: { kind: "height", height: 1201 },
    });
    expect(readCanvasMessage({ kind: "cite", cite: "[cite:k3x9a2b7]" })).toEqual({
      message: { kind: "cite", cite: "[cite:k3x9a2b7]" },
    });
  });

  it("of any other shape is dropped, with why", () => {
    const shapes: [unknown, string][] = [
      [null, "not-an-object"],
      ["height", "not-an-object"],
      [42, "not-an-object"],
      [[{ kind: "height", height: 10 }], "not-an-object"],
      [new Date(), "not-an-object"],
      [Object.create({ kind: "height", height: 10 }), "not-an-object"],
      [{}, "unknown-kind"],
      [{ kind: "open", url: "https://example.com" }, "unknown-kind"],
      [{ kind: "navigate", to: "file:///etc/passwd" }, "unknown-kind"],
      [{ kind: "HEIGHT", height: 10 }, "unknown-kind"],
      [{ kind: "height" }, "extra-fields"],
      [{ kind: "height", height: 10, html: "<img src=x onerror=alert(1)>" }, "extra-fields"],
      [{ kind: "height", size: 10 }, "extra-fields"],
      [{ kind: "height", height: "10" }, "bad-height"],
      [{ kind: "height", height: -1 }, "bad-height"],
      [{ kind: "height", height: Number.NaN }, "bad-height"],
      [{ kind: "height", height: Number.POSITIVE_INFINITY }, "bad-height"],
      [{ kind: "height", height: MAX_CANVAS_HEIGHT + 1 }, "bad-height"],
      [{ kind: "cite", cite: "k3x9a2b7" }, "bad-cite"],
      [{ kind: "cite", cite: "[cite:k3x9a2b7] and more" }, "bad-cite"],
      [{ kind: "cite", cite: '<a href="https://example.com">[cite:k3x9a2b7]</a>' }, "bad-cite"],
      [{ kind: "cite", cite: { toString: () => "[cite:k3x9a2b7]" } }, "bad-cite"],
      [{ kind: "cite", cite: "[cite:k3x9a2b7]", documentId: "x" }, "extra-fields"],
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
