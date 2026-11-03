# Interaction rules

Read this before building or changing any UI, whether you are a person or a coding agent. It sits beside the visual rules in `DESIGN.md` and the words in [`CONTEXT.md`](../../CONTEXT.md).

**The bar:** IncarnaMind should be easy to use and easy to pick up. "Simple" means a first-time User gets what they came for without learning the app or reading help. It doesn't mean fewer features. If a screen needs explaining, it isn't done.

## The rules

Each rule has a check a reviewer can apply. A UI change that breaks a rule says why in its pull request.

0. **Borrow what people already know.** Where Claude, ChatGPT, Cursor, VS Code, Finder, Notion or Granola has a settled way to do something, IncarnaMind does it that way. Chinese Users' apps (Feishu, Yuque, WeChat) count as familiar too. A new gesture needs a reason the familiar one can't serve.
   - Check: the issue or pull request names the app whose convention each gesture follows, or says why none fits. The table below lists the ones already chosen.
1. **Edit in place.** Any name the User sees (a Note, a Conversation, a Document, a Folder, a Tag, a tab) is renamed where it is: double-click it, select it and press F2, or choose Rename from its menu. While renaming, Enter saves, Esc cancels, a blank name changes nothing, and Enter while a Chinese input method is composing never cuts the name off. A double-click renames the item the first click hit, even when that click opened something and moved the list.
   - Check: an end-to-end test renames each object by double-click and by F2, and no dialog opens.
2. **Drag where it makes sense, always with another way.** Documents and Notes drag onto Folders; Documents drag onto Tags and into the composer; files from Finder or Explorer drop onto a Folder, the sidebar or the composer. A target highlights only while it can accept the drop, and the drop says what happened, with Undo. Every drag has a menu item and a key: Move to… (⇧⌘M), Tags….
   - Check: every drag in the change names its menu and keyboard twin.
3. **Keep the User's place.** Nothing replaces the Note the User is in. The Library, a Folder or a Tag opens as a tab; a Document opens beside the Note; Settings opens over it and closes with Esc.
   - Check: no label starts with "Back to". One that does means this rule is broken.
4. **Undo instead of asking.** Anything the User can take back happens at once and offers Undo: ⌘Z / Ctrl+Z, and one short line such as "Moved 3 Documents to Finance · Undo". Deleting a Note, Conversation, Document, Folder or Tag moves it to Recently deleted, where it waits 30 days, with no question asked. Ask first only before something that can't be taken back, and say what will be lost.
   - Making a Note is the one exception, by any way of making one: from ⌘N, a template, a Folder, a Document, an Answer, a table, Record or the AI use statement. It says nothing and leaves no step for ⌘Z, so a habitual ⌘Z never closes the tab; Delete takes it back, with Undo. What a step puts into a Note (an Answer added as changes) is the Note's own to accept or reject.
   - Check: each action in the change is marked reversible (with its undo) or irreversible (with its confirmation text).
   - In a multi-line field a run of typing is one step to undo, as on the computer: use `TypingTextarea`, never a plain `<textarea>` (the linter fails one).
5. **Every object has one right-click menu, in one order.** Open (and Open in new tab), the object's own actions, Move to…, Tags…, Rename, the file's actions (Show in Finder, Copy path), then Delete last, after a separator. The ⋯ button opens the same menu, and each item shows its shortcut.
   - Check: right-click every kind of object the change shows, and compare with this order.
6. **One way to select.** In every list: a click opens, and so does Enter on the focused item; ⌘-click / Ctrl-click adds or removes; Shift-click extends; ⌘A selects everything in view; Esc clears. An action applies to everything selected and says how many ("Delete 3 Documents"). Dragging one of several selected items drags them all.
   - Check: the same selection test passes in the sidebar and the Library.
7. **The keyboard reaches everything, and ⌘K finds it.** Every action works without a mouse and is in ⌘K / Ctrl+K, which also finds any Note, Conversation, Document, Folder or Tag by name (Notes by their contents too), matching pinyin for Chinese names. Arrow keys move through the sidebar. Focus is always visible. Esc closes the innermost thing that's open.
   - Check: every new action has a ⌘K entry and a keyboard path.
8. **Answer at once.** Every action shows its result within 100 ms of the input (p95, on a Library of 2,000 Documents), updating before the core confirms where that's safe and rolling back with a problem line if the core refuses. Anything that takes over a second shows progress where it happens. Nothing freezes the window.
   - Check: the speed test; by hand, nothing waits on a spinner for an action that should be instant.
9. **One way to do each thing, with more behind it.** One primary action per screen and one visible place to add things. Advanced choices live behind ⋯ or in Settings. A new setting needs a reason in the pull request; prefer a good default.
   - Check: the change lists each visible way to reach its action; a second visible way needs a reason.
10. **Say it plainly.** Use the words in `CONTEXT.md`. Say what happened and what the User can do next. A problem stays where it happened, as one line with one action, until the User dismisses it or fixes the cause; it never closes itself, with an action or without one. Only a confirmation ("Copied", "Added to note") goes by itself, after a few seconds. Esc closes either, the newest first. No toast that goes away for an error.
    - A failure with no line of its own shows as a notice (`useNotices().showError`): the core's own sentence, or plain words in both languages when the sentence is the system's own code ("ENOSPC: no space left on device…"), never Electron's "Error invoking remote method…" or a stack, with the technical text, the system's included, under "Details". `describeError` in `src/renderer/src/errors.ts` is the one place that takes it apart; call `reportError`, don't format an error at the call site.
    - A notice is drawn above whatever is open, Settings and every other modal dialog included, readable and dismissable: a native modal makes all else inert, so `ErrorNotices` draws inside the top one (`useTopModal`). A failure that belongs to a field or row in a dialog is a line there, not a notice.
    - Check: the copy reads well in English and Chinese, in `CONTEXT.md`'s words; no line shows an error's wrapping or a stack.
11. **Hold the layout.** Every screen works at every window size the app supports, with and without the viewer open, in English and in Chinese. Text wraps by word, never by letter, and long names truncate with the full name in a tooltip.
    - Check: screenshots at a narrow and a wide window.
12. **Match the prototype's behaviour, not only its picture.** The interactive prototype is the reference for how every screen works. A design board is a still frame: it fixes the looks, never the behaviour. Every UI issue names the prototype flow it implements, and the design boards for the looks.
    - Build what the flow does, step by step: what each click, key, hover and focus move does; what appears, moves or goes away, and when; the empty, loading and error states; and where focus lands after each step.
    - Where the built screen behaves differently from the prototype, say why in the pull request, or fix it.
    - Check: the pull request has a short recording of the flow in the built app beside the same flow in the prototype, with the mouse and the keyboard, and every difference listed.
13. **Use the shared building blocks.** Selection, drag and drop, undo, the right-click menus, rename in place, the command list behind ⌘K and the menus, and optimistic updates each have one shared implementation, so the same gesture does the same thing everywhere. Where a block doesn't exist yet, don't build a one-off: say so in the pull request and keep the current behaviour, or build the block in its own issue.
    - Motion comes from the shared module (`src/renderer/src/motion.ts`) and follows `DESIGN.md` › Motion, Reduced and Off included; no hand-written transitions or animations.
    - Check: code review; no `onContextMenu`, `draggable` or undo handling outside the shared blocks.
14. **Teach in context, not in onboarding.** First run and onboarding cover one thing: getting the User to their first checked Answer. Every other feature is found where it lives:
    - something that looks usable (a grip, a cursor, a chip);
    - its place in the right-click and ⋯ menus;
    - its ⌘K entry;
    - at most one tip, at the moment the feature would help. The tip is one line where the feature is, closed by ✕ or by using the feature, shown at most twice and never again on this device.

    No tours, no coach marks, and no "what's new" pop-ups over the User's work. Tips use the app's one shared tip, not a one-off.
    - Check: the change adds no step to first run or onboarding; any tip names the moment it appears and how it goes away.

## Conventions already chosen

| Task | How IncarnaMind does it | Who does it that way |
|---|---|---|
| Start | A new Note opens with the cursor in its title; New chat (⇧⌘O) starts a Conversation in the assistant's composer, titled from its first Question and renamed in place | Notion, Claude, ChatGPT |
| Ask | One assistant per window, beside the tabs; ⌘J focuses its composer; it reads the Note in focus and searches its Folder | Cursor, Notion AI |
| Find anything | ⌘K searches Notes, Conversations, Documents, Folders and Tags, and runs any action | ChatGPT, Claude, Notion, Linear |
| Open and rename | Click or Enter opens; double-click or F2 renames | Windows Explorer, Notion, Linear, Obsidian |
| Make a Folder | ⇧⌘N makes "Untitled Folder" in the tree with its name field open; ⌃⌘N on macOS (or the selection's menu) makes it with the selected Documents and Notes in it; Enter keeps the name, Esc keeps "Untitled Folder", ⌘Z removes it | Finder, Windows Explorer (Ctrl+Shift+N) |
| Add Documents | ⌘O (Ctrl+O) opens the file picker from a Note, the sidebar and the Library, but not while the focus is in text; the Add menus, the File menu and ⌘K list it, with Link a folder… beside it and no keys | Finder, VS Code |
| File into a Folder | Drag onto the Folder, or Move to… (⇧⌘M) | ChatGPT projects, Notion, Granola, Finder |
| One Folder per Document | A drop on a Folder moves the Document; Tags group Documents across Folders | Finder |
| Tags | Created, renamed, recoloured, merged and deleted in the sidebar's Tags view; a rename applies everywhere | Finder, Bear, Apple Notes |
| Delete | Moves to Recently deleted for 30 days, no question asked | Notion, Granola, Apple Notes, Finder, Feishu |
| Undo | ⌘Z after any change, not only typing | Linear, Things |
| Look inside a file | Space shows a quick preview beside the list; Enter opens it in the viewer | Finder's Quick Look |
| Walk the sidebar | The tree is one Tab stop; ↑ ↓ Home End move, → opens a Folder or steps into it, ← closes it or steps out, typing a name's first letters jumps to it, ⌘⌫ (Delete on Windows and Linux) moves to Recently deleted | Finder's list view, Windows Explorer |
| Files dropped on the composer | They become Documents and that Question's scope | Claude, ChatGPT |
| Insert | "/" in the note, matching pinyin for Chinese | Notion, Feishu, Yuque |
| Changes the AI proposes | Shown as changes in the note; one key accepts all, one rejects all | Cursor, Notion AI |
| Learning a feature | Seen where it lives, in its menu and in ⌘K, with at most one tip when it helps; nothing in onboarding beyond the first checked Answer | Claude, ChatGPT, Linear |

## In an issue that changes UI

Add the interaction checklist from the pull request template to the acceptance criteria. Name the prototype flow the change implements, step by step (rule 12), the design boards for its looks, and the convention each gesture follows (rule 0).

## In a pull request that changes UI

- Tick the interaction checklist in the pull request template.
- Add before and after screenshots, at a narrow and a wide window, in English and Chinese where text changed.
- Record the flow in the built app beside the same flow in the prototype (a short GIF of each), with the mouse and the keyboard, and list every difference in behaviour or looks with its reason.
- Test it like a person: with the mouse and the keyboard, in the built app, not only in unit tests.
- If it changes a flow the feel check covers (`e2e/feel*.spec.ts`), run that spec (testing.md, The feel check).
