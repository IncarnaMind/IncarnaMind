export async function drain<T>(stream: ReadableStream<T>) {
  const reader = stream.getReader();
  try {
    while (!(await reader.read()).done) {}
  } finally {
    reader.releaseLock();
  }
}
