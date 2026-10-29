# The Library organises Documents into Folders and Tags, not generated Topics

The Library puts each Document into one in-app Folder (or Not in a Folder) and gives it Tags, in a single Organize action. A classifier makes the assignment: the User's connected model, Auto local routing between local decision models, or Clef-Flash run locally for image-heavy PDFs. Folders are starter ones the User picks or their own, each with a description of what belongs there. The User's manual choices always win and are kept. Original files never move; Folders only change IncarnaMind's index, and source locations (Linked folders as they are on disk) are shown separately.

We replaced the approved design that grouped Documents into a two-level tree of generated Topics by clustering their vectors (`docs/designs/library-structure-view.md`, engineering-reviewed 2026-10-07). There were two reasons. The User judged it too complicated: they wanted Documents in the right folders with the right tags, which is simple to understand and correct. And the check before building showed that clustering with the built-in embedding model splits Topics by language: in held-out English–Chinese same-subject pairs, 0 of 5 landed together (#51). The classifier reads the Documents' content, so a Chinese and an English Document on one subject can share a Folder.

## Considered options

- **Clustering into generated Topics, with model-written names:** rejected, as above. The grouping functions and `npm run eval:grouping` stayed for measurement until 2026-10-10, when they were removed with the rest of the dormant Topic code; the check's fixture set and results are in `eval/grouping/`.
- **Moving or renaming the User's files on disk:** rejected, because ADR-0010 indexes Documents in place and IncarnaMind never changes a Linked folder.

## Consequences

- Organising needs a model: a cloud model under the existing consent rules, or a local one. Without one, Documents stay Not in a Folder until the User files them by hand.
- "Folder" now means an in-app Folder. A folder on disk is part of a source location (CONTEXT.md).
- Bridges from a Folder into writing, and year, format and status filters, are not built yet (#59).

## Folders are projects (2026-10-10, #111)

A Folder holds Minds as well as Documents: the sidebar's one tree lists each Folder's Minds above its Documents, and "Not in a Folder" holds every Mind and Document in none. What was "Unsorted" for Documents and "Not in a Folder" for Minds is one place, so the User learns one idea, not two. A Mind made in a Folder (or moved into one, by its menu or by dragging) starts each Question with the Folder as its Search scope, a chip the User can remove to search everything; the Folder is resolved when the Question is asked, so Documents filed in or out by Organize or by hand count as they are then. A Mind in no Folder searches every Document, as before.

- `minds.folder_id` (migration 34) names the Folder; NULL is Not in a Folder, where every Mind made before is. No foreign key, as everywhere (ADR-0003).
- Moving is one call for Minds and Documents together (`moveToFolder`), all or none, returning where each was so the move can be undone; a Document moved is a manual choice, which Organize keeps. Drag and drop, "Move to…" and #212's multi-select share it.
- Deleting a Folder moves its Minds and Documents to Not in a Folder. Its row is kept, marked deleted, so a Question whose Search scope named it shows the Folder's name struck through; that Question searches nothing rather than everything, as for any deleted Folder.
- We considered Projects as a kind of their own, apart from the Library's Folders, as some notebook apps do. Rejected: two ideas for "where my work lives" is harder to pick up, and Organize already files Documents into Folders by what they are about.

## Amendment: a Folder can keep its work inside it (2026-10-29, #1934)

A Folder's **Keep this Folder's work inside it** switch adds an information barrier for a client matter or a deal. Its Notes use only Documents the User filed in that Folder, and work outside it leaves those Documents and Notes out, including an All Documents search. Automatic and suggested Organize filings wait outside that Search scope until the User accepts them; the switch does not hide Documents or Notes from the Library, Search or ⌘K.

- A Note inside the wall keeps its Folder chip and cannot remove it to widen its scope. Outside, the chip is not a way to pick the walled Folder or its Documents: their names stay visible with a lock, and the All Documents chip says how many Folders are left out. Opening a Note in the Folder remains available.
- The wall is enforced in the core's scope resolution, including checks, Compare, Research and outside agents. A Folder shared with an outside agent is approved only on its own.
- A null Search scope goes through the same resolution as an explicit one: outside work never turns it into every Document. A scope with no Note open may name one walled Folder, never two; each Question records the wall it was asked inside, so moving its Note cannot change an earlier turn's scope.
- A Document or Note can still be moved out. Its move notice says what changes and has Undo. Turning the switch off restores the ordinary Search scope.
- A Citation made before the wall stays readable and opens as before. An outside check does not read its Document again: its last result stands and says **Kept inside {Folder}**.
