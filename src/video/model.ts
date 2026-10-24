import { MIN_FRAME_RATE, MAX_FRAME_RATE } from './settings';
import { normalizeDocument } from '../core/document';
import { planBatch } from '../core/data';
import type { TableData, TedDocument } from '../core/types';
import type {
  GraphicSource,
  MediaAsset,
  VideoClip,
  VideoProject,
  VideoSequence,
  VideoTrack,
} from './types';
import { validateTemplate } from './templates';

export const uid = (prefix = 'video') => `${prefix}-${crypto.randomUUID()}`;
export const sequenceDuration = (sequence: VideoSequence) =>
  Math.max(0, ...sequence.clips.map((clip) => clip.start + clip.duration));

export function createTrack(
  kind: VideoTrack['kind'],
  name = kind === 'video' ? '画面' : '声音',
): VideoTrack {
  return {
    id: uid('track'),
    name,
    kind,
    locked: false,
    hidden: false,
    muted: false,
    solo: false,
    volume: 1,
  };
}

export function createSequence(
  name = '序列 1',
  width = 1920,
  height = 1080,
  fps = 60,
): VideoSequence {
  return validateSequence({
    id: uid('sequence'),
    name,
    width,
    height,
    fps,
    background: '#000000',
    tracks: [createTrack('video', 'V1'), createTrack('audio', 'A1')],
    clips: [],
    transitions: [],
    markers: [],
  });
}

export function createProject(name = '未命名视频工程'): VideoProject {
  const sequence = createSequence();
  const now = new Date().toISOString();
  return {
    format: 'teditor-video',
    version: 1,
    id: uid('project'),
    name,
    createdAt: now,
    updatedAt: now,
    activeSequenceId: sequence.id,
    assets: [],
    graphics: [],
    sequences: [sequence],
  };
}

export function createClip(
  asset: MediaAsset,
  trackId: string,
  start: number,
  duration: number,
  sequence: VideoSequence,
): VideoClip {
  return {
    id: uid('clip'),
    name: asset.name,
    trackId,
    assetId: asset.id,
    start,
    duration,
    sourceIn: 0,
    transform: {
      x: 0,
      y: 0,
      width: sequence.width,
      height: sequence.height,
      rotation: 0,
      opacity: 1,
      fit: 'contain',
      crop: { top: 0, right: 0, bottom: 0, left: 0 },
    },
    volume: 1,
    fadeIn: 0,
    fadeOut: 0,
    loop: false,
  };
}

type Obj = Record<string, unknown>;
function object(value: unknown, label: string): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label}必须是对象`);
  return value as Obj;
}
function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label}必须是数组`);
  return value;
}
function text(value: unknown, label: string, nonempty = false): asserts value is string {
  if (typeof value !== 'string' || (nonempty && !value.trim()))
    throw new Error(`${label}必须是${nonempty ? '非空' : ''}文本`);
}
function number(
  value: unknown,
  label: string,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
  integer = false,
): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isSafeInteger(value))
  )
    throw new Error(`${label}必须是 ${min}～${max} 之间的${integer ? '整数' : '有限数值'}`);
}
function boolean(value: unknown, label: string) {
  if (typeof value !== 'boolean') throw new Error(`${label}必须是布尔值`);
}
function unique(items: Obj[], label: string) {
  const ids = new Set<string>();
  for (const item of items) {
    text(item.id, `${label} ID`, true);
    if (ids.has(item.id)) throw new Error(`${label} ID 重复：${item.id}`);
    ids.add(item.id);
  }
  return ids;
}
function choice(value: unknown, values: string[], label: string) {
  if (!values.includes(value as string)) throw new Error(`${label}无效`);
}

/** Validation is non-mutating and rejects malformed timing rather than silently rounding it. */
export function validateSequence(input: unknown, assets?: MediaAsset[]): VideoSequence {
  const raw = object(input, '序列');
  text(raw.id, '序列 ID', true);
  text(raw.name, '序列名称');
  text(raw.background, '背景颜色');
  number(raw.width, '序列宽度', 1, 16384, true);
  number(raw.height, '序列高度', 1, 16384, true);
  if (raw.width * raw.height > 64_000_000) throw new Error('序列画布超过 6400 万像素');
  number(raw.fps, '序列帧率', MIN_FRAME_RATE, MAX_FRAME_RATE);
  if (raw.slideshow !== undefined) {
    const settings = object(raw.slideshow, 'PPT 设置');
    text(settings.pageTrackId, 'PPT 页面轨道', true);
    text(settings.bgmTrackId, 'PPT 背景音乐轨道', true);
    if (settings.pageTrackId === settings.bgmTrackId)
      throw new Error('PPT 页面和背景音乐必须使用不同轨道');
    number(settings.defaultDuration, 'PPT 默认页长', 1, Number.MAX_SAFE_INTEGER, true);
    for (const key of ['transitionDuration', 'bgmFadeIn', 'bgmFadeOut'])
      number(settings[key], `PPT ${key}`, 0, Number.MAX_SAFE_INTEGER, true);
    number(settings.bgmVolume, 'PPT 背景音乐音量', 0, 10);
    boolean(settings.bgmLoop, 'PPT 背景音乐循环');
    if (settings.bgmAssetId !== undefined) text(settings.bgmAssetId, 'PPT 背景音乐素材', true);
    // Timeline edits may remove these tracks or change their contents. Keep preferences
    // recoverable; the PPT inspector checks actual clips before allowing edits.
  }
  if (raw.exportSettings !== undefined) {
    const settings = object(raw.exportSettings, '序列导出设置');
    number(settings.startFrame, '导出起始帧', 0, Number.MAX_SAFE_INTEGER, true);
    number(settings.endFrame, '导出结束帧', 0, Number.MAX_SAFE_INTEGER, true);
    if (settings.endFrame <= settings.startFrame) throw new Error('导出结束帧必须晚于起始帧');
    number(settings.videoBitrate, '导出视频码率', 1, Number.MAX_SAFE_INTEGER, true);
    if (settings.videoBitrateMode !== undefined)
      choice(settings.videoBitrateMode, ['variable', 'constant'], '视频码率模式');
    // Keep stored ranges after timeline edits; the export UI clamps them to the new duration.
  }
  const tracks = array(raw.tracks, '轨道').map((v) => object(v, '轨道'));
  const trackIds = unique(tracks, '轨道');
  for (const track of tracks) {
    text(track.name, '轨道名称');
    choice(track.kind, ['video', 'audio'], '轨道类型');
    for (const field of ['locked', 'hidden', 'muted', 'solo']) boolean(track[field], field);
    number(track.volume, '轨道音量', 0, 10);
  }
  const clips = array(raw.clips, '片段').map((v) => object(v, '片段'));
  const clipIds = unique(clips, '片段');
  for (const clip of clips) {
    text(clip.name, '片段名称');
    text(clip.assetId, '素材 ID', true);
    text(clip.trackId, '轨道 ID', true);
    if (!trackIds.has(clip.trackId)) throw new Error(`片段引用不存在的轨道：${clip.trackId}`);
    number(clip.start, '片段开始帧', 0, Number.MAX_SAFE_INTEGER, true);
    number(clip.duration, '片段长度', 1, Number.MAX_SAFE_INTEGER, true);
    number(clip.start + clip.duration, '片段结束帧', 1, Number.MAX_SAFE_INTEGER, true);
    number(clip.sourceIn, '源入点', 0);
    number(clip.volume, '片段音量', 0, 10);
    number(clip.fadeIn, '淡入帧数', 0, clip.duration, true);
    number(clip.fadeOut, '淡出帧数', 0, clip.duration, true);
    if (clip.fadeIn + clip.fadeOut > clip.duration)
      throw new Error('片段淡入淡出不能争用同一段内容');
    boolean(clip.loop, '循环');
    for (const field of ['linkId', 'groupId'])
      if (clip[field] !== undefined) text(clip[field], field, true);
    const transform = object(clip.transform, '片段变换');
    number(transform.x, 'X 坐标', -1e7, 1e7);
    number(transform.y, 'Y 坐标', -1e7, 1e7);
    number(transform.width, '片段宽度', 0.01, 1e7);
    number(transform.height, '片段高度', 0.01, 1e7);
    number(transform.rotation, '旋转', -1e7, 1e7);
    number(transform.opacity, '透明度', 0, 1);
    choice(transform.fit, ['contain', 'cover'], '适应方式');
    const crop = object(transform.crop, '裁切');
    for (const field of ['top', 'right', 'bottom', 'left']) number(crop[field], '裁切比例', 0, 1);
    if (
      (crop.top as number) + (crop.bottom as number) >= 1 ||
      (crop.left as number) + (crop.right as number) >= 1
    )
      throw new Error('裁切不能移除全部画面');
  }
  const transitions = array(raw.transitions, '转场').map((v) => object(v, '转场'));
  unique(transitions, '转场');
  const used = new Map<string, number>();
  const edgeKeys = new Set<string>();
  for (const transition of transitions) {
    text(transition.fromClipId, '转场前片段');
    text(transition.toClipId, '转场后片段');
    const from = clips.find((clip) => clip.id === transition.fromClipId),
      to = clips.find((clip) => clip.id === transition.toClipId);
    if (!from || !to || from === to || from.trackId !== to.trackId)
      throw new Error('转场必须连接同轨的两个有效片段');
    number(
      transition.duration,
      '转场帧数',
      1,
      Math.min(from.duration as number, to.duration as number),
      true,
    );
    if (
      (from.start as number) >= (to.start as number) ||
      (to.start as number) + transition.duration !==
        (from.start as number) + (from.duration as number)
    )
      throw new Error('转场重叠区间与片段位置不一致');
    for (const [key, clip] of [
      [`${from.id}:out`, from],
      [`${to.id}:in`, to],
    ] as const) {
      if (edgeKeys.has(key)) throw new Error('片段同一端不能有多个转场');
      edgeKeys.add(key);
      used.set(clip.id as string, (used.get(clip.id as string) ?? 0) + transition.duration);
      if (used.get(clip.id as string)! > (clip.duration as number))
        throw new Error('前后转场争用同一段内容');
    }
  }
  for (const trackId of trackIds) {
    const ordered = clips
      .filter((clip) => clip.trackId === trackId)
      .sort((a, b) => (a.start as number) - (b.start as number));
    for (let i = 0; i < ordered.length; i++)
      for (let j = i + 1; j < ordered.length; j++) {
        const a = ordered[i],
          b = ordered[j];
        if ((b.start as number) >= (a.start as number) + (a.duration as number)) break;
        if (!transitions.some((t) => t.fromClipId === a.id && t.toClipId === b.id))
          throw new Error('同轨片段发生未声明的重叠，请使用覆盖或转场');
      }
  }
  const markers = array(raw.markers, '标记').map((v) => object(v, '标记'));
  unique(markers, '标记');
  for (const marker of markers) {
    text(marker.label, '标记名称');
    number(marker.frame, '标记帧', 0, Number.MAX_SAFE_INTEGER, true);
  }
  const sequence = input as VideoSequence;
  const links = new Map<string, VideoClip>();
  for (const clip of sequence.clips) {
    if (clip.linkId) {
      const first = links.get(clip.linkId);
      if (
        first &&
        (first.start !== clip.start ||
          first.duration !== clip.duration ||
          Math.abs(first.sourceIn - clip.sourceIn) > 1e-7)
      )
        throw new Error('关联音视频的时间不一致，请先解除关联');
      links.set(clip.linkId, clip);
    }
    if (assets) {
      const asset = assets.find((a) => a.id === clip.assetId);
      if (!asset) throw new Error(`素材不存在：${clip.assetId}`);
      const track = sequence.tracks.find((t) => t.id === clip.trackId)!;
      if (
        track.kind === 'audio' &&
        !(asset.kind === 'audio' || (asset.kind === 'video' && asset.hasAudio))
      )
        throw new Error('该素材没有可放入音轨的声音');
      if (track.kind === 'video' && asset.kind === 'audio')
        throw new Error('音频素材不能放入画面轨');
      if (asset.kind === 'video' || asset.kind === 'audio') {
        if (asset.duration <= 0 || clip.sourceIn >= asset.duration)
          throw new Error('素材长度或源入点无效');
        if (!clip.loop && clip.sourceIn + clip.duration / sequence.fps > asset.duration + 1e-7)
          throw new Error(`片段超出源素材范围：${clip.name}`);
      }
    }
  }
  return structuredClone(sequence);
}

export function validateProject(input: unknown): VideoProject {
  const raw = object(input, '视频工程');
  if (raw.format !== 'teditor-video' || raw.version !== 1)
    throw new Error('不支持的视频工程格式或版本');
  for (const field of ['id', 'name', 'activeSequenceId', 'createdAt', 'updatedAt'])
    text(raw[field], field, true);
  for (const field of ['createdAt', 'updatedAt'])
    if (!Number.isFinite(Date.parse(raw[field] as string))) throw new Error('工程时间无效');
  const graphics = array(raw.graphics, '图片方案').map((v) => object(v, '图片方案'));
  const graphicIds = unique(graphics, '图片方案');
  const resourceMetadata = new Map<string, string>();
  for (const graphic of graphics) {
    text(graphic.name, '图片方案名称');
    number(graphic.revision, '图片方案版本', 0, Number.MAX_SAFE_INTEGER, true);
    normalizeDocument(graphic.document);
    const table = object(graphic.table, '表格');
    const headers = array(table.headers, '表头');
    headers.forEach((h) => text(h, '列名', true));
    if (new Set(headers).size !== headers.length) throw new Error('表头重复');
    const rows = array(table.rows, '数据行');
    rows.forEach((row) => Object.values(object(row, '数据行')).forEach((v) => text(v, '单元格')));
    const rowIds = array(graphic.rowIds, '数据行 ID');
    rowIds.forEach((v) => text(v, '数据行 ID', true));
    if (rowIds.length !== rows.length || new Set(rowIds).size !== rowIds.length)
      throw new Error('数据行 ID 必须与数据一一对应且唯一');
    if (table.rowIds !== undefined && JSON.stringify(table.rowIds) !== JSON.stringify(rowIds))
      throw new Error('表格与图片方案的数据行 ID 不一致');
    const layout = object(graphic.layout, '图片排版');
    number(layout.start, '起始行', 1, Math.max(1, rows.length), true);
    number(layout.end, '结束行', layout.start as number, Math.max(1, rows.length), true);
    number(layout.repeats, '额外副本数', 0, 100000, true);
    number(layout.deltaX, 'X 偏移', -1e7, 1e7);
    number(layout.deltaY, 'Y 偏移', -1e7, 1e7);
    if (graphic.resources !== undefined) {
      const paths = new Set<string>();
      for (const item of array(graphic.resources, '图文资源')) {
        const resource = object(item, '图文资源');
        for (const field of ['id', 'path', 'fileName'])
          text(resource[field], `图文资源 ${field}`, true);
        text(resource.mimeType, '图文资源 MIME');
        number(resource.size, '图文资源大小', 0, Number.MAX_SAFE_INTEGER, true);
        number(resource.lastModified, '图文资源修改时间', 0, Number.MAX_SAFE_INTEGER, true);
        if (resource.fontFamily !== undefined) text(resource.fontFamily, '图文资源字体', true);
        if (paths.has(resource.path as string)) throw new Error('同一图片方案的图文资源路径重复');
        paths.add(resource.path as string);
        const metadata = JSON.stringify([
          resource.fileName,
          resource.size,
          resource.lastModified,
          resource.mimeType,
        ]);
        const old = resourceMetadata.get(resource.id as string);
        if (old && old !== metadata) throw new Error('同一图文资源 ID 的文件元数据不一致');
        resourceMetadata.set(resource.id as string, metadata);
      }
    }
  }
  const assets = array(raw.assets, '素材').map((v) => object(v, '素材'));
  unique(assets, '素材');
  for (const asset of assets) {
    if (resourceMetadata.has(asset.id as string)) throw new Error('图文资源 ID 与媒体素材 ID 冲突');
    text(asset.name, '素材名称');
    choice(asset.kind, ['video', 'audio', 'image', 'graphic', 'text', 'color'], '素材类型');
    for (const field of ['duration', 'width', 'height']) number(asset[field], `素材 ${field}`, 0);
    boolean(asset.hasAudio, '素材声音');
    for (const field of [
      'fileName',
      'relativePath',
      'mimeType',
      'thumbnail',
      'text',
      'color',
      'fontFamily',
    ])
      if (asset[field] !== undefined) text(asset[field], field);
    for (const field of ['size', 'lastModified', 'fontSize'])
      if (asset[field] !== undefined) number(asset[field], field, 0);
    if (asset.waveform !== undefined)
      array(asset.waveform, '波形').forEach((v) => number(v, '波形数值', -1, 1));
    if (asset.waveformVersion !== undefined) number(asset.waveformVersion, '波形版本', 1, 1, true);
    if (asset.kind === 'graphic') {
      const graphic = object(asset.graphic, '图文引用');
      if (!graphicIds.has(graphic.sourceId as string)) throw new Error('图文引用的图片方案不存在');
      const rowIds = array(graphic.rowIds, '图文数据行');
      rowIds.forEach((id) => text(id, '图文数据行 ID', true));
      // Deleted rows stay as unresolved references so existing edits remain recoverable.
      // Rendering/export preflight reports the missing rows; never rebind by row position.
      if (new Set(rowIds).size !== rowIds.length) throw new Error('图文引用的数据行 ID 重复');
    }
  }
  const sequences = array(raw.sequences, '序列').map((v) => object(v, '序列'));
  const sequenceIds = unique(sequences, '序列');
  if (!sequenceIds.has(raw.activeSequenceId as string)) throw new Error('当前序列不存在');
  sequences.forEach((sequence) => validateSequence(sequence, assets as unknown as MediaAsset[]));
  if (raw.templates !== undefined)
    array(raw.templates, '视频模板').forEach((template) => validateTemplate(template));
  if (raw.rankingBindings !== undefined) {
    for (const [sourceId, entries] of Object.entries(object(raw.rankingBindings, '主榜绑定'))) {
      const source = graphics.find((g) => g.id === sourceId);
      if (!source) throw new Error('主榜绑定引用不存在的图片方案');
      const usedRows = new Set<string>();
      for (const entry of array(entries, '主榜绑定列表')) {
        const binding = object(entry, '主榜绑定');
        text(binding.rowId, '主榜数据行 ID', true);
        text(binding.assetId, '主榜素材 ID', true);
        if (usedRows.has(binding.rowId)) throw new Error('主榜绑定数据行重复');
        usedRows.add(binding.rowId);
        const asset = assets.find((a) => a.id === binding.assetId);
        if (!asset || asset.kind !== 'video') throw new Error('主榜绑定必须引用视频素材');
        number(binding.sourceIn, '主榜入点', 0, asset.duration as number);
        number(binding.sourceOut, '主榜出点', 0, asset.duration as number);
        if (binding.sourceOut <= binding.sourceIn) throw new Error('主榜出点必须晚于入点');
      }
    }
  }
  const result = structuredClone(input as VideoProject);
  result.graphics.forEach((source) => {
    source.document = normalizeDocument(source.document).document;
  });
  return result;
}

export const serializeProject = (project: VideoProject) =>
  JSON.stringify(validateProject(project), null, 2);
export function parseProject(json: string): VideoProject {
  let value: unknown;
  try {
    value = JSON.parse(json.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('视频工程必须是有效 JSON');
  }
  return validateProject(value);
}

export function createGraphicSource(
  document: TedDocument,
  table: TableData,
  name: string,
  layout?: Partial<GraphicSource['layout']>,
): GraphicSource {
  const rowIds = table.rowIds ? [...table.rowIds] : table.rows.map(() => uid('row'));
  if (
    rowIds.length !== table.rows.length ||
    new Set(rowIds).size !== rowIds.length ||
    rowIds.some((id) => typeof id !== 'string' || !id)
  )
    throw new Error('数据行 ID 必须与数据一一对应且唯一');
  return {
    id: uid('graphic'),
    name,
    document: normalizeDocument(document).document,
    table: { ...structuredClone(table), rowIds: [...rowIds] },
    rowIds,
    revision: 1,
    layout: {
      start: 1,
      end: Math.max(1, table.rows.length),
      repeats: 0,
      deltaX: 0,
      deltaY: 0,
      ...layout,
    },
  };
}

export function createGraphicAssets(source: GraphicSource): MediaAsset[] {
  const { start, end, repeats } = source.layout;
  return planBatch(Math.max(1, source.table.rows.length), start, end, repeats).map(
    (plan, index) => ({
      id: uid('asset'),
      name: `${source.name} · ${index + 1}`,
      kind: 'graphic',
      duration: 0,
      width: source.document.DocModel.Width,
      height: source.document.DocModel.Height,
      hasAudio: false,
      graphic: {
        sourceId: source.id,
        rowIds: plan.indices.map((i) => source.rowIds[i]).filter((id): id is string => !!id),
      },
    }),
  );
}
