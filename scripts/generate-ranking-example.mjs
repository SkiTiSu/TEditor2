import { writeFile } from 'node:fs/promises';
import {
  createDocument,
  createLayer,
  normalizeLayerOrder,
  serializeDocument,
} from '../src/core/document.ts';

// Run with: node --experimental-strip-types scripts/generate-ranking-example.mjs
const doc = createDocument(1920, 1080);
const layers = [];
function add(key, name, x, y, data) {
  const layer = createLayer(key);
  Object.assign(layer, { LayerNameCustom: name, Left: x, Top: y });
  Object.assign(layer.Data, data);
  layers.unshift(layer);
  return layer;
}
const purple = '#a38aef';
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><defs><linearGradient id="g" x2="0" y2="1"><stop stop-color="#eee9fc"/><stop offset="1" stop-color="#bdb0f5"/></linearGradient></defs><path fill="url(#g)" d="M0 0h1920v1080H0z"/></svg>';
add('Image', '整页紫色渐变背景', 0, 0, {
  Width: 1920,
  Height: 1080,
  EmbedImage: true,
  Image: 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'),
}).PageBackground = true;
function pill(name, x, y, width, height, fill, border = 0) {
  return add('Rectangle', name, x, y, {
    Width: width,
    Height: height,
    FillColor: fill,
    BorderColor: '#a79abd',
    BorderWidth: border,
    RadiusTopLeft: height / 2,
    RadiusTopRight: height / 2,
    RadiusBottomRight: height / 2,
    RadiusBottomLeft: height / 2,
  });
}
function text(name, x, y, value, size, color, extra = {}) {
  return add('Text', name, x, y, {
    Text: value,
    FontFamilyName: 'sans-serif',
    FontSize: size,
    FontWeight: '600',
    Color: color,
    VariableEnable: value.includes('{'),
    VariableTemplate: value,
    ...extra,
  });
}
pill('每条榜单白底（参与重复）', 70, 55, 1780, 190, '#ffffff', 5);
pill('分数底色', 116, 191, 208, 39, purple);
pill('排名变化底色', 1416, 78, 360, 95, '#eae3fc');
add('Rectangle', '排名信息分隔线', 1594, 90, { Width: 4, Height: 69, FillColor: '#ffffff' });
text('本期排名', 149, 74, '{排名}', 98, purple, { FontWeight: '800' });
text('分数', 127, 192, '{分数} Pt.', 27, '#ffffff');
text('作品名称', 354, 110, '{名称}', 43, '#16141b', { TextBoxMode: true, Width: 1020, Height: 62 });
text('详细指标', 354, 197, '{指标}', 22, '#b4a0f3', { TextBoxMode: true, Width: 1420, Height: 34 });
text('原始排名标签', 1459, 90, '原始排名', 24, purple);
text('排名变化标签', 1626, 90, '排名变化', 24, purple);
text('原始排名', 1504, 123, '{原始排名}', 30, purple);
text('排名变化', 1648, 123, '{变化}', 30, purple);
doc.Layers = layers;
normalizeLayerOrder(doc);
const rows = [
  [
    '31',
    '111440',
    '【原创音乐】星光落在窗边',
    '26',
    '-5',
    'Rate. +43.35%    播放 0021811    点赞 0004556    硬币 0000995    收藏 0003074',
  ],
  [
    '32',
    '110462',
    '【原创曲】把四季写进歌里',
    '13',
    '-19',
    'Rate. -41.34%    播放 0012410    点赞 0003459    硬币 0001758    收藏 0002327',
  ],
  [
    '33',
    '106236',
    '【双人合唱】晚风与回声',
    '61',
    '+28',
    'Rate. +28.80%    播放 0042090    点赞 0002837    硬币 0000667    收藏 0002375',
  ],
  [
    '34',
    '105333',
    '【原创音乐】下一站晴天',
    '48',
    '+14',
    'Rate. +217.78%    播放 0048177    点赞 0001702    硬币 0000822    收藏 0001826',
  ],
  [
    '35',
    '103280',
    '【钢琴演奏】一封未寄出的信',
    '40',
    '+5',
    'Rate. +18.60%    播放 0036502    点赞 0001603    硬币 0000723    收藏 0001524',
  ],
];
const csv = [['排名', '分数', '名称', '原始排名', '变化', '指标'], ...rows]
  .map((row) => row.map((cell) => '"' + cell.replaceAll('"', '""') + '"').join(','))
  .join('\r\n');
await writeFile(
  new URL('../public/examples/secondary-ranking.ted', import.meta.url),
  serializeDocument(doc),
);
await writeFile(
  new URL('../public/examples/secondary-ranking.csv', import.meta.url),
  '\uFEFF' + csv,
);
