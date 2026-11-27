/** The `EditCause.requestId` carrying an outside agent's immediate change to its own Note (#3839). */
export const agentOwnChangeRequestId = (mindId: string): string => `agent-own:${mindId}`;
