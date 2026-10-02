import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';

test('background images draw once below every row and only use the first row of each page', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const documentModule = '/src/core/document.ts',
      renderModule = '/src/core/render.ts',
      batchModule = '/src/core/batch.ts';
    const { createDocument, createLayer } = await import(documentModule);
    const { renderComposite } = await import(renderModule);
    const { renderBatchPage } = await import(batchModule);
    const doc = createDocument(120, 140);
    const background = createLayer('Image');
    Object.assign(background, { PageBackground: true, ZIndex: 99 });
    Object.assign(background.Data, {
      Width: 120,
      Height: 140,
      ImageUrl: 'first',
      VariableEnable: true,
      VariableImageUrl: '{背景}',
    });
    const row = createLayer('Rectangle');
    Object.assign(row, { Left: 10, Top: 10 });
    Object.assign(row.Data, { Width: 40, Height: 20, FillColor: '#ff0000' });
    doc.Layers = [background, row];
    const next = structuredClone(doc);
    next.Layers[0].Data.ImageUrl = 'ignored';
    next.Layers[1].Data.FillColor = '#00ff00';
    const calls: string[] = [];
    const image = document.createElement('canvas');
    image.width = 120;
    image.height = 140;
    image.getContext('2d')!.fillStyle = 'rgba(0,0,255,0.5)';
    image.getContext('2d')!.fillRect(0, 0, 120, 140);
    const resolve = async (url: string) => {
      calls.push(url);
      return image;
    };
    const canvas = document.createElement('canvas');
    const pixel = (x: number, y: number) =>
      Array.from(canvas.getContext('2d')!.getImageData(x, y, 1, 1).data);
    const rendered = await renderComposite(canvas, [doc, next], 0, 40, resolve);
    const rows = [pixel(20, 20), pixel(20, 60)];
    const backgroundPixels = [pixel(90, 20), pixel(90, 60), pixel(90, 110)];
    const compositeCalls = [...calls];
    background.Visible = false;
    await renderComposite(canvas, [doc, next], 0, 40, resolve);
    const hidden = pixel(90, 60);
    background.Visible = true;
    calls.length = 0;
    const table = { headers: ['背景'], rows: [{ 背景: 'page-1' }, {}, { 背景: 'page-2' }] };
    const firstPage = await renderBatchPage(canvas, doc, table, [0, 1], 0, 40, resolve);
    const secondPage = await renderBatchPage(canvas, doc, table, [2], 0, 40, resolve);
    return {
      rows,
      backgroundPixels,
      compositeCalls,
      hidden,
      batchCalls: calls,
      warnings: [...firstPage.warnings, ...secondPage.warnings],
      bounds: rendered.bounds[background.Id],
    };
  });
  expect(result.rows).toEqual([
    [255, 0, 0, 255],
    [0, 255, 0, 255],
  ]);
  expect(result.backgroundPixels).toEqual(Array(3).fill([0, 0, 255, 128]));
  expect(result.compositeCalls).toEqual(['first']);
  expect(result.hidden).toEqual([0, 0, 0, 0]);
  expect(result.batchCalls).toEqual(['page-1', 'page-2']);
  expect(result.warnings).toEqual([]);
  expect(result.bounds).toEqual({ x: 0, y: 0, width: 120, height: 140 });
});

test('page-background masks and repeated row masks remain independent', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const documentModule = '/src/core/document.ts',
      renderModule = '/src/core/render.ts';
    const { createDocument, createLayer } = await import(documentModule);
    const { renderComposite } = await import(renderModule);
    const doc = createDocument(120, 100);
    const rect = (
      color: string,
      x: number,
      y: number,
      width: number,
      height: number,
      background: boolean,
      clip: boolean,
      z: number,
    ) => {
      const layer = createLayer('Rectangle');
      Object.assign(layer, {
        PageBackground: background,
        ClippingMaskEnable: clip,
        Left: x,
        Top: y,
        ZIndex: z,
      });
      Object.assign(layer.Data, { Width: width, Height: height, FillColor: color });
      return layer;
    };
    doc.Layers = [
      rect('#0000ff', 0, 0, 120, 100, true, true, 10),
      rect('#ffffff', 0, 0, 100, 100, true, false, 9),
      rect('#ff0000', 0, 0, 120, 25, false, true, 1),
      rect('#ffffff', 10, 5, 30, 20, false, false, 0),
    ];
    const canvas = document.createElement('canvas');
    const rendered = await renderComposite(canvas, [doc, doc], 0, 40, async () => null);
    const pixel = (x: number, y: number) =>
      Array.from(canvas.getContext('2d')!.getImageData(x, y, 1, 1).data);
    return {
      pixels: [pixel(20, 10), pixel(20, 50), pixel(60, 50), pixel(110, 50)],
      warnings: rendered.warnings,
    };
  });
  expect(result.pixels).toEqual([
    [255, 0, 0, 255],
    [255, 0, 0, 255],
    [0, 0, 255, 255],
    [0, 0, 0, 0],
  ]);
  expect(result.warnings).toEqual([]);
});

test('ranking background can be toggled, undone, saved and previewed identically to batch PNG output', async ({
  page,
}, testInfo) => {
  page.on('dialog', (dialog) => dialog.accept());
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true');
  await page
    .locator('input[type="file"][accept=".ted,.json"]')
    .setInputFiles(
      fileURLToPath(new URL('../public/examples/secondary-ranking.ted', import.meta.url)),
    );
  await page.getByRole('button', { name: '选择图层 整页紫色渐变背景', exact: true }).click();
  const background = page.getByLabel('整页背景（不重复）', { exact: true });
  await expect(background).toBeChecked();
  await expect(page.locator('.layer-row').last()).toContainText('背景');
  await expect(page.getByRole('button', { name: '上移图层', exact: true })).toBeDisabled();
  await background.uncheck();
  await expect(page.locator('.layer-background-tag')).toHaveCount(0);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(background).toBeChecked();
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect(background).not.toBeChecked();
  await background.check();
  const saved = page.waitForEvent('download');
  await page.getByRole('button', { name: '保存模板', exact: true }).click();
  const savedPath = (await (await saved).path())!;
  const savedDoc = JSON.parse(await readFile(savedPath, 'utf8'));
  expect(savedDoc.Layers.at(-1).PageBackground).toBe(true);
  await page.locator('input[type="file"][accept=".ted,.json"]').setInputFiles(savedPath);
  await page.getByRole('button', { name: '选择图层 整页紫色渐变背景', exact: true }).click();
  await expect(background).toBeChecked();
  await page.locator('.toolbar').getByRole('button', { name: '导入数据', exact: true }).click();
  const dataDialog = page.getByRole('dialog', { name: '导入数据' });
  await dataDialog
    .getByLabel('粘贴表格数据')
    .fill(
      await readFile(new URL('../public/examples/secondary-ranking.csv', import.meta.url), 'utf8'),
    );
  await dataDialog.getByRole('button', { name: '导入表格', exact: true }).click();
  await page.getByRole('button', { name: '批量导出', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '批量导出' });
  await dialog.getByLabel('额外副本数').fill('3');
  await dialog.getByLabel('Y 偏移', { exact: true }).fill('250');
  const canvas = dialog.getByLabel('同页排版预览画布');
  await expect(canvas).toHaveAttribute('data-ready', 'true');
  await expect(dialog.getByText('1 个整页背景固定不重复，其余图层随数据排版。')).toBeVisible();
  const firstPreview = await canvas.evaluate((el) => (el as HTMLCanvasElement).toDataURL());
  await canvas.screenshot({ path: testInfo.outputPath('ranking-four-rows.png') });
  await testInfo.attach('四行副榜背景只绘制一次', {
    path: testInfo.outputPath('ranking-four-rows.png'),
    contentType: 'image/png',
  });
  await dialog.getByRole('button', { name: '预览下一页' }).click();
  await expect(dialog.getByText('数据第 5 行 · 本页 1 条')).toBeVisible();
  await expect(canvas).toHaveAttribute('data-ready', 'true');
  const lastPreview = await canvas.evaluate((el) => (el as HTMLCanvasElement).toDataURL());
  expect(lastPreview === firstPreview).toBe(false);
  await dialog.getByLabel('导出文件名模板').fill('{index}');
  await dialog.getByLabel('保存方式').selectOption('zip');
  await dialog.getByRole('button', { name: '开始导出', exact: true }).click();
  await expect(dialog.locator('.export-message')).toContainText('已完成：2 / 2');
  const download = page.waitForEvent('download');
  await dialog.getByRole('link', { name: /TEditor_01.zip/ }).click();
  const files = unzipSync(await readFile((await (await download).path())!));
  for (const [name, preview] of [
    ['1-4.png', firstPreview],
    ['5.png', lastPreview],
  ]) {
    expect(
      await page.evaluate(
        async ({ encoded, preview }) => {
          const pixels = async (source: string) => {
            const image = new Image();
            image.src = source;
            await image.decode();
            const canvas = document.createElement('canvas');
            canvas.width = image.naturalWidth;
            canvas.height = image.naturalHeight;
            const context = canvas.getContext('2d')!;
            context.drawImage(image, 0, 0);
            return context.getImageData(0, 0, canvas.width, canvas.height).data;
          };
          const [actual, expected] = await Promise.all([
            pixels('data:image/png;base64,' + encoded),
            pixels(preview),
          ]);
          return (
            actual.length === expected.length && actual.every((value, i) => value === expected[i])
          );
        },
        { encoded: Buffer.from(files[name]).toString('base64'), preview },
      ),
    ).toBe(true);
  }
  expect(errors).toEqual([]);
});
