import { insertClips, relatedClipIds } from './edit';
import { createTrack, uid, validateSequence } from './model';
import type { MediaAsset, VideoSequence } from './types';

const FORMAT = 'TEditor2/timeline-clips';
export const TIMELINE_CLIPBOARD_MIME = 'application/x-teditor-timeline-clips';

export function copyTimelineClips(
  projectId: string,
  sequence: VideoSequence,
  ids: string[],
): string {
  const selected = new Set(relatedClipIds(sequence, ids));
  if (!selected.size) throw new Error('请先选择要复制的片段');
  const snapshot = validateSequence({
    ...sequence,
    clips: sequence.clips.filter((clip) => selected.has(clip.id)),
    transitions: sequence.transitions.filter(
      (t) => selected.has(t.fromClipId) && selected.has(t.toClipId),
    ),
    markers: [],
    exportSettings: undefined,
    slideshow: undefined,
  });
  return JSON.stringify({ type: FORMAT, version: 1, projectId, sequence: snapshot });
}

/** Insert a detached snapshot, remapping relationships so pasted clips never link back to originals. */
export function pasteTimelineClips(
  projectId: string,
  sequence: VideoSequence,
  assets: MediaAsset[],
  text: string,
  frame: number,
) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (data?.type !== FORMAT) return null;
  if (data.version !== 1) throw new Error('不支持此版本的时间轴剪贴板');
  if (data.projectId !== projectId) throw new Error('请在同一视频工程中粘贴，跨工程素材需要先导入');
  const source = validateSequence(data.sequence, assets);
  if (!source.clips.length) throw new Error('剪贴板中没有片段');
  if (source.fps !== sequence.fps) throw new Error('来源与目标序列帧率不同，请统一帧率后重新复制');
  const next = structuredClone(sequence);
  const trackIds = new Map<string, string>();
  for (const clip of source.clips) {
    if (trackIds.has(clip.trackId)) continue;
    const track = source.tracks.find((t) => t.id === clip.trackId)!;
    let destination = next.tracks.find((t) => t.id === track.id);
    if (!destination) {
      const index = source.tracks
        .filter((t) => t.kind === track.kind)
        .findIndex((t) => t.id === track.id);
      while (next.tracks.filter((t) => t.kind === track.kind).length <= index)
        next.tracks.push(createTrack(track.kind));
      destination = next.tracks.filter((t) => t.kind === track.kind)[index];
    }
    trackIds.set(track.id, destination.id);
  }
  const mapping = new Map<string, string>();
  const remap = (id: string) => {
    if (!mapping.has(id)) mapping.set(id, uid('paste'));
    return mapping.get(id)!;
  };
  const clips = source.clips.map((clip) => ({
    ...clip,
    id: remap(clip.id),
    trackId: trackIds.get(clip.trackId)!,
    linkId: clip.linkId ? remap(clip.linkId) : undefined,
    groupId: clip.groupId ? remap(clip.groupId) : undefined,
  }));
  const transitions = source.transitions.map((t) => ({
    ...t,
    id: uid('transition'),
    fromClipId: remap(t.fromClipId),
    toClipId: remap(t.toClipId),
  }));
  return {
    sequence: validateSequence(insertClips(next, clips, frame, undefined, transitions), assets),
    selectedIds: clips.map((clip) => clip.id),
  };
}
