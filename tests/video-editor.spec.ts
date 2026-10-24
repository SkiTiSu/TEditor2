import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { TextData } from '../src/core/types';
import type { VideoProject, VideoSequence } from '../src/video/types';

const errors = new WeakMap<Page, string[]>();
const editor = (page: Page) => page.locator('.video-editor');

test.beforeEach(async ({ page }) => {
  errors.set(page, []);
  page.on('pageerror', (error) => errors.get(page)!.push(error.message));
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto('/');
  await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true');
});

test.afterEach(async ({ page }) => {
  expect(errors.get(page), 'unexpected browser exceptions').toEqual([]);
});

async function openVideo(page: Page) {
  await page.getByRole('button', { name: '视频剪辑', exact: true }).click();
  await expect(editor(page)).toBeVisible();
  await expect(editor(page)).toHaveAttribute('data-ready', 'true');
}

async function saveProject(page: Page) {
  const downloaded = page.waitForEvent('download');
  await editor(page).getByRole('button', { name: '保存工程', exact: true }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toMatch(/\.tevideo$/);
  const path = await download.path();
  expect(path).toBeTruthy();
  return JSON.parse(await readFile(path!, 'utf8')) as VideoProject;
}

function activeSequence(project: VideoProject): VideoSequence {
  return project.sequences.find((sequence) => sequence.id === project.activeSequenceId)!;
}

async function setNumber(page: Page, label: string, value: number) {
  const input = editor(page).getByLabel(label, { exact: true });
  await input.fill(String(value));
  await input.press('Enter');
  await expect(input).toHaveValue(String(value));
}

async function importSampleVideo(page: Page, name: string, duration: number) {
  const encoded = await page.evaluate(async (seconds) => {
    const fixturePath = '/tests/video-media-fixtures.ts';
    const { makeVideo } = await import(fixturePath);
    const file: File = await makeVideo(seconds);
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }, duration);
  await editor(page)
    .getByLabel('导入视频素材文件')
    .setInputFiles({
      name,
      mimeType: 'video/mp4',
      buffer: Buffer.from(encoded, 'base64'),
    });
  await expect(
    editor(page).getByRole('button', { name: `素材 ${name}`, exact: true }),
  ).toBeVisible();
  await editor(page)
    .getByRole('button', { name: `素材 ${name}`, exact: true })
    .click();
  await expect(editor(page).getByLabel('源视频', { exact: true })).toBeVisible();
}

async function prepareGraphicPages(page: Page) {
  await page.locator('.toolbar').getByRole('button', { name: '新建', exact: true }).click();
  await page.getByLabel('画布宽度', { exact: true }).fill('1920');
  await page.getByLabel('画布高度', { exact: true }).fill('1080');
  await page.getByRole('button', { name: '添加文字', exact: true }).click();
  await page.getByLabel('文字内容', { exact: true }).fill('副榜原始标题');
  await page.locator('.toolbar').getByRole('button', { name: '导入数据', exact: true }).click();
  const tableDialog = page.getByRole('dialog', { name: '导入数据' });
  await tableDialog
    .getByLabel('粘贴表格数据')
    .fill('编号\t名称\n5\t第五名\n4\t第四名\n3\t第三名\n2\t第二名\n1\t第一名');
  await tableDialog.getByRole('button', { name: '导入表格', exact: true }).click();
  await expect(tableDialog).not.toBeVisible();
  await openVideo(page);
  await editor(page).getByRole('button', { name: '关联图片', exact: true }).click();
  const graphicDialog = page.getByRole('dialog', { name: '关联图片到视频' });
  await graphicDialog.getByLabel('图片生成方式').selectOption('pages');
  await graphicDialog.getByLabel('视频图片start').fill('1');
  await graphicDialog.getByLabel('视频图片end').fill('5');
  await graphicDialog.getByLabel('视频图片repeats').fill('3');
  await graphicDialog.getByLabel('视频图片deltaX').fill('0');
  await graphicDialog.getByLabel('视频图片deltaY').fill('250');
  await expect(graphicDialog.locator('.ve-graphic-choice')).toHaveCount(2);
  await graphicDialog.getByRole('button', { name: '添加关联图片', exact: true }).click();
  await expect(graphicDialog).not.toBeVisible();
  await expect(editor(page).locator('.ve-asset')).toHaveCount(2);
}

test('free editing preserves text, transforms, track controls, and timeline through project reopen', async ({
  page,
}, testInfo) => {
  await openVideo(page);
  const video = editor(page);
  await video.getByLabel('视频工程名称').fill('自由剪辑验收');
  await video.getByRole('button', { name: '文字', exact: true }).click();
  await video.getByRole('button', { name: '插入', exact: true }).click();
  await expect(video.locator('.vtl-clip')).toHaveCount(1);
  await video.getByLabel('文字内容', { exact: true }).fill('本期排行榜 · 第一名');
  await video.getByLabel('文字内容', { exact: true }).press('Tab');
  await setNumber(page, '时长（帧）', 240);
  await setNumber(page, '位置 X', 120);
  await setNumber(page, '宽度', 1600);
  await setNumber(page, '不透明度', 75);
  await expect(video.getByLabel('文字内容', { exact: true })).toHaveValue('本期排行榜 · 第一名');

  await video.getByRole('button', { name: '色块', exact: true }).click();
  await video.getByRole('button', { name: '插入', exact: true }).click();
  await expect(video.locator('.vtl-clip')).toHaveCount(2);
  await video.getByRole('button', { name: '覆盖', exact: true }).click();
  await expect(video.locator('.vtl-clip')).toHaveCount(2);
  await video.getByRole('button', { name: '视频轨', exact: true }).click();
  await video.getByRole('button', { name: '音频轨', exact: true }).click();
  await expect(video.locator('.vtl-track')).toHaveCount(4);
  const newTrackName = video.getByLabel('轨道名称 画面 2', { exact: true });
  await newTrackName.fill('标题叠层');
  await newTrackName.press('Enter');
  await video.getByRole('button', { name: '标题叠层 下移', exact: true }).click();
  await video.getByRole('button', { name: '标题叠层 锁定', exact: true }).click();
  await video.getByRole('button', { name: 'A1 静音', exact: true }).click();
  await video.getByRole('button', { name: '声音 2 独听', exact: true }).click();

  const saved = await saveProject(page);
  const sequence = activeSequence(saved);
  expect(saved.name).toBe('自由剪辑验收');
  expect(saved.assets.find((asset) => asset.kind === 'text')?.text).toBe('本期排行榜 · 第一名');
  expect(sequence.clips).toHaveLength(2);
  const text = sequence.clips.find(
    (clip) => saved.assets.find((asset) => asset.id === clip.assetId)?.kind === 'text',
  )!;
  expect(text).toMatchObject({
    start: 300,
    duration: 240,
    transform: { x: 120, width: 1600, opacity: 0.75 },
  });
  expect(sequence.tracks.find((track) => track.name === '标题叠层')?.locked).toBe(true);
  expect(sequence.tracks.find((track) => track.name === 'A1')?.muted).toBe(true);
  expect(sequence.tracks.find((track) => track.name === '声音 2')?.solo).toBe(true);

  await video.getByRole('button', { name: '新建', exact: true }).click();
  await expect(video.locator('.vtl-clip')).toHaveCount(0);
  await video.getByLabel('打开视频工程文件').setInputFiles({
    name: 'saved.tevideo',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(saved)),
  });
  await expect(video.getByLabel('视频工程名称')).toHaveValue('自由剪辑验收');
  await expect(video.locator('.vtl-clip')).toHaveCount(2);
  await expect(video.locator('.vtl-track')).toHaveCount(4);
  const restored = await saveProject(page);
  expect(restored.assets).toEqual(saved.assets);
  expect(restored.sequences).toEqual(saved.sequences);
  await page.screenshot({ path: testInfo.outputPath('free-video-editor.png'), fullPage: true });
});

test('linked graphic pages enter video without PNG and keep edits and stable row IDs after sorting', async ({
  page,
}, testInfo) => {
  const unexpectedDownloads: string[] = [];
  page.on('download', (download) => unexpectedDownloads.push(download.suggestedFilename()));
  await prepareGraphicPages(page);
  const video = editor(page);
  await video.getByRole('button', { name: '铺入图片组', exact: true }).click();
  await expect(video.locator('.vtl-clip')).toHaveCount(2);
  expect(unexpectedDownloads).toEqual([]);
  await video.locator('.vtl-clip').first().click();
  await setNumber(page, '时长（帧）', 240);
  const before = await saveProject(page);
  const source = before.graphics[0];
  expect(source.layout).toMatchObject({ repeats: 3, deltaX: 0, deltaY: 250 });
  expect(
    before.assets
      .filter((asset) => asset.kind === 'graphic')
      .map((asset) => asset.graphic!.rowIds.length),
  ).toEqual([4, 1]);
  const originalFifthId = source.rowIds[0];
  const clipsBefore = activeSequence(before).clips;

  await video.getByRole('button', { name: '编辑关联图片', exact: true }).click();
  await expect(video).not.toBeVisible();
  await page.locator('.layer-row').first().click();
  await page.getByLabel('文字内容', { exact: true }).fill('副榜已更新标题');
  await page.getByRole('button', { name: '排序 编号', exact: true }).click();
  await expect(page.getByLabel('第1行 名称', { exact: true })).toHaveValue('第一名');
  await openVideo(page);
  await expect(video.locator('.vtl-clip')).toHaveCount(2);
  const after = await saveProject(page);
  expect(activeSequence(after).clips).toEqual(clipsBefore);
  expect(after.assets.map((asset) => asset.graphic)).toEqual(
    before.assets.map((asset) => asset.graphic),
  );
  const updated = after.graphics[0];
  expect(updated.id).toBe(source.id);
  expect(updated.revision).toBeGreaterThan(source.revision);
  expect((updated.document.Layers[0].Data as TextData).Text).toBe('副榜已更新标题');
  expect(updated.rowIds.indexOf(originalFifthId)).toBe(4);
  expect(updated.table.rows[updated.rowIds.indexOf(originalFifthId)]['名称']).toBe('第五名');
  expect(unexpectedDownloads.every((name) => name.endsWith('.tevideo'))).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('linked-graphic-video.png'), fullPage: true });
});

test('editable ranking template generates two paginated cards with exact 30-frame crossfade in a new sequence', async ({
  page,
}, testInfo) => {
  await prepareGraphicPages(page);
  const video = editor(page);
  await video.getByRole('button', { name: '铺入图片组', exact: true }).click();
  const original = await saveProject(page);
  expect(
    Math.max(...activeSequence(original).clips.map((clip) => clip.start + clip.duration)),
  ).toBe(600);
  await video.getByRole('button', { name: '排行榜工作台', exact: true }).click();
  await video.getByRole('button', { name: '2. 节目模板', exact: true }).click();
  const panel = video.getByLabel('排行榜模板', { exact: true });
  await panel.getByRole('button', { name: '删除章节4', exact: true }).click();
  await panel.getByRole('button', { name: '删除章节2', exact: true }).click();
  await panel.getByRole('button', { name: '删除章节1', exact: true }).click();
  await expect(panel.getByLabel('章节1类型')).toHaveValue('secondary');
  await panel.getByLabel('视频模板名称').fill('副榜分页验收');
  await panel.getByLabel('章节1时长').fill('5');
  await panel.getByLabel('章节1叠化').fill('0.5');
  await panel.getByRole('button', { name: '存入工程', exact: true }).click();
  await panel.getByRole('button', { name: '预览编排结果', exact: true }).click();
  await expect(panel.locator('.ve-template-summary')).toContainText('9.50 秒');
  await panel.getByRole('button', { name: '生成到新序列', exact: true }).click();
  await expect(video.locator('.ve-sequence-tabs button')).toHaveCount(2);
  await expect(video.locator('.vtl-clip')).toHaveCount(2);
  const generated = await saveProject(page);
  const sequence = activeSequence(generated);
  expect(generated.sequences.find((item) => item.id === original.activeSequenceId)).toEqual(
    activeSequence(original),
  );
  expect(sequence.clips.map((clip) => ({ start: clip.start, duration: clip.duration }))).toEqual([
    { start: 0, duration: 300 },
    { start: 270, duration: 300 },
  ]);
  expect(sequence.transitions).toHaveLength(1);
  expect(sequence.transitions[0].duration).toBe(30);
  expect(generated.templates?.[0].name).toBe('副榜分页验收');
  await video.locator('.vtl-clip').first().click();
  await setNumber(page, '位置 X', 40);
  const edited = await saveProject(page);
  expect(activeSequence(edited).clips[0].transform.x).toBe(40);
  expect(activeSequence(edited).transitions).toEqual(sequence.transitions);
  await page.screenshot({
    path: testInfo.outputPath('ranking-template-video.png'),
    fullPage: true,
  });
  await video.getByRole('button', { name: '移除出场转场', exact: true }).click();
  await expect(video.locator('.vtl-crossfade')).toHaveCount(0);
  const withoutTransition = activeSequence(await saveProject(page));
  expect(withoutTransition.transitions).toHaveLength(0);
  expect(
    withoutTransition.clips.map((clip) => ({ start: clip.start, duration: clip.duration })),
  ).toEqual([
    { start: 0, duration: 300 },
    { start: 300, duration: 300 },
  ]);
  await video.getByRole('button', { name: '视频撤销', exact: true }).click();
  await expect(video.locator('.vtl-crossfade')).toHaveCount(1);
});

test('timeline supports native asset drop, cross-track moves, trimming, track locks, razor and undo', async ({
  page,
}, testInfo) => {
  await openVideo(page);
  const video = editor(page);
  await video.getByRole('button', { name: '文字', exact: true }).click();
  await video.getByRole('button', { name: '插入', exact: true }).click();
  await video.getByRole('button', { name: '视频轨', exact: true }).click();
  await video.getByRole('button', { name: '色块', exact: true }).click();
  const topLane = video.locator('.vtl-track-lane').first();
  await video
    .getByRole('button', { name: '素材 纯色色块', exact: true })
    .dragTo(topLane, { targetPosition: { x: 70, y: 35 } });
  await expect(video.locator('.vtl-clip')).toHaveCount(2);
  const dropped = await saveProject(page);
  const originalClip = activeSequence(dropped).clips.find(
    (clip) => dropped.assets.find((asset) => asset.id === clip.assetId)?.kind === 'color',
  )!;
  expect(originalClip.start).toBe(60);
  expect(
    activeSequence(dropped).tracks.find((track) => track.id === originalClip.trackId)?.name,
  ).toBe('画面 2');
  const colorClip = video.locator(`[data-clip-id="${originalClip.id}"]`);

  let box = (await colorClip.boundingBox())!;
  await page.mouse.move(box.x + 60, box.y + 30);
  await page.mouse.down();
  await page.mouse.move(box.x + 130, box.y + 30, { steps: 8 });
  await page.mouse.up();
  await expect(video.getByLabel('起点（帧）', { exact: true })).toHaveValue('120');

  await video.getByRole('button', { name: '视频轨', exact: true }).click();
  box = (await colorClip.boundingBox())!;
  const newLane = (await video.locator('.vtl-track-lane').first().boundingBox())!;
  await page.mouse.move(box.x + 60, box.y + 30);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, newLane.y + 35, { steps: 8 });
  await page.mouse.up();
  const moved = await saveProject(page);
  const newTrack = activeSequence(moved).tracks.find((track) => track.name === '画面 3')!;
  expect(activeSequence(moved).clips.find((clip) => clip.id === originalClip.id)?.trackId).toBe(
    newTrack.id,
  );

  const edge = (await colorClip.locator('.vtl-trim-start').boundingBox())!;
  await page.mouse.move(edge.x + 3, edge.y + 30);
  await page.mouse.down();
  await page.mouse.move(edge.x + 38, edge.y + 30, { steps: 8 });
  await page.mouse.up();
  await expect(video.getByLabel('起点（帧）', { exact: true })).toHaveValue('150');
  await expect(video.getByLabel('时长（帧）', { exact: true })).toHaveValue('270');
  await video.getByRole('button', { name: '画面 3 锁定', exact: true }).click();
  await expect(video.getByLabel('时长（帧）', { exact: true })).toBeDisabled();
  box = (await colorClip.boundingBox())!;
  await page.mouse.move(box.x + 60, box.y + 30);
  await page.mouse.down();
  await page.mouse.move(box.x + 130, box.y + 30, { steps: 8 });
  await page.mouse.up();
  await video.getByRole('button', { name: '画面 3 解锁', exact: true }).click();
  await expect(video.getByLabel('起点（帧）', { exact: true })).toHaveValue('150');
  await video.getByRole('button', { name: '剃刀工具 C', exact: true }).click();
  box = (await colorClip.boundingBox())!;
  await page.mouse.click(box.x + 70, box.y + 30);
  await expect(video.locator('.vtl-clip')).toHaveCount(3);
  await video.getByRole('button', { name: '视频撤销', exact: true }).click();
  await expect(video.locator('.vtl-clip')).toHaveCount(2);
  const restored = await saveProject(page);
  expect(activeSequence(restored).clips.find((clip) => clip.id === originalClip.id)).toMatchObject({
    start: 150,
    duration: 270,
    trackId: newTrack.id,
  });
  await video.getByRole('button', { name: '选择工具 V', exact: true }).click();
  const textId = activeSequence(restored).clips.find((clip) => clip.id !== originalClip.id)!.id;
  await video.locator(`[data-clip-id="${textId}"]`).click();
  await colorClip.click({ modifiers: ['Shift'] });
  await video.getByRole('button', { name: '成组', exact: true }).click();
  box = (await colorClip.boundingBox())!;
  await page.mouse.move(box.x + 60, box.y + 30);
  await page.mouse.down();
  await page.mouse.move(box.x + 130, box.y + 30, { steps: 8 });
  await expect(video.locator('.vtl-dragging')).toHaveCount(2);
  await page.mouse.up();
  const grouped = await saveProject(page);
  expect(activeSequence(grouped).clips.find((clip) => clip.id === originalClip.id)?.start).toBe(
    210,
  );
  expect(activeSequence(grouped).clips.find((clip) => clip.id === textId)?.start).toBe(60);
  await page.screenshot({ path: testInfo.outputPath('timeline-gestures.png'), fullPage: true });
});

test('overwrite replaces linked source audio in the same interval and silent cards remove old audio', async ({
  page,
}, testInfo) => {
  await openVideo(page);
  const video = editor(page);
  await importSampleVideo(page, 'original-audio.mp4', 4);
  await video.getByLabel('素材入点', { exact: true }).fill('0');
  await video.getByLabel('素材出点', { exact: true }).fill('4');
  await video.getByRole('button', { name: '插入', exact: true }).click();
  await expect(video.locator('.vtl-clip')).toHaveCount(2);
  const initial = await saveProject(page);
  const original = initial.assets.find((asset) => asset.name === 'original-audio.mp4')!;
  expect(original.hasAudio).toBe(true);
  expect(activeSequence(initial).clips.every((clip) => clip.linkId)).toBe(true);

  const wav = await page.evaluate(async () => {
    const fixturePath = '/tests/video-media-fixtures.ts';
    const { makeWav } = await import(fixturePath);
    const file: File = makeWav(2);
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  });
  await video.getByLabel('导入视频素材文件').setInputFiles({
    name: 'replacement-music.wav',
    mimeType: 'audio/wav',
    buffer: Buffer.from(wav, 'base64'),
  });
  await video.getByRole('button', { name: '素材 replacement-music.wav', exact: true }).click();
  await video.getByRole('button', { name: '覆盖', exact: true }).click();
  await expect(video.locator('.ve-toast')).toContainText('此音轨与画面关联，请先解除音视频关联');
  expect(activeSequence(await saveProject(page)).clips).toEqual(activeSequence(initial).clips);
  await video.getByRole('button', { name: '关闭提示', exact: true }).click();
  await video.getByRole('button', { name: '解除音视频关联', exact: true }).click();
  const unlinked = activeSequence(await saveProject(page));
  expect(unlinked.clips.every((clip) => !clip.linkId)).toBe(true);
  const videoTrack = unlinked.tracks.find((track) => track.kind === 'video')!;
  const retainedVisual = unlinked.clips.find((clip) => clip.trackId === videoTrack.id)!;
  await video.getByRole('button', { name: '覆盖', exact: true }).click();
  await expect(video.locator('.vtl-clip')).toHaveCount(3);
  const audioReplacement = await saveProject(page);
  const music = audioReplacement.assets.find((asset) => asset.name === 'replacement-music.wav')!;
  expect(
    activeSequence(audioReplacement).clips.find((clip) => clip.id === retainedVisual.id),
  ).toEqual(retainedVisual);
  expect(
    activeSequence(audioReplacement).clips.find((clip) => clip.assetId === music.id),
  ).toMatchObject({ start: 0, duration: 120 });
  const remainingOriginalAudio = activeSequence(audioReplacement).clips.filter(
    (clip) => clip.assetId === original.id && clip.trackId !== videoTrack.id,
  );
  expect(remainingOriginalAudio).toHaveLength(1);
  expect(remainingOriginalAudio[0]).toMatchObject({ start: 120, duration: 120, sourceIn: 2 });
  await video.getByLabel('打开视频工程文件').setInputFiles({
    name: 'linked-original.tevideo',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(initial)),
  });
  await expect(video.locator('.vtl-clip')).toHaveCount(2);

  await video.getByLabel('时间线编辑区', { exact: true }).focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+ArrowRight');
  await expect(video.locator('.vtl-timecode')).toContainText('00:00:01:00');
  await importSampleVideo(page, 'replacement-audio.mp4', 2);
  await video.getByLabel('素材入点', { exact: true }).fill('0.25');
  await video.getByLabel('素材出点', { exact: true }).fill('1.25');
  await video.getByRole('button', { name: '覆盖', exact: true }).click();
  await expect(video.locator('.vtl-clip')).toHaveCount(6);
  const overwritten = await saveProject(page);
  const sequence = activeSequence(overwritten);
  const replacement = overwritten.assets.find((asset) => asset.name === 'replacement-audio.mp4')!;
  const audioTracks = new Set(
    sequence.tracks.filter((track) => track.kind === 'audio').map((track) => track.id),
  );
  const originalAudio = sequence.clips
    .filter((clip) => clip.assetId === original.id && audioTracks.has(clip.trackId))
    .sort((a, b) => a.start - b.start);
  expect(originalAudio.map((clip) => ({ start: clip.start, duration: clip.duration }))).toEqual([
    { start: 0, duration: 60 },
    { start: 120, duration: 120 },
  ]);
  const replacementPair = sequence.clips.filter((clip) => clip.assetId === replacement.id);
  expect(replacementPair).toHaveLength(2);
  expect(replacementPair[0].linkId).toBe(replacementPair[1].linkId);
  expect(
    replacementPair.every(
      (clip) => clip.start === 60 && clip.duration === 60 && clip.sourceIn === 0.25,
    ),
  ).toBe(true);
  expect(
    sequence.clips
      .filter(
        (clip) =>
          audioTracks.has(clip.trackId) && clip.start < 120 && clip.start + clip.duration > 60,
      )
      .map((clip) => clip.assetId),
  ).toEqual([replacement.id]);

  await video.getByRole('button', { name: '色块', exact: true }).click();
  await video.getByRole('button', { name: '覆盖', exact: true }).click();
  await expect(video.locator('.vtl-clip')).toHaveCount(3);
  const silent = await saveProject(page);
  const silentSequence = activeSequence(silent);
  const audioRemaining = silentSequence.clips.filter((clip) => audioTracks.has(clip.trackId));
  expect(audioRemaining).toHaveLength(1);
  expect(audioRemaining[0]).toMatchObject({ assetId: original.id, start: 0, duration: 60 });
  expect(silentSequence.clips.some((clip) => clip.assetId === replacement.id)).toBe(false);
  const color = silent.assets.find((asset) => asset.kind === 'color')!;
  expect(silentSequence.clips.find((clip) => clip.assetId === color.id)).toMatchObject({
    start: 60,
    duration: 300,
  });
  await page.screenshot({
    path: testInfo.outputPath('overwrite-linked-audio.png'),
    fullPage: true,
  });
});

test('source playback pauses on workspace change and program playback while source Space stays isolated', async ({
  page,
}, testInfo) => {
  await openVideo(page);
  const video = editor(page);
  await importSampleVideo(page, 'monitor-audio.mp4', 6);
  await video.getByLabel('素材入点', { exact: true }).fill('0');
  await video.getByLabel('素材出点', { exact: true }).fill('6');
  await video.getByRole('button', { name: '插入', exact: true }).click();
  await expect(video.locator('.vtl-clip')).toHaveCount(2);
  const sourceMedia = video.getByLabel('源视频', { exact: true });
  const sourcePaused = () =>
    sourceMedia.evaluate((element) => (element as HTMLVideoElement).paused);

  const staleDisplay = await video.locator('.ve-source code').textContent();
  await sourceMedia.evaluate(async (element) => {
    const player = element as HTMLVideoElement & { testTimeUpdateBlocker?: EventListener };
    player.testTimeUpdateBlocker = (event) => {
      if (event.target === player) event.stopImmediatePropagation();
    };
    window.addEventListener('timeupdate', player.testTimeUpdateBlocker, true);
    await new Promise<void>((resolve) => {
      player.addEventListener('seeked', () => resolve(), { once: true });
      player.currentTime = 1.25;
    });
  });
  await expect(video.locator('.ve-source code')).toHaveText(staleDisplay!);
  await video.getByRole('button', { name: '设入点', exact: true }).click();
  await expect(video.getByLabel('素材入点', { exact: true })).toHaveValue('1.25');
  await video.getByRole('button', { name: '源下一帧', exact: true }).click();
  await expect
    .poll(async () =>
      Math.abs(
        (await sourceMedia.evaluate((element) => (element as HTMLVideoElement).currentTime)) -
          (1.25 + 1 / 60),
      ),
    )
    .toBeLessThan(0.0001);
  const mediaEnd = await sourceMedia.evaluate(async (element) => {
    const player = element as HTMLVideoElement;
    await new Promise<void>((resolve) => {
      player.addEventListener('seeked', () => resolve(), { once: true });
      player.currentTime = player.duration;
    });
    return player.duration;
  });
  await video.getByRole('button', { name: '设出点', exact: true }).click();
  expect(
    Number(await video.getByLabel('素材出点', { exact: true }).inputValue()),
  ).toBeLessThanOrEqual(mediaEnd);
  await video.getByRole('button', { name: '设入点', exact: true }).click();
  const endIn = Number(await video.getByLabel('素材入点', { exact: true }).inputValue());
  const endOut = Number(await video.getByLabel('素材出点', { exact: true }).inputValue());
  expect(endOut).toBeLessThanOrEqual(mediaEnd);
  expect(endOut - endIn).toBeGreaterThanOrEqual(1 / 60 - 1e-6);
  await sourceMedia.evaluate((element) => {
    const player = element as HTMLVideoElement & { testTimeUpdateBlocker?: EventListener };
    if (player.testTimeUpdateBlocker)
      window.removeEventListener('timeupdate', player.testTimeUpdateBlocker, true);
    delete player.testTimeUpdateBlocker;
  });
  await video.getByLabel('源视频位置', { exact: true }).fill('0');
  await video.getByLabel('素材入点', { exact: true }).fill('0');
  await video.getByLabel('素材出点', { exact: true }).fill('6');

  await video.getByRole('button', { name: '播放源视频', exact: true }).click();
  await expect.poll(sourcePaused).toBe(false);
  await video.getByRole('button', { name: '图片设计', exact: true }).click();
  await expect(video).not.toBeVisible();
  await expect.poll(sourcePaused).toBe(true);
  await openVideo(page);
  await expect.poll(sourcePaused).toBe(true);

  await video.getByRole('button', { name: '播放源视频', exact: true }).click();
  await expect.poll(sourcePaused).toBe(false);
  await video.getByRole('button', { name: '播放视频', exact: true }).click();
  await expect.poll(sourcePaused).toBe(true);
  await expect(video.getByRole('button', { name: '暂停视频', exact: true })).toBeVisible();

  await video.getByLabel('源预览', { exact: true }).focus();
  await page.keyboard.press('Space');
  await expect.poll(sourcePaused).toBe(false);
  await expect(video.getByRole('button', { name: '播放视频', exact: true })).toBeVisible();
  await page.keyboard.press('Space');
  await expect.poll(sourcePaused).toBe(true);
  await expect(video.getByRole('button', { name: '播放视频', exact: true })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('source-monitor-playback.png'),
    fullPage: true,
  });
});

test('operation previews, sync scope, saved export settings and adjustable panels stay connected', async ({
  page,
}, testInfo) => {
  await openVideo(page);
  const video = editor(page);
  await video.getByRole('button', { name: '色块', exact: true }).click();
  await video.getByRole('button', { name: '插入', exact: true }).click();
  await video.getByRole('button', { name: '视频轨', exact: true }).click();
  await video.getByRole('button', { name: '色块', exact: true }).click();
  await video.getByRole('button', { name: '插入', exact: true }).click();
  await expect(video.locator('.vtl-clip')).toHaveCount(2);
  const baseline = activeSequence(await saveProject(page));
  const independentTrack = baseline.tracks.find((track) => track.name === 'V1')!;
  const targetTrack = baseline.tracks.find((track) => track.name === '画面 2')!;
  const independentClip = baseline.clips.find((clip) => clip.trackId === independentTrack.id)!;
  expect(independentClip.start).toBe(300);
  await video.locator('.ve-sync-menu summary').click();
  await video.getByLabel('同步轨道 V1', { exact: true }).uncheck();
  await expect(video.getByLabel('同步轨道 画面 2', { exact: true })).toBeChecked();
  await video.locator('.ve-sync-menu summary').click();
  await video.getByRole('button', { name: '插入', exact: true }).click();
  await expect(video.locator('.vtl-clip')).toHaveCount(3);
  const scoped = activeSequence(await saveProject(page));
  expect(scoped.clips.find((clip) => clip.id === independentClip.id)).toEqual(independentClip);
  expect(
    scoped.clips
      .filter((clip) => clip.trackId === targetTrack.id)
      .map((clip) => clip.start)
      .sort((a, b) => a - b),
  ).toEqual([0, 300]);

  await importSampleVideo(page, 'preview-range.mp4', 3);
  await video.getByLabel('素材入点', { exact: true }).fill('0.5');
  await video.getByLabel('素材出点', { exact: true }).fill('1.75');
  await video.getByLabel('时间线编辑区', { exact: true }).focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+ArrowRight');
  await expect(video.locator('.vtl-timecode')).toContainText('00:00:01:00');
  const insert = video.getByRole('button', { name: '插入', exact: true });
  const overwrite = video.getByRole('button', { name: '覆盖', exact: true });
  const preview = video.locator('.vtl-operation-preview');
  await insert.hover();
  await expect(preview).toHaveAttribute('data-operation-mode', 'insert');
  await expect(preview).toHaveAttribute('data-start', '60');
  await expect(preview).toHaveAttribute('data-duration', '75');
  await expect(preview).toContainText('插入·后移同步轨道');
  await expect(video.locator('.vtl-clip')).toHaveCount(3);
  await overwrite.hover();
  await expect(preview).toHaveAttribute('data-operation-mode', 'overwrite');
  await expect(preview).toHaveAttribute('data-duration', '75');
  await expect(preview).toContainText('覆盖此区间（含关联原声）');
  await insert.focus();
  await expect(preview).toHaveAttribute('data-operation-mode', 'insert');
  await video.getByLabel('素材入点', { exact: true }).focus();
  await expect(preview).toHaveCount(0);
  expect(activeSequence(await saveProject(page)).clips).toEqual(scoped.clips);

  await video.getByRole('button', { name: '导出视频', exact: true }).click();
  const exportDialog = video.getByRole('dialog', { name: '视频导出', exact: true });
  await exportDialog.getByLabel('视频导出开始').fill('1.25');
  await exportDialog.getByLabel('视频导出结束').fill('7.5');
  await exportDialog.getByLabel('视频码率').selectOption('24');
  await exportDialog.getByRole('button', { name: '关闭视频对话框', exact: true }).click();
  const saved = await saveProject(page);
  expect(activeSequence(saved).exportSettings).toEqual({
    startFrame: 75,
    endFrame: 450,
    videoBitrate: 24_000_000,
    videoBitrateMode: 'variable',
  });
  await video.getByRole('button', { name: '新建', exact: true }).click();
  await expect(video.locator('.vtl-clip')).toHaveCount(0);
  await video.getByLabel('打开视频工程文件').setInputFiles({
    name: 'export-settings.tevideo',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(saved)),
  });
  await expect(video.locator('.vtl-clip')).toHaveCount(3);
  await video.getByRole('button', { name: '导出视频', exact: true }).click();
  await expect(exportDialog.getByLabel('视频导出开始')).toHaveValue('1.25');
  await expect(exportDialog.getByLabel('视频导出结束')).toHaveValue('7.5');
  await expect(exportDialog.getByLabel('视频码率')).toHaveValue('24');
  await exportDialog.getByRole('button', { name: '关闭视频对话框', exact: true }).click();

  for (const adjustment of [
    {
      label: '调整素材面板宽度',
      selector: '.ve-library',
      axis: 'width' as const,
      dx: 50,
      dy: 0,
      increase: 40,
    },
    {
      label: '调整属性面板宽度',
      selector: '.vinsp-panel',
      axis: 'width' as const,
      dx: -40,
      dy: 0,
      increase: 30,
    },
    {
      label: '调整时间线高度',
      selector: '.ve-timeline-field',
      axis: 'height' as const,
      dx: 0,
      dy: -45,
      increase: 30,
    },
  ]) {
    const panel = video.locator(adjustment.selector);
    const before = (await panel.boundingBox())![adjustment.axis];
    const divider = (await video
      .getByRole('separator', { name: adjustment.label, exact: true })
      .boundingBox())!;
    const x = divider.x + divider.width / 2,
      y = divider.y + divider.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + adjustment.dx, y + adjustment.dy, { steps: 8 });
    await page.mouse.up();
    await expect
      .poll(async () => (await panel.boundingBox())![adjustment.axis])
      .toBeGreaterThan(before + adjustment.increase);
  }
  await page.screenshot({
    path: testInfo.outputPath('connected-editor-controls.png'),
    fullPage: true,
  });
});
