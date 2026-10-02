import type { ImageResolver } from './types';
export const cleanPath = (s: string) =>
  s
    .replace(/\\/g, '/')
    .replace(/^file:\/\//i, '')
    .replace(/^[a-z]:\//i, '')
    .replace(/^\/+/, '');
export async function fileDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('无法读取文件'));
    r.readAsDataURL(file);
  });
}
export class AssetStore {
  files = new Map<string, File>();
  private generation = 0;
  private cache = new Map<string, { image: HTMLImageElement; url?: string }>();
  add(files: File[]) {
    for (const f of files) this.files.set(cleanPath(f.webkitRelativePath || f.name), f);
    this.clearCache();
  }
  clearCache() {
    this.generation++;
    for (const v of this.cache.values()) if (v.url) URL.revokeObjectURL(v.url);
    this.cache.clear();
  }
  clear() {
    this.clearCache();
    this.files.clear();
  }
  find(source: string): File | undefined {
    const path = cleanPath(source);
    if (this.files.has(path)) return this.files.get(path);
    let matches = [...this.files].filter(
      ([key]) => key.endsWith('/' + path) || path.endsWith('/' + key),
    );
    if (matches.length === 1) return matches[0][1];
    const lower = path.toLowerCase();
    matches = [...this.files].filter(([key]) => {
      const k = key.toLowerCase();
      return k === lower || k.endsWith('/' + lower) || lower.endsWith('/' + k);
    });
    if (matches.length === 1) return matches[0][1];
    if (matches.length > 1) throw new Error(`素材路径存在大小写冲突：${source}`);
    const basename = path.split('/').pop()?.toLowerCase();
    matches = [...this.files].filter(([key]) => key.split('/').pop()?.toLowerCase() === basename);
    if (matches.length === 1) return matches[0][1];
    if (matches.length > 1) throw new Error(`素材重名，需使用相对路径：${source}`);
  }
  resolve: ImageResolver = async (source, embedded) => {
    const generation = this.generation;
    const key = embedded || source;
    if (!key) return null;
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit.image;
    }
    let url: string | undefined;
    let src = embedded;
    if (src && !src.startsWith('data:')) src = 'data:image/png;base64,' + src;
    if (!src) {
      if (source.startsWith('data:image/')) src = source;
      else {
        const file = this.find(source);
        if (!file) return null;
        url = URL.createObjectURL(file);
        src = url;
      }
    }
    const img = new Image();
    img.decoding = 'async';
    img.src = src;
    try {
      await img.decode();
    } catch {
      if (/\.tiff?$/i.test(source) || /^data:image\/(tiff|x-tiff)/i.test(src)) {
        try {
          const utif = await import('utif2');
          const bytes = await (await fetch(src)).arrayBuffer();
          const frame = utif.decode(bytes)[0];
          if (!frame) throw new Error('TIFF 没有图像');
          const fw = Number(Array.isArray(frame.t256) ? frame.t256[0] : frame.width),
            fh = Number(Array.isArray(frame.t257) ? frame.t257[0] : frame.height);
          if (!Number.isFinite(fw * fh) || fw < 1 || fh < 1 || fw * fh > 64000000)
            throw new Error('TIFF 图片尺寸无效或过大');
          utif.decodeImage(bytes, frame);
          if (frame.width * frame.height > 64000000) throw new Error('TIFF 图片过大');
          const c = document.createElement('canvas');
          c.width = frame.width;
          c.height = frame.height;
          c.getContext('2d')!.putImageData(
            new ImageData(new Uint8ClampedArray(utif.toRGBA8(frame)), frame.width, frame.height),
            0,
            0,
          );
          img.src = c.toDataURL('image/png');
          await img.decode();
          c.width = 1;
        } catch {
          if (url) URL.revokeObjectURL(url);
          return null;
        }
      } else {
        if (url) URL.revokeObjectURL(url);
        return null;
      }
    }
    if (generation !== this.generation) {
      if (url) URL.revokeObjectURL(url);
      return img;
    }
    this.cache.set(key, { image: img, url });
    while (this.cache.size > 24) {
      const oldest = this.cache.keys().next().value!;
      const item = this.cache.get(oldest)!;
      if (item.url) URL.revokeObjectURL(item.url);
      this.cache.delete(oldest);
    }
    return img;
  };
}
export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export async function decodeTextFile(file: File): Promise<string> {
  const bytes = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('gb18030').decode(bytes);
  }
}
