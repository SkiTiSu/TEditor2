import { describe, expect, it } from 'vitest';
import { createDocument } from '../src/core/document';
import {
  createClip,
  createGraphicAssets,
  createGraphicSource,
  createProject,
  createSequence,
  createTrack,
  parseProject,
  sequenceDuration,
  serializeProject,
  validateSequence,
} from '../src/video/model';
import {
  createSlideshowSequence,
  duplicateSlides,
  enableSlideshow,
  insertSlides,
  inspectSlideshow,
  removeSlides,
  reorderSlides,
  rescaleSlideshow,
  setSlideDuration,
  setSlideshowSettings,
} from '../src/video/slideshow';
import { applyRankingTemplate, createDefaultTemplate } from '../src/video/templates';
import type { MediaAsset, VideoSequence } from '../src/video/types';

const image: MediaAsset = {
  id: 'image',
  name: '副榜图片',
  kind: 'image',
  width: 1920,
  height: 1080,
  duration: 0,
  hasAudio: false,
};
const color: MediaAsset = { ...image, id: 'color', kind: 'color', color: '#224466' };
const audio: MediaAsset = {
  ...image,
  id: 'audio',
  name: '背景音乐',
  kind: 'audio',
  duration: 4,
  hasAudio: true,
};
const video: MediaAsset = { ...audio, id: 'video', kind: 'video' };
const assets = [image, color, audio, video];
const pages = (sequence: VideoSequence) => inspectSlideshow(sequence, assets).pages;
function fixture(count = 3) {
  return insertSlides(createSlideshowSequence(), assets, Array(count).fill(image.id));
}

describe('PPT timeline projection and compatibility', () => {
  it('creates a normal, exportable timeline with frame-based preferences', () => {
    const sequence = createSlideshowSequence('副榜', 1280, 720, 30);
    expect(sequence).toMatchObject({ name: '副榜', width: 1280, height: 720, fps: 30, clips: [] });
    expect(sequence.slideshow).toMatchObject({
      defaultDuration: 150,
      transitionDuration: 0,
      bgmLoop: true,
      bgmFadeIn: 9,
    });
    expect(inspectSlideshow(sequence, assets).editable).toBe(true);
    expect(sequenceDuration(insertSlides(sequence, assets, [image.id, color.id]))).toBe(300);
  });

  it('does not rewrite timing, crop, IDs or auxiliary tracks when entering PPT mode', () => {
    const sequence = createSequence();
    const page = createClip(image, sequence.tracks[0].id, 0, 100, sequence);
    page.transform.crop.left = 0.1;
    page.transform.rotation = 30;
    sequence.clips.push(page);
    sequence.tracks.push(createTrack('video', '空前景轨'));
    const before = structuredClone(sequence);
    const inspection = inspectSlideshow(sequence, assets);
    expect(inspection.editable).toBe(true);
    expect(sequence).toEqual(before);
    const enabled = enableSlideshow(sequence, assets);
    expect(enabled.clips).toEqual(sequence.clips);
    expect(enabled.tracks).toEqual(sequence.tracks);
    expect(sequence.slideshow).toBeUndefined();
  });

  it('reads an existing secondary ranking template without changing repeat pagination', () => {
    const project = createProject();
    const table = {
      headers: ['排名'],
      rows: Array.from({ length: 9 }, (_, i) => ({ 排名: String(i + 1) })),
    };
    const source = createGraphicSource(createDocument(), table, '副榜', { repeats: 3 });
    project.graphics.push(source);
    project.assets.push(audio, ...createGraphicAssets(source));
    const template = createDefaultTemplate();
    template.sections = template.sections.filter((section) => section.kind === 'secondary');
    template.sections[0].transition = 0.5;
    const generated = applyRankingTemplate(project, template, {
      sources: { secondary: source.id },
      main: [],
      bgmAssetId: audio.id,
      bgmLoop: true,
    });
    const sequence = generated.sequences.at(-1)!;
    const view = inspectSlideshow(sequence, generated.assets);
    expect(view.editable).toBe(true);
    expect(view.pages).toHaveLength(3);
    expect(
      view.pages.map(
        (clip) =>
          generated.assets.find((asset) => asset.id === clip.assetId)!.graphic!.rowIds.length,
      ),
    ).toEqual([4, 4, 1]);
    expect(view.settings.transitionDuration).toBe(30);
    expect(sequenceDuration(sequence)).toBe(840);
    const updated = setSlideDuration(sequence, generated.assets, [view.pages[0].id], 360);
    expect(sequenceDuration(updated)).toBe(900);
    expect(updated.tracks).toEqual(sequence.tracks);
  });

  it.each([
    [
      '视频',
      (sequence: VideoSequence) => {
        sequence.clips[0].assetId = video.id;
        sequence.clips[0].duration = 180;
        sequence.clips[1].start = 180;
        sequence.clips[2].start = 480;
      },
    ],
    [
      '多条画面轨',
      (sequence: VideoSequence) => {
        const track = createTrack('video');
        sequence.tracks.push(track);
        sequence.clips.push(createClip(image, track.id, 0, 300, sequence));
      },
    ],
    [
      '空白间隙',
      (sequence: VideoSequence) => {
        sequence.clips[1].start += 30;
        sequence.clips[2].start += 30;
      },
    ],
    [
      '锁定',
      (sequence: VideoSequence) => {
        sequence.tracks[0].locked = true;
      },
    ],
    [
      '隐藏',
      (sequence: VideoSequence) => {
        sequence.tracks[0].hidden = true;
      },
    ],
    [
      '编组',
      (sequence: VideoSequence) => {
        sequence.clips[0].groupId = sequence.clips[1].groupId = 'shared';
      },
    ],
    [
      '多个声音片段',
      (sequence: VideoSequence) => {
        sequence.clips.push(
          createClip(audio, sequence.tracks[1].id, 0, 120, sequence),
          createClip(audio, sequence.tracks[1].id, 120, 120, sequence),
        );
      },
    ],
    [
      '背景音乐须从起点',
      (sequence: VideoSequence) => {
        sequence.clips.push(createClip(audio, sequence.tracks[1].id, 120, 120, sequence));
      },
    ],
  ])('protects %s timelines without mutating them', (reason, mutate) => {
    const sequence = fixture();
    mutate(sequence);
    const before = structuredClone(sequence);
    expect(inspectSlideshow(sequence, assets)).toMatchObject({
      editable: false,
      reason: expect.stringContaining(reason),
    });
    expect(() => insertSlides(sequence, assets, [image.id])).toThrow();
    expect(sequence).toEqual(before);
  });

  it('protects individually edited transition lengths instead of flattening them', () => {
    const sequence = fixture();
    sequence.clips[1].start -= 30;
    sequence.clips[2].start -= 30;
    sequence.transitions.push({
      id: 'crossfade',
      fromClipId: sequence.clips[0].id,
      toClipId: sequence.clips[1].id,
      duration: 30,
    });
    expect(validateSequence(sequence, assets)).toBeTruthy();
    expect(inspectSlideshow(sequence, assets)).toMatchObject({
      editable: false,
      reason: expect.stringContaining('不同长度'),
    });
    expect(() => setSlideshowSettings(sequence, assets, { transitionDuration: 0 })).toThrow(
      '不同长度',
    );
  });

  it('uses actual timeline changes over stale PPT metadata', () => {
    let sequence = setSlideshowSettings(fixture(2), assets, {
      transitionDuration: 30,
      bgmAssetId: audio.id,
    });
    sequence.clips = sequence.clips.filter(
      (clip) => clip.trackId === sequence.slideshow!.pageTrackId,
    );
    sequence.transitions = [];
    sequence.clips[1].start = 300;
    const view = inspectSlideshow(sequence, assets);
    expect(view.settings.transitionDuration).toBe(0);
    expect(view.settings.bgmAssetId).toBeUndefined();
    sequence = insertSlides(sequence, assets, [image.id]);
    expect(sequence.clips).toHaveLength(3);
    expect(sequenceDuration(sequence)).toBe(900);
  });
});

describe('PPT frame-rate conversion', () => {
  it('resets contiguous boundaries after rounding odd page lengths and preserves source data', () => {
    const sequence = insertSlides(
      createSlideshowSequence(),
      assets,
      [image.id, image.id, color.id],
      0,
      301,
    );
    sequence.clips[1].transform.x = 32;
    sequence.clips[1].transform.crop.top = 0.2;
    const before = structuredClone(sequence);
    const converted = rescaleSlideshow(sequence, assets, 30);
    expect(pages(converted).map((page) => [page.start, page.duration])).toEqual([
      [0, 151],
      [151, 151],
      [302, 151],
    ]);
    expect(sequenceDuration(converted)).toBe(453);
    expect(pages(converted).map((page) => page.id)).toEqual(pages(sequence).map((page) => page.id));
    expect(pages(converted)[1].transform).toEqual(sequence.clips[1].transform);
    expect(converted.slideshow!.defaultDuration).toBe(150);
    expect(inspectSlideshow(converted, assets).editable).toBe(true);
    expect(sequence).toEqual(before);
  });

  it('turns a sub-frame dissolve into a hard cut and clamps dissolves for tiny pages', () => {
    let sequence = setSlideshowSettings(fixture(), assets, { transitionDuration: 1 });
    const cut = rescaleSlideshow(sequence, assets, 24);
    expect(cut.transitions).toEqual([]);
    expect(cut.slideshow!.transitionDuration).toBe(0);
    expect(pages(cut).map((page) => page.start)).toEqual([0, 120, 240]);
    sequence = insertSlides(
      createSlideshowSequence(),
      assets,
      [image.id, image.id, image.id],
      0,
      2,
    );
    sequence = setSlideshowSettings(sequence, assets, { transitionDuration: 1 });
    const tiny = rescaleSlideshow(sequence, assets, 30);
    expect(pages(tiny).map((page) => [page.start, page.duration])).toEqual([
      [0, 1],
      [1, 1],
      [2, 1],
    ]);
    expect(tiny.transitions).toEqual([]);
  });

  it('preserves transition IDs and clamps rounded page fades without overlap', () => {
    let sequence = insertSlides(
      createSlideshowSequence(),
      assets,
      [image.id, image.id, image.id],
      0,
      301,
    );
    sequence = setSlideshowSettings(sequence, assets, { transitionDuration: 30 });
    const ids = sequence.transitions.map((edge) => edge.id);
    sequence.clips[1].fadeIn = 151;
    sequence.clips[1].fadeOut = 150;
    const converted = rescaleSlideshow(sequence, assets, 30);
    expect(converted.transitions.map((edge) => edge.id)).toEqual(ids);
    expect(converted.transitions.map((edge) => edge.duration)).toEqual([15, 15]);
    expect(pages(converted).map((page) => page.start)).toEqual([0, 136, 272]);
    const middle = pages(converted)[1];
    expect(middle.fadeIn + middle.fadeOut).toBeLessThanOrEqual(middle.duration);
    expect(sequenceDuration(converted)).toBe(423);
  });

  it('fills the new page duration with full-length BGM but retains a manually shortened out-point', () => {
    let sequence = insertSlides(
      createSlideshowSequence(),
      assets,
      [image.id, image.id, image.id],
      0,
      301,
    );
    sequence = setSlideshowSettings(sequence, assets, {
      bgmAssetId: audio.id,
      bgmFadeIn: 20,
      bgmFadeOut: 40,
    });
    inspectSlideshow(sequence, assets).bgm!.sourceIn = 1;
    const full = rescaleSlideshow(sequence, assets, 30);
    expect(inspectSlideshow(full, assets).bgm).toMatchObject({
      id: inspectSlideshow(sequence, assets).bgm!.id,
      sourceIn: 1,
      duration: 453,
      fadeIn: 10,
      fadeOut: 20,
    });
    inspectSlideshow(sequence, assets).bgm!.duration = 181;
    const short = rescaleSlideshow(sequence, assets, 30);
    expect(inspectSlideshow(short, assets).bgm).toMatchObject({
      sourceIn: 1,
      duration: 91,
      fadeIn: 10,
      fadeOut: 20,
    });
    expect(sequenceDuration(short)).toBe(453);
  });

  it('keeps non-looping BGM within the actual source range after rounding', () => {
    const shortAudio: MediaAsset = { ...audio, id: 'short-audio', duration: 2.511 };
    const all = [...assets, shortAudio];
    const sequence = setSlideshowSettings(fixture(), all, {
      bgmAssetId: shortAudio.id,
      bgmLoop: false,
    });
    expect(inspectSlideshow(sequence, all).bgm!.duration).toBe(150);
    const converted = rescaleSlideshow(sequence, all, 29.97);
    const music = inspectSlideshow(converted, all).bgm!;
    expect(music.duration).toBeLessThanOrEqual(Math.floor(shortAudio.duration * 29.97));
    expect(validateSequence(converted, all)).toBeTruthy();
  });

  it('rescales markers and explicit export ranges, with full-length export ending on the rebuilt last frame', () => {
    const sequence = insertSlides(
      createSlideshowSequence(),
      assets,
      [image.id, image.id, image.id],
      0,
      301,
    );
    sequence.markers = [{ id: 'marker', label: '章节', frame: 301 }];
    sequence.exportSettings = { startFrame: 301, endFrame: 903, videoBitrate: 8_000_000 };
    const full = rescaleSlideshow(sequence, assets, 30);
    expect(full.markers).toEqual([{ id: 'marker', label: '章节', frame: 151 }]);
    expect(full.exportSettings).toEqual({
      startFrame: 151,
      endFrame: 453,
      videoBitrate: 8_000_000,
    });
    sequence.exportSettings.endFrame = 601;
    const range = rescaleSlideshow(sequence, assets, 30);
    expect(range.exportSettings).toEqual({
      startFrame: 151,
      endFrame: 301,
      videoBitrate: 8_000_000,
    });
  });

  it('rejects invalid rates and complex/locked timelines atomically while accepting empty PPTs', () => {
    const sequence = fixture(),
      before = structuredClone(sequence);
    for (const fps of [0, -1, NaN, Infinity, 241])
      expect(() => rescaleSlideshow(sequence, assets, fps)).toThrow('帧率');
    expect(sequence).toEqual(before);
    sequence.tracks[0].locked = true;
    expect(() => rescaleSlideshow(sequence, assets, 30)).toThrow('锁定');
    sequence.tracks[0].locked = false;
    const extra = createTrack('video');
    sequence.tracks.push(extra);
    sequence.clips.push(createClip(image, extra.id, 0, 300, sequence));
    expect(() => rescaleSlideshow(sequence, assets, 30)).toThrow('多条画面轨');
    const empty = rescaleSlideshow(createSlideshowSequence(), assets, 30);
    expect(empty.clips).toEqual([]);
    expect(empty.slideshow!.defaultDuration).toBe(150);
  });
});

describe('PPT page edits', () => {
  it('inserts, duplicates, reorders and removes pages while retaining image transforms', () => {
    let sequence = fixture(2);
    const original = pages(sequence)[0];
    original.transform = {
      ...original.transform,
      x: 100,
      rotation: -15,
      crop: { left: 0.2, right: 0, top: 0.1, bottom: 0 },
    };
    original.groupId = 'one-page';
    sequence = insertSlides(sequence, assets, [color.id], 1, 180);
    expect(pages(sequence).map((page) => [page.assetId, page.start, page.duration])).toEqual([
      ['image', 0, 300],
      ['color', 300, 180],
      ['image', 480, 300],
    ]);
    sequence = duplicateSlides(sequence, assets, [original.id]);
    const copy = pages(sequence)[1];
    expect(copy.id).not.toBe(original.id);
    expect(copy.groupId).not.toBe(original.groupId);
    expect(copy.transform).toEqual(original.transform);
    sequence = reorderSlides(
      sequence,
      assets,
      pages(sequence)
        .map((page) => page.id)
        .reverse(),
    );
    expect(pages(sequence).at(-1)!.id).toBe(original.id);
    sequence = removeSlides(sequence, assets, [copy.id]);
    expect(sequenceDuration(sequence)).toBe(780);
    expect(pages(sequence).at(-1)!.transform).toEqual(original.transform);
  });

  it('applies exact frame lengths and crossfade overlap with stable surviving edge IDs', () => {
    let sequence = setSlideshowSettings(fixture(), assets, { transitionDuration: 30 });
    expect(pages(sequence).map((page) => page.start)).toEqual([0, 270, 540]);
    expect(sequenceDuration(sequence)).toBe(840);
    const edgeIds = sequence.transitions.map((edge) => edge.id);
    sequence = setSlideDuration(sequence, assets, [pages(sequence)[1].id], 181);
    expect(pages(sequence).map((page) => page.start)).toEqual([0, 270, 421]);
    expect(sequenceDuration(sequence)).toBe(721);
    expect(sequence.transitions.map((edge) => edge.id)).toEqual(edgeIds);
    sequence = setSlideshowSettings(sequence, assets, { transitionDuration: 0 });
    expect(sequence.transitions).toEqual([]);
    expect(sequenceDuration(sequence)).toBe(781);
  });

  it('updates the insertion default without changing existing page lengths', () => {
    const sequence = setSlideshowSettings(fixture(2), assets, { defaultDuration: 120 });
    expect(pages(sequence).map((page) => page.duration)).toEqual([300, 300]);
    expect(pages(insertSlides(sequence, assets, [image.id])).map((page) => page.duration)).toEqual([
      300, 300, 120,
    ]);
  });

  it('rejects invalid order, selection, duration and too-long transitions atomically', () => {
    const sequence = fixture(),
      before = structuredClone(sequence),
      ids = pages(sequence).map((page) => page.id);
    const attempts = [
      () => reorderSlides(sequence, assets, [ids[0], ids[0], ids[2]]),
      () => reorderSlides(sequence, assets, [ids[0], ids[1], 'missing']),
      () => removeSlides(sequence, assets, ['missing']),
      () => duplicateSlides(sequence, assets, []),
      () => setSlideDuration(sequence, assets, [ids[0]], 1.5),
      () => setSlideshowSettings(sequence, assets, { transitionDuration: 151 }),
      () => setSlideshowSettings(sequence, assets, { bgmVolume: NaN }),
      () => setSlideshowSettings(sequence, assets, { pageTrackId: 'new-track' }),
      () => insertSlides(sequence, assets, [video.id]),
      () => insertSlides(sequence, assets, [image.id], -1),
    ];
    for (const attempt of attempts) {
      expect(attempt).toThrow();
      expect(sequence).toEqual(before);
    }
  });
});

describe('PPT continuous background music and persistence', () => {
  it('keeps one continuous looping music clip while adding, moving and shortening pages', () => {
    let sequence = setSlideshowSettings(fixture(2), assets, {
      bgmAssetId: audio.id,
      bgmVolume: 0.4,
    });
    const bgmId = inspectSlideshow(sequence, assets).bgm!.id;
    expect(inspectSlideshow(sequence, assets).bgm).toMatchObject({
      start: 0,
      duration: 600,
      volume: 0.4,
      loop: true,
      fadeIn: 18,
      fadeOut: 18,
    });
    sequence = insertSlides(sequence, assets, [color.id]);
    sequence = reorderSlides(
      sequence,
      assets,
      pages(sequence)
        .map((page) => page.id)
        .reverse(),
    );
    sequence = setSlideDuration(
      sequence,
      assets,
      pages(sequence).map((page) => page.id),
      60,
    );
    expect(
      sequence.clips.filter((clip) => clip.trackId === sequence.slideshow!.bgmTrackId),
    ).toHaveLength(1);
    expect(inspectSlideshow(sequence, assets).bgm).toMatchObject({
      id: bgmId,
      start: 0,
      duration: 180,
    });
  });

  it('does not exceed a short non-looping source and preserves a manually set source in', () => {
    let sequence = setSlideshowSettings(fixture(), assets, {
      bgmAssetId: audio.id,
      bgmLoop: false,
    });
    const bgm = inspectSlideshow(sequence, assets).bgm!;
    expect(bgm.duration).toBe(240);
    bgm.sourceIn = 1;
    bgm.duration = 180;
    sequence = insertSlides(sequence, assets, [image.id]);
    expect(inspectSlideshow(sequence, assets).bgm).toMatchObject({
      sourceIn: 1,
      duration: 180,
      loop: false,
    });
    sequence = setSlideshowSettings(sequence, assets, { bgmLoop: true });
    expect(inspectSlideshow(sequence, assets).bgm).toMatchObject({
      sourceIn: 1,
      duration: 1200,
      loop: true,
    });
  });

  it('retains manual music out-point when changing volume or page order without changing overall duration', () => {
    let sequence = setSlideshowSettings(fixture(), assets, {
      bgmAssetId: audio.id,
      bgmLoop: false,
    });
    inspectSlideshow(sequence, assets).bgm!.duration = 120;
    sequence = setSlideshowSettings(sequence, assets, { bgmVolume: 0.7 });
    sequence = reorderSlides(
      sequence,
      assets,
      pages(sequence)
        .map((page) => page.id)
        .reverse(),
    );
    expect(inspectSlideshow(sequence, assets).bgm).toMatchObject({ duration: 120, volume: 0.7 });
  });

  it('retains music preferences for an empty slideshow without creating invalid zero-frame clips', () => {
    let sequence = setSlideshowSettings(createSlideshowSequence(), assets, {
      bgmAssetId: audio.id,
      bgmFadeIn: 60,
      bgmFadeOut: 60,
    });
    expect(sequence.clips).toEqual([]);
    sequence = insertSlides(sequence, assets, [image.id], 0, 1);
    expect(inspectSlideshow(sequence, assets).bgm).toMatchObject({
      duration: 1,
      fadeIn: 0,
      fadeOut: 1,
    });
    sequence = removeSlides(
      sequence,
      assets,
      pages(sequence).map((page) => page.id),
    );
    expect(sequence.clips).toEqual([]);
    expect(sequence.slideshow!.bgmAssetId).toBe(audio.id);
    sequence = insertSlides(sequence, assets, [image.id]);
    expect(inspectSlideshow(sequence, assets).bgm).toBeDefined();
    expect(inspectSlideshow(sequence, assets).bgm).toMatchObject({ fadeIn: 60, fadeOut: 60 });
    sequence = setSlideshowSettings(sequence, assets, { bgmAssetId: undefined });
    expect(inspectSlideshow(sequence, assets).bgm).toBeUndefined();
  });

  it('round-trips PPT preferences and validates malformed persisted values', () => {
    const project = createProject();
    project.assets = assets;
    const sequence = setSlideshowSettings(fixture(2), assets, {
      bgmAssetId: video.id,
      transitionDuration: 20,
      defaultDuration: 241,
    });
    project.sequences = [sequence];
    project.activeSequenceId = sequence.id;
    const restored = parseProject(serializeProject(project));
    expect(restored.sequences[0]).toEqual(sequence);
    expect(inspectSlideshow(restored.sequences[0], restored.assets).editable).toBe(true);
    sequence.slideshow!.transitionDuration = 1.5;
    expect(() => serializeProject(project)).toThrow('整数');
  });

  it('preserves explicit export ranges and sequence markers for the existing export workflow', () => {
    const sequence = fixture();
    sequence.exportSettings = { startFrame: 60, endFrame: 180, videoBitrate: 10_000_000 };
    sequence.markers = [{ id: 'marker', frame: 200, label: '标记' }];
    const changed = insertSlides(sequence, assets, [image.id]);
    expect(changed.exportSettings).toEqual(sequence.exportSettings);
    expect(changed.markers).toEqual(sequence.markers);
  });

  it('extends full-length exports with new pages, clamps their start after shortening, and clears empty exports', () => {
    let sequence = fixture(2);
    sequence.exportSettings = { startFrame: 550, endFrame: 600, videoBitrate: 10_000_000 };
    sequence = insertSlides(sequence, assets, [image.id]);
    expect(sequence.exportSettings).toEqual({
      startFrame: 550,
      endFrame: 900,
      videoBitrate: 10_000_000,
    });
    sequence = setSlideDuration(
      sequence,
      assets,
      pages(sequence).map((page) => page.id),
      60,
    );
    expect(sequence.exportSettings).toEqual({
      startFrame: 179,
      endFrame: 180,
      videoBitrate: 10_000_000,
    });
    sequence = removeSlides(
      sequence,
      assets,
      pages(sequence).map((page) => page.id),
    );
    expect(sequence.exportSettings).toBeUndefined();
  });

  it('protects locked music tracks and page links even when metadata is already present', () => {
    const sequence = fixture();
    sequence.tracks[1].locked = true;
    expect(() => setSlideshowSettings(sequence, assets, { bgmAssetId: audio.id })).toThrow('锁定');
    sequence.tracks[1].locked = false;
    sequence.clips[0].linkId = 'lone-link';
    expect(() => removeSlides(sequence, assets, [sequence.clips[0].id])).toThrow('关联');
  });
});
