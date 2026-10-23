import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Files,
  GripVertical,
  ImagePlus,
  Images,
  Music2,
  Plus,
  Redo2,
  Trash2,
  Undo2,
  Upload,
} from 'lucide-react';
import type { GraphicSource, MediaAsset, VideoSequence } from './types';
import { sequenceDuration } from './model';
import {
  duplicateSlides,
  inspectSlideshow,
  insertSlides,
  removeSlides,
  reorderSlides,
  setSlideDuration,
  setSlideshowSettings,
} from './slideshow';
import './slideshow.css';

export interface SlideshowEditorProps {
  sequence: VideoSequence;
  assets: MediaAsset[];
  graphics: GraphicSource[];
  disabled: boolean;
  selectedId?: string;
  onSelect(id: string): void;
  onChange(sequence: VideoSequence): void;
  onNewSequence(): void;
  onOpenGraphics(): void;
  onImportMedia(): void;
  onError(message: string): void;
  renderThumbnail(asset: MediaAsset): ReactNode;
  preview: ReactNode;
  onUndo(): void;
  onRedo(): void;
  canUndo: boolean;
  canRedo: boolean;
}

function seconds(frames: number, fps: number) {
  return Number((frames / fps).toFixed(3));
}

function durationLabel(frames: number, fps: number) {
  const value = Math.max(0, frames / fps);
  const minutes = Math.floor(value / 60);
  const remainder = Number((value % 60).toFixed(2));
  return minutes ? `${minutes} 分 ${remainder} 秒` : `${remainder} 秒`;
}

/** Commit numeric edits once, so typing a duration remains a single undo step. */
function NumberField({
  label,
  value,
  min = 0,
  max,
  step = 0.1,
  suffix = '秒',
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  onChange(value: number): void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const next = Number(draft);
    if (
      !draft.trim() ||
      !Number.isFinite(next) ||
      next < min ||
      (max !== undefined && next > max)
    ) {
      setDraft(String(value));
      return;
    }
    if (next !== value) onChange(next);
    setDraft(String(value));
  };
  return (
    <span className="ve-ppt-number">
      <input
        type="number"
        aria-label={label}
        value={draft}
        min={min}
        max={max}
        step={step}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.currentTarget.blur();
          }
          if (event.key === 'Escape') {
            setDraft(String(value));
            event.stopPropagation();
          }
        }}
      />
      <span>{suffix}</span>
    </span>
  );
}

export function SlideshowEditor(props: SlideshowEditorProps) {
  const { sequence, assets, graphics, disabled, onChange, onSelect, onError } = props;
  const inspection = useMemo(() => inspectSlideshow(sequence, assets), [sequence, assets]);
  const { pages, settings, editable } = inspection;
  const [tab, setTab] = useState<'pages' | 'music'>('pages');
  const [source, setSource] = useState('all');
  const [assetId, setAssetId] = useState('');
  const [draggedId, setDraggedId] = useState<string>();
  const [dropId, setDropId] = useState<string>();
  const pageList = useRef<HTMLDivElement>(null);
  const staticAssets = useMemo(
    () => assets.filter((asset) => ['image', 'graphic', 'text', 'color'].includes(asset.kind)),
    [assets],
  );
  const filteredAssets = useMemo(
    () =>
      staticAssets.filter(
        (asset) =>
          source === 'all' ||
          (source === 'images' ? asset.kind === 'image' : asset.graphic?.sourceId === source),
      ),
    [staticAssets, source],
  );
  const sources = graphics.filter((graphic) =>
    staticAssets.some((asset) => asset.graphic?.sourceId === graphic.id),
  );
  const selectedIndex = pages.findIndex((page) => page.id === props.selectedId);
  const currentIndex = selectedIndex < 0 ? 0 : selectedIndex;
  const current = pages[currentIndex];
  const selectedAsset = filteredAssets.find((asset) => asset.id === assetId) || filteredAssets[0];
  const assetMap = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);
  const totalFrames = sequenceDuration(sequence);
  const audioAssets = assets.filter(
    (asset) => asset.kind === 'audio' || (asset.kind === 'video' && asset.hasAudio),
  );
  const fps = sequence.fps;
  const musicTrack = sequence.tracks.find((track) => track.id === settings.bgmTrackId);
  const musicHiddenBySolo =
    !musicTrack?.solo && sequence.tracks.some((track) => track.kind === 'audio' && track.solo);
  const defaultTransition = Math.max(
    1,
    Math.min(
      Math.round(fps * 0.5),
      ...(pages.length > 1
        ? pages.map((page, index) =>
            index === 0 || index === pages.length - 1
              ? page.duration - 1
              : Math.floor(page.duration / 2),
          )
        : []),
    ),
  );

  useEffect(() => {
    if (
      source !== 'all' &&
      source !== 'images' &&
      !graphics.some((graphic) => graphic.id === source)
    ) {
      setSource('all');
    }
  }, [source, graphics]);
  useEffect(() => {
    pageList.current?.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [props.selectedId]);

  const apply = (operation: () => VideoSequence) => {
    if (disabled || !editable) return;
    try {
      const next = operation();
      onChange(next);
      return next;
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  };

  function add(ids: string[]) {
    const next = apply(() => insertSlides(sequence, assets, ids, pages.length));
    if (next) {
      const oldIds = new Set(pages.map((page) => page.id));
      const firstAdded = inspectSlideshow(next, assets).pages.find((page) => !oldIds.has(page.id));
      if (firstAdded) onSelect(firstAdded.id);
    }
  }

  function reorder(id: string, target: string) {
    if (id === target) return;
    const ordered = pages.map((page) => page.id);
    const oldIndex = ordered.indexOf(id);
    const nextIndex = ordered.indexOf(target);
    if (oldIndex < 0 || nextIndex < 0) return;
    ordered.splice(oldIndex, 1);
    ordered.splice(nextIndex, 0, id);
    apply(() => reorderSlides(sequence, assets, ordered));
  }

  function duplicateCurrent() {
    if (!current) return;
    const next = apply(() => duplicateSlides(sequence, assets, [current.id]));
    if (next) {
      const oldIds = new Set(pages.map((page) => page.id));
      const copy = inspectSlideshow(next, assets).pages.find((page) => !oldIds.has(page.id));
      if (copy) onSelect(copy.id);
    }
  }

  function deleteCurrent() {
    if (!current) return;
    const next = apply(() => removeSlides(sequence, assets, [current.id]));
    if (next) {
      const rest = inspectSlideshow(next, assets).pages;
      const nextSelected = rest[Math.min(currentIndex, rest.length - 1)];
      if (nextSelected) onSelect(nextSelected.id);
    }
  }

  const patchSettings = (patch: Parameters<typeof setSlideshowSettings>[2]) =>
    apply(() => setSlideshowSettings(sequence, assets, patch));

  return (
    <section className="ve-ppt" aria-label="PPT副榜编辑器">
      <aside className="ve-ppt-pages">
        <div className="ve-ppt-heading">
          <span>
            <Files size={15} /> 页面
          </span>
          <span className="ve-ppt-count" aria-label="PPT页面总数">
            {editable ? `${pages.length} 页` : '自由剪辑'}
          </span>
        </div>
        <div className="ve-ppt-page-toolbar">
          <button
            title="撤销"
            aria-label="PPT撤销"
            disabled={disabled || !props.canUndo}
            onClick={props.onUndo}
          >
            <Undo2 size={15} />
          </button>
          <button
            title="重做"
            aria-label="PPT重做"
            disabled={disabled || !props.canRedo}
            onClick={props.onRedo}
          >
            <Redo2 size={15} />
          </button>
          <span />
          <button
            title="关联图片编辑器中的副榜图片"
            aria-label="PPT关联图片"
            disabled={disabled || !editable}
            onClick={props.onOpenGraphics}
          >
            <ImagePlus size={15} />
          </button>
        </div>
        <div
          ref={pageList}
          className="ve-ppt-page-list"
          role="list"
          aria-label="PPT页面列表"
          onKeyDown={(event) => {
            if (disabled || !editable || !pages.length) return;
            if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
              event.preventDefault();
              event.stopPropagation();
              const index = Math.max(
                0,
                Math.min(pages.length - 1, currentIndex + (event.key === 'ArrowUp' ? -1 : 1)),
              );
              onSelect(pages[index].id);
            }
          }}
        >
          {editable &&
            pages.map((page, index) => {
              const asset = assetMap.get(page.assetId);
              return (
                <div
                  role="listitem"
                  className={`ve-ppt-page ${current?.id === page.id ? 'selected' : ''} ${dropId === page.id ? 'drop-target' : ''}`}
                  key={page.id}
                  data-clip-id={page.id}
                  draggable={!disabled}
                  onDragStart={(event) => {
                    if (disabled) {
                      event.preventDefault();
                      return;
                    }
                    setDraggedId(page.id);
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('application/x-teditor-slide', page.id);
                    onSelect(page.id);
                  }}
                  onDragOver={(event) => {
                    if (!disabled && draggedId) {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = 'move';
                      setDropId(page.id);
                    }
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const id =
                      event.dataTransfer.getData('application/x-teditor-slide') || draggedId;
                    if (id) reorder(id, page.id);
                    setDraggedId(undefined);
                    setDropId(undefined);
                  }}
                  onDragEnd={() => {
                    setDraggedId(undefined);
                    setDropId(undefined);
                  }}
                >
                  <div className="ve-ppt-page-number">
                    <span>{String(index + 1).padStart(2, '0')}</span>
                    <GripVertical size={13} />
                  </div>
                  <button
                    aria-label={`PPT页面${index + 1}`}
                    aria-pressed={current?.id === page.id}
                    className="ve-ppt-page-select"
                    disabled={disabled}
                    onClick={() => onSelect(page.id)}
                  >
                    <span
                      className="ve-ppt-thumbnail"
                      style={{ aspectRatio: `${sequence.width}/${sequence.height}` }}
                    >
                      {asset ? (
                        props.renderThumbnail(asset)
                      ) : (
                        <span className="ve-ppt-missing">缺少图片</span>
                      )}
                      <span className="ve-ppt-page-duration">{seconds(page.duration, fps)} 秒</span>
                    </span>
                    <span className="ve-ppt-page-name" title={page.name}>
                      {page.name}
                    </span>
                  </button>
                </div>
              );
            })}
          {editable && !pages.length && (
            <div className="ve-ppt-empty-pages">
              <Images size={30} strokeWidth={1.2} />
              <strong>把副榜图片放到这里</strong>
              <p>每张图片就是一页，设置停留时间后即可导出视频。</p>
              <button className="ve-primary" disabled={disabled} onClick={props.onOpenGraphics}>
                <ImagePlus size={14} /> 关联副榜图片
              </button>
              <button disabled={disabled} onClick={props.onImportMedia}>
                导入本地图片
              </button>
            </div>
          )}
          {!editable && (
            <p className="ve-ppt-list-hint">此序列包含自由剪辑内容，请在时间轴模式编辑。</p>
          )}
        </div>
        <div className="ve-ppt-reorder-toolbar">
          <button
            aria-label="PPT页面上移"
            title="页面上移"
            disabled={disabled || !editable || !current || currentIndex === 0}
            onClick={() => current && reorder(current.id, pages[currentIndex - 1].id)}
          >
            <ArrowUp size={15} />
          </button>
          <button
            aria-label="PPT页面下移"
            title="页面下移"
            disabled={disabled || !editable || !current || currentIndex >= pages.length - 1}
            onClick={() => current && reorder(current.id, pages[currentIndex + 1].id)}
          >
            <ArrowDown size={15} />
          </button>
          <button
            aria-label="PPT复制页面"
            title="复制页面"
            disabled={disabled || !editable || !current}
            onClick={duplicateCurrent}
          >
            <Copy size={15} />
          </button>
          <button
            aria-label="PPT删除页面"
            title="删除页面"
            disabled={disabled || !editable || !current}
            onClick={deleteCurrent}
          >
            <Trash2 size={15} />
          </button>
        </div>
      </aside>

      <main className="ve-ppt-center">
        <div className="ve-ppt-preview">{props.preview}</div>
        {!editable ? (
          <div className="ve-ppt-unsupported" role="status">
            <div>
              <strong>这个序列需要在时间轴中编辑</strong>
              <p>{inspection.reason || '当前轨道或片段不适合按页面编辑。'}</p>
              <p>新建一个 PPT 序列，就可以按页制作副榜视频；当前序列会保留在工程中。</p>
            </div>
            <button className="ve-primary" disabled={disabled} onClick={props.onNewSequence}>
              <Plus size={15} /> 新建PPT序列
            </button>
          </div>
        ) : (
          <fieldset disabled={disabled} className="ve-ppt-current">
            <div className="ve-ppt-current-title">
              <span className="ve-ppt-eyebrow">当前页面</span>
              <strong>{current ? `${currentIndex + 1} / ${pages.length}` : '等待添加图片'}</strong>
            </div>
            {current && (
              <>
                <label>
                  本页停留时间
                  <NumberField
                    label="PPT本页秒数"
                    value={seconds(current.duration, fps)}
                    min={1 / fps}
                    onChange={(value) =>
                      apply(() =>
                        setSlideDuration(
                          sequence,
                          assets,
                          [current.id],
                          Math.max(1, Math.round(value * fps)),
                        ),
                      )
                    }
                  />
                </label>
                <label>
                  画面尺寸
                  <select
                    aria-label="PPT画面适应方式"
                    value={current.transform.fit}
                    onChange={(event) => {
                      const fit = event.target.value as 'contain' | 'cover';
                      apply(() => ({
                        ...sequence,
                        clips: sequence.clips.map((clip) =>
                          clip.id === current.id
                            ? { ...clip, transform: { ...clip.transform, fit } }
                            : clip,
                        ),
                      }));
                    }}
                  >
                    <option value="contain">适应画面</option>
                    <option value="cover">填满画面</option>
                  </select>
                </label>
              </>
            )}
          </fieldset>
        )}
        <div className="ve-ppt-summary">
          <span>
            {sequence.width} × {sequence.height} · {fps} fps
          </span>
          <span>
            视频总时长 <strong aria-label="PPT视频总时长">{durationLabel(totalFrames, fps)}</strong>
          </span>
        </div>
      </main>

      <aside className="ve-ppt-settings">
        <div className="ve-ppt-tabs" role="tablist" aria-label="PPT设置">
          <button
            role="tab"
            aria-selected={tab === 'pages'}
            className={tab === 'pages' ? 'active' : ''}
            onClick={() => setTab('pages')}
          >
            <Images size={14} /> 页面
          </button>
          <button
            role="tab"
            aria-selected={tab === 'music'}
            className={tab === 'music' ? 'active' : ''}
            onClick={() => setTab('music')}
          >
            <Music2 size={14} /> 音乐
          </button>
        </div>
        <fieldset
          disabled={disabled || !editable}
          className="ve-ppt-settings-scroll"
          role="tabpanel"
          aria-label={tab === 'pages' ? 'PPT页面设置' : 'PPT音乐设置'}
        >
          {tab === 'pages' ? (
            <>
              <section className="ve-ppt-settings-section">
                <div className="ve-ppt-section-title">
                  <span>添加页面</span>
                  <span>{filteredAssets.length} 张可用</span>
                </div>
                <label>
                  图片来源
                  <select
                    aria-label="PPT图片来源"
                    value={source}
                    onChange={(event) => setSource(event.target.value)}
                  >
                    <option value="all">全部静态素材</option>
                    <option value="images">普通图片</option>
                    {sources.map((graphic) => (
                      <option key={graphic.id} value={graphic.id}>
                        {graphic.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="ve-primary ve-ppt-wide"
                  disabled={!filteredAssets.length}
                  onClick={() => add(filteredAssets.map((asset) => asset.id))}
                >
                  <Plus size={14} /> 添加此来源全部图片
                </button>
                <div className="ve-ppt-single-add">
                  <select
                    aria-label="PPT单张图片"
                    value={selectedAsset?.id || ''}
                    onChange={(event) => setAssetId(event.target.value)}
                  >
                    {!filteredAssets.length && <option value="">还没有可用图片</option>}
                    {filteredAssets.map((asset) => (
                      <option key={asset.id} value={asset.id}>
                        {asset.name}
                      </option>
                    ))}
                  </select>
                  <button
                    title="添加单张图片"
                    aria-label="添加单张图片"
                    disabled={!selectedAsset}
                    onClick={() => selectedAsset && add([selectedAsset.id])}
                  >
                    <Plus size={15} />
                  </button>
                </div>
                <div className="ve-ppt-import-actions">
                  <button onClick={props.onOpenGraphics}>
                    <ImagePlus size={14} /> 关联副榜图片
                  </button>
                  <button onClick={props.onImportMedia}>
                    <Upload size={14} /> 导入素材
                  </button>
                </div>
                <p className="ve-ppt-help">
                  关联图片步骤中的分页结果，无需先导出图片。添加后可拖动左侧页面调整顺序。
                </p>
              </section>
              <section className="ve-ppt-settings-section">
                <div className="ve-ppt-section-title">
                  <span>播放节奏</span>
                </div>
                <label>
                  默认每页停留
                  <NumberField
                    label="PPT默认每页秒数"
                    value={seconds(settings.defaultDuration, fps)}
                    min={1 / fps}
                    onChange={(value) =>
                      patchSettings({ defaultDuration: Math.max(1, Math.round(value * fps)) })
                    }
                  />
                </label>
                <button
                  className="ve-ppt-wide"
                  disabled={!pages.length}
                  onClick={() =>
                    apply(() =>
                      setSlideDuration(
                        sequence,
                        assets,
                        pages.map((page) => page.id),
                        settings.defaultDuration,
                      ),
                    )
                  }
                >
                  应用到所有页面
                </button>
                <label>
                  页面切换
                  <select
                    aria-label="PPT页面切换"
                    value={settings.transitionDuration > 0 ? 'dissolve' : 'cut'}
                    onChange={(event) =>
                      patchSettings({
                        transitionDuration: event.target.value === 'cut' ? 0 : defaultTransition,
                      })
                    }
                  >
                    <option value="cut">硬切</option>
                    <option value="dissolve">叠化</option>
                  </select>
                </label>
                {settings.transitionDuration > 0 && (
                  <label>
                    叠化时长
                    <NumberField
                      label="PPT叠化秒数"
                      value={seconds(settings.transitionDuration, fps)}
                      min={1 / fps}
                      onChange={(value) =>
                        patchSettings({ transitionDuration: Math.max(1, Math.round(value * fps)) })
                      }
                    />
                  </label>
                )}
                <p className="ve-ppt-help">
                  停留时间包含叠化部分。叠化时相邻页面会重叠，实际视频时长显示在预览下方。
                </p>
              </section>
            </>
          ) : (
            <>
              <section className="ve-ppt-settings-section">
                <div className="ve-ppt-section-title">
                  <span>背景音乐</span>
                  <Music2 size={15} />
                </div>
                <label>
                  音乐素材
                  <select
                    aria-label="PPT背景音乐"
                    value={settings.bgmAssetId || ''}
                    onChange={(event) =>
                      patchSettings({ bgmAssetId: event.target.value || undefined })
                    }
                  >
                    <option value="">无背景音乐</option>
                    {audioAssets.map((asset) => (
                      <option key={asset.id} value={asset.id}>
                        {asset.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button className="ve-ppt-wide" onClick={props.onImportMedia}>
                  <Upload size={14} /> 导入音乐或视频
                </button>
                <label className="ve-ppt-checkbox">
                  <input
                    type="checkbox"
                    aria-label="PPT循环背景音乐"
                    checked={settings.bgmLoop}
                    onChange={(event) => patchSettings({ bgmLoop: event.target.checked })}
                  />{' '}
                  循环播放到视频结束
                </label>
                <label>
                  音乐音量
                  <NumberField
                    label="PPT背景音乐音量"
                    value={Math.round(settings.bgmVolume * 100)}
                    min={0}
                    max={200}
                    step={5}
                    suffix="%"
                    onChange={(value) => patchSettings({ bgmVolume: value / 100 })}
                  />
                </label>
                <div className="ve-ppt-music-fades">
                  <label>
                    淡入
                    <NumberField
                      label="PPT音乐淡入秒数"
                      value={seconds(settings.bgmFadeIn, fps)}
                      onChange={(value) =>
                        patchSettings({ bgmFadeIn: Math.max(0, Math.round(value * fps)) })
                      }
                    />
                  </label>
                  <label>
                    淡出
                    <NumberField
                      label="PPT音乐淡出秒数"
                      value={seconds(settings.bgmFadeOut, fps)}
                      onChange={(value) =>
                        patchSettings({ bgmFadeOut: Math.max(0, Math.round(value * fps)) })
                      }
                    />
                  </label>
                </div>
                {(musicTrack?.muted ||
                  musicHiddenBySolo ||
                  (musicTrack && musicTrack.volume !== 1)) && (
                  <p className="ve-ppt-audio-note" role="status">
                    {musicTrack?.muted
                      ? '背景音乐轨道已静音。'
                      : musicHiddenBySolo
                        ? '其他声音轨道开启了独奏，背景音乐当前不会播放。'
                        : `背景音乐轨道音量为 ${Math.round((musicTrack?.volume ?? 1) * 100)}%，会与上方的音乐音量共同作用。`}
                    请在时间轴模式中调整轨道设置。
                  </p>
                )}
                <p className="ve-ppt-help">
                  背景音乐连续铺在整段副榜视频下方。需要逐段剪辑音频时，可随时切换到时间轴模式。
                </p>
              </section>
            </>
          )}
        </fieldset>
      </aside>
    </section>
  );
}
