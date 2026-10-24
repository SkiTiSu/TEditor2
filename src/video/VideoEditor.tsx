import { copyTimelineClips, pasteTimelineClips, TIMELINE_CLIPBOARD_MIME } from './clipboard';
import { rescaleSequence } from './frameRate';
import { FrameRateInput } from './FrameRateInput';
import { defaultVideoBitrate, FRAME_RATE_HINT, type VideoBitrateMode } from './settings';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Clapperboard,
  Download,
  FilePlus2,
  FolderOpen,
  ImagePlus,
  Music2,
  Plus,
  Save,
  Search,
  Type,
  X,
  Trash2,
} from 'lucide-react';
import type { ImageResolver, TableData, TedDocument } from '../core/types';
import { downloadBlob } from '../core/assets';
import { renderBatchPage } from '../core/batch';
import type {
  GraphicSource,
  MediaAsset,
  VideoClip,
  VideoProject,
  VideoSequence,
  VideoTrack,
} from './types';
import {
  createClip,
  createGraphicAssets,
  createGraphicSource,
  createProject,
  createSequence,
  createTrack,
  parseProject,
  sequenceDuration,
  serializeProject,
  uid,
  validateProject,
  validateSequence,
} from './model';
import {
  deleteClips,
  duplicateClips,
  insertClips,
  moveClips,
  overwriteClips,
  relatedClipIds,
  removeTransition,
  replaceClipAsset,
  setTransition,
  splitClips,
  trimClip,
  ungroupClips,
  unlinkClips,
  updateClips,
} from './edit';
import { getMediaFile, putMediaFile, readVideoDraft, saveVideoDraft } from './storage';
import { MediaLibrary, isFileAsset, probeMedia } from './media';
import { captureGraphicResources, graphicFiles, restoreGraphicResources } from './graphics';
import { SequenceRenderer } from './compositor';
import {
  exportSequence,
  preflightExport,
  type ExportProgress,
  type VideoExportResult,
} from './export';
import { Timeline } from './Timeline';
import { Inspector } from './Inspector';
import { ProgramMonitor, SourceMonitor, timecode } from './Monitors';
import { TemplatePanel } from './TemplatePanel';
import { SlideshowEditor } from './SlideshowEditor';
import { SiteCredits } from '../components/SiteCredits';
import { assetUsage, removeAsset } from './assetActions';
import {
  createSlideshowSequence,
  inspectSlideshow,
  insertSlides,
  removeSlides,
  rescaleSlideshow,
  duplicateSlides,
} from './slideshow';
import './video.css';

export interface VideoEditorProps {
  visible: boolean;
  onClose: () => void;
  imageDocument: TedDocument;
  imageTable: TableData;
  imageName: string;
  imageRow: number;
  imageLayout: GraphicSource['layout'];
  imageRevision: number;
  imageFiles: Map<string, File>;
  resolveImage: ImageResolver;
  linkedGraphicId: string | null;
  onLinkGraphic: (id: string | null, layout?: GraphicSource['layout']) => void;
  onEditGraphic: (source: GraphicSource, files: Map<string, File>) => void;
}
const cleanLayout = ({ start, end, repeats, deltaX, deltaY }: GraphicSource['layout']) => ({
  start,
  end,
  repeats,
  deltaX,
  deltaY,
});
const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
const kindName = {
  video: '视频',
  audio: '音频',
  image: '图片',
  graphic: '关联图文',
  text: '文字',
  color: '色块',
};

export default function VideoEditor(props: VideoEditorProps) {
  const [project, setProject] = useState<VideoProject>(() => createProject());
  const [viewMode, setViewMode] = useState<'timeline' | 'ppt'>(() => {
    try {
      return localStorage.getItem('teditor-video-editor-view') === 'ppt' ? 'ppt' : 'timeline';
    } catch {
      return 'timeline';
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('teditor-video-editor-view', viewMode);
    } catch {
      /* View preference does not block editing. */
    }
  }, [viewMode]);
  const projectRef = useRef(project);
  projectRef.current = project;
  const media = useMemo(() => new MediaLibrary(), []);
  const renderer = useMemo(
    () => new SequenceRenderer(media, props.resolveImage),
    [media, props.resolveImage],
  );
  const [ready, setReady] = useState(false),
    [status, setStatus] = useState('正在恢复视频工程…');
  const [autosaveAllowed, setAutosaveAllowed] = useState(false);
  const [dirty, setDirty] = useState(false),
    [message, setMessage] = useState('');
  const [frame, setFrame] = useState(0),
    [playing, setPlaying] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]),
    [assetId, setAssetId] = useState('');
  const editFocus = useRef<'library' | 'timeline'>('timeline');
  const [sourceIn, setSourceIn] = useState(0),
    [sourceOut, setSourceOut] = useState(5);
  const [search, setSearch] = useState(''),
    [filter, setFilter] = useState('all');
  const [folder, setFolder] = useState('');
  const [relinkScope, setRelinkScope] = useState('all');
  const [operation, setOperation] = useState<'insert' | 'overwrite' | null>(null);
  const [syncTracks, setSyncTracks] = useState<Record<string, string[] | undefined>>({});
  const [panels, setPanels] = useState({ left: 236, right: 290, timeline: 34 });
  const [ranking, setRanking] = useState(false),
    [singleViewer, setSingleViewer] = useState(false);
  const [busy, setBusy] = useState(false),
    [mediaRevision, setMediaRevision] = useState(0);
  const [dialog, setDialog] = useState<'graphics' | 'sequence' | 'export' | null>(null);
  const [graphicMode, setGraphicMode] = useState<'current' | 'rows' | 'pages'>('pages');
  const [graphicLayout, setGraphicLayout] = useState(cleanLayout(props.imageLayout));
  const [graphicSelected, setGraphicSelected] = useState<string[]>([]);
  const [exportStart, setExportStart] = useState(0),
    [exportEnd, setExportEnd] = useState(0),
    [quality, setQuality] = useState(6);
  const [bitrateMode, setBitrateMode] = useState<VideoBitrateMode>('variable');
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  const [exportCheck, setExportCheck] = useState(''),
    [exportResult, setExportResult] = useState<VideoExportResult | null>(null);
  const [downloadUrl, setDownloadUrl] = useState('');
  const exportAbort = useRef<AbortController | null>(null),
    exportActive = useRef(false);
  const [sequenceForm, setSequenceForm] = useState({
    name: '',
    width: 1920,
    height: 1080,
    fps: 60,
  });
  const history = useRef<{ past: VideoProject[]; future: VideoProject[] }>({
    past: [],
    future: [],
  });
  const [historyRevision, setHistoryRevision] = useState(0);
  const importInput = useRef<HTMLInputElement>(null),
    importDirectoryInput = useRef<HTMLInputElement>(null),
    openInput = useRef<HTMLInputElement>(null),
    relinkInput = useRef<HTMLInputElement>(null);
  const sequence =
    project.sequences.find((s) => s.id === project.activeSequenceId) || project.sequences[0];
  const selected = sequence.clips.find((c) => c.id === selectedIds[0]);
  const currentAsset = project.assets.find((a) => a.id === assetId);
  const selectedAsset = project.assets.find((a) => a.id === selected?.assetId);
  const total = sequenceDuration(sequence);
  const slideshow = useMemo(
    () => inspectSlideshow(sequence, project.assets),
    [sequence, project.assets],
  );
  const selectedPage =
    slideshow.pages.find((c) => c.id === selectedIds[0]) ||
    slideshow.pages.find((c) => c.start <= frame && c.start + c.duration > frame) ||
    slideshow.pages[0];
  const syncTrackIds = syncTracks[sequence.id];
  const operationTrack =
    currentAsset &&
    sequence.tracks.find(
      (t) => t.kind === (currentAsset.kind === 'audio' ? 'audio' : 'video') && !t.locked,
    );
  function assetRange(id: string) {
    const asset = project.assets.find((a) => a.id === id);
    const seconds = !asset?.duration
      ? 5
      : asset.id === assetId
        ? sourceOut - sourceIn
        : Math.min(25, asset.duration);
    return { duration: Math.max(1, Math.floor(seconds * sequence.fps + 1e-7)) };
  }

  function commit(next: VideoProject | ((p: VideoProject) => VideoProject)) {
    if (exportActive.current) {
      setMessage('导出期间请先取消导出再修改工程。');
      return false;
    }
    try {
      const prev = projectRef.current,
        value = typeof next === 'function' ? next(prev) : next;
      if (value === prev) return false;
      const checked = validateProject({ ...value, updatedAt: new Date().toISOString() });
      history.current.past.push(prev);
      if (history.current.past.length > 35) history.current.past.shift();
      history.current.future = [];
      projectRef.current = checked;
      setProject(checked);
      setDirty(true);
      setHistoryRevision((n) => n + 1);
      setPlaying(false);
      return true;
    } catch (e) {
      setMessage(errorMessage(e));
      return false;
    }
  }
  function edit(action: (s: VideoSequence) => VideoSequence) {
    return commit((p) => ({
      ...p,
      sequences: p.sequences.map((s) =>
        s.id === p.activeSequenceId ? validateSequence(action(s), p.assets) : s,
      ),
    }));
  }
  function undo(redo = false) {
    if (exportActive.current) return;
    const h = history.current,
      from = redo ? h.future : h.past,
      to = redo ? h.past : h.future;
    const next = from.pop();
    if (!next) return;
    to.push(projectRef.current);
    projectRef.current = next;
    setProject(next);
    setPlaying(false);
    setDirty(true);
    setHistoryRevision((n) => n + 1);
  }
  function selectAsset(asset: MediaAsset) {
    setAssetId(asset.id);
    setSourceIn(0);
    setSourceOut(asset.duration > 0 ? Math.min(25, asset.duration) : 5);
  }
  function deleteSelectedAsset() {
    if (busy || exportActive.current) return;
    const current = projectRef.current;
    const asset = current.assets.find((a) => a.id === assetId);
    if (!asset) return;
    const usage = assetUsage(current, asset.id);
    if (usage.locked) {
      setMessage('素材正在锁定轨道中使用，请先解锁相关轨道。');
      return;
    }
    if (
      (usage.clips || usage.bindings) &&
      !confirm(
        `“${asset.name}”已用于 ${usage.sequences} 个序列、${usage.clips} 个片段、${usage.bindings} 项主榜绑定。删除素材会同时移除这些引用，可撤销；磁盘原文件保留。继续吗？`,
      )
    )
      return;
    if (commit((p) => removeAsset(p, asset.id))) {
      setAssetId('');
      setMessage('素材已从工程删除，可撤销；磁盘原文件保留。');
    }
  }
  function seek(value: number) {
    setPlaying(false);
    setFrame(Math.max(0, Math.min(total, Math.round(value))));
  }
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const restored = await readVideoDraft();
        if (restored) {
          for (const asset of restored.assets)
            if (isFileAsset(asset)) {
              const file = await getMediaFile(asset.id);
              if (file && active) media.register(asset.id, file);
            }
          const resources = await restoreGraphicResources(restored);
          if (active) {
            for (const [id, file] of resources) media.register(id, file);
            projectRef.current = restored;
            setProject(restored);
            setMediaRevision((n) => n + 1);
          }
        }
        if (active) {
          setAutosaveAllowed(true);
          setStatus('视频草稿已在本机恢复');
        }
      } catch (e) {
        if (active) {
          setMessage('恢复失败：' + errorMessage(e));
          setStatus('草稿恢复失败，已暂停自动保存；原草稿保留，请新建或打开工程后继续。');
        }
      } finally {
        if (active) setReady(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [media]);
  useEffect(() => {
    if (!ready || !autosaveAllowed) return;
    setStatus('正在保存视频草稿…');
    const timer = setTimeout(
      () =>
        void saveVideoDraft(project)
          .then(() => setStatus('视频草稿已保存在本机'))
          .catch((e) => setStatus('草稿失败：' + errorMessage(e))),
      500,
    );
    return () => clearTimeout(timer);
  }, [project, ready, autosaveAllowed]);
  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => {
      if (dirty || exportActive.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty]);
  useEffect(() => {
    setRelinkScope('all');
  }, [project.id]);
  useEffect(() => {
    if (!props.visible) setPlaying(false);
  }, [props.visible]);
  useEffect(() => {
    setSelectedIds((ids) => ids.filter((id) => sequence.clips.some((c) => c.id === id)));
    setFrame((f) => Math.min(f, total));
  }, [sequence, total]);
  useEffect(() => {
    if (!ready || !props.linkedGraphicId) return;
    const current = projectRef.current.graphics.find((g) => g.id === props.linkedGraphicId);
    if (!current) return;
    let active = true;
    const nextTable = structuredClone(props.imageTable);
    const nextDocument = structuredClone(props.imageDocument);
    const layout = cleanLayout(props.imageLayout);
    const rowCount = Math.max(1, nextTable.rows.length);
    layout.start = Math.max(1, Math.min(layout.start, rowCount));
    layout.end = Math.max(layout.start, Math.min(layout.end, rowCount));
    const files = new Map(props.imageFiles);
    void captureGraphicResources(files, current.resources)
      .then((captured) => {
        if (!active) return;
        const latest = projectRef.current.graphics.find((g) => g.id === current.id);
        if (!latest) return;
        for (const [id, file] of captured.files)
          if (media.getFile(id) !== file) media.register(id, file);
        if (
          JSON.stringify(latest.document) === JSON.stringify(nextDocument) &&
          JSON.stringify(latest.table) === JSON.stringify(nextTable) &&
          JSON.stringify(latest.layout) === JSON.stringify(layout) &&
          JSON.stringify(latest.resources) === JSON.stringify(captured.resources)
        )
          return;
        const next = {
          ...latest,
          document: nextDocument,
          table: nextTable,
          rowIds: [...(nextTable.rowIds || latest.rowIds)],
          layout,
          resources: captured.resources,
          revision: latest.revision + 1,
        };
        if (latest.rowIds.some((id) => !next.rowIds.includes(id)))
          setMessage('图片数据中有行被删除，原视频片段已保留；请检查并重新关联缺失条目。');
        commit((p) => ({ ...p, graphics: p.graphics.map((g) => (g.id === next.id ? next : g)) }));
      })
      .catch((e) => {
        if (active) setMessage('图文资源保存失败：' + errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, [
    props.imageDocument,
    props.imageTable,
    props.imageLayout,
    props.imageRevision,
    props.linkedGraphicId,
    ready,
    media,
  ]);
  const graphicsSignature = useMemo(() => JSON.stringify(project.graphics), [project.graphics]);
  useEffect(() => {
    renderer.invalidate();
  }, [graphicsSignature, renderer]);
  useEffect(() => {
    renderer.invalidate();
    setMediaRevision((n) => n + 1);
  }, [props.imageRevision, renderer]);
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(''), 10000);
    return () => clearTimeout(t);
  }, [message]);

  const waveformKey = project.assets
    .filter((a) => a.hasAudio && a.waveformVersion !== 1)
    .map((a) => a.id)
    .join(',');
  const [waveformBusy, setWaveformBusy] = useState(false);
  useEffect(() => {
    if (!ready || busy || exportProgress || !waveformKey) return;
    const abort = new AbortController();
    const projectId = projectRef.current.id;
    setWaveformBusy(true);
    void (async () => {
      for (const id of waveformKey.split(',')) {
        const file = media.getFile(id);
        if (!file) continue;
        try {
          const waveform = await media.waveform(id, undefined, abort.signal);
          if (abort.signal.aborted) return;
          const current = projectRef.current;
          if (
            current.id !== projectId ||
            media.getFile(id) !== file ||
            !current.assets.some((a) => a.id === id)
          )
            continue;
          // Waveforms are a derived preview cache, not a user edit or an undo step.
          const next = {
            ...current,
            assets: current.assets.map((a) =>
              a.id === id ? { ...a, waveform, waveformVersion: 1 } : a,
            ),
          };
          projectRef.current = next;
          setProject(next);
        } catch {
          /* Missing/unsupported audio still has normal playback and export diagnostics. */
        }
      }
      if (!abort.signal.aborted) setWaveformBusy(false);
    })();
    return () => {
      abort.abort();
      setWaveformBusy(false);
    };
  }, [waveformKey, ready, busy, !!exportProgress, mediaRevision, media]);

  async function importFiles(files: File[], relink = false) {
    if (exportActive.current || busy) return;
    setBusy(true);
    setPlaying(false);
    const temporaryIds: string[] = [];
    try {
      const added: MediaAsset[] = [],
        replacements = new Map<string, MediaAsset>();
      const staged = new Map<string, File>();
      const failures: string[] = [];
      const records = [
        ...projectRef.current.assets
          .filter(isFileAsset)
          .filter((a) => relinkScope === 'all' || relinkScope === a.id)
          .map((a) => ({ ...a, path: a.relativePath })),
        ...projectRef.current.graphics
          .filter((g) => relinkScope === 'all' || relinkScope === g.id)
          .flatMap((g) => (g.resources || []).map((r) => ({ ...r, name: r.fileName }))),
      ];
      for (const file of files) {
        try {
          if (relink) {
            const path = file.webkitRelativePath || file.name;
            const matches = records.filter(
              (a) =>
                (a.path === path || a.fileName === file.name) &&
                (a.size === undefined || a.size === file.size) &&
                (a.lastModified === undefined || a.lastModified === file.lastModified),
            );
            if (!matches.length && records.some((a) => a.path === path || a.fileName === file.name))
              throw new Error('文件大小或修改时间与工程记录不同，请作为新素材导入后明确替换');
            const exact = matches.filter((a) => a.path === path);
            const targets = [
              ...new Map((exact.length ? exact : matches).map((a) => [a.id, a])).values(),
            ];
            if (targets.length > 1)
              throw new Error('匹配到多个素材版本，请先在重新关联范围中选择具体素材或图文方案');
            for (const target of targets) {
              if (target.lastModified !== undefined && target.lastModified !== file.lastModified)
                throw new Error('文件修改时间与工程记录不同，请作为新素材导入后明确替换');
              if ('kind' in target) {
                const probed = await probeMedia(file);
                if (probed.kind !== target.kind) throw new Error('文件类型与原素材不一致');
                replacements.set(target.id, {
                  ...probed,
                  id: target.id,
                  name: target.name,
                  relativePath: target.path,
                });
              }
              staged.set(target.id, file);
            }
          } else {
            if (
              !file.type.match(/^(video|audio|image)\//) &&
              !/\.(mp4|mov|mkv|webm|m4v|mp3|m4a|wav|aac|flac|ogg|opus|png|jpe?g|gif|bmp|webp|avif)$/i.test(
                file.name,
              )
            )
              continue;
            const asset = await media.probe(file);
            temporaryIds.push(asset.id);
            added.push(asset);
            staged.set(asset.id, file);
          }
        } catch (e) {
          failures.push(`${file.name}：${errorMessage(e)}`);
        }
      }
      if (!staged.size) {
        setMessage(failures.join('；') || '未找到匹配的素材文件。');
        return;
      }
      // Validate the entire candidate before replacing any existing file or persisted resource.
      const current = projectRef.current;
      let candidate = validateProject({
        ...current,
        assets: [...current.assets.map((a) => replacements.get(a.id) || a), ...added],
      });
      const slideAssets = added.filter((a) => a.kind === 'image');
      if (viewMode === 'ppt' && slideAssets.length)
        candidate = withSlideAssets(
          candidate,
          slideAssets.map((a) => a.id),
        );
      if (!commit(candidate)) return;
      if (viewMode === 'ppt' && slideAssets.length) {
        const next = candidate.sequences.find((s) => s.id === candidate.activeSequenceId)!;
        const addedPage = next.clips.find((c) => c.assetId === slideAssets[0].id);
        if (addedPage) {
          setSelectedIds([addedPage.id]);
          setFrame(pageFrame(next, addedPage.id));
        }
      }
      for (const [id, file] of staged) {
        media.register(id, file);
        try {
          await putMediaFile(id, file);
        } catch (e) {
          failures.push(`本机缓存失败，重开后需重新关联：${errorMessage(e)}`);
        }
      }
      renderer.invalidate();
      setMediaRevision((n) => n + 1);
      if (added[0]) selectAsset(added[0]);
      setMessage(
        `${relink ? '已重新关联' : '已导入'} ${staged.size} 个素材。${failures.length ? '\n' + failures.join('；') : ''}`,
      );
    } catch (e) {
      setMessage('导入失败：' + errorMessage(e));
    } finally {
      for (const id of temporaryIds)
        if (!projectRef.current.assets.some((a) => a.id === id)) media.remove(id);
      setBusy(false);
    }
  }
  async function openProject(file: File) {
    setBusy(true);
    try {
      const next = parseProject(await file.text());
      if (dirty && !confirm('打开视频工程将替换当前视频工程，继续吗？')) return;
      for (const asset of next.assets)
        if (isFileAsset(asset) && !media.has(asset.id)) {
          const stored = await getMediaFile(asset.id);
          if (stored) media.register(asset.id, stored);
        }
      for (const [id, stored] of await restoreGraphicResources(next)) media.register(id, stored);
      projectRef.current = next;
      setProject(next);
      setAutosaveAllowed(true);
      history.current = { past: [], future: [] };
      setHistoryRevision((n) => n + 1);
      setSelectedIds([]);
      setFrame(0);
      setPlaying(false);
      setDirty(false);
      props.onLinkGraphic(null);
      setMediaRevision((n) => n + 1);
      setMessage('工程已打开，缺失素材可通过“重新关联”恢复。');
    } catch (e) {
      setMessage(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  function saveProject() {
    try {
      downloadBlob(
        new Blob([serializeProject(projectRef.current)], { type: 'application/json' }),
        `${projectRef.current.name}.tevideo`,
      );
      setDirty(false);
    } catch (e) {
      setMessage(errorMessage(e));
    }
  }
  function addAsset(kind: 'text' | 'color') {
    const asset: MediaAsset = {
      id: uid('asset'),
      name: kind === 'text' ? '标题文字' : '纯色色块',
      kind,
      duration: 0,
      width: sequence.width,
      height: sequence.height,
      hasAudio: false,
      text: kind === 'text' ? '输入标题' : undefined,
      color: kind === 'text' ? '#ffffff' : '#17243b',
      fontFamily: 'sans-serif',
      fontSize: 96,
    };
    commit((p) => ({ ...p, assets: [...p.assets, asset] }));
    selectAsset(asset);
  }
  function addToTimeline(
    asset: MediaAsset,
    mode: 'insert' | 'overwrite' | 'place' = 'insert',
    trackId?: string,
    at = frame,
  ) {
    edit((s) => {
      let next = structuredClone(s);
      const audioOnly = asset.kind === 'audio';
      let target =
        next.tracks.find((t) => t.id === trackId) ||
        next.tracks.find((t) => t.kind === (audioOnly ? 'audio' : 'video') && !t.locked);
      if (!target) {
        target = createTrack(audioOnly ? 'audio' : 'video');
        next.tracks.push(target);
      }
      if (target.locked) throw new Error('目标轨道已锁定');
      if (target.kind === 'video' && audioOnly) throw new Error('音频素材请放入音频轨道');
      if (target.kind === 'audio' && !asset.hasAudio) throw new Error('该素材不包含声音');
      const isActive = asset.id === assetId;
      const start = isActive && asset.duration > 0 ? sourceIn : 0;
      const end =
        isActive && asset.duration > 0
          ? sourceOut
          : asset.duration > 0
            ? Math.min(25, asset.duration)
            : 5;
      if (asset.duration > 0 && (!(end > start) || start < 0 || end > asset.duration + 1e-6))
        throw new Error('请设置有效的素材入点、出点');
      const duration = Math.floor((end - start) * s.fps + 1e-7);
      if (duration < 1) throw new Error('选择的素材区间不足一帧，请扩大入出点范围');
      const clip = { ...createClip(asset, target.id, at, duration, next), sourceIn: start };
      const incoming = [clip];
      const overwritten =
        mode === 'overwrite'
          ? next.clips.filter(
              (c) =>
                c.trackId === target.id && c.start < at + duration && c.start + c.duration > at,
            )
          : [];
      const clearedTracks = [
        ...new Set(
          relatedClipIds(
            next,
            overwritten.map((c) => c.id),
            false,
          ).map((id) => next.clips.find((c) => c.id === id)!.trackId),
        ),
      ];
      if (
        mode === 'overwrite' &&
        target.kind === 'audio' &&
        clearedTracks.some((id) => next.tracks.find((t) => t.id === id)?.kind === 'video')
      )
        throw new Error('此音轨与画面关联，请先解除音视频关联，再覆盖声音，或将音乐放入独立音轨。');
      if (target.kind === 'video' && asset.hasAudio) {
        let audioTrack =
          next.tracks.find((t) => t.kind === 'audio' && clearedTracks.includes(t.id)) ||
          next.tracks.find(
            (t) =>
              t.kind === 'audio' &&
              !t.locked &&
              !next.clips.some(
                (c) => c.trackId === t.id && c.start < at + duration && c.start + c.duration > at,
              ),
          );
        if (!audioTrack) {
          audioTrack = createTrack(
            'audio',
            `原声 ${next.tracks.filter((t) => t.kind === 'audio').length + 1}`,
          );
          next.tracks.push(audioTrack);
        }
        const linkId = uid('link');
        clip.linkId = linkId;
        incoming.push({
          ...structuredClone(clip),
          id: uid('clip'),
          trackId: audioTrack.id,
          linkId,
        });
      }
      next =
        mode === 'insert'
          ? insertClips(
              next,
              incoming,
              at,
              syncTrackIds && [...new Set([...syncTrackIds, ...incoming.map((c) => c.trackId)])],
            )
          : mode === 'overwrite'
            ? overwriteClips(next, incoming, clearedTracks)
            : validateSequence(
                { ...next, clips: [...next.clips, ...incoming] },
                projectRef.current.assets,
              );
      setSelectedIds([clip.id]);
      return next;
    });
  }
  function modifyClip(patch: Partial<VideoClip>) {
    if (!selected) return;
    edit((s) => {
      let next = s;
      if (patch.start !== undefined)
        next = moveClips(next, [selected.id], patch.start - selected.start);
      if (patch.duration !== undefined) {
        const clip = next.clips.find((c) => c.id === selected.id)!;
        next = trimClip(
          next,
          selected.id,
          'end',
          clip.start + patch.duration,
          projectRef.current.assets,
        );
      }
      if (patch.sourceIn !== undefined) {
        const ids = new Set(relatedClipIds(next, [selected.id], false));
        if (
          next.clips.some(
            (c) => ids.has(c.id) && next.tracks.find((t) => t.id === c.trackId)?.locked,
          )
        )
          throw new Error('关联轨道已锁定');
        next = {
          ...next,
          clips: next.clips.map((c) => (ids.has(c.id) ? { ...c, sourceIn: patch.sourceIn! } : c)),
        };
      }
      const rest = { ...patch };
      delete rest.start;
      delete rest.duration;
      delete rest.sourceIn;
      if (Object.keys(rest).length) next = updateClips(next, [selected.id], rest);
      return next;
    });
  }
  function trackChange(id: string, patch: Partial<VideoTrack>) {
    edit((s) => ({ ...s, tracks: s.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
  }
  function group() {
    edit((s) => {
      const ids = new Set(relatedClipIds(s, selectedIds)),
        groupId = uid('group');
      if (s.clips.some((c) => ids.has(c.id) && s.tracks.find((t) => t.id === c.trackId)?.locked))
        throw new Error('选中片段包含锁定轨道');
      return { ...s, clips: s.clips.map((c) => (ids.has(c.id) ? { ...c, groupId } : c)) };
    });
  }
  function addTransition(duration: number) {
    edit((s) => {
      const clips = s.clips
        .filter(
          (c) =>
            selectedIds.includes(c.id) &&
            s.tracks.find((t) => t.id === c.trackId)?.kind === 'video',
        )
        .sort((a, b) => a.start - b.start);
      if (clips.length !== 2) throw new Error('请选择同一画面轨道上相邻的两个片段');
      return setTransition(s, clips[0].id, clips[1].id, duration);
    });
  }
  const graphicCandidate = useMemo(() => {
    try {
      const layout =
        graphicMode === 'current'
          ? { ...graphicLayout, start: props.imageRow + 1, end: props.imageRow + 1, repeats: 0 }
          : graphicMode === 'rows'
            ? { ...graphicLayout, repeats: 0 }
            : graphicLayout;
      const source = createGraphicSource(
        props.imageDocument,
        props.imageTable,
        props.imageName,
        layout,
      );
      source.id = 'candidate';
      const assets = createGraphicAssets(source);
      return { source, assets, error: '' };
    } catch (e) {
      return { source: null, assets: [], error: errorMessage(e) };
    }
  }, [
    props.imageDocument,
    props.imageTable,
    props.imageName,
    props.imageRow,
    graphicLayout,
    graphicMode,
  ]);
  function openGraphics() {
    if (viewMode === 'ppt') setGraphicMode('pages');
    setGraphicLayout({
      ...cleanLayout(props.imageLayout),
      start: Math.min(props.imageLayout.start, Math.max(1, props.imageTable.rows.length)),
      end: Math.min(props.imageLayout.end, Math.max(1, props.imageTable.rows.length)),
    });
    setGraphicSelected([]);
    setDialog('graphics');
  }
  async function importGraphics() {
    if (!graphicCandidate.source || busy) return;
    setBusy(true);
    try {
      const source = structuredClone(graphicCandidate.source);
      source.id = uid('graphic');
      const captured = await captureGraphicResources(new Map(props.imageFiles));
      source.resources = captured.resources;
      const generated = createGraphicAssets(source);
      const indices = graphicSelected.length ? new Set(graphicSelected.map(Number)) : null;
      const selectedAssets = generated.filter((_, i) => !indices || indices.has(i));
      for (const [id, file] of captured.files) media.register(id, file);
      if (
        !commit((p) => {
          const next = {
            ...p,
            graphics: [...p.graphics, source],
            assets: [...p.assets, ...selectedAssets],
          };
          return viewMode === 'ppt'
            ? withSlideAssets(
                next,
                selectedAssets.map((a) => a.id),
              )
            : next;
        })
      )
        return;
      if (viewMode === 'ppt') {
        const next = projectRef.current.sequences.find(
          (s) => s.id === projectRef.current.activeSequenceId,
        )!;
        const added = next.clips.find((c) => c.assetId === selectedAssets[0]?.id);
        if (added) {
          setSelectedIds([added.id]);
          setFrame(pageFrame(next, added.id));
        }
      }
      props.onLinkGraphic(source.id, source.layout);
      if (selectedAssets[0]) selectAsset(selectedAssets[0]);
      setDialog(null);
      setMessage(
        viewMode === 'ppt'
          ? `已添加 ${selectedAssets.length} 页副榜图片，可调整时长与音乐后导出。`
          : `已关联 ${selectedAssets.length} 张图文，可拖入时间线或应用视频模板。`,
      );
    } catch (e) {
      setMessage('关联失败：' + errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  function appendGraphics() {
    const list = project.assets.filter(
      (a) =>
        a.kind === 'graphic' &&
        a.graphic?.sourceId === (currentAsset?.graphic?.sourceId || project.graphics.at(-1)?.id),
    );
    if (!list.length) {
      openGraphics();
      return;
    }
    edit((s) => {
      const track = s.tracks.find((t) => t.kind === 'video' && !t.locked);
      if (!track) throw new Error('请添加或解锁画面轨道');
      let at = frame;
      const clips = list.map((a) => {
        const c = createClip(a, track.id, at, s.fps * 5, s);
        at += c.duration;
        return c;
      });
      return insertClips(
        s,
        clips,
        frame,
        syncTrackIds && [...new Set([...syncTrackIds, track.id])],
      );
    });
  }
  function pageFrame(s: VideoSequence, id: string) {
    const clip = s.clips.find((c) => c.id === id);
    return clip ? clip.start + (s.transitions.find((t) => t.toClipId === id)?.duration || 0) : 0;
  }
  function selectPage(id: string) {
    const current = projectRef.current.sequences.find(
      (s) => s.id === projectRef.current.activeSequenceId,
    )!;
    if (!current.clips.some((c) => c.id === id)) return;
    setSelectedIds([id]);
    setPlaying(false);
    setFrame(pageFrame(current, id));
  }
  function changeSlideshow(next: VideoSequence) {
    if (
      !commit((p) => ({ ...p, sequences: p.sequences.map((s) => (s.id === next.id ? next : s)) }))
    )
      return;
    const pages = inspectSlideshow(next, projectRef.current.assets).pages;
    const current =
      pages.find((c) => c.id === selectedPage?.id) ||
      pages[
        Math.max(
          0,
          Math.min(
            pages.length - 1,
            slideshow.pages.findIndex((c) => c.id === selectedPage?.id),
          ),
        )
      ];
    setSelectedIds(current ? [current.id] : []);
    setFrame(current ? pageFrame(next, current.id) : 0);
  }
  function switchView(mode: 'timeline' | 'ppt') {
    setPlaying(false);
    setOperation(null);
    setViewMode(mode);
    if (mode === 'ppt') {
      setRanking(false);
      if (selectedPage) selectPage(selectedPage.id);
    }
  }
  function newSlideshow() {
    const next = createSlideshowSequence(
      `副榜 PPT ${project.sequences.length + 1}`,
      sequence.width,
      sequence.height,
      sequence.fps,
    );
    if (commit((p) => ({ ...p, sequences: [...p.sequences, next], activeSequenceId: next.id }))) {
      setViewMode('ppt');
      setSelectedIds([]);
      setFrame(0);
    }
  }
  function withSlideAssets(p: VideoProject, ids: string[]): VideoProject {
    const current = p.sequences.find((s) => s.id === p.activeSequenceId)!;
    const compatible = inspectSlideshow(current, p.assets).editable;
    const base = compatible
      ? current
      : createSlideshowSequence(
          `副榜 PPT ${p.sequences.length + 1}`,
          current.width,
          current.height,
          current.fps,
        );
    const next = insertSlides(base, p.assets, ids);
    return {
      ...p,
      activeSequenceId: next.id,
      sequences: compatible
        ? p.sequences.map((s) => (s.id === next.id ? next : s))
        : [...p.sequences, next],
    };
  }
  function switchSequence(id: string) {
    setPlaying(false);
    setFrame(0);
    setSelectedIds([]);
    commit((p) => ({ ...p, activeSequenceId: id }));
  }
  function newSequence(copy = false) {
    commit((p) => {
      let s = createSequence(
        `序列 ${p.sequences.length + 1}`,
        sequence.width,
        sequence.height,
        sequence.fps,
      );
      if (copy) {
        const trackIds = new Map(sequence.tracks.map((t) => [t.id, uid('track')])),
          clipIds = new Map(sequence.clips.map((c) => [c.id, uid('clip')]));
        const groups = new Map<string, string>();
        const uniqueGroup = (id: string | undefined) =>
          id ? groups.get(id) || (groups.set(id, uid('group')), groups.get(id)) : undefined;
        s = {
          ...structuredClone(sequence),
          id: s.id,
          name: sequence.name + ' 副本',
          tracks: sequence.tracks.map((t) => ({ ...t, id: trackIds.get(t.id)! })),
          clips: sequence.clips.map((c) => ({
            ...structuredClone(c),
            id: clipIds.get(c.id)!,
            trackId: trackIds.get(c.trackId)!,
            groupId: uniqueGroup(c.groupId),
            linkId: uniqueGroup(c.linkId),
          })),
          transitions: sequence.transitions.map((t) => ({
            ...t,
            id: uid('transition'),
            fromClipId: clipIds.get(t.fromClipId)!,
            toClipId: clipIds.get(t.toClipId)!,
          })),
          markers: sequence.markers.map((m) => ({ ...m, id: uid('marker') })),
          slideshow: sequence.slideshow
            ? {
                ...sequence.slideshow,
                pageTrackId: trackIds.get(sequence.slideshow.pageTrackId) || uid('track'),
                bgmTrackId: trackIds.get(sequence.slideshow.bgmTrackId) || uid('track'),
              }
            : undefined,
        };
      }
      return { ...p, activeSequenceId: s.id, sequences: [...p.sequences, s] };
    });
    setFrame(0);
    setSelectedIds([]);
  }
  function applySequenceSettings() {
    const applied = edit((s) => {
      if (
        s.tracks.some((t) => t.locked) &&
        (s.fps !== sequenceForm.fps ||
          s.width !== sequenceForm.width ||
          s.height !== sequenceForm.height)
      )
        throw new Error('更改画幅或帧率前请解锁轨道');
      if (sequenceForm.fps !== s.fps && inspectSlideshow(s, projectRef.current.assets).editable)
        return {
          ...rescaleSlideshow(s, projectRef.current.assets, sequenceForm.fps),
          ...sequenceForm,
        };
      return {
        ...rescaleSequence(s, projectRef.current.assets, sequenceForm.fps),
        ...sequenceForm,
      };
    });
    if (applied) {
      const updated = projectRef.current.sequences.find((s) => s.id === sequence.id)!;
      setFrame(
        Math.min(
          Math.max(0, sequenceDuration(updated) - 1),
          Math.round((frame * updated.fps) / sequence.fps),
        ),
      );
      setDialog(null);
    }
  }
  function persistExportSettings() {
    const settings = {
      startFrame: Math.round(exportStart * sequence.fps),
      endFrame: Math.round(exportEnd * sequence.fps),
      videoBitrate: quality * 1e6,
      videoBitrateMode: bitrateMode,
    };
    if (
      settings.startFrame < 0 ||
      settings.endFrame <= settings.startFrame ||
      settings.endFrame > total ||
      !Number.isFinite(settings.videoBitrate)
    ) {
      setExportCheck('导出区间必须位于当前序列内，且结束晚于开始。');
      return false;
    }
    if (JSON.stringify(sequence.exportSettings) !== JSON.stringify(settings))
      return commit((p) => ({
        ...p,
        sequences: p.sequences.map((s) =>
          s.id === sequence.id ? { ...s, exportSettings: settings } : s,
        ),
      }));
    return true;
  }
  async function checkExport() {
    if (!persistExportSettings()) return;
    try {
      setExportCheck('正在检查素材和编码能力…');
      const check = await preflightExport(project, sequence, renderer, {
        startFrame: Math.round(exportStart * sequence.fps),
        endFrame: Math.round(exportEnd * sequence.fps),
        videoBitrate: quality * 1e6,
        videoBitrateMode: bitrateMode,
      });
      setExportCheck(
        check.errors.length
          ? check.errors.join('\n')
          : `检查通过。预计空间约 ${(check.estimatedBytes / 1024 / 1024).toFixed(0)} MB。${check.warnings.join('；')}`,
      );
    } catch (e) {
      setExportCheck(errorMessage(e));
    }
  }
  async function runExport(direct: boolean) {
    if (exportActive.current || !persistExportSettings()) return;
    exportActive.current = true;
    setPlaying(false);
    setExportCheck('');
    const controller = new AbortController();
    exportAbort.current = controller;
    try {
      let fileHandle: FileSystemFileHandle | undefined;
      if (direct) {
        const picker = (
          window as unknown as {
            showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle>;
          }
        ).showSaveFilePicker;
        if (!picker) throw new Error('此浏览器不支持选择输出文件，请使用生成后下载。');
        fileHandle = await picker.call(window, {
          suggestedName: `${project.name}-${sequence.name}.mp4`,
          types: [{ description: 'MP4 视频', accept: { 'video/mp4': ['.mp4'] } }],
        });
      }
      setExportProgress({
        completed: 0,
        total: Math.round((exportEnd - exportStart) * sequence.fps),
        ratio: 0,
        bytes: 0,
        phase: 'checking',
      });
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
      setDownloadUrl('');
      await exportResult?.cleanup();
      setExportResult(null);
      const result = await exportSequence(projectRef.current, sequence, renderer, {
        startFrame: Math.round(exportStart * sequence.fps),
        endFrame: Math.round(exportEnd * sequence.fps),
        videoBitrate: quality * 1e6,
        videoBitrateMode: bitrateMode,
        signal: controller.signal,
        onProgress: setExportProgress,
        fileHandle,
      });
      setExportResult(result);
      setDownloadUrl(URL.createObjectURL(result.file));
      const bitrateNote =
        result.actualVideoBitrate > result.targetVideoBitrate * 1.25
          ? '实际码率高于目标，可降低目标码率或画幅后重试。'
          : result.videoBitrateMode === 'constant' &&
              result.actualVideoBitrate < result.targetVideoBitrate * 0.75
            ? '本机编码器未达到 CBR 目标，请以实际码率为准。'
            : '';
      setExportCheck(
        `导出完成：${result.frames} 帧，${result.duration.toFixed(2)} 秒，${(result.bytes / 1024 / 1024).toFixed(1)} MB，耗时 ${(result.elapsedMs / 1000).toFixed(1)} 秒。视频目标 ${(result.targetVideoBitrate / 1e6).toFixed(2)} Mbps（${result.videoBitrateMode === 'constant' ? 'CBR' : 'VBR'}），实际平均 ${(result.actualVideoBitrate / 1e6).toFixed(2)} Mbps。${bitrateNote}${direct ? '文件已写入所选位置。' : '可点击下方下载。'}`,
      );
    } catch (e) {
      setExportCheck(controller.signal.aborted ? '导出已取消，工程已保留。' : errorMessage(e));
    } finally {
      exportActive.current = false;
      exportAbort.current = null;
      setExportProgress(null);
    }
  }
  useEffect(() => {
    if (!props.visible || viewMode !== 'timeline' || dialog) return;
    const editable = (event: ClipboardEvent) => {
      const target = event.target;
      return (
        target instanceof HTMLElement &&
        (target.matches('input,textarea,select') || target.isContentEditable)
      );
    };
    const copy = (event: ClipboardEvent) => {
      if (
        event.defaultPrevented ||
        editable(event) ||
        editFocus.current !== 'timeline' ||
        !selectedIds.length ||
        !event.clipboardData
      )
        return;
      try {
        const snapshot = copyTimelineClips(project.id, sequence, selectedIds);
        event.clipboardData.setData(TIMELINE_CLIPBOARD_MIME, snapshot);
        event.clipboardData.setData('text/plain', snapshot);
        event.preventDefault();
        setMessage('已复制所选片段及关联音视频，可在播放头位置粘贴');
      } catch (error) {
        setMessage(errorMessage(error));
      }
    };
    const paste = (event: ClipboardEvent) => {
      if (
        event.defaultPrevented ||
        editable(event) ||
        editFocus.current !== 'timeline' ||
        !event.clipboardData
      )
        return;
      const text =
        event.clipboardData.getData(TIMELINE_CLIPBOARD_MIME) ||
        event.clipboardData.getData('text/plain');
      try {
        const pasted = pasteTimelineClips(project.id, sequence, project.assets, text, frame);
        if (!pasted) return;
        event.preventDefault();
        if (edit(() => pasted.sequence)) {
          setSelectedIds(pasted.selectedIds);
          setMessage(`已在播放头插入 ${pasted.selectedIds.length} 个片段，后续内容同步后移`);
        }
      } catch (error) {
        event.preventDefault();
        setMessage(errorMessage(error));
      }
    };
    window.addEventListener('copy', copy);
    window.addEventListener('paste', paste);
    return () => {
      window.removeEventListener('copy', copy);
      window.removeEventListener('paste', paste);
    };
  });
  useEffect(() => {
    if (!props.visible) return;
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const typing =
        (e.target as HTMLElement).matches('input,textarea,select') ||
        (e.target as HTMLElement).isContentEditable;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveProject();
        return;
      }
      if (typing || dialog) return;
      const inLibrary = (e.target as HTMLElement).closest('.ve-library');
      if (
        viewMode === 'timeline' &&
        (inLibrary || editFocus.current === 'library') &&
        (e.key === 'Delete' || e.key === 'Backspace')
      ) {
        e.preventDefault();
        deleteSelectedAsset();
        return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        setPlaying((v) => !v);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undo(e.shiftKey);
      } else if (viewMode === 'ppt' && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        try {
          if (selectedPage)
            changeSlideshow(duplicateSlides(sequence, project.assets, [selectedPage.id]));
        } catch (error) {
          setMessage(errorMessage(error));
        }
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        if (viewMode === 'ppt') {
          try {
            if (selectedPage)
              changeSlideshow(removeSlides(sequence, project.assets, [selectedPage.id]));
          } catch (error) {
            setMessage(errorMessage(error));
          }
        } else edit((s) => deleteClips(s, selectedIds, e.shiftKey, syncTrackIds));
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        if (viewMode === 'ppt') {
          const index = slideshow.pages.findIndex((c) => c.id === selectedPage?.id);
          const next =
            slideshow.pages[
              Math.max(
                0,
                Math.min(slideshow.pages.length - 1, index + (e.key === 'ArrowLeft' ? -1 : 1)),
              )
            ];
          if (next) selectPage(next.id);
        } else seek(frame + (e.key === 'ArrowLeft' ? -1 : 1));
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  const visibleAssets = project.assets.filter(
    (a) =>
      (filter === 'all' ||
        a.kind === filter ||
        (filter === 'unused' &&
          !project.sequences.some((s) => s.clips.some((c) => c.assetId === a.id)))) &&
      a.name.toLowerCase().includes(search.toLowerCase()) &&
      (!folder || a.relativePath?.startsWith(folder + '/')),
  );
  const folders = [
    ...new Set(
      project.assets
        .map((a) => a.relativePath?.split('/').slice(0, -1).join('/'))
        .filter((v): v is string => !!v),
    ),
  ].sort();
  const missing = [
    ...new Map(
      [...project.assets.filter(isFileAsset), ...project.graphics.flatMap((g) => g.resources || [])]
        .filter((a) => !media.has(a.id))
        .map((a) => [a.id, a]),
    ).values(),
  ];
  const programPreview = (
    <ProgramMonitor
      project={project}
      sequence={sequence}
      renderer={renderer}
      frame={frame}
      onFrame={setFrame}
      playing={playing}
      onPlaying={setPlaying}
      visible={props.visible && ready}
      revision={mediaRevision}
      selected={
        viewMode === 'ppt' ? (slideshow.editable && !playing ? selectedPage : undefined) : selected
      }
      onTransform={(patch) => {
        if (viewMode === 'ppt' && selectedPage) {
          try {
            changeSlideshow(updateClips(sequence, [selectedPage.id], patch));
          } catch (error) {
            setMessage(errorMessage(error));
          }
        } else modifyClip(patch);
      }}
      onError={setMessage}
    />
  );
  return (
    <div
      className="video-editor"
      style={props.visible ? undefined : { display: 'none' }}
      data-ready={ready}
      data-view-mode={viewMode}
      data-media-revision={mediaRevision}
      data-history-revision={historyRevision}
    >
      <header className="ve-header">
        <button onClick={props.onClose} disabled={!!exportProgress}>
          <ArrowLeft size={15} />
          图片设计
        </button>
        <div className="ve-brand">
          <Clapperboard size={20} />
          <strong>
            TEditor <span>VIDEO</span>
          </strong>
        </div>
        <input
          aria-label="视频工程名称"
          value={project.name}
          onChange={(e) => commit((p) => ({ ...p, name: e.target.value }))}
        />
        <span className="ve-local-dot">本地工作区</span>
        <div className="ve-header-actions">
          <button
            disabled={!ready || busy || !!exportProgress}
            onClick={() => {
              if (dirty && !confirm('新建视频工程将替换当前工程，继续吗？')) return;
              const next = createProject();
              if (viewMode === 'ppt') {
                const ppt = createSlideshowSequence('副榜 PPT');
                next.sequences = [ppt];
                next.activeSequenceId = ppt.id;
              }
              if (!commit(next)) return;
              setAutosaveAllowed(true);
              props.onLinkGraphic(null);
              setSelectedIds([]);
              setFrame(0);
            }}
          >
            <FilePlus2 size={15} />
            新建
          </button>
          <button onClick={() => openInput.current?.click()} disabled={busy || !!exportProgress}>
            <FolderOpen size={15} />
            打开工程
          </button>
          <button
            onClick={saveProject}
            disabled={!ready}
            title="保存编排与图文方案，不打包媒体文件；换设备后请重新关联素材目录"
          >
            <Save size={15} />
            保存工程
          </button>
          <button
            className="ve-primary"
            disabled={!total || !!exportProgress}
            onClick={() => {
              const saved = sequence.exportSettings;
              const start = Math.min(saved?.startFrame ?? 0, Math.max(0, total - 1));
              setExportStart(start / sequence.fps);
              setExportEnd(
                Math.max(start + 1, Math.min(saved?.endFrame ?? total, total)) / sequence.fps,
              );
              setQuality((saved?.videoBitrate ?? defaultVideoBitrate(sequence)) / 1e6);
              setBitrateMode(saved?.videoBitrateMode ?? 'variable');
              setExportCheck('');
              setDialog('export');
              setPlaying(false);
            }}
          >
            <Download size={15} />
            导出视频
          </button>
        </div>
      </header>
      <div className="ve-workbar">
        <div className="ve-mode-switch" role="group" aria-label="视频编辑模式">
          <button
            aria-pressed={viewMode === 'timeline'}
            className={viewMode === 'timeline' ? 'active' : ''}
            disabled={!!exportProgress || busy}
            onClick={() => switchView('timeline')}
          >
            时间轴模式
          </button>
          <button
            aria-pressed={viewMode === 'ppt'}
            className={viewMode === 'ppt' ? 'active' : ''}
            disabled={!!exportProgress || busy}
            onClick={() => switchView('ppt')}
          >
            PPT模式
          </button>
        </div>
        {viewMode === 'timeline' && (
          <>
            <span>素材 / 剪辑</span>
            <button
              className={ranking ? 'active' : ''}
              onClick={() => setRanking((v) => !v)}
              disabled={!!exportProgress}
            >
              排行榜工作台
            </button>
            <button onClick={openGraphics} disabled={!!exportProgress}>
              <ImagePlus size={14} />
              关联图片
            </button>
            <button onClick={() => setSingleViewer((v) => !v)}>
              {singleViewer ? '双预览' : '单预览'}
            </button>
            <details className="ve-sync-menu">
              <summary>同步轨道 · {syncTrackIds ? '自定' : '全部'}</summary>
              <div>
                <p>插入与波纹删除时移动的轨道；关联音视频需同时勾选。插入目标轨道自动包含。</p>
                <button onClick={() => setSyncTracks((v) => ({ ...v, [sequence.id]: undefined }))}>
                  恢复全部轨道
                </button>
                {sequence.tracks.map((track) => (
                  <label key={track.id}>
                    <input
                      type="checkbox"
                      aria-label={`同步轨道 ${track.name}`}
                      checked={!syncTrackIds || syncTrackIds.includes(track.id)}
                      onChange={(e) =>
                        setSyncTracks((v) => {
                          const ids = v[sequence.id] || sequence.tracks.map((t) => t.id);
                          return {
                            ...v,
                            [sequence.id]: e.target.checked
                              ? [...ids, track.id]
                              : ids.filter((id) => id !== track.id),
                          };
                        })
                      }
                    />
                    {track.name}
                  </label>
                ))}
              </div>
            </details>
          </>
        )}
        {viewMode === 'ppt' && (
          <>
            <span className="ve-ppt-summary">副榜图片 · 排序 / 时长 / 音乐</span>
            {selectedPage && project.assets.find((a) => a.id === selectedPage.assetId)?.graphic && (
              <button
                disabled={!!exportProgress || busy}
                onClick={() => {
                  const a = project.assets.find((a) => a.id === selectedPage.assetId)!;
                  const g = project.graphics.find((g) => g.id === a.graphic!.sourceId);
                  if (g)
                    props.onEditGraphic(
                      g,
                      graphicFiles(g, (id) => media.getFile(id)),
                    );
                }}
              >
                编辑本页图片
              </button>
            )}
            {!!missing.length && (
              <button
                onClick={() => {
                  setRelinkScope('all');
                  relinkInput.current?.click();
                }}
                disabled={busy || !!exportProgress}
              >
                {missing.length} 个素材需重新关联
              </button>
            )}
          </>
        )}
        <span className="ve-workbar-status">
          {busy ? '正在处理素材…' : status}
          {dirty ? ' · 工程文件未保存' : ''}
        </span>
      </div>
      {viewMode === 'ppt' ? (
        <SlideshowEditor
          sequence={sequence}
          assets={project.assets}
          graphics={project.graphics}
          disabled={!ready || busy || !!exportProgress}
          selectedId={
            playing
              ? slideshow.pages.find((c) => c.start <= frame && c.start + c.duration > frame)?.id
              : selectedPage?.id
          }
          onSelect={selectPage}
          onChange={changeSlideshow}
          onNewSequence={newSlideshow}
          onOpenGraphics={openGraphics}
          onImportMedia={() => importInput.current?.click()}
          onError={setMessage}
          onUndo={() => undo()}
          onRedo={() => undo(true)}
          canUndo={!!history.current.past.length}
          canRedo={!!history.current.future.length}
          preview={programPreview}
          renderThumbnail={(a) => {
            const source = project.graphics.find((g) => g.id === a.graphic?.sourceId);
            if (source)
              return (
                <GraphicThumb
                  source={source}
                  asset={a}
                  resolveImage={props.resolveImage}
                  media={media}
                  revision={mediaRevision}
                />
              );
            if (a.thumbnail || (a.kind === 'image' && media.has(a.id)))
              return <img src={a.thumbnail || media.getUrl(a.id)} alt="" />;
            return (
              <div
                className="ve-ppt-asset-placeholder"
                style={{
                  background: a.kind === 'color' ? a.color : undefined,
                  color: a.kind === 'text' ? a.color : undefined,
                }}
              >
                {a.kind === 'text' ? a.text : a.name}
              </div>
            );
          }}
        />
      ) : (
        <>
          <fieldset
            className="ve-workspace"
            disabled={!ready || !!exportProgress}
            style={{
              gridTemplateColumns: `${panels.left}px 5px minmax(250px, 1fr) 5px ${panels.right}px`,
            }}
          >
            <aside
              className="ve-library"
              tabIndex={-1}
              onPointerDownCapture={() => {
                editFocus.current = 'library';
              }}
              onFocusCapture={() => {
                editFocus.current = 'library';
              }}
            >
              <div className="ve-panel-heading">
                <strong>素材库</strong>
                <span>{project.assets.length}</span>
                <button
                  aria-label="删除选中素材"
                  title="删除选中素材 (Delete)"
                  disabled={!currentAsset || busy}
                  onClick={deleteSelectedAsset}
                >
                  <Trash2 size={14} />
                </button>
              </div>
              {waveformBusy && (
                <small className="ve-waveform-status" role="status">
                  正在生成音频波形…
                </small>
              )}
              <div className="ve-library-actions">
                <button onClick={() => importInput.current?.click()} disabled={busy}>
                  <Plus size={15} />
                  导入素材
                </button>
                <button onClick={() => relinkInput.current?.click()} disabled={busy}>
                  重新关联
                </button>
                <button onClick={() => importDirectoryInput.current?.click()} disabled={busy}>
                  导入目录
                </button>
              </div>
              <label className="ve-relink-scope">
                重新关联范围
                <select
                  aria-label="重新关联范围"
                  value={relinkScope}
                  onChange={(e) => setRelinkScope(e.target.value)}
                >
                  <option value="all">整个工程（自动匹配）</option>
                  {project.graphics.map((g, i) => (
                    <option key={g.id} value={g.id}>
                      图文 {i + 1} · {g.name}
                    </option>
                  ))}
                  {project.assets.filter(isFileAsset).map((a, i) => (
                    <option key={a.id} value={a.id}>
                      素材 {i + 1} · {a.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="ve-library-actions">
                <button onClick={() => addAsset('text')}>
                  <Type size={14} />
                  文字
                </button>
                <button onClick={() => addAsset('color')}>色块</button>
                <button onClick={appendGraphics} title="所选图片方案每页5秒连续铺入">
                  铺入图片组
                </button>
              </div>
              <div className="ve-search">
                <Search size={14} />
                <input
                  aria-label="搜索素材"
                  placeholder="搜索素材"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <select
                aria-label="素材类型"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                <option value="all">全部素材</option>
                {Object.entries(kindName).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
                <option value="unused">尚未使用</option>
              </select>
              {!!folders.length && (
                <select
                  aria-label="素材目录"
                  value={folder}
                  onChange={(e) => setFolder(e.target.value)}
                >
                  <option value="">全部目录</option>
                  {folders.map((path) => (
                    <option value={path} key={path}>
                      {path}
                    </option>
                  ))}
                </select>
              )}
              {!!missing.length && (
                <p className="ve-warning">{missing.length} 个素材需要重新关联</p>
              )}
              <div
                className="ve-assets"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (e.dataTransfer.files.length) void importFiles([...e.dataTransfer.files]);
                }}
              >
                {visibleAssets.map((a) => (
                  <button
                    key={a.id}
                    className={`ve-asset ${assetId === a.id ? 'selected' : ''}`}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('application/x-teditor-asset', a.id);
                      e.dataTransfer.setData('text/plain', a.id);
                    }}
                    onClick={() => selectAsset(a)}
                    onDoubleClick={() => selectAsset(a)}
                    aria-label={`素材 ${a.name}`}
                  >
                    <div className="ve-asset-thumb">
                      {a.thumbnail ? (
                        <img src={a.thumbnail} alt="" />
                      ) : a.kind === 'audio' ? (
                        <Music2 size={27} />
                      ) : a.kind === 'graphic' &&
                        project.graphics.find((g) => g.id === a.graphic?.sourceId) ? (
                        <GraphicThumb
                          source={project.graphics.find((g) => g.id === a.graphic!.sourceId)!}
                          asset={a}
                          resolveImage={props.resolveImage}
                          media={media}
                          revision={mediaRevision}
                        />
                      ) : a.kind === 'text' ? (
                        <Type size={27} />
                      ) : (
                        <div
                          style={{
                            background: a.color || '#263445',
                            width: '100%',
                            height: '100%',
                          }}
                        />
                      )}
                      {isFileAsset(a) && !media.has(a.id) && <span>缺失</span>}
                    </div>
                    <b>{a.name}</b>
                    <small>
                      {kindName[a.kind]}
                      {a.duration ? ` · ${a.duration.toFixed(1)}s` : ''}
                    </small>
                  </button>
                ))}
                {!visibleAssets.length && (
                  <div className="ve-empty">
                    拖入本地视频、图片或音频
                    <br />
                    也可以直接关联图片设计
                  </div>
                )}
              </div>
              {currentAsset?.graphic && (
                <button
                  onClick={() => {
                    const g = project.graphics.find((g) => g.id === currentAsset.graphic!.sourceId);
                    if (g)
                      props.onEditGraphic(
                        g,
                        graphicFiles(g, (id) => media.getFile(id)),
                      );
                  }}
                >
                  编辑关联图片（影响{' '}
                  {
                    project.sequences
                      .flatMap((s) => s.clips)
                      .filter(
                        (c) =>
                          project.assets.find((a) => a.id === c.assetId)?.graphic?.sourceId ===
                          currentAsset.graphic?.sourceId,
                      ).length
                  }{' '}
                  个片段）
                </button>
              )}
              {currentAsset?.graphic && (
                <button
                  onClick={() => {
                    const original = project.graphics.find(
                      (g) => g.id === currentAsset.graphic!.sourceId,
                    );
                    if (!original) return;
                    const source = {
                      ...structuredClone(original),
                      id: uid('graphic'),
                      name: original.name + ' 独立副本',
                    };
                    const copies = project.assets
                      .filter((a) => a.graphic?.sourceId === original.id)
                      .map((a) => ({
                        ...structuredClone(a),
                        id: uid('asset'),
                        name: a.name + ' 副本',
                        graphic: { ...a.graphic!, sourceId: source.id },
                      }));
                    if (
                      !commit((p) => ({
                        ...p,
                        graphics: [...p.graphics, source],
                        assets: [...p.assets, ...copies],
                      }))
                    )
                      return;
                    const copy = copies.find(
                      (a) => a.graphic!.rowIds.join() === currentAsset.graphic!.rowIds.join(),
                    );
                    if (copy) selectAsset(copy);
                    props.onEditGraphic(
                      source,
                      graphicFiles(source, (id) => media.getFile(id)),
                    );
                  }}
                >
                  复制为独立方案并编辑
                </button>
              )}
              {currentAsset && (
                <button
                  onClick={() => {
                    if (!selected) {
                      setMessage('先在时间线选择要替换的片段。');
                      return;
                    }
                    edit((s) => replaceClipAsset(s, selected.id, currentAsset));
                  }}
                >
                  替换选中片段素材
                </button>
              )}
            </aside>
            <PanelDivider
              label="调整素材面板宽度"
              onDelta={(dx) =>
                setPanels((p) => ({
                  ...p,
                  left: Math.max(170, Math.min(window.innerWidth * 0.3, p.left + dx)),
                }))
              }
            />
            <div className={`ve-monitors ${singleViewer ? 've-single' : ''}`}>
              {!singleViewer && (
                <SourceMonitor
                  asset={currentAsset}
                  media={media}
                  fps={sequence.fps}
                  sourceIn={sourceIn}
                  sourceOut={sourceOut}
                  onRange={(a, b) => {
                    setSourceIn(a);
                    setSourceOut(b);
                  }}
                  onInsert={() => currentAsset && addToTimeline(currentAsset)}
                  onOverwrite={() => currentAsset && addToTimeline(currentAsset, 'overwrite')}
                  visible={props.visible && !dialog}
                  programPlaying={playing}
                  onOperationPreview={setOperation}
                  graphicPreview={
                    currentAsset?.graphic &&
                    project.graphics.find((g) => g.id === currentAsset.graphic!.sourceId) ? (
                      <GraphicThumb
                        source={project.graphics.find(
                          (g) => g.id === currentAsset.graphic!.sourceId,
                        )!}
                        asset={currentAsset}
                        resolveImage={props.resolveImage}
                        media={media}
                        revision={mediaRevision}
                        size={720}
                      />
                    ) : undefined
                  }
                  onPlaySource={() => setPlaying(false)}
                />
              )}
              {programPreview}
            </div>
            <PanelDivider
              label="调整属性面板宽度"
              onDelta={(dx) =>
                setPanels((p) => ({
                  ...p,
                  right: Math.max(220, Math.min(window.innerWidth * 0.35, p.right - dx)),
                }))
              }
            />
            {ranking ? (
              <TemplatePanel
                project={project}
                currentAsset={currentAsset}
                sourceIn={sourceIn}
                sourceOut={sourceOut}
                onChange={commit}
                onApply={(next) => {
                  commit(next);
                  setFrame(0);
                  setSelectedIds([]);
                  setRanking(false);
                }}
                onClose={() => setRanking(false)}
                onError={setMessage}
              />
            ) : (
              <Inspector
                clip={selected}
                asset={selectedAsset}
                sequence={sequence}
                onChange={modifyClip}
                onRemoveTransition={(id) => edit((s) => removeTransition(s, id))}
                onAssetChange={(patch) =>
                  commit((p) => ({
                    ...p,
                    assets: p.assets.map((a) =>
                      a.id === selectedAsset?.id ? { ...a, ...patch } : a,
                    ),
                  }))
                }
                onEditGraphic={(id) => {
                  const g = project.graphics.find((g) => g.id === id);
                  if (g)
                    props.onEditGraphic(
                      g,
                      graphicFiles(g, (id) => media.getFile(id)),
                    );
                }}
              />
            )}
          </fieldset>
          <PanelDivider
            label="调整时间线高度"
            horizontal
            onDelta={(dy) =>
              setPanels((p) => ({
                ...p,
                timeline: Math.max(24, Math.min(55, p.timeline - (dy / window.innerHeight) * 100)),
              }))
            }
          />
        </>
      )}
      <div className="ve-sequence-bar">
        <div className="ve-sequence-tabs">
          {project.sequences.map((s) => (
            <button
              key={s.id}
              disabled={!!exportProgress}
              className={sequence.id === s.id ? 'active' : ''}
              onClick={() => switchSequence(s.id)}
            >
              {s.name}
            </button>
          ))}
        </div>
        <button
          aria-label="新建序列"
          disabled={!!exportProgress}
          onClick={() => (viewMode === 'ppt' ? newSlideshow() : newSequence())}
        >
          <Plus size={14} />
        </button>
        <button disabled={!!exportProgress} onClick={() => newSequence(true)}>
          复制序列
        </button>
        <button
          disabled={!!exportProgress}
          onClick={() => {
            setSequenceForm({
              name: sequence.name,
              width: sequence.width,
              height: sequence.height,
              fps: sequence.fps,
            });
            setDialog('sequence');
          }}
        >
          序列设置
        </button>
        <button
          disabled={!!exportProgress}
          onClick={() => {
            const label = prompt('章节标记名称', '章节');
            if (label)
              edit((s) => ({ ...s, markers: [...s.markers, { id: uid('marker'), frame, label }] }));
          }}
        >
          添加标记
        </button>
      </div>
      {viewMode === 'timeline' && (
        <fieldset
          className="ve-timeline-field"
          onPointerDownCapture={() => {
            editFocus.current = 'timeline';
          }}
          onFocusCapture={() => {
            editFocus.current = 'timeline';
          }}
          disabled={!ready || !!exportProgress}
          style={{ height: `${panels.timeline}vh` }}
        >
          <Timeline
            operationPreview={
              operation && currentAsset && operationTrack
                ? {
                    trackId: operationTrack.id,
                    start: frame,
                    duration: assetRange(currentAsset.id).duration,
                    mode: operation,
                  }
                : undefined
            }
            getAssetRange={assetRange}
            sequence={sequence}
            assets={project.assets}
            selectedIds={selectedIds}
            frame={frame}
            onSelect={setSelectedIds}
            onSeek={seek}
            onMove={(ids, delta, track) => edit((s) => moveClips(s, ids, delta, track))}
            onTrim={(id, edge, delta) =>
              edit((s) => {
                const c = s.clips.find((c) => c.id === id)!;
                return trimClip(
                  s,
                  id,
                  edge,
                  (edge === 'start' ? c.start : c.start + c.duration) + delta,
                  projectRef.current.assets,
                );
              })
            }
            onDropAsset={(id, track, at) => {
              const a = project.assets.find((a) => a.id === id);
              if (a) addToTimeline(a, 'place', track, at);
            }}
            onTrackChange={trackChange}
            onTrackAdd={(kind) =>
              edit((s) => ({
                ...s,
                tracks:
                  kind === 'video'
                    ? [
                        createTrack(
                          kind,
                          `画面 ${s.tracks.filter((t) => t.kind === kind).length + 1}`,
                        ),
                        ...s.tracks,
                      ]
                    : [
                        ...s.tracks,
                        createTrack(
                          kind,
                          `声音 ${s.tracks.filter((t) => t.kind === kind).length + 1}`,
                        ),
                      ],
              }))
            }
            onTrackDelete={(id) =>
              edit((s) => {
                if (s.clips.some((c) => c.trackId === id)) throw new Error('请先移除轨道中的片段');
                return { ...s, tracks: s.tracks.filter((t) => t.id !== id) };
              })
            }
            onTrackMove={(id, direction) =>
              edit((s) => {
                const tracks = [...s.tracks],
                  i = tracks.findIndex((t) => t.id === id),
                  j = i + direction;
                if (j < 0 || j >= tracks.length) return s;
                if (tracks[i].locked || tracks[j].locked) throw new Error('请先解锁轨道');
                [tracks[i], tracks[j]] = [tracks[j], tracks[i]];
                return { ...s, tracks };
              })
            }
            onSplit={() => edit((s) => splitClips(s, selectedIds, frame))}
            onCut={(id, at) => {
              edit((s) => splitClips(s, [id], at));
              seek(at);
            }}
            onDelete={(ripple) => edit((s) => deleteClips(s, selectedIds, ripple, syncTrackIds))}
            onDuplicate={() => edit((s) => duplicateClips(s, selectedIds))}
            onGroup={group}
            onUngroup={() => edit((s) => ungroupClips(s, selectedIds))}
            onUnlink={() => edit((s) => unlinkClips(s, selectedIds))}
            onUndo={() => undo()}
            onRedo={() => undo(true)}
            canUndo={!!history.current.past.length}
            canRedo={!!history.current.future.length}
            onTransition={addTransition}
          />
        </fieldset>
      )}
      <footer className="ve-footer">
        <span>
          {sequence.clips.length} 个片段 · {sequence.tracks.length} 条轨道
        </span>
        <span className="ve-footer-end">
          <span>
            {timecode(total, sequence.fps)} · {sequence.fps} fps · 素材留在本机
          </span>
          <SiteCredits />
        </span>
      </footer>
      {message && (
        <div className="ve-toast" role="status">
          <span>{message}</span>
          <button aria-label="关闭提示" onClick={() => setMessage('')}>
            <X size={14} />
          </button>
        </div>
      )}
      {dialog && (
        <div className="ve-modal-backdrop">
          <section
            className={`ve-modal ${dialog === 'graphics' ? 've-graphic-modal' : ''}`}
            role="dialog"
            aria-label={
              dialog === 'graphics'
                ? '关联图片到视频'
                : dialog === 'sequence'
                  ? '序列设置'
                  : '视频导出'
            }
          >
            <div className="ve-panel-heading">
              <strong>
                {dialog === 'graphics'
                  ? '关联图片到视频'
                  : dialog === 'sequence'
                    ? '序列设置'
                    : '本地视频导出'}
              </strong>
              <button
                disabled={!!exportProgress}
                aria-label="关闭视频对话框"
                onClick={() => {
                  if (
                    dialog === 'export' &&
                    exportStart >= 0 &&
                    exportEnd > exportStart &&
                    exportEnd * sequence.fps <= total
                  )
                    persistExportSettings();
                  setDialog(null);
                }}
              >
                <X size={18} />
              </button>
            </div>
            {dialog === 'graphics' && (
              <>
                <p>
                  {viewMode === 'ppt'
                    ? '将副榜分页直接加入PPT。无需下载图片；复杂时间线会保留，并为这些图片新建PPT序列。'
                    : '将当前设计关联到视频素材库。无需下载图片，之后可返回图片设计继续修改。'}
                </p>
                <label>
                  生成方式
                  <select
                    aria-label="图片生成方式"
                    value={graphicMode}
                    onChange={(e) => {
                      setGraphicMode(e.target.value as typeof graphicMode);
                      setGraphicSelected([]);
                    }}
                  >
                    <option value="current">当前一张</option>
                    <option value="rows">每行一张（主榜）</option>
                    <option value="pages">重复排版分页（副榜）</option>
                  </select>
                </label>
                <div className="ve-form-row">
                  {(['start', 'end', 'repeats', 'deltaX', 'deltaY'] as const).map((k) => (
                    <label key={k}>
                      {
                        {
                          start: '起始行',
                          end: '结束行',
                          repeats: '额外副本数',
                          deltaX: 'X 偏移',
                          deltaY: 'Y 偏移',
                        }[k]
                      }
                      <input
                        aria-label={`视频图片${k}`}
                        type="number"
                        value={graphicLayout[k]}
                        disabled={
                          graphicMode === 'current' || (graphicMode === 'rows' && k === 'repeats')
                        }
                        onChange={(e) => {
                          setGraphicLayout((v) => ({ ...v, [k]: Number(e.target.value) }));
                          setGraphicSelected([]);
                        }}
                      />
                    </label>
                  ))}
                </div>
                {graphicCandidate.error && <p role="alert">{graphicCandidate.error}</p>}
                <p>
                  {graphicCandidate.assets.length} 张图片 · 未勾选时使用全部，勾选后仅添加指定图片
                </p>
                <div className="ve-graphic-grid">
                  {graphicCandidate.source &&
                    graphicCandidate.assets.map((asset, i) => (
                      <label className="ve-graphic-choice" key={i}>
                        <input
                          type="checkbox"
                          aria-label={`选择图片${i + 1}`}
                          checked={graphicSelected.includes(String(i))}
                          onChange={(e) =>
                            setGraphicSelected((v) =>
                              e.target.checked
                                ? [...v, String(i)]
                                : v.filter((x) => x !== String(i)),
                            )
                          }
                        />
                        <GraphicThumb
                          source={graphicCandidate.source!}
                          asset={asset}
                          resolveImage={props.resolveImage}
                        />
                        <span>{asset.name}</span>
                      </label>
                    ))}
                </div>
                <button
                  className="ve-primary"
                  disabled={busy || !!graphicCandidate.error || !graphicCandidate.assets.length}
                  onClick={importGraphics}
                >
                  添加关联图片
                </button>
              </>
            )}
            {dialog === 'sequence' && (
              <>
                <p>只修改当前序列。更改帧率会按原时间长度重算剪辑位置。</p>
                <label>
                  名称
                  <input
                    aria-label="序列名称"
                    value={sequenceForm.name}
                    onChange={(e) => setSequenceForm((v) => ({ ...v, name: e.target.value }))}
                  />
                </label>
                <div className="ve-form-row">
                  {(['width', 'height'] as const).map((k) => (
                    <label key={k}>
                      {{ width: '宽度', height: '高度' }[k]}
                      <input
                        type="number"
                        aria-label={`序列${k}`}
                        value={sequenceForm[k]}
                        onChange={(e) =>
                          setSequenceForm((v) => ({ ...v, [k]: Number(e.target.value) }))
                        }
                      />
                    </label>
                  ))}
                  <label>
                    帧率
                    <FrameRateInput
                      label="序列fps"
                      value={sequenceForm.fps}
                      onChange={(fps) => setSequenceForm((value) => ({ ...value, fps }))}
                    />
                  </label>
                </div>
                <p className="ve-muted">{FRAME_RATE_HINT}</p>
                <button className="ve-primary" onClick={applySequenceSettings}>
                  应用序列设置
                </button>
              </>
            )}
            {dialog === 'export' && (
              <>
                <p>
                  MP4 · H.264 + AAC · {sequence.width} × {sequence.height} · {sequence.fps} fps
                </p>
                <fieldset disabled={!!exportProgress}>
                  <div className="ve-form-row">
                    <label>
                      开始 / 秒
                      <input
                        aria-label="视频导出开始"
                        type="number"
                        step={1 / sequence.fps}
                        min={0}
                        value={exportStart}
                        onChange={(e) => setExportStart(Number(e.target.value))}
                      />
                    </label>
                    <label>
                      结束 / 秒
                      <input
                        aria-label="视频导出结束"
                        type="number"
                        step={1 / sequence.fps}
                        value={exportEnd}
                        onChange={(e) => setExportEnd(Number(e.target.value))}
                      />
                    </label>
                    <label>
                      视频码率
                      <select
                        aria-label="视频码率"
                        value={quality}
                        onChange={(e) => setQuality(Number(e.target.value))}
                      >
                        {[...new Set([3, 4, 6, 8, 12, 16, 20, 24, 40, quality])]
                          .sort((a, b) => a - b)
                          .map((n) => (
                            <option key={n} value={n}>
                              {n} Mbps
                            </option>
                          ))}
                      </select>
                    </label>
                  </div>
                  <label>
                    码率模式
                    <select
                      aria-label="码率模式"
                      value={bitrateMode}
                      onChange={(e) => setBitrateMode(e.target.value as VideoBitrateMode)}
                    >
                      <option value="variable">VBR 可变码率（推荐）</option>
                      <option value="constant">CBR 恒定码率（受设备支持限制）</option>
                    </select>
                  </label>
                  <p>
                    {bitrateMode === 'variable'
                      ? 'VBR 按画面复杂度分配码率，目标并非上限；静态图片通常较低，复杂画面可能超出目标。'
                      : 'CBR 向编码器请求恒定码率，部分设备可能忽略此请求，请在完成后核对实际码率。'}
                  </p>
                  <p>
                    1080p 默认 6
                    Mbps；平台处理规则可能变化，不承诺免二压。先导出短选区检查效果，长片导出时保持页面打开。
                  </p>
                  <div className="ve-modal-actions">
                    <button onClick={() => void checkExport()}>导出前检查</button>
                    <button onClick={() => void runExport(true)}>选择文件并导出</button>
                    <button className="ve-primary" onClick={() => void runExport(false)}>
                      生成后下载
                    </button>
                  </div>
                </fieldset>
                {exportProgress && (
                  <>
                    <progress max={1} value={exportProgress.ratio} />
                    <p>
                      {exportProgress.completed} / {exportProgress.total} 帧 ·{' '}
                      {(exportProgress.ratio * 100).toFixed(1)}% ·{' '}
                      {(exportProgress.bytes / 1024 / 1024).toFixed(1)} MB
                    </p>
                    <button onClick={() => exportAbort.current?.abort()}>取消视频导出</button>
                  </>
                )}
                <p className="ve-export-status" role="status">
                  {exportCheck}
                </p>
                {downloadUrl && (
                  <a
                    className="ve-download"
                    href={downloadUrl}
                    download={`${project.name}-${sequence.name}.mp4`}
                  >
                    下载 MP4 视频
                  </a>
                )}
              </>
            )}
          </section>
        </div>
      )}
      <input
        type="file"
        ref={importInput}
        hidden
        multiple
        accept="video/*,audio/*,image/*,.mkv,.mov,.webm,.mp4,.wav,.mp3,.flac"
        aria-label="导入视频素材文件"
        onChange={(e) => {
          if (e.target.files) void importFiles([...e.target.files]);
          e.target.value = '';
        }}
      />
      <input
        type="file"
        ref={importDirectoryInput}
        hidden
        multiple
        {...({ webkitdirectory: '' } as Record<string, string>)}
        aria-label="导入视频素材目录"
        onChange={(e) => {
          if (e.target.files) void importFiles([...e.target.files]);
          e.target.value = '';
        }}
      />
      <input
        type="file"
        ref={relinkInput}
        hidden
        multiple
        {...({ webkitdirectory: '' } as Record<string, string>)}
        aria-label="关联视频素材目录"
        onChange={(e) => {
          if (e.target.files) void importFiles([...e.target.files], true);
          e.target.value = '';
        }}
      />
      <input
        type="file"
        ref={openInput}
        hidden
        accept=".tevideo,.json"
        aria-label="打开视频工程文件"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void openProject(f);
          e.target.value = '';
        }}
      />
    </div>
  );
}

let thumbnailQueue: Promise<unknown> = Promise.resolve();
function GraphicThumb({
  source,
  asset,
  resolveImage,
  media,
  revision,
  size = 240,
}: {
  source: GraphicSource;
  asset: MediaAsset;
  resolveImage: ImageResolver;
  media?: MediaLibrary;
  revision?: number;
  size?: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => setInView(entries.some((e) => e.isIntersecting)),
      { rootMargin: '80px' },
    );
    if (canvas.current) observer.observe(canvas.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!inView) return;
    let active = true;
    thumbnailQueue = thumbnailQueue
      .catch(() => {})
      .then(async () => {
        if (!active) return;
        const scratch = document.createElement('canvas');
        const rows = asset.graphic!.rowIds.map((id) => source.rowIds.indexOf(id));
        const localRenderer = media ? new SequenceRenderer(media.fork(), resolveImage) : undefined;
        try {
          if (rows.some((i) => i < 0)) return;
          if (localRenderer) {
            const p = createProject();
            const sequence = createSequence(
              '缩略图',
              source.document.DocModel.Width,
              source.document.DocModel.Height,
              30,
            );
            sequence.background = 'transparent';
            sequence.clips = [createClip(asset, sequence.tracks[0].id, 0, 30, sequence)];
            p.graphics = [source];
            p.assets = [asset];
            p.sequences = [sequence];
            p.activeSequenceId = sequence.id;
            await localRenderer.render(scratch, p, sequence, 0);
          } else
            await renderBatchPage(
              scratch,
              source.document,
              source.table,
              rows.length ? rows : [0],
              source.layout.deltaX,
              source.layout.deltaY,
              resolveImage,
            );
          if (!active || !canvas.current) return;
          canvas.current.width = size;
          canvas.current.height = Math.max(1, Math.round((size * scratch.height) / scratch.width));
          canvas.current
            .getContext('2d')!
            .drawImage(scratch, 0, 0, canvas.current.width, canvas.current.height);
        } finally {
          localRenderer?.dispose();
          scratch.width = scratch.height = 1;
        }
      });
    void thumbnailQueue.catch(() => {});
    return () => {
      active = false;
    };
  }, [source, asset, resolveImage, inView, media, revision, size]);
  return <canvas ref={canvas} aria-label={asset.name} />;
}

function PanelDivider({
  label,
  horizontal = false,
  onDelta,
}: {
  label: string;
  horizontal?: boolean;
  onDelta: (delta: number) => void;
}) {
  const last = useRef<number | null>(null);
  return (
    <div
      className={`ve-divider ${horizontal ? 'horizontal' : ''}`}
      role="separator"
      aria-label={label}
      aria-orientation={horizontal ? 'horizontal' : 'vertical'}
      tabIndex={0}
      onPointerDown={(e) => {
        e.preventDefault();
        last.current = horizontal ? e.clientY : e.clientX;
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (last.current === null) return;
        const value = horizontal ? e.clientY : e.clientX;
        onDelta(value - last.current);
        last.current = value;
      }}
      onPointerUp={(e) => {
        last.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => {
        last.current = null;
      }}
      onKeyDown={(e) => {
        if (['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].includes(e.key)) {
          e.preventDefault();
          onDelta(e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -10 : 10);
        }
      }}
    />
  );
}
