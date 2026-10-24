import { validateProject } from './model';
import type { VideoProject } from './types';

export function assetUsage(project: VideoProject, id: string) {
  const sequences = project.sequences.filter((s) => s.clips.some((c) => c.assetId === id));
  const clips = sequences.flatMap((s) => s.clips.filter((c) => c.assetId === id));
  const bindings = Object.values(project.rankingBindings || {})
    .flat()
    .filter((b) => b.assetId === id);
  return {
    sequences: sequences.length,
    clips: clips.length,
    bindings: bindings.length,
    locked: sequences.some((s) =>
      s.clips.some((c) => c.assetId === id && s.tracks.find((t) => t.id === c.trackId)?.locked),
    ),
  };
}

/** Remove project references atomically. Files remain available for undo and other projects. */
export function removeAsset(project: VideoProject, id: string): VideoProject {
  if (!project.assets.some((a) => a.id === id)) throw new Error('请选择要删除的素材');
  if (assetUsage(project, id).locked) throw new Error('素材正在锁定轨道中使用，请先解锁相关轨道');
  const next = structuredClone(project);
  next.assets = next.assets.filter((a) => a.id !== id);
  for (const sequence of next.sequences) {
    const removed = new Set(sequence.clips.filter((c) => c.assetId === id).map((c) => c.id));
    sequence.clips = sequence.clips.filter((c) => !removed.has(c.id));
    sequence.transitions = sequence.transitions.filter(
      (t) => !removed.has(t.fromClipId) && !removed.has(t.toClipId),
    );
    if (sequence.slideshow?.bgmAssetId === id) delete sequence.slideshow.bgmAssetId;
  }
  for (const [key, bindings] of Object.entries(next.rankingBindings || {}))
    next.rankingBindings![key] = bindings.filter((b) => b.assetId !== id);
  return validateProject(next);
}
