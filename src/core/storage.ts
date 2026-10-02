import type { TedDocument, TableData } from './types';
export interface Draft {
  document: TedDocument;
  table: TableData;
  name: string;
  row: number;
}
let dbPromise: Promise<IDBDatabase> | undefined;
function database() {
  return (dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open('teditor-local', 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('draft');
      r.result.createObjectStore('assets');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}
export async function saveDraft(draft: Draft) {
  const db = await database();
  return new Promise<void>((resolve, reject) => {
    const t = db.transaction('draft', 'readwrite');
    t.objectStore('draft').put(draft, 'current');
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}
export async function readDraft(): Promise<Draft | undefined> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const r = db.transaction('draft').objectStore('draft').get('current');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function saveAssets(files: Map<string, File>) {
  const db = await database();
  return new Promise<void>((resolve, reject) => {
    const t = db.transaction('assets', 'readwrite');
    const s = t.objectStore('assets');
    s.clear();
    for (const [path, file] of files) s.put(file, path);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}
export async function readAssets(): Promise<Map<string, File>> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const result = new Map<string, File>();
    const r = db.transaction('assets').objectStore('assets').openCursor();
    r.onsuccess = () => {
      const c = r.result;
      if (c) {
        result.set(String(c.key), c.value);
        c.continue();
      } else resolve(result);
    };
    r.onerror = () => reject(r.error);
  });
}
