import {
  ALL_FORMATS,
  AudioBufferSink,
  BlobSource,
  Input,
  VideoSampleSink,
  type InputAudioTrack,
  type InputVideoTrack,
  type VideoSample,
  type WrappedAudioBuffer,
} from 'mediabunny';
import type { MediaAsset } from './types';

export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('已取消视频处理。', 'AbortError');
}
export const isFileAsset = (asset: MediaAsset) => ['video', 'audio', 'image'].includes(asset.kind);

type Reader = {
  input: Input;
  video: InputVideoTrack | null;
  audio: InputAudioTrack | null;
  origin: number;
};
type VideoCursor = {
  assetId: string;
  iterator: AsyncGenerator<VideoSample, void, unknown>;
  current?: VideoSample;
  next?: VideoSample;
  ended: boolean;
  time: number;
};
type AudioCursor = {
  assetId: string;
  iterator: AsyncGenerator<WrappedAudioBuffer, void, unknown>;
  current?: WrappedAudioBuffer;
  ended: boolean;
  time: number;
};

async function openMedia(file: File): Promise<Reader> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const [video, audio, first] = await Promise.all([
      input.getPrimaryVideoTrack(),
      input.getPrimaryAudioTrack(),
      input.getFirstTimestamp(),
    ]);
    return { input, video, audio, origin: Math.max(0, first) };
  } catch (error) {
    input.dispose();
    throw new Error(
      `无法读取“${file.name}”：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Reads metadata lazily from the local File; never uploads or decodes an entire audio file. */
export async function probeMedia(file: File): Promise<MediaAsset> {
  const base = {
    id: crypto.randomUUID(),
    name: file.name,
    fileName: file.name,
    relativePath: file.webkitRelativePath || undefined,
    size: file.size,
    lastModified: file.lastModified,
    mimeType: file.type,
  };
  if (file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(file.name)) {
    const image = await createImageBitmap(file);
    const result: MediaAsset = {
      ...base,
      kind: 'image',
      duration: 0,
      width: image.width,
      height: image.height,
      hasAudio: false,
    };
    const canvas = document.createElement('canvas');
    const scale = Math.min(240 / image.width, 240 / image.height);
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height);
    result.thumbnail = canvas.toDataURL('image/jpeg', 0.7);
    image.close();
    return result;
  }
  const reader = await openMedia(file);
  try {
    if (!reader.video && !reader.audio) throw new Error('文件不包含可读取的音视频轨道。');
    if (reader.video && !(await reader.video.canDecode()))
      throw new Error('当前浏览器无法解码此视频，请转换为 H.264 MP4 后重新关联。');
    if (reader.audio && !(await reader.audio.canDecode()))
      throw new Error('当前浏览器无法解码此音频。');
    const result: MediaAsset = {
      ...base,
      kind: reader.video ? 'video' : 'audio',
      duration: Math.max(0, (await reader.input.computeDuration()) - reader.origin),
      width: reader.video ? await reader.video.getDisplayWidth() : 0,
      height: reader.video ? await reader.video.getDisplayHeight() : 0,
      hasAudio: !!reader.audio,
    };
    if (reader.video) {
      const frame = await new VideoSampleSink(reader.video).getSample(
        await reader.video.getFirstTimestamp(),
      );
      if (frame) {
        try {
          const canvas = document.createElement('canvas');
          const scale = Math.min(240 / result.width, 240 / result.height);
          canvas.width = Math.max(1, Math.round(result.width * scale));
          canvas.height = Math.max(1, Math.round(result.height * scale));
          frame.draw(canvas.getContext('2d')!, 0, 0, canvas.width, canvas.height);
          result.thumbnail = canvas.toDataURL('image/jpeg', 0.7);
        } finally {
          frame.close();
        }
      }
    }
    return result;
  } finally {
    reader.input.dispose();
  }
}

/** Owns runtime-only File handles, bounded decoded frames, and streaming audio cursors. */
export class MediaLibrary {
  private files = new Map<string, File>();
  private urls = new Map<string, string>();
  private readers = new Map<string, Promise<Reader>>();
  private images = new Map<string, ImageBitmap>();
  private videoCursors = new Map<string, VideoCursor>();
  private audioCursors = new Map<string, AudioCursor>();
  private disposed = false;
  private generation = 0;
  get revision(): number {
    return this.generation;
  }

  register(id: string, file: File): void {
    if (this.disposed) throw new Error('媒体库已关闭。');
    this.remove(id);
    this.files.set(id, file);
  }
  async probe(file: File): Promise<MediaAsset> {
    const asset = await probeMedia(file);
    this.register(asset.id, file);
    return asset;
  }
  has(id: string): boolean {
    return this.files.has(id);
  }
  getFile(id: string): File | undefined {
    return this.files.get(id);
  }
  getUrl(id: string): string | undefined {
    const file = this.files.get(id);
    if (!file) return undefined;
    let url = this.urls.get(id);
    if (!url) {
      url = URL.createObjectURL(file);
      this.urls.set(id, url);
    }
    return url;
  }
  remove(id: string): void {
    this.generation++;
    this.files.delete(id);
    const url = this.urls.get(id);
    if (url) URL.revokeObjectURL(url);
    this.urls.delete(id);
    this.images.get(id)?.close();
    this.images.delete(id);
    for (const [key, cursor] of this.videoCursors)
      if (cursor.assetId === id) this.releaseVideo(key);
    for (const [key, cursor] of this.audioCursors)
      if (cursor.assetId === id) this.releaseAudio(key);
    const reader = this.readers.get(id);
    this.readers.delete(id);
    if (reader) void reader.then((value) => value.input.dispose()).catch(() => undefined);
  }
  fork(): MediaLibrary {
    const copy = new MediaLibrary();
    for (const [id, file] of this.files) copy.files.set(id, file);
    return copy;
  }
  async reader(id: string): Promise<Reader> {
    if (this.disposed) throw new Error('媒体库已关闭。');
    let reader = this.readers.get(id);
    if (!reader) {
      const file = this.files.get(id);
      if (!file) throw new Error('素材未关联，请重新选择本地文件。');
      reader = openMedia(file);
      this.readers.set(id, reader);
      reader.catch(() => {
        if (this.readers.get(id) === reader) this.readers.delete(id);
      });
    }
    // Reader metadata is small, but demuxers also cache packets. Keep at most eight inactive inputs.
    this.readers.delete(id);
    this.readers.set(id, reader);
    if (this.readers.size > 12) {
      for (const [oldId, old] of this.readers) {
        if (
          oldId === id ||
          [...this.videoCursors.values(), ...this.audioCursors.values()].some(
            (c) => c.assetId === oldId,
          )
        )
          continue;
        this.readers.delete(oldId);
        void old.then((value) => value.input.dispose()).catch(() => undefined);
        if (this.readers.size <= 12) break;
      }
    }
    return reader;
  }
  async image(id: string, signal?: AbortSignal): Promise<ImageBitmap> {
    checkAbort(signal);
    const cached = this.images.get(id);
    if (cached) {
      this.images.delete(id);
      this.images.set(id, cached);
      return cached;
    }
    const file = this.files.get(id);
    if (!file) throw new Error('图片素材未关联。');
    const image = await createImageBitmap(file);
    if (signal?.aborted || this.disposed) {
      image.close();
      checkAbort(signal);
      throw new Error('媒体库已关闭。');
    }
    this.images.set(id, image);
    let pixels = [...this.images.values()].reduce(
      (sum, bitmap) => sum + bitmap.width * bitmap.height,
      0,
    );
    while (this.images.size > 1 && (this.images.size > 6 || pixels > 16_000_000)) {
      const first = this.images.keys().next().value!;
      const old = this.images.get(first)!;
      pixels -= old.width * old.height;
      old.close();
      this.images.delete(first);
    }
    return image;
  }
  private releaseVideo(key: string): void {
    const cursor = this.videoCursors.get(key);
    if (!cursor) return;
    this.videoCursors.delete(key);
    cursor.current?.close();
    cursor.next?.close();
    void cursor.iterator.return().catch(() => undefined);
  }
  private releaseAudio(key: string): void {
    const cursor = this.audioCursors.get(key);
    if (!cursor) return;
    this.audioCursors.delete(key);
    void cursor.iterator.return().catch(() => undefined);
  }
  /** The returned sample is borrowed until the next call for this stream; do not close it. */
  async videoFrame(
    id: string,
    time: number,
    key = id,
    signal?: AbortSignal,
  ): Promise<VideoSample | null> {
    checkAbort(signal);
    const reader = await this.reader(id);
    checkAbort(signal);
    if (this.disposed) throw new Error('媒体库已关闭。');
    if (!reader.video) return null;
    const timestamp = time + reader.origin;
    let cursor = this.videoCursors.get(key);
    if (
      cursor &&
      (cursor.assetId !== id || timestamp < cursor.time - 1e-7 || timestamp - cursor.time > 2)
    ) {
      this.releaseVideo(key);
      cursor = undefined;
    }
    if (!cursor) {
      const iterator = new VideoSampleSink(reader.video).samples(timestamp);
      cursor = { assetId: id, iterator, ended: false, time: timestamp };
      this.videoCursors.set(key, cursor);
    }
    this.videoCursors.delete(key);
    this.videoCursors.set(key, cursor);
    // Only active layers should retain decoded surfaces, independent of the number of source files.
    while (this.videoCursors.size > 12) this.releaseVideo(this.videoCursors.keys().next().value!);
    while (!cursor.ended) {
      checkAbort(signal);
      if (!cursor.next) {
        const next = await cursor.iterator.next();
        if (next.done) {
          cursor.ended = true;
          break;
        }
        cursor.next = next.value;
      }
      if (cursor.next.timestamp > timestamp + 1e-7) break;
      cursor.current?.close();
      cursor.current = cursor.next;
      cursor.next = undefined;
    }
    cursor.time = timestamp;
    checkAbort(signal);
    const sample = cursor.current;
    // Do not hold the last frame beyond the end of a deliberately selected source range.
    return sample && timestamp < sample.timestamp + sample.duration + 1e-7 ? sample : null;
  }
  /** Streams the intersecting source buffers; yielded buffers must be consumed immediately. */
  async *audioBuffers(
    id: string,
    start: number,
    end: number,
    key = id,
    signal?: AbortSignal,
  ): AsyncGenerator<WrappedAudioBuffer> {
    checkAbort(signal);
    const reader = await this.reader(id);
    checkAbort(signal);
    if (this.disposed) throw new Error('媒体库已关闭。');
    if (!reader.audio) return;
    const first = start + reader.origin,
      last = end + reader.origin;
    let cursor = this.audioCursors.get(key);
    if (
      cursor &&
      (cursor.assetId !== id || first < cursor.time - 1e-7 || first - cursor.time > 2)
    ) {
      this.releaseAudio(key);
      cursor = undefined;
    }
    if (!cursor) {
      cursor = {
        assetId: id,
        iterator: new AudioBufferSink(reader.audio).buffers(first),
        ended: false,
        time: first,
      };
      this.audioCursors.set(key, cursor);
    }
    this.audioCursors.delete(key);
    this.audioCursors.set(key, cursor);
    while (this.audioCursors.size > 24) this.releaseAudio(this.audioCursors.keys().next().value!);
    while (!cursor.ended) {
      checkAbort(signal);
      if (!cursor.current) {
        const next = await cursor.iterator.next();
        if (next.done) {
          cursor.ended = true;
          break;
        }
        cursor.current = next.value;
      }
      const current = cursor.current;
      if (current.timestamp >= last - 1e-9) break;
      if (current.timestamp + current.duration > first) {
        yield { ...current, timestamp: current.timestamp - reader.origin };
      }
      if (current.timestamp + current.duration >= last - 1e-9) break;
      cursor.current = undefined;
    }
    cursor.time = last;
  }
  retainStreams(videoKeys: Set<string>, audioKeys?: Set<string>): void {
    for (const key of this.videoCursors.keys()) if (!videoKeys.has(key)) this.releaseVideo(key);
    if (audioKeys)
      for (const key of this.audioCursors.keys()) if (!audioKeys.has(key)) this.releaseAudio(key);
  }
  async waveform(id: string, bins?: number, signal?: AbortSignal): Promise<number[]> {
    const reader = await this.reader(id);
    if (!reader.audio) return [];
    const duration = (await reader.input.computeDuration()) - reader.origin;
    const peaks = new Array<number>(
      Math.max(1, Math.min(180_000, Math.ceil(bins ?? duration * 100))),
    ).fill(0);
    // Decode sequentially and discard each PCM block after reducing it into bounded peaks.
    const sink = new AudioBufferSink(reader.audio);
    for await (const sample of sink.buffers(reader.origin, reader.origin + duration)) {
      checkAbort(signal);
      const samplesPerBin = (sample.buffer.sampleRate * duration) / peaks.length;
      const start = (sample.timestamp - reader.origin) * sample.buffer.sampleRate;
      for (let channel = 0; channel < sample.buffer.numberOfChannels; channel++) {
        const samples = sample.buffer.getChannelData(channel);
        for (let i = 0; i < samples.length; i++) {
          const bin = Math.floor((start + i) / samplesPerBin);
          if (bin >= 0 && bin < peaks.length)
            peaks[bin] = Math.max(peaks[bin], Math.abs(samples[i]));
        }
      }
    }
    return peaks.map((value) => Math.round(Math.min(1, value) * 10000) / 10000);
  }
  get diagnostics() {
    return {
      readers: this.readers.size,
      videoStreams: this.videoCursors.size,
      audioStreams: this.audioCursors.size,
      images: this.images.size,
    };
  }
  dispose(): void {
    for (const id of [...this.files.keys()]) this.remove(id);
    this.disposed = true;
  }
}
