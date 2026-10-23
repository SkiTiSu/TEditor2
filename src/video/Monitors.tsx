import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Pause, Play, Maximize2 } from 'lucide-react';
import type { MediaAsset, VideoClip, VideoProject, VideoSequence } from './types';
import type { MediaLibrary } from './media';
import type { SequenceRenderer } from './compositor';

export function timecode(frames: number, fps: number) {
  const n = Math.max(0, Math.round(frames));
  const seconds = Math.floor(n / fps);
  return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}:${String(n % fps).padStart(2, '0')}`;
}

export function SourceMonitor({
  asset,
  media,
  fps,
  sourceIn,
  sourceOut,
  onRange,
  onInsert,
  onOverwrite,
  visible,
  programPlaying,
  onPlaySource,
  graphicPreview,
  onOperationPreview,
}: {
  asset?: MediaAsset;
  media: MediaLibrary;
  fps: number;
  sourceIn: number;
  sourceOut: number;
  onRange: (start: number, end: number) => void;
  onInsert: () => void;
  onOverwrite: () => void;
  visible: boolean;
  programPlaying: boolean;
  onPlaySource: () => void;
  graphicPreview?: ReactNode;
  onOperationPreview?: (mode: 'insert' | 'overwrite' | null) => void;
}) {
  const player = useRef<HTMLVideoElement>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const src = asset && media.has(asset.id) ? media.getUrl(asset.id) : undefined;
  useEffect(() => {
    setTime(0);
    setPlaying(false);
  }, [asset?.id]);
  useEffect(() => {
    if (!visible || programPlaying) player.current?.pause();
  }, [visible, programPlaying]);
  useEffect(() => {
    const element = player.current;
    return () => element?.pause();
  }, [src]);
  function seek(t: number) {
    const value = Math.max(0, Math.min(asset?.duration || 0, t));
    if (player.current) player.current.currentTime = value;
    setTime(value);
  }
  function stepFrame(direction: number) {
    const at = player.current?.currentTime ?? time;
    player.current?.pause();
    seek(at + direction / fps);
  }
  function mark(edge: 'in' | 'out') {
    const duration = asset?.duration || 0;
    if (!duration) return;
    const at = Math.max(0, Math.min(player.current?.currentTime ?? time, duration));
    if (edge === 'in') {
      const start = Math.min(at, Math.max(0, duration - 1 / fps));
      onRange(start, Math.min(duration, Math.max(sourceOut, start + 1 / fps)));
    } else {
      const end = Math.min(
        duration,
        Math.max(at, Math.min(sourceIn, duration - 1 / fps) + 1 / fps),
      );
      onRange(Math.max(0, Math.min(sourceIn, end - 1 / fps)), end);
    }
  }
  const moving = asset?.kind === 'video' || asset?.kind === 'audio';
  return (
    <section
      className="ve-monitor ve-source"
      aria-label="源预览"
      onKeyDown={(e) => {
        if ((e.target as HTMLElement).matches('input,textarea,select')) return;
        if (e.code === 'Space' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          e.stopPropagation();
          if (e.code === 'Space') {
            if (player.current?.paused) void player.current.play().catch(() => {});
            else player.current?.pause();
          } else {
            stepFrame(e.key === 'ArrowLeft' ? -1 : 1);
          }
        }
        if (e.key.toLowerCase() === 'i') {
          e.preventDefault();
          mark('in');
        }
        if (e.key.toLowerCase() === 'o') {
          e.preventDefault();
          mark('out');
        }
      }}
      tabIndex={0}
    >
      <div className="ve-panel-heading">
        <span>源预览</span>
        <span>{asset?.name || '双击素材选择片段'}</span>
      </div>
      <div className="ve-viewer">
        {moving && src ? (
          <video
            ref={player}
            src={src}
            playsInline
            preload="metadata"
            onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
            onPlay={() => {
              setPlaying(true);
              onPlaySource();
            }}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
            aria-label="源视频"
          />
        ) : graphicPreview ? (
          graphicPreview
        ) : asset?.thumbnail ? (
          <img src={asset.thumbnail} alt={asset.name} />
        ) : asset?.kind === 'text' ? (
          <div style={{ color: asset.color }}>{asset.text}</div>
        ) : asset?.kind === 'color' ? (
          <div style={{ background: asset.color, width: '100%', height: '100%' }} />
        ) : (
          <div className="ve-empty">
            {asset ? '关联图文 · 加入时间线后预览' : '导入视频，设置入点和出点'}
          </div>
        )}
        {asset?.kind === 'audio' && <div className="ve-audio-badge">♫ {asset.name}</div>}
      </div>
      {moving && !!asset.waveform?.length && (
        <svg
          className="ve-source-waveform"
          viewBox="0 0 480 32"
          preserveAspectRatio="none"
          aria-label="素材音频波形"
        >
          {asset.waveform.map((value, i) => (
            <line
              key={i}
              x1={(i * 480) / asset.waveform!.length}
              x2={(i * 480) / asset.waveform!.length}
              y1={16 - Math.min(1, value) * 15}
              y2={16 + Math.min(1, value) * 15}
              stroke="currentColor"
              strokeWidth="2"
            />
          ))}
        </svg>
      )}
      {moving && (
        <input
          aria-label="源视频位置"
          type="range"
          min={0}
          max={asset.duration || 1}
          step={1 / fps}
          value={Math.min(time, asset.duration)}
          onChange={(e) => seek(Number(e.target.value))}
        />
      )}
      <div className="ve-transport">
        <button aria-label="源上一帧" disabled={!moving || !src} onClick={() => stepFrame(-1)}>
          <ChevronLeft size={15} />
        </button>
        <button
          aria-label={playing ? '暂停源视频' : '播放源视频'}
          disabled={!moving || !src}
          onClick={() => {
            if (player.current) {
              if (playing) player.current.pause();
              else void player.current.play().catch(() => {});
            }
          }}
        >
          {playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <button aria-label="源下一帧" disabled={!moving || !src} onClick={() => stepFrame(1)}>
          <ChevronRight size={15} />
        </button>
        <code>{timecode(time * fps, fps)}</code>
        <button disabled={!moving} title="I" onClick={() => mark('in')}>
          设入点
        </button>
        <button disabled={!moving} title="O" onClick={() => mark('out')}>
          设出点
        </button>
      </div>
      <div className="ve-source-range">
        <label>
          入点 / 秒
          <input
            aria-label="素材入点"
            type="number"
            min={0}
            step={0.1}
            value={sourceIn}
            disabled={!moving}
            onChange={(e) => onRange(Number(e.target.value), sourceOut)}
          />
        </label>
        <label>
          出点 / 秒
          <input
            aria-label="素材出点"
            type="number"
            min={0}
            step={0.1}
            value={sourceOut}
            disabled={!moving}
            onChange={(e) => onRange(sourceIn, Number(e.target.value))}
          />
        </label>
        <span>{Math.max(0, sourceOut - sourceIn).toFixed(2)} s</span>
        <button
          disabled={!asset}
          onMouseEnter={() => onOperationPreview?.('insert')}
          onMouseLeave={() => onOperationPreview?.(null)}
          onFocus={() => onOperationPreview?.('insert')}
          onBlur={() => onOperationPreview?.(null)}
          onClick={() => {
            onOperationPreview?.(null);
            onInsert();
          }}
        >
          插入
        </button>
        <button
          disabled={!asset}
          onMouseEnter={() => onOperationPreview?.('overwrite')}
          onMouseLeave={() => onOperationPreview?.(null)}
          onFocus={() => onOperationPreview?.('overwrite')}
          onBlur={() => onOperationPreview?.(null)}
          onClick={() => {
            onOperationPreview?.(null);
            onOverwrite();
          }}
        >
          覆盖
        </button>
      </div>
    </section>
  );
}

export function ProgramMonitor({
  project,
  sequence,
  renderer,
  frame,
  onFrame,
  playing,
  onPlaying,
  visible,
  revision,
  selected,
  onTransform,
  onError,
}: {
  project: VideoProject;
  sequence: VideoSequence;
  renderer: SequenceRenderer;
  frame: number;
  onFrame: (n: number) => void;
  playing: boolean;
  onPlaying: (v: boolean) => void;
  visible: boolean;
  revision: number;
  selected?: VideoClip;
  onTransform: (patch: Partial<VideoClip>) => void;
  onError: (error: string) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    viewer = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onFrame, onPlaying, onError });
  callbacks.current = { onFrame, onPlaying, onError };
  const currentFrame = useRef(frame);
  currentFrame.current = frame;
  const [warning, setWarning] = useState('');
  const [level, setLevel] = useState(0);
  const [displaySize, setDisplaySize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = viewer.current;
    if (!element) return;
    const measure = () => {
      const scale = Math.min(
        element.clientWidth / sequence.width,
        element.clientHeight / sequence.height,
      );
      setDisplaySize({ width: sequence.width * scale, height: sequence.height * scale });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [sequence.width, sequence.height, visible]);
  const total = Math.max(0, ...sequence.clips.map((c) => c.start + c.duration));
  useEffect(() => {
    if (!visible || playing || !canvas.current) return;
    const controller = new AbortController();
    const scratch = document.createElement('canvas');
    renderer
      .render(scratch, project, sequence, frame, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted || !canvas.current) return;
        canvas.current.width = scratch.width;
        canvas.current.height = scratch.height;
        canvas.current.getContext('2d')!.drawImage(scratch, 0, 0);
        setWarning(result.warnings.join('；'));
      })
      .catch((e) => {
        if (!controller.signal.aborted) setWarning(String(e instanceof Error ? e.message : e));
      });
    return () => controller.abort();
  }, [project, sequence, renderer, frame, playing, visible, revision]);
  useEffect(() => {
    if (!playing || !visible || !canvas.current || !total) return;
    const controller = new AbortController(),
      audio = new AudioContext({ sampleRate: 48000 });
    const sources = new Set<AudioBufferSourceNode>();
    const local = renderer.fork();
    let raf = 0;
    let base = 0;
    const from = Math.min(currentFrame.current, total - 1) / sequence.fps;
    const end = total / sequence.fps;
    async function mix() {
      let at = from;
      while (!controller.signal.aborted && at < end) {
        if (base + (at - from) > audio.currentTime + 0.6) {
          await new Promise((r) => setTimeout(r, 25));
          continue;
        }
        const buffer = await local.mixAudio(
          project,
          sequence,
          at,
          Math.min(0.25, end - at),
          48000,
          controller.signal,
        );
        if (controller.signal.aborted) break;
        const sound = audio.createBufferSource();
        sound.buffer = buffer;
        sound.connect(audio.destination);
        const target = base + at - from;
        const late = Math.max(0, audio.currentTime - target);
        if (late < buffer.duration) {
          sound.start(Math.max(audio.currentTime, target), late);
          sources.add(sound);
          sound.onended = () => {
            sources.delete(sound);
            sound.disconnect();
          };
        }
        const samples = buffer.getChannelData(0);
        let peak = 0;
        for (let i = 0; i < samples.length; i += 64) peak = Math.max(peak, Math.abs(samples[i]));
        setLevel(peak);
        at += buffer.duration;
      }
    }
    async function draw() {
      if (controller.signal.aborted) return;
      const f = Math.max(
        0,
        Math.floor((from + Math.max(0, audio.currentTime - base)) * sequence.fps),
      );
      if (f >= total) {
        callbacks.current.onFrame(total - 1);
        callbacks.current.onPlaying(false);
        return;
      }
      await local.render(canvas.current!, project, sequence, f, { signal: controller.signal });
      if (!controller.signal.aborted) {
        callbacks.current.onFrame(f);
        raf = requestAnimationFrame(() => {
          void draw().catch(failed);
        });
      }
    }
    function failed(e: unknown) {
      if (!controller.signal.aborted) {
        callbacks.current.onError(e instanceof Error ? e.message : String(e));
        callbacks.current.onPlaying(false);
      }
    }
    void audio
      .resume()
      .then(() => {
        base = audio.currentTime + 0.15;
        void mix().catch(failed);
        void draw().catch(failed);
      })
      .catch(failed);
    return () => {
      controller.abort();
      cancelAnimationFrame(raf);
      for (const source of sources) {
        try {
          source.stop();
        } catch {
          /* already ended */
        }
        source.disconnect();
      }
      void audio.close();
      local.dispose();
      setLevel(0);
    };
  }, [playing, visible, project, sequence, renderer, total, revision]);
  const activeSelection =
    selected &&
    sequence.tracks.find((t) => t.id === selected.trackId)?.kind === 'video' &&
    frame >= selected.start &&
    frame < selected.start + selected.duration;
  function beginTransform(e: React.PointerEvent, resize: boolean) {
    if (!selected || sequence.tracks.find((t) => t.id === selected.trackId)?.locked) return;
    e.preventDefault();
    e.stopPropagation();
    onPlaying(false);
    const start = selected.transform,
      x = e.clientX,
      y = e.clientY;
    const rect = canvas.current!.getBoundingClientRect();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const move = (event: PointerEvent) => {
      const dx = ((event.clientX - x) * sequence.width) / rect.width,
        dy = ((event.clientY - y) * sequence.height) / rect.height;
      const overlay = viewer.current?.querySelector<HTMLElement>('.ve-selection');
      if (overlay) {
        if (resize) {
          overlay.style.width = `${(Math.max(1, start.width + dx) / sequence.width) * 100}%`;
          overlay.style.height = `${(Math.max(1, start.height + dy) / sequence.height) * 100}%`;
        } else {
          overlay.style.left = `${((start.x + dx) / sequence.width) * 100}%`;
          overlay.style.top = `${((start.y + dy) / sequence.height) * 100}%`;
        }
      }
    };
    const finish = (event: PointerEvent) => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', finish);
      target.removeEventListener('pointercancel', cancel);
      const dx = ((event.clientX - x) * sequence.width) / rect.width,
        dy = ((event.clientY - y) * sequence.height) / rect.height;
      onTransform({
        transform: {
          ...start,
          ...(resize
            ? {
                width: Math.max(1, Math.round(start.width + dx)),
                height: Math.max(1, Math.round(start.height + dy)),
              }
            : { x: Math.round(start.x + dx), y: Math.round(start.y + dy) }),
        },
      });
    };
    const cancel = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', finish);
      target.removeEventListener('pointercancel', cancel);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', finish);
    target.addEventListener('pointercancel', cancel);
  }
  return (
    <section className="ve-monitor ve-program" aria-label="节目预览">
      <div className="ve-panel-heading">
        <span>节目预览</span>
        <span>
          {sequence.width} × {sequence.height} · {sequence.fps} fps
        </span>
      </div>
      <div className="ve-viewer" ref={viewer}>
        <div
          className="ve-canvas-wrap"
          style={{
            width: displaySize.width,
            height: displaySize.height,
            aspectRatio: `${sequence.width}/${sequence.height}`,
          }}
        >
          <canvas ref={canvas} aria-label="视频合成画布" />
          {activeSelection && (
            <div
              className="ve-selection"
              onPointerDown={(e) => beginTransform(e, false)}
              style={{
                left: `${(selected.transform.x / sequence.width) * 100}%`,
                top: `${(selected.transform.y / sequence.height) * 100}%`,
                width: `${(selected.transform.width / sequence.width) * 100}%`,
                height: `${(selected.transform.height / sequence.height) * 100}%`,
                transform: `rotate(${selected.transform.rotation}deg)`,
              }}
            >
              <button aria-label="缩放选中片段" onPointerDown={(e) => beginTransform(e, true)} />
            </div>
          )}
        </div>
      </div>
      <div className="ve-transport">
        <button
          aria-label="上一帧"
          onClick={() => {
            onPlaying(false);
            onFrame(Math.max(0, frame - 1));
          }}
        >
          <ChevronLeft size={16} />
        </button>
        <button
          aria-label={playing ? '暂停视频' : '播放视频'}
          disabled={!total}
          onClick={() => {
            if (!playing && frame >= total - 1) onFrame(0);
            onPlaying(!playing);
          }}
        >
          {playing ? <Pause size={17} /> : <Play size={17} />}
        </button>
        <button
          aria-label="下一帧"
          onClick={() => {
            onPlaying(false);
            onFrame(Math.min(Math.max(0, total - 1), frame + 1));
          }}
        >
          <ChevronRight size={16} />
        </button>
        <code>
          {timecode(frame, sequence.fps)} <span>/ {timecode(total, sequence.fps)}</span>
        </code>
        <meter aria-label="音频电平" min={0} max={1} value={Math.min(1, level)} />
        <button
          aria-label="全屏预览"
          onClick={() => void viewer.current?.requestFullscreen().catch(() => {})}
        >
          <Maximize2 size={14} />
        </button>
      </div>
      {warning && (
        <div className="ve-monitor-warning" role="status">
          {warning}
        </div>
      )}
    </section>
  );
}
