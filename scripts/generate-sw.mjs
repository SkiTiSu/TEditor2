import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const files = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
  ...(await readdir('dist/assets')).map((f) => './assets/' + f),
];
const hash = createHash('sha256')
  .update(await readFile('dist/index.html'))
  .digest('hex')
  .slice(0, 12);
await writeFile(
  'dist/sw.js',
  `const CACHE='teditor-${hash}';
const FILES=${JSON.stringify(files)};
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const previous = (await caches.keys()).filter(key => key.startsWith('teditor-') && key !== CACHE);
    // Keep the preceding bundle available to tabs that have not reloaded yet.
    await Promise.all(previous.slice(0, -1).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  if (event.request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(event.request, { cache: 'no-store' });
        if (response.ok) return response;
      } catch {}
      // Use the installed version's complete bundle when the server is unavailable.
      const cache = await caches.open(CACHE);
      return (await cache.match('./index.html')) || Response.error();
    })());
    return;
  }
  event.respondWith(caches.match(event.request, { ignoreVary: true }).then(hit => hit || fetch(event.request)));
});
`,
);
