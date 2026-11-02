/** The technical detail of unread page content, including scanned pages, form fields and a picture, in English, for logs and tooltips. */
export const unreadMessage = (unread: {
  pages: number[];
  message: string;
  forms?: true;
  picture?: true;
}) =>
  unread.forms
    ? unread.message
    : unread.picture
      ? `The picture couldn't be read${unread.message ? `: ${unread.message}` : "."}`
      : `Scanned ${unread.pages.length === 1 ? "page" : "pages"} ${unread.pages.join(", ")} couldn't be read${unread.message ? `: ${unread.message}` : "."}`;
