import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createClip, createProject, createSequence } from '../src/video/model';
import type { MediaAsset, VideoProject } from '../src/video/types';

async function openVideo(page: Page) {
  await page.goto('/');
  await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true');
  await page.getByRole('button', { name: '视频剪辑', exact: true }).click();
  await expect(page.locator('.video-editor')).toHaveAttribute('data-ready', 'true');
}
async function save(page: Page): Promise<VideoProject> {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '保存工程', exact: true }).click();
  return JSON.parse(await readFile((await (await pending).path())!, 'utf8'));
}
test('asset Delete is scoped to the library, protects used references and supports undo', async ({
  page,
}) => {
  await openVideo(page);
  const p = createProject(),
    s = p.sequences[0];
  const a: MediaAsset = {
    id: 'used',
    name: '被使用的色块',
    kind: 'color',
    color: '#ff0000',
    duration: 0,
    hasAudio: false,
    width: 320,
    height: 180,
  };
  p.assets = [a, { ...a, id: 'unused', name: '未使用的色块' }];
  s.clips.push(createClip(a, s.tracks[0].id, 0, 120, s));
  p.sequences.push(createSequence('另外一条'));
  p.sequences[1].clips.push(createClip(a, p.sequences[1].tracks[0].id, 0, 120, p.sequences[1]));
  await page
    .locator('input[accept=".tevideo,.json"]')
    .setInputFiles({
      name: 'asset.tevideo',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(p)),
    });
  await page.locator('.vtl-clip').click();
  await page.getByRole('button', { name: '素材 未使用的色块', exact: true }).click();
  await page.keyboard.press('Delete');
  await expect(page.locator('.ve-asset')).toHaveCount(1);
  await expect(page.locator('.vtl-clip')).toHaveCount(1);
  await page.getByRole('button', { name: '素材 被使用的色块', exact: true }).click();
  page.once('dialog', (d) => d.dismiss());
  await page.keyboard.press('Delete');
  await expect(page.locator('.ve-asset')).toHaveCount(1);
  await expect(page.locator('.vtl-clip')).toHaveCount(1);
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: '删除选中素材' }).click();
  await expect(page.locator('.ve-asset')).toHaveCount(0);
  expect((await save(page)).sequences.every((seq) => !seq.clips.length)).toBe(true);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('.ve-asset')).toHaveCount(1);
  await expect(page.locator('.vtl-clip')).toHaveCount(1);
  await page.locator('.vtl-clip').click();
  await page.keyboard.press('Delete');
  await expect(page.locator('.vtl-clip')).toHaveCount(0);
  await expect(page.locator('.ve-asset')).toHaveCount(1);
});

test('continuous audio peaks retain short pulses and draw a dense waveform at different zooms', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openVideo(page);
  const encoded = await page.evaluate(async () => {
    const path = '/tests/video-media-fixtures.ts';
    const { makeWav } = await import(path);
    const bytes = await makeWav(12).arrayBuffer(),
      data = new DataView(bytes);
    for (let i = 0; i < 12 * 44100; i++) {
      const t = i / 44100;
      const gain =
        t > 1 && t < 1.5
          ? 0
          : t > 2.003 && t < 2.009
            ? 1
            : 0.1 + 0.55 * Math.abs(Math.sin(t * 8.2)) * Math.abs(Math.sin(t * 2.3));
      data.setInt16(44 + i * 2, Math.round(32767 * gain * Math.sin(2 * Math.PI * 880 * t)), true);
    }
    const file = new Blob([bytes], { type: 'audio/wav' });
    return await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.readAsDataURL(file);
    });
  });
  await page
    .getByLabel('导入视频素材文件')
    .setInputFiles({
      name: '动态波形.wav',
      mimeType: 'audio/wav',
      buffer: Buffer.from(encoded, 'base64'),
    });
  await expect(page.getByRole('button', { name: '素材 动态波形.wav', exact: true })).toBeVisible();
  await expect(page.getByText('正在生成音频波形…')).not.toBeVisible();
  const asset = (await save(page)).assets[0];
  expect(asset.waveformVersion).toBe(1);
  expect(asset.waveform).toHaveLength(1200);
  expect(asset.waveform!.slice(110, 140).every((v) => v === 0)).toBe(true);
  expect(asset.waveform![200]).toBeGreaterThan(0.95);
  await page.getByRole('button', { name: '素材 动态波形.wav', exact: true }).click();
  await page.getByRole('button', { name: '插入', exact: true }).click();
  const wave = page.locator('.vtl-kind-audio .vtl-wave');
  await expect(wave).toBeVisible();
  await expect(wave.locator('line')).toHaveCount(0);
  expect(Number(await wave.getAttribute('data-waveform-points'))).toBeGreaterThan(300);
  await page.getByRole('button', { name: '放大时间线', exact: true }).click();
  expect(Number(await wave.getAttribute('data-waveform-points'))).toBeGreaterThan(450);
  await page.screenshot({ path: testInfo.outputPath('dense-waveform.png') });
  expect(errors).toEqual([]);
});
