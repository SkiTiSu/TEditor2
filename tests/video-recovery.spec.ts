import { expect, test, type Page } from '@playwright/test';

async function readRawDraft(page: Page) {
  return page.evaluate(
    () =>
      new Promise<unknown>((resolve, reject) => {
        const opening = indexedDB.open('teditor-video-local', 1);
        opening.onerror = () => reject(opening.error);
        opening.onsuccess = () => {
          const db = opening.result;
          const tx = db.transaction('drafts');
          const request = tx.objectStore('drafts').get('current');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
          tx.oncomplete = tx.onabort = () => db.close();
        };
      }),
  );
}

test('failed video draft recovery preserves the original until an explicit new project resumes autosave', async ({
  page,
}) => {
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto('/');
  await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true');
  const damaged = {
    format: 'teditor-video',
    version: 99,
    id: 'preserve-original-draft',
    name: '待恢复的重要工程',
    retainedPayload: { clips: ['unrecognized-but-not-discardable'] },
  };
  await page.evaluate(
    (draft) =>
      new Promise<void>((resolve, reject) => {
        const opening = indexedDB.open('teditor-video-local', 1);
        opening.onupgradeneeded = () => {
          const db = opening.result;
          db.createObjectStore('drafts');
          db.createObjectStore('media');
        };
        opening.onerror = () => reject(opening.error);
        opening.onsuccess = () => {
          const db = opening.result;
          const tx = db.transaction('drafts', 'readwrite');
          tx.objectStore('drafts').put(draft, 'current');
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = tx.onabort = () => {
            db.close();
            reject(tx.error);
          };
        };
      }),
    damaged,
  );
  await page.getByRole('button', { name: '视频剪辑', exact: true }).click();
  const video = page.locator('.video-editor');
  await expect(video).toHaveAttribute('data-ready', 'true');
  await expect(video.locator('.ve-workbar-status')).toContainText('已暂停自动保存');
  // Exercise the real 500 ms autosave window; an immediate read could miss an overwrite.
  await page.waitForTimeout(800);
  expect(await readRawDraft(page)).toEqual(damaged);

  await video.getByRole('button', { name: '新建', exact: true }).click();
  await video.getByLabel('视频工程名称').fill('明确新建后可保存');
  await expect
    .poll(() => readRawDraft(page))
    .toMatchObject({
      format: 'teditor-video',
      version: 1,
      name: '明确新建后可保存',
    });
  const saved = (await readRawDraft(page)) as { id: string; sequences: unknown[] };
  expect(saved.id).not.toBe(damaged.id);
  expect(saved.sequences).toHaveLength(1);
  expect(browserErrors).toEqual([]);
});
