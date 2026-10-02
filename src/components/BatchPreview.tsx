import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Eye } from 'lucide-react';
import type { BatchPlan } from '../core/data';
import { renderBatchPage } from '../core/batch';
import type { ImageResolver, TableData, TedDocument } from '../core/types';

interface BatchPreviewProps {
  document: TedDocument;
  table: TableData;
  plans: BatchPlan[];
  error: string;
  deltaX: number;
  deltaY: number;
  resolveImage: ImageResolver;
  assetRevision: number;
  fonts: string[];
  disabled: boolean;
}

export function BatchPreview({
  document: doc,
  table,
  plans,
  error,
  deltaX,
  deltaY,
  resolveImage,
  assetRevision,
  fonts,
  disabled,
}: BatchPreviewProps) {
  // Changing the range or group size starts at the first output page; changing offsets keeps it.
  const planKey = `${plans[0]?.start}:${plans[0]?.end}:${plans.at(-1)?.end}:${plans.length}`;
  const [selection, setSelection] = useState({ key: planKey, page: 0 });
  const page = selection.key === planKey ? Math.min(selection.page, plans.length - 1) : 0;
  const plan = plans[page];
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scratchRef = useRef<HTMLCanvasElement | null>(null);
  const [busy, setBusy] = useState(true);
  const [renderError, setRenderError] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);

  useEffect(() => {
    let active = true;
    setBusy(true);
    setRenderError('');
    setWarnings([]);
    // Coalesce fast input changes and only render the selected output page.
    const timer = window.setTimeout(async () => {
      if (!plan || error) {
        if (active) setBusy(false);
        return;
      }
      try {
        const scratch = (scratchRef.current ??= window.document.createElement('canvas'));
        const result = await renderBatchPage(
          scratch,
          doc,
          table,
          plan.indices,
          deltaX,
          deltaY,
          resolveImage,
        );
        if (!active || !canvasRef.current) return;
        const canvas = canvasRef.current;
        canvas.width = scratch.width;
        canvas.height = scratch.height;
        canvas.getContext('2d')!.drawImage(scratch, 0, 0);
        setWarnings(result.warnings);
      } catch (cause) {
        if (active) setRenderError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (active) setBusy(false);
      }
    }, 120);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [doc, table, plan, error, deltaX, deltaY, resolveImage, assetRevision, fonts]);

  const problem = error || renderError;
  return (
    <section className="batch-preview" aria-label="同页排版预览">
      <div className="batch-preview-heading">
        <span>
          <Eye size={16} />
          排版预览
        </span>
        <span className="batch-preview-live">随参数自动更新</span>
      </div>
      <div className="batch-preview-stage" aria-busy={busy && !problem}>
        <canvas
          ref={canvasRef}
          aria-label="同页排版预览画布"
          data-ready={!busy && !problem && !!plan}
          style={{ visibility: problem || !plan ? 'hidden' : undefined, opacity: busy ? 0.35 : 1 }}
        />
        {problem ? (
          <p role="alert" className="batch-preview-overlay error-message">
            {problem}
          </p>
        ) : (
          busy && <span className="batch-preview-overlay">正在更新预览…</span>
        )}
      </div>
      <div className="batch-preview-navigation">
        <button
          className="icon-button"
          aria-label="预览上一页"
          disabled={disabled || !plan || page <= 0}
          onClick={() => setSelection({ key: planKey, page: page - 1 })}
        >
          <ChevronLeft size={17} />
        </button>
        <span aria-label="预览页码">
          {plan ? `第 ${page + 1} / ${plans.length} 页` : '暂无可预览页面'}
        </span>
        <button
          className="icon-button"
          aria-label="预览下一页"
          disabled={disabled || !plan || page >= plans.length - 1}
          onClick={() => setSelection({ key: planKey, page: page + 1 })}
        >
          <ChevronRight size={17} />
        </button>
      </div>
      {plan && (
        <p className="batch-preview-rows">
          {table.rows.length
            ? `数据第 ${plan.start}${plan.end !== plan.start ? `–${plan.end}` : ''} 行 · 本页 ${plan.indices.length} 条`
            : '无表格数据 · 使用当前模板'}
        </p>
      )}
      <p className="hint">
        {doc.DocModel.Width} × {doc.DocModel.Height} px · 与导出使用相同排版，超出画布的内容会裁切。
      </p>
      {plan && plan.indices.length > 1 && deltaX === 0 && deltaY === 0 && (
        <p className="batch-preview-note">X、Y 偏移均为 0，副本会重叠。调整偏移即可展开。</p>
      )}
      {warnings.length > 0 && (
        <details className="batch-preview-warnings">
          <summary>{warnings.length} 条素材或数据提示</summary>
          {warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </details>
      )}
    </section>
  );
}
