import type { LayerModel, TextData, ImageData, ShapeData } from '../core/types';
import { FontPicker } from './FontPicker';
export function NumberField({
  label,
  value,
  onChange,
  min,
  step = 1,
  max,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        aria-label={label}
        type="number"
        value={Number.isFinite(value) ? value : 0}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          if (e.target.value !== '') {
            let n = Number(e.target.value);
            if (min !== undefined) n = Math.max(min, n);
            if (max !== undefined) n = Math.min(max, n);
            onChange(n);
          }
        }}
      />
    </label>
  );
}
export function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  let hex = value;
  if (/^#[\da-f]{8}$/i.test(value)) hex = value.slice(0, 7);
  if (!/^#[\da-f]{6}$/i.test(hex)) hex = '#000000';
  return (
    <label className="field">
      <span>{label}</span>
      <div className="color-field">
        <input
          aria-label={label + '选择'}
          type="color"
          value={hex}
          onChange={(e) => onChange(e.target.value)}
        />
        <input aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} />
      </div>
    </label>
  );
}
const Toggle = ({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (b: boolean) => void;
}) => (
  <label className="toggle">
    <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
    <span>{label}</span>
  </label>
);
export function Properties({
  layer,
  onChange,
  onData,
  fonts,
  fontStatus,
  onFont,
  onReadLocalFonts,
  onImage,
}: {
  layer: LayerModel;
  onChange: (patch: Partial<LayerModel>) => void;
  onData: (patch: Record<string, unknown>) => void;
  fonts: string[];
  fontStatus: string;
  onFont: () => void;
  onReadLocalFonts: () => void;
  onImage: () => void;
}) {
  const d = layer.Data;
  const n = (label: string, key: string, min = 0, step = 1) => (
    <NumberField
      label={label}
      value={Number((d as unknown as Record<string, unknown>)[key])}
      min={min}
      step={step}
      onChange={(v) => onData({ [key]: v })}
    />
  );
  return (
    <div className="properties">
      <section>
        <div className="section-label">图层</div>
        <label className="field">
          <span>名称</span>
          <input
            aria-label="图层名称"
            value={layer.LayerNameCustom}
            onChange={(e) => onChange({ LayerNameCustom: e.target.value })}
          />
        </label>
        <div className="field-grid">
          <NumberField
            label="X"
            value={layer.Left}
            step={0.5}
            onChange={(v) => onChange({ Left: v })}
          />
          <NumberField
            label="Y"
            value={layer.Top}
            step={0.5}
            onChange={(v) => onChange({ Top: v })}
          />
          {n('宽度', 'Width', 1, 0.5)}
          {n('高度', 'Height', 1, 0.5)}
        </div>
        <Toggle label="显示图层" value={layer.Visible} onChange={(v) => onChange({ Visible: v })} />
        <Toggle
          label="整页背景（不重复）"
          value={layer.PageBackground}
          onChange={(v) => onChange({ PageBackground: v })}
        />
        {layer.PageBackground && (
          <p className="hint">
            固定在普通图层下方，每页只绘制一次，不随副本偏移。变量和条件使用本页第一行数据。
          </p>
        )}
        <Toggle
          label="剪贴到下方图层"
          value={layer.ClippingMaskEnable}
          onChange={(v) => onChange({ ClippingMaskEnable: v })}
        />
        {layer.PageBackground && layer.ClippingMaskEnable && (
          <p className="hint">剪贴蒙版的基础图层也需设为整页背景。</p>
        )}
      </section>
      {layer.Key === 'Text' &&
        (() => {
          const t = d as TextData;
          return (
            <>
              <section>
                <div className="section-label">文字内容</div>
                <Toggle
                  label="使用数据变量"
                  value={t.VariableEnable}
                  onChange={(v) =>
                    onData({ VariableEnable: v, VariableTemplate: t.VariableTemplate || t.Text })
                  }
                />
                <textarea
                  aria-label={t.VariableEnable ? '文字模板' : '文字内容'}
                  rows={3}
                  value={t.VariableEnable ? t.VariableTemplate : t.Text}
                  onChange={(e) =>
                    onData(
                      t.VariableEnable
                        ? { VariableTemplate: e.target.value }
                        : { Text: e.target.value },
                    )
                  }
                />
                {t.VariableEnable && <p className="hint">用 {'{列名}'} 插入当前行的数据。</p>}
              </section>
              <section>
                <div className="section-label">
                  排版{' '}
                  <button className="text-action" onClick={onFont}>
                    导入字体
                  </button>
                </div>
                <FontPicker
                  value={t.FontFamilyName}
                  fonts={fonts}
                  status={fontStatus}
                  onChange={(value) => onData({ FontFamilyName: value })}
                  onReadLocalFonts={onReadLocalFonts}
                />
                <div className="field-grid">
                  {n('字号', 'FontSize', 1)}
                  <label className="field">
                    <span>字重</span>
                    <select
                      aria-label="字重"
                      value={
                        ({ Normal: '400', Bold: '700' } as Record<string, string>)[t.FontWeight] ||
                        t.FontWeight
                      }
                      onChange={(e) => onData({ FontWeight: e.target.value })}
                    >
                      {['100', '200', '300', '400', '500', '600', '700', '800', '900'].map((x) => (
                        <option key={x}>{x}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <Toggle
                  label="斜体"
                  value={t.FontStyle.toLowerCase() === 'italic'}
                  onChange={(v) => onData({ FontStyle: v ? 'Italic' : 'Normal' })}
                />
                <label className="field">
                  <span>对齐</span>
                  <select
                    aria-label="文字对齐"
                    value={t.TextAlignment}
                    onChange={(e) => onData({ TextAlignment: Number(e.target.value) })}
                  >
                    <option value={0}>左对齐</option>
                    <option value={2}>居中</option>
                    <option value={1}>右对齐</option>
                    <option value={3}>两端对齐</option>
                  </select>
                </label>
                <div className="field-grid">
                  {n('行高（0 自动）', 'LineHeight', 0)}
                  {n('细空格数量', 'TextSpaceNumber', 0)}
                </div>
                <ColorField
                  label="文字颜色"
                  value={t.Color}
                  onChange={(v) => onData({ Color: v })}
                />
                <Toggle
                  label="固定文本框（换行 / 省略）"
                  value={t.TextBoxMode}
                  onChange={(v) => onData({ TextBoxMode: v })}
                />
              </section>
              <section>
                <Toggle
                  label="文字描边"
                  value={t.StrokeEnable}
                  onChange={(v) => onData({ StrokeEnable: v })}
                />
                {t.StrokeEnable && (
                  <>
                    <ColorField
                      label="描边颜色"
                      value={t.StrokeColor}
                      onChange={(v) => onData({ StrokeColor: v })}
                    />
                    {n('描边粗细', 'StrokeThickness', 0, 0.5)}
                    <label className="field">
                      <span>描边位置</span>
                      <select
                        aria-label="描边位置"
                        value={t.StrokePosition}
                        onChange={(e) => onData({ StrokePosition: Number(e.target.value) })}
                      >
                        <option value={1}>外侧</option>
                        <option value={0}>居中</option>
                        <option value={2}>内侧</option>
                      </select>
                    </label>
                  </>
                )}
              </section>
              <section>
                <Toggle
                  label="文字阴影"
                  value={t.ShadowEnable}
                  onChange={(v) => onData({ ShadowEnable: v })}
                />
                {t.ShadowEnable && (
                  <>
                    <ColorField
                      label="阴影颜色"
                      value={t.ShadowColor}
                      onChange={(v) => onData({ ShadowColor: v })}
                    />
                    <div className="field-grid">
                      {n('阴影距离', 'ShadowDepth', 0)}
                      {n('阴影角度', 'ShadowDirection', 0)}
                      {n('模糊半径', 'ShadowBlurRadius', 0)}
                      <NumberField
                        label="阴影透明度"
                        value={t.ShadowOpacity}
                        min={0}
                        max={1}
                        step={0.05}
                        onChange={(v) => onData({ ShadowOpacity: v })}
                      />
                    </div>
                  </>
                )}
              </section>
            </>
          );
        })()}
      {layer.Key === 'Image' &&
        (() => {
          const i = d as ImageData;
          return (
            <section>
              <div className="section-label">图片来源</div>
              <button className="secondary full" onClick={onImage}>
                选择本地图片
              </button>
              <Toggle
                label="图片地址使用变量"
                value={i.VariableEnable}
                onChange={(v) =>
                  onData({
                    VariableEnable: v,
                    EmbedImage: v ? false : i.EmbedImage,
                    VariableImageUrl: i.VariableImageUrl || i.ImageUrl,
                  })
                }
              />
              <label className="field">
                <span>{i.VariableEnable ? '图片地址模板' : '图片地址'}</span>
                <textarea
                  aria-label="图片地址"
                  value={i.VariableEnable ? i.VariableImageUrl : i.ImageUrl}
                  rows={3}
                  onChange={(e) =>
                    onData(
                      i.VariableEnable
                        ? { VariableImageUrl: e.target.value }
                        : { ImageUrl: e.target.value },
                    )
                  }
                />
              </label>
              <Toggle
                label="保存时内嵌图片"
                value={i.EmbedImage}
                onChange={(v) => onData({ EmbedImage: v })}
              />
              <p className="hint">
                变量图片按素材目录中的相对路径匹配，如 avatars/{'{编号}'}.png。
              </p>
            </section>
          );
        })()}
      {(layer.Key === 'Rectangle' || layer.Key === 'Ellipse') &&
        (() => {
          const s = d as ShapeData;
          const radius = (key: keyof ShapeData, v: number) => {
            if (!s.RadiusLink) {
              onData({ [key]: v });
              return;
            }
            const diff = v - Number(s[key]);
            onData(
              Object.fromEntries(
                ['RadiusTopLeft', 'RadiusTopRight', 'RadiusBottomRight', 'RadiusBottomLeft'].map(
                  (k) => [k, Math.max(0, Number(s[k as keyof ShapeData]) + diff)],
                ),
              ),
            );
          };
          return (
            <>
              <section>
                <div className="section-label">外观</div>
                <ColorField
                  label="填充颜色"
                  value={s.FillColor}
                  onChange={(v) => onData({ FillColor: v })}
                />
                <ColorField
                  label="边框颜色"
                  value={s.BorderColor}
                  onChange={(v) => onData({ BorderColor: v })}
                />
                {n('边框宽度', 'BorderWidth', 0, 0.5)}
              </section>
              {layer.Key === 'Rectangle' && (
                <section>
                  <div className="section-label">圆角</div>
                  <Toggle
                    label="联动四角"
                    value={s.RadiusLink}
                    onChange={(v) => onData({ RadiusLink: v })}
                  />
                  <div className="field-grid">
                    {(
                      [
                        'RadiusTopLeft',
                        'RadiusTopRight',
                        'RadiusBottomLeft',
                        'RadiusBottomRight',
                      ] as const
                    ).map((k, j) => (
                      <NumberField
                        key={k}
                        label={['左上圆角', '右上圆角', '左下圆角', '右下圆角'][j]}
                        value={s[k]}
                        min={0}
                        onChange={(v) => radius(k, v)}
                      />
                    ))}
                  </div>
                </section>
              )}
            </>
          );
        })()}
    </div>
  );
}
