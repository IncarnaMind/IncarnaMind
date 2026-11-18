---
status: accepted, amended since; each change below names its issue
---

# Each Note is stored as one CRDT document (Yjs)

## Context

The hosted version must sync Notes across devices (ADR-0002). Yjs merges edits made offline on different devices without conflicts, so adding sync later means relaying updates, not migrating data. Sheets, decks and boards are to be stored the way Notes are after the alpha, and Notes must stay safe once computers running different versions sync them.

## Decision

Each Note's content is a single Yjs document that the editor edits directly. The code, data and APIs keep the name `mind` (`CONTEXT.md`). The cost: finding Blocks in a Note, such as the ones above a Question, means reading the document instead of running a query.

### Kinds

Each Note's row has a `kind`. `mind` is the only kind this version opens, and the field stays for sheets, decks and boards. A Note of a kind this version doesn't know is listed, but opens as "Update IncarnaMind to open this", never in the editor, and the core refuses to write to it. The `chat` kind is retired: conversations are kept in SQLite (ADR-0017).

### The content schema version

- **Every Note records the content schema version it was last written with,** in its settings map. `CONTENT_SCHEMA_VERSION` (`src/core/api.ts`) is the newest this version understands, and its comment lists each version and why. A Note with none reads as version 1. The core records its version on every write and never lowers one.
- **A Note written by a newer version opens read-only, with a notice to update.** The editor's Yjs binding deletes node types and marks, and strips attributes, that its schema doesn't know, which would silently destroy another computer's content once sync exists. So for such a Note the core neither compacts nor accepts any update, and its Yjs state stays byte for byte as it was.
- **Raise the version whenever an older version would lose or misread content:** a new node type, mark or attribute; a field inside an attribute that an older version writes back without it (a chart value's `scale`, a comparison column's `label`); a settings record an older writer drops; or a value an older version would misread (an unknown check action, someone else's change taken for the AI's).
- **A raise rewrites nothing.** Older content is valid content of the new version as it is, and records the new version on its next write.
- **No raise** for a map beside the Blocks that an older version keeps as it is, or a new field an older version can ignore without losing anything.

### Proposals are content

- **A change the AI made that waits for the User (a Proposal) is stored in the Note's Yjs document,** so it survives sync and reload and any device can resolve it. Words it removes stay, under the `proposalDelete` mark; words it adds are there, under `proposalInsert`; a whole Block or inline node it adds or removes carries the `proposal` attribute (the editor's Yjs binding keeps no marks on nodes). Each names its Proposal, the request that made it and the text it changes (`target`), without which it is never out of date. A `proposalRequests` map beside the Blocks says which model made each request, and is kept once written. Accepting or rejecting is one Yjs change, defined once for the core and the editor (`src/shared/proposals.ts`).
- **How a Note's text is read.** Question context in a Note, and exports, read the AI's Proposals as accepted: without what they add, with what they would remove. The assistant reading the Note in focus, and `read_mind`, read every change still waiting as a change (`reviewReading`, #893), so it can revise its own; an AI change that is out of date is read as if it weren't there.
- **Someone else's tracked changes** in an imported Word file (#108, ADR-0011) are Proposals with the same marks, accepted and rejected the same way on any device. Each is named by where it is in the file (`word:` and its place), and its request records who made it and when, as the file says (`{ source: "word-change", author, date }`). Out of date, they are never read as if they weren't there: the Word export writes them back as theirs. Models and exports read them as changes, with who made each (#734, ADR-0011).

### One way a model's change reaches a Note (#2796)

Every writer of Proposals (Edit with AI, the assistant's Note tools, an outside agent, Compare Documents, and both Regenerates) once wrote its own way, and the copies disagreed: one dropped a refused paragraph and proposed the rest, another forgot what was asked. Now each writes through one module, `src/core/proposals/apply.ts`, whose header holds the rules:

- The change is written into a copy of the Note and checked there, then written into the Note as Proposals of its one request. A change is refused whole, for the reasons `changeRefusals` lists, in one order for every writer, so an outside agent is refused as Edit with AI is.
- **A write may add Proposals and nothing else:** the User's text, read without what Proposals add and with what they remove, must read as it did. Accepted text is the User's, whoever wrote it.
- **Every Proposal has a target,** a Block added whole included, so a change over text the User has edited since is out of date whichever feature made it.
- **One record** per request, made at the core's clock; Edit with AI's also keeps what Regenerate needs to make the change again as asked, which an older version can ignore without loss.
- **A Checkpoint exactly when the Note's text changes:** just before a change that applies at once first reaches the Note, and when the User accepts or applies one. A change that only waits saves none until then.

### The assistant revises its own waiting text (#893, #1950)

Reading its own Proposals as accepted, the assistant asked to "make the summary longer" found the page empty and wrote a second summary under the first.

- **Its own Blocks:** those an Answer in the assistant added whole (a request of source `answer-added`), still waiting and all AI text. `edit_mind` over them rewrites the text in a copy of the Note and puts the new Blocks in their place, still waiting, as a new request (`src/core/proposals/ownWaiting.ts`). The User's text is never touched. Over any other change still waiting, or its own Blocks beside the User's text, nothing changes and the Answer says so, with Review.
- **What a revision replaced is kept** in a `revisions` map beside the Blocks (`MIND_REVISIONS_FIELD`), by the revising request: the Blocks it replaced and the Block before them. Rejecting all of that request, or writing its Answer again, puts them back exactly; accepting any of it lets them go. An older version would reject the revision and lose them, so this raised the schema version.
- **Origins replaced are kept too** (#1950). A change written over Blocks keeps their ids and gives them the rewriting Answer's origin (`MIND_ORIGINS_FIELD`). A `replacedOrigins` map (`MIND_REPLACED_ORIGINS_FIELD`) keeps each Block's earlier origin by request, so rejecting the change puts it back in the same step, and Undo and Redo take it with the text; without it, Use all on the earlier Answer wrote its text a second time. Entries are kept for good, because History can bring back a version with the change waiting again. An older version keeps the map and leaves `origins` as the change set them, losing no text, so no schema version.

### References and Citations

- **One reference shape.** A reference from one artifact to another is `{ artifactKind, artifactId, anchor }`, with a stable anchor, never a position, so it survives edits and sync: a Note's anchor is a Block's id (`{ kind: "block", blockId }`), a conversation's a message's (`{ kind: "message", messageId }`, ADR-0017). One stored without `artifactKind` is a Note's. It is used for a Block's origin and for the link back from a Note to the conversation it came from.
- **Citations stay editor-independent.** A Citation's target is always a Document Location, independent of the editor and of what holds the Citation. Citations are checked against Documents, never against Blocks or any artifact's structure, so a Citation means the same in a Note, a conversation or a later kind of artifact.
- A chart keeps the Citation of each value it draws in its own attributes, and a comparison table's cells hold theirs as nodes, as an Answer does; the start-up walk that keeps the versions Citations quote reads them there too.

### Maps beside the Blocks

A record about a Block is a map beside the Blocks, keyed by Block id, not an attribute. An attribute would have to be declared on every node type a Block can be, nested ones too, and an older version's editor would strip it unless the schema version rose, which would make every Note written since open read-only there. An older version keeps a map as it is, so a map raises no version. A Block deleted since leaves its entry unused.

- **`textOrigins`** (#78): for each Block holding third-party text (ADR-0013), top-level or nested, where it came from ("imported", "web-page" or "checked-document"). A copy pasted elsewhere gets a new id and counts as the User's, as text pasted from another app does.
- **`blockTimes`** (#139): for each line the User writes while a Meeting records, the Meeting's time in ms, taken when the line first has text, or a Mark when it is made; nothing is taken while the Meeting is paused or stopped. A copy pasted elsewhere has no time.
- **`checkUnread`** (#740): by the request that made the checks, the files in a check's scope that couldn't be read when it started, so the line beside the checks and the AI use statement say what wasn't read then, not now. Each file is kept by its name, reason and Document, never by its path, which belongs to one computer. A request that read everything has no entry, and an entry no check names any more goes when the next request is recorded. It is a map, not part of the check's mark, because it is one list per request, not per sentence.

### Marks on words

A record about words is a mark, kept as a formatting attribute of their text, so it splits and follows them as the User types and goes when they are deleted; only text formatting does that. Readers and exports treat these marks as no mark.

- **`generated`** (#95): the words the AI wrote that the User hasn't made their own. What the User types never takes it, and "Mark as mine" takes it off. An Answer written since carries `generatedMarks: true`; an older one without it is AI text as a whole.
- **`claimCheck`** (#96): a sentence's check (below). It isn't inclusive, so words typed after the sentence aren't under it.

### A sentence's check

A check of a sentence puts a `claimCheck` mark on it, holding the result and what it was made from: the sentence's text as checked, the Document versions read, and the scope. Whether a check still holds is worked out from what it records, so nothing is rewritten when a Document changes. Its evidence's versions are retained under the Note (`retained_versions`, kind `check-result`), not found by the start-up walk.

- **Actions.** A check made now stores `check-against-documents` (#2004). An older Note's `find-support`, the action's first name, still reads and runs as it (`claimCheckActions`), and ⌘K still finds it by "find support". Contradiction watch (#112) stores `contradiction-watch`, whose Check again leaves out the Documents the sentence cites; an older version would check the sentence against those very Documents, so it raised the version. `check-against-document` is a whole read of a pick (#1554, below).
- **Kept as the User's view** (#1111): `kept: true` on an unsupported cited sentence's mark. While its words stay as checked, it shows no mark, isn't counted in the Note's health, and no check runs on it again; editing the words ends it. It lives on the mark, so ⌘Z takes it back with the words.
- **The scope** records `chosen` when it was the Note's own choice (#1623), so the card, the Word comment and the check record name it, and a check made in another scope than the Note's needs a re-check.
- **Unsupported, not Not found** (#1608): the `unsupported` reason carries `found` when the check found a Passage about the sentence that doesn't back it.
- **Absence** (#1443): an absence sentence is Supported only after the check reads every scoped Document; `readDocuments` names each Document read, its version and the Locations shown, and a change to one needs a re-check.
- **Which dollar** (#2226): a part's `currencyClause` is the card's one line naming the Document clause that says which dollar a bare "$" is.

**One check keeps its parts** (#2002). A sentence still has one mark; its ordered `parts` keep each part's UTF-16 character range, whether it is a fact or the writer's opinion, its result and its Citations.

- Parts don't overlap, except that a number inside an opinion is a fact part within it, so the opinion is counted and shown once while its numbers are checked. Words a sort leaves out that say more than a joining word (a time, place, scope or condition) join the fact beside them, or the opinion, so nothing is dropped unchecked.
- The sentence's result and evidence are projections of its parts, written together by one writer, and every factual part must be supported before the sentence is. A quantifier's domain list is never evidence that each member satisfies the claim. An omitted opinion has no verdict, and a failed check stays Not checked.
- Each part owns its figure and remainder judgments with their state, request, time and model; an untouched part keeps its own, and an omitted opinion never becomes a factual remainder. A part's optional `decidingEvidence` points at the Citation that decides it, or is null. Core and editor share one exact mapping from the model's text to the Note's positions, and refuse a part boundary inside an atom.
- Part evidence gets ordinary Note-owned Citation ids, covered by the existing Citation traversal, standing, sign-off and Undo; equal receipts are never merged when ambiguous.
- A sentence of omitted opinions alone has no mark: the Note keeps its exact words, Block, occurrence and part ranges in its settings (`opinionSentences`), invalidated when the words change. Checking such an opinion writes its parts under the sentence's one mark, keeping the other parts' results. The `verification` record's claims gain `occurrence` and `parts`, beside `sortedText`. An older writer drops these settings and the mark's new fields, so this raised the version: an older build opens such a Note read-only and can't strip its parts.
- Every part's Citations, calculated inputs and domain evidence take part in check-result retention; an incomplete inventory can add references but never release versions retained before.

**Each record cite keeps its result** (#1709). The mark's optional `recordCites` holds each cite's span in the sentence as the Note holds it (each Citation counts as one U+FFFC, since the mark's `text` leaves Citations out), its own result, what it resolved to, its evidence and, for an `Id.` or `supra`, what its reading rests on (`via`).

- A choice of Document for a source is one settings key per source, `recordCites:<canonical alias>`, holding the Document's id and the content hash it was chosen at, so two choices made on two devices both survive a sync. A choice whose Document is gone or changed no longer stands, and the cite asks again rather than using another Document.
- `Id.` and `supra` are worked out at check time from the Note's text, never kept as links, so checks in any order read the same. When the Note before one reads otherwise, the sentence shows Needs re-check.
- The sentence keeps its own verdict, but an Unsupported, Not found or Choose cite never sits under a Supported glyph: the margin, the card and the check badge show the sentence as Unsupported until its cites are.
- Resolved passages and nearby suggestions take part in evidence retention; unselected candidates don't. An older editor would drop `recordCites` and a `page` Location's printed `lines`, so this raised the version.

**A check that reads a chosen Document or Folder whole** (#1554). A not-found sentence can be checked against the whole text of one Document or Folder the User picks. The mark records exact coverage, `read: { pages, of }`: `pages` counts only pages every Passage of which reached the model in a request it answered, and `of` is the pick's total, so a partial read never claims something is absent from what it didn't read.

- It reads part by part, keeping parts already Supported or Contradicted; asked about one part, it reads only that one. The previous mark stays until the read ends, so Stop or a crash leaves it, and the result is written only if the mark is still the one the read started from; a sentence already being checked is refused.
- An absence is judged window by window. A window that says the thing is there gets two looks at its quote: Contradicted only when both agree; otherwise that window is unjudged and the part ends Not checked, never Supported. A part is Supported only when every window holds it absent and every page was read. Windows overlap by at least about 1,000 tokens of whole Passages, so a clause cut at an edge is whole in the next. No request reads the whole pick at once, so #1443's 40-page cap doesn't apply; its read of a short scope is unchanged.
- **The estimate and the most it may cost** count the requests the read may send, as the provider counts them, with tokens counted on this computer, never by a provider's counting service, and each call priced at its own prompt's tier as the meter prices it (#2287); the most counts every call at its output limit (#2275). How each is sized is in `src/core/answers/checks/wholeRead.ts`.
- **The budget.** A read of sorted parts that costs about $0.50 or less starts without asking, held to its most or $0.50, whichever is less. Any other asks "About $A, up to $B", where $B is twice $A, at least $0.50 and never more than its most, and is held to $B. A sentence whose parts aren't sorted yet always asks. The meter refuses, before it is sent, any request that would pass the budget, as it refuses one past the monthly cap; after one refusal the read sends nothing more, the parts left are Not checked (`read-budget`), and the card says what it spent, with Continue, which reads and prices only those, never costing more than the whole. While a read runs, its card shows only its progress and Stop.
- **Every read has its plan** (`planDocumentCheck`). A newer plan in the Note stops a read already running, and a read whose plan is no longer the latest sends nothing, checked again after consent and before each window. Check again, and Accept all and check, ask through the sentence's card as the first read did.

**A confirmed contradiction carries its correction** (#1481). A contradicted part can hold a `correction`: the exact old words, which occur once in the part and are never the whole sentence, and up to two replacement wordings from Documents, newest first, each with the Citation whose quote holds it. The core keeps one only after the existing contradiction confirmations, on the part's one contradicted result, and only when the corrected sentence names the same periods and the quote names every one of them; the first choice is the part's deciding evidence. The sentence's `correction` is its first contradicted part's; a whole-sentence check without parts holds its own. Applying corrections is one edit of the Note, with no model request: the wording is written as AI text, missing Citations are added, and the parts are written Supported through Keep as my view's writer.

### A Word file imported as a Note (#104, #746, #912)

A Note imported from a `.docx` (ADR-0011) keeps what export needs to write the User's edits back into the original package (#105), and shows the file's own look.

- **Node types:** `wordAtom` (inline) and `wordBlock` (a Block) for what the editor can't represent and keeps as it is, each naming where its XML is; `image` for an inline picture.
- **Maps:** `word` (the file: its name, the package's SHA-256, size and main part; whose document it is; what the import kept; how far the import has got; how the file numbers its notes) and `wordSources` (for each node mapped from a paragraph, table or footnote: its `w14:paraId` or place, and its fingerprint as imported, which tells export whether it was edited).
- **The package** isn't in the Yjs document: it is kept in the data folder by its SHA-256 (ADR-0011), with a row per Note (migration 75), and would sync as a file of its own.
- **The file's look** (#746) is read once at import, each style resolved as Word resolves it, and kept in the Note, so drawing reads no XML and typing, Undo, Proposals and sync carry it. A `wordLook` map holds each style once as a whole value, keyed by a hash of the style, so it grows with the styles a file uses, not its Blocks, and two devices reading the same package write the same values. Paragraphs, headings, tables and cells name theirs in a `wordLook` attribute, which Enter copies, and text unlike most of its paragraph carries an inclusive `wordRun` mark.
- **The look isn't content.** A node's fingerprint (`wordFingerprint`) leaves the look out, so giving a Block its look never makes export treat it as edited.
- **Direct formatting is the User's** (#912). Any Note can set a paragraph's alignment, indents, spacing and line spacing (`paragraphFormat`) and text's colour, font, size and raise (marks). From `WORD_LOOK_VERSION` 6, the look keeps only what the file's styles and lists give; what a paragraph or run sets itself becomes its format and marks, and export writes a property only where they differ from the file's.
- **Looks given later.** Notes imported before get the look once, at a start, in the background, from their kept package, in one planned and checked change of the core's that is no Undo step in the editor. A Block still as imported gets it; a Block the User changed keeps their text and format and gains only the file's formatting it lacks. A Note whose look an earlier version read has it cleared and given again. `word_packages.look_version` (migration 90) records it, so it never runs twice. Until then, export keeps the file's direct formatting where the Note has none, never removing it.
- **Footnotes, endnotes and page breaks are the Note's own** (#746), no longer read-only atoms. A footnote records its `source` in the package and whether it is an `endnote`; a page break is `PAGE_BREAK_NODE`, in any Note. A copy of one, pasted while the original is still there or into another Note, has no `source`, and export writes it as the User's own. A kept-as-is atom records a `hash` of the file's XML at its place, which tells export the file's own atom from a copy, and the clipboard carries it. A footnote's text is the footnote's own, so editing it leaves its paragraph as imported. Notes imported before are converted when opened, from their kept package; a Note whose package is missing keeps its read-only notes.

### Other content

- **Search scope** (#1623): a `scope` key in the Note's settings map (`MIND_SETTINGS_FIELD`), so it goes and syncs with the Note. It holds the scope's Folders, Tags and Documents as one whole value, with its way back for a narrowed scope; when two devices set it at once one value wins whole and no other key is lost. A Note without it is checked in its Folder while that holds a Document, else in every Document.
- **Numbered lists** (#1419): one of four schemes ("1. a. i.", Outline, Clauses, Chinese report), a start level and a continuation from the list before (`numbering`, `startLevel`, `continues`).
- **Charts** keep the Citation of each value in their `data`, with its `scale`, the rows a cut chart doesn't draw (`cutRows`), and the `figure` it was drawn from (#2307), not one Input's Citation. A chart drawn before holds no figure, and Update draws it again from its table.
- **A Citation the User keeps on the version it quotes** carries `keptOver` (#1869, ADR-0017).
- **Comparison tables** (#98): a column has a `label`, its heading (#1833); the app's headings read `label ?? shortened(text)`, since a heading fits about 40 characters, and the Excel and Word exports `label ?? text`, so a long Question reaches a file whole. A table has a `title` of up to 120 characters on one line (#1837), "Comparison table" when it has none. A cell records `edited` and `fillId` (#1836), so a refill never writes over a newer edit or refill. "Checked by me" on a cell is a sign-off record of kind `cell` (#1933): a change to the cell's Answer, or a newer version of its Document, shows it as checked before the change, which never takes it off.
- **A table of contents Block** (#1935), drawn in the editor, the exports and Word's own field, stores no copy of the headings, so it stays true as they change.
- **A Document chip** (#115) names a Document by its id and keeps its name for when the Document is gone.
- **Pictures** (#1937): a `picture` Block keeps a pasted, dropped or chosen picture in the Note's data as a `data:` URL (the Content-Security-Policy allows no other kind). **No picture goes to a model unless the User selected it for a Question,** and then only to a model that reads images; `pictures` is a kind of data the chat flow names, so a User who allowed Questions before is asked once more (ADR-0022). Local mode sends nothing. The pictures a Question asked about are Block ids in its `focus`, which conversations already keep.

## Considered options

- **One database row per Block with a numeric order:** syncing it later would need a data migration, and translating editor changes into insert, reorder and delete calls is what the old frontend never got working.
- **An attribute on Blocks for a record about a Block:** it must be declared on every node type, and an older editor strips it unless the schema version rises (see Maps beside the Blocks).
- **A map for a record about words:** it can't split and follow words as the User types (see Marks on words).
- **Conversations as Notes of kind `chat`:** see ADR-0017.

## Consequences

- An older build opens a Note written by a newer one read-only; it can never compact, save or silently strip it.
- Unless a section names a migration, each change above lives in the Note's Yjs document alone: no SQL table and no migration. The migrations it names are 75 (kept Word packages) and 90 (`word_packages.look_version`).

### Sync rules

Version 1 has no sync, but follows these rules so sync can be added without migrating data:

1. A Document is known by where its file belongs, its Linked folder and its path inside it, never by a path on one device, and a hash of its content identifies each version (ADR-0020). This replaced identifying a Document by its content hash, which ADR-0010 had already narrowed.
2. Every ID is a random UUID generated on the device, never an auto-increment number, so two devices can't produce the same ID.
3. Deleting something marks it deleted rather than removing the row, so a later sync can tell other devices about the deletion.
4. Secrets (API keys, OAuth tokens) are kept only on the device and never go in data that will be synced.
5. Settings are per device (window size, file paths) or per User (default model, interface language). Only per-User settings will sync.
