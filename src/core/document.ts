import type {
  ConditionGroup,
  ImageData,
  LayerKey,
  LayerModel,
  ShapeData,
  TedDocument,
  TextData,
} from './types';

export const DOCUMENT_VERSION = 1;
export const MAX_CANVAS_PIXELS = 64_000_000;
const MAX_DIMENSION = 32_768;
const LAYER_KEYS: LayerKey[] = ['Text', 'Image', 'Rectangle', 'Ellipse'];
type JsonObject = Record<string, unknown>;

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label}必须是对象`);
  return value as JsonObject;
}
function string(value: unknown, fallback = ''): string {
  return value === undefined || value === null ? fallback : String(value);
}
function number(
  value: unknown,
  fallback: number,
  label: string,
  min = -1_000_000,
  max = 1_000_000,
): number {
  if (value === undefined || value === null || value === '') return fallback;
  const result =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(result) || result < min || result > max)
    throw new Error(`${label}必须是 ${min}～${max} 之间的有限数值`);
  return result;
}
function boolean(value: unknown, fallback = false): boolean {
  if (value === undefined || value === null) return fallback;
  if (value === true || value === 'true' || value === 1) return true;
  if (value === false || value === 'false' || value === 0) return false;
  throw new Error(`无效的布尔值：${String(value)}`);
}
function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label}必须是数组`);
  return value;
}
function id(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `layer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
  );
}
function canvasSize(width: unknown, height: unknown): { Width: number; Height: number } {
  const Width = number(width, 1920, '画布宽度', 1, MAX_DIMENSION);
  const Height = number(height, 1080, '画布高度', 1, MAX_DIMENSION);
  if (!Number.isInteger(Width) || !Number.isInteger(Height))
    throw new Error('画布宽高必须是整数像素');
  if (Width * Height > MAX_CANVAS_PIXELS) throw new Error('画布超过 6400 万像素，请减小宽高');
  return { Width, Height };
}

const CSS_NAMES = new Set(
  'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato transparent turquoise violet wheat white whitesmoke yellow yellowgreen'.split(
    ' ',
  ),
);

function color(input: unknown, legacy: boolean): string {
  if (input === undefined || input === null || input === '') return '#000000';
  if (typeof input === 'object' && !Array.isArray(input)) {
    const value = input as JsonObject;
    const channel = (key: string, fallback: number) =>
      Math.round(number(value[key], fallback, `颜色 ${key}`, 0, 255))
        .toString(16)
        .padStart(2, '0');
    return `#${channel('R', 0)}${channel('G', 0)}${channel('B', 0)}${channel('A', 255)}`;
  }
  const value = String(input).trim().toLowerCase();
  if (CSS_NAMES.has(value)) return value;
  if (/^#[\da-f]{3}$/.test(value))
    return `#${value
      .slice(1)
      .split('')
      .map((c) => c + c)
      .join('')}`;
  if (/^#[\da-f]{4}$/.test(value)) {
    const expanded = value
      .slice(1)
      .split('')
      .map((c) => c + c)
      .join('');
    return legacy ? `#${expanded.slice(2)}${expanded.slice(0, 2)}` : `#${expanded}`;
  }
  if (/^#[\da-f]{6}$/.test(value)) return value;
  if (/^#[\da-f]{8}$/.test(value)) return legacy ? `#${value.slice(3)}${value.slice(1, 3)}` : value;
  // Retain valid functional CSS colors without relying on a browser DOM.
  if (/^(?:rgb|rgba|hsl|hsla)\([\d\s.,%+\-/]+\)$/.test(value)) return value;
  // WPF may serialize an scRGB color instead of an eight-digit hex color.
  if (legacy && /^sc#/.test(value)) {
    const values = value
      .slice(3)
      .split(',')
      .map((s) => Number(s.trim()));
    if ((values.length === 3 || values.length === 4) && values.every(Number.isFinite)) {
      const alpha = values.length === 4 ? values.shift()! : 1;
      const hex = (n: number) =>
        Math.round(Math.max(0, Math.min(1, n)) * 255)
          .toString(16)
          .padStart(2, '0');
      const gamma = (n: number) => (n <= 0.0031308 ? n * 12.92 : 1.055 * n ** (1 / 2.4) - 0.055);
      return `#${values.map((v) => hex(gamma(v))).join('')}${hex(alpha)}`;
    }
  }
  throw new Error(`无法识别颜色：${String(input)}`);
}

/** Convert a WPF color, including #AARRGGBB, to a CSS color. */
export function normalizeColor(input: unknown): string {
  return color(input, true);
}

function enumValue(
  value: unknown,
  names: Record<string, number>,
  fallback: number,
  label: string,
): number {
  if (typeof value === 'string' && Object.hasOwn(names, value.toLowerCase()))
    return names[value.toLowerCase()];
  const result = number(value, fallback, label, 0, Math.max(...Object.values(names)));
  if (!Number.isInteger(result)) throw new Error(`${label}无效`);
  return result;
}
function fontWeight(value: unknown): string {
  const weights: Record<string, number> = {
    thin: 100,
    extralight: 200,
    ultralight: 200,
    light: 300,
    normal: 400,
    regular: 400,
    medium: 500,
    demibold: 600,
    semibold: 600,
    bold: 700,
    extrabold: 800,
    ultrabold: 800,
    heavy: 900,
    black: 900,
    extrablack: 950,
    ultrablack: 950,
  };
  const text = string(value, 'normal')
    .toLowerCase()
    .replace(/[\s_-]/g, '');
  return String(
    Object.hasOwn(weights, text) ? weights[text] : number(text, 400, '字体字重', 1, 1000),
  );
}
function fontStyle(value: unknown): string {
  const text = string(value, 'normal').toLowerCase();
  if (!['normal', 'italic', 'oblique'].includes(text)) throw new Error(`未知字体样式：${text}`);
  return text;
}

export function createLayer(key: LayerKey): LayerModel {
  if (!LAYER_KEYS.includes(key)) throw new Error(`不支持的图层类型：${key}`);
  let Data: TextData | ImageData | ShapeData;
  if (key === 'Text')
    Data = {
      Text: '请修改文字',
      FontFamilyName: '微软雅黑',
      FontWeight: '400',
      FontSize: 32,
      FontStyle: 'normal',
      TextAlignment: 0,
      LineHeight: 0,
      TextSpaceNumber: 0,
      Color: '#000000',
      TextBoxMode: false,
      Width: 400,
      Height: 100,
      StrokeEnable: false,
      StrokePosition: 1,
      StrokeThickness: 1,
      StrokeColor: '#000000',
      ShadowEnable: false,
      ShadowDepth: 10,
      ShadowDirection: 315,
      ShadowColor: '#000000',
      ShadowOpacity: 0.5,
      ShadowBlurRadius: 10,
      VariableEnable: false,
      VariableTemplate: '',
    };
  else if (key === 'Image')
    Data = {
      ImageUrl: '',
      Opacity: 1,
      VariableEnable: false,
      VariableImageUrl: '',
      EmbedImage: false,
      Image: '',
      Width: 320,
      Height: 240,
    };
  else
    Data = {
      FillColor: '#000000',
      BorderColor: '#ffffff',
      BorderWidth: 0,
      Width: 100,
      Height: 100,
      RadiusLink: true,
      RadiusTopLeft: 0,
      RadiusTopRight: 0,
      RadiusBottomRight: 0,
      RadiusBottomLeft: 0,
    };
  return {
    Id: id(),
    Key: key,
    ZIndex: 0,
    Left: 0,
    Top: 0,
    Visible: true,
    PageBackground: false,
    LayerNameCustom: '',
    ClippingMaskEnable: false,
    ClippingMaskBottom: false,
    Data,
  };
}

export function createDocument(width = 1920, height = 1080): TedDocument {
  const now = new Date().toISOString();
  return {
    VersionCode: DOCUMENT_VERSION,
    DocModel: {
      ...canvasSize(width, height),
      CreatedAt: now,
      UpdatedAt: now,
      FormatConditionGroups: [
        {
          Name: '默认条件组',
          Color: '#6c77ed',
          EffctiveLayers: [],
          FormatConditionModels: [{ Name: '默认', Condition: '', LayersVisable: {} }],
        },
      ],
    },
    Layers: [],
  };
}

function normalizeLayer(input: unknown, legacy: boolean, index: number): LayerModel {
  const raw = object(input, `第 ${index + 1} 个图层`);
  if (!LAYER_KEYS.includes(raw.Key as LayerKey))
    throw new Error(
      `第 ${index + 1} 个图层包含不支持的类型：${string(raw.Key, '缺少 Key')}。文件未打开，以避免丢失内容。`,
    );
  const layer = createLayer(raw.Key as LayerKey);
  layer.Id = string(raw.Id).trim();
  layer.ZIndex = number(raw.ZIndex, -index, '图层顺序');
  layer.Left = number(raw.Left, 0, '图层 X');
  layer.Top = number(raw.Top, 0, '图层 Y');
  layer.Visible = boolean(raw.Visible, true);
  layer.PageBackground = boolean(raw.PageBackground);
  layer.LayerNameCustom = string(raw.LayerNameCustom);
  layer.ClippingMaskEnable = boolean(raw.ClippingMaskEnable);
  layer.ClippingMaskBottom = boolean(raw.ClippingMaskBottom);
  const data =
    raw.Data === undefined || raw.Data === null
      ? {}
      : object(raw.Data, `图层 ${index + 1} 的 Data`);
  const target = layer.Data as unknown as JsonObject;
  for (const field of Object.keys(target)) {
    if (data[field] === undefined || data[field] === null) continue;
    const fallback = target[field];
    if (/Color$/.test(field)) target[field] = color(data[field], legacy);
    else if (field === 'FontWeight') target[field] = fontWeight(data[field]);
    else if (field === 'FontStyle') target[field] = fontStyle(data[field]);
    else if (field === 'TextAlignment')
      target[field] = enumValue(
        data[field],
        { left: 0, right: 1, center: 2, justify: 3 },
        0,
        '文字对齐',
      );
    else if (field === 'StrokePosition')
      target[field] = enumValue(data[field], { center: 0, outside: 1, inside: 2 }, 1, '描边位置');
    else if (typeof fallback === 'boolean') target[field] = boolean(data[field], fallback);
    else if (typeof fallback === 'number') {
      const max =
        field === 'ShadowOpacity' || field === 'Opacity'
          ? 1
          : field === 'FontSize'
            ? 4096
            : MAX_DIMENSION;
      const min = field === 'FontSize' ? 1 : field === 'ShadowDirection' ? -3600 : 0;
      target[field] = number(data[field], fallback, `图层 ${index + 1} 的 ${field}`, min, max);
      if (field === 'TextSpaceNumber') target[field] = Math.floor(target[field] as number);
    } else target[field] = string(data[field], fallback as string);
  }
  return layer;
}

function normalizeGroups(
  input: unknown,
  ids: Set<string>,
  legacy: boolean,
  warnings: string[],
): ConditionGroup[] {
  if (input === undefined || input === null) return createDocument().DocModel.FormatConditionGroups;
  return array(input, '条件组').map((entry, index) => {
    const group = object(entry, `条件组 ${index + 1}`);
    const name = string(group.Name, `条件组 ${index + 1}`);
    const effective: string[] = [];
    for (const value of array(group.EffctiveLayers ?? [], `条件组「${name}」的图层列表`)) {
      const ref = string(value);
      if (!ids.has(ref)) warnings.push(`条件组「${name}」引用了不存在的图层 ${ref}，已移除该引用`);
      else if (!effective.includes(ref)) effective.push(ref);
    }
    const conditions = array(group.FormatConditionModels ?? [], `条件组「${name}」的条件列表`).map(
      (entry, i) => {
        const condition = object(entry, `条件 ${i + 1}`);
        const entries: [string, boolean][] = [];
        for (const [ref, visible] of Object.entries(
          object(condition.LayersVisable ?? {}, '条件图层可见性'),
        )) {
          if (ids.has(ref)) entries.push([ref, boolean(visible)]);
          else
            warnings.push(`条件组「${name}」的可见性设置引用了不存在的图层 ${ref}，已移除该引用`);
        }
        return {
          Name: string(condition.Name, `条件 ${i + 1}`),
          Condition: string(condition.Condition),
          LayersVisable: Object.fromEntries(entries),
        };
      },
    );
    if (!conditions.some((c) => c.Name === '默认'))
      conditions.push({ Name: '默认', Condition: '', LayersVisable: {} });
    return {
      Name: name,
      Color: color(group.Color ?? '#6c77ed', legacy),
      EffctiveLayers: effective,
      FormatConditionModels: conditions,
    };
  });
}

/** Read both original WPF documents (version 0) and browser documents (version 1). */
export function normalizeDocument(input: unknown): { document: TedDocument; warnings: string[] } {
  const raw = object(input, '模板');
  if (!('DocModel' in raw) || !('Layers' in raw))
    throw new Error('不是有效的 .ted 模板：缺少 DocModel 或 Layers');
  const version = number(raw.VersionCode, 0, '模板版本', 0, Number.MAX_SAFE_INTEGER);
  if (!Number.isInteger(version) || version > DOCUMENT_VERSION)
    throw new Error(`模板版本 ${version} 暂不支持，请使用兼容版本的编辑器`);
  const legacy = version === 0;
  const model = object(raw.DocModel, '文档设置');
  const warnings: string[] = [];
  const layers = array(raw.Layers, '图层列表').map((entry, index) =>
    normalizeLayer(entry, legacy, index),
  );
  const ids = new Set<string>();
  for (const layer of layers) {
    if (!layer.Id || ids.has(layer.Id)) {
      warnings.push(
        layer.Id
          ? `重复图层 ID「${layer.Id}」已重新生成；原条件引用保留到第一个同名 ID 图层`
          : '缺少图层 ID，已生成新 ID',
      );
      layer.Id = id();
    }
    ids.add(layer.Id);
  }
  // Older .ted files rely on WPF ZIndex; browser files use the visible top-first array order.
  if (legacy) layers.sort((a, b) => b.ZIndex - a.ZIndex);
  const now = new Date().toISOString();
  const document: TedDocument = {
    VersionCode: DOCUMENT_VERSION,
    DocModel: {
      ...canvasSize(model.Width, model.Height),
      CreatedAt: string(model.CreatedAt, now),
      UpdatedAt: string(model.UpdatedAt, now),
      FormatConditionGroups: normalizeGroups(model.FormatConditionGroups, ids, legacy, warnings),
    },
    Layers: layers,
  };
  normalizeLayerOrder(document);
  return { document, warnings };
}

export function parseDocument(text: string): { document: TedDocument; warnings: string[] } {
  let input: unknown;
  try {
    input = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('无法读取模板：.ted 必须是有效的 JSON 文件');
  }
  return normalizeDocument(input);
}

export function serializeDocument(document: TedDocument): string {
  return JSON.stringify(normalizeDocument(document).document, null, 2);
}

export function cloneDocument(document: TedDocument): TedDocument {
  return JSON.parse(JSON.stringify(document)) as TedDocument;
}

/** Top-first order, with page backgrounds kept below all repeating content. */
export function normalizeLayerOrder(document: TedDocument): void {
  document.Layers.sort((a, b) => Number(!!a.PageBackground) - Number(!!b.PageBackground));
  document.Layers.forEach((layer, index) => {
    layer.ZIndex = document.Layers.length - 1 - index;
  });
}

export function duplicateLayer(document: TedDocument, layerId: string): TedDocument {
  const result = cloneDocument(document);
  const index = result.Layers.findIndex((layer) => layer.Id === layerId);
  if (index === -1) throw new Error('找不到要复制的图层');
  const source = result.Layers[index];
  const copy: LayerModel = JSON.parse(JSON.stringify(source));
  copy.Id = id();
  copy.LayerNameCustom = `${source.LayerNameCustom || { Text: '文字', Image: '图片', Rectangle: '矩形', Ellipse: '椭圆' }[source.Key]} 副本`;
  copy.Left += 20;
  copy.Top += 20;
  result.Layers.splice(index, 0, copy);
  for (const group of result.DocModel.FormatConditionGroups) {
    if (group.EffctiveLayers.includes(source.Id)) group.EffctiveLayers.push(copy.Id);
    for (const condition of group.FormatConditionModels) {
      if (Object.hasOwn(condition.LayersVisable, source.Id)) {
        Object.defineProperty(condition.LayersVisable, copy.Id, {
          value: condition.LayersVisable[source.Id],
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    }
  }
  normalizeLayerOrder(result);
  return result;
}
