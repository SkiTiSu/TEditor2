import type { MediaAsset, VideoClip } from './types';

/** A pixel-density envelope over the visible part of a clip, with source trims and loops applied. */
export function waveformEnvelope(
  asset: MediaAsset,
  clip: VideoClip,
  fps: number,
  pixelsPerSecond: number,
  startPixel: number,
  width: number,
): number[] {
  const wave = asset.waveform;
  if (!wave?.length || asset.duration <= 0 || width <= 0) return [];
  const count = Math.min(4096, Math.max(2, Math.ceil(width) + 1));
  const sampleDuration = asset.duration / wave.length;
  const loopDuration = asset.duration - clip.sourceIn;
  const peakAt = (time: number) => {
    if (time < 0 || time >= asset.duration) return 0;
    const index = time / sampleDuration;
    const lo = Math.min(wave.length - 1, Math.floor(index));
    const fraction = index - lo;
    return (
      Math.abs(wave[lo]) * (1 - fraction) +
      Math.abs(wave[Math.min(wave.length - 1, lo + 1)]) * fraction
    );
  };
  return Array.from({ length: count }, (_, i) => {
    const elapsed = (startPixel + (i * width) / (count - 1)) / pixelsPerSecond;
    if (elapsed >= clip.duration / fps) return 0;
    const time = clip.sourceIn + (clip.loop && loopDuration > 0 ? elapsed % loopDuration : elapsed);
    const span = width / (count - 1) / pixelsPerSecond;
    let peak = peakAt(time);
    // Preserve transients when many audio bins fall inside a screen pixel.
    for (
      let bin = Math.ceil(time / sampleDuration);
      bin * sampleDuration < Math.min(asset.duration, time + span);
      bin++
    )
      peak = Math.max(peak, Math.abs(wave[bin] ?? 0));
    return Math.min(1, peak);
  });
}
