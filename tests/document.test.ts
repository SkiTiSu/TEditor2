import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  cloneDocument,
  createDocument,
  createLayer,
  duplicateLayer,
  normalizeColor,
  normalizeDocument,
  normalizeLayerOrder,
  parseDocument,
  serializeDocument,
} from '../src/core/document';
import type { ImageData, ShapeData, TextData } from '../src/core/types';

function legacyFixture() {
  return {
    VersionCode: 0,
    DocModel: {
      Width: 1920,
      Height: 1080,
      CreatedAt: '2021-01-01T09:00:00+08:00',
      UpdatedAt: '2022-01-01T09:00:00+08:00',
      FormatConditionGroups: [
        {
          Name: '会员标记',
          Color: '#FFAA5511',
          EffctiveLayers: ['title', 'avatar'],
          FormatConditionModels: [
            { Name: '默认', Condition: null, LayersVisable: { title: true, avatar: false } },
            { Name: 'VIP', Condition: '等级="VIP"', LayersVisable: { title: false, avatar: true } },
          ],
        },
      ],
    },
    Layers: [
      {
        Id: 'background',
        Key: 'Rectangle',
        ZIndex: 10,
        Left: 0,
        Top: 0,
        Visible: true,
        Data: {
          Width: 1920,
          Height: 1080,
          FillColor: '#FFF9F5ED',
          BorderColor: '#00FFFFFF',
          BorderWidth: 2,
          RadiusTopLeft: 12,
          RadiusTopRight: 24,
          RadiusBottomRight: 48,
          RadiusBottomLeft: 96,
          RadiusLink: false,
        },
      },
      {
        Id: 'title',
        Key: 'Text',
        ZIndex: 30,
        Left: 100,
        Top: 80,
        Visible: true,
        LayerNameCustom: '标题',
        ClippingMaskEnable: true,
        ClippingMaskBottom: false,
        Data: {
          Text: '姓名',
          FontFamilyName: '微软雅黑',
          FontWeight: 'SemiBold',
          FontStyle: 'Italic',
          FontSize: 64,
          TextAlignment: 'Center',
          TextSpaceNumber: 2,
          TextBoxMode: true,
          Width: 800,
          Height: 180,
          LineHeight: 90,
          Color: '#80442211',
          StrokeEnable: true,
          StrokePosition: 'Inside',
          StrokeThickness: 4,
          StrokeColor: '#FFFFCC00',
          ShadowEnable: true,
          ShadowDepth: 8,
          ShadowDirection: 315,
          ShadowColor: '#FF000000',
          ShadowOpacity: 0.4,
          ShadowBlurRadius: 6,
          VariableEnable: true,
          VariableTemplate: '您好，{姓名}',
        },
      },
      {
        Id: 'avatar',
        Key: 'Image',
        ZIndex: 20,
        Left: 400,
        Top: 300,
        Visible: false,
        ClippingMaskBottom: true,
        Data: {
          ImageUrl: 'D:\\素材\\头像\\default.png',
          VariableEnable: true,
          VariableImageUrl: 'D:\\素材\\头像\\{编号}.png',
          EmbedImage: true,
          Image: 'iVBORw0KGgo=',
          Width: 256,
          Height: 256,
        },
      },
      {
        Id: 'ellipse',
        Key: 'Ellipse',
        ZIndex: 5,
        Data: { FillColor: 'Red', Width: 200, Height: 80 },
      },
    ],
  };
}

describe('legacy .ted compatibility', () => {
  it('loads the downloadable synthetic WPF fixture', () => {
    const text = readFileSync(
      new URL('../public/examples/legacy-all-features.ted', import.meta.url),
      'utf8',
    );
    const { document, warnings } = parseDocument(text);
    expect(warnings).toEqual([]);
    expect(new Set(document.Layers.map((layer) => layer.Key))).toEqual(
      new Set(['Text', 'Image', 'Ellipse', 'Rectangle']),
    );
    expect(document.Layers.find((layer) => layer.Key === 'Image')?.ClippingMaskEnable).toBe(true);
    expect(
      (document.Layers.find((layer) => layer.Key === 'Image')?.Data as ImageData).Image,
    ).toMatch(/^iVBORw0KGgo/);
    expect(parseDocument(serializeDocument(document)).document).toEqual(document);
  });

  it('imports all four layers, WPF values, misspelled condition fields, and stacking order', () => {
    const { document, warnings } = normalizeDocument(legacyFixture());
    expect(warnings).toEqual([]);
    expect(document.VersionCode).toBe(1);
    expect(document.Layers.map((layer) => layer.Id)).toEqual([
      'title',
      'avatar',
      'background',
      'ellipse',
    ]);
    expect(document.Layers.map((layer) => layer.ZIndex)).toEqual([3, 2, 1, 0]);
    expect(document.Layers[0]).toMatchObject({
      Left: 100,
      Top: 80,
      LayerNameCustom: '标题',
      Visible: true,
      ClippingMaskEnable: true,
      ClippingMaskBottom: false,
    });
    expect(document.Layers[0].Data).toMatchObject({
      FontWeight: '600',
      FontStyle: 'italic',
      TextAlignment: 2,
      StrokePosition: 2,
      Color: '#44221180',
      StrokeColor: '#ffcc00ff',
      VariableTemplate: '您好，{姓名}',
      LineHeight: 90,
      TextSpaceNumber: 2,
    });
    expect(document.Layers[1]).toMatchObject({ Visible: false, ClippingMaskBottom: true });
    expect(document.Layers[1].Data).toMatchObject({
      Image: 'iVBORw0KGgo=',
      EmbedImage: true,
      VariableImageUrl: 'D:\\素材\\头像\\{编号}.png',
    });
    expect(document.Layers[2].Data).toMatchObject({
      FillColor: '#f9f5edff',
      BorderColor: '#ffffff00',
      RadiusTopLeft: 12,
      RadiusBottomLeft: 96,
      RadiusLink: false,
    });
    expect(document.DocModel.FormatConditionGroups[0]).toMatchObject({
      Color: '#aa5511ff',
      EffctiveLayers: ['title', 'avatar'],
    });
    expect(document.DocModel.FormatConditionGroups[0].FormatConditionModels[0]).toEqual({
      Name: '默认',
      Condition: '',
      LayersVisable: { title: true, avatar: false },
    });
  });

  it('survives multiple saves without rotating an alpha channel a second time', () => {
    const first = normalizeDocument(legacyFixture()).document;
    const second = parseDocument(serializeDocument(first)).document;
    const third = parseDocument(serializeDocument(second)).document;
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect((third.Layers[0].Data as TextData).Color).toBe('#44221180');
  });

  it('reads a BOM and treats a missing version as WPF version 0', () => {
    const fixture = legacyFixture() as Partial<ReturnType<typeof legacyFixture>>;
    delete fixture.VersionCode;
    expect(
      (parseDocument(`\uFEFF${JSON.stringify(fixture)}`).document.Layers[0].Data as TextData).Color,
    ).toBe('#44221180');
  });

  it('repairs missing and duplicate IDs and reports dangling references', () => {
    const fixture = legacyFixture();
    fixture.Layers[2].Id = 'title';
    fixture.Layers[3].Id = '';
    const { document, warnings } = normalizeDocument(fixture);
    expect(new Set(document.Layers.map((layer) => layer.Id)).size).toBe(4);
    expect(warnings.some((warning) => warning.includes('重复图层 ID'))).toBe(true);
    expect(warnings.some((warning) => warning.includes('缺少图层 ID'))).toBe(true);
    expect(warnings.some((warning) => warning.includes('不存在的图层 avatar'))).toBe(true);
    expect(document.DocModel.FormatConditionGroups[0].EffctiveLayers).toEqual(['title']);
    expect(
      document.DocModel.FormatConditionGroups[0].FormatConditionModels[0].LayersVisable,
    ).toEqual({ title: true });
  });

  it('accepts numeric weights and enum values without changing old enum meaning', () => {
    const fixture = legacyFixture();
    Object.assign(fixture.Layers[1].Data, {
      FontWeight: 700,
      FontStyle: 'Oblique',
      TextAlignment: 1,
      StrokePosition: 0,
    });
    expect(normalizeDocument(fixture).document.Layers[0].Data).toMatchObject({
      FontWeight: '700',
      FontStyle: 'oblique',
      TextAlignment: 1,
      StrokePosition: 0,
    });
  });

  it('fills absent fields and retains explicit zero, false, and empty strings', () => {
    const input = {
      DocModel: {},
      Layers: [
        { Key: 'Text', Id: 'text', Data: { Text: '', Width: 0, Height: 0, StrokeEnable: false } },
      ],
    };
    const { document } = normalizeDocument(input);
    expect(document.DocModel).toMatchObject({ Width: 1920, Height: 1080 });
    expect(document.Layers[0]).toMatchObject({ Visible: true, Left: 0, Top: 0 });
    expect(document.Layers[0].Data).toMatchObject({
      Text: '',
      Width: 0,
      Height: 0,
      StrokeEnable: false,
      FontSize: 32,
      FontWeight: '400',
      StrokePosition: 1,
    });
    expect(document.DocModel.FormatConditionGroups[0].FormatConditionModels[0].Name).toBe('默认');
  });
});

describe('colors', () => {
  it.each([
    ['#FF112233', '#112233ff'],
    ['#80112233', '#11223380'],
    ['#00112233', '#11223300'],
    ['#ABC', '#aabbcc'],
    ['#8F00', '#ff000088'],
    ['#112233', '#112233'],
    [' Red ', 'red'],
    ['Transparent', 'transparent'],
    ['rgba(20, 30, 40, 0.5)', 'rgba(20, 30, 40, 0.5)'],
    ['sc#0.5,1,0,0', '#ff000080'],
  ])('converts %s into %s', (input, expected) => expect(normalizeColor(input)).toBe(expected));

  it('converts WPF channel objects', () => {
    expect(normalizeColor({ A: 128, R: 255, G: 64, B: 0 })).toBe('#ff400080');
  });

  it('retains CSS short alpha hex in a browser document', () => {
    const document = createDocument();
    document.Layers.push(createLayer('Rectangle'));
    (document.Layers[0].Data as ShapeData).FillColor = '#f008';
    expect((normalizeDocument(document).document.Layers[0].Data as ShapeData).FillColor).toBe(
      '#ff000088',
    );
  });

  it('rejects invalid colors rather than relying on canvas stale-fill behavior', () => {
    expect(() => normalizeColor('not-a-color')).toThrow('无法识别颜色');
    expect(() => normalizeColor('url(https://example.com/color)')).toThrow();
  });
});

describe('editing helpers', () => {
  it('creates independent documents and complete defaults for each layer type', () => {
    const a = createDocument();
    const b = createDocument(800, 600);
    a.DocModel.FormatConditionGroups[0].EffctiveLayers.push('x');
    expect(b.DocModel.FormatConditionGroups[0].EffctiveLayers).toEqual([]);
    expect(b.DocModel).toMatchObject({ Width: 800, Height: 600 });
    for (const key of ['Text', 'Image', 'Rectangle', 'Ellipse'] as const) {
      const one = createLayer(key),
        two = createLayer(key);
      expect(one.Id).not.toBe(two.Id);
      expect(one.Data).not.toBe(two.Data);
      expect(one.Visible).toBe(true);
      expect(Object.values(one.Data)).not.toContain(undefined);
    }
    expect((createLayer('Image').Data as ImageData).VariableImageUrl).toBe('');
  });

  it('duplicates adjacent above the original and retains independent condition membership', () => {
    const original = normalizeDocument(legacyFixture()).document;
    const snapshot = cloneDocument(original);
    const duplicate = duplicateLayer(original, 'title');
    expect(original).toEqual(snapshot);
    expect(duplicate.Layers).toHaveLength(5);
    expect(duplicate.Layers[1].Id).toBe('title');
    const copied = duplicate.Layers[0];
    expect(copied.Id).not.toBe('title');
    expect(copied.Left).toBe(120);
    expect(copied.Top).toBe(100);
    expect(copied.LayerNameCustom).toBe('标题 副本');
    expect(duplicate.DocModel.FormatConditionGroups[0].EffctiveLayers).toContain(copied.Id);
    expect(
      duplicate.DocModel.FormatConditionGroups[0].FormatConditionModels[0].LayersVisable[copied.Id],
    ).toBe(true);
    (copied.Data as TextData).Text = '独立';
    expect((duplicate.Layers[1].Data as TextData).Text).toBe('姓名');
    expect(duplicate.Layers.map((layer) => layer.ZIndex)).toEqual([4, 3, 2, 1, 0]);
  });

  it('normalizes ZIndex using the current array without undoing a user reorder', () => {
    const document = normalizeDocument(legacyFixture()).document;
    document.Layers.reverse();
    normalizeLayerOrder(document);
    expect(document.Layers.map((layer) => layer.Id)).toEqual([
      'ellipse',
      'background',
      'avatar',
      'title',
    ]);
    expect(
      parseDocument(serializeDocument(document)).document.Layers.map((layer) => layer.Id),
    ).toEqual(['ellipse', 'background', 'avatar', 'title']);
  });

  it('clones nested conditions and data as well as layer arrays', () => {
    const document = normalizeDocument(legacyFixture()).document;
    const clone = cloneDocument(document);
    clone.DocModel.FormatConditionGroups[0].FormatConditionModels[0].LayersVisable.title = false;
    (clone.Layers[0].Data as TextData).Text = 'changed';
    expect(
      document.DocModel.FormatConditionGroups[0].FormatConditionModels[0].LayersVisable.title,
    ).toBe(true);
    expect((document.Layers[0].Data as TextData).Text).toBe('姓名');
  });
});

describe('invalid document handling', () => {
  it.each([null, [], {}, { Layers: [] }, { DocModel: {}, Layers: {} }])(
    'rejects malformed document %j',
    (input) => {
      expect(() => normalizeDocument(input)).toThrow();
    },
  );

  it.each([
    [0, 1080],
    [-1, 1080],
    [Infinity, 1080],
    [1920, NaN],
    [32769, 100],
    [10000, 10000],
    [1920.5, 1080],
  ])('rejects unsafe canvas dimensions %s × %s', (width, height) => {
    expect(() => createDocument(width, height)).toThrow();
  });

  it('supports normal 4K documents and the stated 1080p workload', () => {
    expect(createDocument(3840, 2160).DocModel.Width).toBe(3840);
    expect(createDocument(1920, 1080).DocModel.Height).toBe(1080);
  });

  it('rejects an unknown layer or version without silently dropping data', () => {
    expect(() => normalizeDocument({ DocModel: {}, Layers: [{ Key: 'Video', Id: 'v' }] })).toThrow(
      '不支持的类型',
    );
    expect(() => normalizeDocument({ VersionCode: 99, DocModel: {}, Layers: [] })).toThrow(
      '暂不支持',
    );
    expect(() => parseDocument('{broken')).toThrow('有效的 JSON');
  });

  it('rejects invalid property values and missing duplication targets', () => {
    expect(() =>
      normalizeDocument({
        DocModel: {},
        Layers: [{ Key: 'Text', Id: 't', Data: { FontSize: 'oops' } }],
      }),
    ).toThrow('FontSize');
    expect(() =>
      normalizeDocument({
        DocModel: {},
        Layers: [{ Key: 'Text', Id: 't', Data: { FontWeight: 'constructor' } }],
      }),
    ).toThrow();
    expect(() => duplicateLayer(createDocument(), 'missing')).toThrow('找不到');
  });

  it('treats prototype-like IDs as data without polluting objects', () => {
    const input = JSON.parse(
      '{"DocModel":{"FormatConditionGroups":[{"EffctiveLayers":["__proto__"],"FormatConditionModels":[{"Name":"默认","LayersVisable":{"__proto__":false}}]}]},"Layers":[{"Key":"Text","Id":"__proto__"}]}',
    );
    const { document } = normalizeDocument(input);
    expect(
      Object.hasOwn(
        document.DocModel.FormatConditionGroups[0].FormatConditionModels[0].LayersVisable,
        '__proto__',
      ),
    ).toBe(true);
    expect(
      document.DocModel.FormatConditionGroups[0].FormatConditionModels[0].LayersVisable.__proto__,
    ).toBe(false);
    expect(Object.getPrototypeOf(document)).toBe(Object.prototype);
  });
});
