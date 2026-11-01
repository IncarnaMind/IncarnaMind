# IncarnaMind

A notebook where people write Notes and ask Questions that are answered from their own Documents.

## Language

### Notes

**Note**:
A notebook a User writes in: an ordered sequence of Blocks. The code, the data and the APIs keep the name `mind`, and nothing migrates.
_Avoid_: Mind, session, chat

**Block**:
One unit of content in a Note, positioned where the User placed it.
_Avoid_: message

**Your text**:
A Block the User writes, as opposed to one the assistant wrote.
_Avoid_: Note, text block

**Chart**:
A Block in a Note that draws values from a table or from cited figures (a bar, line, pie or scatter chart), each value kept with where it came from and its Citation, so each point can be traced to its source.
_Avoid_: graph, plot, figure (a figure is a number)

**Question**:
What the User asks for an Answer: a Block in a Note, or a message in a Conversation.
_Avoid_: query, prompt

**Answer**:
What is generated in response to exactly one Question, right after it: a Block in a Note, or a message in a Conversation.
_Avoid_: output, response, reply

**Question context**:
What an Answer is generated from: in a Note, every Block above its Question, except the Blocks of your text the User has excluded; in a Conversation, its earlier Questions and Answers, the Note in focus when the Question was asked, the names of the Documents open on screen then, and the words the User selected in Documents to ask about, as each Document has them where they were selected. Plus Passages from the Documents in the Question's Search scope.
_Avoid_: prompt, history

**Search scope**:
The Folders, Tags and individual Documents that a Question's Document search is limited to, resolved when the Question is asked: a Document filed into a Folder since is in it, one filed out is not. A Question in a Folder's Note starts with the Folder as its Search scope while the Folder holds a Document, and with every Document while it holds none; the User can remove the Folder; a Question with no Search scope searches all Documents. The Search scope the User sets in a Note's composer stays with the Note, and checks of its sentences look there too; text added from an Answer brings its Question's Search scope to a Note that has none. A Folder with **Keep this Folder's work inside it** is the exception: its own Notes cannot widen past it, and every other Note leaves its Documents and Notes out, including an All Documents search. Automatic and suggested Organize filings count only once the User accepts them.
_Avoid_: filter, context

### The assistant

**Assistant**:
The one place in each window where the User asks Questions and reads their Answers, beside the Note in focus and outside any tab; it reads that Note and keeps its Conversations as its own history.
_Avoid_: chat panel, thread, copilot, bot

**Conversation**:
The assistant's history of one exchange: its messages, each a Question or an Answer, in order. It belongs to the Folder of the Note its first Question was asked from, or to none; each Question records the Note it was asked from. A Conversation is not a Note: it is listed only in the assistant's History, never in the sidebar or a tab, and exists once it has a Question. New chat starts one. A Conversation follows the User between Notes, but it never carries earlier turns across a work wall.
_Avoid_: chat (except in "New chat"), thread, session

### Documents

**Document**:
A file the User keeps, in a Linked folder or added on its own, that IncarnaMind has indexed for Answers to draw on, or a Web page. A file stays where the User keeps it; IncarnaMind keeps the text it read from it. A Web page's snapshot is kept in IncarnaMind's data folder. A Document is known by its Linked folder and its path inside it, or as a file of its own, never by where it is on one computer, so it stays the same Document when its Linked folder moves or is on another of the User's computers. Each version of its file is known by its content. The same file in two places is two Documents.
_Avoid_: file, doc, source

**Web page**:
A Document saved from a web address: a snapshot of the page's readable text, fetched from the User's computer when it is added (by the User, or by an Answer that read it in a web search), and again only when the User asks. Its Citations point at the snapshot, never at the live page, so they can always be checked.
_Avoid_: link, bookmark, clipping

**Missing Document**:
A Document whose file was removed while its folder is still there. New searches leave it out; its text, and the Citations that quote it, remain.
_Avoid_: deleted, broken

**Unavailable Document**:
A Document whose Linked folder can't be reached for now, such as on an unplugged drive. It is still searched, from its stored text; only its file can't be opened.
_Avoid_: offline, missing

**Scanned page**:
A page of a PDF that is a picture of text, such as a scan, with little or no text of its own. IncarnaMind reads its text from the picture on the User's computer (text recognition, also called OCR) and keeps it as the page's text, so it is searched and cited like any other page; a Citation of it says its text was read from a scan.
_Avoid_: image page, OCR page

**Linked folder**:
A folder on the User's computer that IncarnaMind reads where it is: every supported file in it, at any depth, is a Document, and new and changed files are read as they come; a file removed from it keeps what was read of it, as a Missing Document does. Nothing is copied to a cloud; IncarnaMind keeps the text it read from each file, and the picture of a Cited page, as it does for any Document. IncarnaMind never changes or deletes a file in it, and adds a new file there only once the User allows it for that folder. Files a cloud drive keeps online only are read when the User asks. Moved, renamed or on another computer, it is located again from its menu and keeps its Documents.
_Avoid_: workspace, vault, source, sync folder

**Other Documents**:
The Documents added on their own, outside any Linked folder.
_Avoid_: loose files, imports

**Passage**:
A short span of a Document that can be retrieved and cited.
_Avoid_: chunk, snippet

**Own workings**:
A Document the User marks with "Don't cite this Document", such as a spreadsheet of figures copied from a report, with their own ratios. It is still searched and read to understand a Question, but an Answer never cites it and no check uses it as evidence, so it can't corroborate the report it was copied from. A check that finds only an own working file stating a claim says so. The interface says "Not cited" beside its name.
_Avoid_: private Document, hidden Document, excluded Document

**Citation**:
A reference, anchored in the text of an Answer, to the Passage a claim was drawn from: the Location it cites, and a quote from the Passage that is checked against the text at that Location. Copied into your text, it stays a Citation; Question context shows it as a reference to its Document with an id, by which an Answer keeps it as the same Citation. It names its Document as the Document is named now, so a rename shows in every Citation of it, on screen, in exports and in what a model or an outside agent reads; the name it was made with is kept, never rewritten, and shown only when the Document can't be found. A History comparison keeps each Checkpoint's own names.
_Avoid_: source, reference

**Calculated figure**:
A number in an Answer or in your text that IncarnaMind worked out from numbers quoted from Documents, by a formula (or, later, an Analysis), rather than the AI working it out itself. It keeps its Inputs, each with its Citation, its formula and its result as shown. The AI writes a marker where it goes and never the number; the interface says "Calculated".
_Avoid_: computed figure, calculated citation, derived number, formula

**Figure schedule**:
The figures shown in a Note, each beside its source value, Citation, difference and result from the Note's one Check; calculated figures can be opened to see their Inputs, and totals show whether their parts add up.
_Avoid_: second check, audit table

**Input**:
A number a Calculated figure or an Analysis is worked out from: a number in a Citation's quote (with the line that states its scale or currency when the number has none of its own), a cell of a sheet (the number it stores, not the one it shows rounded), or a range of a sheet or CSV, in the version of its Document it was read from.
_Avoid_: argument, variable, source

**Footnote**:
Text the User attaches to a point in the text, shown there by its number; it can hold Citations. Footnotes and Citations share one numbering, in the order they appear, in the Note and in every export, where a Citation's footnote is its reference.
_Avoid_: endnote, annotation, comment

**Reference record**:
What a citation style needs to cite a Document: its type, title, authors, date, where it was published, volume, issue, pages, publisher, DOI, URL and language. It is read from the Document's file (its properties, and what a PDF's first page prints: title, authors, institution and year), the User can edit every field (an edit is never replaced by a later read), and Look up can fill its empty fields from the Document's DOI or arXiv ID. What was read from the file "needs checking" until the User marks it checked or edits it. A record of a known type that lacks its title, authors or date "needs details". A file exported from Zotero, EndNote or Mendeley (CSL JSON, BibTeX or RIS) can be imported: each reference is matched to a Document, or kept as a record with no Document until its PDF is added; the User's edits win over an import.
_Avoid_: metadata, bibliographic entry, citation (a Citation is the reference in an Answer)

**Citation style**:
How a Note's Citations read, in its text and its exports, and how its Bibliography lists their Documents: any style of the Citation Style Language's repository, such as APA 7, IEEE, Nature or GB/T 7714—2015, or a journal's, which formats as the style it follows, written from the Documents' reference records, or Numbered, IncarnaMind's own (numbered markers, each a footnote naming its Document and Location). Each Note has one; one that hasn't chosen is Numbered, or GB/T 7714—2015 when the interface and the Note are in Chinese and it cites a paper or a book, and a new Note starts in the style last chosen for a Note in its Folder. A style changes how a Citation reads, never its check.
_Avoid_: citation format, reference style

**Bibliography**:
Every Document a Note cites, once each, in its citation style: the References at the Note's end, kept up to date, and the end of its exports. A Note in Numbered shows none. A Document whose reference record is too thin to cite is listed by its name in the Note, marked "needs details"; an export writes the details it has, never a placeholder, and the Saved line counts the Documents that lack authors or dates.
_Avoid_: works cited (except as a style's own heading), sources list

**Source provider**:
A public service that Find sources searches for works to add to the Library: OpenAlex, arXiv and PubMed (Crossref looks a DOI up); openFDA and DailyMed for drug labels, ClinicalTrials.gov for trials and the eCFR for US federal regulations, which are asked only when the User chooses them; GovInfo looks up the US Code and the CFR's official edition by citation, on the User's own key; later, services for other countries' laws and for company filings. A work with an open-access copy is added as a Document, which keeps the provider it came from and the date of the version it holds; any other work, as its Reference record alone. Each Source provider is asked once for consent before anything is sent to it.
_Avoid_: source (a Document is not one), database, provider on its own (an AI model's provider)

**Location**:
Where in a Document a Citation points, in the unit the Document's own readers use: one or two pages of a PDF (named as the page names itself, by its page label or the number printed on it, with its place in the PDF beside it when they differ: "p. 68 · page 69 of the PDF"), one or two slides of a deck (speaker notes count as part of their slide), a sheet and a range of rows of a spreadsheet, the section a quote sits under in a Word file or Markdown (for a quote of a Word comment, the section the comment is anchored in, and that it is a comment by its author), the section and paragraphs of a Web page, a range of lines in plain text, or a range of time in a Transcript (shown as the time the quote starts, "14:26").
_Avoid_: page (for anything that isn't a PDF), position, anchor

**Cited page**:
How a Citation's Location looked in the version it quotes, saved as a picture when the Citation is made, with the text drawn on it, so the quote can be shown where it stood after its file changes or goes. It is kept while a Citation or a Checkpoint points at it, and is never searched.
_Avoid_: screenshot, thumbnail, preview

**Source pack**:
A PDF of the pages a Note cites, made from Export options: a cover list, then one page for each cited Location, drawn from its cited page, with each quote highlighted and numbered as the Note numbers its Citations. It is made from the cited pages, so it holds when a file has changed or gone.
_Avoid_: evidence bundle, appendix, bundle

**Folder**:
A project inside IncarnaMind: a named place for Documents and Notes, with a description of what belongs there. Each Document and each Note belongs to one Folder or is Not in a Folder; this does not change where a Document's original file is stored. A Note in a Folder searches the Folder by default; deleting a Folder moves its Documents and Notes to Not in a Folder. **Keep this Folder's work inside it** adds a work wall: its Notes use only its Documents, and other Notes do not search them, while the Library, Search and ⌘K still show and open everything.
_Avoid_: project (in the interface), group (a Folder's former name; a Group is now a column of tabs), collection, category

**Not in a Folder**:
The one place for every Document and Note in no Folder. A Note there searches every Document except those inside a work wall.
_Avoid_: Unsorted, Uncategorised, Inbox

**Suggested Folder**:
A Folder that Organize proposes for a Document, which waits for the User to accept it (it becomes the User's choice) or reject it (the Document stays Not in a Folder and that Folder isn't suggested for it again). While it waits, the Document counts as in that Folder, for listings and for the Folder's Search scope, marked as a suggestion.
_Avoid_: automatic Folder, proposed Folder

**To review**:
The Library's view of what Organize suggested and the User hasn't accepted yet: the Documents waiting in a Suggested Folder, listed by that Folder, each to accept, move to another Folder or turn down ("Not this Folder"). It is the first section of the Library page while anything waits, with how many, and goes when nothing does.
_Avoid_: inbox, queue, pending

**Source location**:
The original file or Linked folder from which IncarnaMind reads Documents. Its folders mirror the disk and are independent of the Folders used to organise Documents inside IncarnaMind; the sidebar lists them as Folders on disk.

**Tag**:
A label with a short description that a Document can carry. A Document can have many Tags. IncarnaMind applies Tags automatically, and the User can add or remove them.
_Avoid_: category, label, class

**Topic**:
The earlier design for a generated two-level subject tree. The current Library uses flat Folders instead (direction revised 2026-10-08), and the dormant Topic code was removed on 2026-10-10 (ADR-0012).
_Avoid_: cluster, category, collection, group

**Library**:
The view of all of a User's Documents, organised into Folders with visible Tags. Users can search names or Tags, manage Folders, and organise Documents automatically or correct them by hand; manual choices are kept.
_Avoid_: archive, index, vault

**Peek**:
A quick preview of a Document beside the list, opened with Space on its row in the sidebar or the Library, without opening the viewer: its first page, slide or sheet drawn small, its facts, and its Tags and Folder, which can be changed there. ↑ and ↓ move it to the next or previous Document; Space or Esc closes it, and Enter opens the Document in the viewer. It floats over the window and never replaces the Note.
_Avoid_: Quick Look, preview (a preview Tab is another thing), hover card

### Tools

**Tool**:
A single action an Answer can call while it is being generated, provided by Document search, a Connector or a Skill.
_Avoid_: function, action

**Effect**:
What a Tool call can do beyond the conversation it is part of: read data, write (change something), run code on a computer, or send data over the network, and where (some of the User's folders, a web host, a Connector's service, the Documents, a Note). Whether a call asks the User first depends on its Effects.
_Avoid_: permission, capability, side effect

**Analysis**:
Python an Answer wrote and IncarnaMind ran in its sandbox, with no network or files, over Inputs cited from Documents, kept in a Note with its steps, Inputs, code and results.
_Avoid_: notebook, script, code interpreter (in the interface), Skill script

**Third-party text**:
Text someone other than the User wrote that a Run reads: a saved Web page, the document being checked, or text in a Note or Conversation that came from them (imported from someone else's file, a quote added from a Web page, or an Answer written from such text). Once a Run has read some, a call that writes or sends data asks even where the User chose "always". The User's other Documents don't count, though their text is untrusted too, and neither does text pasted from other apps, which can't be traced.
_Avoid_: external content, untrusted content (which also covers the User's own Documents)

**Connector**:
An external service the User has connected, through which Answers can look things up or make changes.
_Avoid_: MCP server, plugin, integration, connection

**Web search**:
Searching the web from an Answer, through the provider of the model it is asked with, when the User has turned it on and the Question asks for the web. Each page the Answer reads is saved as a Web page and cited like any Document; a page it didn't read is never cited.
_Avoid_: browsing, grounding, online mode

**Skill**:
A packaged description of how to do a particular task, optionally with reference files and scripts, that an Answer can follow.
_Avoid_: plugin, command

**Skill script**:
A script that comes with a Skill, which an Answer can run on the User's computer with the User's approval.
_Avoid_: tool script, code execution

**Outside agent**:
An AI agent the User runs themselves, such as Claude Code or Codex, connected to IncarnaMind so it can search and read the Folders the User shares with it (or the Documents in no Folder at the time of each call) and cite them with Citations IncarnaMind checks. The User connects each one in Settings, with its own Folders (none until chosen), its own consent and a list of every call it made; disconnecting it stops it at once, and Local mode pauses it. Where the agent reads Skills, connecting it also installs a Skill in the agent's own skills folder that tells it when to use IncarnaMind, and disconnecting removes it if the User hasn't changed it.
_Avoid_: harness, plugin, client, bot

**Built-in Skill**:
A Skill that ships with IncarnaMind and is updated with it: summarise a Document, a literature review across Documents, a Note to report, a covenant summary, CIM red flags, an earnings review, a credit memo outline, a deposition summary and a chronology. The User can turn one off, remove it and restore it, or duplicate it as their own, but not change it.
_Avoid_: default Skill, system Skill

### Changes

**Proposal**:
A change to a Note, made by the AI or brought in from another person's Word file, that waits for the User to accept or reject it. Until it is accepted it does not count as part of the Note, though the assistant reads every one as a change (the AI's as waiting, another person's with who made each) and exports show another person's, and it is out of date once the text it changes has changed. The assistant revises its own while they wait, rather than adding a second version. Each Proposal is one change in one place (the words it removes and those it adds there, or a whole Block), accepted or rejected on its own; one request, such as an Edit with AI, can make several. The interface calls them changes: "3 changes waiting".
_Avoid_: suggestion, edit, draft, diff

**AI text**:
The words the AI wrote into a Note that the User hasn't made their own: in Answers, Answers added to a note, accepted changes and accepted suggestions. They are drawn a step softer than the User's writing. What the User types, even inside AI text, is theirs, and "Mark as mine" makes selected AI text theirs. Exports and Question context read it as any other text; a Word export can mark it with a comment.
_Avoid_: AI content, machine text

**Checkpoint**:
A saved copy of a Note as it was just before an AI change, or after a pause in writing, which the User can compare, in the Note's History, with another Checkpoint or with the Note now, and restore from. Restoring one brings its content back as a new change, after a Checkpoint of the Note as it is: nothing is overwritten, and Undo takes it back.
_Avoid_: snapshot, version, backup, undo

**Recently deleted**:
Where a deleted Note, Conversation, Document, Folder or Tag waits for 30 days, from where it can be restored or deleted permanently. Deleting never touches the User's files.
_Avoid_: trash, bin, archive

**Undo line**:
The one short line that says what the User just changed, with Undo, shown after any change that can be taken back: "Moved 3 Documents to Finance · Undo". Its Undo does what ⌘Z does.
_Avoid_: toast, snackbar, notification

### Checks

**Record cite**:
A reference in legal writing to a Document in the record and the exact place it names: a deposition's page and lines, an exhibit's or a docket entry's page, a Bates number, a numbered paragraph or a recording's time, and the `Id.` and `supra` that refer back to one. A record-cite check reads exactly that Passage and gives the cite its own result (Supported, Partly, Unsupported, Choose, Not found or Not checked), apart from the sentence's overall result.
_Avoid_: legal citation (a Citation is the general object in a Note), source

**Citation check**:
The test of whether a Citation's quote is found in the text at its Location, and of whether the words its sentence puts in quotation marks (at least 4 words, or 6 characters in Chinese or Japanese) are found in the text at the Locations the sentence cites. Its only failing result is quote not found.
_Avoid_: validation, verification

**Calculation check**:
The test of whether a Calculated figure still holds: each Input's quote is found at its Location and reads as the same number, and the formula gives the same result. Its failing results are an Input not found and needs re-check. It says nothing about whether the right numbers were used, and never that a figure is correct.
_Avoid_: verification, validation

**Unchecked figure**:
A number in an Answer that is neither in a quote of its sentence's Citations nor a Calculated figure: the AI worked it out or wrote it without a source. It is marked as quietly as a sentence without a Citation.
_Avoid_: hallucinated number, unsupported (a claim check's result)

**Quote not found**:
The result of a Citation check when the Citation's quote, or words its sentence puts in quotation marks, are not in the text at its Location. It says nothing about whether the claim is true. The interface always says what wasn't found: "Quote not found" (未找到引文) on a Citation's card, "1 Citation not found" (1 处引用未找到) in the Note's health. "Not found" alone is a sentence's (Not found).
_Avoid_: broken, invalid, failed

**Unsupported**:
The result for a sentence when Check against Documents, Verify or note health finds nothing in the Documents that backs it up. It is not a finding that the sentence is wrong. Its card is headed Unsupported when the check found a Passage about the sentence that doesn't back it: one that says something different, states only part of it, or names another party, period or duty. When nothing in the scope is about the sentence, the card is headed Not found instead. A sentence that cites a court decision none of the Documents holds is unsupported too, and its card says the case can't be checked here.
_Avoid_: unverified, false

**Not found**:
The heading of an unsupported sentence's card when nothing in the check's scope is about the sentence, after the check searched a second time with other words: "I didn't find this in “{scope}”" (未在“{scope}”中找到). It is a fact about the search, never a finding that the sentence is wrong. Once the check finds a Passage about the sentence that doesn't back it, the card says Unsupported. The mark is the same amber "!", and the Note's health counts both as need a look. Not the same as Quote not found, which is about a Citation's quote.
_Avoid_: nothing says this, missing, not in your Documents

**Contradicted**:
The result for a sentence when Verify or contradiction watch finds a Passage that says the opposite. It is not the same as unsupported, where nothing is found either way.
_Avoid_: wrong, conflict, false

**Not examined**:
A sentence the last whole-Note check couldn't tell makes a claim: the model said nothing of it, even asked once more about the sentences its reply left out. It isn't taken for a sentence that makes no claim: it stays to check, and the next Check asks about it again. The line under the check says how many: "1 sentence not examined" (1 句未能判断是否为说法).
_Avoid_: skipped, left out (an opinion is left out), not checked (a claim whose check failed)

**Part**:
One piece of a sentence that a reader can check on its own: a fact, or the writer's own opinion. A sentence's check keeps its parts in order under its one Mark; the sentence is supported only when every factual part is, and its worst part's result is the sentence's. A view the sentence gives to someone else ("The minister said…") is a fact about who said it. A number inside the writer's opinion is a fact inside that opinion, which stays one part. The card shows a row for each part, and Covers counts a quantified part's members ("Covers 3 of the 4 quarters", 覆盖 4 项中的 3 项). Counted with 处 in Chinese.
_Avoid_: chunk, clause, segment

**Opinion left out**:
The writer's own view in a sentence, which a check doesn't judge: a whole sentence that is one has no Mark, and a mixed sentence's opinion part keeps its row. The check's line counts each once: "3 opinions left out · Show" (3 处观点未纳入核对 · 查看), and Check anyway (仍然核对) checks that part alone. Never "Not checked", which is a claim whose check failed.
_Avoid_: skipped, not checked, ignored

**Needs re-check**:
A check result whose sentence, evidence or scope has changed since it was made, so it is no longer known to hold.
_Avoid_: stale, outdated, expired

**Mark**:
The small sign beside a sentence that shows its check result: found, quote not found, unsupported or contradicted. In a Meeting, a Mark is also a flag the User sets at a moment in the Transcript.
_Avoid_: badge, flag, tick

### Tasks

**Run**:
One go of the Tool-calling loop, with its instructions, Tools and model. An Answer is one kind of Run; a Task is another.
_Avoid_: job, execution, session

**Task**:
A Run that goes on in the background, keeps its place if IncarnaMind is quit, and can be steered, paused or scheduled. Its results come back as Proposals or as new Documents.
_Avoid_: job, agent, process, background Answer

**Comparison table**:
A table in a Note with one Document in each row and one Question in each column, whose cells are cited Answers. The command that builds one is Compare Documents.
_Avoid_: grid, spreadsheet

**Memory**:
What IncarnaMind has been asked to remember about the User, kept only when the User says so and open to read, change and delete.
_Avoid_: history, profile, learned preferences

### Cost

**Monthly cap**:
The most IncarnaMind may spend in a calendar month on the models the User pays for by the token, on their own keys; off until the User sets it. A request that could pass it isn't sent, and a run it stops says so.
_Avoid_: budget, quota, spending limit

**Plan**:
A subscription the User signs in with, such as ChatGPT Plus, whose own limits apply instead of a price. A plan's limit stops a run as the monthly cap does.
_Avoid_: subscription key, membership

### Meetings

**Meeting**:
A conversation the User records with the microphone and the computer's sound, which becomes a Transcript and the Note written during it; the help panel beside it is Call help.
_Avoid_: recording, session

**Voice memo**:
What the User records alone, with the microphone, to think out loud: recorded and transcribed as a Meeting is, without a call's parts (the computer's sound, Speakers, help during the call). After Stop, the speech is written into a Note as one change: a title line that names the Note, then that speech tidied into paragraphs in the User's own words, nothing added, each citing its time in the Transcript; with no model to tidy it, the Transcript as it is.
_Avoid_: dictation, voice note, audio note, recording

**Transcript**:
The words of a Meeting, in order and with times, kept as a Document in the Library so that a Citation can point at it; its file is IncarnaMind's own, inside the data folder, never one the User keeps. A `.vtt` file the User adds is their own file, as any Document is. Its Location is a range of time.
_Avoid_: captions, subtitles, minutes

**Speaker**:
A person in a Transcript who is told apart from the others. A Speaker is named by the User, and a Citation to a Transcript names who said the quote. Before that, a live Meeting's lines are "Me" (the microphone) or "Them" (the computer's sound), or "Speaker ?" with no computer sound. After the call, the speaker pass numbers several voices "Speaker 1, 2…"; one other voice stays "Them", and "Me" stays "Me".
_Avoid_: voice, participant, user

### Files

**Granted folder**:
A folder the User has allowed an Answer or a Task to read, once. It is not a Linked folder: its files do not become Documents unless the User keeps them.
_Avoid_: shared folder, workspace, permission

**Output location**:
The folder the files IncarnaMind creates go in, such as exports and Documents a Task saves. Until the User picks one, it is IncarnaMind in their Documents folder (Documents › IncarnaMind; in Chinese, 文稿 › IncarnaMind on a Mac and 文档 › IncarnaMind on Windows and Linux): the first save goes there without asking and says where. IncarnaMind writes nowhere else without asking: a Linked folder asks first, and if the default can't be made or written to, the save asks where instead.
_Avoid_: export folder, downloads, save path

**Workspace**:
Everything one data folder holds (Notes, Conversations, the Documents' index and settings), known by one random id with no account behind it. A copy of the data folder is the same workspace, and the User's computers will share one when they sync. Not shown to the User.
_Avoid_: account, vault, Library (the view of Documents)

### Privacy

**Usage data**:
Anonymous events about using IncarnaMind, such as "a Question was asked with a local model", sent only while the User agrees, under a random install ID. It never holds a Document's content or name, a Question, an Answer or anything the User typed.
_Avoid_: telemetry, tracking

**AI use record**:
What the AI put into a Note, or proposed and the User turned down, and what became of it (kept, edited, deleted), and each sentence a model checked, kept per Note on this computer. It holds kinds, sizes, the model and times, never text, and is never sent, whatever the User chose about Usage data.
_Avoid_: AI log, AI history

**Check record**:
A PDF or CSV the User saves from a Note, listing each sentence and Citation IncarnaMind checked in it with the result, the Document version (name, size, SHA-256), the Location, the quote, the model and when, and whose text it is. It says what was checked and how, not whether a claim is right, and is written only where the User saves it.
_Avoid_: audit log, report

### Window

**Tab**:
What a Note, the Library or a Document is open in. A preview tab, its title in italics, is replaced by the next Document opened in its group until the User keeps it; a pinned tab stays at the left of its group. Opening something already open goes to its tab, in any group; only Open in a new tab makes a second one.
_Avoid_: pane, page, view

**Group**:
One of up to three columns of tabs side by side in a window, each with its own tab strip; in Chinese, 栏. A narrow window shows its groups merged into one.
_Avoid_: pane, split, column

### People

**User**:
The person using IncarnaMind.
_Avoid_: account, UserAccount
