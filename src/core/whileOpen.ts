/**
 * What `waited` resolves with, or nothing ever once `closed()` says the core closed meanwhile: the
 * work that waited goes no further, so it reads no closed database (#2930, #2957). A rejection
 * passes through.
 */
export async function whileOpen<T>(closed: () => boolean, waited: Promise<T>): Promise<T> {
  const value = await waited;
  return closed() ? new Promise<T>(() => {}) : value;
}
