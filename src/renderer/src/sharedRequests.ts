/**
 * Requests that callers asking the same thing at the same moment share: each key has one request
 * while it is in flight, and the next ask after it settles makes a new one.
 */
export function sharedRequests<T>(): (key: string, ask: () => Promise<T>) => Promise<T> {
  const asking = new Map<string, Promise<T>>();
  return (key, ask) => {
    const known = asking.get(key);
    if (known) return known;
    const request = ask().finally(() => {
      if (asking.get(key) === request) asking.delete(key);
    });
    asking.set(key, request);
    return request;
  };
}
