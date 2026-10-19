// Screenshots wait here until Send: session storage holds about 10 MB, which
// three Retina shots fill.

const STORE = "images";

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("tori", 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

async function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const conn = await db();
  return new Promise((resolve, reject) => {
    const request = work(conn.transaction(STORE, mode).objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).finally(() => conn.close()) as Promise<T>;
}

export const putImage = (key: string, blob: Blob) => run("readwrite", (s) => s.put(blob, key));

export const getImage = (key: string) => run<Blob | undefined>("readonly", (s) => s.get(key));

export const dropImages = (tabId: number) =>
  run("readwrite", (s) => s.delete(IDBKeyRange.bound(`${tabId}:`, `${tabId}:￿`)));
