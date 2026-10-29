import type { ChatModelChoice, ExternalService, ProviderError, TaggingState } from "../api";

/** An in-app folder. The legacy Group API name keeps saved assignments compatible. */
export interface LibraryGroup {
  id: string;
  name: string;
  description: string;
  /**
   * Checks count the files IncarnaMind wrote in this Folder as evidence (#80):
   * the User switched their exclusion off here. False by default.
   */
  countsOwnFiles: boolean;
  /** Only this Folder's Documents and Notes may be read or cited from it. False by default. */
  keepInside: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * The model that tags and organizes Documents: "automatic" picks one
 * from what the User has set up (see ./tagging), the default. The others are
 * chosen by hand, and never fall back to another provider:
 * - "chat": a model on a saved chat provider;
 * - "jev": TypeSafe Jev, with the key saved on this device;
 * - "auto": the local decision models in Ollama, picked per Document;
 * - "ollama": one local decision model, by name.
 */
export type LibraryClassifier =
  | { kind: "automatic" }
  | { kind: "chat"; choice: ChatModelChoice }
  | { kind: "jev" }
  | { kind: "auto"; baseUrl: string }
  | { kind: "ollama"; baseUrl: string; modelId: string; usePageImages?: boolean };

/** A model that tags: a classifier chosen by hand, or the one Automatic picked. */
export type TaggingClassifier = Exclude<LibraryClassifier, { kind: "automatic" }>;

/** Where a model that tags runs, grouped as the composer's model chip groups models. */
export type TaggingModelGroup = "keys" | "plan" | "local";

/** About what tagging and organizing 100 Documents costs with a model. */
export type TaggingCost =
  /** On this computer. */
  | { kind: "free" }
  /** It counts against the User's ChatGPT plan. */
  | { kind: "plan" }
  /** At the model's price in the catalog, for a typical Document (an excerpt of about 1,500 tokens). */
  | { kind: "estimate"; currency: "USD" | "CNY"; amount: number }
  | { kind: "unknown" };

/** A model the User can tag with, as the Tagging section lists it. */
export interface TaggingModelOption {
  /** What choosing it saves (`LibrarySettings.classifier`). */
  classifier: TaggingClassifier;
  group: TaggingModelGroup;
  /** Its name in the catalog, else its id, e.g. "Claude Haiku 5.5", "tev1:4b". */
  name: string;
  /** The provider it is reached through, in English and Chinese; null for Ollama's decision models. */
  provider: { en: string; zh: string } | null;
  /** The provider's tagging model, or a local decision model: picked for tagging. */
  goodForTagging: boolean;
  /** A local decision model in Ollama, or Ollama's decision models picked per Document ("auto"). */
  decisionModel: boolean;
  /** It says how likely each Tag is, so the Tags it isn't sure of are marked for review (Jev, decision models). */
  likelihoods: boolean;
  cost: TaggingCost;
}

/**
 * Why Automatic picked its model: TypeSafe Jev; the chat provider's tagging
 * model, its quick-tasks model, or its Answers model when it names neither;
 * the ChatGPT plan's; Ollama's local decision models; the chat model on this computer.
 */
export type AutomaticTaggingReason =
  | "jev"
  | "tagging-model"
  | "quick-model"
  | "answers-model"
  | "plan"
  | "decision-models"
  | "local-chat";

/**
 * Where a choice sends its requests, as the core works it out for the data flows it registers: to
 * a service, nowhere (it runs on this computer), or unknown, because what it names isn't there
 * (its provider was removed, or Jev's key).
 */
export type TaggingDestination =
  | { kind: "here" }
  | { kind: "service"; service: ExternalService }
  | { kind: "unknown" };

/** What the Tagging section shows (see `CoreApi.getTaggingModels`). */
export interface TaggingModels {
  /** What Automatic tags with now, and why; null when there is nothing it can use, so tagging waits. */
  automatic: (TaggingModelOption & { reason: AutomaticTaggingReason }) | null;
  /** The models to choose by hand: Your keys, the ChatGPT plan, then this computer. */
  options: TaggingModelOption[];
  /** "Keep everything on this computer" is on: Automatic picks only local models, and a cloud one waits. */
  localMode: boolean;
  /** Tagging on a plan (ChatGPT's or Claude's) waits for its limit to reset, until this time (ISO 8601, UTC); null when it doesn't. */
  planPausedUntil: string | null;
  /** The choice the User saved, with where it sends its requests; null while Automatic is the setting. */
  saved: { classifier: TaggingClassifier; destination: TaggingDestination } | null;
}

export interface ClassificationModel {
  id: string;
  images: boolean;
  reason: "text" | "visual" | "slow" | "memory" | "unavailable" | "selected";
}

export interface LibrarySettings {
  /** The one model choice for automatic tagging and Organize; "automatic" until the User picks one. */
  classifier: LibraryClassifier;
  /**
   * While `classifier` is "automatic", the model Organize uses: Automatic's pick
   * at the moment the User answered Organize's "Use {company}", kept from then
   * on; null until they do. Automatic covers tagging only.
   */
  organizeWith: TaggingClassifier | null;
  /**
   * Tag and sort new and changed Documents by itself, once a model is chosen
   * (#1617). Until the User sets it, it is on for a model on this computer
   * and off for a cloud model, since each Document's name and an excerpt go
   * to it. Off, nothing is sent by itself: what the User starts by hand
   * (Organize, a re-tag) still goes. A Document added while it is off isn't
   * tagged or sorted when it is turned on.
   */
  automatic: boolean;
  /**
   * Where automatic Tagging with AI is stopped: Folder ids, and null
   * for Not in a Folder. Empty until the User presses Stop.
   */
  taggingStopped: (string | null)[];
}

export type ClassificationStatus = "pending" | "classifying" | "classified" | "waiting" | "failed";

export interface DocumentGroupAssignment {
  documentId: string;
  groupId: string | null;
  /** When it joined this Folder (ISO 8601, UTC), kept by Undo; absent in older clients. */
  filedAt?: string;
  source: "automatic" | "user";
  /**
   * `groupId` is a Suggested Folder: Organize proposed it and it waits for the
   * User. Meanwhile it counts as the Document's Folder, in listings and in
   * that Folder's Search scope. Always with source "automatic".
   */
  suggested: boolean;
  status: ClassificationStatus;
  error: ProviderError | null;
  model: ClassificationModel | null;
  /** The Document's own tagging row as it was, on the assignments a snapshot or event lists and on a move's change. */
  tagging?: DocumentTagging;
}

/** A Document's own tagging row as it was, for an Undo to put back. */
export interface DocumentTagging {
  /** As stored; "skipped" is worked out from the Document's status, never stored. */
  status: Exclude<TaggingState, "skipped">;
  error: ProviderError | null;
  /** When the row last changed: the same state written again is still a newer one. */
  updatedAt: string;
}

/**
 * A Document's place as a change found or left it: its assignment, or none, and the Document's
 * own tagging row when the change moved it. Undo compares the current rows with `after`.
 */
export interface AssignmentState {
  assignment: Omit<DocumentGroupAssignment, "documentId"> | null;
  /** Null when the change left the Document's tagging alone. */
  tagging: DocumentTagging | null;
}

/** One Document's assignment as a change left it, for Undo: the real rows before and after. */
export interface AssignmentChange {
  documentId: string;
  before: AssignmentState;
  after: AssignmentState;
}

/** Documents added together, by one `addDocuments` or `addLinkedFolder`. */
export interface DocumentBatch {
  id: string;
  /**
   * The Folder they were added to, where each is filed as the User's choice
   * and Organize suggests only Tags. Null: Organize suggests their Folders.
   */
  groupId: string | null;
  /** The Documents it added, in order, deleted ones left out. Files already added aren't in it. */
  documentIds: string[];
  /** More may join: the files are still being added, or a Linked folder's first scan is running. */
  adding: boolean;
  /** How many have been read: their text extracted, or found to have none, or failed. */
  read: number;
  /** How many Organize has finished with: a Folder suggested or none, and their Tags. */
  sorted: number;
  /** How many wait in each Suggested Folder, most first. */
  suggested: { groupId: string; count: number }[];
}

export interface LibrarySnapshot {
  groups: LibraryGroup[];
  /**
   * The Folders deleted since, by name order: a Search scope that names one
   * still shows its name, struck through (the search leaves it out).
   */
  deletedGroups: LibraryGroup[];
  assignments: DocumentGroupAssignment[];
  settings: LibrarySettings;
  /**
   * What `settings.automatic` would be if the User hadn't set the switch: on for a model
   * on this computer, off for a cloud model (#1617). Settings › Models compares the two, so
   * a switch that only follows the model never counts as a choice of the User's own.
   */
  automaticDefault: boolean;
  /**
   * Automatic tagging and sorting was turned off for a cloud model once (#1617), since it sent
   * each Document's name and an excerpt: the Library says so once, until the User closes the line.
   */
  automaticOffNotice?: boolean;
}

export interface LibraryGroupInput {
  name: string;
  description: string;
  /** See `LibraryGroup.countsOwnFiles`. Left out, it stays as it was (false for a new Folder). */
  countsOwnFiles?: boolean;
  /** See `LibraryGroup.keepInside`. Left out, it stays as it was (false for a new Folder). */
  keepInside?: boolean;
}
