# Documents are indexed in place, not copied

## Context

The spec first copied every added file into the data folder, "so that moving or deleting the originals breaks nothing" (#20, story 41). That duplicates a research library, often by gigabytes, lets files edited in place go stale, and can't keep a folder in sync. This record replaces it and narrows ADR-0008: the data folder holds no copies of the User's files.

## Decision

Documents stay where the User keeps them: IncarnaMind indexes each file at its own path and never copies it. Linked folders (a papers folder, Zotero's storage folder) are kept in sync: new files become Documents, changed files are indexed again, removed files are marked missing. A file added on its own is indexed at its path too, in "Other Documents" below the Linked folders. In-app Folders and Tags (back since 2026-10-08, at the User's request) only change index metadata, and the sidebar shows them apart from Source locations, so no tree mixes two kinds of folder.

**The index keeps enough for Citations without the file.**

- Page text and Passages live in SQLite, and **the Citation check compares quotes against that stored text, not the file.**
- Each version is identified by the SHA-256 of its content. Search and new Answers use the newest; an old version's pages stay while a Citation quotes them or something retains them (#79, below), and such a Citation says the Document changed after it was cited.
- A new version that can't be read (half-written by a sync client, or corrupt) replaces nothing: the last good one stays searched, and the Document shows the failure with Retry.
- A file that moves or is renamed is found again by its content, and its Citations and Search scopes follow; one also edited unseen is found by its identity on disk, or as the one clear candidate (ADR-0020, #389).
- A file that disappears leaves a missing Document whose text, Citations and saved cited pages remain.
- Unlinking a Linked folder removes its Documents from the index but keeps the Units (ADR-0011) that Citations quote or something retains, until nothing does.

**A Document is a file at a place** (#171): its Linked folder and its path inside it, the data folder, or a file of its own (ADR-0020); it was "a file at a path". Locate folder… points a Linked folder that moved, or is elsewhere on another computer, at where it is now; its Documents keep their ids, versions, Tags and Citations, and unchanged files aren't processed again (migration 58). The same content in two places is two Documents, and search shows each Passage once, preferring the copy inside the Search scope.

**Settled with the User on 2026-10-07:**

- **Missing vs unavailable.** A file gone from a folder that is still there is missing, and new searches leave it out. A Linked folder that can't be reached (an unplugged drive) makes its Documents unavailable; they are still searched from stored text.
- **Cloud drives.** Online-only placeholders are never read, because reading downloads them; the Linked folder says how many it skipped and offers to download and index them.
- **Flat or nested.** A Linked folder starts flat when it has at least 20 subfolders and nearly each holds one file (Zotero's `storage/<key>/`); the User can switch.
- **Big folders.** Linking says how many files and roughly how long, an estimate measured on this computer and shown only once files of those kinds and sizes have been read here (#1506). Indexing runs newest first and can be paused.
- **Web pages** (#261) are snapshots in the data folder's "Web pages", each its Document's file; "Fetch again" writes new versions there (ADR-0011).

### Originals are never changed; new files go to the Output location (2026-10-10, #124)

This replaced "never writes, renames or deletes anything in a Linked folder".

- **Originals stay as they are.** IncarnaMind never changes, renames, moves or deletes a file that is already there, in a Linked folder or anywhere else.
- **The Output location,** kept per device (ADR-0003), takes the files IncarnaMind creates (exports, transcripts, saved pages, what Tasks make). The first save goes to Documents › IncarnaMind until the User picks another, and says where; it asks only when that can't be made or written to (#2004; CONTEXT.md). Settings › General changes it. IncarnaMind writes nowhere else without asking.
- **Inside a Linked folder only with its permission** (next to the original a file was made from, or because the Output location is inside one). The first save there asks, once per Linked folder; the yes or no is remembered (migration 35, `linked_folder_writes`), changed in Settings › General, and forgotten on unlinking. A "no" refuses later saves without asking.
- **Nothing is replaced:** a new file takes the next free name ("Tides 2.docx"), created exclusively, so nothing under that name is overwritten or followed.
- **Path checks resolve links:** the target folder, symbolic links followed, must be inside the Output location or a Linked folder, or nothing is written.

`OutputFiles.save` (`src/core/outputFiles.ts`) does this for every feature that makes a file. A file saved inside a Linked folder becomes a Document like any other.

### What else retains an old version (2026-10-11, #79)

A check result's evidence, a saved page, an unfinished Task and a Checkpoint record the versions they need, and where, in one table (migration 48, `src/core/documents/retention.ts`). A version that nothing retains and no Citation quotes loses its text at the next start. A release stays as a deleted row for 30 days, for a later sync, then is forgotten.

### The cited page is saved when a Citation is made (2026-10-12, #133)

- When a Citation is made, its Location as it looked in the version it quotes becomes a picture in the data folder's "Cited pages", with the text drawn on it and each run's box (migration 73), so the quote can be found and highlighted. One picture per Location and version, drawn in the background queue, never while an Answer is written.
- It stays while a Citation or a Checkpoint points at it, retaining its version, and goes at the first start after. The pictures are never searched, and belong to this computer.
- **A failed drawing waits** (#2161, migration 113): it is tried again at the next start, when its Location is cited again, or when the page is asked for; after three failures only a new Citation tries again. A file that lacks the version waits without counting a failure. The failure is logged, not shown: a missing file's Document already says so, and the source pack shows the quotes of a page not saved.

## Considered options

- **Copy every added file** (the previous design): independent of the User's files, but duplicated, stale and never in sync.
- **Copy single files, index Linked folders in place:** two storage models are harder to explain and to build.
- **In-app Folders and Linked folders in one tree:** two kinds of folder in one tree confuse.
- **Overwrite the original, with a backup:** fights cloud-drive sync clients and risks losing the User's file.
- **Never write inside a Linked folder:** every Word round trip would land away from its original.
- **Ask before every save into a Linked folder:** repeated asks teach clicking through, and adding a file isn't destructive.

## Consequences

- Backing up the data folder backs up the Minds, the index and settings, not the Documents, which are the User's to back up.
- Linked folders are watched while the app runs and reconciled at start-up (size and modified time, then the content hash). Other Documents are watched by their own folder, without subfolders, and only those files are followed.
- Opening a Document in another app opens the original, with no temporary copy.
- **Migration 21** from the copy layout dropped the in-app Folders of the time (their Documents became unfiled; Search scopes show them as deleted). Copied Documents became files at `<data>/documents/<hash>.<ext>` until the User links the folder holding the original, which then takes over the Document, keeping its id, and the copy is removed.
