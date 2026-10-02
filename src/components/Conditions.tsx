import { cloneDocument } from '../core/document';
import type { ConditionGroup, TedDocument } from '../core/types';

export interface ConditionsProps {
  document: TedDocument;
  selectedConditions: Record<number, number>;
  matchedConditions: Record<number, number>;
  onChange: (document: TedDocument, label: string) => void;
  onSelect: (selected: Record<number, number>) => void;
}

export function Conditions({
  document,
  selectedConditions,
  matchedConditions,
  onChange,
  onSelect,
}: ConditionsProps) {
  const groups = document.DocModel.FormatConditionGroups;
  const edit = (groupIndex: number, label: string, change: (group: ConditionGroup) => void) => {
    const next = cloneDocument(document);
    change(next.DocModel.FormatConditionGroups[groupIndex]);
    onChange(next, label);
  };
  const select = (groupIndex: number, value: number) => {
    const next = { ...selectedConditions };
    if (value < 0) delete next[groupIndex];
    else next[groupIndex] = value;
    onSelect(next);
  };
  const removeGroup = (groupIndex: number) => {
    const next = cloneDocument(document);
    next.DocModel.FormatConditionGroups.splice(groupIndex, 1);
    const selection: Record<number, number> = {};
    for (const [key, value] of Object.entries(selectedConditions)) {
      const index = Number(key);
      if (index !== groupIndex) selection[index > groupIndex ? index - 1 : index] = value;
    }
    onChange(next, '删除条件组');
    onSelect(selection);
  };
  const removeCondition = (groupIndex: number, conditionIndex: number) => {
    edit(groupIndex, '删除条件', (group) => group.FormatConditionModels.splice(conditionIndex, 1));
    const current = selectedConditions[groupIndex];
    if (current !== undefined && current >= conditionIndex)
      select(groupIndex, current === conditionIndex ? -1 : current - 1);
  };
  const moveCondition = (groupIndex: number, conditionIndex: number, direction: number) => {
    const target = conditionIndex + direction;
    edit(groupIndex, '调整条件优先级', (group) => {
      const [condition] = group.FormatConditionModels.splice(conditionIndex, 1);
      group.FormatConditionModels.splice(target, 0, condition);
    });
    const current = selectedConditions[groupIndex];
    if (current === conditionIndex) select(groupIndex, target);
    else if (current === target) select(groupIndex, conditionIndex);
  };

  return (
    <div className="conditions-panel">
      <div className="section-label">条件与显示</div>
      <p className="hint">
        按顺序使用首个满足表达式的条件，否则使用“默认”。多个条件组控制同一图层时，后面的组优先。
      </p>
      {groups.map((group, groupIndex) => {
        const active = selectedConditions[groupIndex] ?? matchedConditions[groupIndex];
        const activeName = group.FormatConditionModels[active]?.Name ?? '默认';
        const label = `条件组 ${groupIndex + 1}`;
        return (
          <section
            className="condition-group"
            key={groupIndex}
            style={{ borderLeft: `3px solid ${group.Color}`, paddingLeft: 10, marginBottom: 20 }}
          >
            <div className="field-grid">
              <label className="field">
                条件组名称
                <input
                  aria-label={`${label}名称`}
                  value={group.Name}
                  onChange={(event) =>
                    edit(groupIndex, '修改条件组名称', (target) => {
                      target.Name = event.target.value;
                    })
                  }
                />
              </label>
              <label className="field">
                标记颜色
                <input
                  aria-label={`${label}颜色`}
                  value={group.Color}
                  onChange={(event) =>
                    edit(groupIndex, '修改条件组颜色', (target) => {
                      target.Color = event.target.value;
                    })
                  }
                  placeholder="#6c77ed"
                />
              </label>
            </div>
            <label className="field">
              当前预览条件
              <select
                aria-label={`${label}预览条件`}
                value={selectedConditions[groupIndex] ?? -1}
                onChange={(event) => select(groupIndex, Number(event.target.value))}
              >
                <option value={-1}>自动匹配（{activeName}）</option>
                {group.FormatConditionModels.map((condition, index) => (
                  <option key={index} value={index}>
                    手动：{condition.Name || `条件 ${index + 1}`}
                  </option>
                ))}
              </select>
            </label>
            <details className="condition-members" open>
              <summary>受控图层 · {group.EffctiveLayers.length}</summary>
              {document.Layers.length === 0 && (
                <p className="hint">添加图层后，可在这里选择此组控制的图层。</p>
              )}
              {document.Layers.map((layer, index) => {
                const name =
                  layer.LayerNameCustom ||
                  `${{ Text: '文字', Image: '图片', Rectangle: '矩形', Ellipse: '椭圆' }[layer.Key]} ${index + 1}`;
                return (
                  <label className="toggle" key={layer.Id}>
                    <input
                      type="checkbox"
                      aria-label={`${label}控制图层 ${name}`}
                      checked={group.EffctiveLayers.includes(layer.Id)}
                      onChange={(event) =>
                        edit(groupIndex, '修改条件受控图层', (target) => {
                          if (event.target.checked) {
                            target.EffctiveLayers.push(layer.Id);
                            for (const condition of target.FormatConditionModels)
                              condition.LayersVisable = {
                                ...condition.LayersVisable,
                                [layer.Id]: layer.Visible,
                              };
                          } else {
                            target.EffctiveLayers = target.EffctiveLayers.filter(
                              (id) => id !== layer.Id,
                            );
                            for (const condition of target.FormatConditionModels)
                              delete condition.LayersVisable[layer.Id];
                          }
                        })
                      }
                    />
                    {name}
                  </label>
                );
              })}
            </details>
            {group.FormatConditionModels.map((condition, conditionIndex) => {
              const isDefault = condition.Name === '默认';
              const conditionLabel = `${label}条件 ${conditionIndex + 1}`;
              return (
                <details
                  className="condition-rule"
                  key={conditionIndex}
                  open={conditionIndex === active}
                  style={{ marginTop: 10 }}
                >
                  <summary>
                    {condition.Name || `条件 ${conditionIndex + 1}`}
                    {conditionIndex === active ? ' · 当前' : ''}
                  </summary>
                  <label className="field">
                    条件名称
                    <input
                      aria-label={`${conditionLabel}名称`}
                      value={condition.Name}
                      disabled={isDefault}
                      onChange={(event) => {
                        if (event.target.value === '默认') return;
                        edit(groupIndex, '修改条件名称', (target) => {
                          target.FormatConditionModels[conditionIndex].Name = event.target.value;
                        });
                      }}
                    />
                  </label>
                  {!isDefault && (
                    <label className="field">
                      匹配表达式
                      <textarea
                        aria-label={`${conditionLabel}表达式`}
                        rows={2}
                        value={condition.Condition}
                        placeholder={'例如：等级 = "VIP" 或 金额 >= 100'}
                        onChange={(event) =>
                          edit(groupIndex, '修改条件表达式', (target) => {
                            target.FormatConditionModels[conditionIndex].Condition =
                              event.target.value;
                          })
                        }
                      />
                    </label>
                  )}
                  {isDefault && <p className="hint">所有表达式均不匹配时使用此条件。</p>}
                  {group.EffctiveLayers.map((layerId) => {
                    const layerIndex = document.Layers.findIndex((layer) => layer.Id === layerId);
                    const layer = document.Layers[layerIndex];
                    if (!layer) return null;
                    const name =
                      layer.LayerNameCustom ||
                      `${{ Text: '文字', Image: '图片', Rectangle: '矩形', Ellipse: '椭圆' }[layer.Key]} ${layerIndex + 1}`;
                    return (
                      <label className="toggle" key={layerId}>
                        <input
                          type="checkbox"
                          aria-label={`${conditionLabel}显示 ${name}`}
                          checked={condition.LayersVisable[layerId] ?? layer.Visible}
                          onChange={(event) =>
                            edit(groupIndex, '修改条件图层可见性', (target) => {
                              const selected = target.FormatConditionModels[conditionIndex];
                              selected.LayersVisable = {
                                ...selected.LayersVisable,
                                [layerId]: event.target.checked,
                              };
                            })
                          }
                        />
                        显示 {name}
                      </label>
                    );
                  })}
                  {!group.EffctiveLayers.length && (
                    <p className="hint">先选择受控图层，再设置这个条件下的显示状态。</p>
                  )}
                  {!isDefault && (
                    <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                      <button
                        className="secondary"
                        aria-label={`${conditionLabel}上移`}
                        disabled={
                          conditionIndex === 0 ||
                          group.FormatConditionModels[conditionIndex - 1]?.Name === '默认'
                        }
                        onClick={() => moveCondition(groupIndex, conditionIndex, -1)}
                      >
                        上移
                      </button>
                      <button
                        className="secondary"
                        aria-label={`${conditionLabel}下移`}
                        disabled={
                          conditionIndex === group.FormatConditionModels.length - 1 ||
                          group.FormatConditionModels[conditionIndex + 1]?.Name === '默认'
                        }
                        onClick={() => moveCondition(groupIndex, conditionIndex, 1)}
                      >
                        下移
                      </button>
                      <button
                        className="danger"
                        aria-label={`删除${conditionLabel}`}
                        onClick={() => removeCondition(groupIndex, conditionIndex)}
                      >
                        删除条件
                      </button>
                    </div>
                  )}
                </details>
              );
            })}
            <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
              <button
                className="secondary"
                aria-label={`${label}添加条件`}
                onClick={() =>
                  edit(groupIndex, '添加条件', (target) => {
                    const names = new Set(
                      target.FormatConditionModels.map((condition) => condition.Name),
                    );
                    let n = 1;
                    while (names.has(`条件 ${n}`)) n++;
                    const fallback = target.FormatConditionModels.find(
                      (condition) => condition.Name === '默认',
                    );
                    target.FormatConditionModels.push({
                      Name: `条件 ${n}`,
                      Condition: '',
                      LayersVisable: Object.fromEntries(
                        target.EffctiveLayers.map((layerId) => [
                          layerId,
                          fallback?.LayersVisable[layerId] ??
                            document.Layers.find((layer) => layer.Id === layerId)?.Visible ??
                            true,
                        ]),
                      ),
                    });
                  })
                }
              >
                ＋ 添加条件
              </button>
              <button
                className="danger"
                aria-label={`删除${label}`}
                onClick={() => removeGroup(groupIndex)}
              >
                删除条件组
              </button>
            </div>
          </section>
        );
      })}
      <button
        className="secondary"
        onClick={() => {
          const next = cloneDocument(document);
          next.DocModel.FormatConditionGroups.push({
            Name: `条件组 ${groups.length + 1}`,
            Color: ['#6c77ed', '#219582', '#d58c37', '#b45c9c'][groups.length % 4],
            EffctiveLayers: [],
            FormatConditionModels: [{ Name: '默认', Condition: '', LayersVisable: {} }],
          });
          onChange(next, '添加条件组');
        }}
      >
        ＋ 添加条件组
      </button>
    </div>
  );
}

export default Conditions;
