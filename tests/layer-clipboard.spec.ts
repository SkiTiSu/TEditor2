import { test, expect } from '@playwright/test';

test('native copy and paste preserve a layer snapshot across documents and respect text inputs', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto('/');
  await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true');
  await page.getByRole('button', { name: '新建', exact: true }).click();
  await page.getByRole('button', { name: '添加矩形', exact: true }).click();
  await page.getByLabel('图层名称').fill('剪贴板快照');
  await page.getByLabel('X', { exact: true }).fill('120');
  await page.locator('.layer-row.selected').focus();
  await page.keyboard.press('ControlOrMeta+c');
  await expect(page.locator('.layer-row')).toHaveCount(1);
  await page.getByLabel('图层名称').fill('原图层已修改');
  await page.locator('.layer-row.selected').focus();
  await page.keyboard.press('ControlOrMeta+v');
  await expect(page.locator('.layer-row')).toHaveCount(2);
  await expect(page.getByLabel('图层名称')).toHaveValue('剪贴板快照 副本');
  await expect(page.getByLabel('X', { exact: true })).toHaveValue('140');
  await page.locator('.layer-row.selected').focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('.layer-row')).toHaveCount(1);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(page.locator('.layer-row')).toHaveCount(2);
  await page.getByRole('button', { name: '新建', exact: true }).click();
  await page.locator('.brand').focus();
  await page.keyboard.press('ControlOrMeta+v');
  await expect(page.locator('.layer-row')).toHaveCount(1);
  await expect(page.getByLabel('图层名称')).toHaveValue('剪贴板快照 副本');
  const name = page.getByLabel('图层名称');
  await name.fill('普通文字');
  await name.press('ControlOrMeta+a');
  await name.press('ControlOrMeta+c');
  await name.fill('');
  await name.press('ControlOrMeta+v');
  await expect(name).toHaveValue('普通文字');
  await expect(page.locator('.layer-row')).toHaveCount(1);
  await page.locator('.layer-row.selected').focus();
  await page.keyboard.press('ControlOrMeta+v');
  await expect(page.locator('.layer-row')).toHaveCount(1);
  await page.getByRole('button', { name: '复制到剪贴板', exact: true }).click();
  await page.getByRole('button', { name: '粘贴图层', exact: true }).click();
  await expect(page.locator('.layer-row')).toHaveCount(2);
  await page.setViewportSize({ width: 1100, height: 740 });
  expect(await page.locator('.layer-actions').evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(
    true,
  );
  expect(errors).toEqual([]);
});
