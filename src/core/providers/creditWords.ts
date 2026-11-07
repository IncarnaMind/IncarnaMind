/**
 * What providers say when the account has no credit left: Anthropic's 400, OpenAI's and Kimi's
 * 429, DeepSeek's and OpenRouter's 402, xAI's 403, and Zhipu's and Alibaba's by Chinese words or
 * code. Apart from ./providerErrors, so the transcription process reads it without the AI SDK.
 */
export const OUT_OF_CREDIT =
  /credit balance is too low|insufficient[_ ](?:balance|credits?|funds|quota)|exceeded[_ ]current[_ ]quota|billing[_ ]hard[_ ]limit|out of (?:credits?|balance)|used all (?:of )?(?:its |your )?available credits|(?:add|purchase) more credits|balance (?:is |has )?(?:too low|insufficient|exhausted|not enough)|arrearage|余额不足|欠费/i;
