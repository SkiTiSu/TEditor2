import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/renderer-test', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Renderer test</title>',
    }),
  );
  await page.goto('/renderer-test');
});

test('renders Z order, independent rounded corners, alpha clipping and hidden mask bases', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const renderModule = '/src/core/render.ts';
    const { renderDocument } = await import(renderModule);
    const canvas = document.createElement('canvas');
    const rect = (id: string, z: number, color: string, extra = {}) => ({
      Id: id,
      Key: 'Rectangle',
      Left: 0,
      Top: 0,
      ZIndex: z,
      Visible: true,
      LayerNameCustom: id,
      ClippingMaskEnable: false,
      ClippingMaskBottom: false,
      Data: {
        Width: 100,
        Height: 100,
        FillColor: color,
        BorderColor: '#000',
        BorderWidth: 0,
        RadiusLink: false,
        RadiusTopLeft: 0,
        RadiusTopRight: 0,
        RadiusBottomRight: 0,
        RadiusBottomLeft: 0,
      },
      ...extra,
    });
    const doc = {
      VersionCode: 1,
      DocModel: { Width: 100, Height: 100, FormatConditionGroups: [] },
      Layers: [] as any[],
    };
    const pixel = (x: number, y: number) =>
      Array.from(canvas.getContext('2d')!.getImageData(x, y, 1, 1).data);
    const base = rect('base', 0, 'rgba(255,0,0,.5)');
    const green = rect('green', 1, '#00ff00', { ClippingMaskEnable: true });
    const blue = rect('blue', 2, '#0000ff', { ClippingMaskEnable: true });
    doc.Layers = [blue, base, green];
    await renderDocument(canvas, doc, async () => null);
    const clipped = pixel(50, 50);
    base.Visible = false;
    await renderDocument(canvas, doc, async () => null);
    const hiddenBase = pixel(50, 50);
    const round = rect('round', 0, '#ff0000');
    round.Data.RadiusTopLeft = 30;
    doc.Layers = [round];
    const rendered = await renderDocument(canvas, doc, async () => null);
    return {
      clipped,
      hiddenBase,
      rounded: pixel(0, 0),
      square: pixel(99, 99),
      bounds: rendered.bounds.round,
      width: canvas.width,
      height: canvas.height,
    };
  });
  // Every clipped sibling uses the original 50% base, not the preceding composite.
  expect(result.clipped[3]).toBeGreaterThanOrEqual(222);
  expect(result.clipped[3]).toBeLessThanOrEqual(225);
  expect(result.clipped[2]).toBeGreaterThan(result.clipped[1]);
  expect(result.hiddenBase[3]).toBe(0);
  expect(result.rounded[3]).toBe(0);
  expect(result.square).toEqual([255, 0, 0, 255]);
  expect(result.bounds).toEqual({ x: 0, y: 0, width: 100, height: 100 });
  expect([result.width, result.height]).toEqual([100, 100]);
});

test('image alpha supplies masks and composite rows use isolated masks and offsets', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const modulePath = '/src/core/render.ts';
    const { renderDocument, renderComposite } = await import(modulePath);
    const image = document.createElement('canvas');
    image.width = 20;
    image.height = 20;
    image.getContext('2d')!.fillRect(0, 0, 10, 20);
    const canvas = document.createElement('canvas');
    const doc = {
      VersionCode: 1,
      DocModel: { Width: 100, Height: 50, FormatConditionGroups: [] },
      Layers: [
        {
          Id: 'base',
          Key: 'Image',
          Left: 5,
          Top: 5,
          ZIndex: 0,
          Visible: true,
          ClippingMaskEnable: false,
          Data: { Width: 20, Height: 20, ImageUrl: 'alpha.png' },
        },
        {
          Id: 'clipped',
          Key: 'Rectangle',
          Left: 0,
          Top: 0,
          ZIndex: 1,
          Visible: true,
          ClippingMaskEnable: true,
          Data: { Width: 30, Height: 30, FillColor: '#ff0000' },
        },
      ],
    };
    const pixel = (x: number, y: number) =>
      Array.from(canvas.getContext('2d')!.getImageData(x, y, 1, 1).data);
    await renderDocument(canvas, doc, async () => image);
    const first = [pixel(7, 7), pixel(18, 7)];
    await renderComposite(canvas, [doc, doc], 30, 5, async () => image);
    return {
      first,
      copies: [pixel(7, 7), pixel(37, 12), pixel(48, 12)],
      size: [canvas.width, canvas.height],
    };
  });
  expect(result.first).toEqual([
    [255, 0, 0, 255],
    [0, 0, 0, 0],
  ]);
  expect(result.copies).toEqual([
    [255, 0, 0, 255],
    [255, 0, 0, 255],
    [0, 0, 0, 0],
  ]);
  expect(result.size).toEqual([100, 50]);
});

test('text anchors, inner/outer strokes, wrapping, ellipsis and transparent shadows', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const modulePath = '/src/core/render.ts';
    const { renderDocument, measureLayer } = await import(modulePath);
    const canvas = document.createElement('canvas');
    const data = {
      Text: 'MMMM',
      FontFamilyName: 'Arial',
      FontWeight: 'Bold',
      FontSize: 40,
      FontStyle: 'Normal',
      TextAlignment: 0,
      LineHeight: 0,
      TextSpaceNumber: 0,
      Color: '#ffffff',
      TextBoxMode: false,
      Width: 0,
      Height: 0,
      StrokeEnable: false,
      StrokePosition: 1,
      StrokeThickness: 4,
      StrokeColor: '#ff0000',
      ShadowEnable: false,
      ShadowDepth: 12,
      ShadowDirection: 0,
      ShadowColor: '#0000ff',
      ShadowOpacity: 1,
      ShadowBlurRadius: 0,
    };
    const layer = {
      Id: 'text',
      Key: 'Text',
      Left: 70,
      Top: 20,
      ZIndex: 0,
      Visible: true,
      Data: data,
    };
    const doc = {
      VersionCode: 1,
      DocModel: { Width: 300, Height: 140, FormatConditionGroups: [] },
      Layers: [layer],
    };
    const pixels = () =>
      Array.from(canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data);
    const countAlpha = (rgba: number[]) =>
      rgba.filter((value, index) => index % 4 === 3 && value > 50).length;
    const normalBounds = measureLayer(layer);
    await renderDocument(canvas, doc, async () => null);
    const base = pixels();
    data.StrokeEnable = true;
    data.StrokePosition = 2;
    await renderDocument(canvas, doc, async () => null);
    const inner = pixels();
    data.StrokePosition = 1;
    await renderDocument(canvas, doc, async () => null);
    const outer = pixels();
    data.StrokeEnable = false;
    data.ShadowEnable = true;
    await renderDocument(canvas, doc, async () => null);
    const shadow = pixels();
    data.ShadowEnable = false;
    data.TextAlignment = 1;
    const rightBounds = measureLayer(layer);
    data.TextAlignment = 2;
    const centerBounds = measureLayer(layer);
    data.TextAlignment = 0;
    data.Text = 'ABCDEFGHIJKLMN\n第二行文字';
    data.TextBoxMode = true;
    data.Width = 85;
    data.Height = 47;
    await renderDocument(canvas, doc, async () => null);
    const box = pixels();
    let outsideBox = 0;
    for (let y = 0; y < 140; y++)
      for (let x = 0; x < 300; x++)
        if ((x < 70 || x >= 155 || y < 20 || y >= 67) && box[(y * 300 + x) * 4 + 3]) outsideBox++;
    return {
      normalBounds,
      rightBounds,
      centerBounds,
      base: countAlpha(base),
      inner: countAlpha(inner),
      innerOutside: inner.filter(
        (value, index) => index % 4 === 3 && value > 0 && base[index] === 0,
      ).length,
      outer: countAlpha(outer),
      shadowBlue: shadow.filter(
        (value, index) => index % 4 === 2 && value > 0 && shadow[index - 2] === 0,
      ).length,
      outsideBox,
      box: countAlpha(box),
    };
  });
  expect(result.rightBounds.x).toBeCloseTo(70 - result.normalBounds.width);
  expect(result.centerBounds.x).toBeCloseTo(70 - result.normalBounds.width / 2);
  expect(result.innerOutside).toBe(0);
  expect(result.outer).toBeGreaterThan(result.base * 1.5);
  expect(result.shadowBlue).toBeGreaterThan(100);
  expect(result.outsideBox).toBe(0);
  expect(result.box).toBeGreaterThan(100);
});

test('an obsolete async image render cannot overwrite the latest edit', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const modulePath = '/src/core/render.ts';
    const { renderDocument } = await import(modulePath);
    const canvas = document.createElement('canvas');
    const source = document.createElement('canvas');
    source.width = source.height = 10;
    source.getContext('2d')!.fillStyle = '#ff0000';
    source.getContext('2d')!.fillRect(0, 0, 10, 10);
    let finish: (image: HTMLCanvasElement) => void = () => {};
    const delayed = new Promise<HTMLCanvasElement>((resolve) => {
      finish = resolve;
    });
    const oldDoc = {
      DocModel: { Width: 10, Height: 10 },
      Layers: [
        {
          Id: 'old',
          Key: 'Image',
          Left: 0,
          Top: 0,
          ZIndex: 0,
          Visible: true,
          Data: { Width: 10, Height: 10, ImageUrl: 'slow.png' },
        },
      ],
    };
    const newDoc = {
      DocModel: { Width: 10, Height: 10 },
      Layers: [
        {
          Id: 'new',
          Key: 'Rectangle',
          Left: 0,
          Top: 0,
          ZIndex: 0,
          Visible: true,
          Data: { Width: 10, Height: 10, FillColor: '#00ff00' },
        },
      ],
    };
    const oldJob = renderDocument(canvas, oldDoc, async () => delayed);
    await renderDocument(canvas, newDoc, async () => null);
    finish(source);
    await oldJob;
    return Array.from(canvas.getContext('2d')!.getImageData(5, 5, 1, 1).data);
  });
  expect(result).toEqual([0, 255, 0, 255]);
});
