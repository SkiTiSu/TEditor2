import { uid, validateSequence } from './model';
import type { MediaAsset, VideoClip, VideoSequence } from './types';

function frames(value: number) {
  if (!Number.isSafeInteger(value)) throw new Error('时间必须为整数帧');
}
function clipById(sequence: VideoSequence, id: string) {
  const clip = sequence.clips.find((c) => c.id === id);
  if (!clip) throw new Error(`找不到片段：${id}`);
  return clip;
}
function assertUnlocked(sequence: VideoSequence, clips: VideoClip[]) {
  for (const clip of clips) {
    const track = sequence.tracks.find((t) => t.id === clip.trackId);
    if (!track) throw new Error('轨道不存在');
    if (track.locked) throw new Error(`轨道「${track.name}」已锁定，无法同步修改关联片段`);
  }
}
/** Groups affect move/delete; linked A/V always travels together, transitively. */
export function relatedClipIds(sequence: VideoSequence, ids: string[], groups = true): string[] {
  ids.forEach((id) => clipById(sequence, id));
  const selected = new Set(ids);
  let changed = true;
  while (changed) {
    changed = false;
    const selectedClips = sequence.clips.filter((c) => selected.has(c.id));
    for (const clip of sequence.clips)
      if (
        !selected.has(clip.id) &&
        selectedClips.some(
          (other) =>
            (clip.linkId && clip.linkId === other.linkId) ||
            (groups && clip.groupId && clip.groupId === other.groupId),
        )
      ) {
        selected.add(clip.id);
        changed = true;
      }
  }
  return [...selected];
}
function affected(sequence: VideoSequence, ids: string[], groups = true) {
  const set = new Set(relatedClipIds(sequence, ids, groups));
  const clips = sequence.clips.filter((c) => set.has(c.id));
  assertUnlocked(sequence, clips);
  return clips;
}
const finish = (sequence: VideoSequence) => validateSequence(sequence);
const copy = (sequence: VideoSequence) => structuredClone(sequence);
function cleanTransitions(sequence: VideoSequence) {
  const ids = new Set(sequence.clips.map((c) => c.id));
  sequence.transitions = sequence.transitions.filter(
    (t) => ids.has(t.fromClipId) && ids.has(t.toClipId),
  );
}
function clampFades(clip: VideoClip) {
  clip.fadeIn = Math.min(clip.fadeIn, clip.duration);
  clip.fadeOut = Math.min(clip.fadeOut, clip.duration - clip.fadeIn);
}

export function moveClips(
  sequence: VideoSequence,
  ids: string[],
  deltaFrames: number,
  targetTrackId?: string,
): VideoSequence {
  frames(deltaFrames);
  const next = copy(sequence),
    clips = affected(next, ids);
  let trackDelta = 0;
  if (targetTrackId) {
    if (!ids.length) return next;
    const source = next.tracks.findIndex((t) => t.id === clipById(next, ids[0]).trackId);
    const target = next.tracks.findIndex((t) => t.id === targetTrackId);
    if (target < 0) throw new Error('目标轨道不存在');
    // Offset only the same media-kind tracks; linked audio stays on its original audio track.
    const kind = next.tracks[source].kind;
    const tracks = next.tracks.filter((t) => t.kind === kind);
    trackDelta =
      tracks.findIndex((t) => t.id === targetTrackId) -
      tracks.findIndex((t) => t.id === next.tracks[source].id);
    if (next.tracks[target].kind !== kind) throw new Error('不能跨媒体类型移动轨道');
    for (const clip of clips.filter(
      (c) => next.tracks.find((t) => t.id === c.trackId)!.kind === kind,
    )) {
      const destination = tracks[tracks.findIndex((t) => t.id === clip.trackId) + trackDelta];
      if (!destination) throw new Error('编组超出目标轨道范围');
      clip.trackId = destination.id;
    }
    assertUnlocked(next, clips);
  }
  for (const clip of clips) clip.start += deltaFrames;
  return finish(next);
}

export function trimClip(
  sequence: VideoSequence,
  id: string,
  edge: 'start' | 'end',
  absoluteFrame: number,
  assets?: MediaAsset[],
): VideoSequence {
  frames(absoluteFrame);
  const next = copy(sequence),
    clips = affected(next, [id], false);
  for (const clip of clips) {
    if (edge === 'start') {
      const delta = absoluteFrame - clip.start;
      clip.start = absoluteFrame;
      clip.duration -= delta;
      const asset = assets?.find((a) => a.id === clip.assetId);
      if (!asset || asset.kind === 'video' || asset.kind === 'audio')
        clip.sourceIn += delta / next.fps;
    } else clip.duration = absoluteFrame - clip.start;
    clampFades(clip);
  }
  return validateSequence(next, assets);
}

function splitAt(sequence: VideoSequence, clips: VideoClip[], frame: number) {
  const newLinks = new Map<string, string>(),
    newGroups = new Map<string, string>();
  const newKey = (map: Map<string, string>, old: string, prefix: string) => {
    if (!map.has(old)) map.set(old, uid(prefix));
    return map.get(old)!;
  };
  for (const clip of clips) {
    if (!(clip.start < frame && frame < clip.start + clip.duration)) continue;
    if (
      sequence.transitions.some((t) => {
        if (t.fromClipId === clip.id) return frame > clip.start + clip.duration - t.duration;
        if (t.toClipId === clip.id) return frame < clip.start + t.duration;
        return false;
      })
    )
      throw new Error('不能在叠化区间内分割，请先移除转场');
    const leftDuration = frame - clip.start;
    const right = {
      ...structuredClone(clip),
      id: uid('clip'),
      start: frame,
      duration: clip.duration - leftDuration,
      sourceIn: clip.sourceIn + leftDuration / sequence.fps,
      fadeIn: 0,
    };
    if (right.linkId) right.linkId = newKey(newLinks, right.linkId, 'link');
    if (right.groupId) right.groupId = newKey(newGroups, right.groupId, 'group');
    for (const transition of sequence.transitions)
      if (transition.fromClipId === clip.id) transition.fromClipId = right.id;
    clip.duration = leftDuration;
    clip.fadeOut = 0;
    clampFades(clip);
    clampFades(right);
    sequence.clips.push(right);
  }
}

export function splitClips(sequence: VideoSequence, ids: string[], frame: number): VideoSequence {
  frames(frame);
  const next = copy(sequence),
    clips = affected(next, ids, true);
  splitAt(next, clips, frame);
  return finish(next);
}

function assertSyncClosure(
  sequence: VideoSequence,
  trackIds: Set<string>,
  start: number,
  end = Infinity,
) {
  const touched = sequence.clips.filter(
    (c) => trackIds.has(c.trackId) && c.start + c.duration > start && c.start < end,
  );
  const links = relatedClipIds(
    sequence,
    touched.map((c) => c.id),
    false,
  );
  if (links.some((id) => !trackIds.has(clipById(sequence, id).trackId)))
    throw new Error('同步轨道范围遗漏了关联音视频，请同时选择关联轨道或先解除关联');
  assertUnlocked(sequence, touched);
  return touched;
}

/** Incoming starts are relative to their earliest clip; insertion opens space on sync tracks. */
export function insertClips(
  sequence: VideoSequence,
  incoming: VideoClip[],
  atFrame: number,
  syncTrackIds?: string[],
  incomingTransitions: VideoSequence['transitions'] = [],
): VideoSequence {
  frames(atFrame);
  if (atFrame < 0) throw new Error('插入位置不能为负数');
  if (!incoming.length) return copy(sequence);
  const next = copy(sequence),
    tracks = new Set(syncTrackIds ?? next.tracks.map((t) => t.id));
  const sourceStart = Math.min(...incoming.map((c) => c.start));
  const length = Math.max(...incoming.map((c) => c.start + c.duration)) - sourceStart;
  if (incoming.some((c) => !tracks.has(c.trackId))) throw new Error('插入轨道必须包含在同步范围中');
  const touched = assertSyncClosure(next, tracks, atFrame);
  splitAt(next, touched, atFrame);
  for (const clip of next.clips)
    if (tracks.has(clip.trackId) && clip.start >= atFrame) clip.start += length;
  for (const marker of next.markers) if (marker.frame >= atFrame) marker.frame += length;
  const additions = structuredClone(incoming).map((c) => ({
    ...c,
    start: atFrame + c.start - sourceStart,
  }));
  assertUnlocked(next, additions);
  next.clips.push(...additions);
  next.transitions.push(...structuredClone(incomingTransitions));
  return finish(next);
}

function removeRange(
  sequence: VideoSequence,
  trackIds: Set<string>,
  start: number,
  end: number,
  ripple: boolean,
) {
  const touched = assertSyncClosure(sequence, trackIds, start, ripple ? Infinity : end);
  // Do not silently destroy one side of a crossfade while changing its selected interval.
  const damaged = sequence.transitions.some((t) =>
    [t.fromClipId, t.toClipId].some((id) => {
      const c = clipById(sequence, id);
      return trackIds.has(c.trackId) && c.start < end && c.start + c.duration > start;
    }),
  );
  if (damaged) throw new Error('修改范围含转场，请先移除转场');
  splitAt(sequence, touched, start);
  splitAt(
    sequence,
    sequence.clips.filter(
      (c) => trackIds.has(c.trackId) && c.start < end && c.start + c.duration > end,
    ),
    end,
  );
  sequence.clips = sequence.clips.filter(
    (c) => !(trackIds.has(c.trackId) && c.start >= start && c.start + c.duration <= end),
  );
  if (ripple) {
    for (const clip of sequence.clips)
      if (trackIds.has(clip.trackId) && clip.start >= end) clip.start -= end - start;
    sequence.markers = sequence.markers
      .filter((m) => m.frame < start || m.frame >= end)
      .map((m) => ({ ...m, frame: m.frame >= end ? m.frame - (end - start) : m.frame }));
  }
  cleanTransitions(sequence);
}

export function overwriteClips(
  sequence: VideoSequence,
  incoming: VideoClip[],
  clearTrackIds: string[] = [],
): VideoSequence {
  const next = copy(sequence);
  if (clearTrackIds.some((id) => !next.tracks.some((track) => track.id === id)))
    throw new Error('覆盖清理轨道不存在');
  assertUnlocked(next, incoming);
  // All ranges must be cut together so linked A/V are not temporarily desynchronized.
  const ranges = new Map<string, Set<string>>();
  for (const clip of incoming) {
    const key = `${clip.start}:${clip.start + clip.duration}`;
    if (!ranges.has(key)) ranges.set(key, new Set(clearTrackIds));
    ranges.get(key)!.add(clip.trackId);
  }
  for (const [key, tracks] of ranges) {
    const [start, end] = key.split(':').map(Number);
    removeRange(next, tracks, start, end, false);
  }
  next.clips.push(...structuredClone(incoming));
  return finish(next);
}

export function deleteClips(
  sequence: VideoSequence,
  ids: string[],
  ripple = false,
  syncTrackIds?: string[],
): VideoSequence {
  const next = copy(sequence),
    selected = affected(next, ids);
  if (!ripple) {
    const selectedIds = new Set(selected.map((c) => c.id));
    next.clips = next.clips.filter((c) => !selectedIds.has(c.id));
    cleanTransitions(next);
  } else {
    const tracks = new Set(syncTrackIds ?? next.tracks.map((t) => t.id));
    if (selected.some((c) => !tracks.has(c.trackId))) throw new Error('波纹同步范围遗漏选中轨道');
    const ranges: [number, number][] = [];
    for (const clip of [...selected].sort((a, b) => a.start - b.start)) {
      const last = ranges.at(-1);
      if (last && clip.start <= last[1]) last[1] = Math.max(last[1], clip.start + clip.duration);
      else ranges.push([clip.start, clip.start + clip.duration]);
    }
    for (const [start, end] of ranges.reverse()) removeRange(next, tracks, start, end, true);
  }
  return finish(next);
}

export function duplicateClips(
  sequence: VideoSequence,
  ids: string[],
  atFrame?: number,
): VideoSequence {
  const next = copy(sequence),
    originals = affected(next, ids);
  if (!originals.length) return next;
  const min = Math.min(...originals.map((c) => c.start));
  const at = atFrame ?? Math.max(...originals.map((c) => c.start + c.duration));
  frames(at);
  const mapping = new Map<string, string>();
  const remap = (id: string) => {
    if (!mapping.has(id)) mapping.set(id, uid('copy'));
    return mapping.get(id)!;
  };
  for (const clip of originals)
    next.clips.push({
      ...structuredClone(clip),
      id: remap(clip.id),
      start: at + clip.start - min,
      linkId: clip.linkId ? remap(clip.linkId) : undefined,
      groupId: clip.groupId ? remap(clip.groupId) : undefined,
    });
  for (const t of sequence.transitions)
    if (mapping.has(t.fromClipId) && mapping.has(t.toClipId))
      next.transitions.push({
        ...t,
        id: uid('transition'),
        fromClipId: mapping.get(t.fromClipId)!,
        toClipId: mapping.get(t.toClipId)!,
      });
  return finish(next);
}

export function replaceClipAsset(
  sequence: VideoSequence,
  id: string,
  asset: MediaAsset,
): VideoSequence {
  const next = copy(sequence),
    clips = affected(next, [id], false);
  for (const clip of clips) {
    const track = next.tracks.find((t) => t.id === clip.trackId)!;
    if (track.kind === 'audio' && !(asset.kind === 'audio' || asset.hasAudio))
      throw new Error('替换素材没有关联片段需要的声音');
    if (track.kind === 'video' && asset.kind === 'audio') throw new Error('不能使用声音替换画面');
    if (
      ['video', 'audio'].includes(asset.kind) &&
      (clip.sourceIn >= asset.duration ||
        (!clip.loop && clip.sourceIn + clip.duration / next.fps > asset.duration + 1e-7))
    )
      throw new Error('替换素材过短，请先调整截取范围');
    clip.assetId = asset.id;
    clip.name = asset.name;
  }
  return finish(next);
}

/** Add a cut-overlap transition and ripple all later tracks by exactly its duration. */
export function setTransition(
  sequence: VideoSequence,
  fromId: string,
  toId: string,
  duration: number,
): VideoSequence {
  frames(duration);
  if (duration <= 0) throw new Error('转场必须大于零帧');
  const existing = sequence.transitions.find((t) => t.fromClipId === fromId && t.toClipId === toId);
  const base = existing ? removeTransition(sequence, existing.id) : sequence;
  const next = copy(base),
    from = clipById(next, fromId),
    to = clipById(next, toId);
  assertUnlocked(next, [from, to]);
  if (from.trackId !== to.trackId || from.start + from.duration !== to.start)
    throw new Error('请选择同轨首尾相接的两个片段');
  if (duration >= Math.min(from.duration, to.duration))
    throw new Error('片段过短，转场需短于两侧片段');
  const boundary = to.start;
  const leftEdges = next.clips.filter((c) => c.start + c.duration === boundary);
  const rightEdges = next.clips.filter((c) => c.start === boundary);
  const spanning = next.clips.filter((c) => c.start < boundary && c.start + c.duration > boundary);
  assertUnlocked(next, [...leftEdges, ...rightEdges, ...spanning]);
  // Whole linked/grouped later blocks move together. A long BGM may bridge the cut unchanged.
  const later = next.clips.filter((c) => c.start >= boundary);
  const moving = affected(
    next,
    later.map((c) => c.id),
  );
  if (moving.some((c) => c.start < boundary)) throw new Error('转场边界穿过编组，请先解除编组');
  moving.forEach((c) => {
    c.start -= duration;
  });
  spanning.forEach((c) => {
    c.duration -= duration;
    clampFades(c);
  });
  // Parallel scene layers and linked audio must declare their overlaps as well.
  for (const left of leftEdges) {
    const right = rightEdges.find((c) => c.trackId === left.trackId);
    if (right)
      next.transitions.push({
        id: uid('transition'),
        fromClipId: left.id,
        toClipId: right.id,
        duration,
      });
  }
  next.markers.forEach((m) => {
    if (m.frame >= boundary) m.frame -= duration;
  });
  return finish(next);
}

export function removeTransition(sequence: VideoSequence, id: string): VideoSequence {
  const next = copy(sequence),
    transition = next.transitions.find((t) => t.id === id);
  if (!transition) throw new Error('找不到转场');
  const from = clipById(next, transition.fromClipId),
    to = clipById(next, transition.toClipId);
  assertUnlocked(next, [from, to]);
  const boundary = to.start;
  const spanning = next.clips.filter(
    (c) => c.start < boundary && c.start + c.duration > boundary + transition.duration,
  );
  assertUnlocked(next, spanning);
  next.transitions = next.transitions.filter(
    (t) =>
      !(
        t.duration === transition.duration &&
        clipById(next, t.toClipId).start === boundary &&
        clipById(next, t.fromClipId).start + clipById(next, t.fromClipId).duration ===
          boundary + transition.duration
      ),
  );
  const moving = affected(
    next,
    next.clips.filter((c) => c.start >= boundary).map((c) => c.id),
  );
  if (moving.some((c) => c.start < boundary)) throw new Error('转场边界穿过编组，请先解除编组');
  moving.forEach((c) => {
    c.start += transition.duration;
  });
  spanning.forEach((c) => {
    c.duration += transition.duration;
  });
  next.markers.forEach((m) => {
    if (m.frame >= boundary) m.frame += transition.duration;
  });
  return finish(next);
}

export function updateClips(
  sequence: VideoSequence,
  ids: string[],
  patch: Partial<Pick<VideoClip, 'name' | 'transform' | 'volume' | 'fadeIn' | 'fadeOut' | 'loop'>>,
): VideoSequence {
  const next = copy(sequence);
  const clips = ids.map((id) => clipById(next, id));
  assertUnlocked(next, clips);
  for (const clip of clips) Object.assign(clip, structuredClone(patch));
  return finish(next);
}
export function unlinkClips(sequence: VideoSequence, ids: string[]): VideoSequence {
  const next = copy(sequence);
  affected(next, ids, false).forEach((c) => {
    delete c.linkId;
  });
  return finish(next);
}
export function ungroupClips(sequence: VideoSequence, ids: string[]): VideoSequence {
  const next = copy(sequence);
  affected(next, ids).forEach((c) => {
    delete c.groupId;
  });
  return finish(next);
}
