import { readFile, readdir, writeFile } from 'node:fs/promises';
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
let output = 'TEditor2 — third-party runtime software notices\n\n';
for (const [path, entry] of Object.entries(lock.packages)) {
  if (!path.startsWith('node_modules/') || entry.dev) continue;
  const pkg = JSON.parse(await readFile(`${path}/package.json`, 'utf8'));
  output += `\n${'='.repeat(72)}\n${pkg.name} ${pkg.version}\nLicense: ${pkg.license || 'See included notice'}\n${'='.repeat(72)}\n\n`;
  const files = (await readdir(path)).filter((name) => /^(licen[sc]e|notice)(\.|$)/i.test(name));
  for (const file of files) output += (await readFile(`${path}/${file}`, 'utf8')) + '\n\n';
  if (!files.length) throw new Error(`Missing license notice for ${pkg.name}`);
}
output +=
  '\nToolGood.Algorithm v2 compatibility fixture license (fixtures, not runtime engine):\n\n' +
  (await readFile('src/vendor/toolgood/LICENSE', 'utf8'));
await writeFile('public/THIRD_PARTY_NOTICES.txt', output.replace(/[ \t]+$/gm, ''));
