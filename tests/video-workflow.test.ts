import { expect, it } from 'vitest';
import { assetUsage, removeAsset } from '../src/video/assetActions';
import { createProject, createClip, createSequence, validateProject } from '../src/video/model';
import { waveformEnvelope } from '../src/video/waveform';
import type { MediaAsset } from '../src/video/types';

const asset: MediaAsset = {
  id: 'audio',
  name: '音频',
  kind: 'audio',
  duration: 4,
  width: 0,
  height: 0,
  hasAudio: true,
  waveform: [0, 0.2, 0.7, 0.3, 0, 1, 0.1, 0],
};
it('removes asset uses in all sequences as one reversible project value', () => {
  const p = createProject();
  p.assets = [asset];
  p.sequences.push(createSequence('第二序列'));
  for (const s of p.sequences) s.clips.push(createClip(asset, s.tracks[1].id, 0, 120, s));
  const before = structuredClone(p);
  expect(assetUsage(p, asset.id)).toMatchObject({ sequences: 2, clips: 2, locked: false });
  const next = removeAsset(p, asset.id);
  expect(next.assets).toHaveLength(0);
  expect(next.sequences.every((s) => !s.clips.length)).toBe(true);
  expect(p).toEqual(before);
  expect(validateProject(before)).toEqual(before);
});
it('rejects removal of an asset used on a locked track without partial changes', () => {
  const p = createProject(),
    s = p.sequences[0];
  p.assets = [asset];
  s.clips.push(createClip(asset, s.tracks[1].id, 0, 60, s));
  s.tracks[1].locked = true;
  const before = structuredClone(p);
  expect(() => removeAsset(p, asset.id)).toThrow('锁定');
  expect(p).toEqual(before);
});
it('samples waveform trims, loops and silence, with enough points for screen pixels', () => {
  const s = createSequence(),
    clip = createClip(asset, s.tracks[1].id, 0, 240, s);
  const full = waveformEnvelope(asset, clip, s.fps, 100, 0, 400);
  expect(full).toHaveLength(401);
  expect(full[100]).toBeCloseTo(0.7);
  expect(full[250]).toBe(1);
  clip.sourceIn = 1;
  clip.loop = true;
  const loop = waveformEnvelope(asset, clip, s.fps, 100, 0, 400);
  expect(loop[0]).toBeCloseTo(0.7);
  expect(loop[300]).toBeCloseTo(0.7);
  expect(
    waveformEnvelope({ ...asset, waveform: [0, 0] }, clip, 60, 100, 0, 400).every((v) => v === 0),
  ).toBe(true);
  expect(waveformEnvelope(asset, clip, 60, 100, 100, 100)).toEqual(loop.slice(100, 201));
});
it('keeps short transients when zoomed out and bounds output size', () => {
  const s = createSequence(),
    clip = createClip(asset, s.tracks[1].id, 0, 240, s);
  const dense = { ...asset, waveform: Array.from({ length: 400 }, (_, i) => (i === 24 ? 1 : 0)) };
  expect(Math.max(...waveformEnvelope(dense, clip, 60, 1, 0, 4))).toBe(1);
  expect(waveformEnvelope(asset, clip, 60, 10000, 0, 40000)).toHaveLength(4096);
});
