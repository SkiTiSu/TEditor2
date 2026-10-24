import { expect, it } from 'vitest';
import { copyTimelineClips, pasteTimelineClips } from '../src/video/clipboard';
import { createClip, createSequence } from '../src/video/model';
import type { MediaAsset } from '../src/video/types';

const asset: MediaAsset = {
  id: 'media',
  name: 'video',
  kind: 'video',
  duration: 30,
  width: 320,
  height: 180,
  hasAudio: true,
};
function fixture() {
  const sequence = createSequence('test', 320, 180, 60);
  const a = createClip(asset, sequence.tracks[0].id, 0, 60, sequence);
  const sound = createClip(asset, sequence.tracks[1].id, 0, 60, sequence);
  a.linkId = sound.linkId = 'original-link';
  const b = createClip(asset, sequence.tracks[0].id, 90, 30, sequence);
  sequence.clips = [a, sound, b];
  return { sequence, a, sound, b };
}
it('copies a snapshot of multiple clips with linked audio, relative gaps and independent IDs', () => {
  const { sequence, a, b } = fixture();
  a.sourceIn = sequence.clips[1].sourceIn = 2;
  const snapshot = copyTimelineClips('p', sequence, [a.id, b.id]);
  a.volume = 0;
  const original = structuredClone(sequence);
  const result = pasteTimelineClips('p', sequence, [asset], snapshot, 120)!;
  const clips = result.sequence.clips.filter((c) => result.selectedIds.includes(c.id));
  expect(clips.map((c) => c.start)).toEqual([120, 120, 210]);
  expect(clips[0].volume).toBe(1);
  expect(clips[0].sourceIn).toBe(2);
  expect(clips[0].linkId).toBe(clips[1].linkId);
  expect(clips[0].linkId).not.toBe('original-link');
  const again = pasteTimelineClips('p', result.sequence, [asset], snapshot, 240)!;
  expect(again.selectedIds.some((id) => result.selectedIds.includes(id))).toBe(false);
  expect(sequence).toEqual(original);
});
it('inserts at the playhead and shifts existing content without overwriting it', () => {
  const { sequence, a } = fixture();
  const result = pasteTimelineClips(
    'p',
    sequence,
    [asset],
    copyTimelineClips('p', sequence, [a.id]),
    30,
  )!;
  expect(
    result.sequence.clips.filter((c) => result.selectedIds.includes(c.id)).map((c) => c.start),
  ).toEqual([30, 30]);
  expect(result.sequence.clips.find((c) => c.id === sequence.clips[2].id)?.start).toBe(150);
  expect(
    result.sequence.clips
      .filter((c) => c.linkId === 'original-link')
      .every((c) => c.duration === 30),
  ).toBe(true);
});
it('preserves internal transitions and groups while rejecting locked or missing media atomically', () => {
  const { sequence, a, b } = fixture();
  b.start = 45;
  b.duration = 60;
  a.groupId = b.groupId = 'group';
  sequence.transitions = [{ id: 'fade', fromClipId: a.id, toClipId: b.id, duration: 15 }];
  const text = copyTimelineClips('p', sequence, [a.id]);
  const result = pasteTimelineClips('p', sequence, [asset], text, 120)!;
  expect(result.sequence.transitions).toHaveLength(2);
  expect(result.sequence.transitions[1].duration).toBe(15);
  expect(result.selectedIds).toContain(result.sequence.transitions[1].fromClipId);
  sequence.tracks[1].locked = true;
  const before = structuredClone(sequence);
  expect(() => pasteTimelineClips('p', sequence, [asset], text, 120)).toThrow('锁定');
  expect(sequence).toEqual(before);
  expect(() => pasteTimelineClips('p', sequence, [], text, 120)).toThrow('素材');
  expect(() => pasteTimelineClips('other', sequence, [asset], text, 120)).toThrow('同一视频工程');
  expect(pasteTimelineClips('p', sequence, [asset], 'ordinary text', 0)).toBeNull();
});
it('maps tracks in another sequence and rejects mismatched frame rates', () => {
  const { sequence, a } = fixture();
  const text = copyTimelineClips('p', sequence, [a.id]);
  const target = createSequence('target', 320, 180, 60);
  const result = pasteTimelineClips('p', target, [asset], text, 0)!;
  expect(result.sequence.clips.map((c) => c.trackId)).toEqual(target.tracks.map((t) => t.id));
  target.fps = 30;
  expect(() => pasteTimelineClips('p', target, [asset], text, 0)).toThrow('帧率不同');
});
