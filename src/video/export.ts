import {
  EncodedAudioPacketSource,
  EncodedPacket,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  Quality,
  StreamTarget,
  canEncodeAudio,
  canEncodeVideo,
  type StreamTargetChunk,
} from 'mediabunny';
import { SequenceRenderer, sequenceDuration } from './compositor';
import { checkAbort, isFileAsset } from './media';
import type { VideoProject, VideoSequence } from './types';

export interface ExportProgress {
  completed: number;
  total: number;
  ratio: number;
  phase: 'checking' | 'rendering' | 'finalizing' | 'complete';
  bytes: number;
}
export interface VideoExportOptions {
  startFrame?: number;
  endFrame?: number;
  signal?: AbortSignal;
  onProgress?: (progress: ExportProgress) => void;
  fileHandle?: FileSystemFileHandle;
  videoBitrate?: number;
  audioBitrate?: number;
}
export interface VideoExportResult {
  file: File;
  frames: number;
  duration: number;
  elapsedMs: number;
  bytes: number;
  cleanup: () => Promise<void>;
}
export interface ExportCapabilities {
  supported: boolean;
  video: boolean;
  audio: boolean;
  streaming: boolean;
  errors: string[];
}
const DEFAULT_VIDEO_BITRATE = 16_000_000;
const DEFAULT_AUDIO_BITRATE = 192_000;

// WebCodecs does not expose AAC encoder priming. Some platform encoders add more than 60 ms.
// Calibrate with two impulses once per encoder configuration, then express priming in MP4's edit list.
const aacDelayCache = new Map<number, Promise<number>>();
async function measureAacDelay(bitrate: number): Promise<number> {
  let cached = aacDelayCache.get(bitrate);
  if (cached) return cached;
  cached = (async () => {
    const packets: EncodedAudioChunk[] = [];
    let config: AudioDecoderConfig | undefined, failure: DOMException | undefined;
    const encoder = new AudioEncoder({
      output(chunk, meta) {
        packets.push(chunk);
        config ??= meta?.decoderConfig;
      },
      error(error) {
        failure = error;
      },
    });
    const sampleRate = 48000,
      length = 12288,
      values = new Float32Array(length * 2);
    values[4096] = values[4096 + length] = 0.8;
    values[8192] = values[8192 + length] = -0.6;
    try {
      encoder.configure({ codec: 'mp4a.40.2', sampleRate, numberOfChannels: 2, bitrate });
      const sample = new AudioData({
        data: values,
        format: 'f32-planar',
        numberOfChannels: 2,
        sampleRate,
        numberOfFrames: length,
        timestamp: 0,
      });
      encoder.encode(sample);
      sample.close();
      await encoder.flush();
      if (failure) throw failure;
    } finally {
      if (encoder.state !== 'closed') encoder.close();
    }
    if (!config) throw new Error('AAC 编码器未返回解码配置。');
    const decoded = new Float32Array(length + 8192);
    const decoder = new AudioDecoder({
      output(sample) {
        try {
          const data = new Float32Array(sample.numberOfFrames);
          sample.copyTo(data, { planeIndex: 0, format: 'f32-planar' });
          const start = Math.round((sample.timestamp * sampleRate) / 1e6);
          for (let i = 0; i < data.length; i++)
            if (start + i >= 0 && start + i < decoded.length) decoded[start + i] = data[i];
        } finally {
          sample.close();
        }
      },
      error(error) {
        failure = error;
      },
    });
    try {
      decoder.configure(config);
      packets.forEach((packet) => decoder.decode(packet));
      await decoder.flush();
      if (failure) throw failure;
    } finally {
      if (decoder.state !== 'closed') decoder.close();
    }
    const delays = [4096, 8192].map((position) => {
      let peak = position;
      for (let i = position; i < position + 4096; i++)
        if (Math.abs(decoded[i]) > Math.abs(decoded[peak])) peak = i;
      if (Math.abs(decoded[peak]) < 0.05)
        throw new Error('无法验证 AAC 编码器的音画同步，请更换浏览器后重试。');
      return peak - position;
    });
    if (Math.abs(delays[0] - delays[1]) > 4)
      throw new Error('AAC 编码器时序不稳定，无法保证音画同步。');
    return Math.round((delays[0] + delays[1]) / 2);
  })();
  aacDelayCache.set(bitrate, cached);
  cached.catch(() => aacDelayCache.delete(bitrate));
  return cached;
}

class BoundedAacEncoder {
  readonly source = new EncodedAudioPacketSource('aac');
  private encoder: AudioEncoder;
  private pending: Promise<void> = Promise.resolve();
  private failure: unknown;
  constructor(
    bitrate: number,
    private readonly duration: number,
    delaySamples: number,
  ) {
    this.encoder = new AudioEncoder({
      output: (chunk, metadata) => {
        const original = EncodedPacket.fromEncodedChunk(chunk);
        const timestamp = (Math.round(original.timestamp * 48000) - delaySamples) / 48000;
        if (timestamp >= this.duration - 1e-9) return;
        const duration = Math.min(
          Math.round(original.duration * 48000) / 48000,
          this.duration - timestamp,
        );
        const packet = original.clone({ timestamp, duration });
        this.pending = this.pending
          .then(() => this.source.add(packet, metadata))
          .catch((error) => {
            this.failure = error;
          });
      },
      error: (error) => {
        this.failure = error;
      },
    });
    this.encoder.configure({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate });
  }
  async add(buffer: AudioBuffer, timestamp: number) {
    if (this.failure) throw this.failure;
    const data = new Float32Array(buffer.length * 2);
    data.set(buffer.getChannelData(0));
    data.set(buffer.getChannelData(1), buffer.length);
    const sample = new AudioData({
      data,
      format: 'f32-planar',
      numberOfChannels: 2,
      sampleRate: 48000,
      numberOfFrames: buffer.length,
      timestamp: Math.round(timestamp * 1e6),
    });
    this.encoder.encode(sample);
    sample.close();
    while (this.encoder.encodeQueueSize > 2) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.encoder.removeEventListener('dequeue', done);
          resolve();
        };
        const timer = setTimeout(done, 1000);
        this.encoder.addEventListener('dequeue', done, { once: true });
      });
      if (this.failure) throw this.failure;
    }
    await this.pending;
    if (this.failure) throw this.failure;
  }
  async finish() {
    await this.encoder.flush();
    await this.pending;
    if (this.failure) throw this.failure;
    this.source.close();
  }
  close() {
    if (this.encoder.state !== 'closed') this.encoder.close();
  }
}

/** Probes the exact output dimensions/rate and both encoders; does not silently change container or codecs. */
export async function checkExportCapabilities(
  sequence: Pick<VideoSequence, 'width' | 'height' | 'fps'>,
  options: Pick<VideoExportOptions, 'videoBitrate' | 'audioBitrate' | 'fileHandle'> = {},
): Promise<ExportCapabilities> {
  const errors: string[] = [];
  const videoQuality = new Quality({ bitrate: options.videoBitrate ?? DEFAULT_VIDEO_BITRATE });
  const audioQuality = new Quality({ bitrate: options.audioBitrate ?? DEFAULT_AUDIO_BITRATE });
  const dimensionsValid =
    Number.isInteger(sequence.width) &&
    Number.isInteger(sequence.height) &&
    sequence.width >= 2 &&
    sequence.height >= 2 &&
    sequence.width % 2 === 0 &&
    sequence.height % 2 === 0;
  if (!dimensionsValid) errors.push('H.264 输出的宽和高必须为至少 2 像素的偶数。');
  if (!(sequence.fps >= 1 && sequence.fps <= 120))
    errors.push('输出帧率必须在 1 至 120 fps 之间。');
  const [video, audio] = await Promise.all([
    dimensionsValid
      ? canEncodeVideo('avc', {
          width: sequence.width,
          height: sequence.height,
          frameRate: sequence.fps,
          quality: videoQuality,
        }).catch(() => false)
      : false,
    canEncodeAudio('aac', { sampleRate: 48000, numberOfChannels: 2, quality: audioQuality }).catch(
      () => false,
    ),
  ]);
  if (!video)
    errors.push(
      '此浏览器或设备无法编码所选画幅/帧率的 H.264 视频；请使用支持 WebCodecs 的桌面 Chrome/Edge，或降低输出尺寸。',
    );
  if (!audio) errors.push('此浏览器缺少 AAC 编码能力，无法输出有声 MP4。');
  const streaming = !!options.fileHandle || !!navigator.storage?.getDirectory;
  if (!streaming)
    errors.push('当前环境不支持本地分块写入；请使用桌面 Chrome/Edge，并选择可写入的位置。');
  return { supported: errors.length === 0, video, audio, streaming, errors };
}

export async function preflightExport(
  project: VideoProject,
  sequence: VideoSequence,
  renderer: SequenceRenderer,
  options: VideoExportOptions = {},
): Promise<{ errors: string[]; warnings: string[]; estimatedBytes: number }> {
  checkAbort(options.signal);
  const capability = await checkExportCapabilities(sequence, options);
  const errors = [...capability.errors],
    warnings: string[] = [];
  const start = options.startFrame ?? 0,
    end = options.endFrame ?? sequenceDuration(sequence);
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start ||
    end > sequenceDuration(sequence)
  ) {
    errors.push('导出范围必须是时间线中的有效整数帧区间，并至少包含一帧。');
  }
  const solo = sequence.tracks.some((track) => track.kind === 'audio' && track.solo);
  const checked = new Set<string>(),
    checkedStatic = new Set<string>();
  for (const clip of sequence.clips) {
    const track = sequence.tracks.find((item) => item.id === clip.trackId);
    if (!track || clip.start >= end || clip.start + clip.duration <= start) continue;
    if (track.kind === 'video' ? track.hidden : track.muted || (solo && !track.solo)) continue;
    const asset = project.assets.find((item) => item.id === clip.assetId);
    if (!asset) {
      errors.push(`片段“${clip.name}”缺少素材。`);
      continue;
    }
    if (isFileAsset(asset) && !renderer.media.has(asset.id))
      errors.push(`请重新关联本地素材“${asset.name}”。`);
    if (['video', 'audio'].includes(asset.kind)) {
      if (
        clip.sourceIn < 0 ||
        clip.sourceIn >= asset.duration ||
        (!clip.loop && clip.sourceIn + clip.duration / sequence.fps > asset.duration + 1e-6)
      ) {
        errors.push(`片段“${clip.name}”超出源素材时长，请调整入出点。`);
      }
      if (!checked.has(asset.id) && renderer.media.has(asset.id)) {
        try {
          const reader = await renderer.media.reader(asset.id);
          if (track.kind === 'video' && (!reader.video || !(await reader.video.canDecode())))
            errors.push(`素材“${asset.name}”的视频无法解码。`);
          if (asset.hasAudio && (!reader.audio || !(await reader.audio.canDecode())))
            errors.push(`素材“${asset.name}”的音频无法解码。`);
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
        checked.add(asset.id);
      }
    }
    if (
      ['graphic', 'text', 'color', 'image'].includes(asset.kind) &&
      !checkedStatic.has(asset.id)
    ) {
      checkedStatic.add(asset.id);
      try {
        errors.push(...(await renderer.prepareAsset(asset, project, sequence, options.signal)));
      } catch (error) {
        checkAbort(options.signal);
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (asset.kind === 'graphic') {
      const source = project.graphics.find((item) => item.id === asset.graphic?.sourceId);
      if (!source) errors.push(`“${asset.name}”的图片方案缺失。`);
      else if (asset.graphic!.rowIds.some((id) => !source.rowIds.includes(id)))
        errors.push(`“${asset.name}”关联的数据行已删除。`);
    }
  }
  const estimatedBytes = Math.ceil(
    (((Math.max(0, end - start) / sequence.fps) *
      ((options.videoBitrate ?? DEFAULT_VIDEO_BITRATE) +
        (options.audioBitrate ?? DEFAULT_AUDIO_BITRATE))) /
      8) *
      1.15,
  );
  if (!options.fileHandle && navigator.storage?.estimate) {
    const storage = await navigator.storage.estimate();
    if (storage.quota && storage.quota - (storage.usage || 0) < estimatedBytes)
      errors.push('浏览器临时存储空间不足，请选择磁盘文件位置或缩短导出范围。');
  }
  checkAbort(options.signal);
  return { errors: [...new Set(errors)], warnings, estimatedBytes };
}

/**
 * Frame-exact, faster-than-realtime-capable offline MP4 export. At most 0.25 seconds of mixed PCM and
 * a bounded set of decoded frames are held by this layer. fMP4 fragments and a 1 MiB StreamTarget
 * write directly to the selected file or to a temporary OPFS file; no full-movie ArrayBuffer exists.
 */
export async function exportSequence(
  project: VideoProject,
  sequence: VideoSequence,
  renderer: SequenceRenderer,
  options: VideoExportOptions = {},
): Promise<VideoExportResult> {
  const began = performance.now();
  const start = options.startFrame ?? 0,
    end = options.endFrame ?? sequenceDuration(sequence),
    frames = end - start;
  let bytes = 0;
  const report = (completed: number, phase: ExportProgress['phase']) =>
    options.onProgress?.({
      completed,
      total: frames,
      ratio: frames > 0 ? completed / frames : 0,
      phase,
      bytes,
    });
  report(0, 'checking');
  const worker = renderer.fork();
  let output: Output | undefined;
  let audioEncoder: BoundedAacEncoder | undefined;
  let temporaryRoot: FileSystemDirectoryHandle | undefined;
  let temporaryName: string | undefined;
  let raw: FileSystemWritableFileStream | undefined;
  let completed = false;
  let allowCommit = false;
  let streamClosed = false;
  const cleanup = async () => {
    if (temporaryRoot && temporaryName) {
      await temporaryRoot.removeEntry(temporaryName).catch((error) => {
        if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
      });
    }
  };
  try {
    const preflight = await preflightExport(project, sequence, worker, options);
    if (preflight.errors.length) throw new Error(preflight.errors.join('\n'));
    checkAbort(options.signal);
    let handle = options.fileHandle;
    if (!handle) {
      temporaryRoot = await navigator.storage.getDirectory();
      temporaryName = `teditor-export-${crypto.randomUUID()}.mp4`;
      handle = await temporaryRoot.getFileHandle(temporaryName, { create: true });
    }
    raw = await handle.createWritable();
    const stream = new WritableStream<StreamTargetChunk>(
      {
        async write(chunk) {
          checkAbort(options.signal);
          await raw!.write({
            type: 'write',
            position: chunk.position,
            data: chunk.data as Uint8Array<ArrayBuffer>,
          });
          bytes = Math.max(bytes, chunk.position + chunk.data.byteLength);
        },
        async close() {
          if (streamClosed) return;
          streamClosed = true;
          if (allowCommit && !options.signal?.aborted) await raw!.close();
          else await raw!.abort();
        },
        async abort(reason) {
          if (!streamClosed) {
            streamClosed = true;
            await raw!.abort(reason);
          }
        },
      },
      { highWaterMark: 2 },
    );
    output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 1 }),
      target: new StreamTarget(stream, { chunked: true, chunkSize: 1024 * 1024 }),
    });
    const canvas = document.createElement('canvas');
    canvas.width = sequence.width;
    canvas.height = sequence.height;
    const video = new CanvasSource(canvas, {
      codec: 'avc',
      quality: new Quality({ bitrate: options.videoBitrate ?? DEFAULT_VIDEO_BITRATE }),
      keyFrameInterval: 1,
      latencyMode: 'quality',
    });
    const audioBitrate = options.audioBitrate ?? DEFAULT_AUDIO_BITRATE;
    audioEncoder = new BoundedAacEncoder(
      audioBitrate,
      frames / sequence.fps,
      await measureAacDelay(audioBitrate),
    );
    output.addVideoTrack(video, { frameRate: sequence.fps });
    output.addAudioTrack(audioEncoder.source);
    output.setMetadataTags({ title: `${project.name} · ${sequence.name}` });
    await output.start();
    const sampleRate = 48000;
    let audioSamples = 0;
    const batchFrames = Math.max(1, Math.floor(sequence.fps / 4));
    for (let frame = 0; frame < frames; frame++) {
      checkAbort(options.signal);
      await worker.render(canvas, project, sequence, start + frame, {
        signal: options.signal,
        strict: true,
      });
      await video.add(frame / sequence.fps, 1 / sequence.fps);
      if ((frame + 1) % batchFrames === 0 || frame + 1 === frames) {
        const endSample = Math.round(((frame + 1) * sampleRate) / sequence.fps);
        const buffer = await worker.mixAudio(
          project,
          sequence,
          start / sequence.fps + audioSamples / sampleRate,
          (endSample - audioSamples) / sampleRate,
          sampleRate,
          options.signal,
        );
        await audioEncoder.add(buffer, audioSamples / sampleRate);
        audioSamples = endSample;
        report(frame + 1, 'rendering');
        // Yield UI work and cancellation between chunks, independent of whether WebCodecs immediately resolves.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    checkAbort(options.signal);
    video.close();
    await audioEncoder.finish();
    report(frames, 'finalizing');
    allowCommit = true;
    await output.finalize();
    checkAbort(options.signal);
    const file = await handle.getFile();
    completed = true;
    report(frames, 'complete');
    return {
      file,
      frames,
      duration: frames / sequence.fps,
      elapsedMs: performance.now() - began,
      bytes: file.size,
      cleanup,
    };
  } catch (error) {
    allowCommit = false;
    if (output && output.state !== 'finalized' && output.state !== 'canceled')
      await output.cancel().catch(() => undefined);
    if (raw && !streamClosed) {
      streamClosed = true;
      await raw.abort().catch(() => undefined);
    }
    throw error;
  } finally {
    audioEncoder?.close();
    worker.dispose();
    if (!completed) await cleanup();
  }
}
