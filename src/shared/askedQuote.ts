/** The keys a Question's quotes are told apart by, in the core and the renderer alike (#118). */
export const quoteKey = (quote: { documentId: string; location: unknown; quote: string }): string =>
  `${quote.documentId}:${JSON.stringify(quote.location)}:${quote.quote}`;

/** A picture a Question carries: a data URL of one of the types the models read. */
export const PICTURE_DATA_URL = /^data:(image\/(?:png|jpeg|gif|webp));base64,([\s\S]+)$/;
