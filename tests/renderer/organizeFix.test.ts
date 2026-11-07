import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Document, DocumentGroupAssignment } from "../../src/core/api";

/*
 * The one automatic retry after Add credit (#2535): only an Add credit press arms it, two presses
 * before the return still send one list, the list is read on return rather than kept from the
 * press, a second return asks for nothing, and a return whose destination changed sends nothing.
 */

type Route =
  | { where: "none" }
  | { where: "local" }
  | { where: "cloud"; service: { id: string; name: string } };

type Providers = { id: string; kind: string; service: { id: string; name: string } }[];

const cloud = { where: "cloud" as const, service: { id: "svc", name: "OpenAI" } };

const state = vi.hoisted(() => ({
  documents: [] as Document[],
  assignments: [] as DocumentGroupAssignment[],
  route: (() =>
    Promise.resolve({
      where: "cloud" as const,
      service: { id: "svc", name: "OpenAI" },
    })) as () => Promise<Route>,
  providers: (() => Promise.resolve([])) as () => Promise<Providers>,
  retried: vi.fn(async () => undefined),
  openBilling: vi.fn(),
}));

vi.mock("../../src/renderer/src/core", () => ({
  core: {
    getTaggingRoute: () => state.route(),
    listChatProviders: () => state.providers(),
  },
}));

vi.mock("../../src/renderer/src/keyRefusals", () => ({
  billingUrlOfProvider: () => "https://platform.example/billing",
  useKeyRefusals: {
    getState: () => ({
      checkService: vi.fn(async () => undefined),
      openBilling: state.openBilling,
    }),
  },
}));

vi.mock("../../src/renderer/src/organizeDocuments", () => ({
  organizeDocuments: state.retried,
}));

vi.mock("../../src/renderer/src/store", () => ({
  allExamples: () => null,
  isOwnDocument: () => true,
  useAppStore: {
    getState: () => ({
      documents: state.documents,
      library: { assignments: state.assignments },
      reportError: vi.fn(),
    }),
  },
}));

const windowStub = new EventTarget();
(globalThis as unknown as { window: EventTarget }).window = windowStub;

const doc = (id: string): Document => ({ id, name: id, tagging: "tagged" }) as Document;

const held = (
  documentId: string,
  kind: string,
  over: Partial<DocumentGroupAssignment> = {},
): DocumentGroupAssignment =>
  ({
    documentId,
    groupId: null,
    source: "automatic",
    suggested: false,
    status: "failed",
    error: { kind, message: "" },
    model: null,
    ...over,
  }) as DocumentGroupAssignment;

const returnToApp = () => windowStub.dispatchEvent(new Event("focus"));
/** Waits for the return's route read and the retry it may start. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

let fixOrganizeProblem: typeof import("../../src/renderer/src/organizeFix").fixOrganizeProblem;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  state.route = () => Promise.resolve(cloud);
  state.providers = async () => [
    { id: "provider-1", kind: "openai", service: { id: "svc", name: "OpenAI" } },
  ];
  state.documents = [doc("credit-1")];
  state.assignments = [held("credit-1", "out-of-credit")];
  ({ fixOrganizeProblem } = await import("../../src/renderer/src/organizeFix"));
});

describe("the one retry after Add credit (#2535)", () => {
  test("a plain return with no Add credit press retries nothing", async () => {
    returnToApp();
    await settle();
    expect(state.retried).not.toHaveBeenCalled();
  });

  test("two Add credit presses before the return still retry once", async () => {
    await Promise.all([fixOrganizeProblem("credit"), fixOrganizeProblem("credit")]);
    returnToApp();
    await settle();
    expect(state.retried).toHaveBeenCalledTimes(1);
    expect(state.retried).toHaveBeenCalledWith(["credit-1"], undefined, "svc");
  });

  test("the retry reads the credit list at the return, not at the press", async () => {
    await fixOrganizeProblem("credit");
    state.documents = [doc("credit-1"), doc("credit-2")];
    state.assignments = [held("credit-1", "auth"), held("credit-2", "out-of-credit")];
    returnToApp();
    await settle();
    expect(state.retried).toHaveBeenCalledTimes(1);
    expect(state.retried).toHaveBeenCalledWith(["credit-2"], undefined, "svc");
  });

  test("a second return retries nothing", async () => {
    await fixOrganizeProblem("credit");
    returnToApp();
    await settle();
    expect(state.retried).toHaveBeenCalledTimes(1);
    returnToApp();
    await settle();
    expect(state.retried).toHaveBeenCalledTimes(1);
  });

  test("a second press whose page opens only after the return arms nothing", async () => {
    let release: () => void = () => undefined;
    const pending = new Promise<Providers>((resolve) => {
      release = () =>
        resolve([{ id: "provider-1", kind: "openai", service: { id: "svc", name: "OpenAI" } }]);
    });
    await fixOrganizeProblem("credit");
    state.providers = () => pending;
    const late = fixOrganizeProblem("credit");
    returnToApp();
    await settle();
    expect(state.retried).toHaveBeenCalledTimes(1);
    release();
    await late;
    returnToApp();
    await settle();
    expect(state.retried).toHaveBeenCalledTimes(1);
  });

  test("a return after Organize's service changed sends nothing to the new one", async () => {
    await fixOrganizeProblem("credit");
    state.route = () =>
      Promise.resolve({ where: "cloud", service: { id: "other", name: "Other" } });
    returnToApp();
    await settle();
    expect(state.retried).not.toHaveBeenCalled();
  });

  test("a return after Organize moved to a model on this computer sends nothing", async () => {
    await fixOrganizeProblem("credit");
    state.route = () => Promise.resolve({ where: "local" });
    returnToApp();
    await settle();
    expect(state.retried).not.toHaveBeenCalled();
  });
});
