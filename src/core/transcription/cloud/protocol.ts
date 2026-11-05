export const QWEN_REALTIME_PATH = "/api-ws/v1/inference";
/** The socket's close code when the handshake was refused for the key. */
export const HANDSHAKE_REFUSED = 4401;
/** The socket's close code when the handshake was refused because the account has no credit. */
export const HANDSHAKE_NO_CREDIT = 4402;

export const DEEPGRAM_URL = "wss://api.deepgram.com/v1/listen";
/** Deepgram's own servers, its regions' (api.eu.deepgram.com) among them. */
export const isDeepgramHost = (hostname: string) =>
  hostname === "deepgram.com" || hostname.endsWith(".deepgram.com");
export const DEEPGRAM_MODEL = "nova-3";
export const ASSEMBLYAI_MODEL = "universal-3-6-pro";
export const GEMINI_LIVE_MODEL = "gemini-3.8-live";
