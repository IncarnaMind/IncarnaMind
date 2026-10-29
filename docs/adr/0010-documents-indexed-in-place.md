# Documents are indexed in place, not copied

**Amended 2026-10-08:** At the User’s request, the Library again offers in-app Folders (previously called Groups) and Tags. These only update index metadata: originals remain at their source paths. The sidebar separates Folders from Source locations, avoiding two kinds of folder in one tree. This supersedes the removal of in-app organisation described below; indexing, watching, citations and read-only source handling are unchanged.

**Amended 2026-10-26 (#2004): the first save doesn't ask. It goes to the Output location, Documents › IncarnaMind until the User picks another, and says where; it asks only when the default can't be made or written to (CONTEXT.md, Output location; `src/core/outputFiles.ts`).**

Documents stay where the User keeps them. IncarnaMind indexes each file at its own path and never copies it into the data folder. The User adds Linked folders (a papers folder, Zotero's storage folder) and IncarnaMind keeps them in sync: new files become Documents, changed files are indexed again, and removed files are marked missing. A single file added on its own is indexed at its path too. Each folder inside a Linked folder is a Folder in the sidebar; in-app Folders that the User filed Documents into by hand are gone, and Tags remain for grouping across folders.

What the index keeps is enough for Citations without the file:
- Each Document's page text and Passages live in SQLite, and the Citation check compares quotes against that stored text, not the file.
- Each version of a file is identified by the SHA-256 of its content.
- When a file changes, the new version is indexed and becomes what search and new Answers use. The old version's pages are kept for as long as a Citation points at them, so the Citation is still checked against the text it quoted, and it says the Document changed after it was cited.
- A new version that can't be read (a sync client wrote it half-way, or it is corrupt) replaces nothing: the last good version stays indexed and searched, and the Document shows the failure and offers Retry until a retry or a later change is read.
- A file that moves or is renamed is found again by its content fingerprint, so its Citations and Search scopes follow it. One also edited where IncarnaMind didn't see it is found by its identity on its disk, or as the one clear candidate (ADR-0020's amendment, #389).
- A file that disappears leaves a missing Document whose text and Citations remain. Only the rendered page, which needs the file, is lost.
- Unlinking a Linked folder removes its Documents from the index but keeps the Units (ADR-0011) its Citations point to, so they are still checked; like an old version's pages, that text goes once no Citation quotes it (settled with the User on 2026-10-07).

Settled with the User on 2026-10-07:
- **A Document is a file at a path.** The same content in two places is two Documents. Search shows each Passage once, preferring the copy inside the Search scope.
- **Missing vs unavailable.** A file removed from a folder that is still there is a missing Document, and new searches leave it out. A Linked folder that can't be reached, such as an unplugged drive, makes its Documents unavailable. They are still searched from their stored text.
- **Cloud drives.** Online-only placeholder files are never read, because reading downloads them. The Linked folder says how many it skipped, and offers to download and index them.
- **Flat or nested.** A Linked folder can show its subfolders or a flat list. It starts flat when nearly every subfolder holds one file and there are many of them (at least 20), which is Zotero's `storage/<key>/` layout; a small library keeps its folders. The User picks the layout when linking and can switch it later.
- **Big folders.** Linking says how many files and roughly how long before indexing starts. Indexing runs newest first, and can be paused and resumed. (2026-10-23, #1506: how long is measured on this computer, so it shows only once files of the folder's kinds, and of sizes near its files', have been read here.)
- **Read-only.** IncarnaMind never writes, renames or deletes anything in a Linked folder. (Amended on 2026-10-10, below: it may add new files there with the folder's permission, and still never changes the files already there.)
- **Other Documents.** Files added on their own form the "Other Documents" group, below the Linked folders.
- **Web pages** (2026-10-10, #261) have no file of the User's to index in place: a page saved by its address is kept as a snapshot in the data folder ("Web pages"), which is its Document's file, and "Fetch again" writes its new versions there (ADR-0011's amendment).

This replaces the spec's original choice (issue #20, story 41: "copied into the app's data folder, so that moving or deleting the originals breaks nothing") and narrows ADR-0008: the data folder no longer holds Document files.

## Considered options

- **Copy every added file into the data folder** (the previous design): Citations and backups never depend on the User's own files, but a research library is duplicated (often gigabytes), files edited in place go stale, and a folder can't stay in sync.
- **Copy single files, index Linked folders in place**: protects files dragged in from Downloads, but two storage models are harder to explain and to build.
- **Keep in-app Folders alongside Linked folders**: more flexible, but two kinds of Folder in one tree confuse; Tags already cover grouping across folders.

## Consequences

- Backing up the data folder backs up the Minds, the index and settings, but not the Documents. The User's files are theirs to back up.
- IncarnaMind watches Linked folders while it runs and reconciles them at start-up (size and modified time first, then the content hash), because files change while it is closed.
- Other Documents are watched too, by the folder each is in, without its subfolders: an edit, a deletion, or a rename or move into such a folder is picked up while the app runs. Only the files added on their own are followed; nothing else in their folders is added.
- Opening a Document in another app opens the original; no temporary copies.
- Linked folders on cloud drives can hold placeholder files that aren't downloaded; those wait until they're readable.
- **Migration 21** from the copy layout drops the in-app Folders: their Documents become unfiled, and Search scopes show those Folders as deleted. Copied Documents become single files at `<data>/documents/<hash>.<ext>` until the User links the folder holding the original; that Linked folder then takes over the Document, keeping its id, and the copy is removed.

## Amendment: new files go to an Output location, and into a Linked folder only with its permission (2026-10-10, #124)

Settled with the User on 2026-10-09: originals are never changed or deleted, and the files IncarnaMind creates (exports, and later transcripts, saved web pages and what Tasks make) go where the User picks. This replaces "IncarnaMind never writes, renames or deletes anything in a Linked folder" with:

- **Originals stay as they are.** IncarnaMind never changes, renames, moves or deletes a file that is already there, in a Linked folder or anywhere else.
- **The Output location.** New files go to one folder the User picks. The first save asks, offering "IncarnaMind" in the User's Documents folder, and the answer is kept per device (paths belong to one computer, ADR-0003). Settings › General shows it and changes it. IncarnaMind writes nowhere else without asking.
- **Inside a Linked folder only with its permission.** A new file can go inside a Linked folder, next to the original it was made from or because the Output location is inside one, once the User allows that folder. The first save there asks, once per Linked folder; the answer, yes or no, is remembered (migration 35, `linked_folder_writes`) and changed in Settings › General. Unlinking the folder forgets it. A "no" refuses later saves there without asking again.
- **Nothing is replaced.** A new file takes its name, or the next free one ("Tides 2.docx"), and each name is created exclusively, so a file or a link already under it is never overwritten or followed.
- **Path checks resolve links.** The folder a file goes to is resolved, symbolic links followed, and must still be inside the Output location the User chose or inside a Linked folder. A link that leads anywhere else is refused, and nothing is written.

One core call does all of this for every feature that makes a file (`OutputFiles.save` in `src/core/outputFiles.ts`): it finds the folder, asks what hasn't been answered, picks a free name and says where the file went. A file it saves inside a Linked folder is picked up there like any other file and becomes a Document.

### Considered options

- **Overwrite the original, with a backup:** the most convenient, like saving in Word, but it fights cloud-drive sync clients and risks losing the User's file.
- **Never write inside a Linked folder** (the rule until now): the strictest, but every Word round trip would be saved somewhere away from its original.
- **Ask before every save into a Linked folder:** safe, but asking again and again teaches the User to click through; adding a file is not destructive, so one answer per folder is enough.

## Amendment: check results, saved pages, Tasks and Checkpoints retain old versions too (2026-10-11, #79)

An old version's text was kept only while a Citation quoted it. Check results (their evidence), saved pages, unfinished Tasks and Checkpoints point at versions too, and they are kept outside Minds. Each now retains the versions it needs, and where in them, in one table (migration 48, `src/core/documents/retention.ts`):

- The start-up clean-up keeps a version that a Citation quotes or something retains. It reads every retained version with one query, beside its walk over Minds, which isn't extended.
- Unlinking a Linked folder keeps the Units retained, as it keeps those Citations point to.
- Once its last owner releases a version, and no Citation quotes it, its text goes at the next start. A release stays as a deleted row for 30 days, for a later sync to pass on, and is then forgotten.

## Amendment: a Document is known by where it belongs, not by its path (2026-10-11, #171)

"A Document is a file at a path" becomes "a file at a place": its Linked folder and its path inside it, the data folder, or a file of its own (ADR-0020). Its absolute path is where that place is on this computer, and differs on another. A Linked folder that moved, or that is somewhere else on another computer, is pointed at where it is now with Locate folder… in its menu: its Documents keep their ids, versions, Tags and Citations, and a file whose content didn't change isn't processed again (migration 58). The same content in two places is still two Documents, and a file that moves within what IncarnaMind watches is still found by its content.

## Amendment: the cited page is saved when a Citation is made (2026-10-12, #133)

A file that disappears no longer takes the cited page with it:

- **What is saved.** When a Citation is made (in an Answer, or with a suggestion the User accepts), how its Location looked in the version it quotes becomes a picture in the data folder's "Cited pages": a PDF's pages, drawn by the page-image worker; a slide, the rows a sheet's Citation covers, a section or lines of text, drawn by their viewer off screen. The text drawn on it, each run with its box, is kept beside it (migration 73), so a quote can be found and highlighted on it. One picture per Location and version.
- **When.** In the background queue, never while an Answer is being written. A picture a quit cut short is drawn at the next start, if the file still has that version; none is drawn of a version the file no longer has.
- **How long.** While a Citation or a Checkpoint points at it, and it retains its version meanwhile (as a saved page, above). At the first start after the last one goes, it goes. The pictures are never searched, and are this computer's.

## Amendment: a cited page whose drawing fails waits to be drawn again (2026-10-29, #2161)

A drawing that failed once took its page away for good: the next Citation of the Location was its only chance. On GitHub's macOS runner a Word section taller than the screen made the hidden window grow, and the picture asked for before the first frame of the new size was dropped by the compositor ("UnknownVizError").

- **The picture.** After the hidden window grows, the picture waits for a frame painted at the new size; one the compositor still drops is asked for again, three times at most.
- **The page.** A page not saved keeps waiting (migration 113). It is drawn again at the next start, when its Location is cited again, or when its page is asked for (an export); after three failed drawings, only another Citation tries again. A page whose file doesn't have the version cited waits for that version without counting a failure; none is drawn of another version.
- **What is logged.** Each failed picture and each page not saved, with how many drawings have failed, and one line for each drawing with its frames and pictures. A page that can't be saved is no problem the User can act on: where its file is missing, the Document says so already, and the source pack shows the quotes of a page not saved.
