# The app's own links: an id that shows one item, reached through a page of our site

When the User asks their own AI for a Note, a file or a page, the agent writes it into IncarnaMind and replies in its own app. The User wants to get back to it later from that chat (#3534). Asking the agent to open it again already works in every client: `show_citation` shows a Note, a handed-over file or a Canvas by its id. This records the link an agent can also give with its reply: what it looks like, what opening it may do, and how it reaches the app. Other apps will keep these links in chats and notes, so the form doesn't change once shipped.

The scheme is the product's name, `incarnamind`, and is registered with the system. The site the web link goes through is still to be fixed: until its domain is bought and the site is live, no Tool gives out a link, and the app's side only shows what a link handed to it names.

## The link

- **Three kinds, each by its own id:** `incarnamind://note/<id>` for a Note, `incarnamind://file/<id>` for a file an agent handed over, and `incarnamind://canvas/<id>` for a Canvas. The id is the item's own random UUID (AGENTS.md rule 7), in lower case.
- **A handed file's link is the file's, not a version's.** It shows the Note of the file's newest version, so a link given with version 1 still shows the file after version 2 comes.
- **Nothing else in it.** No name, no path, no text of the User's, no query and no fragment, and no verb: a link only shows. A title changes and a path tells where the User keeps things; an id does neither. (Obsidian's `obsidian://open?vault=…&file=…` carries both; DEVONthink's `x-devonthink-item://<UUID>` and Things' `things:///show?id=…` carry only an id.)

## The web link the agent gives

Most of the apps an agent's reply is read in don't open a custom scheme (#3534's findings): Claude's desktop app shows such a link and does nothing, VS Code's chat removes it, and the Codex command line prints it as plain text. Every one of them opens an https link. So the link an agent gives is `https://<our site>/open/#note/<id>` (a file or a Canvas likewise; the site's paths end in a slash). A static page of our site reads the part after `#` in the browser and hands it to the app's own link, which the browser asks once to open.

- **The part after `#` never reaches a server.** The page logs nothing, sets nothing, and loads nothing from anyone else.
- **Where the app isn't there, or the hand-over is refused,** the page says in one line what the link is for and where to get the app.
- **Known limit:** in Claude's desktop app with "open links in browser panel" on, the hand-over is reported to fail.

## What opening it does

- **It shows the item.** IncarnaMind comes to the front, started first if it isn't running, and the item opens in a tab in front, as what an agent makes opens (#3534's first box).
- **That is all it does.** A link never writes, never asks for a permission or a consent, never sends anything anywhere and never starts an AI request.
- **For this computer's User.** It shows an item of the data folder this app holds. The same link on another computer finds no such id and shows nothing. A link is no secret and grants nothing: it can only show an item to whoever already sits at this computer's IncarnaMind.
- **Anything else brings the app forward and stops there.** An id that isn't there (deleted, another computer's), another kind, an id that isn't a UUID, a second path part, a query, a fragment, user info or a port. The link is read as input from outside the app, in one place (`src/shared/appLinks.ts`).

## How it reaches the app

- **macOS:** the system sends the running app an `open-url` event, also when the link starts it. The handler is set before the app is ready, and a link that comes before the first window is shown waits for it.
- **Windows and Linux:** the system starts the app again with the link as an argument. The copy that holds the data folder receives the second start's arguments (`SecondStart`) and reads the link there. A link that starts the app is read from its own arguments.
- **Registration:** `electron-builder.yml`'s `protocols` puts the scheme in macOS's `Info.plist` and in the Linux `.desktop` file's `MimeType` (`x-scheme-handler/incarnamind`, which the .deb installs). Windows' installer registers no scheme, so the app registers it for its user at start (`app.setAsDefaultProtocolClient`), and the uninstaller removes it (`build/installer.nsh`). An AppImage that isn't integrated into the desktop has no `.desktop` file and can't register itself: there a link works once the User has integrated it.

## Considered options

- **The custom-scheme link alone in the agent's reply.** Rejected: dead text in most clients (#3534's findings).
- **No link,** only asking the agent to open it again. Rejected by the owner: the chat history should itself lead back to what was made.
- **A card in the chat with an Open button** (MCP Apps). Not now: only Claude's desktop app renders one from a local server, and its button asks before every link (#3534's research).
- **Names or paths in the link.** Rejected: they break when a Note is renamed, and they put the User's words in every chat the link is pasted into.
- **A verb in the link** (`…://open/note/<id>`). Rejected: a link only ever shows, so a verb invites links that do something else.
- **The version's own id for a handed file.** Rejected: the link given with version 1 would keep showing version 1 after the agent hands over version 2.

## Consequences

- `src/shared/appLinks.ts` makes and reads the links; the scheme is one constant, which a test holds to what the installers register. The core's `showLinked` shows what one names, through the same event box 1 uses (`agents.opened`, in front).
- The main process takes a link from `open-url` and from a start's arguments (`src/main/appLinkInbox.ts`). A link that comes before the app is up waits for it; one naming nothing there only brings the app forward.
- Still to do, once the site's domain is fixed and the site is live:
  - the `/open` page on our site (its pull request waits on the site);
  - the Tools returning the web link, with `docs/privacy.md` and `docs/where-your-data-goes.md` saying what the page does;
  - `docs/agents.md` saying the Tools give one.
