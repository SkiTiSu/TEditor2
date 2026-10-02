import { expect, test } from '@playwright/test';
import { createRequire } from 'node:module';

test.beforeEach(async ({ page }) => {
  await page.route('**/assets-test', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Asset integration test</title>',
    }),
  );
  await page.goto('/assets-test');
});

test('relocates Windows paths, prefers exact matches and rejects ambiguous basenames', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const modulePath = '/src/core/assets.ts';
    const { AssetStore } = await import(modulePath);
    const store = new AssetStore();
    const file = (path: string) => {
      const f = new File(['x'], path.split('/').at(-1)!);
      Object.defineProperty(f, 'webkitRelativePath', { value: path });
      return f;
    };
    const portrait = file('素材/avatars/01.PNG'),
      other = file('素材/team/01.PNG'),
      unique = file('素材/backgrounds/bg.png');
    store.add([portrait, other, unique]);
    const relative = store.find('avatars/01.PNG') === portrait;
    const absolute = store.find('D:\\旧项目\\素材\\avatars\\01.PNG') === portrait;
    const exact = store.find('素材/team/01.PNG') === other;
    const windowsCase = store.find('d:\\旧项目\\素材\\AVATARS\\01.png') === portrait;
    const fallback = store.find('C:\\old-location\\bg.png') === unique;
    let ambiguity = '';
    try {
      store.find('01.PNG');
    } catch (error) {
      ambiguity = String(error);
    }
    const missing = store.find('missing.png') === undefined;
    store.add([file('Case/A.png'), file('Case/a.png')]);
    let caseAmbiguity = '';
    try {
      store.find('case/a.PNG');
    } catch (error) {
      caseAmbiguity = String(error);
    }
    return { relative, absolute, exact, windowsCase, fallback, ambiguity, missing, caseAmbiguity };
  });
  expect(result).toMatchObject({
    relative: true,
    absolute: true,
    exact: true,
    windowsCase: true,
    fallback: true,
    missing: true,
  });
  expect(result.ambiguity).toMatch(/重名|冲突/);
  expect(result.caseAmbiguity).toMatch(/重名|冲突/);
});

test('replacing an asset during decoding cannot repopulate its cache with the previous image', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const modulePath = '/src/core/assets.ts';
    const { AssetStore } = await import(modulePath);
    const store = new AssetStore();
    const svg = (color: string) =>
      new File(
        [
          `<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="${color}"/></svg>`,
        ],
        'logo.svg',
        { type: 'image/svg+xml' },
      );
    const original = HTMLImageElement.prototype.decode;
    let release!: () => void,
      decoded!: () => void,
      call = 0;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstDecoded = new Promise<void>((resolve) => {
      decoded = resolve;
    });
    HTMLImageElement.prototype.decode = async function () {
      const first = ++call === 1;
      await original.call(this);
      if (first) {
        decoded();
        await pending;
      }
    };
    try {
      store.add([svg('#ff0000')]);
      const oldRequest = store.resolve('logo.svg');
      await firstDecoded;
      store.add([svg('#0000ff')]);
      const newImage = await store.resolve('logo.svg');
      release();
      await oldRequest;
      const final = await store.resolve('logo.svg');
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 2;
      canvas.getContext('2d')!.drawImage(final!, 0, 0);
      return {
        same: final === newImage,
        rgba: Array.from(canvas.getContext('2d')!.getImageData(0, 0, 1, 1).data),
      };
    } finally {
      HTMLImageElement.prototype.decode = original;
    }
  });
  expect(result).toEqual({ same: true, rgba: [0, 0, 255, 255] });
});

test('image decode cache remains bounded and releases object URLs when invalidated', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const modulePath = '/src/core/assets.ts';
    const { AssetStore } = await import(modulePath);
    const store = new AssetStore();
    const originalCreate = URL.createObjectURL,
      originalRevoke = URL.revokeObjectURL;
    let created = 0,
      revoked = 0;
    URL.createObjectURL = (blob) => {
      created++;
      return originalCreate(blob);
    };
    URL.revokeObjectURL = (url) => {
      revoked++;
      originalRevoke(url);
    };
    try {
      store.add(
        Array.from(
          { length: 30 },
          (_, i) =>
            new File(
              [
                `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="rgb(${i},0,0)"/></svg>`,
              ],
              `${i}.svg`,
              { type: 'image/svg+xml' },
            ),
        ),
      );
      for (let i = 0; i < 30; i++) await store.resolve(`${i}.svg`);
      const afterLoad = { created, revoked };
      const recent = await store.resolve('29.svg');
      const recentAgain = await store.resolve('29.svg');
      const reused = recent === recentAgain;
      await store.resolve('0.svg');
      const afterReload = { created, revoked };
      store.clear();
      return {
        afterLoad,
        afterReload,
        final: { created, revoked },
        reused,
        files: store.files.size,
        remote: await store.resolve('https://example.invalid/unlinked-image.png'),
      };
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });
  expect(result.afterLoad).toEqual({ created: 30, revoked: 6 });
  expect(result.afterReload).toEqual({ created: 31, revoked: 7 });
  expect(result.final).toEqual({ created: 31, revoked: 31 });
  expect(result.reused).toBe(true);
  expect(result.files).toBe(0);
  expect(result.remote).toBeNull();
});

test('draft and relative asset paths survive a real browser reload', async ({ page }) => {
  await page.evaluate(async () => {
    const storageModule = '/src/core/storage.ts',
      documentModule = '/src/core/document.ts';
    const { saveDraft, saveAssets } = await import(storageModule);
    const { createDocument, createLayer } = await import(documentModule);
    const doc = createDocument(123, 456);
    const text = createLayer('Text');
    text.Data.Text = '草稿恢复';
    doc.Layers.push(text);
    await saveDraft({
      document: doc,
      table: { headers: ['编号'], rows: [{ 编号: '0001' }, { 编号: '0002' }] },
      name: '草稿.ted',
      row: 1,
    });
    const image = new File(
      [
        '<svg xmlns="http://www.w3.org/2000/svg" width="3" height="4"><rect width="3" height="4" fill="red"/></svg>',
      ],
      'avatar.svg',
      { type: 'image/svg+xml', lastModified: 12345 },
    );
    await saveAssets(new Map([['project/avatars/avatar.svg', image]]));
  });
  await page.reload();
  const result = await page.evaluate(async () => {
    const storageModule = '/src/core/storage.ts',
      assetsModule = '/src/core/assets.ts';
    const { readDraft, readAssets } = await import(storageModule);
    const { AssetStore } = await import(assetsModule);
    const [draft, savedAssets] = await Promise.all([readDraft(), readAssets()]);
    const store = new AssetStore();
    store.files = savedAssets;
    const image = await store.resolve('D:\\project\\avatars\\avatar.svg');
    const file = store.find('avatars/avatar.svg');
    return {
      name: draft.name,
      row: draft.row,
      dimensions: [draft.document.DocModel.Width, draft.document.DocModel.Height],
      text: draft.document.Layers[0].Data.Text,
      table: draft.table,
      paths: Array.from(savedAssets.keys()),
      file: { name: file.name, type: file.type, lastModified: file.lastModified },
      image: image && [image.naturalWidth, image.naturalHeight],
    };
  });
  expect(result).toEqual({
    name: '草稿.ted',
    row: 1,
    dimensions: [123, 456],
    text: '草稿恢复',
    table: { headers: ['编号'], rows: [{ 编号: '0001' }, { 编号: '0002' }] },
    paths: ['project/avatars/avatar.svg'],
    file: { name: 'avatar.svg', type: 'image/svg+xml', lastModified: 12345 },
    image: [3, 4],
  });
});

test('rich demo export resolves all SVG assets and condition groups across ten rows', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const exportModule = '/src/core/export.ts',
      demoModule = '/src/core/demo.ts',
      assetsModule = '/src/core/assets.ts',
      zipModule = '/node_modules/fflate/esm/browser.js';
    const { runExport } = await import(exportModule);
    const { createDemo } = await import(demoModule);
    const { AssetStore } = await import(assetsModule);
    const { unzipSync } = await import(zipModule);
    const demo = createDemo(10),
      store = new AssetStore();
    store.add(demo.files);
    const archives: Promise<ArrayBuffer>[] = [];
    const report = await runExport(demo.document, demo.table, store.resolve, {
      start: 1,
      end: 10,
      repeats: 0,
      deltaX: 0,
      deltaY: 0,
      filename: 'demo-{index}',
      onArchive(blob: Blob) {
        archives.push(blob.arrayBuffer());
      },
    });
    const zip = unzipSync(new Uint8Array(await archives[0]));
    const sample = async (name: string) => {
      const bitmap = await createImageBitmap(new Blob([zip[name]]));
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      return {
        size: [canvas.width, canvas.height],
        background: Array.from(ctx.getImageData(0, 0, 1, 1).data),
        avatar: Array.from(ctx.getImageData(140, 330, 1, 1).data),
        badge: Array.from(ctx.getImageData(1400, 665, 1, 1).data),
      };
    };
    return {
      report,
      names: Object.keys(zip),
      first: await sample('demo-1.png'),
      last: await sample('demo-10.png'),
    };
  });
  expect(result.report).toEqual({ completed: 10, total: 10, cancelled: false, warnings: [] });
  expect(result.names).toHaveLength(10);
  expect(result.first.size).toEqual([1920, 1080]);
  expect(result.last.size).toEqual([1920, 1080]);
  expect(result.first.background).toEqual([20, 38, 60, 255]);
  expect(result.first.avatar).toEqual([183, 208, 220, 255]);
  expect(result.last.avatar).toEqual([232, 189, 158, 255]);
  expect(result.first.badge).toEqual([215, 235, 156, 255]);
  expect(result.last.badge).toEqual([32, 57, 78, 255]);
});

test('decodes generated TIFF files and legacy bare base64 images locally', async ({ page }) => {
  const utif = createRequire(import.meta.url)('utif2') as {
    encodeImage(rgba: ArrayBuffer, width: number, height: number): ArrayBuffer;
  };
  const bytes = Array.from(
    new Uint8Array(
      utif.encodeImage(
        new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]).buffer,
        2,
        2,
      ),
    ),
  );
  const result = await page.evaluate(async (bytes: number[]) => {
    const modulePath = '/src/core/assets.ts';
    const { AssetStore } = await import(modulePath);
    const store = new AssetStore();
    store.add([new File([new Uint8Array(bytes)], 'generated.tiff', { type: 'image/tiff' })]);
    const pixel = (image: CanvasImageSource | null) => {
      if (!image) return null;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 2;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(image, 0, 0);
      return Array.from(ctx.getImageData(0, 0, 2, 2).data);
    };
    const tiff = await store.resolve('generated.tiff');
    const tiffEmbedded = await store.resolve(
      'embedded.tif',
      `data:image/tiff;base64,${btoa(String.fromCharCode(...bytes))}`,
    );
    const png = document.createElement('canvas');
    png.width = png.height = 2;
    const ctx = png.getContext('2d')!;
    ctx.fillStyle = '#123456';
    ctx.fillRect(0, 0, 2, 2);
    const bare = png.toDataURL().split(',')[1];
    return {
      tiff: pixel(tiff),
      embedded: pixel(tiffEmbedded),
      bare: pixel(await store.resolve('', bare)),
    };
  }, bytes);
  const rgba = [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255];
  expect(result.tiff).toEqual(rgba);
  expect(result.embedded).toEqual(rgba);
  expect(result.bare).toEqual(Array.from({ length: 4 }, () => [18, 52, 86, 255]).flat());
});
