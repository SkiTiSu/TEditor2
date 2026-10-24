import { expect, test } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { createClip, createProject } from '../src/video/model';
import type { MediaAsset, VideoProject } from '../src/video/types';

test('real complex video export passes 6/40 Mbps and CBR controls and reports measured packet rates', async ({
  page,
}, testInfo) => {
  await page.route('**/encoding-test', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Encoding validation</title>',
    }),
  );
  await page.goto('/encoding-test');
  const results = await page.evaluate(async () => {
    const bunnyPath = '/node_modules/.vite/deps/mediabunny.js',
      exportPath = '/src/video/export.ts',
      modelPath = '/src/video/model.ts',
      mediaPath = '/src/video/media.ts',
      compositorPath = '/src/video/compositor.ts';
    const {
      CanvasSource,
      Quality,
      Output,
      Mp4OutputFormat,
      BufferTarget,
      Input,
      BlobSource,
      ALL_FORMATS,
      VideoSampleSink,
    } = await import(bunnyPath);
    const { exportSequence } = await import(exportPath);
    const { createProject, createSequence, createClip } = await import(modelPath);
    const { MediaLibrary } = await import(mediaPath);
    const { SequenceRenderer } = await import(compositorPath);
    // Deterministic changing texture gives the encoder enough detail to use either target bitrate.
    const canvas = document.createElement('canvas');
    canvas.width = 1920;
    canvas.height = 1080;
    const texture = document.createElement('canvas');
    texture.width = 240;
    texture.height = 135;
    const ctx = canvas.getContext('2d')!,
      tx = texture.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    const pixels = tx.createImageData(240, 135);
    const target = new BufferTarget();
    const output = new Output({ format: new Mp4OutputFormat(), target });
    const source = new CanvasSource(canvas, {
      codec: 'avc',
      quality: new Quality({ bitrate: 60e6 }),
    });
    output.addVideoTrack(source, { frameRate: 30 });
    await output.start();
    let seed = 23;
    for (let frame = 0; frame < 60; frame++) {
      for (let i = 0; i < pixels.data.length; i += 4) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        pixels.data[i] = seed >>> 24;
        pixels.data[i + 1] = (seed >>> 16) & 255;
        pixels.data[i + 2] = (seed >>> 8) & 255;
        pixels.data[i + 3] = 255;
      }
      tx.putImageData(pixels, 0, 0);
      ctx.drawImage(texture, 0, 0, 1920, 1080);
      await source.add(frame / 30, 1 / 30);
    }
    source.close();
    await output.finalize();
    const media = new MediaLibrary(),
      project = createProject();
    const asset = await media.probe(
      new File([target.buffer], 'complex.mp4', { type: 'video/mp4' }),
    );
    const sequence = createSequence('1080p complex motion', 1920, 1080, 30);
    project.sequences = [sequence];
    project.activeSequenceId = sequence.id;
    project.assets = [asset];
    sequence.clips = [createClip(asset, sequence.tracks[0].id, 0, 60, sequence)];
    const renderer = new SequenceRenderer(media, async () => null);
    const reports = [];
    try {
      for (const [videoBitrate, videoBitrateMode] of [
        [6e6, 'variable'],
        [40e6, 'variable'],
        [6e6, 'constant'],
      ] as const) {
        const result = await exportSequence(project, sequence, renderer, {
          videoBitrate,
          videoBitrateMode,
        });
        const input = new Input({ source: new BlobSource(result.file), formats: ALL_FORMATS });
        try {
          const track = await input.getPrimaryVideoTrack();
          const stats = await track.computePacketStats();
          const sample = await new VideoSampleSink(track).getSample(1.5);
          const decoded = !!sample;
          sample?.close();
          reports.push({
            requested: videoBitrate,
            mode: videoBitrateMode,
            actual: result.actualVideoBitrate,
            config: result.encoderConfig,
            stats,
            duration: await input.computeDuration(),
            bytes: result.bytes,
            decoded,
          });
        } finally {
          input.dispose();
          await result.cleanup();
        }
      }
    } finally {
      renderer.dispose();
      media.dispose();
    }
    return reports;
  });
  const metricsPath = testInfo.outputPath('bitrate-measurements.json');
  await writeFile(metricsPath, JSON.stringify(results, null, 2));
  await testInfo.attach('bitrate-measurements.json', {
    path: metricsPath,
    contentType: 'application/json',
  });
  for (const result of results) {
    expect(result.config.bitrate).toBe(result.requested);
    expect(result.config.bitrateMode).toBe(result.mode);
    expect(result.config.framerate).toBe(30);
    expect(result.stats.packetCount).toBe(60);
    expect(result.stats.averagePacketRate).toBeCloseTo(30, 3);
    expect(result.duration).toBeCloseTo(2, 3);
    expect(result.decoded).toBe(true);
    expect(result.actual).toBeCloseTo(result.stats.averageBitrate, 0);
  }
  expect(results[1].actual).toBeGreaterThan(results[0].actual * 2);
  expect(results[1].bytes).toBeGreaterThan(results[0].bytes * 2);
});

test('UI preserves bitrate mode and allows 240 fps in sequence, template and actual MP4 export', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true');
  await page.getByRole('button', { name: '视频剪辑', exact: true }).click();
  const video = page.locator('.video-editor');
  await expect(video).toHaveAttribute('data-ready', 'true');
  const project = createProject();
  const sequence = project.sequences[0];
  const asset: MediaAsset = {
    id: 'color',
    name: 'color',
    kind: 'color',
    color: '#007755',
    duration: 0,
    width: 1920,
    height: 1080,
    hasAudio: false,
  };
  project.assets = [asset];
  sequence.clips = [createClip(asset, sequence.tracks[0].id, 0, 60, sequence)];
  await video.getByLabel('打开视频工程文件').setInputFiles({
    name: 'encoding.tevideo',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await video.getByRole('button', { name: '导出视频', exact: true }).click();
  const dialog = video.getByRole('dialog', { name: '视频导出', exact: true });
  await expect(dialog.getByLabel('视频码率', { exact: true })).toHaveValue('6');
  await expect(dialog.getByLabel('码率模式', { exact: true })).toHaveValue('variable');
  await dialog.getByLabel('视频码率', { exact: true }).selectOption('40');
  await dialog.getByLabel('码率模式').selectOption('constant');
  await dialog.getByRole('button', { name: '关闭视频对话框' }).click();
  const pending = page.waitForEvent('download');
  await video.getByRole('button', { name: '保存工程', exact: true }).click();
  const saved: VideoProject = JSON.parse(await readFile((await (await pending).path())!, 'utf8'));
  expect(saved.sequences[0].exportSettings).toMatchObject({
    videoBitrate: 40e6,
    videoBitrateMode: 'constant',
  });
  await video.getByLabel('打开视频工程文件').setInputFiles({
    name: 'saved.tevideo',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(saved)),
  });
  await video.getByRole('button', { name: '导出视频', exact: true }).click();
  await expect(dialog.getByLabel('视频码率', { exact: true })).toHaveValue('40');
  await expect(dialog.getByLabel('码率模式')).toHaveValue('constant');
  await dialog.getByRole('button', { name: '关闭视频对话框' }).click();
  await video.getByRole('button', { name: '序列设置', exact: true }).click();
  await video.getByLabel('序列fps', { exact: true }).fill('240');
  await video.getByRole('button', { name: '应用序列设置', exact: true }).click();
  await expect(video.getByRole('dialog')).toHaveCount(0);
  await video.getByRole('button', { name: '排行榜工作台', exact: true }).click();
  await video.getByRole('button', { name: '2. 节目模板', exact: true }).click();
  const panel = video.getByLabel('排行榜模板', { exact: true });
  for (const index of [4, 3, 2])
    await panel.getByRole('button', { name: `删除章节${index}`, exact: true }).click();
  await panel.getByLabel('模板宽度').fill('320');
  await panel.getByLabel('模板高度').fill('180');
  await panel.getByLabel('模板帧率').fill('240');
  await panel.getByLabel('章节1时长').fill('0.25');
  await panel.getByRole('button', { name: '预览编排结果', exact: true }).click();
  await panel.getByRole('button', { name: '生成到新序列', exact: true }).click();
  await video.getByRole('button', { name: '导出视频', exact: true }).click();
  await expect(dialog).toContainText('240 fps');
  await dialog.getByLabel('码率模式').selectOption('constant');
  await dialog.getByRole('button', { name: '生成后下载', exact: true }).click();
  await expect(dialog.locator('.ve-export-status')).toContainText('导出完成：60 帧', {
    timeout: 60000,
  });
  await expect(dialog.locator('.ve-export-status')).toContainText('实际平均');
  const metrics = await dialog
    .getByRole('link', { name: '下载 MP4 视频' })
    .evaluate(async (link: HTMLAnchorElement) => {
      const path = '/node_modules/.vite/deps/mediabunny.js';
      const { Input, BlobSource, ALL_FORMATS } = await import(path);
      const input = new Input({
        source: new BlobSource(await (await fetch(link.href)).blob()),
        formats: ALL_FORMATS,
      });
      try {
        const track = await input.getPrimaryVideoTrack();
        return { stats: await track.computePacketStats(), duration: await input.computeDuration() };
      } finally {
        input.dispose();
      }
    });
  expect(metrics.stats.packetCount).toBe(60);
  expect(metrics.stats.averagePacketRate).toBeCloseTo(240, 2);
  expect(metrics.duration).toBeCloseTo(0.25, 3);
  await page.screenshot({ path: testInfo.outputPath('export-settings.png'), fullPage: true });
});
