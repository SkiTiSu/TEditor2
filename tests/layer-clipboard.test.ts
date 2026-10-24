import { describe, expect, it } from 'vitest';
import { createDocument, createLayer } from '../src/core/document';
import { copyLayer, pasteLayer } from '../src/core/layerClipboard';

describe('layer clipboard snapshots', () => {
  for (const kind of ['Text', 'Image', 'Rectangle', 'Ellipse'] as const)
    it(`pastes an independent ${kind} with its original properties`, () => {
      const doc = createDocument();
      const layer = createLayer(kind);
      Object.assign(layer, { Left: 100, Top: 80, PageBackground: true, ClippingMaskEnable: true });
      doc.Layers.push(layer);
      const text = copyLayer(doc, layer.Id);
      layer.Left = 900;
      const pasted = pasteLayer(createDocument(), text)!;
      expect(pasted.document.Layers[0]).toMatchObject({
        Id: pasted.layerId,
        Key: kind,
        Left: 120,
        Top: 100,
        PageBackground: true,
        ClippingMaskEnable: true,
        Data: layer.Data,
      });
      expect(pasted.layerId).not.toBe(layer.Id);
      expect(pasteLayer(createDocument(), text)!.layerId).not.toBe(pasted.layerId);
    });
  it('remaps conditional visibility within and across documents without changing the source', () => {
    const doc = createDocument(),
      layer = createLayer('Text'),
      other = createLayer('Image');
    doc.Layers.push(layer, other);
    doc.DocModel.FormatConditionGroups.push({
      Name: 'VIP',
      Color: '#112233',
      EffctiveLayers: [layer.Id, other.Id],
      FormatConditionModels: [
        { Name: '默认', Condition: '', LayersVisable: { [layer.Id]: false, [other.Id]: true } },
        { Name: 'VIP', Condition: '[VIP]=1', LayersVisable: { [layer.Id]: true } },
      ],
    });
    const before = structuredClone(doc),
      text = copyLayer(doc, layer.Id);
    for (const target of [doc, createDocument()]) {
      const pasted = pasteLayer(target, text)!;
      const groups = pasted.document.DocModel.FormatConditionGroups.filter(
        (group) => group.Name === 'VIP',
      );
      expect(groups).toHaveLength(1);
      expect(groups[0].EffctiveLayers).toContain(pasted.layerId);
      expect(groups[0].FormatConditionModels.map((c) => c.LayersVisable[pasted.layerId])).toEqual([
        false,
        true,
      ]);
      if (target !== doc) expect(groups[0].EffctiveLayers).toEqual([pasted.layerId]);
    }
    expect(doc).toEqual(before);
  });
  it('ignores ordinary clipboard text and rejects corrupt or future layer payloads', () => {
    const doc = createDocument();
    expect(pasteLayer(doc, '普通文字')).toBeNull();
    expect(pasteLayer(doc, JSON.stringify({ hello: 'world' }))).toBeNull();
    expect(() =>
      pasteLayer(doc, JSON.stringify({ type: 'TEditor2/layer', version: 99 })),
    ).toThrow();
    expect(() =>
      pasteLayer(doc, JSON.stringify({ type: 'TEditor2/layer', version: 1, document: doc })),
    ).toThrow();
    expect(doc.Layers).toEqual([]);
  });
});
