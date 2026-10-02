import { expect, test } from '@playwright/test';

test('all font families are searchable and each authorized page load refreshes newly installed fonts', async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    let calls = 0;
    const permissionsQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = ((descriptor: PermissionDescriptor) =>
      descriptor.name === ('local-fonts' as PermissionName)
        ? Promise.resolve({
            state: localStorage.getItem('test-font-authorized') ? 'granted' : 'prompt',
          })
        : permissionsQuery(descriptor)) as typeof navigator.permissions.query;
    Object.defineProperty(window, 'testFontQueries', { get: () => calls });
    Object.defineProperty(window, 'queryLocalFonts', {
      configurable: true,
      value: async () => {
        calls++;
        localStorage.setItem('test-font-authorized', 'true');
        if (localStorage.getItem('test-font-installed')) return [{ family: '新安装字体' }];
        return Array.from({ length: 500 }, (_, i) => ({
          family: `测试字体 ${String(i).padStart(3, '0')}`,
        })).flatMap((font) => [font, { ...font }]);
      },
    });
  });
  await page.goto('/');
  await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true');
  await page.getByRole('button', { name: '添加文字', exact: true }).click();
  const layerName = await page.getByLabel('图层名称').inputValue();
  await page.getByRole('button', { name: '展开字体列表' }).click();
  const list = page.getByLabel('可用字体', { exact: true });
  await page.getByRole('button', { name: '读取本机字体', exact: true }).click();
  await expect(
    page.getByText('已读取 500 个本机字体家族（1000 个字形），展开字体列表即可选择'),
  ).toBeVisible();
  await expect(list.locator('option')).toHaveCount(508);
  await expect(list.locator('option').filter({ hasText: '测试字体 499' })).toHaveCount(1);
  await page.getByLabel('搜索字体').fill('480');
  await expect(list.locator('option')).toHaveCount(1);
  await list.selectOption('测试字体 480');
  await expect(page.getByLabel('字体', { exact: true })).toHaveValue('测试字体 480');
  await expect(list).toBeHidden();
  await page.getByRole('button', { name: '展开字体列表' }).click();
  await expect(page.getByLabel('搜索字体')).toHaveValue('');
  await expect(list.locator('option')).toHaveCount(507);
  await page.locator('.font-picker').screenshot({ path: testInfo.outputPath('font-picker.png') });
  await page.getByLabel('搜索字体').fill('不存在的字体');
  await expect(page.getByText('没有匹配的字体。也可在上方直接输入字体名称。')).toBeVisible();
  await page.getByLabel('搜索字体').press('Escape');
  await expect(page.getByRole('button', { name: '展开字体列表' })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await expect(page.getByText('草稿已保存在本机', { exact: true })).toBeVisible();
  page.on('dialog', (dialog) => dialog.accept());
  await page.evaluate(() => localStorage.setItem('test-font-installed', 'true'));
  await page.reload();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true');
  await page.getByRole('button', { name: '选择图层 ' + layerName, exact: true }).click();
  await page.getByRole('button', { name: '展开字体列表' }).click();
  await expect(list.locator('option').filter({ hasText: '新安装字体' })).toHaveCount(1);
  await expect(list.locator('option').filter({ hasText: '测试字体 499' })).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as unknown as { testFontQueries: number }).testFontQueries),
  ).toBe(1);
  await page.evaluate(() =>
    Object.defineProperty(window, 'queryLocalFonts', {
      configurable: true,
      value: async () => [{ family: '页面打开期间安装的字体' }],
    }),
  );
  await page.getByRole('button', { name: '读取本机字体', exact: true }).click();
  await expect(list.locator('option').filter({ hasText: '页面打开期间安装的字体' })).toHaveCount(1);
  await expect(list.locator('option').filter({ hasText: '测试字体 499' })).toHaveCount(0);
  await expect(page.getByLabel('字体', { exact: true })).toHaveValue('测试字体 480');
});

test('a failed authorized automatic refresh retains cached font names as a fallback', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem('teditor.local-font-families', JSON.stringify(['之前读取的字体']));
    const query = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = ((descriptor: PermissionDescriptor) =>
      descriptor.name === ('local-fonts' as PermissionName)
        ? Promise.resolve({ state: 'granted' })
        : query(descriptor)) as typeof navigator.permissions.query;
    Object.defineProperty(window, 'queryLocalFonts', {
      value: async () => {
        throw new DOMException('需要用户操作', 'SecurityError');
      },
    });
  });
  await page.goto('/');
  await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true');
  await page.getByRole('button', { name: '添加文字', exact: true }).click();
  await page.getByRole('button', { name: '展开字体列表' }).click();
  await expect(
    page.getByText('自动读取暂不可用，已保留上次列表；可点击“读取本机字体”更新。'),
  ).toBeVisible();
  await expect(
    page.getByLabel('可用字体').locator('option').filter({ hasText: '之前读取的字体' }),
  ).toHaveCount(1);
});

test('font permission rejection and an invalid font cache leave manual font entry usable', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem('teditor.local-font-families', '{broken');
    Object.defineProperty(window, 'queryLocalFonts', {
      value: async () => {
        throw new DOMException('用户未允许字体访问', 'NotAllowedError');
      },
    });
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true');
  await page.getByRole('button', { name: '添加文字', exact: true }).click();
  await page.getByRole('button', { name: '展开字体列表' }).click();
  await page.getByRole('button', { name: '读取本机字体', exact: true }).click();
  await expect(page.getByText('字体访问：用户未允许字体访问')).toBeVisible();
  await page.getByLabel('字体', { exact: true }).fill('自定义字体');
  await expect(page.getByLabel('字体', { exact: true })).toHaveValue('自定义字体');
  await expect(
    page.getByLabel('可用字体').locator('option').filter({ hasText: 'Arial' }),
  ).toHaveCount(1);
  expect(errors).toEqual([]);
});
