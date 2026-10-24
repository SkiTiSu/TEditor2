import { sequenceDuration, validateSequence } from './model';
import { validFrameRate } from './settings';
import type { MediaAsset, VideoSequence } from './types';

/** Map shared edit boundaries once so adjacent cuts and transition overlaps stay aligned. */
export function rescaleSequence(
  sequence: VideoSequence,
  assets: MediaAsset[],
  fps: number,
): VideoSequence {
  if (!validFrameRate(fps)) throw new Error('帧率必须是 1～240 之间的有限数值');
  if (fps === sequence.fps) return validateSequence(sequence, assets);
  if (sequence.tracks.some((track) => track.locked)) throw new Error('更改帧率前请解锁轨道');
  const next = structuredClone(sequence);
  const scale = (frame: number) => Math.round((frame * fps) / sequence.fps);
  next.fps = fps;
  for (const clip of next.clips) {
    const end = scale(clip.start + clip.duration);
    clip.start = scale(clip.start);
    clip.duration = end - clip.start;
    if (clip.duration < 1) throw new Error('降低帧率会使部分片段不足一帧，请先延长这些片段');
    clip.fadeIn = Math.min(clip.duration, scale(clip.fadeIn));
    clip.fadeOut = Math.min(clip.duration - clip.fadeIn, scale(clip.fadeOut));
  }
  next.transitions = next.transitions.flatMap((transition) => {
    const from = next.clips.find((clip) => clip.id === transition.fromClipId)!;
    const to = next.clips.find((clip) => clip.id === transition.toClipId)!;
    const duration = from.start + from.duration - to.start;
    return duration > 0 ? [{ ...transition, duration }] : [];
  });
  next.markers = next.markers.map((marker) => ({ ...marker, frame: scale(marker.frame) }));
  if (next.slideshow) {
    const settings = next.slideshow;
    settings.defaultDuration = Math.max(1, scale(settings.defaultDuration));
    settings.transitionDuration = scale(settings.transitionDuration);
    settings.bgmFadeIn = scale(settings.bgmFadeIn);
    settings.bgmFadeOut = scale(settings.bgmFadeOut);
  }
  const duration = sequenceDuration(next);
  if (next.exportSettings && duration) {
    next.exportSettings.startFrame = Math.min(duration - 1, scale(next.exportSettings.startFrame));
    next.exportSettings.endFrame = Math.min(
      duration,
      Math.max(next.exportSettings.startFrame + 1, scale(next.exportSettings.endFrame)),
    );
  } else delete next.exportSettings;
  return validateSequence(next, assets);
}
