import { resolveDocument } from './data';
import { renderComposite } from './render';
import type { ImageResolver, RenderResult, TableData, TedDocument } from './types';

/** Preview and PNG export share row resolution, conditions, masks and page clipping. */
export async function renderBatchPage(
  canvas: HTMLCanvasElement,
  document: TedDocument,
  table: TableData,
  indices: number[],
  deltaX: number,
  deltaY: number,
  resolveImage: ImageResolver,
): Promise<RenderResult> {
  const warnings = new Set<string>();
  const documents = indices.map((index) => {
    const result = resolveDocument(document, table.rows.length ? table.rows[index] : undefined);
    result.warnings.forEach((warning) => warnings.add(warning));
    return result.document;
  });
  const result = await renderComposite(canvas, documents, deltaX, deltaY, resolveImage);
  result.warnings.forEach((warning) => warnings.add(warning));
  return { bounds: result.bounds, warnings: [...warnings] };
}
