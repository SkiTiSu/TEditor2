import { expect, test } from '@playwright/test';
import { unzipSync } from 'fflate';

test.beforeEach(async ({ page }) => {
  await page.route('**/export-test', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Export integration test</title>',
    }),
  );
  await page.goto('/export-test');
});

test('exports 500 real 1920×1080 PNGs sequentially with bounded canvas allocation', async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  const result = await page.evaluate(async () => {
    const exportModule = '/src/core/export.ts',
      documentModule = '/src/core/document.ts';
    const { runExport } = await import(exportModule);
    const { createDocument, createLayer } = await import(documentModule);
    const doc = createDocument(1920, 1080);
    const add = (key: string, left: number, top: number, data: object) => {
      const layer = createLayer(key);
      layer.Left = left;
      layer.Top = top;
      layer.ZIndex = doc.Layers.length;
      Object.assign(layer.Data, data);
      doc.Layers.push(layer);
      return layer;
    };
    add('Rectangle', 0, 0, { Width: 1920, Height: 1080, FillColor: '#14263c' });
    add('Rectangle', 100, 110, {
      Width: 1720,
      Height: 800,
      FillColor: '#20394e',
      RadiusTopLeft: 40,
      RadiusTopRight: 80,
    });
    add('Ellipse', 140, 210, { Width: 220, Height: 220, FillColor: '#fff' });
    const avatar = add('Image', 140, 210, {
      Width: 220,
      Height: 220,
      ImageUrl: 'avatar',
      VariableEnable: true,
      VariableImageUrl: 'avatar-{类别}',
    });
    avatar.ClippingMaskEnable = true;
    add('Text', 430, 250, {
      Text: '测试',
      FontFamilyName: 'Arial',
      FontSize: 70,
      FontWeight: 'Bold',
      Color: '#ffffff',
      VariableEnable: true,
      VariableTemplate: 'Batch {编号} · {名称}',
      StrokeEnable: true,
      StrokePosition: 1,
      StrokeThickness: 1,
      StrokeColor: '#d7eb9c',
    });
    add('Text', 145, 520, {
      FontFamilyName: 'sans-serif',
      FontSize: 52,
      Color: '#d7eb9c',
      VariableEnable: true,
      VariableTemplate: '本地批量导出验证：第 {编号} 行',
      ShadowEnable: true,
      ShadowBlurRadius: 10,
      ShadowDepth: 5,
      ShadowOpacity: 0.4,
    });
    const badge = add('Rectangle', 145, 700, { Width: 200, Height: 70, FillColor: '#d7eb9c' });
    doc.DocModel.FormatConditionGroups = [
      {
        Name: '条件',
        Color: '#d7eb9c',
        EffctiveLayers: [badge.Id],
        FormatConditionModels: [
          { Name: '默认', Condition: '', LayersVisable: { [badge.Id]: false } },
          { Name: '偶数显示', Condition: '[类别] = 0', LayersVisable: { [badge.Id]: true } },
        ],
      },
    ];
    const rows = Array.from({ length: 500 }, (_, i) => ({
      编号: String(i + 1).padStart(3, '0'),
      名称: ['林间来信', '周末放映室'][i % 2],
      类别: String(i % 2),
    }));
    const table = { headers: ['编号', '名称', '类别'], rows };
    const avatars = [0, 1].map((i) => {
      const image = document.createElement('canvas');
      image.width = image.height = 32;
      const ctx = image.getContext('2d')!;
      ctx.fillStyle = i ? '#b7d0dc' : '#e8bd9e';
      ctx.fillRect(0, 0, 32, 32);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(8, 8, 16, 24);
      return image;
    });
    const files = new Set(['render_001.png', 'render_002.png']);
    const written: string[] = [];
    let bytes = 0,
      validPNGs = 0,
      closed = 0,
      aborts = 0,
      activeWrites = 0,
      peakActiveWrites = 0,
      resolverCalls = 0;
    const directory = {
      async getFileHandle(name: string, options?: { create?: boolean }) {
        if (!options?.create) {
          if (files.has(name)) return {};
          throw new DOMException('missing', 'NotFoundError');
        }
        if (files.has(name)) throw new Error(`Would overwrite ${name}`);
        files.add(name);
        return {
          async createWritable() {
            return {
              async write(blob: Blob) {
                activeWrites++;
                peakActiveWrites = Math.max(peakActiveWrites, activeWrites);
                const header = new Uint8Array(await blob.slice(0, 24).arrayBuffer());
                const view = new DataView(header.buffer);
                if (
                  Array.from(header.slice(0, 8)).join() !== '137,80,78,71,13,10,26,10' ||
                  view.getUint32(16) !== 1920 ||
                  view.getUint32(20) !== 1080
                )
                  throw new Error('Invalid PNG output');
                validPNGs++;
                bytes += blob.size;
                written.push(name);
                activeWrites--;
              },
              async close() {
                closed++;
              },
              async abort() {
                aborts++;
              },
            };
          },
        };
      },
    };
    const memory = () =>
      (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
        ?.usedJSHeapSize ?? null;
    const progress: [number, number][] = [],
      heapSamples: { completed: number; bytes: number | null }[] = [
        { completed: 0, bytes: memory() },
      ];
    let canvasesCreated = 0;
    const originalCreateElement = document.createElement.bind(document);
    document.createElement = ((tagName: string, options?: ElementCreationOptions) => {
      if (tagName.toLowerCase() === 'canvas') canvasesCreated++;
      return originalCreateElement(tagName, options);
    }) as typeof document.createElement;
    const start = performance.now();
    let report;
    try {
      report = await runExport(
        doc,
        table,
        async (source: string) => {
          resolverCalls++;
          return avatars[source.endsWith('1') ? 1 : 0];
        },
        {
          start: 1,
          end: 500,
          repeats: 0,
          deltaX: 0,
          deltaY: 0,
          filename: 'render_{编号}',
          directory,
          onProgress(done: number, total: number) {
            progress.push([done, total]);
            if (done % 50 === 0) heapSamples.push({ completed: done, bytes: memory() });
          },
        },
      );
    } finally {
      document.createElement = originalCreateElement;
    }
    return {
      report,
      elapsedMs: performance.now() - start,
      bytes,
      validPNGs,
      closed,
      aborts,
      peakActiveWrites,
      resolverCalls,
      canvasesCreated,
      heapSamples,
      progress,
      written,
    };
  });
  expect(result.report).toEqual({ completed: 500, total: 500, cancelled: false, warnings: [] });
  expect(result.validPNGs).toBe(500);
  expect(result.closed).toBe(500);
  expect(result.aborts).toBe(0);
  expect(result.peakActiveWrites).toBe(1);
  expect(result.canvasesCreated).toBeLessThanOrEqual(10);
  expect(new Set(result.written).size).toBe(500);
  expect(result.written.slice(0, 3)).toEqual([
    'render_001 (2).png',
    'render_002 (2).png',
    'render_003.png',
  ]);
  expect(result.written.at(-1)).toBe('render_500.png');
  expect(result.progress).toEqual(Array.from({ length: 500 }, (_, i) => [i + 1, 500]));
  const benchmark = {
    ...result,
    written: undefined,
    progress: undefined,
    note: 'Chrome performance.memory measures JS heap only; native canvas buffers and PNG encoder memory are not included. Writable mock validates then discards every PNG.',
  };
  await testInfo.attach('500-image-benchmark.json', {
    contentType: 'application/json',
    body: JSON.stringify(benchmark, null, 2),
  });
  console.log('EXPORT_500_BENCHMARK', JSON.stringify(benchmark));
});

test('repeated rows obey the selected end row and export PNG pixels at exact offsets', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const exportModule = '/src/core/export.ts',
      documentModule = '/src/core/document.ts';
    const { runExport } = await import(exportModule);
    const { createDocument, createLayer } = await import(documentModule);
    const doc = createDocument(96, 32),
      layer = createLayer('Image');
    Object.assign(layer.Data, {
      Width: 12,
      Height: 12,
      VariableEnable: true,
      VariableImageUrl: '{编号}',
    });
    doc.Layers = [layer];
    const rows = Array.from({ length: 7 }, (_, i) => ({ 编号: String(i + 1) }));
    const seen: string[] = [],
      output: { name: string; samples: number[]; size: number[] }[] = [];
    const directory = {
      async getFileHandle(name: string, options?: { create?: boolean }) {
        if (!options?.create) throw new DOMException('missing', 'NotFoundError');
        return {
          async createWritable() {
            return {
              async write(blob: Blob) {
                const image = await createImageBitmap(blob),
                  canvas = document.createElement('canvas');
                canvas.width = image.width;
                canvas.height = image.height;
                const ctx = canvas.getContext('2d')!;
                ctx.drawImage(image, 0, 0);
                image.close();
                output.push({
                  name,
                  size: [canvas.width, canvas.height],
                  samples: [2, 22, 42, 62].flatMap((x) =>
                    Array.from(ctx.getImageData(x, 2, 1, 1).data),
                  ),
                });
              },
              async close() {},
              async abort() {},
            };
          },
        };
      },
    };
    const report = await runExport(
      doc,
      { headers: ['编号'], rows },
      async (source: string) => {
        seen.push(source);
        const sourceCanvas = document.createElement('canvas');
        sourceCanvas.width = sourceCanvas.height = 1;
        const ctx = sourceCanvas.getContext('2d')!;
        ctx.fillStyle = `rgb(${Number(source) * 20},0,0)`;
        ctx.fillRect(0, 0, 1, 1);
        return sourceCanvas;
      },
      {
        start: 2,
        end: 5,
        repeats: 2,
        deltaX: 20,
        deltaY: 0,
        filename: 'rows_{index}_{编号}',
        directory,
      },
    );
    return { report, seen, output };
  });
  expect(result.report).toEqual({ completed: 2, total: 2, cancelled: false, warnings: [] });
  expect(result.seen).toEqual(['2', '3', '4', '5']);
  expect(result.output.map((file) => file.name)).toEqual(['rows_2-4_2.png', 'rows_5_5.png']);
  expect(result.output.map((file) => file.size)).toEqual([
    [96, 32],
    [96, 32],
  ]);
  expect(result.output[0].samples).toEqual([
    40, 0, 0, 255, 60, 0, 0, 255, 80, 0, 0, 255, 0, 0, 0, 0,
  ]);
  expect(result.output[1].samples).toEqual([100, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test('ZIP parts retain every output when template names collide with generated suffixes', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const exportModule = '/src/core/export.ts',
      documentModule = '/src/core/document.ts';
    const { runExport } = await import(exportModule);
    const { createDocument, createLayer } = await import(documentModule);
    const doc = createDocument(12, 8),
      rect = createLayer('Rectangle');
    Object.assign(rect.Data, { Width: 12, Height: 8, FillColor: '#abcdef' });
    doc.Layers = [rect];
    const names = ['a', 'a', 'a (2)', 'a', ...Array.from({ length: 49 }, (_, i) => `item-${i}`)];
    const archives: Promise<{ name: string; bytes: number[] }>[] = [];
    const report = await runExport(
      doc,
      { headers: ['名称'], rows: names.map((名称) => ({ 名称 })) },
      async () => null,
      {
        start: 1,
        end: names.length,
        repeats: 0,
        deltaX: 0,
        deltaY: 0,
        filename: '{名称}',
        onArchive(blob: Blob, name: string) {
          archives.push(
            blob
              .arrayBuffer()
              .then((buffer) => ({ name, bytes: Array.from(new Uint8Array(buffer)) })),
          );
        },
      },
    );
    return { report, archives: await Promise.all(archives) };
  });
  expect(result.report).toEqual({ completed: 53, total: 53, cancelled: false, warnings: [] });
  expect(result.archives.map((archive) => archive.name)).toEqual([
    'TEditor_01.zip',
    'TEditor_02.zip',
  ]);
  const parts = result.archives.map((archive) => unzipSync(new Uint8Array(archive.bytes)));
  expect(parts.map((part) => Object.keys(part).length)).toEqual([50, 3]);
  const names = parts.flatMap((part) => Object.keys(part));
  expect(new Set(names).size).toBe(53);
  expect(names).toContain('a.png');
  expect(names).toContain('a (2).png');
  for (const bytes of parts.flatMap((part) => Object.values(part))) {
    expect(Array.from(bytes.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect([header.getUint32(16), header.getUint32(20)]).toEqual([12, 8]);
  }
});

test('cancellation returns completed progress and emits the usable partial archive', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const exportModule = '/src/core/export.ts',
      documentModule = '/src/core/document.ts';
    const { runExport } = await import(exportModule);
    const { createDocument } = await import(documentModule);
    const controller = new AbortController(),
      progress: number[] = [],
      archives: Promise<number[]>[] = [];
    const report = await runExport(
      createDocument(12, 8),
      { headers: ['id'], rows: Array.from({ length: 20 }, (_, i) => ({ id: String(i) })) },
      async () => null,
      {
        start: 1,
        end: 20,
        repeats: 0,
        deltaX: 0,
        deltaY: 0,
        filename: '{index}',
        signal: controller.signal,
        onProgress(done: number) {
          progress.push(done);
          if (done === 3) controller.abort();
        },
        onArchive(blob: Blob) {
          archives.push(blob.arrayBuffer().then((buffer) => Array.from(new Uint8Array(buffer))));
        },
      },
    );
    const alreadyAborted = await runExport(
      createDocument(12, 8),
      { headers: [], rows: [] },
      async () => {
        throw new Error('must not resolve');
      },
      {
        start: 1,
        end: 1,
        repeats: 0,
        deltaX: 0,
        deltaY: 0,
        filename: '{index}',
        signal: controller.signal,
      },
    );
    return { report, alreadyAborted, progress, archives: await Promise.all(archives) };
  });
  expect(result.report).toEqual({ completed: 3, total: 20, cancelled: true, warnings: [] });
  expect(result.alreadyAborted).toEqual({ completed: 0, total: 1, cancelled: true, warnings: [] });
  expect(result.progress).toEqual([1, 2, 3]);
  expect(result.archives).toHaveLength(1);
  expect(Object.keys(unzipSync(new Uint8Array(result.archives[0])))).toEqual([
    '1.png',
    '2.png',
    '3.png',
  ]);
});

test('writer failures abort the incomplete file and stop subsequent rows', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const exportModule = '/src/core/export.ts',
      documentModule = '/src/core/document.ts';
    const { runExport } = await import(exportModule);
    const { createDocument } = await import(documentModule);
    let writes = 0,
      aborts = 0,
      closes = 0,
      progress = 0,
      error = '';
    const directory = {
      async getFileHandle(_name: string, options?: { create?: boolean }) {
        if (!options?.create) throw new DOMException('missing', 'NotFoundError');
        return {
          async createWritable() {
            return {
              async write() {
                writes++;
                throw new DOMException('disk full', 'QuotaExceededError');
              },
              async close() {
                closes++;
              },
              async abort() {
                aborts++;
              },
            };
          },
        };
      },
    };
    try {
      await runExport(
        createDocument(12, 8),
        { headers: ['id'], rows: [{ id: '1' }, { id: '2' }] },
        async () => null,
        {
          start: 1,
          end: 2,
          repeats: 0,
          deltaX: 0,
          deltaY: 0,
          filename: '{index}',
          directory,
          onProgress() {
            progress++;
          },
        },
      );
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    return { writes, aborts, closes, progress, error };
  });
  expect(result).toEqual({ writes: 1, aborts: 1, closes: 0, progress: 0, error: 'disk full' });
});

test('writes PNG files through real browser FileSystemWritableFileStreams without overwriting existing files', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const exportModule = '/src/core/export.ts',
      documentModule = '/src/core/document.ts';
    const { runExport } = await import(exportModule);
    const { createDocument, createLayer } = await import(documentModule);
    const root = await navigator.storage.getDirectory();
    const name = `teditor-export-test-${crypto.randomUUID()}`;
    const directory = await root.getDirectoryHandle(name, { create: true });
    try {
      const original = await directory.getFileHandle('demo_1.png', { create: true });
      const writer = await original.createWritable();
      await writer.write(new Uint8Array([1, 2, 3]));
      await writer.close();
      const doc = createDocument(17, 19),
        rectangle = createLayer('Rectangle');
      Object.assign(rectangle.Data, { Width: 17, Height: 19, FillColor: '#123456' });
      doc.Layers.push(rectangle);
      const report = await runExport(
        doc,
        { headers: ['编号'], rows: [{ 编号: '1' }, { 编号: '2' }, { 编号: '3' }] },
        async () => null,
        { start: 1, end: 3, repeats: 0, deltaX: 0, deltaY: 0, filename: 'demo_{编号}', directory },
      );
      const files: { name: string; bytes: number; signature: number[]; dimensions: number[] }[] =
        [];
      for (const filename of ['demo_1 (2).png', 'demo_2.png', 'demo_3.png']) {
        const file = await (await directory.getFileHandle(filename)).getFile();
        const bytes = new Uint8Array(await file.slice(0, 24).arrayBuffer()),
          header = new DataView(bytes.buffer);
        files.push({
          name: file.name,
          bytes: file.size,
          signature: Array.from(bytes.slice(0, 8)),
          dimensions: [header.getUint32(16), header.getUint32(20)],
        });
      }
      const originalBytes = Array.from(
        new Uint8Array(await (await original.getFile()).arrayBuffer()),
      );
      return { report, files, originalBytes };
    } finally {
      await root.removeEntry(name, { recursive: true });
    }
  });
  expect(result.report).toEqual({ completed: 3, total: 3, cancelled: false, warnings: [] });
  expect(result.originalBytes).toEqual([1, 2, 3]);
  expect(result.files.map((file) => file.name)).toEqual([
    'demo_1 (2).png',
    'demo_2.png',
    'demo_3.png',
  ]);
  for (const file of result.files) {
    expect(file.bytes).toBeGreaterThan(24);
    expect(file.signature).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(file.dimensions).toEqual([17, 19]);
  }
});
