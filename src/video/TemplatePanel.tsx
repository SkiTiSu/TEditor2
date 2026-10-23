import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2, X } from 'lucide-react';
import { downloadBlob } from '../core/assets';
import type {
  MediaAsset,
  RankingBinding,
  TemplateSection,
  VideoProject,
  VideoTemplate,
} from './types';
import { uid, sequenceDuration } from './model';
import { applyRankingTemplate, parseTemplate, serializeTemplate } from './templates';

export function starterTemplate(): VideoTemplate {
  const base: TemplateSection = {
    id: uid('section'),
    kind: 'main',
    name: '主榜',
    sourceSlot: '主榜',
    duration: 25,
    order: 'reverse',
    mainMode: 'window',
    cardDuration: 3,
    window: { x: 360, y: 90, width: 1480, height: 830 },
    transition: 0,
  };
  return {
    format: 'teditor-video-template',
    version: 1,
    name: '排行榜节目',
    width: 1920,
    height: 1080,
    fps: 60,
    sections: [
      {
        ...base,
        id: uid('section'),
        kind: 'title',
        name: '片头',
        text: '本期排行榜',
        duration: 3,
        background: '#101622',
      },
      base,
      {
        ...base,
        id: uid('section'),
        kind: 'secondary',
        name: '副榜',
        sourceSlot: '副榜',
        duration: 5,
        order: 'forward',
      },
      {
        ...base,
        id: uid('section'),
        kind: 'title',
        name: 'STAFF',
        text: '感谢收看',
        duration: 4,
        background: '#101622',
      },
    ],
  };
}

export function TemplatePanel({
  project,
  currentAsset,
  sourceIn,
  sourceOut,
  onChange,
  onApply,
  onClose,
  onError,
}: {
  project: VideoProject;
  currentAsset?: MediaAsset;
  sourceIn: number;
  sourceOut: number;
  onChange: (next: VideoProject) => void;
  onApply: (next: VideoProject) => void;
  onClose: () => void;
  onError: (s: string) => void;
}) {
  const [template, setTemplate] = useState<VideoTemplate>(starterTemplate);
  const [sources, setSources] = useState<Record<string, string>>({
    主榜: project.graphics[0]?.id || '',
    副榜: project.graphics.at(-1)?.id || '',
  });
  const [mainSource, setMainSource] = useState(project.graphics[0]?.id || '');
  const [bgm, setBgm] = useState(''),
    [bgmLoop, setBgmLoop] = useState(true);
  const [preview, setPreview] = useState<VideoProject | null>(null);
  useEffect(() => setPreview(null), [project]);
  const [tab, setTab] = useState<'bind' | 'template'>('bind');
  const file = useRef<HTMLInputElement>(null);
  const source = project.graphics.find((s) => s.id === mainSource);
  const bindings = project.rankingBindings?.[mainSource] || [];
  function change(patch: Partial<VideoTemplate>) {
    setTemplate((t) => ({ ...t, ...patch }));
    setPreview(null);
  }
  function changeSection(id: string, patch: Partial<TemplateSection>) {
    change({ sections: template.sections.map((s) => (s.id === id ? { ...s, ...patch } : s)) });
  }
  function bind(rowId: string) {
    if (!currentAsset || currentAsset.kind !== 'video') {
      onError('先在素材库选择视频，并设置源预览的入点和出点。');
      return;
    }
    if (!(sourceOut > sourceIn && sourceIn >= 0 && sourceOut <= currentAsset.duration + 0.001)) {
      onError('入点和出点必须在源视频时长内。');
      return;
    }
    const next: RankingBinding = { rowId, assetId: currentAsset.id, sourceIn, sourceOut };
    onChange({
      ...project,
      rankingBindings: {
        ...project.rankingBindings,
        [mainSource]: [...bindings.filter((b) => b.rowId !== rowId), next],
      },
    });
    setPreview(null);
  }
  function reorder(index: number, delta: number) {
    const list = [...template.sections];
    const to = index + delta;
    if (to < 0 || to >= list.length) return;
    [list[index], list[to]] = [list[to], list[index]];
    change({ sections: list });
  }
  function makePreview() {
    try {
      setPreview(
        applyRankingTemplate(project, template, {
          sources,
          main: [],
          mainBySource: project.rankingBindings,
          bgmAssetId: bgm || undefined,
          bgmLoop,
        }),
      );
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  }
  async function load(f: File) {
    try {
      setTemplate(parseTemplate(await f.text()));
      setPreview(null);
      setTab('template');
    } catch (e) {
      onError(String(e instanceof Error ? e.message : e));
    }
  }
  const result = preview?.sequences.find((s) => s.id === preview.activeSequenceId);
  return (
    <section className="ve-ranking-panel" aria-label="排行榜模板">
      <div className="ve-panel-heading">
        <strong>排行榜工作台</strong>
        <button aria-label="关闭排行榜工作台" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <div className="ve-tabs">
        <button className={tab === 'bind' ? 'active' : ''} onClick={() => setTab('bind')}>
          1. 主榜选段
        </button>
        <button className={tab === 'template' ? 'active' : ''} onClick={() => setTab('template')}>
          2. 节目模板
        </button>
      </div>
      {tab === 'bind' ? (
        <>
          <p className="ve-help">
            从素材库选择视频，在源预览设置入点、出点，然后绑定到对应榜单条目。绑定会随工程保存。
          </p>
          <label>
            主榜图片方案
            <select
              aria-label="主榜图片方案"
              value={mainSource}
              onChange={(e) => setMainSource(e.target.value)}
            >
              <option value="">选择图片方案</option>
              {project.graphics.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </label>
          <div className="ve-binding-source">
            当前选段：{currentAsset?.name || '尚未选择视频'} · {sourceIn.toFixed(2)}–
            {sourceOut.toFixed(2)} s
          </div>
          <div className="ve-binding-list">
            {source?.rowIds.map((id, i) => {
              const entry = bindings.find((b) => b.rowId === id),
                asset = project.assets.find((a) => a.id === entry?.assetId);
              return (
                <div className="ve-binding" key={id}>
                  <div>
                    <b>
                      {i + 1}.{' '}
                      {Object.values(source.table.rows[i] || {})
                        .slice(0, 3)
                        .join(' · ') || '空白数据'}
                    </b>
                    <small>
                      {entry
                        ? `${asset?.name || '缺失素材'} · ${entry.sourceIn.toFixed(2)}–${entry.sourceOut.toFixed(2)} s`
                        : '待绑定视频'}
                    </small>
                  </div>
                  <button aria-label={`绑定第${i + 1}条视频`} onClick={() => bind(id)}>
                    {entry ? '替换选段' : '绑定选段'}
                  </button>
                </div>
              );
            })}
          </div>
          {!source && <div className="ve-empty">先通过“关联图片”添加主榜图片方案。</div>}
        </>
      ) : (
        <>
          <div className="ve-template-tools">
            <button onClick={() => file.current?.click()}>打开模板</button>
            <button
              onClick={() => {
                try {
                  downloadBlob(
                    new Blob([serializeTemplate(template)], { type: 'application/json' }),
                    `${template.name}.tevt`,
                  );
                } catch (e) {
                  onError(String(e));
                }
              }}
            >
              保存模板
            </button>
            <button
              onClick={() => {
                onChange({
                  ...project,
                  templates: [
                    ...(project.templates || []).filter((t) => t.name !== template.name),
                    template,
                  ],
                });
              }}
            >
              存入工程
            </button>
          </div>
          {!!project.templates?.length && (
            <label>
              工程内模板
              <select
                aria-label="工程内模板"
                defaultValue=""
                onChange={(e) => {
                  const t = project.templates?.[Number(e.target.value)];
                  if (t) {
                    setTemplate(structuredClone(t));
                    setPreview(null);
                  }
                }}
              >
                <option value="">选择已保存模板</option>
                {project.templates.map((t, i) => (
                  <option value={i} key={i}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            模板名称
            <input
              aria-label="视频模板名称"
              value={template.name}
              onChange={(e) => change({ name: e.target.value })}
            />
          </label>
          <div className="ve-form-row">
            <label>
              宽
              <input
                aria-label="模板宽度"
                type="number"
                value={template.width}
                onChange={(e) => change({ width: Number(e.target.value) })}
              />
            </label>
            <label>
              高
              <input
                aria-label="模板高度"
                type="number"
                value={template.height}
                onChange={(e) => change({ height: Number(e.target.value) })}
              />
            </label>
            <label>
              帧率
              <select
                aria-label="模板帧率"
                value={template.fps}
                onChange={(e) => change({ fps: Number(e.target.value) })}
              >
                {[24, 25, 30, 50, 60].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="ve-section-list">
            {template.sections.map((s, i) => (
              <div key={s.id} className="ve-template-section">
                <div className="ve-section-title">
                  <input
                    aria-label={`章节${i + 1}名称`}
                    value={s.name}
                    onChange={(e) => changeSection(s.id, { name: e.target.value })}
                  />
                  <button aria-label={`上移章节${i + 1}`} onClick={() => reorder(i, -1)}>
                    <ArrowUp size={13} />
                  </button>
                  <button aria-label={`下移章节${i + 1}`} onClick={() => reorder(i, 1)}>
                    <ArrowDown size={13} />
                  </button>
                  <button
                    aria-label={`删除章节${i + 1}`}
                    onClick={() =>
                      change({ sections: template.sections.filter((t) => t.id !== s.id) })
                    }
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
                <div className="ve-form-row">
                  <label>
                    类型
                    <select
                      aria-label={`章节${i + 1}类型`}
                      value={s.kind}
                      onChange={(e) =>
                        changeSection(s.id, {
                          kind: e.target.value as TemplateSection['kind'],
                          sourceSlot: s.sourceSlot || s.id,
                        })
                      }
                    >
                      <option value="title">标题 / 片头片尾</option>
                      <option value="main">主榜视频</option>
                      <option value="secondary">副榜分页</option>
                    </select>
                  </label>
                  <label>
                    {s.kind === 'main' ? '选段参考 / 秒' : '每段 / 秒'}
                    <input
                      aria-label={`章节${i + 1}时长`}
                      type="number"
                      min={0.1}
                      step={0.1}
                      value={s.duration}
                      onChange={(e) => changeSection(s.id, { duration: Number(e.target.value) })}
                    />
                  </label>
                </div>
                {s.kind === 'title' ? (
                  <>
                    <label>
                      文字
                      <textarea
                        aria-label={`章节${i + 1}文字`}
                        value={s.text || ''}
                        onChange={(e) => changeSection(s.id, { text: e.target.value })}
                      />
                    </label>
                    <label>
                      底色
                      <input
                        type="color"
                        value={s.background || '#101622'}
                        onChange={(e) => changeSection(s.id, { background: e.target.value })}
                      />
                    </label>
                  </>
                ) : (
                  <>
                    <label>
                      图片来源
                      <select
                        aria-label={`章节${i + 1}图片来源`}
                        value={sources[s.sourceSlot || ''] || ''}
                        onChange={(e) => {
                          setSources({ ...sources, [s.sourceSlot || s.id]: e.target.value });
                          setPreview(null);
                        }}
                      >
                        <option value="">请选择</option>
                        {project.graphics.map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="ve-form-row">
                      <label>
                        起始条目
                        <input
                          aria-label={`章节${i + 1}起始条目`}
                          type="number"
                          min={1}
                          value={s.rowStart || 1}
                          onChange={(e) =>
                            changeSection(s.id, { rowStart: Number(e.target.value) })
                          }
                        />
                      </label>
                      <label>
                        结束条目
                        <input
                          aria-label={`章节${i + 1}结束条目`}
                          type="number"
                          min={1}
                          placeholder="全部"
                          value={s.rowEnd || ''}
                          onChange={(e) =>
                            changeSection(s.id, { rowEnd: Number(e.target.value) || undefined })
                          }
                        />
                      </label>
                      <label>
                        顺序
                        <select
                          value={s.order}
                          onChange={(e) =>
                            changeSection(s.id, { order: e.target.value as 'forward' | 'reverse' })
                          }
                        >
                          <option value="forward">数据正序</option>
                          <option value="reverse">数据倒序</option>
                        </select>
                      </label>
                    </div>
                    {s.kind === 'main' && (
                      <>
                        <label>
                          主榜画面
                          <select
                            aria-label={`章节${i + 1}主榜画面`}
                            value={s.mainMode}
                            onChange={(e) =>
                              changeSection(s.id, {
                                mainMode: e.target.value as 'window' | 'alternating',
                              })
                            }
                          >
                            <option value="window">模板内视频窗口</option>
                            <option value="alternating">图片与全屏视频交替</option>
                          </select>
                        </label>
                        {s.mainMode === 'window' ? (
                          <>
                            <div className="ve-form-row">
                              {(['x', 'y', 'width', 'height'] as const).map((k) => (
                                <label key={k}>
                                  {
                                    { x: '窗口 X', y: '窗口 Y', width: '窗口宽', height: '窗口高' }[
                                      k
                                    ]
                                  }
                                  <input
                                    type="number"
                                    value={s.window[k]}
                                    onChange={(e) =>
                                      changeSection(s.id, {
                                        window: { ...s.window, [k]: Number(e.target.value) },
                                      })
                                    }
                                  />
                                </label>
                              ))}
                            </div>
                            <label>
                              透明前景（可选）
                              <select
                                aria-label={`章节${i + 1}前景`}
                                value={sources[`${s.sourceSlot}:foreground`] || ''}
                                onChange={(e) => {
                                  setSources((v) => ({
                                    ...v,
                                    [`${s.sourceSlot}:foreground`]: e.target.value,
                                  }));
                                  setPreview(null);
                                }}
                              >
                                <option value="">不叠加额外前景</option>
                                {project.graphics.map((g) => (
                                  <option value={g.id} key={g.id}>
                                    {g.name}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <p className="ve-help">
                              图片来源位于视频窗口下方，透明前景位于视频上方。前景中的透明区域会透出视频。
                            </p>
                          </>
                        ) : (
                          <label>
                            卡片停留 / 秒
                            <input
                              type="number"
                              value={s.cardDuration}
                              min={0.1}
                              step={0.1}
                              onChange={(e) =>
                                changeSection(s.id, { cardDuration: Number(e.target.value) })
                              }
                            />
                          </label>
                        )}
                      </>
                    )}
                    {s.kind === 'secondary' && (
                      <label>
                        页间叠化 / 秒
                        <input
                          aria-label={`章节${i + 1}叠化`}
                          type="number"
                          min={0}
                          step={0.1}
                          value={s.transition}
                          onChange={(e) =>
                            changeSection(s.id, { transition: Number(e.target.value) })
                          }
                        />
                      </label>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>
          <button
            onClick={() =>
              change({
                sections: [
                  ...template.sections,
                  {
                    ...starterTemplate().sections[0],
                    id: uid('section'),
                    name: '新章节',
                    text: 'SH / HOT / 特别推荐',
                    sourceSlot: uid('slot'),
                  },
                ],
              })
            }
          >
            <Plus size={14} />
            添加章节
          </button>
          <label>
            副榜背景音乐
            <select
              aria-label="副榜背景音乐"
              value={bgm}
              onChange={(e) => {
                setBgm(e.target.value);
                setPreview(null);
              }}
            >
              <option value="">无背景音乐</option>
              {project.assets
                .filter((a) => a.hasAudio)
                .map((a) => (
                  <option value={a.id} key={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="ve-check">
            <input
              type="checkbox"
              checked={bgmLoop}
              onChange={(e) => {
                setBgmLoop(e.target.checked);
                setPreview(null);
              }}
            />
            音乐不足时循环（关闭时剩余静音）
          </label>
          <button className="ve-primary" onClick={makePreview}>
            预览编排结果
          </button>
          {result && (
            <div className="ve-template-summary">
              <b>{result.name}</b>
              <p>
                {result.tracks.length} 条轨道 · {result.clips.length} 个片段 ·{' '}
                {(sequenceDuration(result) / result.fps).toFixed(2)} 秒
              </p>
              <p>生成独立序列，所有片段均可继续自由剪辑。</p>
              <button
                className="ve-primary"
                onClick={() => {
                  try {
                    onApply(
                      applyRankingTemplate(project, template, {
                        sources,
                        main: [],
                        mainBySource: project.rankingBindings,
                        bgmAssetId: bgm || undefined,
                        bgmLoop,
                      }),
                    );
                  } catch (e) {
                    onError(e instanceof Error ? e.message : String(e));
                  }
                }}
              >
                生成到新序列
              </button>
            </div>
          )}
        </>
      )}
      <input
        ref={file}
        type="file"
        hidden
        accept=".tevt,.json"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void load(f);
          e.target.value = '';
        }}
      />
    </section>
  );
}
