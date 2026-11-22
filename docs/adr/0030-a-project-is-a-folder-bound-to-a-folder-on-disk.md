---
status: accepted (2026-11-20), amended 2026-11-22 (#3613)
---

# A Project is a Folder bound to a folder on disk

A User's piece of work often lives in a folder on their computer, and the AI agent they run works in that folder. Today the two don't meet. A Linked folder's Documents are in no Folder until the User files each one. So an agent given a Folder doesn't reach the files in the folder it works in, a new file lands in Not in a Folder, and a file the agent hands over from there is refused (#3499).

## Decision

An in-app Folder may be **bound** to one folder on disk: a Linked folder, or a folder inside one. The code and the agents' words call it a **Project**; the interface calls it a Folder (amended, #3613). Binding is the only new idea: the Project stays a Folder, and the folder stays a Linked folder. **Linking a folder makes its Folder at once** (amended, #3613), named after it, at the top level or inside the Folder it was dropped on; it shows wherever a Folder shows, as a Folder, with a link mark that says where the folder is on disk.

- **Its files are filed in it as they arrive.** A Document under the bound folder that has no filing of its own is filed in the bound Folder, as the User's own choice, when the scan adds it or a file moves in. Binding files the Documents already there that have none. Organize leaves these filings alone, as it leaves any filing of the User's. A Document the User files elsewhere by hand stays where they put it. A folder bound inside a larger bound one takes its own files. Nothing rewrites a filing that already exists.
- **It is open to work outside it, as any new Folder is** (amended, #3613): the User walls it from its menu when they want to. A Folder got just by linking that kept its work inside it would be left out of every other Note's search and of what a connected agent reads by default, with no word to the User why. A Project made before keeps its wall.
- **Filing as one Folder can be turned off from its menu, and on again** (#3613). Off, each of the folder's Documents its Folder still holds goes back to the place binding found it in, or to no filing, where Organize may place it, and its new files land in Not in a Folder; the Folder stays, a plain Folder, while it holds a Note, a Folder or a Document the User put there from elsewhere, and otherwise goes without passing through Recently deleted. The folder is then a row of its own in the list of Folders, with the folder's actions. On again binds the same Folder. Each has Undo.
- **Reach is unchanged.** An agent given the bound Folder reaches its Documents because they are filed in it. Reach is still a Folder id, and every check made after a wait stays as it is. A hand-over from the bound folder goes through: its Document is filed in a Folder the agent reaches.
- **Unlinked or paused:** while paused, nothing arrives. Unlinked, the folder's Documents leave the Library as any Linked folder's do, and the Folder keeps its Notes and is no longer bound; a Folder left holding nothing goes with the folder (#3613). Unlink… stands in Delete's place on its menu.
- **Linked around another:** a folder linked around a Linked folder merges it, and that folder's Folder stays bound to the same folder inside the new one, inside the new Folder when it was at the top level (#3613). A folder inside a Linked folder makes no Folder: its files are in that one's already.
- **Flat:** every file of the folder, at any depth, is filed in its one Folder; a sub-folder is not a sub-Folder. Its folder shows beside a file's name where names repeat.
- **A folder linked before** is bound by a migration (161, #3613) as linking binds one now, keeping every filing the User made; one whose Documents the User had all filed elsewhere is left with filing as one Folder off, so no empty Folder appears.
- **One binding a folder.** Notes stay in the database.
- Stored as `library_groups.bound_folder_id`, the id of the Linked folder's own Folder or one inside it. No foreign key, as everywhere (ADR-0003).

## What this changes

ADR-0012 rejected "Projects as a kind of their own", because two ideas for "where my work lives" are harder to pick up. That stands: a Project is a Folder with one more property, not a second kind. ADR-0012's line is amended to say so. `CONTEXT.md` no longer avoids "project": it is the word for a Folder bound to a folder on disk, and only for that, in the code and in what agents are told.

The amendment of 2026-11-22 (#3613) goes further the same way: with linking making the Folder, there is one list of Folders and no list of folders on disk beside it, no "Make it a project" step, and no "read-only" label, the promise that IncarnaMind never changes, moves or deletes the files already there (ADR-0010) being said once, as the folder is linked and in its Folder's details. ADR-0010 still holds; its considered option against "Folders and Linked folders in one tree" is amended there.

## Not decided here

- A folder's sub-folders as sub-Folders, mirrored as on disk (#3635).
- Notes written into the folder as files.
- Choosing the bound Folder from where an agent runs, and a harness command that makes one. Where an agent says it is working may narrow its reach, never widen it.
- A Citation that points outside the bound Folder.
