import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import {
  MousePointer2,
  Type,
  Image as ImageIcon,
  Square,
  Circle,
  Layers,
  Eye,
  EyeOff,
  Copy,
  Trash2,
  Plus,
  FolderOpen,
  Save,
  Undo2,
  Redo2,
  Download,
  ChevronDown,
  ChevronUp,
  Minus,
  Maximize,
  Table2,
  FolderInput,
  Check,
  AlertCircle,
  X,
  FilePlus2,
  ArrowDownToLine,
  Settings2,
  SlidersHorizontal,
  GripVertical,
  ArrowUp,
  ArrowDown,
  HelpCircle,
  FileSpreadsheet,
} from 'lucide-react';
import type {
  Bounds,
  DataRow,
  ImageData,
  LayerKey,
  LayerModel,
  TableData,
  TedDocument,
  TextData,
} from './core/types';
import {
  createDocument,
  createLayer,
  cloneDocument,
  normalizeDocument,
  normalizeLayerOrder,
  parseDocument,
  serializeDocument,
  duplicateLayer,
} from './core/document';
import { parseTable, planBatch, resolveDocument } from './core/data';
import { renderDocument } from './core/render';
import { AssetStore, decodeTextFile, downloadBlob, fileDataUrl } from './core/assets';
import { readDraft, readAssets, saveDraft, saveAssets } from './core/storage';
import { History } from './core/history';
import { ArchiveStorage } from './core/archive';
import { createDemo } from './core/demo';
import { canvasBlob, runExport } from './core/export';
import { NumberField, Properties } from './components/Properties';
import { Conditions } from './components/Conditions';
import { BatchPreview } from './components/BatchPreview';

const typeNames: Record<LayerKey, string> = {
  Text: '文字',
  Image: '图片',
  Rectangle: '矩形',
  Ellipse: '椭圆',
};
const layerIcon = (key: LayerKey) =>
  key === 'Text' ? (
    <Type size={15} />
  ) : key === 'Image' ? (
    <ImageIcon size={15} />
  ) : key === 'Ellipse' ? (
    <Circle size={15} />
  ) : (
    <Square size={15} />
  );
const emptyTable: TableData = { headers: [], rows: [] };
type Modal = 'data' | 'export' | 'help' | null;
type Archive = { name: string; url: string; size: number };
function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

export default function App() {
  const initial = useMemo(() => createDemo(), []);
  const [doc, setDoc] = useState(initial.document),
    [table, setTable] = useState<TableData>(initial.table),
    [filename, setFilename] = useState('创作者周刊.ted');
  const [selected, setSelected] = useState<string | null>(null),
    [row, setRow] = useState(0),
    [dirty, setDirty] = useState(false),
    [ready, setReady] = useState(false);
  const [zoom, setZoom] = useState(0.45),
    [pan, setPan] = useState({ x: 0, y: 0 }),
    [bounds, setBounds] = useState<Record<string, Bounds>>({}),
    [renderWarnings, setRenderWarnings] = useState<string[]>([]);
  const [manual, setManual] = useState<Record<number, number>>({}),
    [tab, setTab] = useState<'properties' | 'conditions'>('properties'),
    [modal, setModal] = useState<Modal>(null),
    [toast, setToast] = useState('');
  const [dataText, setDataText] = useState(''),
    [dataError, setDataError] = useState(''),
    [dataVisible, setDataVisible] = useState(true),
    [page, setPage] = useState(0),
    [sort, setSort] = useState<{ column: string; direction: number } | null>(null),
    [assetRevision, setAssetRevision] = useState(0),
    [fonts, setFonts] = useState([
      'sans-serif',
      'Arial',
      'Microsoft YaHei',
      'PingFang SC',
      'SimSun',
      'Georgia',
      'monospace',
    ]);
  const [historyRevision, setHistoryRevision] = useState(0),
    [showHistory, setShowHistory] = useState(false),
    [saving, setSaving] = useState('已在本地恢复'),
    [warningsOpen, setWarningsOpen] = useState(false);
  const [exportOptions, setExportOptions] = useState({
    start: 1,
    end: 12,
    repeats: 0,
    deltaX: 0,
    deltaY: 0,
    filename: 'Rank_{index}_{名称}',
    mode: 'directory',
  });
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null),
    [exportMessage, setExportMessage] = useState(''),
    [archives, setArchives] = useState<Archive[]>([]);
  const docRef = useRef(doc);
  docRef.current = doc;
  const assets = useRef(new AssetStore()),
    history = useRef(new History()),
    lastEdit = useRef({ label: '', time: 0 });
  const canvasRef = useRef<HTMLCanvasElement>(null),
    workspaceRef = useRef<HTMLDivElement>(null),
    openInput = useRef<HTMLInputElement>(null),
    imageInput = useRef<HTMLInputElement>(null),
    assetInput = useRef<HTMLInputElement>(null),
    csvInput = useRef<HTMLInputElement>(null),
    fontInput = useRef<HTMLInputElement>(null),
    exportAbort = useRef<AbortController | null>(null),
    exportRunning = useRef(false),
    archiveStorage = useRef(new ArchiveStorage());
  const drag = useRef<
    | {
        mode: string;
        clientX: number;
        clientY: number;
        document: TedDocument;
        id: string | null;
        pan: { x: number; y: number };
        bounds?: Bounds;
      }
    | undefined
  >(undefined);
  const space = useRef(false),
    [hand, setHand] = useState(false),
    draggedLayer = useRef<string | null>(null);
  const currentRow = table.rows[row];
  const resolved = useMemo(
    () => resolveDocument(doc, currentRow, manual),
    [doc, currentRow, manual],
  );
  const exportPlan = useMemo(() => {
    try {
      return {
        plans: planBatch(
          Math.max(1, table.rows.length),
          exportOptions.start,
          exportOptions.end,
          exportOptions.repeats,
        ),
        error: '',
      };
    } catch (cause) {
      return { plans: [], error: errorText(cause) };
    }
  }, [table.rows.length, exportOptions.start, exportOptions.end, exportOptions.repeats]);
  const warnings = useMemo(
    () => [...new Set([...resolved.warnings, ...renderWarnings])],
    [resolved.warnings, renderWarnings],
  );
  const selectedLayer = doc.Layers.find((l) => l.Id === selected),
    selectedBounds = selected ? bounds[selected] : undefined;
  const notice = (message: string) => setToast(message);
  useEffect(() => {
    if (selected && !doc.Layers.some((l) => l.Id === selected)) setSelected(null);
  }, [doc, selected]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 6500);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [draft, savedAssets] = await Promise.all([readDraft(), readAssets()]);
        if (!active) return;
        if (draft) {
          const normalized = normalizeDocument(draft.document);
          setDoc(normalized.document);
          setTable(draft.table || emptyTable);
          setFilename(draft.name);
          setRow(Math.max(0, Math.min(draft.row, draft.table.rows.length - 1)));
          assets.current.files = savedAssets;
          for (const [path, file] of savedAssets)
            if (/\.(ttf|otf|woff2?)$/i.test(path)) {
              try {
                await loadFont(file, false);
              } catch {
                notice('无法恢复字体：' + file.name);
              }
            }
        } else {
          assets.current.add(initial.files);
          await saveAssets(assets.current.files);
        }
        setAssetRevision((v) => v + 1);
      } catch (e) {
        if (active) {
          assets.current.add(initial.files);
          notice('本地恢复不可用：' + errorText(e));
        }
      } finally {
        if (active) setReady(true);
      }
    })();
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!ready) return;
    setSaving('正在保存草稿…');
    const timer = setTimeout(() => {
      saveDraft({ document: doc, table, name: filename, row })
        .then(() => setSaving('草稿已保存在本机'))
        .catch((e) => setSaving('草稿保存失败：' + errorText(e)));
    }, 650);
    return () => clearTimeout(timer);
  }, [doc, table, filename, row, ready]);
  useEffect(() => {
    const listener = (e: BeforeUnloadEvent) => {
      if (dirty || progress) {
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', listener);
    return () => window.removeEventListener('beforeunload', listener);
  }, [dirty, progress]);
  useEffect(() => {
    let active = true;
    if (!canvasRef.current) return;
    renderDocument(canvasRef.current, resolved.document, assets.current.resolve)
      .then((result) => {
        if (active) {
          setBounds(result.bounds);
          setRenderWarnings(result.warnings);
        }
      })
      .catch((e) => {
        if (active) setRenderWarnings([errorText(e)]);
      });
    return () => {
      active = false;
    };
  }, [resolved, assetRevision, fonts]);
  function fit() {
    const area = workspaceRef.current;
    if (!area) return;
    setZoom(
      Math.max(
        0.05,
        Math.min(
          2,
          (area.clientWidth - 100) / docRef.current.DocModel.Width,
          (area.clientHeight - 100) / docRef.current.DocModel.Height,
        ),
      ),
    );
    setPan({ x: 0, y: 0 });
  }
  useEffect(() => {
    fit();
  }, [doc.DocModel.Width, doc.DocModel.Height, dataVisible, ready]);
  useEffect(() => {
    const area = workspaceRef.current;
    if (!area) return;
    const observer = new ResizeObserver(() => fit());
    observer.observe(area);
    return () => observer.disconnect();
  }, []);
  function replaceDocument(next: TedDocument, label: string, coalesce = false) {
    const now = Date.now(),
      key = label + '|' + (selected || '');
    if (!coalesce || lastEdit.current.label !== key || now - lastEdit.current.time > 650)
      history.current.push(docRef.current, label);
    lastEdit.current = { label: key, time: now };
    normalizeLayerOrder(next);
    docRef.current = next;
    setDoc(next);
    setDirty(true);
    setHistoryRevision((v) => v + 1);
  }
  function mutate(fn: (d: TedDocument) => void, label: string, coalesce = false) {
    const next = cloneDocument(docRef.current);
    fn(next);
    replaceDocument(next, label, coalesce);
  }
  function patchLayer(patch: Partial<LayerModel>) {
    if (!selected) return;
    if (Object.keys(patch).length === 1 && 'Visible' in patch) {
      visibility(selected);
      return;
    }
    mutate(
      (d) =>
        Object.assign(
          d.Layers.find((l) => l.Id === selected)!,
          patch,
        ),
      '修改图层 ' + Object.keys(patch).join(),
      true,
    );
  }
  function patchData(patch: Record<string, unknown>) {
    if (!selected) return;
    mutate(
      (d) => Object.assign(d.Layers.find((l) => l.Id === selected)!.Data, patch),
      '修改属性 ' + Object.keys(patch).join(),
      true,
    );
  }
  function undo() {
    setManual({});
    const d = history.current.undo(docRef.current);
    if (d) {
      docRef.current = d;
      setDoc(d);
      setDirty(true);
      setHistoryRevision((v) => v + 1);
      lastEdit.current = { label: '', time: 0 };
    }
  }
  function redo() {
    setManual({});
    const d = history.current.redo(docRef.current);
    if (d) {
      docRef.current = d;
      setDoc(d);
      setDirty(true);
      setHistoryRevision((v) => v + 1);
      lastEdit.current = { label: '', time: 0 };
    }
  }
  function reset(next: TedDocument, name: string, newTable = emptyTable) {
    lastEdit.current = { label: '', time: 0 };
    setDoc(next);
    docRef.current = next;
    setFilename(name);
    setTable(newTable);
    setSort(null);
    setRow(0);
    setPage(0);
    setSelected(null);
    setManual({});
    history.current.clear();
    setHistoryRevision((v) => v + 1);
    setDirty(false);
  }
  function newDocument() {
    if (dirty && !confirm('当前更改尚未保存为模板文件，确认新建？本机草稿将被替换。')) return;
    reset(createDocument(), '未命名.ted');
  }
  async function loadTemplate(file: File) {
    try {
      if (dirty && !confirm('打开模板将替换当前文档，是否继续？')) return;
      const result = parseDocument(await decodeTextFile(file));
      reset(result.document, file.name);
      if (result.warnings.length) notice(result.warnings.join('；'));
      else notice('模板已打开');
    } catch (e) {
      notice('打开失败：' + errorText(e));
    }
  }
  async function saveTemplate() {
    try {
      const source = docRef.current;
      const next = cloneDocument(source);
      next.DocModel.UpdatedAt = new Date().toISOString();
      for (const l of next.Layers)
        if (l.Key === 'Image') {
          const i = l.Data as ImageData;
          if (i.EmbedImage && !i.Image) {
            const f = assets.current.find(i.ImageUrl);
            if (f) i.Image = await fileDataUrl(f);
            else throw new Error('无法内嵌缺失素材：' + i.ImageUrl);
          }
        }
      downloadBlob(
        new Blob([serializeDocument(next)], { type: 'application/json' }),
        filename.endsWith('.ted') ? filename : filename + '.ted',
      );
      if (docRef.current === source) setDirty(false);
      notice('模板已保存');
    } catch (e) {
      notice(errorText(e));
    }
  }
  function addLayer(key: LayerKey) {
    const layer = createLayer(key);
    layer.Left = 100;
    layer.Top = 100;
    layer.LayerNameCustom =
      typeNames[key] + ' ' + (doc.Layers.filter((l) => l.Key === key).length + 1);
    mutate((d) => d.Layers.unshift(layer), '添加' + typeNames[key]);
    setSelected(layer.Id);
    setTab('properties');
  }
  function deleteLayer(id = selected) {
    if (!id) return;
    mutate((d) => {
      d.Layers = d.Layers.filter((l) => l.Id !== id);
      for (const g of d.DocModel.FormatConditionGroups) {
        g.EffctiveLayers = g.EffctiveLayers.filter((x) => x !== id);
        for (const c of g.FormatConditionModels) delete c.LayersVisable[id];
      }
    }, '删除图层');
    setSelected(null);
  }
  function duplicate() {
    if (!selectedLayer) return;
    const d = duplicateLayer(doc, selectedLayer.Id);
    const created = d.Layers.find((l) => !doc.Layers.some((old) => old.Id === l.Id));
    replaceDocument(d, '复制图层');
    if (created) setSelected(created.Id);
  }
  function reorder(id: string, target: number) {
    mutate((d) => {
      const index = d.Layers.findIndex((l) => l.Id === id);
      if (index < 0) return;
      const [l] = d.Layers.splice(index, 1);
      d.Layers.splice(Math.max(0, Math.min(target, d.Layers.length)), 0, l);
    }, '调整图层顺序');
  }
  function visibility(id: string) {
    const layer = resolved.document.Layers.find((l) => l.Id === id);
    if (!layer) return;
    mutate((d) => {
      let gi = -1;
      d.DocModel.FormatConditionGroups.forEach((g, index) => {
        if (g.EffctiveLayers.includes(id)) gi = index;
      });
      const ci = manual[gi] ?? resolved.matchedConditions[gi];
      if (
        gi >= 0 &&
        ci !== undefined &&
        ci >= 0 &&
        d.DocModel.FormatConditionGroups[gi].FormatConditionModels[ci]
      )
        d.DocModel.FormatConditionGroups[gi].FormatConditionModels[ci].LayersVisable[id] =
          !layer.Visible;
      else {
        const target = d.Layers.find((l) => l.Id === id);
        if (target) target.Visible = !layer.Visible;
      }
    }, '切换图层显示');
  }
  async function importAssets(files: File[]) {
    assets.current.add(files);
    setAssetRevision((v) => v + 1);
    try {
      await saveAssets(assets.current.files);
      notice(`已关联 ${files.length} 个素材文件`);
    } catch (e) {
      notice('素材可用，但本地缓存失败：' + errorText(e));
    }
  }
  async function chooseImage(file: File) {
    try {
      let id = selected;
      if (!selectedLayer || selectedLayer.Key !== 'Image') {
        const l = createLayer('Image');
        l.LayerNameCustom = file.name;
        id = l.Id;
        mutate((d) => d.Layers.unshift(l), '添加图片');
        setSelected(id);
      }
      const data = await fileDataUrl(file);
      assets.current.add([file]);
      const image = (await assets.current.resolve(file.name, data)) as HTMLImageElement | null;
      if (!docRef.current.Layers.some((l) => l.Id === id)) {
        notice('目标图层已删除，图片导入已取消');
        return;
      }
      mutate((d) => {
        const l = d.Layers.find((l) => l.Id === id)!;
        Object.assign(l.Data, {
          ImageUrl: file.name,
          Image: data,
          EmbedImage: true,
          VariableEnable: false,
          Width: image?.naturalWidth || 300,
          Height: image?.naturalHeight || 300,
        });
      }, '设置图片');
      setAssetRevision((v) => v + 1);
      await saveAssets(assets.current.files);
    } catch (e) {
      notice(errorText(e));
    }
  }
  async function loadFont(file: File, persist = true) {
    const name = file.name.replace(/\.(ttf|otf|woff2?)$/i, '');
    const font = new FontFace(name, await file.arrayBuffer());
    await font.load();
    document.fonts.add(font);
    setFonts((f) => [...new Set([...f, name])]);
    if (persist) {
      assets.current.add([file]);
      await saveAssets(assets.current.files);
      notice('字体已导入：' + name);
    }
  }
  async function localFonts() {
    try {
      const query = (window as unknown as { queryLocalFonts?: () => Promise<{ family: string }[]> })
        .queryLocalFonts;
      if (!query) {
        notice('当前浏览器不支持读取本机字体，请导入字体文件');
        fontInput.current?.click();
        return;
      }
      const list = await query.call(window);
      setFonts((f) => [...new Set([...f, ...list.map((x) => x.family)])].sort());
      notice(`已读取 ${list.length} 种本机字体`);
    } catch (e) {
      notice('字体访问：' + errorText(e));
    }
  }
  async function loadData(file: File) {
    try {
      const parsed = parseTable(await decodeTextFile(file));
      setTable(parsed);
      setSort(null);
      setRow(0);
      setPage(0);
      setManual({});
      setModal(null);
      notice(`已导入 ${parsed.rows.length} 行数据`);
    } catch (e) {
      setDataError(errorText(e));
      notice(errorText(e));
    }
  }
  function pasteData() {
    try {
      const parsed = parseTable(dataText);
      setTable(parsed);
      setSort(null);
      setRow(0);
      setPage(0);
      setManual({});
      setModal(null);
      setDataError('');
      notice(`已导入 ${parsed.rows.length} 行数据`);
    } catch (e) {
      setDataError(errorText(e));
    }
  }
  async function loadDemo() {
    if (dirty && !confirm('载入示例将替换当前模板，是否继续？')) return;
    const sample = createDemo();
    reset(sample.document, '创作者周刊.ted', sample.table);
    await importAssets(sample.files);
  }
  function sortData(column: string) {
    const direction = sort?.column === column ? -sort.direction : 1;
    const collator = new Intl.Collator('zh-CN', { numeric: true });
    setTable((t) => ({
      ...t,
      rows: [...t.rows].sort(
        (a, b) => direction * collator.compare(a[column] || '', b[column] || ''),
      ),
    }));
    setSort({ column, direction });
    setRow(0);
    setPage(0);
    setManual({});
  }
  function selectRow(i: number) {
    setRow(i);
    setManual({});
    setPage(Math.floor(i / 50));
  }
  async function exportCurrent() {
    try {
      const canvas = document.createElement('canvas');
      await renderDocument(canvas, resolved.document, assets.current.resolve);
      downloadBlob(await canvasBlob(canvas), filename.replace(/\.ted$/i, '') + `_${row + 1}.png`);
      canvas.width = 1;
      notice('当前图片已导出');
    } catch (e) {
      notice(errorText(e));
    }
  }
  function openExport() {
    setExportOptions((o) => ({ ...o, start: 1, end: Math.max(1, table.rows.length) }));
    setExportMessage('');
    setModal('export');
  }
  async function batchExport() {
    if (exportRunning.current) return;
    exportRunning.current = true;
    try {
      if (exportPlan.error) throw new Error(exportPlan.error);
      let directory: FileSystemDirectoryHandle | undefined;
      if (exportOptions.mode === 'directory') {
        const picker = (
          window as unknown as {
            showDirectoryPicker?: (options: { mode: string }) => Promise<FileSystemDirectoryHandle>;
          }
        ).showDirectoryPicker;
        if (!picker) throw new Error('此浏览器不支持目录写入，请选择 ZIP 下载');
        directory = await picker.call(window, { mode: 'readwrite' });
      }
      await archiveStorage.current.clear();
      setArchives([]);
      setExportMessage('');
      exportAbort.current = new AbortController();
      setProgress({ done: 0, total: 0 });
      const snapshot = cloneDocument(doc);
      const report = await runExport(snapshot, structuredClone(table), assets.current.resolve, {
        ...exportOptions,
        directory,
        signal: exportAbort.current.signal,
        onProgress: (done, total) => setProgress({ done, total }),
        onArchive: async (blob, name) => {
          const url = await archiveStorage.current.add(blob, name);
          setArchives((a) => [...a, { name, url, size: blob.size }]);
        },
      });
      setExportMessage(
        `${report.cancelled ? '已取消' : '已完成'}：${report.completed} / ${report.total} 张${report.warnings.length ? '。注意：' + report.warnings.slice(0, 5).join('；') : ''}`,
      );
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError'))
        setExportMessage('导出失败：' + errorText(e));
    } finally {
      exportRunning.current = false;
      setProgress(null);
      exportAbort.current = null;
    }
  }
  function startPointer(e: ReactPointerEvent, mode?: string) {
    if (e.button !== 0 && e.button !== 1) return;
    if ((e.target as HTMLElement).closest('button')) return;
    const isPan = space.current || hand || e.button === 1;
    let id = selected;
    if (!mode && !isPan) {
      const rect = canvasRef.current!.getBoundingClientRect();
      const x = (e.clientX - rect.left) / zoom,
        y = (e.clientY - rect.top) / zoom;
      id =
        resolved.document.Layers.find((l) => {
          const b = bounds[l.Id];
          return (
            l.Visible && b && x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height
          );
        })?.Id || null;
      setSelected(id);
      if (id) setTab('properties');
    }
    if (!id && !isPan) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = {
      mode: isPan ? 'pan' : mode || 'move',
      clientX: e.clientX,
      clientY: e.clientY,
      document: cloneDocument(docRef.current),
      id,
      pan: { ...pan },
      bounds: id ? bounds[id] : undefined,
    };
  }
  function movePointer(e: ReactPointerEvent) {
    const a = drag.current;
    if (!a) return;
    const dx = (e.clientX - a.clientX) / zoom,
      dy = (e.clientY - a.clientY) / zoom;
    if (a.mode === 'pan') {
      setPan({ x: a.pan.x + e.clientX - a.clientX, y: a.pan.y + e.clientY - a.clientY });
      return;
    }
    const next = cloneDocument(a.document);
    const l = next.Layers.find((x) => x.Id === a.id);
    if (!l) return;
    if (a.mode === 'move') {
      l.Left = Math.round((l.Left + dx) * 2) / 2;
      l.Top = Math.round((l.Top + dy) * 2) / 2;
    } else {
      const b = a.bounds!;
      const horizontal = a.mode.includes('w') ? -dx : a.mode.includes('e') ? dx : 0,
        vertical = a.mode.includes('n') ? -dy : a.mode.includes('s') ? dy : 0;
      const width = Math.max(1, b.width + horizontal),
        height = Math.max(1, b.height + vertical);
      let x = b.x,
        y = b.y;
      if (a.mode.includes('w')) x = b.x + b.width - width;
      if (a.mode.includes('n')) y = b.y + b.height - height;
      l.Data.Width = width;
      l.Data.Height = height;
      l.Top = y;
      l.Left = x;
      if (l.Key === 'Text') {
        const t = l.Data as TextData;
        t.TextBoxMode = true;
        if (t.TextAlignment === 2) l.Left = x + width / 2;
        if (t.TextAlignment === 1) l.Left = x + width;
      }
    }
    docRef.current = next;
    setDoc(next);
  }
  function endPointer() {
    const a = drag.current;
    if (!a) return;
    drag.current = undefined;
    if (a.mode !== 'pan' && JSON.stringify(a.document) !== JSON.stringify(docRef.current)) {
      history.current.push(a.document, a.mode === 'move' ? '移动图层' : '调整图层尺寸');
      setDirty(true);
      setHistoryRevision((v) => v + 1);
      lastEdit.current = { label: '', time: 0 };
    }
  }
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = target.matches('input,textarea,select') || target.isContentEditable;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveTemplate();
        return;
      }
      if (typing || modal) return;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        openInput.current?.click();
      } else if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        duplicate();
      } else if (e.code === 'Space') {
        e.preventDefault();
        space.current = true;
        setHand(true);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteLayer();
      } else if (e.key === 'Escape') {
        setSelected(null);
      } else if (selected && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        mutate(
          (d) => {
            const l = d.Layers.find((x) => x.Id === selected);
            if (!l) return;
            l.Left += e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
            l.Top += e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
          },
          '方向键移动',
          true,
        );
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        space.current = false;
        setHand(false);
      }
    };
    const blur = () => {
      space.current = false;
      setHand(false);
      endPointer();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  });
  useEffect(() => {
    const area = workspaceRef.current;
    if (!area) return;
    const wheel = (e: WheelEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) {
        e.preventDefault();
        setZoom((z) => Math.max(0.05, Math.min(4, z * (e.deltaY < 0 ? 1.1 : 1 / 1.1))));
      } else setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
    };
    area.addEventListener('wheel', wheel, { passive: false });
    return () => area.removeEventListener('wheel', wheel);
  }, []);

  return (
    <div className="app-shell" data-ready={ready}>
      <header className="app-header">
        <a className="brand" href="#" onClick={(e) => e.preventDefault()}>
          <span className="brand-mark">
            T<span>e</span>
          </span>
          <span>
            TEditor2<span className="web-label">WEB</span>
          </span>
        </a>
        <div className="file-title">
          <input
            aria-label="文件名"
            value={filename}
            onChange={(e) => {
              setFilename(e.target.value);
              setDirty(true);
            }}
          />
          <span
            className={dirty ? 'modified-dot' : 'saved-dot'}
            title={dirty ? '有未保存更改' : '已保存'}
          />
          <span className="local-tag">
            <span />
            本地工作区
          </span>
        </div>
        <div className="header-actions">
          <button
            className="icon-button"
            title="使用帮助"
            aria-label="使用帮助"
            onClick={() => setModal('help')}
          >
            <HelpCircle size={18} />
          </button>
          <button className="secondary" onClick={saveTemplate}>
            <Save size={15} />
            保存模板
          </button>
          <button className="primary" onClick={openExport}>
            <Download size={15} />
            批量导出
          </button>
        </div>
      </header>
      <div className="toolbar">
        <div className="toolbar-group">
          <button onClick={newDocument}>
            <FilePlus2 size={15} />
            新建
          </button>
          <button onClick={() => openInput.current?.click()}>
            <FolderOpen size={15} />
            打开模板
          </button>
          <span className="separator" />
          <button
            onClick={() => {
              setDataError('');
              setModal('data');
            }}
          >
            <Table2 size={15} />
            导入数据
          </button>
          <button onClick={() => assetInput.current?.click()}>
            <FolderInput size={15} />
            关联素材目录
          </button>
          <span className="separator" />
          <button
            onClick={undo}
            disabled={!history.current.past.length}
            title="撤销 Ctrl/Cmd+Z"
            aria-label="撤销"
          >
            <Undo2 size={16} />
          </button>
          <button
            onClick={redo}
            disabled={!history.current.future.length}
            title="重做 Ctrl/Cmd+Shift+Z"
            aria-label="重做"
          >
            <Redo2 size={16} />
          </button>
          <button
            onClick={() => setShowHistory((v) => !v)}
            className={showHistory ? 'active' : ''}
            title="历史记录"
            aria-label="历史记录"
          >
            <ChevronDown size={13} />
          </button>
        </div>
        <div className="toolbar-group">
          <button onClick={exportCurrent}>
            <ArrowDownToLine size={15} />
            导出当前
          </button>
          <span className="toolbar-caption">
            {doc.DocModel.Width} × {doc.DocModel.Height} px
          </span>
        </div>
      </div>
      <main className="editor-main">
        <aside className="layers-panel">
          <div className="panel-heading">
            <span>
              <Layers size={15} />
              图层
            </span>
            <span className="count">{doc.Layers.length}</span>
          </div>
          <div className="add-tools">
            {(['Text', 'Image', 'Rectangle', 'Ellipse'] as LayerKey[]).map((key) => (
              <button
                key={key}
                title={'添加' + typeNames[key]}
                aria-label={'添加' + typeNames[key]}
                onClick={() => addLayer(key)}
              >
                {layerIcon(key)}
                <span>{typeNames[key]}</span>
              </button>
            ))}
          </div>
          <div className="layer-list">
            {doc.Layers.map((layer, i) => {
              const visible = resolved.document.Layers.find((l) => l.Id === layer.Id)?.Visible;
              return (
                <div
                  key={layer.Id}
                  role="button"
                  tabIndex={0}
                  aria-label={'选择图层 ' + layer.LayerNameCustom}
                  aria-pressed={selected === layer.Id}
                  className={
                    'layer-row ' +
                    (selected === layer.Id ? 'selected ' : '') +
                    (!visible ? 'hidden-layer' : '')
                  }
                  draggable
                  onDragStart={() => (draggedLayer.current = layer.Id)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (draggedLayer.current) reorder(draggedLayer.current, i);
                    draggedLayer.current = null;
                  }}
                  onClick={() => {
                    setSelected(layer.Id);
                    setTab('properties');
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') setSelected(layer.Id);
                  }}
                >
                  <GripVertical size={11} className="drag-grip" />
                  {layer.ClippingMaskEnable && <span className="clip-mark">↳</span>}
                  <span className="layer-symbol">{layerIcon(layer.Key)}</span>
                  <span className="layer-name">
                    {layer.LayerNameCustom || typeNames[layer.Key]}
                  </span>
                  <button
                    className="icon-button visibility"
                    aria-label={(visible ? '隐藏 ' : '显示 ') + layer.LayerNameCustom}
                    onClick={(e) => {
                      e.stopPropagation();
                      visibility(layer.Id);
                    }}
                  >
                    {visible ? <Eye size={14} /> : <EyeOff size={14} />}
                  </button>
                </div>
              );
            })}
            {!doc.Layers.length && (
              <div className="empty-panel">
                <Layers size={28} />
                <p>开始你的第一个模板</p>
                <span>点击上方工具添加图层</span>
              </div>
            )}
          </div>
          <div className="layer-actions">
            <button
              className="icon-button"
              title="上移图层"
              aria-label="上移图层"
              disabled={!selectedLayer}
              onClick={() =>
                selected && reorder(selected, doc.Layers.findIndex((l) => l.Id === selected) - 1)
              }
            >
              <ArrowUp size={15} />
            </button>
            <button
              className="icon-button"
              title="下移图层"
              aria-label="下移图层"
              disabled={!selectedLayer}
              onClick={() =>
                selected && reorder(selected, doc.Layers.findIndex((l) => l.Id === selected) + 1)
              }
            >
              <ArrowDown size={15} />
            </button>
            <span />
            <button
              className="icon-button"
              title="复制图层"
              aria-label="复制图层"
              disabled={!selectedLayer}
              onClick={duplicate}
            >
              <Copy size={15} />
            </button>
            <button
              className="icon-button"
              title="删除图层"
              aria-label="删除图层"
              disabled={!selectedLayer}
              onClick={() => deleteLayer()}
            >
              <Trash2 size={15} />
            </button>
          </div>
          <div className="asset-summary">
            <FolderInput size={14} />
            <span>{assets.current.files.size} 个本地素材</span>
            <button className="text-action" onClick={() => assetInput.current?.click()}>
              关联
            </button>
          </div>
        </aside>
        <div className="center-panel">
          <div className="canvas-topline">
            <span>
              <span className="canvas-status-dot" />
              画布预览
            </span>
            <span>
              {table.rows.length ? `数据行 ${row + 1} / ${table.rows.length}` : '自由编辑'}
              {Object.keys(manual).length ? ' · 手动条件' : ''}
            </span>
          </div>
          <div
            ref={workspaceRef}
            className={'workspace ' + (hand ? 'hand-mode' : '')}
            onPointerDown={(e) => startPointer(e)}
            onPointerMove={movePointer}
            onPointerUp={endPointer}
            onPointerCancel={endPointer}
          >
            <div
              className="canvas-wrapper"
              style={{
                width: doc.DocModel.Width,
                height: doc.DocModel.Height,
                transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              }}
            >
              <canvas aria-label="模板画布" ref={canvasRef} />
              {selectedBounds && (
                <div
                  className="selection-box"
                  style={{
                    left: selectedBounds.x,
                    top: selectedBounds.y,
                    width: selectedBounds.width,
                    height: selectedBounds.height,
                    borderWidth: 1 / zoom,
                  }}
                >
                  {['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((handle) => (
                    <div
                      key={handle}
                      role="button"
                      aria-label={'缩放 ' + handle}
                      className={'resize-handle ' + handle}
                      style={{ width: 7 / zoom, height: 7 / zoom, borderWidth: 1 / zoom }}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        startPointer(e, handle);
                      }}
                      onPointerMove={movePointer}
                      onPointerUp={endPointer}
                    />
                  ))}
                </div>
              )}
            </div>
            <div className="canvas-controls" onPointerDown={(e) => e.stopPropagation()}>
              <button
                className="icon-button"
                aria-label="缩小"
                onClick={() => setZoom((z) => Math.max(0.05, z / 1.2))}
              >
                <Minus size={15} />
              </button>
              <input
                aria-label="画布缩放百分比"
                type="number"
                min={5}
                max={400}
                value={Math.round(zoom * 100)}
                onChange={(e) => setZoom(Math.max(0.05, Math.min(4, Number(e.target.value) / 100)))}
              />
              <span>%</span>
              <button
                className="icon-button"
                aria-label="放大"
                onClick={() => setZoom((z) => Math.min(4, z * 1.2))}
              >
                <Plus size={15} />
              </button>
              <span className="separator" />
              <button className="icon-button" aria-label="适应画布" title="适应画布" onClick={fit}>
                <Maximize size={15} />
              </button>
            </div>
            <div className="canvas-hint">空格拖动画布 · Alt + 滚轮缩放</div>
          </div>
          <div className="data-panel">
            <div className="data-heading">
              <button className="plain" onClick={() => setDataVisible((v) => !v)}>
                <Table2 size={15} />
                <b>数据源</b>
                <span className="count">{table.rows.length} 行</span>
                {dataVisible ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
              </button>
              <div>
                <button
                  className="text-action"
                  onClick={() => {
                    setDataError('');
                    setModal('data');
                  }}
                >
                  替换数据
                </button>
                <button className="text-action" onClick={() => csvInput.current?.click()}>
                  导入 CSV
                </button>
                <button
                  className="text-action"
                  onClick={() => {
                    const headers = table.headers.length ? table.headers : ['名称'];
                    setTable((t) => ({
                      headers,
                      rows: [...t.rows, Object.fromEntries(headers.map((h) => [h, '']))],
                    }));
                    selectRow(table.rows.length);
                  }}
                >
                  ＋ 添加行
                </button>
              </div>
            </div>
            {dataVisible && (
              <>
                <div className="data-scroll">
                  {table.headers.length ? (
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>#</th>
                          {table.headers.map((h) => (
                            <th key={h}>
                              <button
                                className="column-sort"
                                aria-label={'排序 ' + h}
                                onClick={() => sortData(h)}
                              >
                                {h}
                                {sort?.column === h ? (sort.direction > 0 ? ' ↑' : ' ↓') : ''}
                              </button>
                            </th>
                          ))}
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {table.rows.slice(page * 50, page * 50 + 50).map((record, j) => {
                          const i = page * 50 + j;
                          return (
                            <tr
                              key={i}
                              className={row === i ? 'current-row' : ''}
                              onClick={() => selectRow(i)}
                            >
                              <td>
                                <button
                                  className="row-number"
                                  aria-label={'预览第 ' + (i + 1) + ' 行'}
                                  onClick={() => selectRow(i)}
                                >
                                  {row === i ? <span className="row-indicator" /> : null}
                                  {i + 1}
                                </button>
                              </td>
                              {table.headers.map((h) => (
                                <td key={h}>
                                  <input
                                    aria-label={`第${i + 1}行 ${h}`}
                                    value={record[h] ?? ''}
                                    onChange={(e) => {
                                      const value = e.target.value;
                                      setTable((t) => ({
                                        ...t,
                                        rows: t.rows.map((r, k) =>
                                          k === i ? { ...r, [h]: value } : r,
                                        ),
                                      }));
                                    }}
                                  />
                                </td>
                              ))}
                              <td>
                                <button
                                  className="icon-button"
                                  aria-label={'删除第 ' + (i + 1) + ' 行'}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setTable((t) => ({
                                      ...t,
                                      rows: t.rows.filter((_, k) => k !== i),
                                    }));
                                    setRow((r) => Math.max(0, Math.min(r, table.rows.length - 2)));
                                    setPage((p) =>
                                      Math.min(
                                        p,
                                        Math.max(0, Math.ceil((table.rows.length - 1) / 50) - 1),
                                      ),
                                    );
                                  }}
                                >
                                  <X size={12} />
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  ) : (
                    <div className="empty-data">
                      <FileSpreadsheet size={28} />
                      <span>粘贴 Excel 表格，或导入 CSV 开始批量生成</span>
                      <button className="secondary" onClick={() => setModal('data')}>
                        导入数据
                      </button>
                    </div>
                  )}
                </div>
                <div className="data-footer">
                  <span>点击行切换预览 · 双击内容可编辑</span>
                  <div>
                    <button disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                      上一页
                    </button>
                    <span>
                      {page + 1} / {Math.max(1, Math.ceil(table.rows.length / 50))}
                    </span>
                    <button
                      disabled={(page + 1) * 50 >= table.rows.length}
                      onClick={() => setPage((p) => p + 1)}
                    >
                      下一页
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
        <aside className="inspector">
          <div className="inspector-tabs">
            <button
              className={tab === 'properties' ? 'active' : ''}
              onClick={() => setTab('properties')}
            >
              <Settings2 size={14} />
              属性
            </button>
            <button
              className={tab === 'conditions' ? 'active' : ''}
              onClick={() => setTab('conditions')}
            >
              <SlidersHorizontal size={14} />
              条件组
            </button>
          </div>
          <div className="inspector-content">
            {tab === 'conditions' ? (
              <Conditions
                document={doc}
                selectedConditions={manual}
                matchedConditions={resolved.matchedConditions}
                onChange={replaceDocument}
                onSelect={setManual}
              />
            ) : selectedLayer ? (
              <Properties
                key={selectedLayer.Id}
                layer={{
                  ...selectedLayer,
                  Visible:
                    resolved.document.Layers.find((l) => l.Id === selected)?.Visible ??
                    selectedLayer.Visible,
                }}
                onChange={patchLayer}
                onData={patchData}
                fonts={fonts}
                onFont={() => fontInput.current?.click()}
                onImage={() => imageInput.current?.click()}
              />
            ) : (
              <div className="properties">
                <section>
                  <div className="section-label">文档设置</div>
                  <div className="field-grid">
                    <NumberField
                      label="画布宽度"
                      value={doc.DocModel.Width}
                      min={1}
                      max={8192}
                      onChange={(v) => {
                        if (v * doc.DocModel.Height > 64000000) {
                          notice('画布不能超过 6400 万像素');
                          return;
                        }
                        mutate((d) => (d.DocModel.Width = Math.round(v)), '设置画布宽度', true);
                      }}
                    />
                    <NumberField
                      label="画布高度"
                      value={doc.DocModel.Height}
                      min={1}
                      max={8192}
                      onChange={(v) => {
                        if (v * doc.DocModel.Width > 64000000) {
                          notice('画布不能超过 6400 万像素');
                          return;
                        }
                        mutate((d) => (d.DocModel.Height = Math.round(v)), '设置画布高度', true);
                      }}
                    />
                  </div>
                  <div className="document-preview">
                    <span>
                      {doc.DocModel.Width} × {doc.DocModel.Height}
                    </span>
                    <small>透明背景 · PNG</small>
                  </div>
                </section>
                <section>
                  <div className="section-label">字体与素材</div>
                  <button className="secondary full" onClick={localFonts}>
                    读取本机字体
                  </button>
                  <button className="secondary full" onClick={() => fontInput.current?.click()}>
                    导入字体文件
                  </button>
                  <p className="hint">
                    字体、图片和数据在本机处理。旧模板的图片路径可通过关联素材目录恢复。
                  </p>
                </section>
                <section>
                  <div className="section-label">开始创作</div>
                  <p className="hint">选择画布上的元素或左侧图层，即可修改文字、图片和样式。</p>
                  <button className="secondary full" onClick={loadDemo}>
                    载入演示模板
                  </button>
                </section>
              </div>
            )}
          </div>
          <div className="inspector-foot">
            <span className="privacy-dot" />
            文件仅保存在你的设备上
          </div>
        </aside>
      </main>
      <footer className="statusbar">
        <span>
          <Check size={12} />
          {saving}
        </span>
        <span>
          {warnings.length > 0 && (
            <button className="warning-button" onClick={() => setWarningsOpen((v) => !v)}>
              <AlertCircle size={13} />
              {warnings.length} 条提示
            </button>
          )}
          <span>
            {selectedLayer
              ? `${typeNames[selectedLayer.Key]} · ${selectedLayer.LayerNameCustom}`
              : '未选择图层'}
          </span>
          <span className="version">TEditor2 1.0</span>
        </span>
      </footer>
      {toast && (
        <div role="status" className="toast">
          <Check size={16} />
          <span>{toast}</span>
          <button className="icon-button" aria-label="关闭消息" onClick={() => setToast('')}>
            <X size={14} />
          </button>
        </div>
      )}
      {warningsOpen && (
        <div className="floating-panel warnings">
          <div className="section-label">
            素材与渲染提示
            <button className="icon-button" onClick={() => setWarningsOpen(false)}>
              <X size={14} />
            </button>
          </div>
          {warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
        </div>
      )}
      {showHistory && (
        <div className="floating-panel history" data-revision={historyRevision}>
          <div className="section-label">
            操作历史
            <button className="icon-button" onClick={() => setShowHistory(false)}>
              <X size={14} />
            </button>
          </div>
          {history.current.past.length ? (
            [...history.current.past].reverse().map((h, i) => (
              <div key={i}>
                {i === 0 ? <span className="history-dot" /> : <span className="history-empty" />}
                {h.label}
              </div>
            ))
          ) : (
            <p className="hint">还没有编辑操作</p>
          )}
        </div>
      )}
      {modal && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !progress) setModal(null);
          }}
        >
          <div
            className={'modal ' + (modal === 'export' ? 'export-modal' : '')}
            role="dialog"
            aria-modal="true"
            aria-label={
              modal === 'data' ? '导入数据' : modal === 'export' ? '批量导出' : '使用帮助'
            }
          >
            <div className="modal-title">
              <h2>
                {modal === 'data'
                  ? '导入数据'
                  : modal === 'export'
                    ? '批量导出'
                    : '欢迎使用 TEditor2'}
              </h2>
              <button
                disabled={!!progress}
                className="icon-button"
                aria-label="关闭对话框"
                onClick={() => setModal(null)}
              >
                <X size={20} />
              </button>
            </div>
            {modal === 'data' && (
              <>
                <p className="muted">
                  从 Excel 复制包含标题行的表格，粘贴到下方。也可导入 CSV / TSV 文件。
                </p>
                <textarea
                  className="data-paste"
                  aria-label="粘贴表格数据"
                  placeholder={'名称\t得分\t图片\n林间来信\t98.6\tavatars/01.png'}
                  value={dataText}
                  onChange={(e) => setDataText(e.target.value)}
                />
                {dataError && <p className="error-message">{dataError}</p>}
                <div className="modal-actions">
                  <button className="secondary" onClick={() => csvInput.current?.click()}>
                    <FolderOpen size={15} />
                    选择 CSV / TSV
                  </button>
                  <button className="primary" onClick={pasteData}>
                    导入表格
                  </button>
                </div>
              </>
            )}
            {modal === 'export' && (
              <>
                <p className="muted">
                  以文档尺寸生成透明 PNG。当前数据源共 {Math.max(1, table.rows.length)} 行。
                </p>
                <div className="export-layout">
                  <fieldset className="export-settings" disabled={!!progress}>
                    <label className="field">
                      <span>文件名模板</span>
                      <input
                        aria-label="导出文件名模板"
                        value={exportOptions.filename}
                        onChange={(e) =>
                          setExportOptions((o) => ({ ...o, filename: e.target.value }))
                        }
                      />
                      <small>
                        支持 {'{index}'} 和 {'{列名}'}，自动添加 .png
                      </small>
                    </label>
                    <div className="field-grid">
                      <NumberField
                        label="起始行"
                        value={exportOptions.start}
                        min={1}
                        onChange={(v) => setExportOptions((o) => ({ ...o, start: v }))}
                      />
                      <NumberField
                        label="结束行"
                        value={exportOptions.end}
                        min={1}
                        onChange={(v) => setExportOptions((o) => ({ ...o, end: v }))}
                      />
                    </div>
                    <div className="export-repeat">
                      <div className="section-label">同页重复排版</div>
                      <NumberField
                        label="额外副本数"
                        value={exportOptions.repeats}
                        min={0}
                        max={500}
                        onChange={(v) => setExportOptions((o) => ({ ...o, repeats: v }))}
                      />
                      <div className="field-grid">
                        <NumberField
                          label="X 偏移"
                          value={exportOptions.deltaX}
                          onChange={(v) => setExportOptions((o) => ({ ...o, deltaX: v }))}
                        />
                        <NumberField
                          label="Y 偏移"
                          value={exportOptions.deltaY}
                          onChange={(v) => setExportOptions((o) => ({ ...o, deltaY: v }))}
                        />
                      </div>
                      <p className="hint">
                        副本数为 2 时，每张图放入连续 3 行数据；画布大小保持不变。
                      </p>
                    </div>
                    <label className="field">
                      <span>保存方式</span>
                      <select
                        aria-label="保存方式"
                        value={exportOptions.mode}
                        onChange={(e) => setExportOptions((o) => ({ ...o, mode: e.target.value }))}
                      >
                        <option value="directory">写入本地目录（推荐）</option>
                        <option value="zip">ZIP 下载（每包最多 50 张）</option>
                      </select>
                    </label>
                  </fieldset>
                  <BatchPreview
                    document={doc}
                    table={table}
                    plans={exportPlan.plans}
                    error={exportPlan.error}
                    deltaX={exportOptions.deltaX}
                    deltaY={exportOptions.deltaY}
                    resolveImage={assets.current.resolve}
                    assetRevision={assetRevision}
                    fonts={fonts}
                    disabled={!!progress}
                  />
                </div>
                {progress && (
                  <div className="progress">
                    <div>
                      <span>正在生成图片</span>
                      <b>
                        {progress.done} / {progress.total || '…'}
                      </b>
                    </div>
                    <progress value={progress.done} max={progress.total || 1} />
                  </div>
                )}
                {exportMessage && (
                  <p role="status" className="export-message">
                    {exportMessage}
                  </p>
                )}
                {archives.length > 0 && (
                  <div className="archive-list">
                    {archives.map((a) => (
                      <a key={a.url} href={a.url} download={a.name}>
                        <Download size={14} />
                        {a.name}
                        <span>{(a.size / 1024 / 1024).toFixed(1)} MB</span>
                      </a>
                    ))}
                  </div>
                )}
                <div className="modal-actions">
                  <span className="hint">同名文件会自动编号，不覆盖已有图片。</span>
                  {progress ? (
                    <button className="secondary" onClick={() => exportAbort.current?.abort()}>
                      取消导出
                    </button>
                  ) : (
                    <button className="primary" onClick={batchExport} disabled={!!exportPlan.error}>
                      <Download size={15} />
                      开始导出
                    </button>
                  )}
                </div>
              </>
            )}
            {modal === 'help' && (
              <>
                <p className="muted">
                  一个在浏览器中运行的模板图片编辑器。通过表格数据，让同一份设计生成不同内容。
                </p>
                <ol className="help-steps">
                  <li>
                    <b>设计模板</b>
                    <span>添加文字、图片、图形，设置描边、阴影或剪贴蒙版。</span>
                  </li>
                  <li>
                    <b>连接数据</b>
                    <span>粘贴 Excel 或导入 CSV，在文字和图片地址中使用 {'{列名}'}。</span>
                  </li>
                  <li>
                    <b>批量生成</b>
                    <span>用条件组切换元素，再将 PNG 保存到本地目录。</span>
                  </li>
                </ol>
                <div className="shortcuts">
                  <span>撤销 / 重做</span>
                  <kbd>⌘ / Ctrl + Z / Shift + Z</kbd>
                  <span>复制图层</span>
                  <kbd>⌘ / Ctrl + D</kbd>
                  <span>移动图层</span>
                  <kbd>方向键 · Shift 加速</kbd>
                  <span>移动画布</span>
                  <kbd>空格 + 拖动</kbd>
                  <span>缩放画布</span>
                  <kbd>Alt + 滚轮</kbd>
                </div>
                <p className="hint">
                  支持旧版 .ted。Windows 字体在其他系统可能需要导入。批量任务运行时请保持页面打开。
                </p>
                <div className="modal-actions">
                  <button
                    className="secondary"
                    onClick={() => {
                      setModal(null);
                      void loadDemo();
                    }}
                  >
                    载入演示模板
                  </button>
                  <button className="primary" onClick={() => setModal(null)}>
                    开始创作
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      <input
        hidden
        ref={openInput}
        type="file"
        accept=".ted,.json"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void loadTemplate(f);
          e.target.value = '';
        }}
      />
      <input
        hidden
        ref={imageInput}
        type="file"
        accept="image/*,.tif,.tiff"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void chooseImage(f);
          e.target.value = '';
        }}
      />
      <input
        hidden
        ref={assetInput}
        type="file"
        multiple
        {...({ webkitdirectory: '' } as Record<string, string>)}
        onChange={(e) => {
          if (e.target.files) void importAssets([...e.target.files]);
          e.target.value = '';
        }}
      />
      <input
        hidden
        ref={csvInput}
        type="file"
        accept=".csv,.tsv,.txt"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void loadData(f);
          e.target.value = '';
        }}
      />
      <input
        hidden
        ref={fontInput}
        type="file"
        accept=".ttf,.otf,.woff,.woff2"
        multiple
        onChange={(e) => {
          for (const f of e.target.files || []) void loadFont(f).catch((e) => notice(errorText(e)));
          e.target.value = '';
        }}
      />
    </div>
  );
}
