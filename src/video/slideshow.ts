import { validFrameRate } from './settings';
import { createClip, createSequence, createTrack, uid, validateSequence } from './model';
import type { MediaAsset, SlideshowSettings, VideoClip, VideoSequence } from './types';

export interface SlideshowInspection {
  editable: boolean;
  reason?: string;
  pages: VideoClip[];
  settings: SlideshowSettings;
  bgm?: VideoClip;
}

export const isSlideAsset = (asset: MediaAsset) =>
  ['image', 'graphic', 'text', 'color'].includes(asset.kind);
const isMusic = (asset: MediaAsset) =>
  asset.kind === 'audio' || (asset.kind === 'video' && asset.hasAudio);

function defaults(sequence: VideoSequence): SlideshowSettings {
  return {
    pageTrackId:
      sequence.tracks.find((track) => track.kind === 'video')?.id ?? `${sequence.id}-pages`,
    bgmTrackId: sequence.tracks.find((track) => track.kind === 'audio')?.id ?? `${sequence.id}-bgm`,
    defaultDuration: Math.max(1, Math.round(5 * sequence.fps)),
    transitionDuration: 0,
    bgmVolume: 1,
    bgmLoop: true,
    bgmFadeIn: Math.round(0.3 * sequence.fps),
    bgmFadeOut: Math.round(0.3 * sequence.fps),
    ...sequence.slideshow,
  };
}

/** A read-only projection. Switching views never rewrites or simplifies an existing timeline. */
export function inspectSlideshow(
  sequence: VideoSequence,
  assets: MediaAsset[],
): SlideshowInspection {
  const settings = defaults(sequence);
  const videoTracks = sequence.tracks.filter((track) => track.kind === 'video');
  const occupied = videoTracks.filter((track) =>
    sequence.clips.some((clip) => clip.trackId === track.id),
  );
  const pageTrack =
    occupied[0] ?? videoTracks.find((track) => track.id === settings.pageTrackId) ?? videoTracks[0];
  if (pageTrack) settings.pageTrackId = pageTrack.id;
  const pages = sequence.clips
    .filter((clip) => clip.trackId === settings.pageTrackId)
    .sort((a, b) => a.start - b.start);
  const audioTracks = sequence.tracks.filter((track) => track.kind === 'audio');
  const sounds = sequence.clips.filter((clip) =>
    audioTracks.some((track) => track.id === clip.trackId),
  );
  const bgm = sounds[0];
  const musicTrack = bgm
    ? audioTracks.find((track) => track.id === bgm.trackId)
    : (audioTracks.find((track) => track.id === settings.bgmTrackId) ?? audioTracks[0]);
  if (musicTrack) settings.bgmTrackId = musicTrack.id;
  if (bgm) {
    const remembered = sequence.slideshow;
    const expectedFades = { ...bgm };
    if (remembered) clampedFades(expectedFades, remembered.bgmFadeIn, remembered.bgmFadeOut);
    const keepFadePreference =
      remembered?.bgmAssetId === bgm.assetId &&
      expectedFades.fadeIn === bgm.fadeIn &&
      expectedFades.fadeOut === bgm.fadeOut;
    settings.bgmAssetId = bgm.assetId;
    settings.bgmVolume = bgm.volume;
    settings.bgmLoop = bgm.loop;
    settings.bgmFadeIn = keepFadePreference ? remembered!.bgmFadeIn : bgm.fadeIn;
    settings.bgmFadeOut = keepFadePreference ? remembered!.bgmFadeOut : bgm.fadeOut;
  } else if (sequence.clips.length && sequence.slideshow?.bgmAssetId) {
    // Removing music in the timeline must stay removed when another page is edited.
    delete settings.bgmAssetId;
  }
  const result: SlideshowInspection = { editable: false, pages, settings, bgm };
  const reject = (reason: string) => ({ ...result, reason });
  try {
    validateSequence(sequence, assets);
  } catch (error) {
    return reject(
      `当前时间轴需要先修复：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (occupied.length > 1)
    return reject('当前序列包含多条画面轨的内容，请在时间轴编辑，或新建 PPT 序列。');
  if (pages.some((clip) => !isSlideAsset(assets.find((asset) => asset.id === clip.assetId)!)))
    return reject('PPT 页面只支持图片、图文、文字和纯色；当前序列含视频片段，请使用时间轴。');
  if (pages.some((clip) => clip.linkId))
    return reject('页面存在音视频关联，请先在时间轴解除关联。');
  const pageGroups = pages.map((clip) => clip.groupId).filter(Boolean);
  if (new Set(pageGroups).size !== pageGroups.length)
    return reject('多页被编入同一组，请先在时间轴解除编组。');
  if (sounds.length > 1)
    return reject('当前序列包含多个声音片段，PPT 模式只管理一条连续背景音乐。');
  if (pageTrack?.locked || musicTrack?.locked)
    return reject('页面或背景音乐轨道已锁定，请先在时间轴解锁。');
  if (pageTrack?.hidden) return reject('页面轨道已隐藏，请先在时间轴显示该轨道。');
  if (pages.length && pages[0].start !== 0)
    return reject('第一页未从序列起点开始，请在时间轴整理后再进入 PPT 编辑。');
  const overlaps: number[] = [];
  for (let i = 1; i < pages.length; i++) {
    const overlap = pages[i - 1].start + pages[i - 1].duration - pages[i].start;
    if (overlap < 0) return reject('页面之间有空白间隙，请在时间轴整理后再进入 PPT 编辑。');
    overlaps.push(overlap);
  }
  if (new Set(overlaps).size > 1)
    return reject(
      '页面使用了不同长度的转场；请在时间轴保留这些独立设置，或统一转场后再使用 PPT 编辑。',
    );
  if (overlaps.length) settings.transitionDuration = overlaps[0];
  const duration = pages.length ? pages.at(-1)!.start + pages.at(-1)!.duration : 0;
  if (bgm && (bgm.start !== 0 || bgm.start + bgm.duration > duration || bgm.linkId || bgm.groupId))
    return reject('背景音乐须从起点连续播放且不超出页面，不能关联或编组；请先在时间轴调整。');
  return { ...result, editable: true };
}

export function createSlideshowSequence(name = '副榜 PPT', width = 1920, height = 1080, fps = 60) {
  const sequence = createSequence(name, width, height, fps);
  sequence.tracks[0].name = 'PPT 页面';
  sequence.tracks[1].name = '背景音乐';
  sequence.slideshow = defaults(sequence);
  return sequence;
}

function editable(sequence: VideoSequence, assets: MediaAsset[]) {
  const view = inspectSlideshow(sequence, assets);
  if (!view.editable) throw new Error(view.reason);
  return view;
}

/** Attach preferences only; existing clips, transitions and track ordering are unchanged. */
export function enableSlideshow(sequence: VideoSequence, assets: MediaAsset[]): VideoSequence {
  const view = editable(sequence, assets);
  return validateSequence({ ...sequence, slideshow: view.settings }, assets);
}

function integer(value: number, min: number, label: string) {
  if (!Number.isSafeInteger(value) || value < min)
    throw new Error(`${label}必须是至少 ${min} 的整数帧数`);
}

function selected(pages: VideoClip[], ids: string[]) {
  if (
    !ids.length ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !pages.some((page) => page.id === id))
  )
    throw new Error('请选择有效且不重复的 PPT 页面');
  return new Set(ids);
}

function clampedFades(clip: VideoClip, fadeIn: number, fadeOut: number) {
  const total = fadeIn + fadeOut;
  clip.fadeIn = total > clip.duration ? Math.floor((clip.duration * fadeIn) / total) : fadeIn;
  clip.fadeOut = total > clip.duration ? clip.duration - clip.fadeIn : fadeOut;
}

/** All mutation work is done on a clone, then validated as one atomic timeline edit. */
function rebuild(
  sequence: VideoSequence,
  assets: MediaAsset[],
  pages: VideoClip[],
  settings: SlideshowSettings,
  previousBgm?: VideoClip,
) {
  const next = structuredClone(sequence);
  next.slideshow = structuredClone(settings);
  if (!next.tracks.some((track) => track.id === settings.pageTrackId))
    next.tracks.unshift({ ...createTrack('video', 'PPT 页面'), id: settings.pageTrackId });
  if (!next.tracks.some((track) => track.id === settings.bgmTrackId))
    next.tracks.push({ ...createTrack('audio', '背景音乐'), id: settings.bgmTrackId });
  const oldTransitions = sequence.transitions;
  next.transitions = [];
  let cursor = 0;
  const placed = structuredClone(pages);
  for (let i = 0; i < placed.length; i++) {
    const page = placed[i];
    const transition = settings.transitionDuration;
    integer(page.duration, 1, '页面时长');
    const used = (i > 0 ? transition : 0) + (i < placed.length - 1 ? transition : 0);
    if (used > page.duration || (placed.length > 1 && transition >= page.duration))
      throw new Error(`「${page.name}」时长不足以容纳转场，请增加页长或缩短叠化时间。`);
    page.start = cursor;
    page.trackId = settings.pageTrackId;
    clampedFades(page, page.fadeIn, page.fadeOut);
    if (i && transition) {
      const from = placed[i - 1];
      next.transitions.push({
        id:
          oldTransitions.find((edge) => edge.fromClipId === from.id && edge.toClipId === page.id)
            ?.id ?? uid('transition'),
        fromClipId: from.id,
        toClipId: page.id,
        duration: transition,
      });
    }
    cursor += page.duration - (i < placed.length - 1 ? transition : 0);
    integer(cursor, 1, '页面总时长');
  }
  next.clips = placed;
  if (settings.bgmAssetId) {
    const asset = assets.find((item) => item.id === settings.bgmAssetId);
    if (!asset || !isMusic(asset)) throw new Error('背景音乐必须选择有效音频或带声音的视频素材');
    const sameSource = previousBgm?.assetId === asset.id;
    const sourceIn = sameSource ? previousBgm.sourceIn : 0;
    const available = Math.floor((asset.duration - sourceIn) * sequence.fps + 1e-7);
    if (available < 1) throw new Error('背景音乐可用范围不足一帧');
    const oldPageDuration = Math.max(
      0,
      ...sequence.clips
        .filter((clip) =>
          sequence.tracks.some((track) => track.kind === 'video' && track.id === clip.trackId),
        )
        .map((clip) => clip.start + clip.duration),
    );
    const preserveRange =
      sameSource && cursor === oldPageDuration && settings.bgmLoop === previousBgm.loop;
    const duration = preserveRange
      ? previousBgm.duration
      : settings.bgmLoop
        ? cursor
        : Math.min(cursor, available);
    if (duration) {
      const bgm = sameSource
        ? structuredClone(previousBgm)
        : createClip(asset, settings.bgmTrackId, 0, duration, sequence);
      Object.assign(bgm, {
        start: 0,
        duration,
        sourceIn,
        trackId: settings.bgmTrackId,
        volume: settings.bgmVolume,
        loop: settings.bgmLoop,
      });
      clampedFades(bgm, settings.bgmFadeIn, settings.bgmFadeOut);
      next.clips.push(bgm);
    }
  }
  if (next.exportSettings) {
    const oldDuration = Math.max(0, ...sequence.clips.map((clip) => clip.start + clip.duration));
    if (!cursor) delete next.exportSettings;
    else if (next.exportSettings.endFrame === oldDuration) {
      next.exportSettings.endFrame = cursor;
      next.exportSettings.startFrame = Math.min(next.exportSettings.startFrame, cursor - 1);
    }
  }
  return validateSequence(next, assets);
}

export function insertSlides(
  sequence: VideoSequence,
  assets: MediaAsset[],
  assetIds: string[],
  index?: number,
  duration?: number,
) {
  const view = editable(sequence, assets);
  const at = index ?? view.pages.length;
  if (!Number.isSafeInteger(at) || at < 0 || at > view.pages.length)
    throw new Error('插入页面的位置无效');
  if (!assetIds.length) throw new Error('请选择要加入 PPT 的图片或图文');
  const length = duration ?? view.settings.defaultDuration;
  integer(length, 1, '页面时长');
  const incoming = assetIds.map((id) => {
    const asset = assets.find((item) => item.id === id);
    if (!asset || !isSlideAsset(asset)) throw new Error('PPT 页面只支持图片、图文、文字和纯色');
    return createClip(asset, view.settings.pageTrackId, 0, length, sequence);
  });
  const pages = [...view.pages];
  pages.splice(at, 0, ...incoming);
  return rebuild(sequence, assets, pages, view.settings, view.bgm);
}

export function removeSlides(sequence: VideoSequence, assets: MediaAsset[], clipIds: string[]) {
  const view = editable(sequence, assets),
    ids = selected(view.pages, clipIds);
  return rebuild(
    sequence,
    assets,
    view.pages.filter((page) => !ids.has(page.id)),
    view.settings,
    view.bgm,
  );
}

export function duplicateSlides(sequence: VideoSequence, assets: MediaAsset[], clipIds: string[]) {
  const view = editable(sequence, assets),
    ids = selected(view.pages, clipIds);
  const pages = view.pages.flatMap((page) =>
    ids.has(page.id)
      ? [
          page,
          {
            ...structuredClone(page),
            id: uid('clip'),
            groupId: page.groupId ? uid('group') : undefined,
          },
        ]
      : [page],
  );
  return rebuild(sequence, assets, pages, view.settings, view.bgm);
}

export function reorderSlides(
  sequence: VideoSequence,
  assets: MediaAsset[],
  orderedClipIds: string[],
) {
  const view = editable(sequence, assets);
  if (
    orderedClipIds.length !== view.pages.length ||
    new Set(orderedClipIds).size !== view.pages.length
  )
    throw new Error('重排必须且只能包含每一页一次');
  const pages = orderedClipIds.map((id) => view.pages.find((page) => page.id === id));
  if (pages.some((page) => !page)) throw new Error('重排包含不存在的页面');
  return rebuild(sequence, assets, pages as VideoClip[], view.settings, view.bgm);
}

export function setSlideDuration(
  sequence: VideoSequence,
  assets: MediaAsset[],
  clipIds: string[],
  duration: number,
) {
  const view = editable(sequence, assets),
    ids = selected(view.pages, clipIds);
  integer(duration, 1, '页面时长');
  return rebuild(
    sequence,
    assets,
    view.pages.map((page) => (ids.has(page.id) ? { ...page, duration } : page)),
    view.settings,
    view.bgm,
  );
}

export function setSlideshowSettings(
  sequence: VideoSequence,
  assets: MediaAsset[],
  patch: Partial<SlideshowSettings>,
) {
  const view = editable(sequence, assets);
  if (
    (patch.pageTrackId !== undefined && patch.pageTrackId !== view.settings.pageTrackId) ||
    (patch.bgmTrackId !== undefined && patch.bgmTrackId !== view.settings.bgmTrackId)
  )
    throw new Error('请在时间轴修改轨道，PPT 设置不能替换轨道');
  const settings = { ...view.settings, ...patch };
  // Validate preferences before using them in frame arithmetic (NaN/negative values included).
  validateSequence({ ...sequence, slideshow: settings }, assets);
  return rebuild(sequence, assets, view.pages, settings, view.bgm);
}

/** Change frame rate without opening gaps between independently rounded PPT page lengths. */
export function rescaleSlideshow(
  sequence: VideoSequence,
  assets: MediaAsset[],
  fps: number,
): VideoSequence {
  if (!validFrameRate(fps)) throw new Error('PPT 帧率必须是 1～240 之间的有限数值');
  const view = editable(sequence, assets);
  if (fps === sequence.fps) return validateSequence(sequence, assets);
  const ratio = fps / sequence.fps;
  const scale = (frames: number) => Math.round(frames * ratio);
  const pages = view.pages.map((page) => ({
    ...structuredClone(page),
    duration: Math.max(1, scale(page.duration)),
    fadeIn: scale(page.fadeIn),
    fadeOut: scale(page.fadeOut),
  }));
  const transitionLimit =
    pages.length > 1
      ? Math.min(
          ...pages.map((page, index) =>
            index === 0 || index === pages.length - 1
              ? page.duration - 1
              : Math.floor(page.duration / 2),
          ),
        )
      : Number.MAX_SAFE_INTEGER;
  const settings: SlideshowSettings = {
    ...view.settings,
    defaultDuration: Math.max(1, scale(view.settings.defaultDuration)),
    transitionDuration: Math.min(scale(view.settings.transitionDuration), transitionLimit),
    bgmFadeIn: scale(view.settings.bgmFadeIn),
    bgmFadeOut: scale(view.settings.bgmFadeOut),
  };
  const base = { ...sequence, fps };
  const next = rebuild(base, assets, pages, settings, view.bgm);
  const oldDuration = view.pages.at(-1)
    ? view.pages.at(-1)!.start + view.pages.at(-1)!.duration
    : 0;
  const duration = Math.max(
    0,
    ...next.clips
      .filter((clip) => clip.trackId === settings.pageTrackId)
      .map((clip) => clip.start + clip.duration),
  );
  const music = next.clips.find((clip) => clip.trackId === settings.bgmTrackId);
  if (music && view.bgm) {
    const asset = assets.find((item) => item.id === music.assetId)!;
    const available = Math.floor((asset.duration - music.sourceIn) * fps + 1e-7);
    const requested =
      view.bgm.duration === oldDuration ? duration : Math.max(1, scale(view.bgm.duration));
    music.duration = Math.min(
      duration,
      requested,
      music.loop ? Number.MAX_SAFE_INTEGER : available,
    );
    clampedFades(music, settings.bgmFadeIn, settings.bgmFadeOut);
  }
  next.markers = sequence.markers.map((marker) => ({ ...marker, frame: scale(marker.frame) }));
  if (sequence.exportSettings && duration) {
    const startFrame = Math.min(scale(sequence.exportSettings.startFrame), duration - 1);
    next.exportSettings = {
      ...sequence.exportSettings,
      startFrame,
      endFrame:
        sequence.exportSettings.endFrame === oldDuration
          ? duration
          : Math.min(duration, Math.max(startFrame + 1, scale(sequence.exportSettings.endFrame))),
    };
  } else delete next.exportSettings;
  return validateSequence(next, assets);
}
