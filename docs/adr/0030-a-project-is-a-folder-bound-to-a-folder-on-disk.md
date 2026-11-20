---
status: accepted (2026-11-20)
---

# A Project is a Folder bound to a folder on disk

A User's piece of work often lives in a folder on their computer, and the AI agent they run works in that folder. Today the two don't meet. A Linked folder's Documents are in no Folder until the User files each one. So an agent given a Folder doesn't reach the files in the folder it works in, a new file lands in Not in a Folder, and a file the agent hands over from there is refused (#3499).

## Decision

An in-app Folder may be **bound** to one folder on disk: a Linked folder, or a folder inside one. In the interface it is a **Project** (项目), the owner's word. Binding is the only new idea: the Project stays a Folder, and the folder stays a Linked folder. The interface for it is minimal: one item on a Linked folder's menu makes one, and it shows wherever a Folder shows, as a Folder.

- **Its files are filed in it as they arrive.** A Document under the bound folder that has no filing of its own is filed in the bound Folder, as the User's own choice, when the scan adds it or a file moves in. Binding files the Documents already there that have none. Organize leaves these filings alone, as it leaves any filing of the User's. A Document the User files elsewhere by hand stays where they put it. A folder bound inside a larger bound one takes its own files. Nothing rewrites a filing that already exists.
- **It keeps its work inside it by default** (the existing work wall), which the User can turn off.
- **Reach is unchanged.** An agent given the bound Folder reaches its Documents because they are filed in it. Reach is still a Folder id, and every check made after a wait stays as it is. A hand-over from the bound folder goes through: its Document is filed in a Folder the agent reaches.
- **Unlinked or paused:** while paused, nothing arrives. Unlinked, the folder's Documents leave the Library as any Linked folder's do, and the Folder keeps its Notes and is no longer bound.
- **One binding a folder,** made once by the User in the app. Notes stay in the database.
- Stored as `library_groups.bound_folder_id`, the id of the Linked folder's own Folder or one inside it. No foreign key, as everywhere (ADR-0003).

## What this changes

ADR-0012 rejected "Projects as a kind of their own", because two ideas for "where my work lives" are harder to pick up. That stands: a Project is a Folder with one more property, not a second kind. ADR-0012's line is amended to say so. `CONTEXT.md` no longer avoids "project": it is the word for a Folder bound to a folder on disk, and only for that.

## Not decided here

- Notes written into the folder as files.
- Choosing the bound Folder from where an agent runs, and a harness command that makes one. Where an agent says it is working may narrow its reach, never widen it.
- A Citation that points outside the bound Folder.
