import { describe, expect, test } from "vitest";
import type { DocumentGroupAssignment, LibraryGroup, OwnFile, Settings } from "../../src/core/api";
import { countedByChoice, leftOutOfEvidence } from "../../src/shared/evidence";

const settings = (leaveOutOwnFiles: boolean): Pick<Settings, "user"> => ({
  user: {
    language: "en",
    chatModel: null,
    quickTasksModel: null,
    imageModel: null,
    suggestWhileWriting: false,
    leaveOutOwnFiles,
    exportOptions: {
      format: "docx",
      docx: {
        includeQuestions: false,
        trackChanges: true,
        markAiText: "mark",
        commentFailedChecks: true,
      },
      pdf: { includeQuestions: false },
      html: { includeQuestions: false },
      "share-page": { includeQuestions: false, citationCards: true, checkedLine: false },
    },
    authorName: null,
    personId: null,
    monthlyCap: null,
    webSearch: false,
    keepWebPageLook: false,
    taskNotifications: true,
    recentCitationStyles: [],
    newMindStyle: { font: "default", size: "default" },
  },
});

const folder = (countsOwnFiles: boolean): LibraryGroup => ({
  id: "drafts",
  name: "Drafts",
  description: "",
  countsOwnFiles,
  createdAt: "",
  updatedAt: "",
});

const filed: DocumentGroupAssignment = {
  documentId: "export",
  groupId: "drafts",
  source: "user",
  suggested: false,
  status: "classified",
  error: null,
  model: null,
};

const exported = (counted = false): { id: string; ownFile: OwnFile } => ({
  id: "export",
  ownFile: { kind: "export", counted },
});

describe("whether checks leave a Document out of their evidence, as the window shows it", () => {
  test("a file IncarnaMind wrote is left out until counted; the User's own files never are", () => {
    expect(leftOutOfEvidence(exported(), settings(true), null)).toBe(true);
    expect(leftOutOfEvidence(exported(true), settings(true), null)).toBe(false);
    expect(leftOutOfEvidence({ id: "notes", ownFile: null }, settings(true), null)).toBe(false);
    // Before settings have loaded, the default: left out.
    expect(leftOutOfEvidence(exported(), null, null)).toBe(true);
  });

  test("Settings, or the Folder it is in, can count IncarnaMind's files", () => {
    expect(leftOutOfEvidence(exported(), settings(false), null)).toBe(false);
    const library = (counts: boolean) => ({ groups: [folder(counts)], assignments: [filed] });
    expect(leftOutOfEvidence(exported(), settings(true), library(true))).toBe(false);
    expect(leftOutOfEvidence(exported(), settings(true), library(false))).toBe(true);
    // Another Folder's switch says nothing of it.
    expect(
      leftOutOfEvidence(exported(), settings(true), { groups: [folder(true)], assignments: [] }),
    ).toBe(true);
  });

  test("taking Count it back is offered only where it would leave the Document out again", () => {
    expect(countedByChoice(exported(true), settings(true), null)).toBe(true);
    expect(countedByChoice(exported(false), settings(true), null)).toBe(false);
    // Settings, or its Folder, counts it anyway: taking the choice back would change nothing.
    expect(countedByChoice(exported(true), settings(false), null)).toBe(false);
    const library = { groups: [folder(true)], assignments: [filed] };
    expect(countedByChoice(exported(true), settings(true), library)).toBe(false);
    expect(countedByChoice({ id: "notes", ownFile: null }, settings(true), null)).toBe(false);
  });
});
