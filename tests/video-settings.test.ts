import { expect, it } from 'vitest';
import { createClip, createSequence, validateSequence } from '../src/video/model';
import { createDefaultTemplate, validateTemplate } from '../src/video/templates';
import { rescaleSequence } from '../src/video/frameRate';
import { defaultVideoBitrate, validFrameRate } from '../src/video/settings';
import type { MediaAsset } from '../src/video/types';

it('uses the same fractional and high frame rates for sequences and templates', () => {
  for (const fps of [1, 23.976, 59.94, 120, 144, 240]) {
    expect(validFrameRate(fps)).toBe(true);
    expect(createSequence('test', 1920, 1080, fps).fps).toBe(fps);
    expect(validateTemplate({ ...createDefaultTemplate(), fps }).fps).toBe(fps);
  }
  for (const fps of [0, 240.01, Infinity, NaN]) {
    expect(validFrameRate(fps)).toBe(false);
    expect(() => createSequence('test', 1920, 1080, fps)).toThrow();
    expect(() => validateTemplate({ ...createDefaultTemplate(), fps })).toThrow();
  }
});

it('defaults 1080p to 6 Mbps in either orientation and preserves old saved export choices', () => {
  expect(defaultVideoBitrate({ width: 1920, height: 1080 })).toBe(6e6);
  expect(defaultVideoBitrate({ width: 1080, height: 1920 })).toBe(6e6);
  expect(defaultVideoBitrate({ width: 3840, height: 2160 })).toBe(20e6);
  const sequence = createSequence();
  sequence.exportSettings = { startFrame: 0, endFrame: 60, videoBitrate: 40e6 };
  expect(validateSequence(sequence).exportSettings).toEqual(sequence.exportSettings);
  sequence.exportSettings.videoBitrateMode = 'constant';
  expect(validateSequence(sequence).exportSettings?.videoBitrateMode).toBe('constant');
  expect(() =>
    validateSequence({
      ...sequence,
      exportSettings: {
        ...sequence.exportSettings,
        videoBitrateMode: 'ignored',
      },
    }),
  ).toThrow('码率模式');
});

const asset: MediaAsset = {
  id: 'color',
  name: 'color',
  kind: 'color',
  color: '#f00',
  duration: 0,
  width: 320,
  height: 180,
  hasAudio: false,
};
it('retimes shared cuts and transition overlaps without rounding gaps', () => {
  const sequence = createSequence('rounding', 320, 180, 60);
  const track = sequence.tracks[0].id;
  sequence.clips = [
    createClip(asset, track, 0, 3, sequence),
    createClip(asset, track, 3, 5, sequence),
    createClip(asset, track, 7, 5, sequence),
  ];
  sequence.transitions = [
    {
      id: 'transition',
      fromClipId: sequence.clips[1].id,
      toClipId: sequence.clips[2].id,
      duration: 1,
    },
  ];
  sequence.exportSettings = {
    startFrame: 0,
    endFrame: 12,
    videoBitrate: 6e6,
    videoBitrateMode: 'constant',
  };
  const original = structuredClone(sequence);
  const next = rescaleSequence(sequence, [asset], 30);
  expect(next.clips.map((clip) => [clip.start, clip.duration])).toEqual([
    [0, 2],
    [2, 2],
    [4, 2],
  ]);
  expect(next.transitions).toHaveLength(0);
  expect(next.exportSettings).toMatchObject({ endFrame: 6, videoBitrateMode: 'constant' });
  const increased = rescaleSequence(sequence, [asset], 240);
  expect(increased.transitions[0].duration).toBe(4);
  expect(increased.clips[1].start).toBe(12);
  expect(sequence).toEqual(original);
});

it('rejects collapsing clips or locked timelines without mutating the sequence', () => {
  const sequence = createSequence('short', 320, 180, 240);
  sequence.clips = [createClip(asset, sequence.tracks[0].id, 0, 1, sequence)];
  const original = structuredClone(sequence);
  expect(() => rescaleSequence(sequence, [asset], 24)).toThrow('不足一帧');
  expect(sequence).toEqual(original);
  sequence.tracks[0].locked = true;
  expect(() => rescaleSequence(sequence, [asset], 120)).toThrow('解锁');
});
