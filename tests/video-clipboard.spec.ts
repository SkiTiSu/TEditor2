import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createClip, createProject } from '../src/video/model';
import type { MediaAsset, VideoProject } from '../src/video/types';

test('native timeline clipboard copies multiple clips and linked audio at the playhead with undo and text isolation', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true');
  await page.getByRole('button', { name: '视频剪辑', exact: true }).click();
  const video = page.locator('.video-editor');
  await expect(video).toHaveAttribute('data-ready', 'true');
  const project = createProject(),
    sequence = project.sequences[0];
  const asset: MediaAsset = {
    id: 'video',
    name: '源视频',
    kind: 'video',
    duration: 20,
    width: 320,
    height: 180,
    hasAudio: true,
  };
  project.assets = [asset];
  const a = createClip(asset, sequence.tracks[0].id, 0, 60, sequence);
  const audio = createClip(asset, sequence.tracks[1].id, 0, 60, sequence);
  a.linkId = audio.linkId = 'original';
  a.sourceIn = audio.sourceIn = 2;
  const b = createClip(asset, sequence.tracks[0].id, 90, 30, sequence);
  sequence.clips = [a, audio, b];
  await video
    .getByLabel('打开视频工程文件')
    .setInputFiles({
      name: 'clipboard.tevideo',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(project)),
    });
  await video.locator(`[data-clip-id="${a.id}"]`).click();
  await video.locator(`[data-clip-id="${b.id}"]`).click({ modifiers: ['Shift'] });
  const timeline = video.getByLabel('时间线编辑区', { exact: true });
  await timeline.focus();
  await page.keyboard.press('ControlOrMeta+c');
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ControlOrMeta+v');
  await expect(video.locator('.vtl-clip')).toHaveCount(6);
  const pending = page.waitForEvent('download');
  await video.getByRole('button', { name: '保存工程', exact: true }).click();
  const saved: VideoProject = JSON.parse(await readFile((await (await pending).path())!, 'utf8'));
  const pasted = saved.sequences[0].clips.filter(
    (c) => !sequence.clips.some((old) => old.id === c.id),
  );
  expect(pasted.map((c) => c.start)).toEqual([120, 120, 210]);
  expect(pasted[0].sourceIn).toBe(2);
  expect(pasted[0].linkId).toBe(pasted[1].linkId);
  expect(pasted[0].linkId).not.toBe('original');
  await timeline.focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(video.locator('.vtl-clip')).toHaveCount(3);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(video.locator('.vtl-clip')).toHaveCount(6);
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ControlOrMeta+v');
  await expect(video.locator('.vtl-clip')).toHaveCount(9);
  await video.getByRole('button', { name: 'A1 锁定', exact: true }).click();
  await timeline.focus();
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ControlOrMeta+v');
  await expect(video).toContainText('已锁定');
  await expect(video.locator('.vtl-clip')).toHaveCount(9);
  const name = video.getByLabel('视频工程名称');
  await name.fill('普通文字');
  await name.press('ControlOrMeta+a');
  await name.press('ControlOrMeta+c');
  await name.press('ControlOrMeta+a');
  await name.press('ControlOrMeta+v');
  await expect(name).toHaveValue('普通文字');
  await timeline.focus();
  await page.keyboard.press('ControlOrMeta+v');
  await expect(video.locator('.vtl-clip')).toHaveCount(9);
  expect(errors).toEqual([]);
});
