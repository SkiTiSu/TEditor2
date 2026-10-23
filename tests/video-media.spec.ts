import { expect, test } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

test.beforeEach(async ({ page }) => {
  await page.route('**/video-media-test', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Local video media validation</title>',
    }),
  );
  await page.goto('/video-media-test');
});

test('real H.264/AAC export preserves trimmed mixed-rate video, transformed layers, looped PCM and frame range', async ({
  page,
}, testInfo) => {
  const result = await page.evaluate(async () => {
    const fixturePath = '/tests/video-media-fixtures.ts',
      exportPath = '/src/video/export.ts',
      bunnyPath = '/node_modules/.vite/deps/mediabunny.js';
    const { fixture, tone, rms } = await import(fixturePath);
    const { exportSequence, checkExportCapabilities } = await import(exportPath);
    const { Input, BlobSource, ALL_FORMATS, VideoSampleSink, AudioBufferSink } = await import(
      bunnyPath
    );
    const f = await fixture();
    const caps = await checkExportCapabilities(f.sequence);
    const progress: number[] = [];
    const output = await exportSequence(f.project, f.sequence, f.renderer, {
      videoBitrate: 2_000_000,
      onProgress: (p: { ratio: number }) => progress.push(p.ratio),
    });
    const input = new Input({ source: new BlobSource(output.file), formats: ALL_FORMATS });
    const video = await input.getPrimaryVideoTrack(),
      audio = await input.getPrimaryAudioTrack();
    const samples = new VideoSampleSink(video),
      canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    const ctx = canvas.getContext('2d')!;
    const pixels: number[][] = [];
    for (const time of [0.1, 0.75]) {
      const sample = await samples.getSample(time);
      sample.draw(ctx, 0, 0);
      sample.close();
      pixels.push([...ctx.getImageData(160, 80, 1, 1).data]);
    }
    const corner = [...ctx.getImageData(4, 4, 1, 1).data];
    const decoded = new Float32Array(24000);
    for await (const part of new AudioBufferSink(audio).buffers(0, 0.5)) {
      const data = part.buffer.getChannelData(0),
        start = Math.round(part.timestamp * 48000);
      for (let i = 0; i < data.length; i++)
        if (start + i >= 0 && start + i < decoded.length) decoded[start + i] = data[i];
    }
    const range = await exportSequence(f.project, f.sequence, f.renderer, {
      startFrame: 30,
      endFrame: 60,
      videoBitrate: 2_000_000,
    });
    const rangeInput = new Input({ source: new BlobSource(range.file), formats: ALL_FORMATS });
    const rangeVideo = await rangeInput.getPrimaryVideoTrack();
    const rangeSample = await new VideoSampleSink(rangeVideo).getSample(0);
    rangeSample.draw(ctx, 0, 0);
    rangeSample.close();
    const rangePixel = [...ctx.getImageData(160, 80, 1, 1).data];
    const result = {
      capabilities: caps,
      sourceDuration: f.video.duration,
      sourceHasAudio: f.video.hasAudio,
      videoCodec: await video.getCodec(),
      audioCodec: await audio.getCodec(),
      frames: (await video.computePacketStats()).packetCount,
      videoFirst: await video.getFirstTimestamp(),
      audioFirst: await audio.getFirstTimestamp(),
      videoDuration: await video.computeDuration(),
      audioDuration: await audio.computeDuration(),
      duration: await input.computeDuration(),
      bytes: output.bytes,
      elapsedMs: output.elapsedMs,
      rangeFrames: (await rangeVideo.computePacketStats()).packetCount,
      rangePixel,
      pixels,
      corner,
      rms: rms(decoded),
      originalTone: tone(decoded, 440, 48000),
      bgmTone: tone(decoded, 880, 48000),
      progress,
      diagnostics: f.renderer.diagnostics,
    };
    input.dispose();
    rangeInput.dispose();
    await output.cleanup();
    await range.cleanup();
    f.renderer.dispose();
    return result;
  });
  expect(result.capabilities.supported).toBe(true);
  expect(result.sourceHasAudio).toBe(true);
  expect(result.videoCodec).toBe('avc');
  expect(result.audioCodec).toBe('aac');
  expect(result.frames).toBe(60);
  expect(result.rangeFrames).toBe(30);
  expect(Math.abs(result.duration - 1)).toBeLessThan(0.03);
  expect(result.pixels[0][1]).toBeGreaterThan(180);
  expect(result.pixels[0][0]).toBeLessThan(30);
  expect(result.pixels[1][0]).toBeGreaterThan(180);
  expect(result.pixels[1][1]).toBeLessThan(30);
  expect(result.rangePixel[0]).toBeGreaterThan(180);
  expect(result.corner[2]).toBeGreaterThan(220);
  expect(result.rms).toBeGreaterThan(0.06);
  expect(result.originalTone).toBeGreaterThan(0.08);
  expect(result.bgmTone).toBeGreaterThan(0.04);
  expect(result.bytes).toBeGreaterThan(1000);
  expect(result.progress.at(-1)).toBe(1);
  await testInfo.attach('real-av-export.json', {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json',
  });
});

test('audio mute/solo, clip fades, accurate source seek, and loop boundaries share the preview mixer', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const path = '/tests/video-media-fixtures.ts';
    const { fixture, rms, tone } = await import(path),
      f = await fixture();
    const mixed = await f.renderer.mixAudio(f.project, f.sequence, 0.1, 0.2);
    f.a2.muted = true;
    const original = await f.renderer.mixAudio(f.project, f.sequence, 0.1, 0.2);
    f.a2.muted = false;
    f.a2.solo = true;
    const solo = await f.renderer.mixAudio(f.project, f.sequence, 0.1, 0.2);
    f.music.fadeIn = 30;
    const fade = await f.renderer.mixAudio(f.project, f.sequence, 0, 0.05);
    f.music.fadeIn = 0;
    const loop = await f.renderer.mixAudio(f.project, f.sequence, 0.35, 0.2);
    const a = loop.getChannelData(0);
    const silent = a.reduce(
      (count: number, value: number) => count + (Math.abs(value) < 0.00001 ? 1 : 0),
      0,
    );
    f.a2.muted = true;
    const muteSolo = await f.renderer.mixAudio(f.project, f.sequence, 0.2, 0.1);
    f.renderer.dispose();
    return {
      mix: rms(mixed.getChannelData(0)),
      original440: tone(original.getChannelData(0), 440, 48000),
      original880: tone(original.getChannelData(0), 880, 48000),
      solo440: tone(solo.getChannelData(0), 440, 48000),
      solo880: tone(solo.getChannelData(0), 880, 48000),
      fade: rms(fade.getChannelData(0)),
      loop: rms(a),
      silent,
      muteSolo: rms(muteSolo.getChannelData(0)),
    };
  });
  expect(result.mix).toBeGreaterThan(0.08);
  expect(result.original440).toBeGreaterThan(0.09);
  expect(result.original880).toBeLessThan(0.01);
  expect(result.solo440).toBeLessThan(0.01);
  expect(result.solo880).toBeGreaterThan(0.08);
  expect(result.fade).toBeLessThan(0.01);
  expect(result.loop).toBeGreaterThan(0.06);
  expect(result.silent).toBeLessThan(100);
  expect(result.muteSolo).toBe(0);
});

test('linked graphics update without PNG intermediates and crossfade has a full-brightness midpoint', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const modelPath = '/src/video/model.ts',
      compositorPath = '/src/video/compositor.ts',
      mediaPath = '/src/video/media.ts',
      docPath = '/src/core/document.ts';
    const { createProject, createSequence, createClip, createGraphicSource, createGraphicAssets } =
      await import(modelPath);
    const { SequenceRenderer } = await import(compositorPath),
      { MediaLibrary } = await import(mediaPath);
    const { createDocument, createLayer } = await import(docPath);
    const project = createProject(),
      sequence = createSequence('Graphic', 320, 180, 60);
    project.sequences = [sequence];
    project.activeSequenceId = sequence.id;
    const doc = createDocument(320, 180),
      background = createLayer('Rectangle');
    Object.assign(background.Data, { Width: 320, Height: 180, FillColor: '#ff0000' });
    doc.Layers.push(background);
    const source = createGraphicSource(doc, { headers: [], rows: [] }, '关联图文');
    project.graphics = [source];
    project.assets = createGraphicAssets(source);
    const clip = createClip(project.assets[0], sequence.tracks[0].id, 0, 60, sequence);
    sequence.clips = [clip];
    const renderer = new SequenceRenderer(new MediaLibrary(), async () => null),
      canvas = document.createElement('canvas');
    const read = () => [...canvas.getContext('2d')!.getImageData(160, 90, 1, 1).data];
    await renderer.render(canvas, project, sequence, 0);
    const first = read();
    source.document.Layers[0].Data.FillColor = '#00ff00';
    source.revision++;
    await renderer.render(canvas, project, sequence, 0);
    const updated = read();
    const branch = structuredClone(source);
    branch.document.Layers[0].Data.FillColor = '#0000ff'; // Same revision after an undo/edit branch.
    project.graphics = [branch];
    await renderer.render(canvas, project, sequence, 0);
    const branched = read();
    project.graphics = [source];
    const blue = {
      id: 'blue',
      kind: 'color',
      name: 'Blue',
      color: '#0000ff',
      width: 320,
      height: 180,
      duration: 0,
      hasAudio: false,
    };
    project.assets.push(blue);
    const next = createClip(blue, sequence.tracks[0].id, 30, 60, sequence);
    sequence.clips.push(next);
    sequence.transitions.push({
      id: 'dissolve',
      fromClipId: clip.id,
      toClipId: next.id,
      duration: 30,
    });
    await renderer.render(canvas, project, sequence, 45);
    const midpoint = read();
    sequence.tracks[0].hidden = true;
    await renderer.render(canvas, project, sequence, 45);
    const hidden = read();
    renderer.dispose();
    return { first, updated, branched, midpoint, hidden };
  });
  expect(result.first.slice(0, 3)).toEqual([255, 0, 0]);
  expect(result.updated.slice(0, 3)).toEqual([0, 255, 0]);
  expect(result.branched.slice(0, 3)).toEqual([0, 0, 255]);
  expect(result.midpoint[1]).toBeGreaterThanOrEqual(127);
  expect(result.midpoint[2]).toBeGreaterThanOrEqual(127);
  expect(result.hidden.slice(0, 3)).toEqual([0, 0, 0]);
});

test('cancel removes temporary output and preserves reusable media; preflight locates missing files', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const fixturePath = '/tests/video-media-fixtures.ts',
      exportPath = '/src/video/export.ts';
    const { fixture } = await import(fixturePath),
      { exportSequence, preflightExport } = await import(exportPath),
      f = await fixture();
    const root = await navigator.storage.getDirectory();
    const entries = async () => {
      const names: string[] = [];
      for await (const key of (root as unknown as { keys(): AsyncIterable<string> }).keys())
        names.push(key);
      return names.sort();
    };
    const before = await entries(),
      controller = new AbortController();
    let error = '';
    try {
      await exportSequence(f.project, f.sequence, f.renderer, {
        signal: controller.signal,
        onProgress: (p: { phase: string }) => {
          if (p.phase === 'rendering') controller.abort();
        },
      });
    } catch (e) {
      error = e instanceof Error ? e.name : String(e);
    }
    const after = await entries();
    const canvas = document.createElement('canvas');
    await f.renderer.render(canvas, f.project, f.sequence, 0, { strict: true });
    f.media.remove(f.video.id);
    const preflight = await preflightExport(f.project, f.sequence, f.renderer);
    f.renderer.dispose();
    return { error, before, after, errors: preflight.errors, width: canvas.width };
  });
  expect(result.error).toBe('AbortError');
  expect(result.after).toEqual(result.before);
  expect(result.width).toBe(320);
  expect(result.errors.join(' ')).toContain('sample-30fps.mp4');
});

test('AAC impulse round-trip has sample-accurate sync and an exact one-second tail', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const fixturePath = '/tests/video-media-fixtures.ts',
      modelPath = '/src/video/model.ts',
      exportPath = '/src/video/export.ts',
      bunnyPath = '/node_modules/.vite/deps/mediabunny.js';
    const { fixture, makeWav } = await import(fixturePath),
      { createClip } = await import(modelPath);
    const { exportSequence } = await import(exportPath),
      { Input, BlobSource, ALL_FORMATS, AudioBufferSink } = await import(bunnyPath);
    const f = await fixture(),
      bytes = await makeWav(1, 440, 48000).arrayBuffer(),
      view = new DataView(bytes);
    for (let i = 44; i < bytes.byteLength; i += 2) view.setInt16(i, 0, true);
    view.setInt16(44 + 9600 * 2, 28000, true);
    view.setInt16(44 + 38400 * 2, -25000, true);
    const impulse = await f.media.probe(
      new File([bytes], 'sync-impulses.wav', { type: 'audio/wav' }),
    );
    f.project.assets.push(impulse);
    f.sequence.clips = f.sequence.clips.filter(
      (clip: { trackId: string }) => clip.trackId !== f.a1.id && clip.trackId !== f.a2.id,
    );
    f.sequence.clips.push(createClip(impulse, f.a1.id, 0, 60, f.sequence));
    const output = await exportSequence(f.project, f.sequence, f.renderer, {
      videoBitrate: 1_000_000,
    });
    const input = new Input({ source: new BlobSource(output.file), formats: ALL_FORMATS }),
      audio = await input.getPrimaryAudioTrack();
    const decoded = new Float32Array(48000);
    for await (const part of new AudioBufferSink(audio).buffers()) {
      const offset = Math.round(part.timestamp * 48000),
        values = part.buffer.getChannelData(0);
      for (let i = 0; i < values.length; i++)
        if (i + offset >= 0 && i + offset < decoded.length) decoded[i + offset] = values[i];
    }
    const peaks = [9600, 38400].map((position) => {
      let peak = position - 2400;
      for (let i = position - 2400; i < position + 2400; i++)
        if (Math.abs(decoded[i]) > Math.abs(decoded[peak])) peak = i;
      return { position: peak, amplitude: decoded[peak] };
    });
    const duration = await input.computeDuration();
    input.dispose();
    await output.cleanup();
    f.renderer.dispose();
    return { peaks, duration };
  });
  expect(Math.abs(result.peaks[0].position - 9600)).toBeLessThanOrEqual(4);
  expect(Math.abs(result.peaks[1].position - 38400)).toBeLessThanOrEqual(4);
  expect(Math.abs(result.peaks[0].amplitude)).toBeGreaterThan(0.3);
  expect(result.duration).toBe(1);
});

test('scoped graphic resources isolate same paths and invalidate after relinking', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const modelPath = '/src/video/model.ts',
      compositorPath = '/src/video/compositor.ts',
      mediaPath = '/src/video/media.ts',
      docPath = '/src/core/document.ts',
      exportPath = '/src/video/export.ts';
    const { createProject, createSequence, createClip, createGraphicSource, createGraphicAssets } =
      await import(modelPath);
    const { SequenceRenderer } = await import(compositorPath),
      { MediaLibrary } = await import(mediaPath),
      { preflightExport } = await import(exportPath);
    const { createDocument, createLayer } = await import(docPath);
    const makeImage = async (color: string) => {
      const c = document.createElement('canvas');
      c.width = c.height = 32;
      c.getContext('2d')!.fillStyle = color;
      c.getContext('2d')!.fillRect(0, 0, 32, 32);
      return new File(
        [await new Promise<Blob>((resolve) => c.toBlob((blob) => resolve(blob!)))],
        'avatar.png',
        { type: 'image/png' },
      );
    };
    const [red, blue, green] = await Promise.all(['#ff0000', '#0000ff', '#00ff00'].map(makeImage));
    const project = createProject(),
      sequence = createSequence('Scoped', 320, 180, 60),
      media = new MediaLibrary();
    project.sequences = [sequence];
    project.activeSequenceId = sequence.id;
    const doc = createDocument(320, 180),
      layer = createLayer('Image');
    Object.assign(layer.Data, { Width: 320, Height: 180, ImageUrl: 'avatar.png' });
    doc.Layers.push(layer);
    for (const [id, file] of [
      ['red-resource', red],
      ['blue-resource', blue],
    ] as const) {
      const source = createGraphicSource(doc, { headers: [], rows: [] }, id);
      source.resources = [
        {
          id,
          path: 'avatar.png',
          fileName: file.name,
          size: file.size,
          lastModified: file.lastModified,
          mimeType: file.type,
        },
      ];
      project.graphics.push(source);
      project.assets.push(...createGraphicAssets(source));
      media.register(id, file);
    }
    project.assets.forEach((asset: any, index: number) =>
      sequence.clips.push(createClip(asset, sequence.tracks[0].id, index * 60, 60, sequence)),
    );
    let globalCalls = 0;
    const renderer = new SequenceRenderer(media, async () => {
        globalCalls++;
        return createImageBitmap(green);
      }),
      canvas = document.createElement('canvas');
    const pixel = () => [...canvas.getContext('2d')!.getImageData(160, 90, 1, 1).data];
    await renderer.render(canvas, project, sequence, 0);
    const first = pixel();
    await renderer.render(canvas, project, sequence, 60);
    const second = pixel();
    media.remove('blue-resource');
    await renderer.render(canvas, project, sequence, 60);
    const missing = pixel();
    const errors = (await preflightExport(project, sequence, renderer)).errors;
    media.register('blue-resource', green);
    await renderer.render(canvas, project, sequence, 60);
    const restored = pixel();
    renderer.dispose();
    return { first, second, missing, restored, errors, globalCalls };
  });
  expect(result.first.slice(0, 3)).toEqual([255, 0, 0]);
  expect(result.second.slice(0, 3)).toEqual([0, 0, 255]);
  expect(result.missing.slice(0, 3)).not.toEqual([0, 255, 0]);
  expect(result.restored.slice(0, 3)).toEqual([0, 255, 0]);
  expect(result.errors.join(' ')).toContain('avatar.png');
  expect(result.globalCalls).toBe(0);
});

test('imported fonts with the same family use isolated aliases and missing fonts block export', async ({
  page,
}) => {
  const paths = [
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/System/Library/Fonts/Supplemental/Times New Roman.ttf',
  ];
  test.skip(
    paths.some((path) => !existsSync(path)),
    'Requires two installed test fonts on macOS; no font is bundled or uploaded.',
  );
  for (let index = 0; index < paths.length; index++) {
    const data = await readFile(paths[index]);
    await page.route(`**/video-media-font-${index}`, (route) =>
      route.fulfill({ contentType: 'font/ttf', body: data }),
    );
  }
  const result = await page.evaluate(async () => {
    const modelPath = '/src/video/model.ts',
      compositorPath = '/src/video/compositor.ts',
      mediaPath = '/src/video/media.ts',
      docPath = '/src/core/document.ts',
      exportPath = '/src/video/export.ts';
    const { createProject, createSequence, createClip, createGraphicSource, createGraphicAssets } =
      await import(modelPath);
    const { SequenceRenderer } = await import(compositorPath),
      { MediaLibrary } = await import(mediaPath),
      { preflightExport } = await import(exportPath);
    const { createDocument, createLayer } = await import(docPath);
    const project = createProject(),
      sequence = createSequence('Fonts', 320, 180, 60),
      media = new MediaLibrary();
    project.sequences = [sequence];
    project.activeSequenceId = sequence.id;
    const doc = createDocument(320, 180),
      layer = createLayer('Text');
    Object.assign(layer.Data, {
      Text: 'WWiill Mixed',
      FontFamilyName: 'SameFont',
      FontSize: 40,
      Color: '#ffffff',
    });
    layer.Top = 30;
    doc.Layers.push(layer);
    for (let index = 0; index < 2; index++) {
      const file = new File(
          [await (await fetch(`/video-media-font-${index}`)).arrayBuffer()],
          'SameFont.ttf',
          { type: 'font/ttf' },
        ),
        id = `font-${index}`;
      const source = createGraphicSource(doc, { headers: [], rows: [] }, id);
      source.resources = [
        {
          id,
          path: 'SameFont.ttf',
          fileName: file.name,
          size: file.size,
          lastModified: file.lastModified,
          mimeType: file.type,
          fontFamily: 'SameFont',
        },
      ];
      project.graphics.push(source);
      project.assets.push(...createGraphicAssets(source));
      media.register(id, file);
    }
    project.assets.forEach((asset: any, index: number) =>
      sequence.clips.push(createClip(asset, sequence.tracks[0].id, index * 60, 60, sequence)),
    );
    const renderer = new SequenceRenderer(media, async () => null),
      canvas = document.createElement('canvas');
    const pixels = () => canvas.toDataURL();
    await renderer.render(canvas, project, sequence, 0);
    const first = pixels();
    await renderer.render(canvas, project, sequence, 60);
    const second = pixels();
    const aliases = [...document.fonts]
      .map((font) => font.family)
      .filter((family) => family.startsWith('tevideo-font-'));
    media.remove('font-1');
    const errors = (await preflightExport(project, sequence, renderer)).errors;
    renderer.dispose();
    const left = [...document.fonts].filter((font) =>
      font.family.startsWith('tevideo-font-'),
    ).length;
    return {
      different: first !== second,
      aliases,
      errors,
      left,
      originalFamily: project.graphics[0].document.Layers[0].Data.FontFamilyName,
    };
  });
  expect(result.different).toBe(true);
  expect(new Set(result.aliases).size).toBe(2);
  expect(result.originalFamily).toBe('SameFont');
  expect(result.errors.join(' ')).toContain('字体未关联');
  expect(result.left).toBe(0);
});

test('30-minute 1080p60 streamed export long-run validation', async ({ page }, testInfo) => {
  test.skip(
    process.env.VIDEO_LONG_TEST !== '1',
    'Set VIDEO_LONG_TEST=1 to run the 108000-frame real H.264/AAC export.',
  );
  test.setTimeout(7_200_000);
  const result = await page.evaluate(async () => {
    const fixturePath = '/tests/video-media-fixtures.ts',
      modelPath = '/src/video/model.ts',
      exportPath = '/src/video/export.ts',
      bunnyPath = '/node_modules/.vite/deps/mediabunny.js';
    const { fixture } = await import(fixturePath),
      { createClip, createTrack } = await import(modelPath),
      { exportSequence } = await import(exportPath);
    const { Input, BlobSource, ALL_FORMATS, AudioBufferSink, VideoSampleSink } = await import(
      bunnyPath
    );
    const f = await fixture();
    f.sequence.width = 1920;
    f.sequence.height = 1080;
    const duration = 30 * 60 * 60;
    for (const clip of f.sequence.clips) {
      clip.duration = duration;
      if (clip.assetId === f.video.id || clip.assetId === f.bgm.id) clip.loop = true;
      clip.transform.width *= 6;
      clip.transform.height *= 6;
      clip.transform.x *= 6;
      clip.transform.y *= 6;
    }
    const upper = createTrack('video', '第三画面轨');
    f.sequence.tracks.unshift(upper);
    const label = {
      id: 'label',
      name: 'Long-run title',
      kind: 'text',
      duration: 0,
      hasAudio: false,
      width: 1920,
      height: 160,
      text: 'TEditor2 · 1080p60 / 30 min',
      color: '#ffffff',
      fontSize: 60,
    };
    f.project.assets.push(label);
    const clip = createClip(label, upper.id, 0, duration, f.sequence);
    clip.transform.height = 160;
    f.sequence.clips.push(clip);
    const memory: { frame: number; heap: number | null }[] = [];
    let last = -1;
    const output = await exportSequence(f.project, f.sequence, f.renderer, {
      videoBitrate: 4_000_000,
      onProgress: (p: { completed: number }) => {
        const minute = Math.floor(p.completed / 3600);
        if (minute !== last) {
          last = minute;
          memory.push({
            frame: p.completed,
            heap:
              (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
                ?.usedJSHeapSize ?? null,
          });
        }
      },
    });
    const input = new Input({ source: new BlobSource(output.file), formats: ALL_FORMATS }),
      video = await input.getPrimaryVideoTrack(),
      audio = await input.getPrimaryAudioTrack();
    const audioChecks = [];
    for (const at of [0.1, 900.1, 1799.6]) {
      let energy = 0,
        count = 0;
      for await (const part of new AudioBufferSink(audio).buffers(at, at + 0.25)) {
        const values = part.buffer.getChannelData(0);
        for (let i = 0; i < values.length; i++) {
          const time = part.timestamp + i / part.buffer.sampleRate;
          if (time >= at && time < at + 0.25) {
            energy += values[i] ** 2;
            count++;
          }
        }
      }
      audioChecks.push({ time: at, rms: Math.sqrt(energy / Math.max(1, count)), samples: count });
    }
    const lastPicture = await new VideoSampleSink(video).getSample(1799.75);
    const sampleCanvas = document.createElement('canvas');
    sampleCanvas.width = 1920;
    sampleCanvas.height = 1080;
    lastPicture.draw(sampleCanvas.getContext('2d')!, 0, 0);
    lastPicture.close();
    const lastPicturePixel = [...sampleCanvas.getContext('2d')!.getImageData(960, 540, 1, 1).data];
    const result = {
      capturedAt: new Date().toISOString(),
      source:
        '2-second 320x180 H.264 30fps + AAC clip looped; 44.1kHz mono PCM BGM looped; color and text layers',
      storage: 'fragmented MP4 streamed in 1 MiB chunks to OPFS',
      memoryScope:
        'performance.memory.usedJSHeapSize; excludes browser native decoder/encoder/GPU allocations',
      browser: navigator.userAgent,
      platform: navigator.platform,
      hardwareConcurrency: navigator.hardwareConcurrency,
      resolution: '1920x1080',
      fps: 60,
      videoTracks: 3,
      audioTracks: 2,
      frames: (await video.computePacketStats()).packetCount,
      duration: await input.computeDuration(),
      videoDuration: await video.computeDuration(),
      audioDuration: await audio.computeDuration(),
      videoCodec: await video.getCodec(),
      audioCodec: await audio.getCodec(),
      bytes: output.bytes,
      elapsedMs: output.elapsedMs,
      memory,
      audioChecks,
      lastPicturePixel,
    };
    input.dispose();
    await output.cleanup();
    f.renderer.dispose();
    return result;
  });
  await writeFile(
    new URL('../docs/VIDEO_EDITOR_LONG_RUN.json', import.meta.url),
    JSON.stringify(result, null, 2) + '\n',
  );
  console.log(
    JSON.stringify({
      frames: result.frames,
      duration: result.duration,
      elapsedMs: result.elapsedMs,
      bytes: result.bytes,
      audioChecks: result.audioChecks,
      heap: result.memory,
    }),
  );
  expect(result.frames).toBe(108000);
  expect(Math.abs(result.duration - 1800)).toBeLessThan(0.04);
  expect(Math.abs(result.videoDuration - result.audioDuration)).toBeLessThan(0.04);
  expect(result.videoCodec).toBe('avc');
  expect(result.audioCodec).toBe('aac');
  for (const check of result.audioChecks) {
    expect(check.rms).toBeGreaterThan(0.03);
    expect(check.samples).toBeGreaterThan(11000);
  }
  expect(Math.max(result.lastPicturePixel[0], result.lastPicturePixel[1])).toBeGreaterThan(150);
  await testInfo.attach('1080p60-30min-validation.json', {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json',
  });
});
