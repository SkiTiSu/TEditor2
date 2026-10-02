import { expect, test, type Page, type Download } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import type { TedDocument } from '../src/core/types';

const legacyPath = fileURLToPath(
  new URL('../public/examples/legacy-all-features.ted', import.meta.url),
);
const errors = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  errors.set(page, []);
  page.on('pageerror', (error) => errors.get(page)!.push(error.message));
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto('/');
  await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true');
  await expect(page.getByRole('button', { name: '添加文字', exact: true })).toBeVisible();
});

test.afterEach(async ({ page }) => {
  expect(errors.get(page), 'unexpected browser exceptions').toEqual([]);
});

test('image opacity multiplies source alpha in preview and export and survives saving', async ({
  page,
}) => {
  await fresh(page, 100, 100);
  await page.getByRole('button', { name: '添加图片', exact: true }).click();
  const encoded = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 20;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ff000080';
    ctx.fillRect(0, 0, 20, 20);
    return canvas.toDataURL().split(',')[1];
  });
  await page.locator('input[type=file][accept="image/*,.tif,.tiff"]').setInputFiles({
    name: 'alpha.png',
    mimeType: 'image/png',
    buffer: Buffer.from(encoded, 'base64'),
  });
  await page.getByLabel('X', { exact: true }).fill('0');
  await page.getByLabel('Y', { exact: true }).fill('0');
  const opacity = page.getByLabel('图片不透明度 (%)', { exact: true });
  await expect(opacity).toHaveValue('100');
  await expect.poll(() => pixel(page, 5, 5)).toEqual([255, 0, 0, 128]);
  await opacity.fill('50');
  await expect.poll(() => pixel(page, 5, 5)).toEqual([255, 0, 0, 64]);
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出当前', exact: true }).click();
  expect((await pngPixels(page, await downloadBytes(await downloaded), [[5, 5]])).pixels).toEqual([
    [255, 0, 0, 64],
  ]);
  const saved = await saveDocument(page);
  expect(saved.Layers[0].Data).toMatchObject({ Opacity: 0.5 });
  await fresh(page, 100, 100);
  await page.locator('input[type=file][accept=".ted,.json"]').setInputFiles({
    name: 'opacity.ted',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(saved)),
  });
  await page.locator('.layer-row').first().click();
  await expect(opacity).toHaveValue('50');
  await expect.poll(() => pixel(page, 5, 5)).toEqual([255, 0, 0, 64]);
  await page.getByLabel('图片不透明度滑块', { exact: true }).fill('0');
  await expect.poll(() => pixel(page, 5, 5)).toEqual([0, 0, 0, 0]);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(opacity).toHaveValue('50');
});

test('color picker supports RGB and RGBA while preserving alpha and transparent RGB', async ({
  page,
}) => {
  await fresh(page);
  await page.getByRole('button', { name: '添加文字', exact: true }).click();
  const color = page.getByLabel('文字颜色', { exact: true });
  const picker = page.getByLabel('文字颜色选择', { exact: true });
  const alpha = page.getByLabel('文字颜色 Alpha', { exact: true });
  await color.fill('rgb(12, 34, 56)');
  await expect(picker).toHaveValue('#0c2238');
  await expect(alpha).toHaveValue('1');
  await color.fill('rgba(12, 34, 56, 0.5)');
  await expect(alpha).toHaveValue('0.5');
  await picker.fill('#ff8000');
  await expect(color).toHaveValue('#ff800080');
  await alpha.fill('0');
  await expect(color).toHaveValue('#ff800000');
  await expect(picker).toHaveValue('#ff8000');
  await alpha.fill('1');
  await expect(color).toHaveValue('#ff8000');
  await color.fill('#1234');
  await expect(picker).toHaveValue('#112233');
  expect(Number(await alpha.inputValue())).toBeCloseTo(4 / 15, 2);
  await color.fill('#11223380');
  await expect(picker).toHaveValue('#112233');
  expect(Number(await alpha.inputValue())).toBeCloseTo(128 / 255, 2);
  await page.getByLabel('文字颜色 Alpha滑块', { exact: true }).fill('0.25');
  await expect(color).toHaveValue('#11223340');
  const saved = await saveDocument(page);
  await fresh(page);
  await page.locator('input[type=file][accept=".ted,.json"]').setInputFiles({
    name: 'rgba.ted',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(saved)),
  });
  await page.locator('.layer-row').first().click();
  await expect(color).toHaveValue('#11223340');
});

test('starts only one batch when export is double clicked while choosing a directory', async ({
  page,
}) => {
  await fresh(page, 100, 100);
  await pasteTable(page, '编号\n1\n2');
  await page.evaluate(() => {
    const state = window as unknown as {
      pickerCalls: number;
      showDirectoryPicker: () => Promise<FileSystemDirectoryHandle>;
    };
    state.pickerCalls = 0;
    state.showDirectoryPicker = async () => {
      state.pickerCalls++;
      await new Promise((r) => setTimeout(r, 120));
      return (await navigator.storage.getDirectory()).getDirectoryHandle(
        'double-click-export-test',
        { create: true },
      );
    };
  });
  await page.getByRole('button', { name: '批量导出', exact: true }).click();
  await page.getByRole('button', { name: '开始导出', exact: true }).dblclick();
  await expect(page.locator('.export-message')).toContainText('已完成：2 / 2');
  expect(
    await page.evaluate(() => (window as unknown as { pickerCalls: number }).pickerCalls),
  ).toBe(1);
  await page.evaluate(async () => {
    await (
      await navigator.storage.getDirectory()
    ).removeEntry('double-click-export-test', { recursive: true });
  });
});

test('sorts rows together with their variables and handles undo of a selected new layer', async ({
  page,
}) => {
  await fresh(page);
  await pasteTable(page, '编号\t名称\n10\t十号\n2\t二号\n1\t一号');
  await page.getByRole('button', { name: '排序 编号', exact: true }).click();
  await expect(page.getByLabel('第1行 名称', { exact: true })).toHaveValue('一号');
  await page.getByRole('button', { name: '排序 编号', exact: true }).click();
  await expect(page.getByLabel('第1行 名称', { exact: true })).toHaveValue('十号');
  await page.getByRole('button', { name: '添加文字', exact: true }).click();
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.locator('.layer-row')).toHaveCount(0);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Control+d');
  await expect(page.locator('.layer-row')).toHaveCount(0);
});

async function fresh(page: Page, width = 800, height = 600) {
  await page.getByRole('button', { name: '新建', exact: true }).click();
  await expect(page.locator('.layer-row')).toHaveCount(0);
  await page.getByLabel('画布宽度', { exact: true }).fill(String(width));
  await page.getByLabel('画布高度', { exact: true }).fill(String(height));
  await expect(page.getByLabel('模板画布', { exact: true })).toHaveAttribute(
    'width',
    String(width),
  );
  await expect(page.getByLabel('模板画布', { exact: true })).toHaveAttribute(
    'height',
    String(height),
  );
}

async function pasteTable(page: Page, text: string) {
  await page.locator('.toolbar').getByRole('button', { name: '导入数据', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '导入数据' });
  await dialog.getByLabel('粘贴表格数据').fill(text);
  await dialog.getByRole('button', { name: '导入表格', exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

async function pixel(page: Page, x: number, y: number): Promise<number[]> {
  return page
    .getByLabel('模板画布', { exact: true })
    .evaluate(
      (node, point) =>
        Array.from(
          (node as HTMLCanvasElement).getContext('2d')!.getImageData(point.x, point.y, 1, 1).data,
        ),
      { x, y },
    );
}

async function downloadBytes(download: Download): Promise<Buffer> {
  const path = await download.path();
  expect(path).not.toBeNull();
  return readFile(path!);
}

async function saveDocument(page: Page): Promise<TedDocument> {
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: '保存模板', exact: true }).click();
  return JSON.parse((await downloadBytes(await downloaded)).toString('utf8')) as TedDocument;
}

async function pngPixels(page: Page, buffer: Buffer, points: [number, number][]) {
  expect([...buffer.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  return page.evaluate(
    async ({ base64, points }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      return {
        width: canvas.width,
        height: canvas.height,
        pixels: points.map(([x, y]) => Array.from(context.getImageData(x, y, 1, 1).data)),
      };
    },
    { base64: buffer.toString('base64'), points },
  );
}

test('creates every layer type, edits properties, and restores delete/duplicate/reorder through history', async ({
  page,
}) => {
  await fresh(page);
  await page.getByRole('button', { name: '添加矩形', exact: true }).click();
  await page.getByLabel('图层名称').fill('半透明底板');
  await page.getByLabel('宽度', { exact: true }).fill('320');
  await page.getByLabel('高度', { exact: true }).fill('180');
  await page.getByLabel('填充颜色', { exact: true }).fill('#ef783780');
  await page.getByLabel('左上圆角').fill('24');
  await expect(page.getByLabel('右下圆角')).toHaveValue('24');
  await page.getByLabel('联动四角').uncheck();
  await page.getByLabel('右下圆角').fill('8');
  await expect(page.getByLabel('左上圆角')).toHaveValue('24');
  await page.getByRole('button', { name: '添加椭圆', exact: true }).click();
  await page.getByRole('button', { name: '添加图片', exact: true }).click();
  await page.getByRole('button', { name: '添加文字', exact: true }).click();
  await page.getByLabel('文字内容', { exact: true }).fill('测试文字 Hello');
  await page.getByLabel('字号', { exact: true }).fill('56');
  await expect(page.getByLabel('字重', { exact: true })).toHaveValue('400');
  await page.getByLabel('字重', { exact: true }).selectOption('700');
  await page.getByLabel('斜体', { exact: true }).check();
  await page.getByLabel('文字描边', { exact: true }).check();
  await page.getByLabel('描边位置').selectOption('2');
  await page.getByLabel('描边粗细').fill('3');
  await page.getByLabel('文字阴影', { exact: true }).check();
  await page.getByLabel('阴影透明度').fill('0.3');
  await expect(page.locator('.layer-row')).toHaveCount(4);
  await page.getByRole('button', { name: '复制图层', exact: true }).click();
  await expect(page.locator('.layer-row')).toHaveCount(5);
  await expect(page.getByLabel('图层名称')).toHaveValue('文字 1 副本');
  await page.getByLabel('文字内容', { exact: true }).fill('复制内容');
  await page.getByRole('button', { name: '选择图层 文字 1', exact: true }).click();
  await expect(page.getByLabel('文字内容', { exact: true })).toHaveValue('测试文字 Hello');
  await page.getByRole('button', { name: '选择图层 文字 1 副本', exact: true }).click();
  await page.getByRole('button', { name: '下移图层', exact: true }).click();
  await expect(page.locator('.layer-row').nth(1)).toHaveAttribute(
    'aria-label',
    '选择图层 文字 1 副本',
  );
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.locator('.layer-row').first()).toHaveAttribute(
    'aria-label',
    '选择图层 文字 1 副本',
  );
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect(page.locator('.layer-row').nth(1)).toHaveAttribute(
    'aria-label',
    '选择图层 文字 1 副本',
  );
  await page.getByRole('button', { name: '删除图层', exact: true }).click();
  await expect(page.locator('.layer-row')).toHaveCount(4);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.locator('.layer-row')).toHaveCount(5);
  const saved = await saveDocument(page);
  expect(new Set(saved.Layers.map((layer) => layer.Key))).toEqual(
    new Set(['Text', 'Image', 'Ellipse', 'Rectangle']),
  );
  expect(saved.Layers.find((layer) => layer.LayerNameCustom === '半透明底板')?.Data).toMatchObject({
    FillColor: '#ef783780',
    RadiusTopLeft: 24,
    RadiusBottomRight: 8,
  });
  expect(saved.Layers.find((layer) => layer.LayerNameCustom === '文字 1')?.Data).toMatchObject({
    FontWeight: '700',
    FontStyle: 'italic',
    StrokePosition: 2,
    ShadowOpacity: 0.3,
  });
});

test('supports keyboard movement, accelerated steps, duplicate, delete, undo and redo without hijacking text fields', async ({
  page,
}) => {
  await fresh(page);
  await page.getByRole('button', { name: '添加矩形', exact: true }).click();
  const layer = page.getByRole('button', { name: '选择图层 矩形 1', exact: true });
  await layer.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  await expect(page.getByLabel('X', { exact: true })).toHaveValue('101');
  await expect(page.getByLabel('Y', { exact: true })).toHaveValue('110');
  await page.keyboard.press('ControlOrMeta+d');
  await expect(page.locator('.layer-row')).toHaveCount(2);
  await page.getByLabel('图层名称').fill('编辑框安全');
  await page.getByLabel('图层名称').press('Backspace');
  await expect(page.locator('.layer-row')).toHaveCount(2);
  await page.locator('.layer-row.selected').focus();
  await page.keyboard.press('Delete');
  await expect(page.locator('.layer-row')).toHaveCount(1);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('.layer-row')).toHaveCount(2);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(page.locator('.layer-row')).toHaveCount(1);
});

test('moves and resizes canvas objects, preserves undo, and allows panning and zoom', async ({
  page,
}) => {
  await fresh(page);
  await page.getByRole('button', { name: '添加矩形', exact: true }).click();
  await page.getByLabel('宽度', { exact: true }).fill('180');
  await page.getByLabel('高度', { exact: true }).fill('140');
  await expect.poll(() => pixel(page, 150, 150)).toEqual([0, 0, 0, 255]);
  const canvas = page.getByLabel('模板画布', { exact: true });
  const bounds = (await canvas.boundingBox())!;
  const scale = bounds.width / 800;
  const start = { x: bounds.x + 150 * scale, y: bounds.y + 150 * scale };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 50 * scale, start.y + 40 * scale, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByLabel('X', { exact: true })).toHaveValue('150');
  await expect(page.getByLabel('Y', { exact: true })).toHaveValue('140');
  const handle = page.getByRole('button', { name: '缩放 se', exact: true });
  await expect(handle).toBeVisible();
  const h = (await handle.boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 + 60 * scale, h.y + h.height / 2 + 30 * scale, {
    steps: 5,
  });
  await page.mouse.up();
  await expect
    .poll(async () => Number(await page.getByLabel('宽度', { exact: true }).inputValue()))
    .toBeCloseTo(240, 0);
  await expect
    .poll(async () => Number(await page.getByLabel('高度', { exact: true }).inputValue()))
    .toBeCloseTo(170, 0);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.getByLabel('宽度', { exact: true })).toHaveValue('180');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.getByLabel('X', { exact: true })).toHaveValue('100');
  const zoom = page.getByLabel('画布缩放百分比');
  const previousZoom = Number(await zoom.inputValue());
  await page.getByRole('button', { name: '放大', exact: true }).click();
  expect(Number(await zoom.inputValue())).toBeGreaterThan(previousZoom);
  await page.getByRole('button', { name: '适应画布', exact: true }).click();
  const previousTransform = await page.locator('.canvas-wrapper').getAttribute('style');
  await page.locator('.layer-row.selected').focus();
  await page.keyboard.down('Space');
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 45, start.y + 25, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up('Space');
  expect(await page.locator('.canvas-wrapper').getAttribute('style')).not.toBe(previousTransform);
  await expect(page.getByLabel('X', { exact: true })).toHaveValue('100');
});

test('edits condition groups and chooses defaults, formula matches and manual overrides', async ({
  page,
}) => {
  await fresh(page);
  await page.getByRole('button', { name: '添加矩形', exact: true }).click();
  await page.getByRole('button', { name: '条件组', exact: true }).click();
  await page.getByLabel('条件组 1名称', { exact: true }).fill('展示规则');
  await page.getByLabel('条件组 1颜色', { exact: true }).fill('#aa55ee');
  await page.getByLabel('条件组 1控制图层 矩形 1', { exact: true }).check();
  await page.getByLabel('条件组 1条件 1显示 矩形 1', { exact: true }).uncheck();
  await expect(page.locator('.layer-row')).toHaveClass(/hidden-layer/);
  await page.getByRole('button', { name: '条件组 1添加条件', exact: true }).click();
  await page.locator('.condition-rule').nth(1).locator('summary').click();
  await page.getByLabel('条件组 1条件 2名称', { exact: true }).fill('VIP');
  await page.getByLabel('条件组 1条件 2表达式', { exact: true }).fill('等级 = "VIP"');
  await page.getByLabel('条件组 1条件 2显示 矩形 1', { exact: true }).check();
  await page.getByLabel('条件组 1预览条件', { exact: true }).selectOption('1');
  await expect(page.locator('.layer-row')).not.toHaveClass(/hidden-layer/);
  await page.getByLabel('条件组 1预览条件', { exact: true }).selectOption('-1');
  await expect(page.locator('.layer-row')).toHaveClass(/hidden-layer/);
  await pasteTable(page, '姓名\t等级\n林晓\tVIP\n陈宁\t普通');
  await expect(page.locator('.layer-row')).not.toHaveClass(/hidden-layer/);
  await page.getByRole('button', { name: '预览第 2 行', exact: true }).click();
  await expect(page.locator('.layer-row')).toHaveClass(/hidden-layer/);
  await page.getByRole('button', { name: '＋ 添加条件组', exact: true }).click();
  await expect(page.getByLabel('条件组 2名称', { exact: true })).toBeVisible();
  await page.getByLabel('条件组 2名称', { exact: true }).fill('临时组');
  await page.getByRole('button', { name: '删除条件组 2', exact: true }).click();
  await expect(page.getByLabel('条件组 2名称', { exact: true })).not.toBeVisible();
  const saved = await saveDocument(page);
  expect(saved.DocModel.FormatConditionGroups).toHaveLength(1);
  expect(saved.DocModel.FormatConditionGroups[0]).toMatchObject({
    Name: '展示规则',
    Color: '#aa55ee',
  });
  expect(saved.DocModel.FormatConditionGroups[0].FormatConditionModels[1]).toMatchObject({
    Name: 'VIP',
    Condition: '等级 = "VIP"',
  });
});

test('imports an original-format template and local PNG, previews data rows, and roundtrips a saved template', async ({
  page,
}) => {
  await page.locator('input[type=file][accept=".ted,.json"]').setInputFiles(legacyPath);
  await expect(page.locator('.layer-row')).toHaveCount(5);
  await expect(page.getByLabel('模板画布', { exact: true })).toHaveAttribute('width', '1920');
  await expect
    .poll(async () => (await pixel(page, 1510, 340))[2], {
      message: 'legacy raw-base64 PNG must render, rather than the missing-image placeholder',
    })
    .toBe(170);
  await page.getByRole('button', { name: '选择图层 variable-title', exact: true }).click();
  await expect(page.getByLabel('文字模板')).toHaveValue('你好，{姓名}\n{城市} · 编号 {编号}');
  await expect(page.getByLabel('字重', { exact: true })).toHaveValue('600');
  await pasteTable(page, '姓名,城市,编号,等级\n林晓,上海,0001,VIP\n陈宁,杭州,0002,普通');
  await expect(page.getByLabel('第1行 编号', { exact: true })).toHaveValue('0001');
  await expect(
    page.getByRole('button', { name: '选择图层 vip-badge', exact: true }),
  ).not.toHaveClass(/hidden-layer/);
  const firstPreview = await page
    .getByLabel('模板画布', { exact: true })
    .evaluate((node) => (node as HTMLCanvasElement).toDataURL());
  await page.getByRole('button', { name: '预览第 2 行', exact: true }).click();
  await expect(page.getByRole('button', { name: '选择图层 vip-badge', exact: true })).toHaveClass(
    /hidden-layer/,
  );
  await expect
    .poll(() =>
      page
        .getByLabel('模板画布', { exact: true })
        .evaluate((node) => (node as HTMLCanvasElement).toDataURL()),
    )
    .not.toBe(firstPreview);
  await page.getByRole('button', { name: '添加图片', exact: true }).click();
  const fixture = JSON.parse(await readFile(legacyPath, 'utf8')) as TedDocument;
  const data = fixture.Layers.find((layer) => layer.Key === 'Image')!.Data as { Image: string };
  await page.locator('input[type=file][accept="image/*,.tif,.tiff"]').setInputFiles({
    name: 'synthetic.png',
    mimeType: 'image/png',
    buffer: Buffer.from(data.Image, 'base64'),
  });
  await expect(page.getByLabel('宽度', { exact: true })).toHaveValue('128');
  await expect(page.getByLabel('高度', { exact: true })).toHaveValue('128');
  await expect(page.getByLabel('保存时内嵌图片')).toBeChecked();
  const saved = await saveDocument(page);
  expect(saved.VersionCode).toBe(1);
  expect(saved.Layers).toHaveLength(6);
  expect(saved.Layers.find((layer) => layer.Id === 'variable-title')?.Data).toMatchObject({
    Color: '#f4e2b1ff',
    FontWeight: '600',
  });
  await page.getByRole('button', { name: '新建', exact: true }).click();
  await page.locator('input[type=file][accept=".ted,.json"]').setInputFiles({
    name: 'roundtrip.ted',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(saved)),
  });
  await expect(page.locator('.layer-row')).toHaveCount(6);
  expect(await saveDocument(page)).toMatchObject({ VersionCode: 1, Layers: saved.Layers });
});

test('validates table imports, keeps quoted and multiline fields, edits rows and imports CSV files', async ({
  page,
}) => {
  await fresh(page);
  await page.locator('.toolbar').getByRole('button', { name: '导入数据', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '导入数据' });
  await dialog.getByLabel('粘贴表格数据').fill('名称,名称\n甲,乙');
  await dialog.getByRole('button', { name: '导入表格', exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/重复列名/)).toBeVisible();
  await dialog
    .getByLabel('粘贴表格数据')
    .fill('名称,备注,编号\n"甲,乙","第一行\n第二行",0001\n丙,普通,0002');
  await dialog.getByRole('button', { name: '导入表格', exact: true }).click();
  await expect(page.getByLabel('第1行 名称', { exact: true })).toHaveValue('甲,乙');
  await expect(page.getByLabel('第1行 编号', { exact: true })).toHaveValue('0001');
  await page.getByLabel('第2行 名称', { exact: true }).fill('编辑后');
  await expect(page.getByLabel('第2行 名称', { exact: true })).toHaveValue('编辑后');
  await page.getByRole('button', { name: '＋ 添加行', exact: true }).click();
  await expect(page.getByLabel('第3行 名称', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: '删除第 2 行', exact: true }).click();
  await expect(page.getByRole('button', { name: '预览第 3 行', exact: true })).not.toBeVisible();
  await page.locator('input[type=file][accept=".csv,.tsv,.txt"]').setInputFiles({
    name: 'local.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('\uFEFF名称,编号\n本地导入,0009'),
  });
  await expect(page.getByLabel('第1行 名称', { exact: true })).toHaveValue('本地导入');
  await expect(page.getByLabel('第1行 编号', { exact: true })).toHaveValue('0009');
  await pasteTable(
    page,
    `名称\t编号\n${Array.from({ length: 70 }, (_, index) => `测试用户 ${index + 1}\t${String(index + 1).padStart(4, '0')}`).join('\n')}`,
  );
  await expect(page.getByLabel('第1行 名称', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.getByLabel('第51行 名称', { exact: true })).toHaveValue('测试用户 51');
  await page.getByRole('button', { name: '预览第 70 行', exact: true }).click();
  await expect(page.locator('.canvas-topline')).toContainText('数据行 70 / 70');
  await page.getByRole('button', { name: '删除第 70 行', exact: true }).click();
  await expect(page.locator('.canvas-topline')).toContainText('数据行 69 / 69');
  await page.getByRole('button', { name: '上一页', exact: true }).click();
  await expect(page.getByLabel('第1行 编号', { exact: true })).toHaveValue('0001');
});

test('reports malformed and unsupported templates without replacing the current document', async ({
  page,
}) => {
  const count = await page.locator('.layer-row').count();
  const upload = page.locator('input[type=file][accept=".ted,.json"]');
  await upload.setInputFiles({
    name: 'broken.ted',
    mimeType: 'application/json',
    buffer: Buffer.from('{ this is invalid'),
  });
  await expect(page.getByRole('status')).toContainText('打开失败');
  await expect(page.locator('.layer-row')).toHaveCount(count);
  await upload.setInputFiles({
    name: 'future.ted',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ VersionCode: 50, DocModel: {}, Layers: [] })),
  });
  await expect(page.getByRole('status')).toContainText('暂不支持');
  await expect(page.locator('.layer-row')).toHaveCount(count);
  await upload.setInputFiles({
    name: 'unknown-layer.ted',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({ DocModel: {}, Layers: [{ Id: 'unhandled', Key: 'Video' }] }),
    ),
  });
  await expect(page.getByRole('status')).toContainText('不支持的类型');
  await expect(page.locator('.layer-row')).toHaveCount(count);
  await upload.setInputFiles({
    name: 'unsafe-size.ted',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ DocModel: { Width: 10000, Height: 10000 }, Layers: [] })),
  });
  await expect(page.getByRole('status')).toContainText('6400 万像素');
  await expect(page.locator('.layer-row')).toHaveCount(count);
});

test('exports document-size PNG with transparent background and excludes editor selections', async ({
  page,
}) => {
  await fresh(page, 800, 600);
  await page.getByRole('button', { name: '添加矩形', exact: true }).click();
  await page.getByLabel('宽度', { exact: true }).fill('160');
  await page.getByLabel('高度', { exact: true }).fill('100');
  await page.getByLabel('填充颜色', { exact: true }).fill('#ff000080');
  await expect.poll(() => pixel(page, 120, 120)).toEqual([255, 0, 0, 128]);
  await expect(page.locator('.selection-box')).toBeVisible();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出当前', exact: true }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toMatch(/\.png$/);
  const png = await pngPixels(page, await downloadBytes(download), [
    [0, 0],
    [95, 95],
    [120, 120],
    [799, 599],
  ]);
  expect(png).toEqual({
    width: 800,
    height: 600,
    pixels: [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [255, 0, 0, 128],
      [0, 0, 0, 0],
    ],
  });
});

test('runs batch export with row ranges, filename variables and repeated data on one page', async ({
  page,
}) => {
  await fresh(page, 400, 200);
  await page.getByRole('button', { name: '添加矩形', exact: true }).click();
  await page.getByLabel('X', { exact: true }).fill('0');
  await page.getByLabel('Y', { exact: true }).fill('0');
  await page.getByLabel('宽度', { exact: true }).fill('60');
  await page.getByLabel('高度', { exact: true }).fill('60');
  await page.getByLabel('填充颜色', { exact: true }).fill('#32aa55');
  await pasteTable(page, '姓名,编号\n甲,001\n乙,002\n丙,003');
  await page.getByRole('button', { name: '批量导出', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '批量导出' });
  await dialog.getByLabel('导出文件名模板').fill('{index}_{姓名}');
  await dialog.getByLabel('起始行', { exact: true }).fill('1');
  await dialog.getByLabel('结束行', { exact: true }).fill('3');
  await dialog.getByLabel('额外副本数').fill('1');
  await dialog.getByLabel('X 偏移', { exact: true }).fill('100');
  await dialog.getByLabel('保存方式').selectOption('zip');
  await dialog.getByRole('button', { name: '开始导出', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText(/已完成：2 \/ 2 张/);
  const downloaded = page.waitForEvent('download');
  await dialog.getByRole('link', { name: /TEditor_01.zip/ }).click();
  const entries = unzipSync(await downloadBytes(await downloaded));
  expect(Object.keys(entries).sort()).toEqual(['1-2_甲.png', '3_丙.png']);
  const first = await pngPixels(page, Buffer.from(entries['1-2_甲.png']), [
    [10, 10],
    [110, 10],
    [210, 10],
  ]);
  const last = await pngPixels(page, Buffer.from(entries['3_丙.png']), [
    [10, 10],
    [110, 10],
  ]);
  expect(first).toEqual({
    width: 400,
    height: 200,
    pixels: [
      [50, 170, 85, 255],
      [50, 170, 85, 255],
      [0, 0, 0, 0],
    ],
  });
  expect(last.pixels).toEqual([
    [50, 170, 85, 255],
    [0, 0, 0, 0],
  ]);
});

test('recovers the local draft and table on reload without uploading document contents', async ({
  page,
}) => {
  const external: string[] = [];
  page.on('request', (request) => {
    if (/^https?:/.test(request.url()) && !request.url().startsWith('http://127.0.0.1:5173/'))
      external.push(request.url());
  });
  await fresh(page, 640, 360);
  await page.getByLabel('文件名', { exact: true }).fill('本机恢复.ted');
  await page.getByRole('button', { name: '添加文字', exact: true }).click();
  await page.getByLabel('文字内容', { exact: true }).fill('只保存在本地');
  await pasteTable(page, '姓名\t编号\n本地用户\t0042');
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('teditor-local', 1);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const saved = await new Promise<{ name: string; table: { rows: unknown[] } } | undefined>(
          (resolve, reject) => {
            const request = database.transaction('draft').objectStore('draft').get('current');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          },
        );
        database.close();
        return { name: saved?.name, rows: saved?.table?.rows?.length };
      }),
    )
    .toEqual({ name: '本机恢复.ted', rows: 1 });
  await page.reload();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true');
  await expect(page.getByLabel('文件名', { exact: true })).toHaveValue('本机恢复.ted');
  await expect(page.getByLabel('模板画布', { exact: true })).toHaveAttribute('width', '640');
  await expect(page.getByLabel('第1行 编号', { exact: true })).toHaveValue('0042');
  await page.getByRole('button', { name: '选择图层 文字 1', exact: true }).click();
  await expect(page.getByLabel('文字内容', { exact: true })).toHaveValue('只保存在本地');
  expect(external).toEqual([]);
});
