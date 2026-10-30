/**
 * What an approval card says the Answer read, by kind (#2240): Documents, web pages, web
 * search's results, Connectors, a script's output, the live Transcript, and other text for every
 * read the list cannot name. Other text is the default, so a kind of read added later is still
 * named on the card.
 */
import { webHostOf } from "../../shared/webAddresses";
import type { AnswerToolCall, DocumentKind, ThirdPartyReason } from "../api";
import {
  ANALYSIS_TOOLS,
  ASK_TOOLS,
  COMMAND_TOOLS,
  DOCUMENT_TOOLS,
  MIND_TOOLS,
  SKILL_TOOLS,
  SOURCE_TOOLS,
  WEB_TOOLS,
} from "../tools";

/** The kinds the card names, in the order it names them. */
export interface ReadKinds {
  /** One entry per Document read, by its id: two Documents with one name are two. */
  documents: string[];
  /** One host per web page read. */
  webPages: string[];
  webSearchResults: boolean;
  /** One entry per Connector whose results were read, by its id. */
  connectors: string[];
  scriptOutput: boolean;
  transcript: boolean;
  /** Some text read that none of the kinds above names. */
  otherText: boolean;
}

/** One finished Tool call's read, as the card groups it. */
export type ToolReadKind = "web-search" | "connector" | "script" | "other" | null;

type Call = Pick<AnswerToolCall, "source" | "tool" | "status" | "connector">;

/**
 * The kind of text one Tool call read, or null for a call that reads none the card names. A call
 * this function does not know is "other": the default is to name what it read, never to leave it
 * off.
 */
export function toolReadKind(call: Call): ToolReadKind {
  switch (call.source) {
    case "documents":
      return call.tool === DOCUMENT_TOOLS.search ||
        call.tool === DOCUMENT_TOOLS.cite ||
        call.tool === DOCUMENT_TOOLS.calculate
        ? null
        : "other";
    case "skill":
      if (call.tool === SKILL_TOOLS.runScript) return "script";
      return call.tool === SKILL_TOOLS.use || call.tool === SKILL_TOOLS.readFile ? null : "other";
    case "sources":
      return call.tool === SOURCE_TOOLS.find ? "web-search" : "other";
    case "web":
      if (call.tool === WEB_TOOLS.search) return "web-search";
      return call.tool === WEB_TOOLS.read ? null : "other";
    case "connector":
      return "connector";
    case "minds":
      return call.tool === MIND_TOOLS.read ||
        call.tool === MIND_TOOLS.edit ||
        call.tool === MIND_TOOLS.add ||
        call.tool === MIND_TOOLS.create
        ? null
        : "other";
    case "commands":
      return call.tool === COMMAND_TOOLS.list || call.tool === COMMAND_TOOLS.run ? null : "other";
    case "asks":
      return call.tool === ASK_TOOLS.ask ? null : "other";
    case "analysis":
      return call.tool === ANALYSIS_TOOLS.run ? "script" : "other";
    default:
      return "other";
  }
}

export interface ReadInput {
  /** Each Passage the model was given, in the order it was. */
  reads: readonly { documentId: string; documentName: string; kind: DocumentKind }[];
  /** The live Transcript's Document, heard rather than read from the Library. */
  transcripts: ReadonlySet<string>;
  calls: readonly Call[];
  /** Why the Run counts as having read third-party text, from its Question context too. */
  reasons: readonly ThirdPartyReason[];
  /** The saved pages whose titles the Run was given, by id: a title belongs to its page. */
  titlesRead: readonly string[];
  /** A saved web page's address; null for a file, or a Document no longer here. */
  webAddress(documentId: string): string | null;
}

/** What the card names the Run read, from the Passages it was given, its calls and its reasons. */
export function readKinds(input: ReadInput): ReadKinds {
  const documents: string[] = [];
  const webPages: string[] = [];
  const connectors = new Map<string, string>();
  const seen = new Set<string>();
  const namedPages = new Set<string>();
  let webSearchResults = false;
  let scriptOutput = false;
  let transcript = false;
  let otherText = false;
  for (const read of input.reads) {
    if (seen.has(read.documentId)) continue;
    seen.add(read.documentId);
    if (input.transcripts.has(read.documentId)) {
      transcript = true;
      continue;
    }
    if (read.kind === "web") {
      const source = input.webAddress(read.documentId);
      const host = source === null ? null : webHostOf(source);
      if (host === null) otherText = true;
      else {
        webPages.push(host);
        namedPages.add(read.documentId);
      }
      continue;
    }
    documents.push(read.documentName);
  }
  for (const call of input.calls) {
    if (call.status !== "done") continue;
    switch (toolReadKind(call)) {
      case "web-search":
        webSearchResults = true;
        break;
      case "connector":
        if (call.connector) connectors.set(call.connector.id, call.connector.name);
        else otherText = true;
        break;
      case "script":
        scriptOutput = true;
        break;
      case "other":
        otherText = true;
        break;
      case null:
        break;
    }
  }
  for (const reason of input.reasons) {
    // A web page read is named by its host; every other reason is text the list doesn't name.
    if (reason.via === "read" && reason.source === "web-page") {
      if (webPages.length === 0 && !webSearchResults) otherText = true;
    } else otherText = true;
  }
  // A title is its page's, named by host as a read page is, never by the title it wrote itself.
  for (const documentId of input.titlesRead) {
    if (namedPages.has(documentId)) continue;
    const source = input.webAddress(documentId);
    const host = source === null ? null : webHostOf(source);
    if (host === null) otherText = true;
    else {
      webPages.push(host);
      namedPages.add(documentId);
    }
  }
  return {
    documents,
    webPages,
    webSearchResults,
    connectors: [...connectors.values()],
    scriptOutput,
    transcript,
    otherText,
  };
}
