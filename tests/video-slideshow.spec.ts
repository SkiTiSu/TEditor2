import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import {
  createDocument,
  createLayer,
  normalizeLayerOrder,
  serializeDocument,
} from '../src/core/document';
import type { VideoProject, VideoSequence } from '../src/video/types';

const editor = (page: Page) => page.locator('.video-editor');
const exceptions = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  exceptions.set(page, []);
  page.on('pageerror', (error) => exceptions.get(page)!.push(error.message));
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto('/');
  await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true');
});

test.afterEach(async ({ page }) => {
  expect(exceptions.get(page), 'unexpected browser exceptions').toEqual([]);
});

async function openVideo(page: Page) {
  await page.getByRole('button', { name: '视频剪辑', exact: true }).click();
  await expect(editor(page)).toBeVisible();
  await expect(editor(page)).toHaveAttribute('data-ready', 'true');
}

async function switchMode(page: Page, mode: 'ppt' | 'timeline') {
  await editor(page)
    .getByRole('button', { name: mode === 'ppt' ? 'PPT模式' : '时间轴模式', exact: true })
    .click();
  await expect(editor(page)).toHaveAttribute('data-view-mode', mode);
}

async function setNumber(scope: Page | Locator, label: string, value: number) {
  const input = scope.getByLabel(label, { exact: true });
  await input.fill(String(value));
  await input.press('Enter');
  await expect(input).toHaveValue(String(value));
}

async function saveProject(page: Page): Promise<VideoProject> {
  const pending = page.waitForEvent('download');
  await editor(page).getByRole('button', { name: '保存工程', exact: true }).click();
  const file = await pending;
  expect(file.suggestedFilename()).toMatch(/\.tevideo$/);
  return JSON.parse(await readFile((await file.path())!, 'utf8')) as VideoProject;
}

function activeSequence(project: VideoProject): VideoSequence {
  return project.sequences.find((sequence) => sequence.id === project.activeSequenceId)!;
}

function pagesOf(sequence: VideoSequence) {
  const videoTrackIds = new Set(
    sequence.tracks.filter((track) => track.kind === 'video').map((track) => track.id),
  );
  return sequence.clips
    .filter((clip) => videoTrackIds.has(clip.trackId))
    .sort((a, b) => a.start - b.start);
}

async function canvasPixel(page: Page) {
  return editor(page)
    .getByLabel('视频合成画布', { exact: true })
    .evaluate((element: HTMLCanvasElement) =>
      [...element.getContext('2d')!.getImageData(160, 25, 1, 1).data].slice(0, 3),
    );
}

async function configureSmallSequence(page: Page) {
  const video = editor(page);
  await video.getByRole('button', { name: '序列设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '序列设置', exact: true });
  await dialog.getByLabel('序列width', { exact: true }).fill('320');
  await dialog.getByLabel('序列height', { exact: true }).fill('180');
  await dialog.getByLabel('序列fps', { exact: true }).fill('60');
  await dialog.getByRole('button', { name: '应用序列设置', exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

async function prepareRankingPages(page: Page) {
  const document = createDocument(320, 180);
  const blocks = ['#ff0000', '#00ff00', '#0000ff'].map((color) => {
    const layer = createLayer('Rectangle');
    Object.assign(layer.Data, { Width: 320, Height: 50, FillColor: color });
    return layer;
  });
  const title = createLayer('Text');
  title.Left = 8;
  title.Top = 8;
  Object.assign(title.Data, {
    Text: '副榜',
    FontFamilyName: 'Arial',
    FontSize: 18,
    Color: '#ffffff',
    VariableEnable: true,
    VariableTemplate: '{名称}',
  });
  document.Layers = [title, ...blocks];
  normalizeLayerOrder(document);
  document.DocModel.FormatConditionGroups = [
    {
      Name: '分页颜色',
      Color: '#6699ff',
      EffctiveLayers: blocks.map((layer) => layer.Id),
      FormatConditionModels: ['red', 'green', 'blue'].map((color, index) => ({
        Name: color,
        Condition: index ? `[颜色]="${color}"` : '',
        LayersVisable: Object.fromEntries(blocks.map((layer, i) => [layer.Id, i === index])),
      })),
    },
  ];
  await page.locator('.app-shell input[accept=".ted,.json"]').setInputFiles({
    name: '副榜PPT测试.ted',
    mimeType: 'application/json',
    buffer: Buffer.from(serializeDocument(document)),
  });
  await page.locator('.toolbar').getByRole('button', { name: '导入数据', exact: true }).click();
  const tableDialog = page.getByRole('dialog', { name: '导入数据', exact: true });
  await tableDialog
    .getByLabel('粘贴表格数据')
    .fill('名称\t颜色\nR1\tred\nR2\tred\nR3\tred\nG1\tgreen\nG2\tgreen\nG3\tgreen\nB1\tblue');
  await tableDialog.getByRole('button', { name: '导入表格', exact: true }).click();
  await expect(tableDialog).not.toBeVisible();
  await openVideo(page);
  await configureSmallSequence(page);
  await switchMode(page, 'ppt');
  await editor(page).getByRole('button', { name: 'PPT关联图片', exact: true }).click();
  const graphicDialog = page.getByRole('dialog', { name: '关联图片到视频', exact: true });
  await graphicDialog.getByLabel('图片生成方式').selectOption('pages');
  await graphicDialog.getByLabel('视频图片start').fill('1');
  await graphicDialog.getByLabel('视频图片end').fill('7');
  await graphicDialog.getByLabel('视频图片repeats').fill('2');
  await graphicDialog.getByLabel('视频图片deltaX').fill('0');
  await graphicDialog.getByLabel('视频图片deltaY').fill('60');
  await expect(graphicDialog.locator('.ve-graphic-choice')).toHaveCount(3);
  await graphicDialog.getByRole('button', { name: '添加关联图片', exact: true }).click();
  await expect(graphicDialog).not.toBeVisible();
  await expect(
    editor(page).getByRole('list', { name: 'PPT页面列表' }).getByRole('listitem'),
  ).toHaveCount(3);
}

async function importMusic(page: Page) {
  const encoded = await page.evaluate(async () => {
    const fixturePath = '/tests/video-media-fixtures.ts';
    const { makeWav } = await import(fixturePath);
    const file: File = makeWav(0.4, 880);
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  });
  await editor(page)
    .getByLabel('导入视频素材文件')
    .setInputFiles({
      name: 'ppt-loop-music.wav',
      mimeType: 'audio/wav',
      buffer: Buffer.from(encoded, 'base64'),
    });
  await editor(page).getByRole('tab', { name: '音乐', exact: true }).click();
  const music = editor(page).getByLabel('PPT背景音乐', { exact: true });
  await expect(music.locator('option')).toHaveCount(2);
  await music.selectOption({ label: 'ppt-loop-music.wav' });
  await expect(editor(page).getByLabel('PPT循环背景音乐', { exact: true })).toBeChecked();
  await setNumber(editor(page), 'PPT背景音乐音量', 60);
  await setNumber(editor(page), 'PPT音乐淡入秒数', 0.1);
  await setNumber(editor(page), 'PPT音乐淡出秒数', 0.15);
}

test('PPT pages preserve ranking bindings, reorder and durations across timeline and reopen, then export real looped audio MP4', async ({
  page,
}, testInfo) => {
  const downloads: string[] = [];
  page.on('download', (file) => downloads.push(file.suggestedFilename()));
  await prepareRankingPages(page);
  expect(downloads).toEqual([]);
  const video = editor(page);
  await video.getByLabel('视频工程名称').fill('副榜PPT验收');
  const initial = await saveProject(page);
  const originalPages = pagesOf(activeSequence(initial));
  expect(initial.assets.map((asset) => asset.graphic?.rowIds.length)).toEqual([3, 3, 1]);
  await setNumber(video, 'PPT默认每页秒数', 2);
  await video.getByRole('button', { name: '应用到所有页面', exact: true }).click();
  await video.getByRole('button', { name: 'PPT页面1', exact: true }).click();
  await setNumber(video, 'PPT本页秒数', 1);
  await video.getByRole('button', { name: 'PPT页面下移', exact: true }).click();
  const cards = video.getByRole('list', { name: 'PPT页面列表' }).getByRole('listitem');
  await cards.nth(2).dragTo(cards.nth(0));
  await video.getByLabel('PPT页面切换', { exact: true }).selectOption('dissolve');
  await setNumber(video, 'PPT叠化秒数', 0.25);
  await expect(video.getByLabel('PPT视频总时长', { exact: true })).toHaveText('4.5 秒');
  await importMusic(page);
  await video.getByRole('button', { name: 'PPT页面1', exact: true }).click();
  await expect.poll(() => canvasPixel(page)).toEqual([0, 0, 255]);
  const composed = await saveProject(page);
  const sequence = activeSequence(composed),
    pages = pagesOf(sequence);
  expect(pages.map((clip) => clip.id)).toEqual([
    originalPages[2].id,
    originalPages[1].id,
    originalPages[0].id,
  ]);
  expect(pages.map((clip) => ({ start: clip.start, duration: clip.duration }))).toEqual([
    { start: 0, duration: 120 },
    { start: 105, duration: 120 },
    { start: 210, duration: 60 },
  ]);
  expect(sequence.transitions.map((transition) => transition.duration)).toEqual([15, 15]);
  const musicAsset = composed.assets.find((asset) => asset.name === 'ppt-loop-music.wav')!;
  expect(sequence.clips.find((clip) => clip.assetId === musicAsset.id)).toMatchObject({
    start: 0,
    duration: 270,
    loop: true,
    volume: 0.6,
    fadeIn: 6,
    fadeOut: 9,
  });
  expect(
    composed.assets.filter((asset) => asset.kind === 'graphic').map((asset) => asset.graphic),
  ).toEqual(initial.assets.map((asset) => asset.graphic));
  await video.getByRole('tab', { name: '页面', exact: true }).click();
  const invalidTransition = video.getByLabel('PPT叠化秒数', { exact: true });
  await invalidTransition.fill('3');
  await invalidTransition.press('Enter');
  await expect(video.locator('.ve-toast')).toContainText('时长不足以容纳转场');
  await expect(invalidTransition).toHaveValue('0.25');
  expect(activeSequence(await saveProject(page))).toEqual(sequence);
  await video.getByRole('button', { name: '关闭提示', exact: true }).click();
  await switchMode(page, 'timeline');
  await expect(video.locator('.vtl-clip')).toHaveCount(4);
  expect(activeSequence(await saveProject(page))).toEqual(sequence);
  await switchMode(page, 'ppt');
  expect(activeSequence(await saveProject(page))).toEqual(sequence);
  await video.getByRole('button', { name: '新建', exact: true }).click();
  await expect(video.getByLabel('PPT页面总数', { exact: true })).toHaveText('0 页');
  await video.getByLabel('打开视频工程文件').setInputFiles({
    name: 'ranking-ppt.tevideo',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(composed)),
  });
  await expect(video.getByLabel('PPT页面总数', { exact: true })).toHaveText('3 页');
  expect(activeSequence(await saveProject(page))).toEqual(sequence);
  await video.getByRole('button', { name: 'PPT页面1', exact: true }).click();
  await expect.poll(() => canvasPixel(page)).toEqual([0, 0, 255]);
  await page.screenshot({ path: testInfo.outputPath('ppt-ranking-editor.png'), fullPage: true });

  await video.getByRole('button', { name: '导出视频', exact: true }).click();
  const exportDialog = page.getByRole('dialog', { name: '视频导出', exact: true });
  await expect(exportDialog.getByLabel('视频导出结束')).toHaveValue('4.5');
  await exportDialog.getByRole('button', { name: '生成后下载', exact: true }).click();
  await expect(exportDialog.locator('.ve-export-status')).toContainText('导出完成：270 帧');
  const exportUrl = await exportDialog
    .getByRole('link', { name: '下载 MP4 视频', exact: true })
    .getAttribute('href');
  const decoded = await page.evaluate(async (url) => {
    const bunnyPath = '/node_modules/.vite/deps/mediabunny.js';
    const { Input, BlobSource, ALL_FORMATS, VideoSampleSink, AudioBufferSink } = await import(
      bunnyPath
    );
    const blob = await (await fetch(url!)).blob();
    const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
    const video = await input.getPrimaryVideoTrack(),
      audio = await input.getPrimaryAudioTrack();
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    const context = canvas.getContext('2d')!;
    const pixels: number[][] = [];
    for (const time of [0.1, 2.1, 4.1]) {
      const sample = await new VideoSampleSink(video).getSample(time);
      sample.draw(context, 0, 0);
      sample.close();
      pixels.push([...context.getImageData(160, 25, 1, 1).data].slice(0, 3));
    }
    const audioRms: number[] = [];
    for (const start of [0.5, 2.5, 4.1]) {
      let sum = 0,
        count = 0;
      for await (const part of new AudioBufferSink(audio).buffers(start, start + 0.1)) {
        const values = part.buffer.getChannelData(0),
          rate = part.buffer.sampleRate;
        const first = Math.max(0, Math.ceil((start - part.timestamp) * rate));
        const last = Math.min(values.length, Math.floor((start + 0.1 - part.timestamp) * rate));
        for (let i = first; i < last; i++) {
          sum += values[i] * values[i];
          count++;
        }
      }
      audioRms.push(Math.sqrt(sum / count));
    }
    const result = {
      videoCodec: await video.getCodec(),
      audioCodec: await audio.getCodec(),
      frames: (await video.computePacketStats()).packetCount,
      duration: await input.computeDuration(),
      pixels,
      audioRms,
      bytes: blob.size,
    };
    input.dispose();
    return result;
  }, exportUrl);
  expect(decoded.videoCodec).toBe('avc');
  expect(decoded.audioCodec).toBe('aac');
  expect(decoded.frames).toBe(270);
  expect(Math.abs(decoded.duration - 4.5)).toBeLessThan(0.03);
  for (const [index, channel] of [2, 1, 0].entries()) {
    expect(decoded.pixels[index][channel]).toBeGreaterThan(235);
    expect(decoded.pixels[index].filter((_, i) => i !== channel).every((value) => value < 20)).toBe(
      true,
    );
  }
  for (const rms of decoded.audioRms) expect(rms).toBeGreaterThan(0.05);
  expect(decoded.bytes).toBeGreaterThan(1000);
  const evidencePath = testInfo.outputPath('ppt-real-mp4.json');
  await writeFile(evidencePath, JSON.stringify(decoded, null, 2));
  await testInfo.attach('ppt-real-mp4.json', {
    path: evidencePath,
    contentType: 'application/json',
  });
  await exportDialog.getByRole('button', { name: '关闭视频对话框', exact: true }).click();
  await video.getByRole('button', { name: 'PPT页面3', exact: true }).click();
  await setNumber(video, 'PPT本页秒数', 1.5);
  await expect(video.getByLabel('PPT视频总时长', { exact: true })).toHaveText('5 秒');
  await video.getByRole('button', { name: '导出视频', exact: true }).click();
  await expect(exportDialog.getByLabel('视频导出结束')).toHaveValue('5');
  await exportDialog.getByLabel('视频导出结束').fill('2');
  await exportDialog.getByRole('button', { name: '关闭视频对话框', exact: true }).click();
  await setNumber(video, 'PPT本页秒数', 2);
  await video.getByRole('button', { name: '导出视频', exact: true }).click();
  await expect(exportDialog.getByLabel('视频导出结束')).toHaveValue('2');
  expect(downloads.every((name) => name.endsWith('.tevideo'))).toBe(true);
});

test('PPT mode preserves incompatible free timeline content and creates an independent slideshow sequence', async ({
  page,
}) => {
  await openVideo(page);
  const video = editor(page);
  await video.getByRole('button', { name: '文字', exact: true }).click();
  await video.getByRole('button', { name: '插入', exact: true }).click();
  await video.getByRole('button', { name: '视频轨', exact: true }).click();
  await video.getByRole('button', { name: '色块', exact: true }).click();
  await video
    .getByRole('button', { name: '素材 纯色色块', exact: true })
    .dragTo(video.locator('.vtl-track-lane').first(), { targetPosition: { x: 70, y: 35 } });
  await expect(video.locator('.vtl-clip')).toHaveCount(2);
  const before = await saveProject(page),
    original = activeSequence(before);
  await switchMode(page, 'ppt');
  await expect(video.locator('.ve-ppt-unsupported')).toContainText('多条画面轨');
  await expect(
    video.getByRole('button', { name: '添加此来源全部图片', exact: true }),
  ).toBeDisabled();
  expect(activeSequence(await saveProject(page))).toEqual(original);
  await video.getByRole('button', { name: '新建PPT序列', exact: true }).click();
  await expect(video.getByLabel('PPT页面总数', { exact: true })).toHaveText('0 页');
  await video.getByRole('button', { name: '添加此来源全部图片', exact: true }).click();
  await expect(video.getByLabel('PPT页面总数', { exact: true })).toHaveText('2 页');
  const after = await saveProject(page);
  expect(after.sequences).toHaveLength(2);
  expect(after.sequences.find((sequence) => sequence.id === original.id)).toEqual(original);
  expect(after.activeSequenceId).not.toBe(original.id);
  await switchMode(page, 'timeline');
  await video
    .locator('.ve-sequence-tabs')
    .getByRole('button', { name: original.name, exact: true })
    .click();
  expect(activeSequence(await saveProject(page))).toEqual(original);
  await expect(video.locator('.vtl-clip')).toHaveCount(2);
});

test('PPT imports ordinary images directly, copies and deletes pages with undo, and follows timeline edits safely', async ({
  page,
}) => {
  await openVideo(page);
  await configureSmallSequence(page);
  await switchMode(page, 'ppt');
  const encoded = await page.evaluate(() =>
    ['#ff0000', '#0000ff'].map((color) => {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 180;
      const context = canvas.getContext('2d')!;
      context.fillStyle = color;
      context.fillRect(0, 0, 320, 180);
      return canvas.toDataURL('image/png').split(',')[1];
    }),
  );
  const video = editor(page);
  await video.getByLabel('导入视频素材文件').setInputFiles(
    encoded.map((data, i) => ({
      name: `image-${i + 1}.png`,
      mimeType: 'image/png',
      buffer: Buffer.from(data, 'base64'),
    })),
  );
  await expect(video.getByLabel('PPT页面总数', { exact: true })).toHaveText('2 页');
  await video.getByRole('button', { name: 'PPT页面2', exact: true }).click();
  await expect.poll(() => canvasPixel(page)).toEqual([0, 0, 255]);
  await video.getByRole('button', { name: 'PPT复制页面', exact: true }).click();
  await expect(video.getByLabel('PPT页面总数', { exact: true })).toHaveText('3 页');
  const copied = activeSequence(await saveProject(page));
  expect(pagesOf(copied).map((clip) => clip.assetId)).toEqual([
    copied.clips[0].assetId,
    copied.clips[1].assetId,
    copied.clips[1].assetId,
  ]);
  await video.getByRole('button', { name: 'PPT删除页面', exact: true }).click();
  await expect(video.getByLabel('PPT页面总数', { exact: true })).toHaveText('2 页');
  await video.getByRole('button', { name: 'PPT撤销', exact: true }).click();
  await expect(video.getByLabel('PPT页面总数', { exact: true })).toHaveText('3 页');
  expect(activeSequence(await saveProject(page))).toEqual(copied);
  await video.getByRole('button', { name: 'PPT重做', exact: true }).click();
  await expect(video.getByLabel('PPT页面总数', { exact: true })).toHaveText('2 页');
  await switchMode(page, 'timeline');
  await video.locator('.vtl-clip').last().click();
  await setNumber(video, '时长（帧）', 120);
  await switchMode(page, 'ppt');
  await video.getByRole('button', { name: 'PPT页面2', exact: true }).click();
  await expect(video.getByLabel('PPT本页秒数', { exact: true })).toHaveValue('2');
  await expect(video.getByLabel('PPT视频总时长', { exact: true })).toHaveText('7 秒');
  await expect(video.locator('.ve-workbar-status')).toContainText('视频草稿已保存在本机');
  await page.reload();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true');
  await openVideo(page);
  await switchMode(page, 'ppt');
  await expect(video.getByLabel('PPT页面总数', { exact: true })).toHaveText('2 页');
  await video.getByRole('button', { name: 'PPT页面2', exact: true }).click();
  await expect.poll(() => canvasPixel(page)).toEqual([0, 0, 255]);
  await expect(video.getByLabel('PPT本页秒数', { exact: true })).toHaveValue('2');
});

test('PPT frame-rate changes stay contiguous and sequence copies retain independent settings after an empty music track is removed', async ({
  page,
}) => {
  await prepareRankingPages(page);
  const video = editor(page);
  await setNumber(video, 'PPT默认每页秒数', 5.017);
  await video.getByRole('button', { name: '应用到所有页面', exact: true }).click();
  const at60 = activeSequence(await saveProject(page));
  expect(pagesOf(at60).map((clip) => clip.duration)).toEqual([301, 301, 301]);
  await video.getByRole('button', { name: '序列设置', exact: true }).click();
  const settingsDialog = page.getByRole('dialog', { name: '序列设置', exact: true });
  await settingsDialog.getByLabel('序列fps', { exact: true }).fill('30');
  await settingsDialog.getByRole('button', { name: '应用序列设置', exact: true }).click();
  await expect(settingsDialog).not.toBeVisible();
  await expect(video.getByLabel('PPT页面总数', { exact: true })).toHaveText('3 页');
  await expect(video.locator('.ve-ppt-unsupported')).toHaveCount(0);
  const at30 = activeSequence(await saveProject(page));
  expect(at30.fps).toBe(30);
  const convertedPages = pagesOf(at30);
  expect(convertedPages.map((clip) => clip.duration)).toEqual([151, 151, 151]);
  expect(convertedPages.map((clip) => clip.start)).toEqual([0, 151, 302]);
  await video.getByRole('button', { name: 'PPT页面2', exact: true }).click();
  await setNumber(video, 'PPT本页秒数', 2.5);
  const original = activeSequence(await saveProject(page));
  expect(pagesOf(original).map((clip) => clip.duration)).toEqual([151, 75, 151]);
  await video.getByRole('button', { name: '复制序列', exact: true }).click();
  const duplicated = await saveProject(page),
    firstCopy = activeSequence(duplicated);
  expect(duplicated.sequences.find((sequence) => sequence.id === original.id)).toEqual(original);
  expect(firstCopy.id).not.toBe(original.id);
  expect(firstCopy.slideshow?.pageTrackId).not.toBe(original.slideshow?.pageTrackId);
  expect(firstCopy.slideshow?.bgmTrackId).not.toBe(original.slideshow?.bgmTrackId);
  expect(firstCopy.tracks.some((track) => track.id === firstCopy.slideshow?.pageTrackId)).toBe(
    true,
  );
  expect(firstCopy.tracks.some((track) => track.id === firstCopy.slideshow?.bgmTrackId)).toBe(true);
  const originalIds = new Set(original.clips.map((clip) => clip.id));
  expect(firstCopy.clips.every((clip) => !originalIds.has(clip.id))).toBe(true);
  expect(
    pagesOf(firstCopy).map((clip) => ({
      assetId: clip.assetId,
      start: clip.start,
      duration: clip.duration,
    })),
  ).toEqual(
    pagesOf(original).map((clip) => ({
      assetId: clip.assetId,
      start: clip.start,
      duration: clip.duration,
    })),
  );
  await switchMode(page, 'timeline');
  const audioTrack = firstCopy.tracks.find((track) => track.kind === 'audio')!;
  await video.getByRole('button', { name: `删除轨道 ${audioTrack.name}`, exact: true }).click();
  const withoutAudio = activeSequence(await saveProject(page));
  expect(withoutAudio.tracks.some((track) => track.kind === 'audio')).toBe(false);
  await video.getByRole('button', { name: '复制序列', exact: true }).click();
  await switchMode(page, 'ppt');
  await expect(video.getByLabel('PPT页面总数', { exact: true })).toHaveText('3 页');
  const copiedWithoutAudio = activeSequence(await saveProject(page));
  expect(copiedWithoutAudio.slideshow?.bgmTrackId).toEqual(expect.any(String));
  expect(copiedWithoutAudio.slideshow?.bgmTrackId).not.toBe(audioTrack.id);
  expect(copiedWithoutAudio.slideshow?.bgmTrackId.length).toBeGreaterThan(0);
  await setNumber(video, 'PPT默认每页秒数', 2);
  await video.getByRole('button', { name: '应用到所有页面', exact: true }).click();
  const finalProject = await saveProject(page),
    finalSequence = activeSequence(finalProject);
  expect(pagesOf(finalSequence).map((clip) => clip.duration)).toEqual([60, 60, 60]);
  expect(
    finalSequence.tracks.find((track) => track.id === finalSequence.slideshow?.bgmTrackId)?.kind,
  ).toBe('audio');
  expect(finalProject.sequences.find((sequence) => sequence.id === original.id)).toEqual(original);
  expect(finalProject.sequences.find((sequence) => sequence.id === withoutAudio.id)).toEqual(
    withoutAudio,
  );
});
