# Consent is given where the User chooses a service

Nothing leaves the computer for a service the User hasn't chosen. The User chooses a service in one place (first-run setup, Settings, connecting a Connector or an agent, the meeting sheet), and that place says, in one line, what will go to it. Choosing is consenting to that. We don't ask again per feature: the flows that send to the chosen chat model (Answers, Edit with AI, checks, suggestions) are covered by choosing it. Two kinds of work are not, and each has its own switch (below).

- **Asked again** only when a flow starts sending a kind of data its line didn't name.
- **Asked in place** for a service the User didn't pick (reference look-up), once, where the feature starts.
- **Tagging and sorting new Documents by themselves are their own switch** (Settings › Tagging): off for a cloud model, on for one on this computer. They send each new Document's name and an excerpt without the User asking, so choosing the chat model does not allow them; turning the switch on does, and records it in Settings › Privacy. This changes the earlier rule, under which choosing the model covered Tags and organization. Organize and Re-tag asked for by hand still go.
- **Page images are their own switch.** Organize reading a scan with no text sends its page pictures, which carry more than the text the chat line names, so choosing the chat model does not allow them: the User allows them per service, in Settings › Privacy or from the Document's Info. This changes the earlier rule, under which choosing the model covered them.
- **Never asked by background work,** which waits and says so.
- **Revocable per flow** in Settings › Privacy, which lists every flow, the service it goes to and when it was allowed.
- **Local mode** sends nothing to any cloud service, whatever was chosen.

Considered: a dialog per flow and service (the previous rule), rejected after persona testing found two or three dialogs in the first minute; one dialog per provider at the first send, rejected because the User has already chosen the provider a moment before and the dialog only repeats it.

## Amendment: choosing a model for Tags turns the switch on (2026-10-31, #2308)

Choosing the model that tags and sorts, where its line says what it sends (first-run setup's "Tags and Folders use …", Settings › Tagging, the Models defaults), is choosing a service for that flow, so it turns **Tag and sort new Documents automatically** on. Choosing the chat model for Answers still doesn't, and the switch stays where the User can turn it off. Before, a User who chose "Tags and Folders use Claude Haiku 5.5" in setup got no Tags at all, every Document "off", with nothing saying why.
