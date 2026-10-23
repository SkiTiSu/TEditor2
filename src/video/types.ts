import type { TedDocument, TableData } from '../core/types';

/** Timeline positions/durations use integer sequence frames; sourceIn uses seconds. */
export type MediaKind = 'video' | 'audio' | 'image' | 'graphic' | 'text' | 'color';
export interface GraphicResource {
  id: string;
  path: string;
  fileName: string;
  size: number;
  lastModified: number;
  mimeType: string;
  fontFamily?: string;
}
export interface GraphicSource {
  id: string;
  name: string;
  document: TedDocument;
  table: TableData;
  rowIds: string[];
  revision: number;
  layout: { start: number; end: number; repeats: number; deltaX: number; deltaY: number };
  resources?: GraphicResource[];
}
export interface MediaAsset {
  id: string;
  name: string;
  kind: MediaKind;
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
  fileName?: string;
  relativePath?: string;
  size?: number;
  lastModified?: number;
  mimeType?: string;
  thumbnail?: string;
  waveform?: number[];
  graphic?: { sourceId: string; rowIds: string[] };
  text?: string;
  color?: string;
  fontFamily?: string;
  fontSize?: number;
}
export interface ClipTransform {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  opacity: number;
  fit: 'contain' | 'cover';
  crop: { top: number; right: number; bottom: number; left: number };
}
export interface VideoClip {
  id: string;
  name: string;
  trackId: string;
  assetId: string;
  start: number;
  duration: number;
  sourceIn: number;
  transform: ClipTransform;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  loop: boolean;
  linkId?: string;
  groupId?: string;
}
export interface VideoTrack {
  id: string;
  name: string;
  kind: 'video' | 'audio';
  locked: boolean;
  hidden: boolean;
  muted: boolean;
  solo: boolean;
  volume: number;
}
/** PPT editing preferences; clips remain the authoritative timeline representation. */
export interface SlideshowSettings {
  pageTrackId: string;
  bgmTrackId: string;
  defaultDuration: number;
  transitionDuration: number;
  bgmAssetId?: string;
  bgmVolume: number;
  bgmLoop: boolean;
  bgmFadeIn: number;
  bgmFadeOut: number;
}
/** Tracks are ordered top to bottom; last visible video track is composited first. */
export interface VideoSequence {
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  background: string;
  tracks: VideoTrack[];
  clips: VideoClip[];
  transitions: { id: string; fromClipId: string; toClipId: string; duration: number }[];
  markers: { id: string; frame: number; label: string }[];
  exportSettings?: { startFrame: number; endFrame: number; videoBitrate: number };
  slideshow?: SlideshowSettings;
}
export interface VideoProject {
  format: 'teditor-video';
  version: 1;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  activeSequenceId: string;
  assets: MediaAsset[];
  graphics: GraphicSource[];
  sequences: VideoSequence[];
  rankingBindings?: Record<string, RankingBinding[]>;
  templates?: VideoTemplate[];
}
export interface RankingBinding {
  rowId: string;
  assetId: string;
  sourceIn: number;
  sourceOut: number;
}
export interface TemplateSection {
  id: string;
  kind: 'main' | 'secondary' | 'title';
  name: string;
  sourceSlot?: string;
  duration: number;
  order: 'forward' | 'reverse';
  mainMode: 'window' | 'alternating';
  cardDuration: number;
  window: { x: number; y: number; width: number; height: number };
  transition: number;
  text?: string;
  background?: string;
  rowStart?: number;
  rowEnd?: number;
}
export interface VideoTemplate {
  format: 'teditor-video-template';
  version: 1;
  name: string;
  width: number;
  height: number;
  fps: number;
  sections: TemplateSection[];
}
export interface TemplateBindings {
  sources: Record<string, string>;
  main: RankingBinding[];
  mainBySource?: Record<string, RankingBinding[]>;
  bgmAssetId?: string;
  bgmLoop?: boolean;
}
