import type {
  Bounds,
  ImageData,
  ImageResolver,
  LayerModel,
  RenderResult,
  ShapeData,
  TedDocument,
  TextData,
} from './types';

/** The persisted coordinates use the WPF text anchor: baseline = Top + FontSize. */
type Context = CanvasRenderingContext2D;
type Surface = { canvas: HTMLCanvasElement; ctx: Context };
type RenderState = { revision: number; surfaces: Map<string, Surface> };
type TextLine = { text: string; width: number; justify: boolean };
type TextLayout = {
  lines: TextLine[];
  width: number;
  height: number;
  lineHeight: number;
  baseline: number;
  xOffset: number;
};
const renderStates = new WeakMap<HTMLCanvasElement, RenderState>();
let measurement: Context | undefined;
const number = (value: number, fallback = 0) => (Number.isFinite(value) ? value : fallback);
const positive = (value: number) => Math.max(0, number(value));
const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, number(value)));

function createSurface(width: number, height: number): Surface {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('当前浏览器不支持 Canvas 2D。');
  return { canvas, ctx };
}
function measureContext(): Context {
  return (measurement ??= createSurface(1, 1).ctx);
}
function surface(state: RenderState, name: string, width: number, height: number): Surface {
  let result = state.surfaces.get(name);
  if (!result) {
    result = createSurface(width, height);
    state.surfaces.set(name, result);
  }
  if (result.canvas.width !== width) result.canvas.width = width;
  if (result.canvas.height !== height) result.canvas.height = height;
  const ctx = result.ctx;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = ctx.shadowOffsetX = ctx.shadowOffsetY = 0;
  ctx.filter = 'none';
  ctx.clearRect(0, 0, width, height);
  return result;
}

const fontWeights: Record<string, number> = {
  thin: 100,
  extralight: 200,
  ultralight: 200,
  light: 300,
  normal: 400,
  regular: 400,
  medium: 500,
  semibold: 600,
  demibold: 600,
  bold: 700,
  extrabold: 800,
  ultrabold: 800,
  black: 900,
  heavy: 900,
  extrablack: 950,
  ultrablack: 950,
};
export function canvasFont(data: TextData): string {
  const weightText = String(data.FontWeight || 'Normal')
    .replace(/[\s_-]/g, '')
    .toLowerCase();
  const weight = fontWeights[weightText] ?? clamp(Number(weightText) || 400, 1, 1000);
  const style = /italic/i.test(data.FontStyle)
    ? 'italic'
    : /oblique/i.test(data.FontStyle)
      ? 'oblique'
      : 'normal';
  // Each old template stores one family. Quote it so spaces and commas in imported names remain literal.
  const family = JSON.stringify(data.FontFamilyName || 'sans-serif');
  return `${style} ${weight} ${Math.max(1, number(data.FontSize, 32))}px ${family}, sans-serif`;
}
function configureText(ctx: Context, data: TextData) {
  ctx.font = canvasFont(data);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.direction = 'ltr';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
}

const graphemeSegmenter =
  typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter('zh', { granularity: 'grapheme' })
    : undefined;
function characters(text: string): string[] {
  return graphemeSegmenter
    ? Array.from(graphemeSegmenter.segment(text), (item) => item.segment)
    : Array.from(text);
}
function spacedText(text: string, spaces: number): string {
  const hair = '\u200a'.repeat(Math.round(clamp(spaces, 0, 100)));
  return hair ? characters(text).join(hair) : text;
}
function fitPrefix(ctx: Context, chars: string[], start: number, width: number): number {
  let lo = 0,
    hi = chars.length - start;
  while (lo < hi) {
    const count = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(chars.slice(start, start + count).join('')).width <= width) lo = count;
    else hi = count - 1;
  }
  return lo;
}
function wrapLine(ctx: Context, text: string, width: number): TextLine[] {
  if (!text) return [{ text: '', width: 0, justify: false }];
  const chars = characters(text),
    result: TextLine[] = [];
  let start = 0;
  while (start < chars.length) {
    let count = fitPrefix(ctx, chars, start, width);
    // An oversized glyph is retained; the text box clips it instead of looping forever.
    if (!count) count = 1;
    const overflow = start + count < chars.length;
    if (overflow) {
      for (let i = start + count - 1; i > start; i--) {
        if (/\s/.test(chars[i]) || /[\u2e80-\u9fff\uac00-\ud7af]/u.test(chars[i])) {
          count = i - start + 1;
          break;
        }
      }
    }
    const line = chars
      .slice(start, start + count)
      .join('')
      .replace(/[\t \u200a]+$/u, '');
    result.push({ text: line, width: ctx.measureText(line).width, justify: overflow });
    start += count;
    while (start < chars.length && /^[\t \u200a]$/u.test(chars[start])) start++;
  }
  return result;
}
function ellipsize(ctx: Context, text: string, width: number): string {
  const ellipsis = '…';
  if (ctx.measureText(ellipsis).width > width) return '';
  const chars = characters(text.replace(/[\s\u200a]+$/u, ''));
  const count = fitPrefix(ctx, chars, 0, Math.max(0, width - ctx.measureText(ellipsis).width));
  return (
    chars
      .slice(0, count)
      .join('')
      .replace(/[\s\u200a]+$/u, '') + ellipsis
  );
}
function layoutText(data: TextData): TextLayout {
  const ctx = measureContext();
  configureText(ctx, data);
  const fontSize = Math.max(1, number(data.FontSize, 32));
  const metrics = ctx.measureText('国Ag');
  const descent =
    metrics.fontBoundingBoxDescent || metrics.actualBoundingBoxDescent || fontSize * 0.22;
  const defaultLineHeight = (metrics.fontBoundingBoxAscent || fontSize * 0.95) + descent;
  const lineHeight =
    data.LineHeight > 0 ? Math.max(0.1, data.LineHeight) : Math.max(fontSize, defaultLineHeight);
  const paragraphs = String(data.Text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  let lines: TextLine[] = [];
  const width = positive(data.Width);
  for (const paragraph of paragraphs) {
    const text = spacedText(paragraph, data.TextSpaceNumber);
    lines.push(
      ...(data.TextBoxMode
        ? wrapLine(ctx, text, width)
        : [{ text, width: ctx.measureText(text).width, justify: false }]),
    );
  }
  if (data.TextBoxMode) {
    const height = positive(data.Height);
    const capacity =
      height > 0 && width > 0
        ? Math.max(1, Math.floor((height - fontSize - descent) / lineHeight) + 1)
        : 0;
    const truncated = lines.length > capacity;
    lines = lines.slice(0, capacity);
    if (truncated && lines.length) {
      const last = lines[lines.length - 1];
      last.text = ellipsize(ctx, last.text, width);
      last.width = ctx.measureText(last.text).width;
      last.justify = false;
    }
  }
  const actualWidth = data.TextBoxMode
    ? width
    : lines.reduce((max, line) => Math.max(max, line.width), 0);
  const actualHeight = data.TextBoxMode
    ? positive(data.Height)
    : fontSize + descent + Math.max(0, lines.length - 1) * lineHeight;
  return {
    lines,
    width: actualWidth,
    height: actualHeight,
    lineHeight,
    baseline: fontSize,
    xOffset:
      data.TextAlignment === 1 ? -actualWidth : data.TextAlignment === 2 ? -actualWidth / 2 : 0,
  };
}

/** Logical selection bounds exclude effects, as in the original editor. */
export function measureLayer(layer: LayerModel): Bounds {
  if (layer.Key !== 'Text')
    return {
      x: number(layer.Left),
      y: number(layer.Top),
      width: positive(layer.Data.Width),
      height: positive(layer.Data.Height),
    };
  const layout = layoutText(layer.Data as TextData);
  return {
    x: number(layer.Left) + layout.xOffset,
    y: number(layer.Top),
    width: layout.width,
    height: layout.height,
  };
}

function drawTextLines(ctx: Context, layer: LayerModel, layout: TextLayout, stroke: boolean) {
  const data = layer.Data as TextData;
  configureText(ctx, data);
  const origin = number(layer.Left) + layout.xOffset;
  const top = number(layer.Top);
  ctx.save();
  if (data.TextBoxMode) {
    ctx.beginPath();
    ctx.rect(origin, top, layout.width, layout.height);
    ctx.clip();
  }
  for (let i = 0; i < layout.lines.length; i++) {
    const line = layout.lines[i];
    const y = top + layout.baseline + i * layout.lineHeight;
    const x =
      origin +
      (data.TextAlignment === 1
        ? layout.width - line.width
        : data.TextAlignment === 2
          ? (layout.width - line.width) / 2
          : 0);
    const draw = (text: string, at: number) =>
      stroke ? ctx.strokeText(text, at, y) : ctx.fillText(text, at, y);
    if (data.TextAlignment === 3 && data.TextBoxMode && line.justify && line.width < layout.width) {
      const chars = characters(line.text);
      const whitespace = chars.flatMap((char, index) => (/[\t ]/.test(char) ? [index] : []));
      // Chinese paragraphs justify between glyphs; Latin paragraphs prefer word spaces.
      const gaps = new Set(
        whitespace.length
          ? whitespace
          : chars.slice(0, -1).flatMap((char, index) => (char === '\u200a' ? [] : [index])),
      );
      const extra = gaps.size ? (layout.width - line.width) / gaps.size : 0;
      let previous = 0,
        shift = 0;
      for (let at = 0; at < chars.length; at++) {
        if (gaps.has(at) || at === chars.length - 1) {
          const part = chars.slice(previous, at + 1).join('');
          const prefix = chars.slice(0, previous).join('');
          draw(part, x + ctx.measureText(prefix).width + shift);
          shift += extra;
          previous = at + 1;
        }
      }
    } else draw(line.text, x);
  }
  ctx.restore();
}

const colorCache = new Map<string, string>();
function withOpacity(color: string, opacity: number): string {
  const key = `${color}|${opacity}`;
  const cached = colorCache.get(key);
  if (cached) return cached;
  const ctx = measureContext();
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = 'transparent';
  ctx.fillStyle = color || '#000';
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  const result = `rgba(${r}, ${g}, ${b}, ${(a / 255) * clamp(opacity, 0, 1)})`;
  if (colorCache.size > 256) colorCache.clear();
  colorCache.set(key, result);
  return result;
}
function drawText(
  ctx: Context,
  layer: LayerModel,
  state: RenderState,
  width: number,
  height: number,
) {
  const data = layer.Data as TextData;
  const layout = layoutText(data);
  const textSurface = data.ShadowEnable ? surface(state, 'text', width, height) : undefined;
  const target = textSurface?.ctx ?? ctx;
  target.fillStyle = data.Color || '#000';
  drawTextLines(target, layer, layout, false);
  const thickness = positive(data.StrokeThickness);
  if (data.StrokeEnable && thickness > 0) {
    if (data.StrokePosition === 1 || data.StrokePosition === 2) {
      const glyph = surface(state, 'glyph', width, height);
      glyph.ctx.fillStyle = '#000';
      drawTextLines(glyph.ctx, layer, layout, false);
      const stroke = surface(state, 'stroke', width, height);
      stroke.ctx.strokeStyle = data.StrokeColor || '#000';
      stroke.ctx.lineWidth = thickness * 2;
      drawTextLines(stroke.ctx, layer, layout, true);
      stroke.ctx.globalCompositeOperation =
        data.StrokePosition === 1 ? 'destination-out' : 'destination-in';
      stroke.ctx.drawImage(glyph.canvas, 0, 0);
      stroke.ctx.globalCompositeOperation = 'source-over';
      target.drawImage(stroke.canvas, 0, 0);
    } else {
      target.strokeStyle = data.StrokeColor || '#000';
      target.lineWidth = thickness;
      drawTextLines(target, layer, layout, true);
    }
  }
  if (textSurface) {
    ctx.save();
    const radians = (number(data.ShadowDirection, 315) * Math.PI) / 180;
    ctx.shadowColor = withOpacity(data.ShadowColor || '#000', data.ShadowOpacity);
    ctx.shadowBlur = positive(data.ShadowBlurRadius);
    ctx.shadowOffsetX = Math.cos(radians) * positive(data.ShadowDepth);
    ctx.shadowOffsetY = -Math.sin(radians) * positive(data.ShadowDepth);
    ctx.drawImage(textSurface.canvas, 0, 0);
    ctx.restore();
  }
}

function roundedRect(
  ctx: Context,
  x: number,
  y: number,
  width: number,
  height: number,
  data: ShapeData,
) {
  const radii = [
    data.RadiusTopLeft,
    data.RadiusTopRight,
    data.RadiusBottomRight,
    data.RadiusBottomLeft,
  ].map(positive);
  // CSS-style proportional normalization keeps independent corners valid at small sizes.
  const scale = Math.min(
    1,
    width / (radii[0] + radii[1] || 1),
    width / (radii[3] + radii[2] || 1),
    height / (radii[0] + radii[3] || 1),
    height / (radii[1] + radii[2] || 1),
  );
  const [tl, tr, br, bl] = radii.map((radius) => radius * scale);
  ctx.moveTo(x + tl, y);
  ctx.lineTo(x + width - tr, y);
  ctx.arcTo(x + width, y, x + width, y + tr, tr);
  ctx.lineTo(x + width, y + height - br);
  ctx.arcTo(x + width, y + height, x + width - br, y + height, br);
  ctx.lineTo(x + bl, y + height);
  ctx.arcTo(x, y + height, x, y + height - bl, bl);
  ctx.lineTo(x, y + tl);
  ctx.arcTo(x, y, x + tl, y, tl);
  ctx.closePath();
}
function drawShape(ctx: Context, layer: LayerModel) {
  const data = layer.Data as ShapeData;
  const x = number(layer.Left),
    y = number(layer.Top),
    width = positive(data.Width),
    height = positive(data.Height);
  if (!width || !height) return;
  ctx.beginPath();
  if (layer.Key === 'Ellipse')
    ctx.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
  else roundedRect(ctx, x, y, width, height, data);
  ctx.fillStyle = data.FillColor || 'transparent';
  ctx.fill();
  if (data.BorderWidth > 0) {
    ctx.strokeStyle = data.BorderColor || '#000';
    ctx.lineWidth = data.BorderWidth;
    ctx.stroke();
  }
}
function drawMissingImage(ctx: Context, layer: LayerModel) {
  const bounds = measureLayer(layer);
  if (!bounds.width || !bounds.height) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(bounds.x, bounds.y, bounds.width, bounds.height);
  ctx.clip();
  ctx.fillStyle = '#f1f3f7';
  ctx.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
  ctx.strokeStyle = '#a9b2c1';
  ctx.lineWidth = 1;
  ctx.strokeRect(bounds.x + 0.5, bounds.y + 0.5, bounds.width - 1, bounds.height - 1);
  ctx.beginPath();
  ctx.moveTo(bounds.x, bounds.y);
  ctx.lineTo(bounds.x + bounds.width, bounds.y + bounds.height);
  ctx.moveTo(bounds.x + bounds.width, bounds.y);
  ctx.lineTo(bounds.x, bounds.y + bounds.height);
  ctx.stroke();
  if (bounds.width > 70 && bounds.height > 30) {
    ctx.fillStyle = '#f1f3f7';
    ctx.fillRect(bounds.x + bounds.width / 2 - 40, bounds.y + bounds.height / 2 - 12, 80, 24);
    ctx.font = '12px sans-serif';
    ctx.fillStyle = '#667085';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('素材未关联', bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  }
  ctx.restore();
}

function snapshot(doc: TedDocument): TedDocument {
  return {
    ...doc,
    DocModel: { ...doc.DocModel },
    Layers: doc.Layers.map((layer) => ({ ...layer, Data: { ...layer.Data } })),
  };
}
function dimensions(doc: TedDocument): [number, number] {
  const width = Math.round(number(doc.DocModel.Width)),
    height = Math.round(number(doc.DocModel.Height));
  if (width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > 67_108_864)
    throw new Error('画布尺寸无效：边长须在 1～16384 像素之间，总像素不得超过 6710 万。');
  return [width, height];
}

/** Render one document. Repeated calls reuse at most six canvas buffers, regardless of export count. */
export async function renderDocument(
  canvas: HTMLCanvasElement,
  doc: TedDocument,
  resolveImage: ImageResolver,
): Promise<RenderResult> {
  return renderComposite(canvas, [doc], 0, 0, resolveImage);
}

/** Draw page backgrounds once, then consecutive rows. Masks stay within each pass. */
export async function renderComposite(
  canvas: HTMLCanvasElement,
  docs: TedDocument[],
  deltaX: number,
  deltaY: number,
  resolveImage: ImageResolver,
): Promise<RenderResult> {
  if (!docs.length) throw new Error('没有可绘制的文档。');
  let state = renderStates.get(canvas);
  if (!state) {
    state = { revision: 0, surfaces: new Map() };
    renderStates.set(canvas, state);
  }
  const revision = ++state.revision;
  const documents = docs.map(snapshot);
  const [width, height] = dimensions(documents[0]);
  const passes = [
    { layers: documents[0].Layers.filter((layer) => layer.PageBackground), dx: 0, dy: 0 },
    ...documents.map((doc, copy) => ({
      layers: doc.Layers.filter((layer) => !layer.PageBackground),
      dx: number(deltaX) * copy,
      dy: number(deltaY) * copy,
    })),
  ];
  const warnings = new Set<string>();
  const images = new Map<LayerModel, CanvasImageSource | null>();
  const imageJobs = new Map<string, Promise<CanvasImageSource | null>>();
  const fonts = new Map<string, string>();
  const jobs: Promise<unknown>[] = [];
  for (const pass of passes)
    for (const layer of pass.layers) {
      if (layer.Key === 'Text') {
        const data = layer.Data as TextData;
        const font = canvasFont(data);
        fonts.set(font, (fonts.get(font) || '') + String(data.Text ?? '').slice(0, 200));
      }
      if (!layer.Visible || layer.Key !== 'Image') continue;
      const data = layer.Data as ImageData;
      const embedded = data.EmbedImage ? data.Image : undefined;
      const key = embedded || data.ImageUrl || '';
      let job = imageJobs.get(key);
      if (!job) {
        job = Promise.resolve()
          .then(() => resolveImage(data.ImageUrl, embedded))
          .catch(() => null);
        imageJobs.set(key, job);
      }
      jobs.push(
        job.then((image) => {
          images.set(layer, image);
          if (!image)
            warnings.add(`素材未关联：${data.ImageUrl || layer.LayerNameCustom || '未指定图片'}`);
        }),
      );
    }
  if (document.fonts)
    for (const [font, text] of fonts)
      jobs.push(document.fonts.load(font, text || '国Ag').catch(() => undefined));
  await Promise.all(jobs);
  // Resolve before touching any pixels. A slower obsolete image load cannot overwrite a new edit.
  if (revision !== state.revision) return { bounds: {}, warnings: [] };
  const page = surface(state, 'page', width, height);
  const bounds: Record<string, Bounds> = {};
  for (const pass of passes) {
    const layers = pass.layers.slice().sort((a, b) => a.ZIndex - b.ZIndex);
    let base: Surface | undefined;
    let hasBase = false;
    const { dx, dy } = pass;
    for (let index = 0; index < layers.length; index++) {
      const original = layers[index];
      const layer = {
        ...original,
        Left: number(original.Left) + dx,
        Top: number(original.Top) + dy,
      };
      const layerBounds = measureLayer(layer);
      // The editor renders one copy. Composite callers receive the first instance for each ID.
      if (!(layer.Id in bounds)) bounds[layer.Id] = layerBounds;
      const usedAsMask = !layer.ClippingMaskEnable && !!layers[index + 1]?.ClippingMaskEnable;
      if (!layer.ClippingMaskEnable) {
        hasBase = true;
        base = usedAsMask ? surface(state, 'mask', width, height) : undefined;
      }
      if (!layer.Visible) continue;
      const isolated = surface(state, 'layer', width, height);
      if (layer.Key === 'Text') drawText(isolated.ctx, layer, state, width, height);
      else if (layer.Key === 'Image') {
        isolated.ctx.save();
        isolated.ctx.globalAlpha = clamp((layer.Data as ImageData).Opacity ?? 1, 0, 1);
        const image = images.get(original);
        if (image) {
          try {
            isolated.ctx.drawImage(
              image,
              layerBounds.x,
              layerBounds.y,
              layerBounds.width,
              layerBounds.height,
            );
          } catch {
            warnings.add(
              `无法绘制素材：${(layer.Data as ImageData).ImageUrl || layer.LayerNameCustom}`,
            );
            drawMissingImage(isolated.ctx, layer);
          }
        } else drawMissingImage(isolated.ctx, layer);
        isolated.ctx.restore();
      } else drawShape(isolated.ctx, layer);
      if (layer.ClippingMaskEnable && hasBase && base) {
        isolated.ctx.globalCompositeOperation = 'destination-in';
        isolated.ctx.drawImage(base.canvas, 0, 0);
        isolated.ctx.globalCompositeOperation = 'source-over';
      } else if (layer.ClippingMaskEnable && !hasBase) {
        warnings.add(`“${layer.LayerNameCustom || layer.Id}” 没有下方蒙版图层，已按普通图层绘制。`);
      }
      if (usedAsMask && base) base.ctx.drawImage(isolated.canvas, 0, 0);
      page.ctx.drawImage(isolated.canvas, 0, 0);
    }
  }
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const target = canvas.getContext('2d');
  if (!target) throw new Error('当前浏览器不支持 Canvas 2D。');
  target.save();
  target.setTransform(1, 0, 0, 1, 0, 0);
  target.globalCompositeOperation = 'copy';
  target.globalAlpha = 1;
  target.shadowColor = 'transparent';
  target.filter = 'none';
  target.drawImage(page.canvas, 0, 0);
  target.restore();
  return { bounds, warnings: Array.from(warnings) };
}
