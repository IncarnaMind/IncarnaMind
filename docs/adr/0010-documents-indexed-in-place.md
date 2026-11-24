# Documents are indexed in place, not copied

## Context

The spec first copied every added file into the data folder, "so that moving or deleting the originals breaks nothing" (#20, story 41). That duplicates a research library, often by gigabytes, lets files edited in place go stale, and can't keep a folder in sync. This record replaces it and narrows ADR-0008: the data folder holds no copies of the User's files.

## Decision

Documents stay where the User keeps them: IncarnaMind indexes each file at its own path and never copies it. Linked folders (a papers folder, Zotero's storage folder) are kept in sync: new files become Documents, changed files are indexed again, removed files are marked missing. A file added on its own is indexed at its path too, in "Other Documents" below the Linked folders. In-app Folders and Tags (back since 2026-10-08, at the User's request) only change index metadata. Linking a folder makes a Folder bound to it (ADR-0030, amended 2026-11-22, #3613), so the sidebar lists one kind of folder, Folders, the folder's Folder among them with a mark that says where it is on disk; the folder on disk is never shown as a tree beside them.

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

- **Originals stay as they are.** IncarnaMind never changes, renames, moves or deletes a file that is already there, in a Linked folder or anywhere else; a deck the User edits by hand is the one exception (below, 2026-11-24).
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

### A deck edited by hand is written itself (2026-11-24, #149)

This changes "Originals stay as they are" for one case, decided by the User on 2026-11-24: a `.pptx` the User edits by hand on its slides in IncarnaMind. Everything else in that section stands.

- **What changes.** Each gesture (a drag, a resize, a text box from open to close, a run of arrow-key moves) is written at once; there is no Save button. A deck of the User's own, added on its own or in a Linked folder, an agent's hand-over found in a Linked folder included, is written itself, as PowerPoint saves it. A deck IncarnaMind keeps in its data folder (one an agent handed over from elsewhere) takes one new version per sitting instead. Exports, Word round trips, Tasks, checks, agents' hand-overs and any change an AI proposes still never change an original.
- **What keeps it safe.**
  - Only the User's own hand: the write is reached from the deck's viewer alone, through the bridge (`editDeck`, `undoDeckEdit`, `redoDeckEdit`, `saveDeckCopy`, `restoreKeptDeck`); no agent Tool and no assistant command reaches it.
  - Only over bytes the viewer showed: a sitting's first write checks that the file still holds the version the viewer showed, and every write that it still holds what the sitting last wrote, again just before the rename. Otherwise nothing is written and the deck is read again: another program, a sync client or an agent saved it meanwhile.
  - Never half written: the bytes go to a temporary file in the same folder, with the original's permissions, which is renamed over it (`replaceFile`, `src/core/fileNames.ts`). A crash leaves the original whole.
  - Kept first: before a sitting's first write, the file as it stood is kept whole in the data folder (`Kept decks/`, migration 163), flushed to the disk before the User's file is replaced; a state already kept isn't kept again. For each deck the first state kept (the file before IncarnaMind first wrote it, marked as such) stays while the deck is in the Library, with up to 9 others, the oldest let go first, never the one the latest sitting began from. A state is let go only after the write that kept a newer one succeeded, and that receipt says so. The deck's menu offers two, each a step Undo takes back: Put back as it was (the state the latest sitting began from) and, when it differs, Put back as it was before IncarnaMind first changed it; no list of versions. They go with the Document when it is deleted for good; a kept file no record names goes at the next start if it is older than the start.
  - A sitting goes on while any tab of the window shows the deck, so a look at another tab doesn't end it; it ends when the last tab showing the deck closes, the deck changes elsewhere or is put back, or the window closes or reloads. A change that waits to be written outlives its sitting's viewer: the core keeps it until it is saved as a copy or written, the deck opened again shows it, and quitting asks about it as about unsaved Notes. A change that waited whose file another app wrote meanwhile is never written over that: only a copy keeps it.
  - Never written: a deck another app has open (its `~$name` or `.~lock.name#` file beside it), which waits with Try again; a signed deck, one marked as final, one with a password to modify, and a package whose parts would not survive being written back (two entries with one name, a name not marked UTF-8).
  - Only what the gesture touched: the patch layer (`src/core/exports/pptxPatch`) splices the edited shape's runs or transform and copies every other part's stored bytes.
  - A file that can't be written (read-only, locked by another app, gone, a full disk, a folder with no write access) says so where it happened and keeps the change waiting, to be saved as a copy beside it: in its folder, else in the Output location. A copy into a Linked folder still takes that folder's permission. The change waits in memory only, so it lasts while the app runs: quitting asks first, and a crash loses it.
- "Overwrite the original, with a backup", below, stays rejected for every other save. It is taken here for this one: the backup is kept in the data folder, and a sync client's change is met by the check before each write.

## Considered options

- **Copy every added file** (the previous design): independent of the User's files, but duplicated, stale and never in sync.
- **Copy single files, index Linked folders in place:** two storage models are harder to explain and to build.
- **In-app Folders and Linked folders in one tree:** two kinds of folder in one tree confuse. So a Linked folder is shown as a Folder bound to it (ADR-0030, #3613), one kind, never as a second tree of folders on disk.
- **Overwrite the original, with a backup:** fights cloud-drive sync clients and risks losing the User's file.
- **Never write inside a Linked folder:** every Word round trip would land away from its original.
- **Ask before every save into a Linked folder:** repeated asks teach clicking through, and adding a file isn't destructive.

## Consequences

- Backing up the data folder backs up the Minds, the index and settings, not the Documents, which are the User's to back up.
- Linked folders are watched while the app runs and reconciled at start-up (size and modified time, then the content hash). Other Documents are watched by their own folder, without subfolders, and only those files are followed.
- Opening a Document in another app opens the original, with no temporary copy.
- **Migration 21** from the copy layout dropped the in-app Folders of the time (their Documents became unfiled; Search scopes show them as deleted). Copied Documents became files at `<data>/documents/<hash>.<ext>` until the User links the folder holding the original, which then takes over the Document, keeping its id, and the copy is removed.
