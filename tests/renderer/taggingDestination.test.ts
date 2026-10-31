import { expect, test } from "vitest";
import type { RegisteredDataFlow, TaggingRoute } from "../../src/core/api";
import {
  pageImagesSent,
  serviceOf,
  unknownService,
} from "../../src/renderer/src/taggingDestination";

const service = { id: "https://api.anthropic.com", name: "Anthropic" };
const cloud: TaggingRoute = { where: "cloud", service };

/** The tagging flow as the flows list it: a service with the User's decision, or none on this computer. */
const taggingFlow = (
  consent: "accepted" | "declined" | "not-asked" | null,
): RegisteredDataFlow => ({
  id: "tagging",
  sends: ["tags", "document-excerpts"],
  services:
    consent === null
      ? []
      : [
          {
            flow: { id: "tagging", service, sends: ["tags", "document-excerpts"] },
            consent,
            decidedAt: null,
            chosen: consent === "accepted",
          },
        ],
});

test("nothing is known while the model or the flows are still being read", () => {
  expect(serviceOf("tagging", null, null)).toEqual(unknownService);
  // The model's route is in, the flows aren't: the row names the service but says nothing more.
  expect(serviceOf("tagging", cloud, null)).toEqual({ route: cloud, known: false, allowed: null });
});

test("a flow list that fails leaves the last answer not known", () => {
  expect(serviceOf("tagging", cloud, null)).toMatchObject({ known: false });
  expect(serviceOf("tagging", { where: "local" }, null)).toMatchObject({ known: false });
});

test("a service is named, with whether the User allowed it", () => {
  expect(serviceOf("tagging", cloud, [taggingFlow("accepted")])).toEqual({
    route: cloud,
    known: true,
    allowed: true,
  });
  expect(serviceOf("tagging", cloud, [taggingFlow("declined")])).toEqual({
    route: cloud,
    known: true,
    allowed: false,
  });
  expect(serviceOf("tagging", cloud, [taggingFlow("not-asked")])).toEqual({
    route: cloud,
    known: true,
    allowed: false,
  });
});

test("a model on this computer is said only when the model is local", () => {
  expect(serviceOf("tagging", { where: "local" }, [taggingFlow(null)])).toEqual({
    route: { where: "local" },
    known: true,
    allowed: null,
  });
  // The flows send nothing, but the model isn't known: no claim that it stays here.
  expect(serviceOf("tagging", null, [taggingFlow(null)])).toEqual(unknownService);
});

test("a flow the flows leave out, or one that names another service, isn't known", () => {
  expect(serviceOf("tagging", cloud, [])).toMatchObject({ known: false });
  const elsewhere: RegisteredDataFlow = {
    id: "tagging",
    sends: ["tags"],
    services: [
      {
        flow: {
          id: "tagging",
          service: { id: "https://api.openai.com", name: "OpenAI" },
          sends: [],
        },
        consent: "accepted",
        decidedAt: null,
        chosen: true,
      },
    ],
  };
  expect(serviceOf("tagging", cloud, [elsewhere])).toMatchObject({ known: false });
});

test("Organize and page images use the current model, with permission from their flows", () => {
  const organize: RegisteredDataFlow = {
    id: "classification",
    sends: ["groups", "tags", "document-excerpts"],
    services: [
      {
        flow: { id: "classification", service, sends: ["groups", "tags"] },
        consent: "accepted",
        decidedAt: null,
        chosen: true,
      },
    ],
  };
  expect(serviceOf("classification", cloud, [organize])).toEqual({
    route: cloud,
    known: true,
    allowed: true,
  });
  const pageImages: RegisteredDataFlow = {
    id: "scan-images",
    sends: ["page-images"],
    services: [],
  };
  expect(serviceOf("scan-images", { where: "local" }, [pageImages])).toEqual({
    route: { where: "local" },
    known: true,
    allowed: null,
  });
});

test("page images count only when the reader sends them where the User allowed, or on this computer", () => {
  const classification: RegisteredDataFlow = {
    id: "classification",
    sends: [],
    services: [
      {
        flow: { id: "classification", service, sends: [] },
        consent: "accepted",
        chosen: true,
        decidedAt: null,
      },
    ],
  };
  const cloudAllowed = serviceOf("scan-images", cloud, [
    classification,
    {
      id: "scan-images",
      sends: ["page-images"],
      services: [
        {
          flow: { id: "scan-images", service, sends: ["page-images"] },
          consent: "accepted",
          decidedAt: null,
          chosen: true,
        },
      ],
    },
  ]);
  const cloudDeclined = serviceOf("scan-images", cloud, [
    classification,
    {
      id: "scan-images",
      sends: ["page-images"],
      services: [
        {
          flow: { id: "scan-images", service, sends: ["page-images"] },
          consent: "declined",
          decidedAt: null,
          chosen: false,
        },
      ],
    },
  ]);
  const local = serviceOf("scan-images", { where: "local" }, [
    { id: "scan-images", sends: ["page-images"], services: [] },
  ]);
  expect(pageImagesSent(true, cloudAllowed)).toBe(true);
  expect(pageImagesSent(true, cloudDeclined)).toBe(false);
  expect(pageImagesSent(true, local)).toBe(true);
  expect(pageImagesSent(true, unknownService)).toBe(false);
  expect(pageImagesSent(false, cloudAllowed)).toBe(false);
});

test.each(["tagging", "classification", "scan-images"] as const)(
  "past consent cannot replace the current %s destination",
  (flow) => {
    const old = { id: "https://api.openai.com", name: "OpenAI" };
    const registered: RegisteredDataFlow = {
      id: flow,
      sends: [],
      services: [old, service].map((recipient) => ({
        flow: { id: flow, service: recipient, sends: [] },
        consent: recipient.id === old.id ? "accepted" : "declined",
        chosen: false,
        decidedAt: null,
      })),
    };
    expect(serviceOf(flow, cloud, [registered])).toEqual({
      route: cloud,
      known: true,
      allowed: false,
      ...(flow === "scan-images" && { classificationAllowed: null }),
    });
    expect(serviceOf(flow, { where: "local" }, [registered])).toEqual({
      route: { where: "local" },
      known: true,
      allowed: null,
    });
    expect(serviceOf(flow, null, [registered])).toEqual(unknownService);
  },
);
