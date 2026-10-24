import { cloneDocument, normalizeDocument, normalizeLayerOrder } from './document';
import type { ConditionGroup, TedDocument } from './types';

const FORMAT = 'TEditor2/layer';
export const LAYER_CLIPBOARD_MIME = 'application/x-teditor-layer';

/** A portable snapshot, including only the selected layer's condition bindings. */
export function copyLayer(document: TedDocument, layerId: string): string {
  const snapshot = cloneDocument(document);
  const layer = snapshot.Layers.find((item) => item.Id === layerId);
  if (!layer) throw new Error('请先选择要复制的图层');
  snapshot.Layers = [layer];
  snapshot.DocModel.FormatConditionGroups = snapshot.DocModel.FormatConditionGroups.filter(
    (group) => group.EffctiveLayers.includes(layerId),
  ).map((group) => ({
    ...group,
    EffctiveLayers: [layerId],
    FormatConditionModels: group.FormatConditionModels.map((condition) => ({
      ...condition,
      LayersVisable: Object.hasOwn(condition.LayersVisable, layerId)
        ? { [layerId]: condition.LayersVisable[layerId] }
        : {},
    })),
  }));
  return JSON.stringify({ type: FORMAT, version: 1, document: snapshot });
}

function groupSignature(group: ConditionGroup) {
  return JSON.stringify({
    name: group.Name,
    color: group.Color,
    conditions: group.FormatConditionModels.map(({ Name, Condition }) => ({ Name, Condition })),
  });
}

/** Ordinary clipboard text is ignored; recognized but corrupt layer data is rejected atomically. */
export function pasteLayer(document: TedDocument, text: string, selectedId?: string | null) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (data?.type !== FORMAT) return null;
  if (data.version !== 1) throw new Error('不支持此版本的图层剪贴板');
  const snapshot = normalizeDocument(data.document).document;
  if (snapshot.Layers.length !== 1) throw new Error('剪贴板必须包含一个有效图层');
  const result = cloneDocument(document);
  const layer = snapshot.Layers[0];
  const oldId = layer.Id;
  layer.Id = crypto.randomUUID();
  layer.Left += 20;
  layer.Top += 20;
  layer.LayerNameCustom = `${layer.LayerNameCustom} 副本`;
  const index = result.Layers.findIndex((item) => item.Id === selectedId);
  result.Layers.splice(Math.max(0, index), 0, layer);
  for (const source of snapshot.DocModel.FormatConditionGroups) {
    let group = result.DocModel.FormatConditionGroups.find(
      (item) => groupSignature(item) === groupSignature(source),
    );
    if (!group) {
      group = {
        ...source,
        EffctiveLayers: [],
        FormatConditionModels: source.FormatConditionModels.map((condition) => ({
          ...condition,
          LayersVisable: {},
        })),
      };
      result.DocModel.FormatConditionGroups.push(group);
    }
    group.EffctiveLayers.push(layer.Id);
    source.FormatConditionModels.forEach((condition, i) => {
      if (Object.hasOwn(condition.LayersVisable, oldId))
        group.FormatConditionModels[i].LayersVisable[layer.Id] = condition.LayersVisable[oldId];
    });
  }
  normalizeLayerOrder(result);
  return { document: result, layerId: layer.Id };
}
