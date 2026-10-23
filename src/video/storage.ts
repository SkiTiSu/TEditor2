import { validateProject } from './model';
import type { VideoProject } from './types';

let opened: Promise<IDBDatabase> | undefined;
function database(): Promise<IDBDatabase> {
  return (opened ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('teditor-video-local', 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts');
      if (!db.objectStoreNames.contains('media')) db.createObjectStore('media');
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => {
        request.result.close();
        opened = undefined;
      };
      resolve(request.result);
    };
    request.onerror = () => {
      opened = undefined;
      reject(request.error ?? new Error('无法打开视频素材库'));
    };
    request.onblocked = () => {
      opened = undefined;
      reject(new Error('视频素材库被其他页面占用，请关闭旧页面后重试'));
    };
  }));
}
async function write(store: string, key: string, value?: unknown, remove = false) {
  const db = await database();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    if (remove) tx.objectStore(store).delete(key);
    else tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('视频素材保存失败'));
  });
}
async function read<T>(store: string, key: string): Promise<T | undefined> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function saveVideoDraft(project: VideoProject): Promise<void> {
  const valid = validateProject(project);
  await write('drafts', 'current', valid);
}
export async function readVideoDraft(): Promise<VideoProject | undefined> {
  const draft = await read<VideoProject>('drafts', 'current');
  return draft ? validateProject(draft) : undefined;
}
export async function putMediaFile(assetId: string, file: File): Promise<void> {
  if (!assetId || !(file instanceof File)) throw new Error('素材 ID 或文件无效');
  await write('media', assetId, file);
}
export const getMediaFile = (assetId: string) => read<File>('media', assetId);
export const deleteMediaFile = (assetId: string) => write('media', assetId, undefined, true);
export async function readMediaFiles(): Promise<Map<string, File>> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const result = new Map<string, File>();
    const request = db.transaction('media').objectStore('media').openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        result.set(String(cursor.key), cursor.value);
        cursor.continue();
      } else resolve(result);
    };
    request.onerror = () => reject(request.error);
  });
}
