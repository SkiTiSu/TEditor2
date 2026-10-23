import {
  createClip,
  createSequence,
  createTrack,
  sequenceDuration,
  uid,
  validateProject,
  validateSequence,
} from './model';
import { planBatch } from '../core/data';
import type {
  GraphicSource,
  MediaAsset,
  TemplateBindings,
  TemplateSection,
  VideoProject,
  VideoSequence,
  VideoTemplate,
} from './types';

export function createDefaultTemplate(name = '排行榜节目'): VideoTemplate {
  const section = (
    kind: TemplateSection['kind'],
    label: string,
    slot?: string,
  ): TemplateSection => ({
    id: uid('section'),
    kind,
    name: label,
    sourceSlot: slot,
    duration: kind === 'main' ? 25 : 5,
    order: 'forward',
    mainMode: 'window',
    cardDuration: 3,
    window: { x: 160, y: 90, width: 1600, height: 900 },
    transition: 0,
  });
  return {
    format: 'teditor-video-template',
    version: 1,
    name,
    width: 1920,
    height: 1080,
    fps: 60,
    sections: [
      { ...section('title', '片头'), text: '排行榜', background: '#111827' },
      section('main', '主榜', 'main'),
      section('secondary', '副榜', 'secondary'),
      { ...section('title', '片尾'), text: '感谢观看', background: '#111827' },
    ],
  };
}

export function validateTemplate(input: unknown): VideoTemplate {
  if (!input || typeof input !== 'object') throw new Error('视频模板必须是对象');
  const t = input as VideoTemplate;
  if (t.format !== 'teditor-video-template' || t.version !== 1)
    throw new Error('不支持的视频模板格式或版本');
  if (typeof t.name !== 'string') throw new Error('模板名称无效');
  createSequence('校验', t.width, t.height, t.fps);
  if (!Array.isArray(t.sections)) throw new Error('模板章节必须是数组');
  const ids = new Set<string>();
  for (const s of t.sections) {
    if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !s.id || ids.has(s.id))
      throw new Error('模板章节 ID 缺失或重复');
    ids.add(s.id);
    if (typeof s.name !== 'string' || !['main', 'secondary', 'title'].includes(s.kind))
      throw new Error('模板章节类型或名称无效');
    if (
      !['forward', 'reverse'].includes(s.order) ||
      !['window', 'alternating'].includes(s.mainMode)
    )
      throw new Error('章节顺序或主榜模式无效');
    for (const [field, value] of Object.entries({
      duration: s.duration,
      cardDuration: s.cardDuration,
      transition: s.transition,
    }))
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        value < 0 ||
        (field === 'duration' && value === 0)
      )
        throw new Error('模板时长必须为有限非负秒数');
    if (s.sourceSlot !== undefined && (typeof s.sourceSlot !== 'string' || !s.sourceSlot))
      throw new Error('图片槽位名称无效');
    if (s.kind !== 'title' && !s.sourceSlot) throw new Error('榜单章节必须指定图片槽位');
    for (const field of ['rowStart', 'rowEnd'] as const)
      if (s[field] !== undefined && (!Number.isSafeInteger(s[field]) || s[field]! < 1))
        throw new Error('章节行范围必须是从 1 开始的整数');
    if (s.rowStart && s.rowEnd && s.rowEnd < s.rowStart) throw new Error('章节行范围无效');
    if (!s.window || typeof s.window !== 'object') throw new Error('视频窗口缺失');
    for (const [field, value] of Object.entries(s.window))
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        (['width', 'height'].includes(field) && value <= 0)
      )
        throw new Error('视频窗口尺寸或位置无效');
    if (
      !['x', 'y', 'width', 'height'].every(
        (key) => typeof s.window[key as keyof typeof s.window] === 'number',
      )
    )
      throw new Error('视频窗口不完整');
    for (const field of ['text', 'background'] as const)
      if (s[field] !== undefined && typeof s[field] !== 'string')
        throw new Error('章节文字/背景无效');
  }
  return structuredClone(t);
}
export const serializeTemplate = (template: VideoTemplate) =>
  JSON.stringify(validateTemplate(template), null, 2);
export function parseTemplate(json: string): VideoTemplate {
  let input: unknown;
  try {
    input = JSON.parse(json.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('视频模板必须是有效 JSON');
  }
  return validateTemplate(input);
}

/** Overlap full scene boundaries, adding explicit transitions to every intersecting track. */
function overlapBoundary(sequence: VideoSequence, boundary: number, duration: number) {
  if (!duration) return;
  const left = sequence.clips.filter((c) => c.start + c.duration === boundary);
  const right = sequence.clips.filter((c) => c.start === boundary);
  if (!left.length || !right.length || [...left, ...right].some((c) => c.duration <= duration))
    throw new Error('片段过短，无法应用章节转场');
  for (const clip of sequence.clips) if (clip.start >= boundary) clip.start -= duration;
  for (const clip of left) {
    const following = right.find((c) => c.trackId === clip.trackId);
    if (following)
      sequence.transitions.push({
        id: uid('transition'),
        fromClipId: clip.id,
        toClipId: following.id,
        duration,
      });
  }
  for (const marker of sequence.markers) if (marker.frame >= boundary) marker.frame -= duration;
  validateSequence(sequence);
}

/** Always append a new sequence; old edits and their source snapshots are never replaced. */
export function applyRankingTemplate(
  project: VideoProject,
  template: VideoTemplate,
  bindings: TemplateBindings,
): VideoProject {
  const next = validateProject(project),
    t = validateTemplate(template);
  const sequence = createSequence(t.name, t.width, t.height, t.fps);
  const foreground = createTrack('video', '前景 / 标题'),
    video = createTrack('video', '作品视频 / 卡片');
  const background = createTrack('video', '背景图文'),
    audio = createTrack('audio', '作品原声'),
    bgm = createTrack('audio', '背景音乐');
  sequence.tracks = [foreground, video, background, audio, bgm];
  const toFrames = (seconds: number) => Math.round(seconds * t.fps);
  const sourceFor = (slot: string, optional = false): GraphicSource | undefined => {
    const id = bindings.sources[slot];
    const source = next.graphics.find((g) => g.id === id);
    if (!source && (id || !optional)) throw new Error(`尚未绑定图片槽位或图片方案已丢失：${slot}`);
    return source;
  };
  const graphicAsset = (source: GraphicSource, rowIds: string[]): MediaAsset => {
    const existing = next.assets.find(
      (a) =>
        a.kind === 'graphic' &&
        a.graphic?.sourceId === source.id &&
        JSON.stringify(a.graphic.rowIds) === JSON.stringify(rowIds),
    );
    if (existing) return existing;
    const asset: MediaAsset = {
      id: uid('asset'),
      name: `${source.name} · ${rowIds.length > 1 ? `${rowIds.length} 条` : '单条'}`,
      kind: 'graphic',
      duration: 0,
      width: source.document.DocModel.Width,
      height: source.document.DocModel.Height,
      hasAudio: false,
      graphic: { sourceId: source.id, rowIds: [...rowIds] },
    };
    next.assets.push(asset);
    return asset;
  };
  const add = (
    asset: MediaAsset,
    trackId: string,
    start: number,
    length: number,
    groupId?: string,
  ) => {
    if (length < 1) throw new Error('片段长度不足一帧');
    const clip = createClip(asset, trackId, start, length, sequence);
    clip.groupId = groupId;
    sequence.clips.push(clip);
    return clip;
  };
  let cursor = 0;
  for (const section of t.sections) {
    const chapterStart = cursor;
    sequence.markers.push({ id: uid('marker'), label: section.name, frame: cursor });
    if (section.kind === 'title') {
      const text: MediaAsset = {
        id: uid('asset'),
        name: section.name,
        kind: 'text',
        text: section.text ?? section.name,
        color: '#ffffff',
        fontSize: 72,
        fontFamily: 'sans-serif',
        duration: 0,
        width: t.width,
        height: t.height,
        hasAudio: false,
      };
      const color: MediaAsset = {
        id: uid('asset'),
        name: `${section.name}背景`,
        kind: 'color',
        color: section.background ?? '#111827',
        duration: 0,
        width: t.width,
        height: t.height,
        hasAudio: false,
      };
      next.assets.push(text, color);
      const duration = toFrames(section.duration),
        group = uid('group');
      add(text, foreground.id, cursor, duration, group);
      add(color, background.id, cursor, duration, group);
      cursor += duration;
      continue;
    }
    const source = sourceFor(section.sourceSlot!)!;
    const start = section.rowStart ?? source.layout.start,
      end = section.rowEnd ?? source.layout.end;
    if (start < 1 || end < start || end > Math.max(1, source.rowIds.length))
      throw new Error(`「${section.name}」行范围超出图片方案`);
    if (section.kind === 'secondary') {
      const plans = planBatch(Math.max(1, source.rowIds.length), start, end, source.layout.repeats);
      if (section.order === 'reverse') plans.reverse();
      for (const [index, plan] of plans.entries()) {
        const boundary = cursor;
        add(
          graphicAsset(source, plan.indices.map((i) => source.rowIds[i]).filter(Boolean)),
          video.id,
          cursor,
          toFrames(section.duration),
          uid('group'),
        );
        cursor += toFrames(section.duration);
        if (index > 0 && section.transition) {
          const d = toFrames(section.transition);
          overlapBoundary(sequence, boundary, d);
          cursor -= d;
        }
      }
      if (bindings.bgmAssetId) {
        const asset = next.assets.find((a) => a.id === bindings.bgmAssetId);
        if (!asset || !(asset.kind === 'audio' || (asset.kind === 'video' && asset.hasAudio)))
          throw new Error('背景音乐素材无效');
        const length = cursor - chapterStart;
        const musicLength = bindings.bgmLoop
          ? length
          : Math.min(length, Math.floor(asset.duration * t.fps + 1e-7));
        if (musicLength < 1) continue;
        const clip = add(asset, bgm.id, chapterStart, musicLength);
        clip.loop = !!bindings.bgmLoop;
        clip.fadeIn = clip.fadeOut = Math.min(toFrames(0.3), Math.floor(musicLength / 2));
      }
    } else {
      const main = bindings.mainBySource?.[source.id] ?? bindings.main;
      if (new Set(main.map((b) => b.rowId)).size !== main.length)
        throw new Error(`图片方案「${source.name}」主榜条目重复绑定，请保留唯一的视频选择`);
      const rowIds = source.rowIds.slice(start - 1, end);
      if (!rowIds.length) throw new Error('主榜没有数据条目');
      if (section.order === 'reverse') rowIds.reverse();
      const bgSource = sourceFor(`${section.sourceSlot}:background`, true) ?? source;
      const fgSource = sourceFor(`${section.sourceSlot}:foreground`, true);
      const rowsFor = (other: GraphicSource, rowId: string) => {
        if (!other.rowIds.length) return [];
        const selected = other.rowIds.includes(rowId)
          ? rowId
          : other.rowIds[source.rowIds.indexOf(rowId)];
        if (!selected) throw new Error('主榜前景/背景方案没有对应数据行');
        return [selected];
      };
      for (const [index, rowId] of rowIds.entries()) {
        const binding = main.find((b) => b.rowId === rowId);
        if (!binding)
          throw new Error(`主榜条目尚未绑定视频：第 ${source.rowIds.indexOf(rowId) + 1} 行`);
        const asset = next.assets.find((a) => a.id === binding.assetId);
        if (!asset || asset.kind !== 'video') throw new Error('主榜必须绑定视频素材');
        if (
          ![binding.sourceIn, binding.sourceOut].every(Number.isFinite) ||
          binding.sourceIn < 0 ||
          binding.sourceOut <= binding.sourceIn ||
          binding.sourceOut > asset.duration + 1e-7
        )
          throw new Error('主榜截取入点/出点超出视频范围');
        const duration = Math.floor((binding.sourceOut - binding.sourceIn) * t.fps + 1e-7);
        const group = uid('group'),
          boundary = cursor;
        if (section.mainMode === 'alternating' && section.cardDuration > 0) {
          add(
            graphicAsset(source, [rowId]),
            video.id,
            cursor,
            toFrames(section.cardDuration),
            group,
          );
          cursor += toFrames(section.cardDuration);
        }
        const clip = add(asset, video.id, cursor, duration, group);
        clip.sourceIn = binding.sourceIn;
        if (section.mainMode === 'window') {
          Object.assign(clip.transform, section.window);
          add(
            graphicAsset(bgSource, rowsFor(bgSource, rowId)),
            background.id,
            cursor,
            duration,
            group,
          );
          if (fgSource)
            add(
              graphicAsset(fgSource, rowsFor(fgSource, rowId)),
              foreground.id,
              cursor,
              duration,
              group,
            );
        }
        if (asset.hasAudio) {
          const sound = add(asset, audio.id, cursor, duration, group);
          sound.sourceIn = binding.sourceIn;
          clip.linkId = sound.linkId = uid('link');
        }
        cursor += duration;
        if (index > 0 && section.transition) {
          const d = toFrames(section.transition);
          overlapBoundary(sequence, boundary, d);
          cursor -= d;
        }
      }
    }
  }
  if (!sequence.clips.length) throw new Error('模板没有可生成的片段');
  validateSequence(sequence, next.assets);
  next.sequences.push(sequence);
  next.activeSequenceId = sequence.id;
  next.updatedAt = new Date().toISOString();
  return validateProject(next);
}
