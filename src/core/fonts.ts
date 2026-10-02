export const DEFAULT_FONTS = [
  'sans-serif',
  'Arial',
  'Microsoft YaHei',
  'PingFang SC',
  'SimSun',
  'Georgia',
  'monospace',
];
const FONT_CACHE = 'teditor.local-font-families';

export function fontFamilies(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
}

export function initialFonts(): string[] {
  try {
    const cached: unknown = JSON.parse(localStorage.getItem(FONT_CACHE) || '[]');
    if (Array.isArray(cached) && cached.every((value) => typeof value === 'string')) {
      return fontFamilies([...DEFAULT_FONTS, ...cached]);
    }
  } catch {
    /* Font discovery still works when local storage is unavailable. */
  }
  return [...DEFAULT_FONTS];
}

export function cacheLocalFonts(families: string[]): void {
  try {
    localStorage.setItem(FONT_CACHE, JSON.stringify(families));
  } catch {
    /* Keep the current session usable. */
  }
}
