import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';

test('an old cached app upgrades on reload and retains the local draft and offline support', async ({
  page,
  context,
}) => {
  const files = new Map<string, Buffer>();
  for (const name of [
    'index.html',
    'sw.js',
    'manifest.webmanifest',
    'icon.svg',
    ...(await readdir(new URL('../dist/assets/', import.meta.url))).map((name) => `assets/${name}`),
  ]) {
    files.set('/' + name, await readFile(new URL('../dist/' + name, import.meta.url)));
  }
  const currentHtml = files.get('/index.html')!.toString();
  const legacyHtml = currentHtml.replace(
    '</head>',
    '<meta name="test-release" content="legacy"><style>.color-field input[type="color"]{width:21px!important;height:23px!important;padding:6px 8px!important}</style></head>',
  );
  const legacyWorker = `const CACHE='teditor-legacy-test';
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(['/','/index.html'])).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('fetch',event=>event.respondWith(caches.match(event.request).then(hit=>hit||fetch(event.request))));`;
  let published = false;
  const server = createServer((request, response) => {
    const pathname = new URL(request.url!, 'http://localhost').pathname;
    const path = pathname === '/' ? '/index.html' : pathname;
    const body =
      !published && path === '/index.html'
        ? legacyHtml
        : !published && path === '/sw.js'
          ? legacyWorker
          : files.get(path);
    if (!body) {
      response.writeHead(404).end();
      return;
    }
    const type = path.endsWith('.js')
      ? 'text/javascript'
      : path.endsWith('.css')
        ? 'text/css'
        : path.endsWith('.html')
          ? 'text/html; charset=utf-8'
          : path.endsWith('.svg')
            ? 'image/svg+xml'
            : 'application/json';
    response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/`;
  try {
    await page.goto(url);
    await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true');
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await page.getByRole('button', { name: '添加矩形', exact: true }).click();
    await page.getByLabel('图层名称').fill('升级后保留的草稿');
    await page.getByLabel('填充颜色', { exact: true }).fill('#20394e');
    expect(
      await page.getByLabel('填充颜色选择').evaluate((el) => el.getBoundingClientRect().width),
    ).toBe(21);
    await expect(page.getByText('草稿已保存在本机', { exact: true })).toBeVisible();
    page.on('dialog', (dialog) => dialog.accept());
    await page.reload();
    await expect(page.locator('meta[name="test-release"]')).toHaveAttribute('content', 'legacy');

    // Publish while the old app is still open, as happens with a long-lived preview tab.
    published = true;
    await page.evaluate(async () => {
      const changed = new Promise<void>((resolve) =>
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), {
          once: true,
        }),
      );
      await (await navigator.serviceWorker.ready).update();
      await changed;
    });
    // Updating the cache must not reload or interrupt an editor that is already open.
    await expect(page.locator('meta[name="test-release"]')).toHaveAttribute('content', 'legacy');
    await page.reload();
    await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true');
    await expect(page.locator('meta[name="test-release"]')).toHaveCount(0);
    await page.getByRole('button', { name: '选择图层 升级后保留的草稿', exact: true }).click();
    await expect(page.getByLabel('填充颜色', { exact: true })).toHaveValue('#20394e');
    expect(
      await page.getByLabel('填充颜色选择').evaluate((el) => el.getBoundingClientRect().width),
    ).toBe(36);
    await expect(page.locator('.layer-row')).toHaveCount(19);

    await context.setOffline(true);
    await page.reload();
    await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true');
    await expect(page.locator('meta[name="test-release"]')).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: '选择图层 升级后保留的草稿', exact: true }),
    ).toBeVisible();
  } finally {
    await context.setOffline(false);
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('production app reloads, edits and exports after the network is offline', async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://127.0.0.1:4173');
  await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('.layer-row')).toHaveCount(18);
  await page.getByRole('button', { name: '添加矩形', exact: true }).click();
  await expect(page.locator('.layer-row')).toHaveCount(19);
  await page.getByLabel('宽度', { exact: true }).fill('222');
  await expect(page.getByLabel('宽度', { exact: true })).toHaveValue('222');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出当前', exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/\.png$/);
  expect(errors).toEqual([]);
  await context.setOffline(false);
});
