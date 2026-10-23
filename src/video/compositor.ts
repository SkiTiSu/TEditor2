import { renderBatchPage } from '../core/batch';
import { AssetStore, cleanPath } from '../core/assets';
import { resolveDocument } from '../core/data';
import type { ImageResolver, TedDocument, TextData } from '../core/types';
import type { VideoSample } from 'mediabunny';
import { checkAbort, MediaLibrary } from './media';
import type { GraphicSource, MediaAsset, VideoClip, VideoProject, VideoSequence } from './types';

export const sequenceDuration = (sequence: VideoSequence) =>
  sequence.clips.reduce((end, clip) => Math.max(end, clip.start + clip.duration), 0);
const clamp = (value: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, value));
export function clipEnvelope(clip: VideoClip, frame: number): number {
  const local = frame - clip.start;
  if (local < 0 || local >= clip.duration) return 0;
  return Math.min(
    1,
    clip.fadeIn > 0 ? local / clip.fadeIn : 1,
    clip.fadeOut > 0 ? (clip.duration - local) / clip.fadeOut : 1,
  );
}
export function transitionEnvelope(
  sequence: VideoSequence,
  clip: VideoClip,
  frame: number,
): number {
  let gain = 1;
  for (const transition of sequence.transitions) {
    if (transition.fromClipId !== clip.id && transition.toClipId !== clip.id) continue;
    const to = sequence.clips.find((item) => item.id === transition.toClipId);
    if (
      !to ||
      transition.duration <= 0 ||
      frame < to.start ||
      frame >= to.start + transition.duration
    )
      continue;
    const progress = (frame - to.start) / transition.duration;
    gain *= transition.fromClipId === clip.id ? 1 - progress : progress;
  }
  return gain;
}
export function clipSourceTime(
  asset: MediaAsset,
  clip: VideoClip,
  frame: number,
  fps: number,
): number {
  const offset = Math.max(0, (frame - clip.start) / fps);
  const available = Math.max(0, asset.duration - clip.sourceIn);
  return clip.sourceIn + (clip.loop && available > 0 ? offset % available : offset);
}

type Visual = {
  source: CanvasImageSource | VideoSample;
  width: number;
  height: number;
  video?: boolean;
};
type CachedGraphic = { canvas: HTMLCanvasElement; warnings: string[] };
export interface RenderOptions {
  signal?: AbortSignal;
  strict?: boolean;
}
export interface RenderFeedback {
  warnings: string[];
}

type GraphicResources = {
  signature: string;
  mediaRevision: number;
  sourceRevision: number;
  store: AssetStore;
  fonts: FontFace[];
  missingFonts: Map<string, string>;
  document: TedDocument;
  ready: Promise<void>;
};
const resourceFileIds = new WeakMap<File, number>();
let nextResourceFileId = 0;
function resourceFileId(file?: File): number {
  if (!file) return 0;
  let id = resourceFileIds.get(file);
  if (!id) {
    id = ++nextResourceFileId;
    resourceFileIds.set(file, id);
  }
  return id;
}

/** Shared frame evaluation and PCM mixing for both the program monitor and offline export. */
export class SequenceRenderer {
  private graphics = new Map<string, CachedGraphic>();
  private sourceIdentities = new WeakMap<object, number>();
  private nextSourceIdentity = 0;
  private resourceContexts = new Map<number, GraphicResources>();
  private trackCanvas = document.createElement('canvas');
  private frameCanvas = document.createElement('canvas');
  private renderQueue: Promise<unknown> = Promise.resolve();
  private audioQueue: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(
    public readonly media: MediaLibrary,
    private readonly resolveImage: ImageResolver,
  ) {}
  fork(): SequenceRenderer {
    return new SequenceRenderer(this.media.fork(), this.resolveImage);
  }
  invalidate(): void {
    for (const entry of this.graphics.values()) entry.canvas.width = entry.canvas.height = 1;
    this.graphics.clear();
    for (const context of this.resourceContexts.values()) this.releaseResources(context);
    this.resourceContexts.clear();
  }
  private releaseResources(context: GraphicResources) {
    context.store.clear();
    for (const face of context.fonts) document.fonts.delete(face);
    context.fonts.length = 0;
  }
  private async resources(
    source: GraphicSource,
    identity: number,
  ): Promise<GraphicResources | undefined> {
    if (source.resources === undefined) return undefined;
    let context = this.resourceContexts.get(identity);
    if (
      context &&
      context.mediaRevision === this.media.revision &&
      context.sourceRevision === source.revision
    ) {
      this.resourceContexts.delete(identity);
      this.resourceContexts.set(identity, context);
      await context.ready;
      return context;
    }
    const files = source.resources.map((resource) => ({
      resource,
      file: this.media.getFile(resource.id),
    }));
    const signature = JSON.stringify(
      files.map(({ resource, file }) => [
        resource.id,
        resource.path,
        resource.fontFamily,
        resourceFileId(file),
      ]),
    );
    if (context?.signature === signature && context.sourceRevision === source.revision) {
      context.mediaRevision = this.media.revision;
      context.sourceRevision = source.revision;
      await context.ready;
      return context;
    }
    if (context) this.releaseResources(context);
    const store = new AssetStore();
    const renderDocument = structuredClone(source.document);
    const usedFamilies = new Set(
      renderDocument.Layers.filter((layer) => layer.Key === 'Text').map(
        (layer) => (layer.Data as TextData).FontFamilyName,
      ),
    );
    context = {
      signature,
      mediaRevision: this.media.revision,
      sourceRevision: source.revision,
      store,
      fonts: [],
      missingFonts: new Map(),
      document: renderDocument,
      ready: Promise.resolve(),
    };
    const current = context;
    this.resourceContexts.set(identity, current);
    current.ready = (async () => {
      for (const { resource, file } of files) {
        if (!resource.fontFamily) {
          if (file) store.files.set(cleanPath(resource.path), file);
          continue;
        }
        if (!usedFamilies.has(resource.fontFamily)) continue;
        if (!file) {
          current.missingFonts.set(resource.fontFamily, `字体未关联：${resource.fileName}`);
          continue;
        }
        try {
          const alias = `tevideo-font-${resource.id.replace(/[^a-zA-Z0-9_-]/g, '_')}-${resourceFileId(file)}`;
          const face = new FontFace(alias, await file.arrayBuffer());
          await face.load();
          if (this.closed || this.resourceContexts.get(identity) !== current) continue;
          document.fonts.add(face);
          current.fonts.push(face);
          for (const layer of renderDocument.Layers)
            if (
              layer.Key === 'Text' &&
              (layer.Data as TextData).FontFamilyName === resource.fontFamily
            )
              (layer.Data as TextData).FontFamilyName = alias;
        } catch {
          current.missingFonts.set(resource.fontFamily, `字体无法读取：${resource.fileName}`);
        }
      }
    })();
    await current.ready;
    while (this.resourceContexts.size > 6) {
      const oldest = this.resourceContexts.keys().next().value!;
      this.releaseResources(this.resourceContexts.get(oldest)!);
      this.resourceContexts.delete(oldest);
    }
    return current;
  }
  private async graphic(
    asset: MediaAsset,
    project: VideoProject,
    sequence: VideoSequence,
  ): Promise<CachedGraphic> {
    let key: string;
    const linked =
      asset.graphic && project.graphics.find((source) => source.id === asset.graphic!.sourceId);
    if (asset.kind === 'graphic' && !linked) throw new Error(`“${asset.name}”的关联图片方案缺失。`);
    if (linked && !this.sourceIdentities.has(linked))
      this.sourceIdentities.set(linked, ++this.nextSourceIdentity);
    const resources = linked
      ? await this.resources(linked, this.sourceIdentities.get(linked)!)
      : undefined;
    key = linked
      ? `${asset.id}:${linked.revision}:${this.sourceIdentities.get(linked)}:${resources?.signature ?? 'legacy'}:${asset.graphic!.rowIds.join(',')}`
      : `${asset.id}:${asset.text}:${asset.color}:${asset.fontFamily}:${asset.fontSize}:${asset.width}:${asset.height}:${sequence.width}:${sequence.height}`;
    const cached = this.graphics.get(key);
    if (cached) {
      this.graphics.delete(key);
      this.graphics.set(key, cached);
      return cached;
    }
    const canvas = document.createElement('canvas');
    let warnings: string[] = [];
    if (linked) {
      const rows = asset.graphic!.rowIds.map((id) => linked.rowIds.indexOf(id));
      if (rows.some((index) => index < 0))
        throw new Error(`“${asset.name}”关联的数据行已删除，请重新绑定。`);
      const result = await renderBatchPage(
        canvas,
        resources?.document ?? linked.document,
        linked.table,
        rows.length ? rows : [0],
        linked.layout.deltaX,
        linked.layout.deltaY,
        resources?.store.resolve ?? this.resolveImage,
      );
      warnings = result.warnings;
      if (resources?.missingFonts.size) {
        const used = new Set<string>();
        for (const row of rows.length ? rows : [0]) {
          const resolved = resolveDocument(linked.document, linked.table.rows[row]).document;
          for (const layer of resolved.Layers)
            if (layer.Key === 'Text' && layer.Visible)
              used.add((layer.Data as TextData).FontFamilyName);
        }
        for (const [family, warning] of resources.missingFonts)
          if (used.has(family)) warnings.push(warning);
      }
    } else {
      canvas.width = asset.width || sequence.width;
      canvas.height = asset.height || sequence.height;
      const ctx = canvas.getContext('2d')!;
      if (asset.kind === 'color') {
        ctx.fillStyle = asset.color || '#202735';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      } else {
        const fontSize = asset.fontSize || 80;
        const family = asset.fontFamily || 'sans-serif';
        const font = `${fontSize}px ${JSON.stringify(family)}, sans-serif`;
        if (document.fonts) await document.fonts.load(font, asset.text || 'Ag国');
        ctx.font = font;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = asset.color || '#ffffff';
        const lines = (asset.text || '').split('\n');
        lines.forEach((line, index) =>
          ctx.fillText(
            line,
            canvas.width / 2,
            canvas.height / 2 + (index - (lines.length - 1) / 2) * fontSize * 1.2,
            canvas.width,
          ),
        );
      }
    }
    if (this.closed) {
      canvas.width = canvas.height = 1;
      throw new Error('画面渲染器已关闭。');
    }
    const result = { canvas, warnings };
    this.graphics.set(key, result);
    // Bound retained static pixels to roughly 48 MiB, while always retaining the latest page.
    let pixels = [...this.graphics.values()].reduce(
      (n, item) => n + item.canvas.width * item.canvas.height,
      0,
    );
    while (this.graphics.size > 1 && (pixels > 12_000_000 || this.graphics.size > 16)) {
      const oldest = this.graphics.keys().next().value!;
      const entry = this.graphics.get(oldest)!;
      pixels -= entry.canvas.width * entry.canvas.height;
      entry.canvas.width = entry.canvas.height = 1;
      this.graphics.delete(oldest);
    }
    return result;
  }
  /** Resolve static pictures and fonts before an export opens its destination. */
  async prepareAsset(
    asset: MediaAsset,
    project: VideoProject,
    sequence: VideoSequence,
    signal?: AbortSignal,
  ): Promise<string[]> {
    checkAbort(signal);
    if (asset.kind === 'image') {
      await this.media.image(asset.id, signal);
      return [];
    }
    if (!['graphic', 'text', 'color'].includes(asset.kind)) return [];
    const result = await this.graphic(asset, project, sequence);
    checkAbort(signal);
    return result.warnings;
  }
  private async visual(
    asset: MediaAsset,
    clip: VideoClip,
    frame: number,
    project: VideoProject,
    sequence: VideoSequence,
    warnings: Set<string>,
    signal?: AbortSignal,
  ): Promise<Visual | null> {
    if (asset.kind === 'video') {
      const sample = await this.media.videoFrame(
        asset.id,
        clipSourceTime(asset, clip, frame, sequence.fps),
        clip.id,
        signal,
      );
      return sample
        ? { source: sample, width: sample.displayWidth, height: sample.displayHeight, video: true }
        : null;
    }
    if (asset.kind === 'image') {
      const image = await this.media.image(asset.id, signal);
      return { source: image, width: image.width, height: image.height };
    }
    if (asset.kind === 'audio') return null;
    const result = await this.graphic(asset, project, sequence);
    result.warnings.forEach((warning) => warnings.add(warning));
    return { source: result.canvas, width: result.canvas.width, height: result.canvas.height };
  }
  private draw(ctx: CanvasRenderingContext2D, visual: Visual, clip: VideoClip, gain: number): void {
    const t = clip.transform;
    if (gain <= 0 || t.width <= 0 || t.height <= 0) return;
    const crop = t.crop;
    const sx = visual.width * clamp(crop.left),
      sy = visual.height * clamp(crop.top);
    let sw = visual.width * Math.max(0, 1 - clamp(crop.left) - clamp(crop.right));
    let sh = visual.height * Math.max(0, 1 - clamp(crop.top) - clamp(crop.bottom));
    if (sw <= 0 || sh <= 0) return;
    const scale =
      t.fit === 'cover'
        ? Math.max(t.width / sw, t.height / sh)
        : Math.min(t.width / sw, t.height / sh);
    const dw = sw * scale,
      dh = sh * scale;
    ctx.save();
    ctx.translate(t.x + t.width / 2, t.y + t.height / 2);
    ctx.rotate((t.rotation * Math.PI) / 180);
    ctx.beginPath();
    ctx.rect(-t.width / 2, -t.height / 2, t.width, t.height);
    ctx.clip();
    ctx.globalAlpha = clamp(t.opacity) * clamp(gain);
    if (visual.video)
      (visual.source as VideoSample).draw(ctx, sx, sy, sw, sh, -dw / 2, -dh / 2, dw, dh);
    else
      ctx.drawImage(visual.source as CanvasImageSource, sx, sy, sw, sh, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  }
  render(
    canvas: HTMLCanvasElement,
    project: VideoProject,
    sequence: VideoSequence,
    frame: number,
    options: RenderOptions = {},
  ): Promise<RenderFeedback> {
    const job = this.renderQueue
      .catch(() => undefined)
      .then(() => this.renderFrame(canvas, project, sequence, frame, options));
    this.renderQueue = job;
    return job;
  }
  private async renderFrame(
    canvas: HTMLCanvasElement,
    project: VideoProject,
    sequence: VideoSequence,
    frame: number,
    { signal, strict = false }: RenderOptions,
  ): Promise<RenderFeedback> {
    checkAbort(signal);
    if (this.closed) throw new Error('画面渲染器已关闭。');
    const warnings = new Set<string>();
    for (const surface of [this.frameCanvas, this.trackCanvas]) {
      if (surface.width !== sequence.width) surface.width = sequence.width;
      if (surface.height !== sequence.height) surface.height = sequence.height;
    }
    const ctx = this.frameCanvas.getContext('2d')!;
    ctx.clearRect(0, 0, sequence.width, sequence.height);
    ctx.fillStyle = sequence.background || '#000000';
    ctx.fillRect(0, 0, sequence.width, sequence.height);
    const trackCtx = this.trackCanvas.getContext('2d')!;
    const activeVideoKeys = new Set<string>();
    for (const track of [...sequence.tracks].reverse()) {
      if (track.kind !== 'video' || track.hidden) continue;
      const active = sequence.clips
        .filter(
          (clip) =>
            clip.trackId === track.id && frame >= clip.start && frame < clip.start + clip.duration,
        )
        .sort((a, b) => a.start - b.start);
      trackCtx.clearRect(0, 0, sequence.width, sequence.height);
      trackCtx.globalCompositeOperation = 'source-over';
      const transition = sequence.transitions.find(
        (item) =>
          active.some((c) => c.id === item.fromClipId) &&
          active.some((c) => c.id === item.toClipId),
      );
      // Add premultiplied weighted images on an isolated track to avoid the dark midpoint of two source-over fades.
      if (transition) trackCtx.globalCompositeOperation = 'lighter';
      for (const clip of active) {
        const asset = project.assets.find((item) => item.id === clip.assetId);
        try {
          if (!asset) throw new Error(`片段“${clip.name}”的素材已丢失。`);
          if (asset.kind === 'video') activeVideoKeys.add(clip.id);
          const visual = await this.visual(asset, clip, frame, project, sequence, warnings, signal);
          checkAbort(signal);
          if (visual)
            this.draw(
              trackCtx,
              visual,
              clip,
              clipEnvelope(clip, frame) * transitionEnvelope(sequence, clip, frame),
            );
        } catch (error) {
          if (signal?.aborted || strict) throw error;
          warnings.add(error instanceof Error ? error.message : String(error));
        }
      }
      ctx.drawImage(this.trackCanvas, 0, 0);
    }
    this.media.retainStreams(activeVideoKeys);
    checkAbort(signal);
    if (strict && warnings.size) throw new Error([...warnings].join('\n'));
    if (canvas.width !== sequence.width) canvas.width = sequence.width;
    if (canvas.height !== sequence.height) canvas.height = sequence.height;
    const target = canvas.getContext('2d')!;
    target.clearRect(0, 0, canvas.width, canvas.height);
    target.drawImage(this.frameCanvas, 0, 0);
    return { warnings: [...warnings] };
  }
  mixAudio(
    project: VideoProject,
    sequence: VideoSequence,
    startSeconds: number,
    durationSeconds: number,
    sampleRate = 48000,
    signal?: AbortSignal,
  ): Promise<AudioBuffer> {
    const job = this.audioQueue
      .catch(() => undefined)
      .then(() =>
        this.mixAudioBlock(project, sequence, startSeconds, durationSeconds, sampleRate, signal),
      );
    this.audioQueue = job;
    return job;
  }
  private async mixAudioBlock(
    project: VideoProject,
    sequence: VideoSequence,
    startSeconds: number,
    durationSeconds: number,
    sampleRate: number,
    signal?: AbortSignal,
  ): Promise<AudioBuffer> {
    checkAbort(signal);
    if (this.closed) throw new Error('音频渲染器已关闭。');
    if (!(durationSeconds > 0 && durationSeconds <= 2))
      throw new Error('音频必须按不超过 2 秒的小块处理。');
    const length = Math.max(1, Math.round(durationSeconds * sampleRate));
    const output = new AudioBuffer({ length, numberOfChannels: 2, sampleRate });
    const channels = [output.getChannelData(0), output.getChannelData(1)];
    const endSeconds = startSeconds + length / sampleRate;
    const audioTracks = sequence.tracks.filter((track) => track.kind === 'audio');
    const anySolo = audioTracks.some((track) => track.solo);
    for (const track of audioTracks) {
      if (track.muted || (anySolo && !track.solo)) continue;
      for (const clip of sequence.clips) {
        if (clip.trackId !== track.id) continue;
        const clipStart = clip.start / sequence.fps,
          clipEnd = (clip.start + clip.duration) / sequence.fps;
        const from = Math.max(startSeconds, clipStart),
          to = Math.min(endSeconds, clipEnd);
        if (to <= from || clip.volume <= 0 || track.volume <= 0) continue;
        const asset = project.assets.find((item) => item.id === clip.assetId);
        if (!asset?.hasAudio) continue;
        const available = asset.duration - clip.sourceIn;
        if (available <= 0) continue;
        // Split looping sources at the exact source boundary; never duplicate/skip a destination PCM sample.
        let segment = from;
        while (segment < to - 1e-10) {
          checkAbort(signal);
          const offset = segment - clipStart;
          let local = clip.loop ? ((offset % available) + available) % available : offset;
          if (clip.loop && (local < 1e-9 || available - local < 1e-9)) local = 0;
          if (!clip.loop && local >= available - 1e-10) break;
          const segmentEnd = Math.min(to, segment + available - local);
          if (segmentEnd <= segment + 1e-10) break;
          const sourceStart = clip.sourceIn + local,
            sourceEnd = sourceStart + segmentEnd - segment;
          for await (const part of this.media.audioBuffers(
            asset.id,
            sourceStart,
            sourceEnd,
            `audio:${clip.id}`,
            signal,
          )) {
            const first = Math.max(
              0,
              Math.ceil((segment - startSeconds) * sampleRate - 1e-7),
              Math.ceil(
                (segment + part.timestamp - sourceStart - startSeconds) * sampleRate - 1e-7,
              ),
            );
            const last = Math.min(
              length,
              Math.ceil((segmentEnd - startSeconds) * sampleRate - 1e-7),
              Math.ceil(
                (segment + part.timestamp + part.duration - sourceStart - startSeconds) *
                  sampleRate -
                  1e-7,
              ),
            );
            const source = Array.from(
              { length: Math.min(2, part.buffer.numberOfChannels) },
              (_, channel) => part.buffer.getChannelData(channel),
            );
            for (let index = first; index < last; index++) {
              const time = startSeconds + index / sampleRate;
              const position =
                (sourceStart + time - segment - part.timestamp) * part.buffer.sampleRate;
              const left = Math.max(0, Math.min(part.buffer.length - 1, Math.floor(position)));
              const right = Math.min(part.buffer.length - 1, left + 1),
                fraction = clamp(position - left);
              const frame = time * sequence.fps;
              const gain =
                clip.volume *
                track.volume *
                clipEnvelope(clip, frame) *
                transitionEnvelope(sequence, clip, frame);
              for (let channel = 0; channel < 2; channel++) {
                const samples = source[Math.min(channel, source.length - 1)];
                channels[channel][index] +=
                  (samples[left] * (1 - fraction) + samples[right] * fraction) * gain;
              }
            }
          }
          segment = segmentEnd;
        }
      }
    }
    for (const channel of channels)
      for (let index = 0; index < channel.length; index++)
        channel[index] = clamp(channel[index], -1, 1);
    checkAbort(signal);
    return output;
  }
  get diagnostics() {
    return { ...this.media.diagnostics, graphicPages: this.graphics.size };
  }
  dispose(): void {
    this.closed = true;
    this.invalidate();
    this.media.dispose();
    this.trackCanvas.width =
      this.trackCanvas.height =
      this.frameCanvas.width =
      this.frameCanvas.height =
        1;
  }
}
