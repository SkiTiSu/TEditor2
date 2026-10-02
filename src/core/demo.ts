import { createDocument, createLayer, normalizeLayerOrder } from './document';
import type { LayerKey, LayerModel, TableData, TedDocument } from './types';
export function createDemo(count = 12): { document: TedDocument; table: TableData; files: File[] } {
  const doc = createDocument();
  const layers: LayerModel[] = [];
  const add = (
    key: LayerKey,
    name: string,
    x: number,
    y: number,
    data: Record<string, unknown>,
  ) => {
    const layer = createLayer(key);
    Object.assign(layer, { LayerNameCustom: name, Left: x, Top: y });
    Object.assign(layer.Data, data);
    layers.push(layer);
    return layer;
  };
  add('Rectangle', '深海蓝背景', 0, 0, { Width: 1920, Height: 1080, FillColor: '#14263c' });
  add('Rectangle', '右侧色块', 1330, 0, { Width: 590, Height: 1080, FillColor: '#20394e' });
  add('Ellipse', '装饰圆环', 1410, -100, {
    Width: 740,
    Height: 740,
    FillColor: '#ffffff00',
    BorderColor: '#456273',
    BorderWidth: 2,
  });
  add('Ellipse', '装饰圆环 2', 1500, -10, {
    Width: 560,
    Height: 560,
    FillColor: '#ffffff00',
    BorderColor: '#456273',
    BorderWidth: 2,
  });
  add('Rectangle', '顶部分隔条', 104, 107, { Width: 60, Height: 6, FillColor: '#d7eb9c' });
  add('Text', '栏目名称', 192, 86, {
    Text: 'CREATOR SPOTLIGHT  /  创作者周刊',
    FontSize: 26,
    FontFamilyName: 'Arial',
    Color: '#d7eb9c',
    TextSpaceNumber: 1,
  });
  add('Text', '排名数字', 1305, 150, {
    Text: '01',
    FontSize: 216,
    FontWeight: 'Bold',
    FontFamilyName: 'Arial',
    Color: '#d7eb9c',
    VariableEnable: true,
    VariableTemplate: '{排名}',
    StrokeEnable: true,
    StrokeThickness: 1,
    StrokeColor: '#d7eb9c',
    StrokePosition: 1,
  });
  add('Text', '排名说明', 1337, 404, {
    Text: '本期精选',
    FontSize: 34,
    Color: '#c5d2dc',
    FontFamilyName: 'sans-serif',
  });
  add('Ellipse', '头像圆形蒙版', 110, 256, { Width: 200, Height: 200, FillColor: '#ffffff' });
  const avatar = add('Image', '变量头像', 110, 256, {
    Width: 200,
    Height: 200,
    ImageUrl: 'avatars/01.svg',
    VariableEnable: true,
    VariableImageUrl: 'avatars/{头像}.svg',
    EmbedImage: false,
  });
  avatar.ClippingMaskEnable = true;
  add('Text', '创作者名称', 350, 279, {
    Text: '林间来信',
    FontSize: 60,
    FontWeight: 'Bold',
    FontFamilyName: 'sans-serif',
    Color: '#ffffff',
    VariableEnable: true,
    VariableTemplate: '{名称}',
  });
  add('Text', '创作者分类', 352, 372, {
    Text: '影像 · 生活 · 灵感',
    FontSize: 28,
    FontFamilyName: 'sans-serif',
    Color: '#a5b7c7',
    VariableEnable: true,
    VariableTemplate: '{分类}',
  });
  add('Text', '作品标题', 110, 531, {
    Text: '把日常，拍成诗。',
    FontSize: 78,
    FontWeight: 'Bold',
    FontFamilyName: 'sans-serif',
    Color: '#ffffff',
    VariableEnable: true,
    VariableTemplate: '{标题}',
    TextBoxMode: true,
    Width: 1080,
    Height: 224,
    LineHeight: 100,
    ShadowEnable: true,
    ShadowDepth: 3,
    ShadowDirection: 315,
    ShadowBlurRadius: 12,
    ShadowOpacity: 0.25,
  });
  const badge = add('Rectangle', '高分标签底色', 1350, 658, {
    Width: 390,
    Height: 80,
    FillColor: '#d7eb9c',
    RadiusTopLeft: 40,
    RadiusTopRight: 40,
    RadiusBottomLeft: 40,
    RadiusBottomRight: 40,
  });
  const badgeText = add('Text', '高分标签文字', 1407, 675, {
    Text: 'EDITOR’S PICK',
    FontFamilyName: 'Arial',
    FontSize: 32,
    FontWeight: 'Bold',
    Color: '#14263c',
  });
  add('Rectangle', '底部分隔线', 110, 881, { Width: 1700, Height: 2, FillColor: '#ffffff30' });
  add('Text', '统计数据', 110, 932, {
    Text: '综合得分 98.6',
    FontFamilyName: 'sans-serif',
    FontSize: 29,
    Color: '#d7eb9c',
    VariableEnable: true,
    VariableTemplate: '综合得分  {得分}',
  });
  add('Text', '期号', 1810, 932, {
    Text: 'VOL. 042  /  2026',
    FontFamilyName: 'Arial',
    FontSize: 28,
    Color: '#a5b7c7',
    TextAlignment: 1,
  });
  doc.Layers = layers.reverse();
  normalizeLayerOrder(doc);
  doc.DocModel.FormatConditionGroups = [
    {
      Name: '高分推荐',
      Color: '#d7eb9c',
      EffctiveLayers: [badge.Id, badgeText.Id],
      FormatConditionModels: [
        {
          Name: '默认',
          Condition: '',
          LayersVisable: { [badge.Id]: false, [badgeText.Id]: false },
        },
        {
          Name: '推荐作品',
          Condition: '[得分] >= 95',
          LayersVisable: { [badge.Id]: true, [badgeText.Id]: true },
        },
      ],
    },
  ];
  const names = ['林间来信', '散步研究所', '一帧远方', '周末放映室'];
  const titles = [
    '把日常，拍成诗。',
    '在城市的缝隙里，\n发现新的风景。',
    '追着光，去远方。',
    '留一点时间，\n给喜欢的事。',
  ];
  const rows = Array.from({ length: count }, (_, i) => ({
    排名: String(i + 1).padStart(2, '0'),
    名称: names[i % 4],
    标题: titles[i % 4],
    分类: ['影像 · 生活 · 灵感', '城市 · 观察 · 记录', '旅行 · 自然 · 探索', '艺术 · 电影 · 日常'][
      i % 4
    ],
    得分: (98.6 - (i % 12) * 0.7).toFixed(1),
    头像: String((i % 4) + 1).padStart(2, '0'),
  }));
  const colors = ['#b7d0dc', '#e8bd9e', '#c6cea2', '#c4b3d6'];
  const files = colors.map((color, i) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240"><rect width="240" height="240" fill="${color}"/><circle cx="120" cy="92" r="45" fill="#fff4dc"/><ellipse cx="120" cy="222" rx="84" ry="79" fill="${['#4b6570', '#74584a', '#4d614d', '#5e5576'][i]}"/><path d="M75 90Q65 20 126 30Q180 35 165 94L145 73Q105 92 75 90" fill="#26384c"/><circle cx="104" cy="98" r="3" fill="#26384c"/><circle cx="138" cy="98" r="3" fill="#26384c"/><path d="M110 121Q123 130 135 118" fill="none" stroke="#a86d5c" stroke-width="3"/></svg>`;
    const f = new File([svg], `0${i + 1}.svg`, { type: 'image/svg+xml' });
    Object.defineProperty(f, 'webkitRelativePath', { value: `avatars/0${i + 1}.svg` });
    return f;
  });
  return { document: doc, table: { headers: Object.keys(rows[0]), rows }, files };
}
