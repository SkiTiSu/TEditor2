import type { DataRow, TableData, TedDocument, TextData, ImageData } from './types';
import { evaluateExpression } from './expression';

/** RFC 4180 CSV and Excel clipboard TSV; values stay strings, including 0001. */
export function parseTable(text: string, delimiter?: string): TableData {
  text = text.replace(/^\uFEFF/, '');
  if (!text.trim()) return { headers: [], rows: [] };
  if (delimiter && delimiter.length !== 1) throw new Error('分隔符必须是一个字符。');
  if (!delimiter) {
    const count: Record<string, number> = { '\t': 0, ',': 0, ';': 0 };
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '"') {
        if (quoted && text[i + 1] === '"') i++;
        else quoted = !quoted;
      } else if (!quoted) {
        if (c === '\r' || c === '\n') break;
        if (c in count) count[c]++;
      }
    }
    delimiter = count['\t'] > 0 ? '\t' : count[','] >= count[';'] ? ',' : ';';
  }
  const records: string[][] = [];
  let record: string[] = [],
    field = '',
    quoted = false,
    closed = false;
  const pushField = () => {
    record.push(field);
    field = '';
    closed = false;
  };
  const pushRow = () => {
    pushField();
    records.push(record);
    record = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += c;
    } else if (c === delimiter) pushField();
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      pushRow();
    } else if (c === '"') {
      // Clipboard TSV can contain literal quotes inside unquoted cells.
      // Quotes at the start of a cell still support Excel's escaped/multiline format.
      if (delimiter === '\t' && field && !closed) {
        field += c;
        continue;
      }
      if (field || closed) throw new Error(`第 ${records.length + 1} 行引号位置不正确。`);
      quoted = true;
    } else {
      if (closed) throw new Error(`第 ${records.length + 1} 行引号之后存在多余内容。`);
      field += c;
    }
  }
  if (quoted) throw new Error('表格存在未闭合的双引号。');
  if (field !== '' || record.length || closed) pushRow();
  while (records.length && records[records.length - 1].every((v) => v === '')) records.pop();
  if (!records.length) return { headers: [], rows: [] };
  const headers = records.shift()!.map((h) => h.trim());
  if (headers.some((h) => !h)) throw new Error('表头存在空列名，请为每一列填写名称。');
  if (new Set(headers).size !== headers.length)
    throw new Error('表头存在重复列名，请使用唯一的列名。');
  const rows = records.map((cells, i) => {
    if (cells.length > headers.length)
      throw new Error(`第 ${i + 2} 行有 ${cells.length} 列，超过表头的 ${headers.length} 列。`);
    return Object.fromEntries(headers.map((h, j) => [h, cells[j] ?? '']));
  });
  return { headers, rows };
}

/** index is the zero-based table row; the displayed placeholder is one-based. */
export function replaceVariables(template: string, row: DataRow, index?: number): string {
  return template.replace(/\{([^{}]+)\}/g, (match, key: string) => {
    if (key === 'index' && index !== undefined) return String(index + 1);
    return Object.prototype.hasOwnProperty.call(row, key) ? row[key] : match;
  });
}

export function resolveDocument(
  doc: TedDocument,
  row?: DataRow,
  selectedConditions: Record<number, number> = {},
): { document: TedDocument; warnings: string[]; matchedConditions: Record<number, number> } {
  const document = structuredClone(doc),
    warnings: string[] = [],
    matchedConditions: Record<number, number> = {};
  const replace = (template: string, label: string) => {
    const missing = [...template.matchAll(/\{([^{}]+)\}/g)]
      .map((m) => m[1])
      .filter((key) => !Object.prototype.hasOwnProperty.call(row!, key));
    if (missing.length)
      warnings.push(`${label}：数据中缺少列 ${[...new Set(missing)].join('、')}。`);
    return replaceVariables(template, row!);
  };
  if (row)
    for (const layer of document.Layers) {
      if (layer.Key === 'Text') {
        const d = layer.Data as TextData;
        if (d.VariableEnable && d.VariableTemplate.trim())
          d.Text = replace(d.VariableTemplate, layer.LayerNameCustom || '文字图层');
      }
      if (layer.Key === 'Image') {
        const d = layer.Data as ImageData;
        if (d.VariableEnable && d.VariableImageUrl) {
          d.ImageUrl = replace(d.VariableImageUrl, layer.LayerNameCustom || '图片图层');
          d.EmbedImage = false;
        }
      }
    }
  const layerMap = new Map(document.Layers.map((layer) => [layer.Id, layer]));
  document.DocModel.FormatConditionGroups.forEach((group, groupIndex) => {
    const conditions = group.FormatConditionModels;
    let matched = -1;
    if (
      Object.prototype.hasOwnProperty.call(selectedConditions, groupIndex) &&
      selectedConditions[groupIndex] >= 0
    ) {
      const manual = selectedConditions[groupIndex];
      if (Number.isInteger(manual) && manual < conditions.length) matched = manual;
      else warnings.push(`条件组“${group.Name}”的手动选择已失效。`);
    } else if (row) {
      for (let i = 0; i < conditions.length; i++) {
        const condition = conditions[i];
        if (condition.Name === '默认' || !condition.Condition.trim()) continue;
        try {
          if (evaluateExpression(condition.Condition, row)) {
            matched = i;
            break;
          }
        } catch (error) {
          warnings.push(
            `条件组“${group.Name}” / “${condition.Name}”：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    if (matched < 0) matched = conditions.findIndex((condition) => condition.Name === '默认');
    if (matched < 0) return;
    matchedConditions[groupIndex] = matched;
    const visibility = conditions[matched].LayersVisable;
    for (const id of group.EffctiveLayers) {
      const layer = layerMap.get(id);
      if (layer && Object.prototype.hasOwnProperty.call(visibility, id))
        layer.Visible = visibility[id];
    }
  });
  return { document, warnings: [...new Set(warnings)], matchedConditions };
}

export interface BatchPlan {
  indices: number[];
  start: number;
  end: number;
}
export function planBatch(total: number, start: number, end: number, repeats: number): BatchPlan[] {
  for (const [name, value] of Object.entries({
    数据行数: total,
    开始行: start,
    结束行: end,
    副本个数: repeats,
  }))
    if (!Number.isSafeInteger(value)) throw new Error(`${name}必须为整数。`);
  if (total < 0 || repeats < 0) throw new Error('数据行数和副本个数不能为负数。');
  if (total === 0) return [];
  if (start < 1 || start > total || end < start)
    throw new Error('导出范围无效，请检查开始行和结束行。');
  end = Math.min(total, end);
  const result: BatchPlan[] = [];
  for (let i = start; i <= end; i += repeats + 1) {
    const last = Math.min(i + repeats, end);
    result.push({
      start: i,
      end: last,
      indices: Array.from({ length: last - i + 1 }, (_, j) => i + j - 1),
    });
  }
  return result;
}

export function filenameForBatch(template: string, rows: DataRow[], indices: number[]): string {
  if (!indices.length) throw new Error('导出分组为空。');
  const first = indices[0],
    last = indices[indices.length - 1];
  const range = first === last ? String(first + 1) : `${first + 1}-${last + 1}`;
  let name = (template || '{index}').replace(/\{index\}/g, range);
  name = replaceVariables(name, rows[first] ?? {}).replace(/\.png$/i, '');
  name = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim();
  if (!name || /^\.+$/.test(name)) name = range;
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  return `${[...name].slice(0, 140).join('')}.png`;
}
