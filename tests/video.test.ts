import { describe, expect, it, vi } from 'vitest';
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
  validateProject,
  validateSequence,
} from '../src/video/model';
import {
  deleteClips,
  duplicateClips,
  insertClips,
  moveClips,
  overwriteClips,
  removeTransition,
  replaceClipAsset,
  setTransition,
  splitClips,
  trimClip,
  unlinkClips,
} from '../src/video/edit';
import {
  applyRankingTemplate,
  createDefaultTemplate,
  parseTemplate,
  serializeTemplate,
} from '../src/video/templates';
import type { MediaAsset, TemplateBindings, VideoClip, VideoProject } from '../src/video/types';
import {
  captureGraphicResources,
  graphicFiles,
  restoreGraphicResources,
} from '../src/video/graphics';
import { getMediaFile, putMediaFile } from '../src/video/storage';

vi.mock('../src/video/storage', () => ({
  getMediaFile: vi.fn(),
  putMediaFile: vi.fn(),
}));

function graphicStorage() {
  const files = new Map<string, File>();
  vi.mocked(putMediaFile)
    .mockReset()
    .mockImplementation(async (id, file) => {
      files.set(id, file);
    });
  vi.mocked(getMediaFile)
    .mockReset()
    .mockImplementation(async (id) => files.get(id));
  return files;
}

function asset(kind: MediaAsset['kind'] = 'video', id = 'media'): MediaAsset {
  return {
    id,
    name: id,
    kind,
    duration: 60,
    width: 1920,
    height: 1080,
    hasAudio: kind === 'video' || kind === 'audio',
  };
}
function fixture() {
  const project = createProject('测试工程'),
    sequence = project.sequences[0],
    media = asset();
  project.assets.push(media);
  const video = createClip(media, sequence.tracks[0].id, 0, 300, sequence);
  const audio = createClip(media, sequence.tracks[1].id, 0, 300, sequence);
  video.linkId = audio.linkId = 'av-1';
  sequence.clips.push(video, audio);
  return { project, sequence, media, video, audio };
}
function stills() {
  const sequence = createSequence(),
    image = asset('image');
  const first = createClip(image, sequence.tracks[0].id, 0, 300, sequence);
  const second = createClip(image, sequence.tracks[0].id, 300, 300, sequence);
  sequence.clips.push(first, second);
  return { sequence, first, second, image };
}

describe('video project persistence and stable references', () => {
  it('persists independent sequence export settings, allowing stale ranges until export UI clamps', () => {
    const { project, sequence } = fixture();
    sequence.exportSettings = { startFrame: 60, endFrame: 300, videoBitrate: 16_000_000 };
    const empty = createSequence('未设置导出的空序列');
    const another = createSequence('另一序列');
    another.exportSettings = { startFrame: 0, endFrame: 600, videoBitrate: 8_000_000 };
    project.sequences.push(empty, another);
    const restored = parseProject(serializeProject(project));
    expect(restored.sequences[0].exportSettings).toEqual(sequence.exportSettings);
    expect(restored.sequences[1].exportSettings).toBeUndefined();
    expect(restored.sequences[2].exportSettings).toEqual(another.exportSettings);
    restored.sequences[0].clips.forEach((c) => (c.duration = 30));
    expect(validateProject(restored).sequences[0].exportSettings?.endFrame).toBe(300);
    const invalid = [
      { startFrame: -1 },
      { startFrame: 0.5 },
      { endFrame: 2.5 },
      { endFrame: 60 },
      { endFrame: 0 },
      { videoBitrate: 0 },
      { videoBitrate: Infinity },
    ];
    for (const patch of invalid)
      expect(() =>
        validateSequence({ ...sequence, exportSettings: { ...sequence.exportSettings, ...patch } }),
      ).toThrow('导出');
  });
  it('roundtrips separate sequence settings, stable graphic rows, saved bindings and templates', () => {
    const { project, media } = fixture();
    const source = createGraphicSource(
      createDocument(),
      { headers: ['名次'], rows: [{ 名次: '1' }, { 名次: '2' }], rowIds: ['row-a', 'row-b'] },
      '主榜',
    );
    project.graphics.push(source);
    project.assets.push(...createGraphicAssets(source));
    project.sequences.push(createSequence('竖屏', 1080, 1920, 30));
    project.templates = [createDefaultTemplate()];
    project.rankingBindings = {
      [source.id]: [{ rowId: 'row-a', assetId: media.id, sourceIn: 2, sourceOut: 7 }],
    };
    const restored = parseProject(serializeProject(project));
    expect(restored).toEqual(project);
    expect(restored.graphics[0].rowIds).toEqual(['row-a', 'row-b']);
    restored.sequences[1].name = '隔离副本';
    expect(project.sequences[1].name).toBe('竖屏');
  });
  it('rejects unsupported versions, duplicate identities, missing media and nonfinite timing', () => {
    const { project } = fixture();
    expect(() => validateProject({ ...project, version: 2 })).toThrow('版本');
    expect(() =>
      validateProject({ ...project, assets: [...project.assets, project.assets[0]] }),
    ).toThrow('重复');
    expect(() => validateProject({ ...project, assets: [] })).toThrow('素材不存在');
    const broken = structuredClone(project);
    broken.sequences[0].clips[0].start = NaN;
    expect(() => validateProject(broken)).toThrow('开始帧');
  });
  it('rejects mismatched row metadata and invalid source duration before save', () => {
    expect(() =>
      createGraphicSource(
        createDocument(),
        { headers: [], rows: [{}, {}], rowIds: ['same', 'same'] },
        '错误',
      ),
    ).toThrow('唯一');
    const { project } = fixture();
    project.sequences[0].clips.forEach((c) => {
      c.sourceIn = 59;
    });
    expect(() => serializeProject(project)).toThrow('超出源素材');
  });
  it('retains deleted-row references as unresolved identities without rebinding existing edits', () => {
    const { project, media } = fixture();
    const source = createGraphicSource(
      createDocument(),
      {
        headers: ['名称'],
        rows: [{ 名称: '原条目' }, { 名称: '下一条' }],
        rowIds: ['old', 'next'],
      },
      '图文',
    );
    project.graphics.push(source);
    const pages = createGraphicAssets(source);
    project.assets.push(...pages);
    project.rankingBindings = {
      [source.id]: [{ rowId: 'old', assetId: media.id, sourceIn: 2, sourceOut: 7 }],
    };
    source.table.rows.shift();
    source.table.rowIds = ['next'];
    source.rowIds = ['next'];
    source.layout.end = 1;
    const reopened = parseProject(serializeProject(project));
    expect(reopened.assets.find((a) => a.id === pages[0].id)!.graphic!.rowIds).toEqual(['old']);
    expect(reopened.rankingBindings![source.id][0].rowId).toBe('old');
    expect(reopened.graphics[0].table.rows[0].名称).toBe('下一条');
  });
});

describe('transactional timeline commands', () => {
  it('moves linked and grouped clips together and rejects a locked linked track atomically', () => {
    const { sequence, video, audio } = fixture();
    const moved = moveClips(sequence, [video.id], 30);
    expect(moved.clips.map((c) => c.start)).toEqual([30, 30]);
    sequence.tracks[1].locked = true;
    expect(() => moveClips(sequence, [video.id], 30)).toThrow('锁定');
    expect([video.start, audio.start]).toEqual([0, 0]);
  });
  it('trims linked A/V with matching source offsets and refuses extending beyond media', () => {
    const { sequence, media, video } = fixture();
    const trimmed = trimClip(sequence, video.id, 'start', 60, [media]);
    expect(trimmed.clips.map((c) => [c.start, c.duration, c.sourceIn])).toEqual([
      [60, 240, 1],
      [60, 240, 1],
    ]);
    expect(() => trimClip(sequence, video.id, 'end', 4000, [media])).toThrow('源素材');
    expect(sequence.clips[0].duration).toBe(300);
  });
  it('can extend a still backwards without creating a negative source timestamp', () => {
    const { sequence, image, first } = stills();
    sequence.clips = [first];
    first.start = 60;
    expect(trimClip(sequence, first.id, 'start', 0, [image]).clips[0]).toMatchObject({
      start: 0,
      duration: 360,
      sourceIn: 0,
    });
  });
  it('splits both linked streams with independent new link identities', () => {
    const { sequence, video } = fixture();
    const split = splitClips(sequence, [video.id], 120);
    expect(split.clips).toHaveLength(4);
    const right = split.clips.filter((c) => c.start === 120);
    expect(right.map((c) => [c.duration, c.sourceIn])).toEqual([
      [180, 2],
      [180, 2],
    ]);
    expect(right[0].linkId).toBe(right[1].linkId);
    expect(right[0].linkId).not.toBe('av-1');
    expect(sequence.clips).toHaveLength(2);
  });
  it('inserts into a linked clip without discarding either retained side', () => {
    const { sequence, video, audio, media } = fixture();
    const inserted = [
      createClip(media, video.trackId, 0, 60, sequence),
      createClip(media, audio.trackId, 0, 60, sequence),
    ];
    inserted.forEach((c) => {
      c.linkId = 'insert';
    });
    const result = insertClips(sequence, inserted, 120);
    expect(sequenceDuration(result)).toBe(360);
    expect(
      result.clips
        .filter((c) => c.trackId === video.trackId)
        .map((c) => [c.start, c.duration, c.sourceIn])
        .sort((a, b) => a[0] - b[0]),
    ).toEqual([
      [0, 120, 0],
      [120, 60, 0],
      [180, 180, 2],
    ]);
    expect(() => insertClips(sequence, [inserted[0]], 120, [video.trackId])).toThrow('关联');
  });
  it('overwrites both streams, preserving material before and after the replacement', () => {
    const { sequence, video, audio, media } = fixture();
    const incoming = [
      createClip(media, video.trackId, 60, 60, sequence),
      createClip(media, audio.trackId, 60, 60, sequence),
    ];
    incoming.forEach((c) => {
      c.linkId = 'replacement';
    });
    const result = overwriteClips(sequence, incoming);
    expect(
      result.clips
        .filter((c) => c.trackId === video.trackId)
        .map((c) => [c.start, c.duration, c.sourceIn])
        .sort((a, b) => a[0] - b[0]),
    ).toEqual([
      [0, 60, 0],
      [60, 60, 0],
      [120, 180, 2],
    ]);
    expect(sequenceDuration(result)).toBe(300);
    expect(() => overwriteClips(sequence, [incoming[0]])).toThrow('关联');
  });
  it('clears the old linked soundtrack when overwriting with a silent image', () => {
    const { sequence, video, audio } = fixture();
    const image = asset('image', 'replacement-image');
    const incoming = createClip(image, video.trackId, 60, 60, sequence);
    const before = structuredClone(sequence);
    const result = overwriteClips(sequence, [incoming], [audio.trackId]);
    expect(
      result.clips
        .filter((c) => c.trackId === audio.trackId)
        .map((c) => [c.start, c.duration, c.sourceIn]),
    ).toEqual([
      [0, 60, 0],
      [120, 180, 2],
    ]);
    expect(sequenceDuration(result)).toBe(300);
    expect(result.clips).toHaveLength(5);
    expect(sequence).toEqual(before);
    sequence.tracks.find((t) => t.id === audio.trackId)!.locked = true;
    expect(() => overwriteClips(sequence, [incoming], [audio.trackId])).toThrow('锁定');
    expect(() => overwriteClips(sequence, [incoming], ['missing-track'])).toThrow('不存在');
  });
  it('overwrites onto a new audio track while clearing old audio, with linked scope enforced', () => {
    const { sequence, video, audio, media } = fixture();
    const destination = createTrack('audio');
    sequence.tracks.push(destination);
    const incoming = [
      createClip(media, video.trackId, 60, 60, sequence),
      createClip(media, destination.id, 60, 60, sequence),
    ];
    incoming.forEach((c) => (c.linkId = 'new-soundtrack'));
    expect(() => overwriteClips(sequence, incoming)).toThrow('关联');
    const result = overwriteClips(sequence, incoming, [audio.trackId]);
    expect(result.clips.filter((c) => c.start === 60)).toEqual(incoming);
    expect(result.clips.filter((c) => c.trackId === audio.trackId)).toHaveLength(2);
    const extraVideo = createTrack('video');
    const extraAudio = createTrack('audio');
    sequence.tracks.push(extraVideo, extraAudio);
    const unrelatedPair = [
      createClip(media, extraVideo.id, 0, 300, sequence),
      createClip(media, extraAudio.id, 0, 300, sequence),
    ];
    unrelatedPair.forEach((c) => (c.linkId = 'unrelated-av'));
    sequence.clips.push(...unrelatedPair);
    expect(() => overwriteClips(sequence, incoming, [audio.trackId, extraAudio.id])).toThrow(
      '关联',
    );
  });
  it('deletes linked content together, and ripple deletion closes only the selected intervals', () => {
    const { sequence, video, audio, media } = fixture();
    const later = [
      createClip(media, video.trackId, 300, 180, sequence),
      createClip(media, audio.trackId, 300, 180, sequence),
    ];
    later.forEach((c) => {
      c.linkId = 'later';
    });
    sequence.clips.push(...later);
    const normal = deleteClips(sequence, [video.id]);
    expect(normal.clips.map((c) => c.start)).toEqual([300, 300]);
    const ripple = deleteClips(sequence, [video.id], true);
    expect(ripple.clips.map((c) => c.start)).toEqual([0, 0]);
    expect(sequenceDuration(ripple)).toBe(180);
  });
  it('ripple cuts crossing audio accurately and refuses locked tracks', () => {
    const { sequence, first, second } = stills();
    const music = createClip(asset('audio', 'music'), sequence.tracks[1].id, 0, 600, sequence);
    sequence.clips.push(music);
    const result = deleteClips(sequence, [first.id], true);
    expect(result.clips.find((c) => c.assetId === 'music')).toMatchObject({
      start: 0,
      duration: 300,
      sourceIn: 5,
    });
    expect(result.clips.find((c) => c.id === second.id)?.start).toBe(0);
    sequence.tracks[1].locked = true;
    expect(() => deleteClips(sequence, [first.id], true)).toThrow('锁定');
  });
  it('duplicates without sharing link identities and validates replacement length', () => {
    const { sequence, video } = fixture();
    const duplicated = duplicateClips(sequence, [video.id]);
    const copies = duplicated.clips.filter((c) => c.start === 300);
    expect(copies).toHaveLength(2);
    expect(copies[0].linkId).toBe(copies[1].linkId);
    expect(copies[0].linkId).not.toBe(video.linkId);
    expect(() => replaceClipAsset(sequence, video.id, { ...asset(), duration: 2 })).toThrow('过短');
    const replaced = replaceClipAsset(sequence, video.id, asset('video', 'new'));
    expect(replaced.clips.every((c) => c.assetId === 'new')).toBe(true);
  });
  it('rejects implicit same-track overlap but allows intentional unlinking', () => {
    const { sequence, first } = stills();
    expect(() => moveClips(sequence, [first.id], 10)).toThrow('重叠');
    const linked = fixture();
    expect(unlinkClips(linked.sequence, [linked.video.id]).clips.every((c) => !c.linkId)).toBe(
      true,
    );
  });
});

describe('overlap transitions', () => {
  it('two 5-second pages with 30-frame dissolve produce exactly 570 frames and undo to 600', () => {
    const { sequence, first, second } = stills();
    const result = setTransition(sequence, first.id, second.id, 30);
    expect(result.clips[1].start).toBe(270);
    expect(sequenceDuration(result)).toBe(570);
    expect(result.clips.map((c) => c.sourceIn)).toEqual([0, 0]);
    const removed = removeTransition(result, result.transitions[0].id);
    expect(removed.clips).toEqual(sequence.clips);
    expect(sequenceDuration(removed)).toBe(600);
  });
  it('keeps a continuous BGM bounded to the shortened programme and restores it on removal', () => {
    const { sequence, first, second } = stills();
    sequence.clips.push(
      createClip(asset('audio', 'music'), sequence.tracks[1].id, 0, 600, sequence),
    );
    const result = setTransition(sequence, first.id, second.id, 30);
    expect(sequenceDuration(result)).toBe(570);
    expect(result.clips.find((c) => c.assetId === 'music')?.duration).toBe(570);
    expect(sequenceDuration(removeTransition(result, result.transitions[0].id))).toBe(600);
  });
  it('rejects contested transition handles and locked ripple effects', () => {
    const { sequence, first, second, image } = stills();
    const third = createClip(image, first.trackId, 600, 300, sequence);
    sequence.clips.push(third);
    const transitioned = setTransition(sequence, first.id, second.id, 180);
    expect(() => setTransition(transitioned, second.id, third.id, 180)).toThrow('争用');
    sequence.tracks[1].locked = true;
    sequence.clips.push(createClip(asset('audio'), sequence.tracks[1].id, 300, 300, sequence));
    expect(() => setTransition(sequence, first.id, second.id, 30)).toThrow('锁定');
  });
});

function rankingFixture() {
  const project = createProject();
  const source = createGraphicSource(
    createDocument(),
    {
      headers: ['名称'],
      rows: [{ 名称: '甲' }, { 名称: '乙' }, { 名称: '丙' }],
      rowIds: ['a', 'b', 'c'],
    },
    '榜单',
    { repeats: 1, deltaY: 200 },
  );
  const video = asset(),
    music = asset('audio', 'music');
  project.graphics.push(source);
  project.assets.push(video, music);
  const bindings: TemplateBindings = {
    sources: { main: source.id, secondary: source.id },
    main: source.rowIds.map((rowId, i) => ({
      rowId,
      assetId: video.id,
      sourceIn: i,
      sourceOut: i + 5,
    })),
    bgmAssetId: music.id,
    bgmLoop: false,
  };
  return { project, source, bindings };
}
describe('ranking templates remain editable ordinary sequences', () => {
  it('roundtrips templates, creates a fresh sequence and preserves the previous one on each application', () => {
    const { project, bindings } = rankingFixture(),
      template = createDefaultTemplate();
    expect(parseTemplate(serializeTemplate(template))).toEqual(template);
    const generated = applyRankingTemplate(project, template, bindings);
    expect(generated.sequences).toHaveLength(2);
    expect(generated.sequences[0]).toEqual(project.sequences[0]);
    const twice = applyRankingTemplate(generated, template, bindings);
    expect(twice.sequences).toHaveLength(3);
    expect(twice.sequences[1]).toEqual(generated.sequences[1]);
    expect(project.assets).toHaveLength(2);
  });
  it('generates window background + video + optional foreground and linked original audio', () => {
    const { project, source, bindings } = rankingFixture(),
      template = createDefaultTemplate();
    template.sections = template.sections.filter((s) => s.kind === 'main');
    bindings.sources['main:foreground'] = source.id;
    const result = applyRankingTemplate(project, template, bindings),
      sequence = result.sequences.at(-1)!;
    const item = sequence.clips.filter((c) => c.start === 0);
    expect(item).toHaveLength(4);
    expect(
      item.find((c) => sequence.tracks.find((t) => t.id === c.trackId)?.name === '作品视频 / 卡片')
        ?.transform.width,
    ).toBe(1600);
    expect(item.filter((c) => c.linkId)).toHaveLength(2);
    expect(new Set(item.map((c) => c.groupId)).size).toBe(1);
  });
  it('keeps reused row identities scoped to their graphic source and supports legacy bindings', () => {
    const { project, source, bindings } = rankingFixture();
    const other = { ...structuredClone(source), id: 'other-graphic', name: '另一个主榜' };
    project.graphics.push(other);
    const template = createDefaultTemplate();
    const section = template.sections.find((s) => s.kind === 'main')!;
    template.sections = [
      { ...section, rowStart: 1, rowEnd: 1 },
      { ...section, id: 'other-main', sourceSlot: 'other', rowStart: 1, rowEnd: 1 },
    ];
    const scoped = {
      ...bindings,
      main: [],
      sources: { ...bindings.sources, other: other.id },
      mainBySource: {
        [source.id]: [{ rowId: 'a', assetId: 'media', sourceIn: 2, sourceOut: 6 }],
        [other.id]: [{ rowId: 'a', assetId: 'media', sourceIn: 10, sourceOut: 16 }],
      },
    };
    const sequence = applyRankingTemplate(project, template, scoped).sequences.at(-1)!;
    expect(
      sequence.clips
        .filter((c) => sequence.tracks.find((t) => t.id === c.trackId)?.kind === 'audio')
        .map((c) => [c.start, c.duration, c.sourceIn]),
    ).toEqual([
      [0, 240, 2],
      [240, 360, 10],
    ]);
    const emptyScope = {
      ...scoped,
      main: bindings.main,
      mainBySource: { ...scoped.mainBySource, [source.id]: [] },
    };
    expect(() => applyRankingTemplate(project, template, emptyScope)).toThrow('尚未绑定');
    const duplicate = scoped.mainBySource[source.id][0];
    expect(() =>
      applyRankingTemplate(project, template, {
        ...scoped,
        mainBySource: { ...scoped.mainBySource, [source.id]: [duplicate, duplicate] },
      }),
    ).toThrow('重复绑定');
    const legacyFallback = { ...scoped, main: bindings.main, mainBySource: {} };
    expect(() => applyRankingTemplate(project, template, legacyFallback)).not.toThrow();
  });
  it('alternates silent cards and full-screen source video, respecting row ranges and order', () => {
    const { project, bindings } = rankingFixture(),
      template = createDefaultTemplate();
    template.sections = template.sections.filter((s) => s.kind === 'main');
    Object.assign(template.sections[0], {
      mainMode: 'alternating',
      cardDuration: 2,
      rowStart: 2,
      rowEnd: 3,
      order: 'reverse',
    });
    const result = applyRankingTemplate(project, template, bindings),
      sequence = result.sequences.at(-1)!;
    expect(sequenceDuration(sequence)).toBe(840);
    const sounds = sequence.clips.filter(
      (c) => sequence.tracks.find((t) => t.id === c.trackId)?.kind === 'audio',
    );
    expect(sounds.map((c) => [c.start, c.duration, c.sourceIn])).toEqual([
      [120, 300, 2],
      [540, 300, 1],
    ]);
    expect(
      sequence.clips
        .filter((c) => c.assetId === 'media' && !sounds.includes(c))
        .every((c) => c.transform.width === 1920),
    ).toBe(true);
  });
  it('uses existing repeat pagination and preserves tail page with continuous BGM across a dissolve', () => {
    const { project, bindings } = rankingFixture(),
      template = createDefaultTemplate();
    template.sections = template.sections.filter((s) => s.kind === 'secondary');
    template.sections[0].transition = 0.5;
    const result = applyRankingTemplate(project, template, bindings),
      sequence = result.sequences.at(-1)!;
    expect(sequenceDuration(sequence)).toBe(570);
    const graphicClips = sequence.clips.filter(
      (c) => result.assets.find((a) => a.id === c.assetId)?.kind === 'graphic',
    );
    expect(
      graphicClips.map((c) => result.assets.find((a) => a.id === c.assetId)!.graphic!.rowIds),
    ).toEqual([['a', 'b'], ['c']]);
    expect(sequence.clips.filter((c) => c.assetId === 'music')).toHaveLength(1);
    expect(sequence.clips.find((c) => c.assetId === 'music')?.duration).toBe(570);
  });
  it('refuses incomplete source binding atomically', () => {
    const { project, bindings } = rankingFixture(),
      template = createDefaultTemplate();
    expect(() => applyRankingTemplate(project, template, { ...bindings, main: [] })).toThrow(
      '尚未绑定',
    );
    expect(project.sequences).toHaveLength(1);
  });
  it('plays short nonlooping BGM once and leaves the remaining pages silent', () => {
    const { project, bindings } = rankingFixture();
    const template = createDefaultTemplate();
    template.sections = template.sections.filter((s) => s.kind === 'secondary');
    project.assets.find((a) => a.id === 'music')!.duration = 1.01;
    const once = applyRankingTemplate(project, template, {
      ...bindings,
      bgmLoop: false,
    }).sequences.at(-1)!;
    const sound = once.clips.find((c) => c.assetId === 'music')!;
    expect(sound.duration).toBe(60);
    expect(sound.loop).toBe(false);
    expect(sound.fadeIn + sound.fadeOut).toBeLessThanOrEqual(sound.duration);
    expect(sequenceDuration(once)).toBe(600);
    const loop = applyRankingTemplate(project, template, {
      ...bindings,
      bgmLoop: true,
    }).sequences.at(-1)!;
    expect(loop.clips.find((c) => c.assetId === 'music')?.duration).toBe(600);
    expect(loop.clips.find((c) => c.assetId === 'music')?.loop).toBe(true);
  });
});

describe('source-scoped graphic resources', () => {
  it('isolates same-name files even with identical metadata, while sharing the same File identity', async () => {
    const stored = graphicStorage();
    const options = { type: 'image/png', lastModified: 12345 };
    const firstFile = new File(['old'], 'cover.png', options);
    const first = await captureGraphicResources(new Map([['covers/cover.png', firstFile]]));
    const firstId = first.resources[0].id;
    const again = await captureGraphicResources(
      new Map([['covers/cover.png', firstFile]]),
      first.resources,
    );
    expect(again.resources[0].id).toBe(firstId);
    expect(putMediaFile).toHaveBeenCalledTimes(1);
    const replacement = new File(['new'], 'cover.png', options);
    const [second, shared] = await Promise.all([
      captureGraphicResources(new Map([['covers/cover.png', replacement]]), first.resources),
      captureGraphicResources(new Map([['other/cover.png', replacement]])),
    ]);
    expect(second.resources[0].id).not.toBe(firstId);
    expect(shared.resources[0].id).toBe(second.resources[0].id);
    expect(putMediaFile).toHaveBeenCalledTimes(2);
    expect(await stored.get(firstId)!.text()).toBe('old');
    expect(await stored.get(second.resources[0].id)!.text()).toBe('new');
    expect(first.resources[0].id).toBe(firstId);
  });

  it('restores available files and font metadata without losing missing resource references', async () => {
    const stored = graphicStorage();
    const image = new File(['image'], 'cover.png', { type: 'image/png', lastModified: 100 });
    const font = new File(['font'], '标题字体.woff2', { type: 'font/woff2', lastModified: 200 });
    const missing = new File(['missing'], 'missing.png', { type: 'image/png', lastModified: 300 });
    const changed = new File(['before'], 'changed.png', { type: 'image/png', lastModified: 400 });
    const captured = await captureGraphicResources(
      new Map([
        ['covers/cover.png', image],
        ['fonts/标题字体.woff2', font],
        ['covers/missing.png', missing],
        ['covers/changed.png', changed],
      ]),
    );
    const { project, source } = rankingFixture();
    source.resources = captured.resources;
    const reloaded = parseProject(serializeProject(project));
    const fontResource = captured.resources.find((r) => r.fileName === font.name)!;
    expect(fontResource.fontFamily).toBe('标题字体');
    const imageId = captured.resources.find((r) => r.fileName === image.name)!.id;
    const missingId = captured.resources.find((r) => r.fileName === missing.name)!.id;
    const changedId = captured.resources.find((r) => r.fileName === changed.name)!.id;
    const rehydratedImage = new File([image], image.name, {
      type: image.type,
      lastModified: image.lastModified,
    });
    stored.set(imageId, rehydratedImage);
    stored.delete(missingId);
    stored.set(changedId, new File(['different content'], changed.name, { lastModified: 400 }));
    const available = await restoreGraphicResources(reloaded);
    expect([...available.keys()]).toEqual([imageId, fontResource.id]);
    const editing = graphicFiles(reloaded.graphics[0], (id) => available.get(id));
    expect(editing.get('covers/cover.png')).toBe(rehydratedImage);
    expect(editing.has('covers/missing.png')).toBe(false);
    const recaptured = await captureGraphicResources(editing, reloaded.graphics[0].resources);
    expect(recaptured.resources).toEqual(captured.resources);
    expect(putMediaFile).toHaveBeenCalledTimes(4);
    expect(validateProject(reloaded).graphics[0].resources).toHaveLength(4);
  });

  it('keeps resource capture failures retryable without replacing previous stored files', async () => {
    const stored = graphicStorage();
    const original = new File(['original'], 'cover.png', { lastModified: 10 });
    const captured = await captureGraphicResources(new Map([['cover.png', original]]));
    const replacement = new File(['replacement'], 'cover.png', { lastModified: 20 });
    vi.mocked(putMediaFile).mockRejectedValueOnce(new Error('quota exceeded'));
    await expect(
      captureGraphicResources(new Map([['cover.png', replacement]]), captured.resources),
    ).rejects.toThrow('quota');
    expect(stored.get(captured.resources[0].id)).toBe(original);
    const retried = await captureGraphicResources(
      new Map([['cover.png', replacement]]),
      captured.resources,
    );
    expect(stored.get(retried.resources[0].id)).toBe(replacement);
    expect(retried.resources[0].id).not.toBe(captured.resources[0].id);
  });

  it('validates resource identities and paths while keeping legacy sources compatible', async () => {
    graphicStorage();
    const { project, source } = rankingFixture();
    expect(parseProject(serializeProject(project)).graphics[0].resources).toBeUndefined();
    const captured = await captureGraphicResources(
      new Map([['cover.png', new File(['x'], 'cover.png', { lastModified: 1 })]]),
    );
    source.resources = captured.resources;
    expect(() => validateProject(project)).not.toThrow();
    const duplicatePath = structuredClone(project);
    duplicatePath.graphics[0].resources!.push({ ...captured.resources[0], id: 'another-id' });
    expect(() => validateProject(duplicatePath)).toThrow('路径重复');
    const shared = structuredClone(project);
    shared.graphics.push({ ...structuredClone(source), id: 'shared-source' });
    expect(() => validateProject(shared)).not.toThrow();
    shared.graphics[1].resources![0].size++;
    expect(() => validateProject(shared)).toThrow('元数据不一致');
    const collision = structuredClone(project);
    collision.graphics[0].resources![0].id = collision.assets[0].id;
    expect(() => validateProject(collision)).toThrow('冲突');
    const invalid = structuredClone(project);
    invalid.graphics[0].resources![0].size = -1;
    expect(() => validateProject(invalid)).toThrow('图文资源大小');
    expect(graphicFiles({ ...source, resources: undefined }, () => undefined).size).toBe(0);
  });
});
