import { useEffect, useState, type ReactNode } from 'react';
import { Crop, Image, Link2, Music2, RotateCcw, Settings2, Type } from 'lucide-react';
import type { ClipTransform, MediaAsset, VideoClip, VideoSequence } from './types';
import { formatTimelineTime } from './Timeline';
import './timeline.css';

export interface InspectorProps {
  clip?: VideoClip;
  asset?: MediaAsset;
  sequence: VideoSequence;
  onChange(patch: Partial<VideoClip>): void;
  onAssetChange(patch: Partial<MediaAsset>): void;
  onEditGraphic?(sourceId: string): void;
  onRemoveTransition?(transitionId: string): void;
}

function NumberControl({
  label,
  value,
  onChange,
  min = -Infinity,
  max = Infinity,
  step = 1,
  suffix,
  disabled = false,
}: {
  label: string;
  value: number;
  onChange(value: number): void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  disabled?: boolean;
}) {
  const normalized = Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : 0;
  const [draft, setDraft] = useState(String(normalized));
  useEffect(() => setDraft(String(normalized)), [normalized]);
  function commit() {
    if (draft.trim() === '' || !Number.isFinite(Number(draft))) {
      setDraft(String(normalized));
      return;
    }
    const next = Math.max(min, Math.min(max, Number(draft)));
    // Restore the accepted value first; a rejected edit must not leave a stale draft visible.
    setDraft(String(normalized));
    if (next !== normalized) onChange(next);
  }
  return (
    <label className="vinsp-field">
      <span>{label}</span>
      <div className="vinsp-number-wrap">
        <input
          aria-label={label}
          type="number"
          value={draft}
          min={Number.isFinite(min) ? min : undefined}
          max={Number.isFinite(max) ? max : undefined}
          step={step}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.currentTarget.blur();
            } else if (event.key === 'Escape') {
              setDraft(String(normalized));
            }
          }}
        />
        {suffix && <small>{suffix}</small>}
      </div>
    </label>
  );
}

function TextControl({
  label,
  value,
  onChange,
  multiline = false,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  multiline?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) onChange(draft);
  };
  return (
    <label className="vinsp-field vinsp-full">
      <span>{label}</span>
      {multiline ? (
        <textarea
          aria-label={label}
          rows={4}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
        />
      ) : (
        <input
          aria-label={label}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
        />
      )}
    </label>
  );
}

function Section({
  title,
  icon,
  children,
  initiallyOpen = true,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
  initiallyOpen?: boolean;
}) {
  return (
    <details className="vinsp-section" open={initiallyOpen}>
      <summary>
        {icon}
        <span>{title}</span>
      </summary>
      <div className="vinsp-section-content">{children}</div>
    </details>
  );
}

export function Inspector({
  clip,
  asset,
  sequence,
  onChange,
  onAssetChange,
  onEditGraphic,
  onRemoveTransition,
}: InspectorProps) {
  const track = clip ? sequence.tracks.find((item) => item.id === clip.trackId) : undefined;
  const isAudio = track?.kind === 'audio' || asset?.kind === 'audio';
  const locked = track?.locked ?? false;
  const fps = sequence.fps;
  const assetUses = asset ? sequence.clips.filter((item) => item.assetId === asset.id).length : 0;
  const clipTransitions = clip
    ? sequence.transitions.filter(
        (transition) => transition.fromClipId === clip.id || transition.toClipId === clip.id,
      )
    : [];
  function transformChange(patch: Partial<ClipTransform>) {
    if (!clip) return;
    onChange({ transform: { ...clip.transform, ...patch } });
  }
  function cropChange(side: keyof ClipTransform['crop'], value: number) {
    if (!clip) return;
    const opposite =
      side === 'top' ? 'bottom' : side === 'bottom' ? 'top' : side === 'left' ? 'right' : 'left';
    const next = Math.min(0.99 - clip.transform.crop[opposite], value / 100);
    transformChange({ crop: { ...clip.transform.crop, [side]: Math.max(0, next) } });
  }
  function resetTransform() {
    transformChange({
      x: 0,
      y: 0,
      width: sequence.width,
      height: sequence.height,
      rotation: 0,
      opacity: 1,
      fit: 'contain',
      crop: { top: 0, right: 0, bottom: 0, left: 0 },
    });
  }

  return (
    <aside className="vinsp-panel" aria-label="视频片段属性">
      <header className="vinsp-header">
        <Settings2 size={15} />
        <strong>片段属性</strong>
        {clip && <span>{isAudio ? '音频' : '画面'}</span>}
      </header>
      {!clip ? (
        <div className="vinsp-empty">
          <Settings2 size={30} />
          <p>选择时间线片段</p>
          <span>
            调整画面、时间与声音。
            <br />
            多选片段可一起移动、分割和成组。
          </span>
          <div className="vinsp-sequence-meta">
            <strong>{sequence.name}</strong>
            <span>
              {sequence.width} × {sequence.height} · {sequence.fps} fps
            </span>
            <span>
              {sequence.tracks.length} 条轨道 · {sequence.clips.length} 个片段
            </span>
          </div>
        </div>
      ) : (
        <div className="vinsp-scroll" key={clip.id}>
          <div className="vinsp-clip-summary">
            <strong>{clip.name}</strong>
            <span>{asset?.name ?? '素材未找到'}</span>
            <small>
              {track?.name} · {formatTimelineTime(clip.start, fps)} –{' '}
              {formatTimelineTime(clip.start + clip.duration, fps)}
            </small>
            {(clip.groupId || clip.linkId) && (
              <div className="vinsp-badges">
                {clip.groupId && <span>编组片段</span>}
                {clip.linkId && (
                  <span>
                    <Link2 size={10} />
                    关联音视频
                  </span>
                )}
              </div>
            )}
          </div>
          {locked && <p className="vinsp-notice">轨道已锁定，请先在时间线解锁后修改。</p>}
          <fieldset className="vinsp-fields" disabled={locked}>
            <Section title="时间与来源" icon={<Settings2 size={13} />}>
              <TextControl
                label="片段名称"
                value={clip.name}
                onChange={(name) => onChange({ name })}
              />
              <div className="vinsp-grid">
                <NumberControl
                  label="起点（帧）"
                  value={clip.start}
                  min={0}
                  onChange={(start) => onChange({ start: Math.round(start) })}
                />
                <NumberControl
                  label="时长（帧）"
                  value={clip.duration}
                  min={1}
                  onChange={(duration) => onChange({ duration: Math.round(duration) })}
                />
                <NumberControl
                  label="起点（秒）"
                  value={clip.start / fps}
                  min={0}
                  step={1 / fps}
                  onChange={(seconds) => onChange({ start: Math.round(seconds * fps) })}
                />
                <NumberControl
                  label="时长（秒）"
                  value={clip.duration / fps}
                  min={1 / fps}
                  step={1 / fps}
                  onChange={(seconds) =>
                    onChange({ duration: Math.max(1, Math.round(seconds * fps)) })
                  }
                />
              </div>
              {(asset?.kind === 'video' || asset?.kind === 'audio') && (
                <>
                  <NumberControl
                    label="源入点（秒）"
                    value={clip.sourceIn}
                    min={0}
                    max={Math.max(0, asset.duration - 1 / fps)}
                    step={1 / fps}
                    onChange={(sourceIn) => onChange({ sourceIn })}
                  />
                  <div className="vinsp-readout">
                    <span>源出点</span>
                    <strong>{(clip.sourceIn + clip.duration / fps).toFixed(3)} 秒</strong>
                  </div>
                  <div className="vinsp-readout">
                    <span>素材总时长</span>
                    <strong>{asset.duration.toFixed(3)} 秒</strong>
                  </div>
                  <label className="vinsp-check">
                    <input
                      type="checkbox"
                      checked={clip.loop}
                      onChange={(event) => onChange({ loop: event.target.checked })}
                    />
                    <span>从素材入点循环至文件末尾</span>
                  </label>
                </>
              )}
              <p className="vinsp-hint">时间精确到序列帧；修改入点不会改变源文件。</p>
            </Section>
            {!isAudio && (
              <>
                <Section title="画面变换" icon={<Image size={13} />}>
                  <div className="vinsp-grid">
                    <NumberControl
                      label="位置 X"
                      value={clip.transform.x}
                      suffix="px"
                      onChange={(x) => transformChange({ x })}
                    />
                    <NumberControl
                      label="位置 Y"
                      value={clip.transform.y}
                      suffix="px"
                      onChange={(y) => transformChange({ y })}
                    />
                    <NumberControl
                      label="宽度"
                      value={clip.transform.width}
                      min={1}
                      suffix="px"
                      onChange={(width) => transformChange({ width })}
                    />
                    <NumberControl
                      label="高度"
                      value={clip.transform.height}
                      min={1}
                      suffix="px"
                      onChange={(height) => transformChange({ height })}
                    />
                    <NumberControl
                      label="旋转"
                      value={clip.transform.rotation}
                      suffix="°"
                      step={0.1}
                      onChange={(rotation) => transformChange({ rotation })}
                    />
                    <NumberControl
                      label="不透明度"
                      value={clip.transform.opacity * 100}
                      min={0}
                      max={100}
                      suffix="%"
                      onChange={(opacity) => transformChange({ opacity: opacity / 100 })}
                    />
                  </div>
                  <label className="vinsp-field">
                    <span>画面适配</span>
                    <select
                      aria-label="画面适配"
                      value={clip.transform.fit}
                      onChange={(event) =>
                        transformChange({ fit: event.target.value as 'contain' | 'cover' })
                      }
                    >
                      <option value="contain">适应 · 保留完整画面</option>
                      <option value="cover">填充 · 裁掉超出部分</option>
                    </select>
                  </label>
                  <div className="vinsp-actions">
                    <button
                      type="button"
                      onClick={() =>
                        transformChange({
                          x: (sequence.width - clip.transform.width) / 2,
                          y: (sequence.height - clip.transform.height) / 2,
                        })
                      }
                    >
                      画布居中
                    </button>
                    <button type="button" onClick={resetTransform}>
                      <RotateCcw size={12} />
                      重置画面
                    </button>
                  </div>
                </Section>
                <Section title="裁切" icon={<Crop size={13} />} initiallyOpen={false}>
                  <div className="vinsp-grid">
                    <NumberControl
                      label="裁切顶部"
                      value={clip.transform.crop.top * 100}
                      min={0}
                      max={99 - clip.transform.crop.bottom * 100}
                      suffix="%"
                      step={0.1}
                      onChange={(value) => cropChange('top', value)}
                    />
                    <NumberControl
                      label="裁切底部"
                      value={clip.transform.crop.bottom * 100}
                      min={0}
                      max={99 - clip.transform.crop.top * 100}
                      suffix="%"
                      step={0.1}
                      onChange={(value) => cropChange('bottom', value)}
                    />
                    <NumberControl
                      label="裁切左侧"
                      value={clip.transform.crop.left * 100}
                      min={0}
                      max={99 - clip.transform.crop.right * 100}
                      suffix="%"
                      step={0.1}
                      onChange={(value) => cropChange('left', value)}
                    />
                    <NumberControl
                      label="裁切右侧"
                      value={clip.transform.crop.right * 100}
                      min={0}
                      max={99 - clip.transform.crop.left * 100}
                      suffix="%"
                      step={0.1}
                      onChange={(value) => cropChange('right', value)}
                    />
                  </div>
                  <button
                    type="button"
                    className="vinsp-secondary"
                    onClick={() =>
                      transformChange({ crop: { top: 0, right: 0, bottom: 0, left: 0 } })
                    }
                  >
                    清除裁切
                  </button>
                </Section>
              </>
            )}
            <Section title={isAudio ? '声音与淡化' : '淡入淡出'} icon={<Music2 size={13} />}>
              {isAudio && (
                <>
                  <NumberControl
                    label="片段音量"
                    value={clip.volume * 100}
                    min={0}
                    max={400}
                    suffix="%"
                    onChange={(value) => onChange({ volume: value / 100 })}
                  />
                  <button
                    type="button"
                    className={`vinsp-secondary ${clip.volume === 0 ? 'vinsp-active' : ''}`}
                    onClick={() => onChange({ volume: clip.volume === 0 ? 1 : 0 })}
                  >
                    {clip.volume === 0 ? '恢复原声音量' : '片段静音'}
                  </button>
                </>
              )}
              <div className="vinsp-grid">
                <NumberControl
                  label="淡入（秒）"
                  value={clip.fadeIn / fps}
                  min={0}
                  max={clip.duration / fps}
                  step={0.1}
                  onChange={(seconds) => onChange({ fadeIn: Math.round(seconds * fps) })}
                />
                <NumberControl
                  label="淡出（秒）"
                  value={clip.fadeOut / fps}
                  min={0}
                  max={clip.duration / fps}
                  step={0.1}
                  onChange={(seconds) => onChange({ fadeOut: Math.round(seconds * fps) })}
                />
              </div>
              <p className="vinsp-hint">
                {isAudio
                  ? '音轨音量与片段音量共同生效。'
                  : '画面淡化调整透明度，下面的轨道会透出。原声音量请在关联音频片段中调整。'}
              </p>
            </Section>
            {clipTransitions.length > 0 && (
              <Section title="片段叠化" icon={<Link2 size={13} />}>
                {clipTransitions.map((transition) => {
                  const outgoing = transition.fromClipId === clip.id;
                  const neighbor = sequence.clips.find(
                    (item) => item.id === (outgoing ? transition.toClipId : transition.fromClipId),
                  );
                  return (
                    <div key={transition.id} className="vinsp-transition">
                      <div className="vinsp-readout">
                        <span>{outgoing ? '与下一片段叠化' : '与上一片段叠化'}</span>
                        <strong>{(transition.duration / fps).toFixed(2)} 秒</strong>
                      </div>
                      <p className="vinsp-hint">
                        {neighbor?.name ?? '关联片段'} · {transition.duration} 帧
                      </p>
                      <button
                        type="button"
                        className="vinsp-secondary"
                        disabled={!onRemoveTransition}
                        aria-label={`移除${outgoing ? '出场' : '入场'}转场`}
                        onClick={() => onRemoveTransition?.(transition.id)}
                      >
                        移除转场
                      </button>
                    </div>
                  );
                })}
              </Section>
            )}
            {(asset?.kind === 'text' || asset?.kind === 'color') && (
              <Section
                title={asset.kind === 'text' ? '文字素材' : '颜色素材'}
                icon={<Type size={13} />}
              >
                {assetUses > 1 && (
                  <p className="vinsp-hint">
                    以下素材设置会更新当前序列中共用它的 {assetUses} 个片段。
                  </p>
                )}
                {asset.kind === 'text' && (
                  <>
                    <TextControl
                      label="文字内容"
                      value={asset.text ?? ''}
                      onChange={(text) => onAssetChange({ text })}
                      multiline
                    />
                    <TextControl
                      label="字体"
                      value={asset.fontFamily ?? 'sans-serif'}
                      onChange={(fontFamily) => onAssetChange({ fontFamily })}
                    />
                    <NumberControl
                      label="字号"
                      value={asset.fontSize ?? 72}
                      min={1}
                      max={2000}
                      suffix="px"
                      onChange={(fontSize) => onAssetChange({ fontSize })}
                    />
                  </>
                )}
                <label className="vinsp-field">
                  <span>{asset.kind === 'text' ? '文字颜色' : '填充颜色'}</span>
                  <div className="vinsp-color">
                    <input
                      aria-label={asset.kind === 'text' ? '文字颜色选择' : '填充颜色选择'}
                      type="color"
                      value={/^#[0-9a-f]{6}$/i.test(asset.color ?? '') ? asset.color : '#ffffff'}
                      onChange={(event) => onAssetChange({ color: event.target.value })}
                    />
                    <input
                      aria-label="颜色值"
                      value={asset.color ?? '#ffffff'}
                      onChange={(event) => onAssetChange({ color: event.target.value })}
                    />
                  </div>
                </label>
              </Section>
            )}
            {asset?.graphic && (
              <Section title="关联图片方案" icon={<Link2 size={13} />}>
                <p className="vinsp-hint">
                  在图片工作区编辑关联图文，回到视频后画面会更新，剪辑与声音设置保持。
                </p>
                <div className="vinsp-readout">
                  <span>数据条目</span>
                  <strong>{asset.graphic.rowIds.length} 条</strong>
                </div>
                {onEditGraphic && (
                  <button
                    type="button"
                    className="vinsp-primary"
                    onClick={() => onEditGraphic(asset.graphic!.sourceId)}
                  >
                    编辑关联图片
                  </button>
                )}
              </Section>
            )}
          </fieldset>
        </div>
      )}
    </aside>
  );
}
