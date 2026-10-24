export const MIN_FRAME_RATE = 1;
export const MAX_FRAME_RATE = 240;
export const FRAME_RATE_PRESETS = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 100, 120, 144, 240];
export const FRAME_RATE_HINT = '1–240 fps，可输入小数；导出前会检查设备编码能力。';
export type VideoBitrateMode = 'variable' | 'constant';

export function validFrameRate(fps: number): boolean {
  return Number.isFinite(fps) && fps >= MIN_FRAME_RATE && fps <= MAX_FRAME_RATE;
}

/** Conservative upload defaults; platform processing rules can change. */
export function defaultVideoBitrate({ width, height }: { width: number; height: number }): number {
  const pixels = width * height;
  if (pixels <= 1280 * 720) return 3_000_000;
  if (pixels <= 1920 * 1080) return 6_000_000;
  if (pixels <= 3840 * 2160) return 20_000_000;
  return 40_000_000;
}

export const DEFAULT_AUDIO_BITRATE = 192_000;
