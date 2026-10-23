import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VideoProject } from '../src/video/types';

async function pixel(canvas: Locator) {
  return canvas.evaluate((element: HTMLCanvasElement) =>
    [
      ...element
        .getContext('2d')!
        .getImageData(Math.floor(element.width / 2), Math.floor(element.height / 2), 1, 1).data,
    ].slice(0, 3),
  );
}
async function openVideo(page: Page) {
  await page.getByRole('button', { name: '视频剪辑', exact: true }).click();
  await expect(page.locator('.video-editor')).toBeVisible();
  await expect(page.locator('.video-editor')).toHaveAttribute('data-ready', 'true');
}
async function associate(page: Page) {
  const video = page.locator('.video-editor');
  await video.getByRole('button', { name: '关联图片', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '关联图片到视频' });
  await dialog.getByLabel('图片生成方式').selectOption('current');
  await dialog.getByRole('button', { name: '添加关联图片', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await video.getByRole('button', { name: '插入', exact: true }).click();
}
async function saveProject(page: Page): Promise<VideoProject> {
  const pending = page.waitForEvent('download');
  await page
    .locator('.video-editor')
    .getByRole('button', { name: '保存工程', exact: true })
    .click();
  const download = await pending;
  return JSON.parse(await readFile((await download.path())!, 'utf8')) as VideoProject;
}

test('real directory resources stay isolated across graphic editing, project save, and draft reload', async ({
  page,
}, testInfo) => {
  const temporary = await mkdtemp(join(tmpdir(), 'teditor-graphic-ui-'));
  const exceptions: string[] = [];
  page.on('pageerror', (error) => exceptions.push(error.message));
  page.on('dialog', (dialog) => dialog.accept());
  try {
    await page.goto('/');
    await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true');
    const fixture = await page.evaluate(async () => {
      const modulePath = '/src/core/document.ts';
      const { createDocument, createLayer } = await import(modulePath);
      const doc = createDocument(320, 180),
        layer = createLayer('Image');
      Object.assign(layer.Data, {
        Width: 320,
        Height: 180,
        ImageUrl: 'same.png',
        EmbedImage: false,
        Image: '',
      });
      doc.Layers.push(layer);
      const images = ['#ff0000', '#0000ff'].map((color) => {
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 180;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 320, 180);
        return canvas.toDataURL('image/png').split(',')[1];
      });
      return { document: JSON.stringify(doc), images };
    });
    const redDirectory = join(temporary, 'red', 'shared'),
      blueDirectory = join(temporary, 'blue', 'shared');
    await Promise.all([
      mkdir(redDirectory, { recursive: true }),
      mkdir(blueDirectory, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(redDirectory, 'same.png'), Buffer.from(fixture.images[0], 'base64')),
      writeFile(join(blueDirectory, 'same.png'), Buffer.from(fixture.images[1], 'base64')),
    ]);
    const imageEditor = page.locator('.app-shell'),
      video = page.locator('.video-editor');
    const templateInput = imageEditor.locator('input[accept=".ted,.json"]');
    await templateInput.setInputFiles({
      name: '红色方案.ted',
      mimeType: 'application/json',
      buffer: Buffer.from(fixture.document),
    });
    await imageEditor.locator('input[webkitdirectory]').setInputFiles(redDirectory);
    await expect.poll(() => pixel(imageEditor.getByLabel('模板画布'))).toEqual([255, 0, 0]);
    await openVideo(page);
    await associate(page);
    await expect(video.locator('.ve-asset')).toHaveCount(1);
    await expect.poll(() => pixel(video.getByLabel('视频合成画布'))).toEqual([255, 0, 0]);
    const firstProject = await saveProject(page),
      firstResource = firstProject.graphics[0].resources!.find(
        (resource) => resource.path === 'shared/same.png',
      )!;
    expect(firstResource.path).toBe('shared/same.png');

    await video.getByRole('button', { name: '图片设计', exact: true }).click();
    // Opening a new image design explicitly unlinks the previous scheme before replacing same-path assets.
    await templateInput.setInputFiles({
      name: '蓝色方案.ted',
      mimeType: 'application/json',
      buffer: Buffer.from(fixture.document),
    });
    await expect(imageEditor.getByLabel('文件名')).toHaveValue('蓝色方案.ted');
    await imageEditor.locator('input[webkitdirectory]').setInputFiles(blueDirectory);
    await expect.poll(() => pixel(imageEditor.getByLabel('模板画布'))).toEqual([0, 0, 255]);
    await openVideo(page);
    await associate(page);
    await expect(video.locator('.ve-asset')).toHaveCount(2);
    await expect
      .poll(() => pixel(video.locator('.ve-asset').nth(0).locator('canvas')))
      .toEqual([255, 0, 0]);
    await expect
      .poll(() => pixel(video.locator('.ve-asset').nth(1).locator('canvas')))
      .toEqual([0, 0, 255]);
    const timeline = video.getByLabel('时间线编辑区');
    await timeline.focus();
    await timeline.press('Home');
    await expect.poll(() => pixel(video.getByLabel('视频合成画布'))).toEqual([0, 0, 255]);
    await timeline.press('End');
    await expect.poll(() => pixel(video.getByLabel('视频合成画布'))).toEqual([255, 0, 0]);
    const beforeEditing = await saveProject(page);
    expect(beforeEditing.graphics).toHaveLength(2);
    expect(
      beforeEditing.graphics[0].resources!.find((resource) => resource.path === firstResource.path)!
        .id,
    ).toBe(firstResource.id);
    expect(
      beforeEditing.graphics[1].resources!.find((resource) => resource.path === firstResource.path)!
        .id,
    ).not.toBe(firstResource.id);
    expect(JSON.stringify(beforeEditing)).not.toContain('data:image');

    await video.locator('.ve-asset').first().click();
    await video.getByRole('button', { name: /^编辑关联图片（/ }).click();
    await expect(imageEditor).toBeVisible();
    await expect.poll(() => pixel(imageEditor.getByLabel('模板画布'))).toEqual([255, 0, 0]);
    await openVideo(page);
    await expect
      .poll(() => pixel(video.locator('.ve-asset').nth(0).locator('canvas')))
      .toEqual([255, 0, 0]);
    await expect
      .poll(() => pixel(video.locator('.ve-asset').nth(1).locator('canvas')))
      .toEqual([0, 0, 255]);
    const afterEditing = await saveProject(page);
    expect(afterEditing.graphics[1]).toEqual(beforeEditing.graphics[1]);
    expect(afterEditing.graphics[0].resources).toEqual(beforeEditing.graphics[0].resources);
    await expect(video.locator('.ve-workbar-status')).toContainText('视频草稿已保存在本机');
    await page.reload();
    await expect(imageEditor).toHaveAttribute('data-ready', 'true');
    await openVideo(page);
    await expect(video.locator('.ve-asset')).toHaveCount(2);
    await expect
      .poll(() => pixel(video.locator('.ve-asset').nth(0).locator('canvas')))
      .toEqual([255, 0, 0]);
    await expect
      .poll(() => pixel(video.locator('.ve-asset').nth(1).locator('canvas')))
      .toEqual([0, 0, 255]);
    await video.getByLabel('时间线编辑区').focus();
    await video.getByLabel('时间线编辑区').press('Home');
    await expect.poll(() => pixel(video.getByLabel('视频合成画布'))).toEqual([0, 0, 255]);
    await video.getByLabel('时间线编辑区').press('End');
    await expect.poll(() => pixel(video.getByLabel('视频合成画布'))).toEqual([255, 0, 0]);
    const restored = await saveProject(page);
    expect(restored.graphics.map((source) => source.resources)).toEqual(
      afterEditing.graphics.map((source) => source.resources),
    );
    expect(JSON.stringify(restored)).not.toContain('data:image');
    expect(exceptions).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath('isolated-graphic-resources.png'),
      fullPage: true,
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
