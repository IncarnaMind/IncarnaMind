/** The technical detail of unread PDF page content, including scanned pages and form fields, in English, for logs and tooltips. */
export const unreadMessage = (unread: { pages: number[]; message: string; forms?: true }) =>
  unread.forms
    ? unread.message
    : `Scanned ${unread.pages.length === 1 ? "page" : "pages"} ${unread.pages.join(", ")} couldn't be read${unread.message ? `: ${unread.message}` : "."}`;
