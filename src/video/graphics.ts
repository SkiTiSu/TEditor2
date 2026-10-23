import { cleanPath } from '../core/assets';
import { uid } from './model';
import { getMediaFile, putMediaFile } from './storage';
import type { GraphicResource, GraphicSource, VideoProject } from './types';

// File identity, not a filename/size fingerprint, owns a persisted resource. Two files can
// have identical metadata and different pixels; assigning a new id preserves old edits.
const identities = new WeakMap<File, string>();
const pending = new WeakMap<File, Promise<string>>();

function matches(resource: GraphicResource, file: File): boolean {
  return (
    resource.fileName === file.name &&
    resource.size === file.size &&
    resource.lastModified === file.lastModified &&
    resource.mimeType === file.type
  );
}

async function persistedId(file: File): Promise<string> {
  const known = identities.get(file);
  if (known) return known;
  const writing = pending.get(file);
  if (writing) return writing;
  const id = uid('graphic-resource');
  const save = putMediaFile(id, file)
    .then(() => {
      identities.set(file, id);
      return id;
    })
    .finally(() => pending.delete(file));
  pending.set(file, save);
  return save;
}

/** Capture immutable resource references without embedding images in the project JSON.
 * Missing previous resources remain explicit references; selecting another file at the
 * same path replaces only this source's reference, never the previous stored file.
 */
export async function captureGraphicResources(
  files: Map<string, File>,
  previous: GraphicResource[] = [],
): Promise<{ resources: GraphicResource[]; files: Map<string, File> }> {
  const resources = new Map(previous.map((resource) => [resource.path, { ...resource }]));
  const captured = new Map<string, File>();
  const normalized = new Map<string, File>();
  for (const [rawPath, file] of files) {
    const path = cleanPath(rawPath);
    if (!path || !(file instanceof File)) throw new Error('图文资源路径或文件无效');
    if (normalized.has(path) && normalized.get(path) !== file)
      throw new Error(`图文资源路径重复：${path}`);
    normalized.set(path, file);
  }
  for (const [path, file] of normalized) {
    const id = await persistedId(file);
    const old = resources.get(path);
    const fontFamily =
      old?.id === id && old.fontFamily
        ? old.fontFamily
        : /\.(ttf|otf|woff2?)$/i.test(file.name)
          ? file.name.replace(/\.(ttf|otf|woff2?)$/i, '')
          : undefined;
    resources.set(path, {
      id,
      path,
      fileName: file.name,
      size: file.size,
      lastModified: file.lastModified,
      mimeType: file.type,
      ...(fontFamily ? { fontFamily } : {}),
    });
    captured.set(id, file);
  }
  return { resources: [...resources.values()], files: captured };
}

/** Restore available files; missing or changed cache entries remain unresolved. */
export async function restoreGraphicResources(project: VideoProject): Promise<Map<string, File>> {
  const available = new Map<string, File>();
  const resources = new Map(
    project.graphics.flatMap((source) => (source.resources || []).map((r) => [r.id, r] as const)),
  );
  for (const [id, resource] of resources) {
    const file = await getMediaFile(id);
    if (!(file instanceof File) || !matches(resource, file)) continue;
    available.set(id, file);
    identities.set(file, id);
  }
  return available;
}

/** Rebuild a source-local AssetStore map when returning to image design. */
export function graphicFiles(
  source: GraphicSource,
  lookup: (id: string) => File | undefined,
): Map<string, File> {
  const files = new Map<string, File>();
  for (const resource of source.resources || []) {
    const file = lookup(resource.id);
    if (!file || !matches(resource, file)) continue;
    files.set(resource.path, file);
    identities.set(file, resource.id);
  }
  return files;
}
