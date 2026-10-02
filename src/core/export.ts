import { zipSync } from 'fflate';
import type { TedDocument, TableData, ImageResolver } from './types';
import { planBatch, filenameForBatch } from './data';
import { renderBatchPage } from './batch';
export interface ExportOptions {
  start: number;
  end: number;
  repeats: number;
  deltaX: number;
  deltaY: number;
  filename: string;
  directory?: FileSystemDirectoryHandle;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  onArchive?: (blob: Blob, name: string) => void | Promise<void>;
}
export interface ExportReport {
  completed: number;
  total: number;
  warnings: string[];
  cancelled: boolean;
}
export function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG 编码失败'))), 'image/png'),
  );
}
async function unusedName(directory: FileSystemDirectoryHandle, name: string): Promise<string> {
  let candidate = name;
  for (let i = 2; i < 10000; i++) {
    try {
      await directory.getFileHandle(candidate);
      candidate = name.replace(/\.png$/i, ` (${i}).png`);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'NotFoundError') return candidate;
      throw e;
    }
  }
  throw new Error('同名文件过多，请更换输出目录');
}
export async function runExport(
  doc: TedDocument,
  table: TableData,
  resolveImage: ImageResolver,
  options: ExportOptions,
): Promise<ExportReport> {
  const rows = table.rows.length ? table.rows : [{}];
  const plans = planBatch(rows.length, options.start, options.end, options.repeats);
  const canvas = document.createElement('canvas');
  const warnings = new Set<string>();
  let completed = 0,
    part = 1;
  let zipFiles: Record<string, Uint8Array> = {};
  let zipBytes = 0;
  const names = new Set<string>();
  async function flush() {
    if (!Object.keys(zipFiles).length) return;
    const bytes = zipSync(zipFiles, { level: 0 });
    await options.onArchive?.(
      new Blob([bytes as BlobPart], { type: 'application/zip' }),
      `TEditor_${String(part++).padStart(2, '0')}.zip`,
    );
    zipFiles = {};
    zipBytes = 0;
  }
  try {
    for (const plan of plans) {
      if (options.signal?.aborted) break;
      const result = await renderBatchPage(
        canvas,
        doc,
        table,
        plan.indices,
        options.deltaX,
        options.deltaY,
        resolveImage,
      );
      result.warnings.forEach((w) => warnings.add(w));
      if (options.signal?.aborted) break;
      const blob = await canvasBlob(canvas);
      let name = filenameForBatch(options.filename, rows, plan.indices);
      if (!name.toLowerCase().endsWith('.png')) name += '.png';
      const original = name;
      let suffix = 2;
      while (names.has(name.toLocaleLowerCase()))
        name = original.replace(/\.png$/i, ` (${suffix++}).png`);
      names.add(name.toLocaleLowerCase());
      if (options.directory) {
        name = await unusedName(options.directory, name);
        const h = await options.directory.getFileHandle(name, { create: true });
        const writer = await h.createWritable();
        try {
          await writer.write(blob);
          await writer.close();
        } catch (error) {
          await writer.abort().catch(() => {});
          throw error;
        }
      } else {
        zipFiles[name] = new Uint8Array(await blob.arrayBuffer());
        zipBytes += blob.size;
        if (Object.keys(zipFiles).length >= 50 || zipBytes >= 64 * 1024 * 1024) await flush();
      }
      completed++;
      options.onProgress?.(completed, plans.length);
      await new Promise<void>((r) => setTimeout(r, 0));
    }
    await flush();
    return {
      completed,
      total: plans.length,
      warnings: [...warnings],
      cancelled: !!options.signal?.aborted,
    };
  } finally {
    canvas.width = 1;
    canvas.height = 1;
  }
}
