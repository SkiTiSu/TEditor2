import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import {
  createDocument,
  createLayer,
  normalizeLayerOrder,
  serializeDocument,
} from '../src/core/document';

const errors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  errors.set(page, []);
  page.on('pageerror', (error) => errors.get(page)!.push(error.message));
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto('/');
  await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true');
  const doc = createDocument(320, 200);
  const red = createLayer('Rectangle'),
    blue = createLayer('Rectangle'),
    text = createLayer('Text');
  for (const [layer, color] of [
    [red, '#ff0000'],
    [blue, '#0000ff'],
  ] as const) {
    layer.Left = 8;
    layer.Top = 8;
    Object.assign(layer.Data, { Width: 40, Height: 40, FillColor: color });
  }
  text.Left = 8;
  text.Top = 64;
  Object.assign(text.Data, {
    Text: '静态',
    FontFamilyName: 'Arial',
    FontSize: 18,
    Color: '#111111',
    VariableEnable: true,
    VariableTemplate: '{名称}',
  });
  doc.Layers = [text, blue, red];
  normalizeLayerOrder(doc);
  doc.DocModel.FormatConditionGroups = [
    {
      Name: '行颜色',
      Color: '#6699ff',
      EffctiveLayers: [red.Id, blue.Id],
      FormatConditionModels: [
        { Name: '默认', Condition: '', LayersVisable: { [red.Id]: true, [blue.Id]: false } },
        {
          Name: '蓝色',
          Condition: '[等级]="blue"',
          LayersVisable: { [red.Id]: false, [blue.Id]: true },
        },
      ],
    },
  ];
  await page
    .locator('input[type="file"][accept=".ted,.json"]')
    .setInputFiles({
      name: '预览测试.ted',
      mimeType: 'application/json',
      buffer: Buffer.from(serializeDocument(doc)),
    });
  await expect(page.getByLabel('模板画布', { exact: true })).toHaveAttribute('width', '320');
});
test.afterEach(async ({ page }) => expect(errors.get(page)).toEqual([]));

async function importRows(page: Page) {
  await page.locator('.toolbar').getByRole('button', { name: '导入数据', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '导入数据' });
  await dialog
    .getByLabel('粘贴表格数据')
    .fill('名称\t等级\nA\tred\nB\tblue\nC\tred\nD\tblue\nE\tred');
  await dialog.getByRole('button', { name: '导入表格', exact: true }).click();
}
async function colors(page: Page, points: number[][]) {
  return page.getByLabel('同页排版预览画布', { exact: true }).evaluate((element, points) => {
    const context = (element as HTMLCanvasElement).getContext('2d')!;
    return points.map(([x, y]) => Array.from(context.getImageData(x, y, 1, 1).data));
  }, points);
}
async function fingerprint(page: Page, label: string) {
  return page.getByLabel(label, { exact: true }).evaluate(async (element) => {
    const canvas = element as HTMLCanvasElement;
    const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', pixels))).join(
      ',',
    );
    return { width: canvas.width, height: canvas.height, hash };
  });
}

test('live offsets, variable rows and last-page preview match exported PNG pixels exactly', async ({
  page,
}) => {
  await importRows(page);
  const editorBefore = await fingerprint(page, '模板画布');
  let downloads = 0;
  page.on('download', () => downloads++);
  await page.getByRole('button', { name: '批量导出', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '批量导出' });
  const canvas = dialog.getByLabel('同页排版预览画布');
  await dialog.getByLabel('额外副本数').fill('1');
  await expect(dialog.getByText('X、Y 偏移均为 0，副本会重叠。调整偏移即可展开。')).toBeVisible();
  await dialog.getByLabel('X 偏移', { exact: true }).fill('100');
  await expect(canvas).toHaveAttribute('data-ready', 'true');
  await expect
    .poll(() =>
      colors(page, [
        [10, 10],
        [110, 10],
        [210, 10],
      ]),
    )
    .toEqual([
      [255, 0, 0, 255],
      [0, 0, 255, 255],
      [0, 0, 0, 0],
    ]);
  await dialog.getByLabel('Y 偏移', { exact: true }).fill('50');
  await expect
    .poll(() =>
      colors(page, [
        [110, 10],
        [110, 60],
      ]),
    )
    .toEqual([
      [0, 0, 0, 0],
      [0, 0, 255, 255],
    ]);
  await dialog.getByLabel('Y 偏移', { exact: true }).fill('0');
  await expect.poll(() => colors(page, [[110, 10]])).toEqual([[0, 0, 255, 255]]);
  const first = await fingerprint(page, '同页排版预览画布');
  await expect(dialog.getByLabel('预览页码')).toHaveText('第 1 / 3 页');
  await dialog.getByRole('button', { name: '预览下一页' }).click();
  await dialog.getByRole('button', { name: '预览下一页' }).click();
  await expect(dialog.getByText('数据第 5 行 · 本页 1 条')).toBeVisible();
  await expect(canvas).toHaveAttribute('data-ready', 'true');
  await expect
    .poll(() =>
      colors(page, [
        [10, 10],
        [110, 10],
      ]),
    )
    .toEqual([
      [255, 0, 0, 255],
      [0, 0, 0, 0],
    ]);
  const last = await fingerprint(page, '同页排版预览画布');
  expect(last.hash).not.toBe(first.hash);
  expect(await fingerprint(page, '模板画布')).toEqual(editorBefore);
  expect(downloads).toBe(0);
  await dialog.getByLabel('导出文件名模板').fill('{index}');
  await dialog.getByLabel('保存方式').selectOption('zip');
  await dialog.getByRole('button', { name: '开始导出', exact: true }).click();
  await expect(dialog.locator('.export-message')).toContainText('已完成：3 / 3');
  const download = page.waitForEvent('download');
  await dialog.getByRole('link', { name: /TEditor_01.zip/ }).click();
  const files = unzipSync(await readFile((await (await download).path())!));
  for (const [filename, expected] of [
    ['1-2.png', first],
    ['5.png', last],
  ] as const) {
    const result = await page.evaluate(async (data) => {
      const image = new Image();
      image.src = 'data:image/png;base64,' + data;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      const hash = Array.from(
        new Uint8Array(
          await crypto.subtle.digest(
            'SHA-256',
            context.getImageData(0, 0, canvas.width, canvas.height).data,
          ),
        ),
      ).join(',');
      return { width: canvas.width, height: canvas.height, hash };
    }, Buffer.from(files[filename]).toString('base64'));
    expect(result).toEqual(expected);
  }
});

test('range changes reset paging, invalid settings hide stale preview, and negative offsets clip', async ({
  page,
}) => {
  await importRows(page);
  await page.getByRole('button', { name: '批量导出', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '批量导出' });
  await dialog.getByLabel('额外副本数').fill('1');
  await dialog.getByRole('button', { name: '预览下一页' }).click();
  await dialog.getByLabel('起始行', { exact: true }).fill('2');
  await dialog.getByLabel('结束行', { exact: true }).fill('4');
  await expect(dialog.getByLabel('预览页码')).toHaveText('第 1 / 2 页');
  await expect(dialog.getByText('数据第 2–3 行 · 本页 2 条')).toBeVisible();
  await dialog.getByLabel('X 偏移', { exact: true }).fill('-20');
  await expect
    .poll(() =>
      colors(page, [
        [1, 10],
        [10, 10],
        [30, 10],
      ]),
    )
    .toEqual([
      [255, 0, 0, 255],
      [255, 0, 0, 255],
      [0, 0, 255, 255],
    ]);
  await dialog.getByLabel('起始行', { exact: true }).fill('5');
  await expect(dialog.getByRole('alert')).toContainText('导出范围无效');
  await expect(dialog.getByLabel('同页排版预览画布')).toBeHidden();
  await expect(dialog.getByRole('button', { name: '开始导出', exact: true })).toBeDisabled();
  await dialog.getByLabel('起始行', { exact: true }).fill('1');
  await dialog.getByLabel('额外副本数').fill('1.5');
  await expect(dialog.getByRole('alert')).toContainText('副本个数必须为整数');
  await dialog.getByLabel('额外副本数').fill('2');
  await expect(dialog.getByLabel('同页排版预览画布')).toHaveAttribute('data-ready', 'true');
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '开始导出', exact: true })).toBeEnabled();
});

test('a template without rows previews once and the dialog remains usable in a smaller desktop window', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 720 });
  await page.getByRole('button', { name: '批量导出', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '批量导出' });
  await expect(dialog.getByText('无表格数据 · 使用当前模板')).toBeVisible();
  await dialog.getByLabel('额外副本数').fill('4');
  const canvas = dialog.getByLabel('同页排版预览画布');
  await expect(canvas).toHaveAttribute('data-ready', 'true');
  await expect(dialog.getByLabel('预览页码')).toHaveText('第 1 / 1 页');
  await expect(dialog.getByRole('button', { name: '预览下一页' })).toBeDisabled();
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const size = await canvas.boundingBox();
  expect(size).not.toBeNull();
  expect(size!.width / size!.height).toBeCloseTo(320 / 200, 1);
  await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: '批量导出', exact: true }).click();
  await expect(page.getByLabel('同页排版预览画布', { exact: true })).toHaveAttribute(
    'data-ready',
    'true',
  );
});
