import {
  AudioSample,
  AudioSampleSource,
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  Quality,
} from 'mediabunny';
import { MediaLibrary } from '../src/video/media';
import { SequenceRenderer } from '../src/video/compositor';
import { createClip, createProject, createSequence, createTrack } from '../src/video/model';
import type { MediaAsset } from '../src/video/types';

export async function makeVideo(duration = 2, fps = 30, width = 320, height = 180): Promise<File> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat(), target });
  const video = new CanvasSource(canvas, {
    codec: 'avc',
    quality: new Quality({ bitrate: 1_000_000 }),
    keyFrameInterval: 0.5,
  });
  const audio = new AudioSampleSource({ codec: 'aac', quality: new Quality({ bitrate: 128_000 }) });
  output.addVideoTrack(video, { frameRate: fps });
  output.addAudioTrack(audio);
  await output.start();
  for (let frame = 0; frame < duration * fps; frame++) {
    ctx.fillStyle = frame < fps ? '#00e000' : '#e00000';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(frame % width, height - 8, 6, 8);
    await video.add(frame / fps, 1 / fps);
    const sampleRate = 48000,
      length = sampleRate / fps;
    const samples = new Float32Array(length * 2);
    for (let i = 0; i < length; i++) {
      samples[i] = 0.25 * Math.sin(2 * Math.PI * 440 * (frame / fps + i / sampleRate));
      samples[i + length] = samples[i];
    }
    const sample = new AudioSample({
      data: samples,
      format: 'f32-planar',
      numberOfChannels: 2,
      sampleRate,
      timestamp: frame / fps,
    });
    await audio.add(sample);
    sample.close();
  }
  video.close();
  audio.close();
  await output.finalize();
  return new File([target.buffer!], 'sample-30fps.mp4', { type: 'video/mp4' });
}

export function makeWav(duration = 1, frequency = 880, sampleRate = 44100): File {
  const length = Math.round(sampleRate * duration),
    bytes = new ArrayBuffer(44 + length * 2),
    view = new DataView(bytes);
  const text = (offset: number, value: string) =>
    [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, bytes.byteLength - 8, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, length * 2, true);
  for (let i = 0; i < length; i++)
    view.setInt16(
      44 + i * 2,
      Math.round(0.2 * 32767 * Math.sin((2 * Math.PI * frequency * i) / sampleRate)),
      true,
    );
  return new File([bytes], 'background-44k.wav', { type: 'audio/wav' });
}

export async function fixture() {
  const project = createProject('媒体集成测试');
  const sequence = createSequence('混合帧率', 320, 180, 60);
  project.sequences = [sequence];
  project.activeSequenceId = sequence.id;
  const media = new MediaLibrary();
  const video = await media.probe(await makeVideo());
  const bgm = await media.probe(makeWav(0.37));
  const background: MediaAsset = {
    id: 'background',
    kind: 'color',
    name: '背景',
    duration: 0,
    width: 320,
    height: 180,
    hasAudio: false,
    color: '#0000ff',
  };
  project.assets = [video, bgm, background];
  const v1 = sequence.tracks[0],
    a1 = sequence.tracks[1];
  const v0 = createTrack('video', '底图'),
    a2 = createTrack('audio', 'BGM');
  sequence.tracks = [v1, v0, a1, a2];
  const visual = createClip(video, v1.id, 0, 60, sequence);
  visual.sourceIn = 0.5;
  visual.transform = { ...visual.transform, x: 40, y: 20, width: 240, height: 120, fit: 'cover' };
  const original = createClip(video, a1.id, 0, 60, sequence);
  original.sourceIn = 0.5;
  original.volume = 0.5;
  const music = createClip(bgm, a2.id, 0, 60, sequence);
  music.loop = true;
  music.volume = 0.5;
  sequence.clips = [visual, original, music, createClip(background, v0.id, 0, 60, sequence)];
  const renderer = new SequenceRenderer(media, async () => null);
  return { project, sequence, media, renderer, video, bgm, visual, original, music, a1, a2, v1 };
}

export function rms(samples: Float32Array) {
  return Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
}
export function tone(samples: Float32Array, frequency: number, sampleRate: number) {
  let sin = 0,
    cos = 0;
  for (let i = 0; i < samples.length; i++) {
    sin += samples[i] * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
    cos += samples[i] * Math.cos((2 * Math.PI * frequency * i) / sampleRate);
  }
  return (2 * Math.hypot(sin, cos)) / samples.length;
}
