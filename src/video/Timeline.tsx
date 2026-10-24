import { waveformEnvelope } from './waveform';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  Copy,
  Eye,
  EyeOff,
  Film,
  Group,
  Link2Off,
  Lock,
  Magnet,
  Minus,
  MousePointer2,
  Music2,
  Plus,
  Redo2,
  Scissors,
  Trash2,
  Undo2,
  Ungroup,
  Unlock,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { MediaAsset, VideoClip, VideoSequence, VideoTrack } from './types';
import { relatedClipIds } from './edit';
import './timeline.css';

export interface TimelineProps {
  sequence: VideoSequence;
  assets: MediaAsset[];
  selectedIds: string[];
  frame: number;
  onSelect(ids: string[]): void;
  onSeek(frame: number): void;
  onMove(ids: string[], deltaFrames: number, targetTrackId?: string): void;
  onTrim(id: string, edge: 'start' | 'end', frameDelta: number): void;
  onDropAsset(assetId: string, trackId: string, frame: number): void;
  onTrackChange(trackId: string, patch: Partial<VideoTrack>): void;
  onTrackAdd(kind: 'video' | 'audio'): void;
  onTrackDelete(id: string): void;
  onTrackMove(id: string, direction: -1 | 1): void;
  onSplit(): void;
  onCut?(id: string, frame: number): void;
  onDelete(ripple: boolean): void;
  onDuplicate(): void;
  onGroup(): void;
  onUngroup(): void;
  onUnlink(): void;
  onUndo(): void;
  onRedo(): void;
  canUndo: boolean;
  canRedo: boolean;
  onTransition(durationFrames: number): void;
  operationPreview?: {
    trackId: string;
    start: number;
    duration: number;
    mode: 'insert' | 'overwrite';
  };
  getAssetRange?(assetId: string): { duration: number };
}

const HEADER_WIDTH = 180;
const TRACK_HEIGHT = 72;
const RULER_HEIGHT = 30;

export function formatTimelineTime(frame: number, fps: number) {
  const rate = Math.max(1, Math.round(fps));
  const safeFrame = Math.max(0, Math.floor(frame));
  const seconds = Math.floor(safeFrame / rate);
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60, safeFrame % rate]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}

type DragPreview = {
  kind: 'move' | 'trim';
  ids: string[];
  clipId: string;
  edge?: 'start' | 'end';
  delta: number;
  targetTrackId?: string;
  snapFrame?: number;
};
type SelectionBox = { startX: number; startY: number; x: number; y: number };

function Waveform({
  asset,
  clip,
  fps,
  pixelsPerSecond,
  startPixel,
  width,
}: {
  asset: MediaAsset;
  clip: VideoClip;
  fps: number;
  pixelsPerSecond: number;
  startPixel: number;
  width: number;
}) {
  const values = waveformEnvelope(asset, clip, fps, pixelsPerSecond, startPixel, width);
  if (!values.length) return null;
  const top = values.map((value, i) => `${i},${(16 - value * 15).toFixed(2)}`);
  const bottom = values.map((value, i) => `${i},${(16 + value * 15).toFixed(2)}`).reverse();
  return (
    <svg
      className="vtl-wave"
      viewBox={`0 0 ${values.length - 1} 32`}
      preserveAspectRatio="none"
      style={{ left: startPixel, width }}
      data-waveform-points={values.length}
      aria-hidden="true"
    >
      <path d={`M${top.join(' L')} L${bottom.join(' L')} Z`} />
      <path className="vtl-wave-center" d={`M0,16 H${values.length - 1}`} />
    </svg>
  );
}

export function Timeline(props: TimelineProps) {
  const { sequence, assets, selectedIds, frame, onSelect, onSeek } = props;
  const viewportRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const draggedAssetRef = useRef('');
  const [pixelsPerSecond, setPixelsPerSecond] = useState(70);
  const [viewportWidth, setViewportWidth] = useState(800);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [snapping, setSnapping] = useState(true);
  const [tool, setTool] = useState<'select' | 'razor'>('select');
  const [preview, setPreview] = useState<DragPreview | null>(null);
  const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null);
  const [dropPreview, setDropPreview] = useState<{
    trackId: string;
    frame: number;
    assetId: string;
    duration: number;
  } | null>(null);
  const [transitionSeconds, setTransitionSeconds] = useState(0.5);
  const [status, setStatus] = useState('拖入素材开始剪辑 · 拖动片段边缘裁切 · Shift 多选');
  const pxPerFrame = pixelsPerSecond / sequence.fps;
  const duration = Math.max(0, ...sequence.clips.map((clip) => clip.start + clip.duration));
  const visibleDuration = Math.max(
    duration + sequence.fps * 5,
    sequence.fps * 30,
    frame + sequence.fps * 5,
    (props.operationPreview ? props.operationPreview.start + props.operationPreview.duration : 0) +
      sequence.fps * 5,
    (dropPreview ? dropPreview.frame + dropPreview.duration : 0) + sequence.fps * 5,
  );
  const contentWidth = Math.max(
    viewportWidth - HEADER_WIDTH,
    Math.ceil(visibleDuration * pxPerFrame),
  );
  const assetMap = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);
  const trackMap = useMemo(
    () => new Map(sequence.tracks.map((track) => [track.id, track])),
    [sequence.tracks],
  );
  const selectedClips = sequence.clips.filter((clip) => selectedIds.includes(clip.id));
  const selectionLocked = selectedClips.some((clip) => trackMap.get(clip.trackId)?.locked);
  const canEdit = selectedClips.length > 0 && !selectionLocked;
  const baseTick =
    [1 / sequence.fps, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600].find(
      (seconds) => seconds * pixelsPerSecond >= 80,
    ) ?? 3600;
  const tickFrames = Math.max(1, Math.round(baseTick * sequence.fps));
  const firstTick = Math.max(0, Math.floor((scrollLeft - 100) / pxPerFrame / tickFrames));
  const lastTick = Math.ceil((scrollLeft + viewportWidth + 100) / pxPerFrame / tickFrames);
  const tickCount = Math.max(0, lastTick - firstTick + 1);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(() => setViewportWidth(viewport.clientWidth));
    observer.observe(viewport);
    setViewportWidth(viewport.clientWidth);
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => cleanupRef.current?.(), []);
  useEffect(() => {
    // During dragover the browser protects DataTransfer data; remember our in-page drag at its start.
    const start = (event: DragEvent) => {
      draggedAssetRef.current = event.dataTransfer?.getData('application/x-teditor-asset') || '';
    };
    const end = () => {
      draggedAssetRef.current = '';
      setDropPreview(null);
    };
    window.addEventListener('dragstart', start);
    window.addEventListener('dragend', end);
    return () => {
      window.removeEventListener('dragstart', start);
      window.removeEventListener('dragend', end);
    };
  }, []);
  useEffect(() => {
    setPreview(null);
    setSelectionBox(null);
    setDropPreview(null);
    cleanupRef.current?.();
  }, [sequence.id]);

  function coordinate(clientX: number) {
    const rect = surfaceRef.current?.getBoundingClientRect();
    return Math.max(0, Math.round((clientX - (rect?.left ?? 0) - HEADER_WIDTH) / pxPerFrame));
  }

  function snapAt(
    value: number,
    excludedIds: string[] = [],
  ): { value: number; snapFrame?: number } {
    const rounded = Math.round(value);
    if (!snapping) return { value: rounded };
    const points = [0, frame, ...sequence.markers.map((marker) => marker.frame)];
    for (const clip of sequence.clips) {
      if (!excludedIds.includes(clip.id)) points.push(clip.start, clip.start + clip.duration);
    }
    const threshold = 8 / pxPerFrame;
    let closest: number | undefined;
    let distance = threshold;
    for (const point of points) {
      const nextDistance = Math.abs(point - rounded);
      if (nextDistance <= distance) {
        closest = point;
        distance = nextDistance;
      }
    }
    return closest === undefined ? { value: rounded } : { value: closest, snapFrame: closest };
  }

  function listenPointer(
    move: (event: PointerEvent) => void,
    finish: (event: PointerEvent) => void,
  ) {
    cleanupRef.current?.();
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', cancel);
      cleanupRef.current = null;
    };
    const end = (event: PointerEvent) => {
      cleanup();
      finish(event);
    };
    const cancel = () => {
      cleanup();
      setPreview(null);
      setSelectionBox(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', cancel);
    cleanupRef.current = cleanup;
  }

  function beginClipDrag(event: ReactPointerEvent, clip: VideoClip, edge?: 'start' | 'end') {
    if (event.currentTarget.closest('fieldset:disabled')) return;
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    viewportRef.current?.focus();
    const track = trackMap.get(clip.trackId);
    if (tool === 'razor' && !edge) {
      if (track?.locked) {
        setStatus('此轨道已锁定，先解锁再剪辑。');
        return;
      }
      const cutFrame = coordinate(event.clientX);
      if (cutFrame > clip.start && cutFrame < clip.start + clip.duration)
        props.onCut?.(clip.id, cutFrame);
      return;
    }
    const multi = event.shiftKey || event.metaKey || event.ctrlKey;
    let ids = selectedIds.includes(clip.id) ? selectedIds : [clip.id];
    if (multi) {
      ids = selectedIds.includes(clip.id)
        ? selectedIds.filter((id) => id !== clip.id)
        : [...selectedIds, clip.id];
      onSelect(ids);
      return;
    }
    onSelect(ids);
    ids = relatedClipIds(
      sequence,
      edge ? [clip.id] : [clip.id, ...ids.filter((id) => id !== clip.id)],
      !edge,
    );
    if (
      track?.locked ||
      ids.some(
        (id) => trackMap.get(sequence.clips.find((item) => item.id === id)?.trackId ?? '')?.locked,
      )
    ) {
      setStatus('选区包含锁定轨道，先解锁再剪辑。');
      return;
    }
    const startX = event.clientX;
    const startY = event.clientY;
    const initialFrame = coordinate(startX);
    const affected = sequence.clips.filter((item) => ids.includes(item.id));
    const earliest = Math.min(...affected.map((item) => item.start));
    let current: DragPreview = {
      kind: edge ? 'trim' : 'move',
      ids,
      clipId: clip.id,
      edge,
      delta: 0,
    };
    let didMove = false;
    listenPointer(
      (pointer) => {
        if (!didMove && Math.abs(pointer.clientX - startX) + Math.abs(pointer.clientY - startY) < 3)
          return;
        didMove = true;
        const rawDelta = coordinate(pointer.clientX) - initialFrame;
        let delta = rawDelta;
        let snapped: number | undefined;
        if (edge) {
          const position = edge === 'start' ? clip.start : clip.start + clip.duration;
          const result = snapAt(position + delta, ids);
          delta = result.value - position;
          snapped = result.snapFrame;
          const asset = assetMap.get(clip.assetId);
          const finiteSource =
            asset && (asset.kind === 'audio' || asset.kind === 'video') && !clip.loop;
          if (edge === 'start') {
            const minimum = finiteSource
              ? Math.max(-clip.start, -Math.floor(clip.sourceIn * sequence.fps))
              : -clip.start;
            delta = Math.max(minimum, Math.min(clip.duration - 1, delta));
          } else {
            const maximum = finiteSource
              ? Math.max(
                  0,
                  Math.floor((asset.duration - clip.sourceIn) * sequence.fps) - clip.duration,
                )
              : Infinity;
            delta = Math.max(1 - clip.duration, Math.min(maximum, delta));
          }
          if (delta !== result.value - position) snapped = undefined;
        } else {
          let bestDistance = Infinity;
          for (const moving of affected) {
            for (const boundary of [moving.start, moving.start + moving.duration]) {
              const result = snapAt(boundary + rawDelta, ids);
              const distance = Math.abs(result.value - boundary - rawDelta);
              if (result.snapFrame !== undefined && distance < bestDistance) {
                bestDistance = distance;
                delta = result.value - boundary;
                snapped = result.snapFrame;
              }
            }
          }
          delta = Math.max(-earliest, delta);
        }
        const targetElement = document
          .elementFromPoint(pointer.clientX, pointer.clientY)
          ?.closest<HTMLElement>('[data-vtl-track]');
        const targetId = targetElement?.dataset.vtlTrack;
        const target = targetId ? trackMap.get(targetId) : undefined;
        const targetTrackId =
          !edge && target && !target.locked && target.kind === track?.kind ? target.id : undefined;
        current = {
          kind: edge ? 'trim' : 'move',
          ids,
          clipId: clip.id,
          edge,
          delta,
          targetTrackId,
          snapFrame: snapped,
        };
        setPreview(current);
        setStatus(
          `${edge ? (edge === 'start' ? '调整入点' : '调整出点') : '移动片段'} ${delta >= 0 ? '+' : ''}${delta} 帧${snapped !== undefined ? ' · 已吸附' : ''}`,
        );
        const viewport = viewportRef.current;
        if (viewport) {
          const viewportRect = viewport.getBoundingClientRect();
          if (pointer.clientX > viewportRect.right - 35) viewport.scrollLeft += 14;
          else if (pointer.clientX < viewportRect.left + HEADER_WIDTH + 25)
            viewport.scrollLeft = Math.max(0, viewport.scrollLeft - 14);
        }
      },
      () => {
        setPreview(null);
        if (viewportRef.current?.closest('fieldset:disabled')) return;
        if (!didMove) return;
        if (edge && current.delta !== 0) props.onTrim(clip.id, edge, current.delta);
        else if (
          !edge &&
          (current.delta !== 0 || (current.targetTrackId && current.targetTrackId !== clip.trackId))
        ) {
          props.onMove(ids, current.delta, current.targetTrackId);
        }
      },
    );
  }

  function beginSeek(event: ReactPointerEvent) {
    if (event.currentTarget.closest('fieldset:disabled')) return;
    if (event.button !== 0) return;
    event.preventDefault();
    viewportRef.current?.focus();
    onSeek(coordinate(event.clientX));
    listenPointer(
      (pointer) => onSeek(coordinate(pointer.clientX)),
      (pointer) => onSeek(coordinate(pointer.clientX)),
    );
  }

  function beginBox(event: ReactPointerEvent) {
    if (event.currentTarget.closest('fieldset:disabled')) return;
    if (event.button !== 0 || event.target !== event.currentTarget) return;
    event.preventDefault();
    viewportRef.current?.focus();
    const rect = surfaceRef.current!.getBoundingClientRect();
    const startX = event.clientX - rect.left;
    const startY = event.clientY - rect.top;
    const initialIds = event.shiftKey || event.metaKey || event.ctrlKey ? selectedIds : [];
    let last: SelectionBox | null = null;
    listenPointer(
      (pointer) => {
        const currentRect = surfaceRef.current!.getBoundingClientRect();
        last = {
          startX,
          startY,
          x: pointer.clientX - currentRect.left,
          y: pointer.clientY - currentRect.top,
        };
        if (Math.abs(last.x - startX) + Math.abs(last.y - startY) > 4) setSelectionBox(last);
      },
      () => {
        if (!last || Math.abs(last.x - startX) + Math.abs(last.y - startY) <= 4) {
          onSelect(initialIds);
          onSeek(coordinate(event.clientX));
        } else {
          const box = last as SelectionBox;
          const left = Math.min(box.startX, box.x) - HEADER_WIDTH;
          const right = Math.max(box.startX, box.x) - HEADER_WIDTH;
          const top = Math.min(box.startY, box.y) - RULER_HEIGHT;
          const bottom = Math.max(box.startY, box.y) - RULER_HEIGHT;
          const hits = sequence.clips
            .filter((clip) => {
              const index = sequence.tracks.findIndex((track) => track.id === clip.trackId);
              return (
                clip.start * pxPerFrame < right &&
                (clip.start + clip.duration) * pxPerFrame > left &&
                index * TRACK_HEIGHT < bottom &&
                (index + 1) * TRACK_HEIGHT > top
              );
            })
            .map((clip) => clip.id);
          onSelect([...new Set([...initialIds, ...hits])]);
        }
        setSelectionBox(null);
      },
    );
  }

  function zoom(factor: number) {
    const viewport = viewportRef.current;
    const oldScale = pxPerFrame;
    const next = Math.max(0.2, Math.min(1800, pixelsPerSecond * factor));
    const anchor = viewport
      ? (viewport.scrollLeft + Math.max(0, viewport.clientWidth - HEADER_WIDTH) / 2) / oldScale
      : frame;
    setPixelsPerSecond(next);
    requestAnimationFrame(() => {
      if (viewport)
        viewport.scrollLeft =
          (anchor * next) / sequence.fps - Math.max(0, viewport.clientWidth - HEADER_WIDTH) / 2;
    });
  }

  function fitTimeline() {
    setPixelsPerSecond(
      Math.max(
        0.2,
        Math.min(1800, (viewportWidth - HEADER_WIDTH - 42) / Math.max(5, duration / sequence.fps)),
      ),
    );
    if (viewportRef.current) viewportRef.current.scrollLeft = 0;
  }

  function displayClip(clip: VideoClip): VideoClip {
    if (!preview?.ids.includes(clip.id)) return clip;
    if (preview.kind === 'move') {
      let trackId = clip.trackId;
      const source = sequence.clips.find((item) => item.id === preview.clipId);
      const sourceTrack = source && trackMap.get(source.trackId);
      if (
        preview.targetTrackId &&
        sourceTrack &&
        trackMap.get(clip.trackId)?.kind === sourceTrack.kind
      ) {
        const tracks = sequence.tracks.filter((track) => track.kind === sourceTrack.kind);
        const offset =
          tracks.findIndex((track) => track.id === preview.targetTrackId) -
          tracks.findIndex((track) => track.id === sourceTrack.id);
        trackId =
          tracks[tracks.findIndex((track) => track.id === clip.trackId) + offset]?.id ??
          clip.trackId;
      }
      return { ...clip, start: clip.start + preview.delta, trackId };
    }
    return preview.edge === 'start'
      ? {
          ...clip,
          start: clip.start + preview.delta,
          duration: clip.duration - preview.delta,
          sourceIn: clip.sourceIn + preview.delta / sequence.fps,
        }
      : { ...clip, duration: clip.duration + preview.delta };
  }

  return (
    <section className="vtl-panel" aria-label="视频时间线">
      <div className="vtl-toolbar">
        <div className="vtl-toolgroup">
          <button
            type="button"
            aria-label="选择工具 V"
            title="选择工具 (V)"
            className={tool === 'select' ? 'vtl-active' : ''}
            onClick={() => setTool('select')}
          >
            <MousePointer2 size={15} />
          </button>
          <button
            type="button"
            aria-label="剃刀工具 C"
            title="剃刀工具 (C)：单击片段分割"
            className={tool === 'razor' ? 'vtl-active' : ''}
            disabled={!props.onCut}
            onClick={() => setTool('razor')}
          >
            <Scissors size={15} />
          </button>
          <button
            type="button"
            aria-label="时间线吸附"
            aria-pressed={snapping}
            title="吸附片段边缘、标记和播放头"
            className={snapping ? 'vtl-active' : ''}
            onClick={() => setSnapping(!snapping)}
          >
            <Magnet size={15} />
          </button>
        </div>
        <div className="vtl-toolgroup">
          <button
            type="button"
            title="撤销 (⌘/Ctrl+Z)"
            aria-label="视频撤销"
            disabled={!props.canUndo}
            onClick={props.onUndo}
          >
            <Undo2 size={15} />
          </button>
          <button
            type="button"
            title="重做 (⌘/Ctrl+Shift+Z)"
            aria-label="视频重做"
            disabled={!props.canRedo}
            onClick={props.onRedo}
          >
            <Redo2 size={15} />
          </button>
          <button
            type="button"
            disabled={!canEdit}
            onClick={props.onSplit}
            title="在播放头分割所选片段"
          >
            <Scissors size={14} />
            分割
          </button>
          <button
            type="button"
            disabled={!canEdit}
            onClick={props.onDuplicate}
            title="复制所选片段"
          >
            <Copy size={14} />
          </button>
          <button
            type="button"
            disabled={!canEdit}
            onClick={() => props.onDelete(false)}
            title="删除 (Delete)"
            aria-label="删除片段"
          >
            <Trash2 size={14} />
          </button>
          <button
            type="button"
            disabled={!canEdit}
            onClick={() => props.onDelete(true)}
            title="删除并关闭空隙 (Shift+Delete)"
          >
            波纹删除
          </button>
        </div>
        <div className="vtl-toolgroup">
          <button
            type="button"
            disabled={!canEdit || selectedClips.length < 2}
            title="将所选片段成组"
            onClick={props.onGroup}
          >
            <Group size={14} />
            成组
          </button>
          <button
            type="button"
            disabled={!canEdit || !selectedClips.some((clip) => clip.groupId)}
            title="解除编组"
            aria-label="解除编组"
            onClick={props.onUngroup}
          >
            <Ungroup size={14} />
          </button>
          <button
            type="button"
            disabled={!canEdit || !selectedClips.some((clip) => clip.linkId)}
            title="解除音视频关联"
            aria-label="解除音视频关联"
            onClick={props.onUnlink}
          >
            <Link2Off size={14} />
          </button>
        </div>
        <div className="vtl-toolgroup vtl-transition-control">
          <label title="叠化持续秒数">
            <input
              aria-label="叠化秒数"
              type="number"
              value={transitionSeconds}
              min={1 / sequence.fps}
              max={30}
              step={0.1}
              onChange={(event) =>
                setTransitionSeconds(
                  Math.max(1 / sequence.fps, Number(event.target.value) || 1 / sequence.fps),
                )
              }
            />
            <span>秒</span>
          </label>
          <button
            type="button"
            disabled={!canEdit || selectedClips.length < 2}
            title="对选中的相邻片段添加叠化"
            onClick={() => props.onTransition(Math.round(transitionSeconds * sequence.fps))}
          >
            叠化
          </button>
        </div>
        <div className="vtl-toolgroup vtl-zoom-controls">
          <button
            type="button"
            aria-label="缩小时间线"
            title="缩小时间线"
            onClick={() => zoom(1 / 1.4)}
          >
            <ZoomOut size={15} />
          </button>
          <input
            aria-label="时间线缩放"
            type="range"
            min={Math.log(0.2)}
            max={Math.log(1800)}
            step={0.01}
            value={Math.log(pixelsPerSecond)}
            onChange={(event) => setPixelsPerSecond(Math.exp(Number(event.target.value)))}
          />
          <button
            type="button"
            aria-label="放大时间线"
            title="放大时间线"
            onClick={() => zoom(1.4)}
          >
            <ZoomIn size={15} />
          </button>
          <button type="button" onClick={fitTimeline}>
            适应全片
          </button>
        </div>
      </div>
      <div
        className={`vtl-viewport ${tool === 'razor' ? 'vtl-razor' : ''}`}
        ref={viewportRef}
        tabIndex={0}
        aria-label="时间线编辑区"
        onScroll={(event) => setScrollLeft(event.currentTarget.scrollLeft)}
        onKeyDown={(event) => {
          if (event.currentTarget.closest('fieldset:disabled')) return;
          if ((event.target as HTMLElement).closest('input,textarea,select,button')) return;
          const key = event.key.toLowerCase();
          const command = event.metaKey || event.ctrlKey;
          if (command && key === 'z') {
            event.preventDefault();
            event.stopPropagation();
            event.shiftKey ? props.onRedo() : props.onUndo();
          } else if (key === 'delete' || key === 'backspace') {
            event.preventDefault();
            event.stopPropagation();
            if (canEdit) props.onDelete(event.shiftKey);
          } else if (!command && (key === 'v' || key === 'c')) {
            event.preventDefault();
            event.stopPropagation();
            setTool(key === 'c' && props.onCut ? 'razor' : 'select');
          } else if (!command && (key === 'arrowleft' || key === 'arrowright')) {
            event.preventDefault();
            event.stopPropagation();
            onSeek(
              Math.max(
                0,
                frame + (key === 'arrowleft' ? -1 : 1) * (event.shiftKey ? sequence.fps : 1),
              ),
            );
          } else if (key === 'home' || key === 'end') {
            event.preventDefault();
            event.stopPropagation();
            onSeek(key === 'home' ? 0 : Math.max(0, duration - 1));
          } else if (key === 'escape') {
            cleanupRef.current?.();
            setPreview(null);
            setSelectionBox(null);
            onSelect([]);
          } else if (key === '+' || key === '=') {
            event.preventDefault();
            zoom(1.4);
          } else if (key === '-') {
            event.preventDefault();
            zoom(1 / 1.4);
          }
        }}
      >
        <div
          className="vtl-surface"
          ref={surfaceRef}
          style={{
            width: contentWidth + HEADER_WIDTH,
            minHeight: RULER_HEIGHT + sequence.tracks.length * TRACK_HEIGHT,
          }}
        >
          <div className="vtl-ruler-row">
            <div className="vtl-timecode">
              {formatTimelineTime(frame, sequence.fps)}
              <small>{sequence.fps} fps</small>
            </div>
            <div className="vtl-ruler" style={{ width: contentWidth }} onPointerDown={beginSeek}>
              {Array.from({ length: tickCount }, (_, offset) => {
                const index = firstTick + offset;
                return (
                  <span
                    key={index}
                    className="vtl-tick"
                    style={{ left: index * tickFrames * pxPerFrame }}
                  >
                    <span>{formatTimelineTime(index * tickFrames, sequence.fps)}</span>
                  </span>
                );
              })}
              {sequence.markers.map((marker) => (
                <button
                  key={marker.id}
                  type="button"
                  className="vtl-marker"
                  style={{ left: marker.frame * pxPerFrame }}
                  title={`${marker.label} · ${formatTimelineTime(marker.frame, sequence.fps)}`}
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    onSeek(marker.frame);
                  }}
                >
                  ◆<span>{marker.label}</span>
                </button>
              ))}
            </div>
          </div>
          {sequence.tracks.map((track, trackIndex) => (
            <div
              key={track.id}
              className={`vtl-track ${track.locked ? 'vtl-locked' : ''} ${track.hidden || track.muted ? 'vtl-dimmed' : ''}`}
              data-vtl-track={track.id}
            >
              <div className="vtl-track-header">
                <div className="vtl-track-name">
                  {track.kind === 'video' ? <Film size={13} /> : <Music2 size={13} />}
                  <input
                    aria-label={`轨道名称 ${track.name}`}
                    key={`${track.id}-${track.name}`}
                    defaultValue={track.name}
                    onBlur={(event) => {
                      const name = event.target.value.trim();
                      if (name && name !== track.name) props.onTrackChange(track.id, { name });
                      else event.target.value = track.name;
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur();
                    }}
                  />
                  <span className="vtl-track-order">
                    <button
                      type="button"
                      disabled={trackIndex === 0 || track.locked}
                      aria-label={`${track.name} 上移`}
                      onClick={() => props.onTrackMove(track.id, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      disabled={trackIndex === sequence.tracks.length - 1 || track.locked}
                      aria-label={`${track.name} 下移`}
                      onClick={() => props.onTrackMove(track.id, 1)}
                    >
                      ↓
                    </button>
                  </span>
                </div>
                <div className="vtl-track-switches">
                  <button
                    type="button"
                    aria-label={`${track.name} ${track.locked ? '解锁' : '锁定'}`}
                    title={track.locked ? '解锁轨道' : '锁定轨道'}
                    className={track.locked ? 'vtl-active' : ''}
                    onClick={() => {
                      props.onTrackChange(track.id, { locked: !track.locked });
                      setStatus(track.locked ? '轨道已解锁，可以继续剪辑。' : '轨道已锁定。');
                    }}
                  >
                    {track.locked ? <Lock size={12} /> : <Unlock size={12} />}
                  </button>
                  {track.kind === 'video' && (
                    <button
                      type="button"
                      aria-label={`${track.name} ${track.hidden ? '显示' : '隐藏'}`}
                      title="显示 / 隐藏画面"
                      className={track.hidden ? 'vtl-active' : ''}
                      onClick={() => props.onTrackChange(track.id, { hidden: !track.hidden })}
                    >
                      {track.hidden ? <EyeOff size={12} /> : <Eye size={12} />}
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label={`${track.name} ${track.muted ? '取消静音' : '静音'}`}
                    title="静音轨道"
                    className={track.muted ? 'vtl-active' : ''}
                    onClick={() => props.onTrackChange(track.id, { muted: !track.muted })}
                  >
                    {track.muted ? <VolumeX size={12} /> : <Volume2 size={12} />}
                  </button>
                  {track.kind === 'audio' && (
                    <button
                      type="button"
                      aria-label={`${track.name} 独听`}
                      title="独听此音轨"
                      aria-pressed={track.solo}
                      className={track.solo ? 'vtl-active' : ''}
                      onClick={() => props.onTrackChange(track.id, { solo: !track.solo })}
                    >
                      S
                    </button>
                  )}
                  <label className="vtl-track-volume" title="轨道音量">
                    <input
                      aria-label={`${track.name} 音量`}
                      type="number"
                      min={0}
                      max={400}
                      step={5}
                      value={Math.round(track.volume * 100)}
                      onChange={(event) =>
                        props.onTrackChange(track.id, {
                          volume: Math.max(0, Math.min(4, Number(event.target.value) / 100)),
                        })
                      }
                    />
                    <span>%</span>
                  </label>
                  <button
                    type="button"
                    aria-label={`删除轨道 ${track.name}`}
                    title="删除空轨道"
                    disabled={
                      track.locked || sequence.clips.some((clip) => clip.trackId === track.id)
                    }
                    onClick={() => props.onTrackDelete(track.id)}
                  >
                    <Minus size={12} />
                  </button>
                </div>
              </div>
              <div
                className="vtl-track-lane"
                style={{ width: contentWidth, backgroundSize: `${tickFrames * pxPerFrame}px 100%` }}
                onPointerDown={beginBox}
                onDragOver={(event) => {
                  if (event.currentTarget.closest('fieldset:disabled')) return;
                  if (track.locked) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'copy';
                  const id =
                    event.dataTransfer.getData('application/x-teditor-asset') ||
                    event.dataTransfer.getData('text/plain') ||
                    draggedAssetRef.current;
                  const asset = assetMap.get(id);
                  if (
                    !asset ||
                    (track.kind === 'video' && asset.kind === 'audio') ||
                    (track.kind === 'audio' && !asset.hasAudio && asset.kind !== 'audio')
                  ) {
                    setDropPreview(null);
                    event.dataTransfer.dropEffect = 'none';
                    return;
                  }
                  const at = snapAt(coordinate(event.clientX)).value;
                  const rangeDuration = props.getAssetRange?.(id).duration;
                  setDropPreview({
                    trackId: track.id,
                    frame: at,
                    assetId: id,
                    duration:
                      rangeDuration !== undefined && Number.isFinite(rangeDuration)
                        ? Math.max(1, Math.floor(rangeDuration))
                        : asset.kind === 'audio' || asset.kind === 'video'
                          ? Math.max(1, Math.floor(Math.min(25, asset.duration) * sequence.fps))
                          : sequence.fps * 5,
                  });
                }}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                    setDropPreview(null);
                }}
                onDrop={(event) => {
                  if (event.currentTarget.closest('fieldset:disabled')) return;
                  event.preventDefault();
                  setDropPreview(null);
                  if (track.locked) {
                    setStatus('此轨道已锁定，无法放入素材。');
                    return;
                  }
                  const id =
                    event.dataTransfer.getData('application/x-teditor-asset') ||
                    event.dataTransfer.getData('text/plain');
                  const asset = assetMap.get(id);
                  if (!asset) return;
                  if (
                    (track.kind === 'video' && asset.kind === 'audio') ||
                    (track.kind === 'audio' && !asset.hasAudio && asset.kind !== 'audio')
                  ) {
                    setStatus('此素材与轨道类型不匹配。');
                    return;
                  }
                  props.onDropAsset(id, track.id, snapAt(coordinate(event.clientX)).value);
                }}
              >
                {sequence.clips
                  .map(displayClip)
                  .filter((clip) => clip.trackId === track.id)
                  .map((clip) => {
                    const asset = assetMap.get(clip.assetId);
                    const selected = selectedIds.includes(clip.id);
                    const kind = track.kind === 'audio' ? 'audio' : (asset?.kind ?? 'image');
                    return (
                      <div
                        key={clip.id}
                        className={`vtl-clip vtl-kind-${kind} ${selected ? 'vtl-selected' : ''} ${preview?.ids.includes(clip.id) ? 'vtl-dragging' : ''}`}
                        style={{
                          left: clip.start * pxPerFrame,
                          width: Math.max(3, clip.duration * pxPerFrame),
                        }}
                        data-clip-id={clip.id}
                        role="button"
                        tabIndex={-1}
                        aria-label={`${clip.name}，${formatTimelineTime(clip.start, sequence.fps)}，${clip.duration} 帧`}
                        aria-pressed={selected}
                        title={`${clip.name}\n${formatTimelineTime(clip.start, sequence.fps)} → ${formatTimelineTime(clip.start + clip.duration, sequence.fps)}\n${clip.duration} 帧 · ${(clip.duration / sequence.fps).toFixed(2)} 秒${clip.linkId ? '\n关联音视频' : ''}${clip.groupId ? '\n属于编组' : ''}`}
                        onPointerDown={(event) =>
                          beginClipDrag(
                            event,
                            sequence.clips.find((item) => item.id === clip.id)!,
                          )
                        }
                      >
                        <div className="vtl-clip-label">
                          {clip.groupId && <Group size={10} />}
                          {clip.linkId && <span className="vtl-linked">↔</span>}
                          <span>{clip.name}</span>
                        </div>
                        {track.kind === 'video' && asset?.thumbnail && (
                          <img
                            className="vtl-thumbnail"
                            src={asset.thumbnail}
                            alt=""
                            draggable={false}
                          />
                        )}
                        {asset && (kind === 'audio' || asset.hasAudio) && (
                          <Waveform
                            asset={asset}
                            clip={clip}
                            fps={sequence.fps}
                            pixelsPerSecond={pixelsPerSecond}
                            startPixel={Math.max(0, scrollLeft - clip.start * pxPerFrame - 8)}
                            width={Math.max(
                              0,
                              Math.min(
                                clip.duration * pxPerFrame,
                                scrollLeft +
                                  viewportWidth -
                                  HEADER_WIDTH -
                                  clip.start * pxPerFrame +
                                  8,
                              ) - Math.max(0, scrollLeft - clip.start * pxPerFrame - 8),
                            )}
                          />
                        )}
                        {kind === 'text' && <div className="vtl-text-preview">{asset?.text}</div>}
                        {kind === 'color' && (
                          <div className="vtl-color-preview" style={{ background: asset?.color }} />
                        )}
                        {clip.fadeIn > 0 && (
                          <span
                            className="vtl-fade vtl-fade-in"
                            style={{ width: Math.min(clip.duration, clip.fadeIn) * pxPerFrame }}
                          />
                        )}
                        {clip.fadeOut > 0 && (
                          <span
                            className="vtl-fade vtl-fade-out"
                            style={{ width: Math.min(clip.duration, clip.fadeOut) * pxPerFrame }}
                          />
                        )}
                        <span
                          className="vtl-trim-handle vtl-trim-start"
                          role="separator"
                          aria-label={`${clip.name} 入点裁切`}
                          onPointerDown={(event) =>
                            beginClipDrag(
                              event,
                              sequence.clips.find((item) => item.id === clip.id)!,
                              'start',
                            )
                          }
                        />
                        <span
                          className="vtl-trim-handle vtl-trim-end"
                          role="separator"
                          aria-label={`${clip.name} 出点裁切`}
                          onPointerDown={(event) =>
                            beginClipDrag(
                              event,
                              sequence.clips.find((item) => item.id === clip.id)!,
                              'end',
                            )
                          }
                        />
                      </div>
                    );
                  })}
                {sequence.transitions.map((transition) => {
                  const from = sequence.clips.find((clip) => clip.id === transition.fromClipId);
                  const to = sequence.clips.find((clip) => clip.id === transition.toClipId);
                  if (!from || !to || from.trackId !== track.id) return null;
                  return (
                    <div
                      className="vtl-crossfade"
                      key={transition.id}
                      style={{
                        left: to.start * pxPerFrame,
                        width: Math.max(3, transition.duration * pxPerFrame),
                      }}
                      title={`叠化 ${(transition.duration / sequence.fps).toFixed(2)} 秒`}
                    >
                      ×
                    </div>
                  );
                })}
                {dropPreview?.trackId === track.id && (
                  <div
                    className="vtl-drop-preview"
                    style={{
                      left: dropPreview.frame * pxPerFrame,
                      width: dropPreview.duration * pxPerFrame,
                    }}
                  >
                    + {assetMap.get(dropPreview.assetId)?.name ?? '素材'}
                  </div>
                )}
                {props.operationPreview?.trackId === track.id &&
                  props.operationPreview.duration > 0 && (
                    <div
                      className={`vtl-operation-preview vtl-operation-${props.operationPreview.mode}`}
                      data-operation-mode={props.operationPreview.mode}
                      data-start={props.operationPreview.start}
                      data-duration={props.operationPreview.duration}
                      style={{
                        left: props.operationPreview.start * pxPerFrame,
                        width: Math.max(2, props.operationPreview.duration * pxPerFrame),
                      }}
                      title={`${formatTimelineTime(props.operationPreview.start, sequence.fps)} → ${formatTimelineTime(props.operationPreview.start + props.operationPreview.duration, sequence.fps)} · ${props.operationPreview.duration} 帧`}
                    >
                      <span>
                        {props.operationPreview.mode === 'insert'
                          ? '插入·后移同步轨道'
                          : '覆盖此区间（含关联原声）'}
                      </span>
                    </div>
                  )}
              </div>
            </div>
          ))}
          {frame * pxPerFrame >= scrollLeft && (
            <div
              className="vtl-playhead"
              style={{
                left: HEADER_WIDTH + frame * pxPerFrame,
                height: Math.max(
                  RULER_HEIGHT,
                  RULER_HEIGHT + sequence.tracks.length * TRACK_HEIGHT,
                ),
              }}
            >
              <div onPointerDown={beginSeek} />
            </div>
          )}
          {preview?.snapFrame !== undefined && (
            <div
              className="vtl-snap-line"
              style={{ left: HEADER_WIDTH + preview.snapFrame * pxPerFrame }}
            />
          )}
          {selectionBox && (
            <div
              className="vtl-selection-box"
              style={{
                left: Math.min(selectionBox.startX, selectionBox.x),
                top: Math.min(selectionBox.startY, selectionBox.y),
                width: Math.abs(selectionBox.x - selectionBox.startX),
                height: Math.abs(selectionBox.y - selectionBox.startY),
              }}
            />
          )}
        </div>
      </div>
      <div className="vtl-footer">
        <button type="button" onClick={() => props.onTrackAdd('video')}>
          <Plus size={12} />
          视频轨
        </button>
        <button type="button" onClick={() => props.onTrackAdd('audio')}>
          <Plus size={12} />
          音频轨
        </button>
        <span className="vtl-status" role="status">
          {selectionLocked
            ? '选区包含锁定轨道'
            : preview
              ? status
              : selectedClips.length
                ? `已选 ${selectedClips.length} 个片段 · ${status}`
                : status}
        </span>
        <span className="vtl-duration">
          总时长 {formatTimelineTime(duration, sequence.fps)} · {duration} 帧
        </span>
      </div>
    </section>
  );
}
