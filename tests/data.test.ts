import { describe, it, expect } from 'vitest';
import {
  parseTable,
  replaceVariables,
  resolveDocument,
  planBatch,
  filenameForBatch,
} from '../src/core/data';
import { evaluateExpression } from '../src/core/expression';
import { createDocument, createLayer } from '../src/core/document';
import type { ImageData, TextData } from '../src/core/types';
import golden from '../src/vendor/toolgood/v2-regression-fixtures.json';

describe('local table import', () => {
  it('reads BOM CSV, escaped quotes, multiline text and leading zero identifiers', () => {
    const table = parseTable(
      '\uFEFF编号,姓名,备注\r\n0001,"李,明","他说""你好""\r\n第二行"\r\n0002,王芳,\r\n',
    );
    expect(table).toEqual({
      headers: ['编号', '姓名', '备注'],
      rows: [
        { 编号: '0001', 姓名: '李,明', 备注: '他说"你好"\r\n第二行' },
        { 编号: '0002', 姓名: '王芳', 备注: '' },
      ],
    });
  });
  it('accepts spreadsheet TSV with commas and fills missing cells', () => {
    expect(parseTable('编号\t说明\t值\n01\ta,b\n02\t"多\n行"\t0').rows).toEqual([
      { 编号: '01', 说明: 'a,b', 值: '' },
      { 编号: '02', 说明: '多\n行', 值: '0' },
    ]);
  });
  it.each([undefined, '\t'])('preserves literal quotes in clipboard TSV (%s)', (delimiter) => {
    const table = parseTable(
      '原排名\t曲名\t播放\r\n4\t【星尘原创】"伟大的浪漫主义"\t0092841\r\n8\t未配对的"引号\t0250816',
      delimiter,
    );
    expect(table.rows).toEqual([
      { 原排名: '4', 曲名: '【星尘原创】"伟大的浪漫主义"', 播放: '0092841' },
      { 原排名: '8', 曲名: '未配对的"引号', 播放: '0250816' },
    ]);
  });
  it('still decodes quoted TSV cells with escaped quotes, tabs and newlines', () => {
    expect(
      parseTable('曲名\t播放\n"【星尘原创】""伟大的浪漫主义""\t现场\n版"\t0092841').rows,
    ).toEqual([{ 曲名: '【星尘原创】"伟大的浪漫主义"\t现场\n版', 播放: '0092841' }]);
  });
  it.each([
    'a,b\ntext"quote,1',
    'a;b\ntext"quote;1',
    'a\tb\n"closed""""\t1',
    'a\tb\n"unfinished\t1',
  ])('retains strict CSV and quoted TSV validation: %s', (text) =>
    expect(() => parseTable(text)).toThrow(),
  );
  it('supports explicit and autodetected semicolons', () => {
    expect(parseTable('a;b\n1;2').rows).toEqual([{ a: '1', b: '2' }]);
    expect(parseTable('a|b\n1|2', '|').rows).toEqual([{ a: '1', b: '2' }]);
  });
  it.each(['a,a\n1,2', 'a,\n1,2', 'a\n1,2', 'a\n"unfinished', 'a\n"closed"extra'])(
    'rejects malformed tables: %s',
    (text) => expect(() => parseTable(text)).toThrow(),
  );
  it('retains interior empty rows and safely handles prototype-like column names', () => {
    expect(parseTable('a,b\n1,2\n,\n3,4').rows).toHaveLength(3);
    const row = parseTable('__proto__,constructor\na,b').rows[0];
    expect(Object.hasOwn(row, '__proto__')).toBe(true);
    expect(row.__proto__).toBe('a');
  });
  it('empty input yields no rows', () =>
    expect(parseTable(' \n')).toEqual({ headers: [], rows: [] }));
});

describe('ToolGood-compatible condition evaluation', () => {
  const row = {
    姓名: '张三',
    分数: '090',
    等级: 'VIP',
    日期: '2024-02-28',
    空值: '',
    金额: '1.5',
    AND: 'yes',
    编号: '001',
    '中文 列': '是',
  };
  it.each([
    '[分数]>=80 AND [等级]="VIP"',
    '#分数#>=80 && @等级="VIP"',
    '〖分数〗>=80 OR FALSE()',
    '["中文 列"]="是"',
    '[AND]="yes"',
    'IF(分数>=80,TRUE(),FALSE())',
    'IF(3,TRUE(),FALSE())',
    'AND(3,2)',
    'INT(-9.222)=-9',
    'TEXT(DATE(2024,2,29),"yyyy年MM月dd日")="2024年02月29日"',
    'TEXT(1234.5,"N2")="1,234.50"',
    'TEXT("0001","N2")="0001"',
    'ABS(TDIST(1.2,24,1)-0.120925677)<0.00000001',
    'ABS(BETADIST(0.5,2,3)-0.6875)<0.000000001',
    'AND(分数>60,NOT(等级="普通"))',
    'NOT FALSE',
    'IF（分数>=80，TRUE（），FALSE（））',
    'SUM({1,2,3})=6',
    'COUNT({1,2,3})=3',
    'LEFT(姓名,1)="张"',
    '姓名.StartsWith("张")',
    'LEN(姓名)=2 AND MID("ABCDEF",2,3)="BCD"',
    'ISNULLOREMPTY(空值)',
    'ISNUMBER(编号) AND 编号=1',
    'ROUND(金额*2,0)=3',
    '0.1+0.2=0.3',
    '0.0000000000001=0',
    '"2">10',
    'DATE(2024,2,28)+1=DATE(2024,2,29)',
    '[日期]+2=DATE(2024,3,1)',
    'HOUR("2016-1-1"+9*"1:0")=9',
    'DATE(2024,3,1)-1=DATE(2024,2,29)',
    'ISREGEX(姓名,"^张")',
    'REGEXREPALCE("abc","a","z")="zbc"',
    'JSON("{\\"name\\":\\"张三\\"}")[name]="张三"',
    'ISERROR(1/0)',
    'IFERROR(1/0,TRUE())',
    'MD5("abc")="900150983CD24FB0D6963F7D28E17F72"',
  ])('evaluates %s', (formula) => expect(evaluateExpression(formula, row)).toBe(true));
  it.each(['分数<80', 'FALSE()', '0', '等级<>"VIP"', 'NOT(分数>80)', '"2"<10', '0.000000000001=0'])(
    'returns false for %s',
    (formula) => expect(evaluateExpression(formula, row)).toBe(false),
  );
  it('preserves literal strings containing old grammar characters', () => {
    expect(evaluateExpression('"[姓名] AND @等级 {1,2}"="[姓名] AND @等级 {1,2}"', row)).toBe(true);
  });
  it('isolates cached formulas from row values', () => {
    expect(evaluateExpression('[分数]>80', { 分数: '90' })).toBe(true);
    expect(evaluateExpression('[分数]>80', { 分数: '20' })).toBe(false);
  });
  it('never executes JavaScript and reports invalid syntax, unknown columns and errors', () => {
    expect(() => evaluateExpression('globalThis.alert("hello")', row)).toThrow('条件公式错误');
    expect(() => evaluateExpression('[不存在]>0', row)).toThrow('不存在');
    expect(() => evaluateExpression('1/0', row)).toThrow('零');
    expect(() => evaluateExpression('1>=', row)).toThrow('条件公式错误');
    expect(() => evaluateExpression('"abc"', row)).toThrow('逻辑值');
    expect(() => evaluateExpression(' '.repeat(9000) + 'true', row)).toThrow('过长');
  });
});

describe('official ToolGood 2.2.0.2 regression examples', () => {
  it.each(golden)('$source: $formula', ({ formula, expected, ...fixture }) => {
    expect(evaluateExpression(`(${formula})=${JSON.stringify(expected)}`, fixture.row ?? {})).toBe(
      true,
    );
  });
});

function fixture() {
  const doc = createDocument();
  const text = createLayer('Text'),
    image = createLayer('Image'),
    shape = createLayer('Rectangle');
  text.Id = 'text';
  image.Id = 'image';
  shape.Id = 'shape';
  Object.assign(text.Data, {
    Text: '模板',
    VariableEnable: true,
    VariableTemplate: '{姓名} · {编号}',
  });
  Object.assign(image.Data, {
    ImageUrl: 'default.png',
    VariableEnable: true,
    VariableImageUrl: '头像/{编号}.png',
    EmbedImage: true,
    Image: 'abc',
  });
  image.Visible = false;
  doc.Layers = [text, image, shape];
  doc.DocModel.FormatConditionGroups = [
    {
      Name: '等级',
      Color: '#123456',
      EffctiveLayers: ['image'],
      FormatConditionModels: [
        { Name: '默认', Condition: '', LayersVisable: { image: false, text: false } },
        { Name: 'VIP', Condition: '[分数]>=80', LayersVisable: { image: true, text: false } },
        { Name: '高分', Condition: '[分数]>=90', LayersVisable: { image: false } },
      ],
    },
  ];
  return doc;
}
describe('data-bound document snapshots', () => {
  it('replaces variables once, keeps unknown placeholders, and supports one-based index', () => {
    expect(
      replaceVariables('{姓名}-{编号}-{未知}-{index}', { 姓名: '{编号}', 编号: '0001' }, 0),
    ).toBe('{编号}-0001-{未知}-1');
    expect(replaceVariables('{constructor}- {__proto__}', {})).toBe('{constructor}- {__proto__}');
  });
  it('selects first matching non-default rule, limits visibility to effective layers, and never mutates source', () => {
    const original = fixture(),
      before = JSON.stringify(original);
    const { document, warnings, matchedConditions } = resolveDocument(original, {
      姓名: '张三',
      编号: '001',
      分数: '95',
    });
    expect((document.Layers[0].Data as TextData).Text).toBe('张三 · 001');
    expect(document.Layers[0].Visible).toBe(true);
    expect(document.Layers[1].Visible).toBe(true);
    expect(document.Layers[1].Data).toMatchObject({ ImageUrl: '头像/001.png', EmbedImage: false });
    expect(matchedConditions).toEqual({ 0: 1 });
    expect(warnings).toEqual([]);
    expect(JSON.stringify(original)).toBe(before);
  });
  it('defaults for unmatched rows and lets manual selection override', () => {
    expect(resolveDocument(fixture(), { 分数: '50' }).document.Layers[1].Visible).toBe(false);
    expect(resolveDocument(fixture(), { 分数: '50' }, { 0: 1 }).document.Layers[1].Visible).toBe(
      true,
    );
    expect(resolveDocument(fixture(), { 分数: '90' }, { 0: 0 }).matchedConditions).toEqual({
      0: 0,
    });
  });
  it('keeps base values without data and preserves unrelated layer visibility', () => {
    const original = fixture();
    expect((resolveDocument(original).document.Layers[0].Data as TextData).Text).toBe('模板');
    original.DocModel.FormatConditionGroups[0].FormatConditionModels = [];
    expect(resolveDocument(original, {}).document.Layers.map((layer) => layer.Visible)).toEqual([
      true,
      false,
      true,
    ]);
  });
  it('keeps the existing content when an enabled variable template is blank, as in desktop', () => {
    const doc = fixture();
    (doc.Layers[0].Data as TextData).VariableTemplate = '   ';
    (doc.Layers[1].Data as ImageData).VariableImageUrl = '';
    const result = resolveDocument(doc, { 分数: '0' }).document;
    expect((result.Layers[0].Data as TextData).Text).toBe('模板');
    expect(result.Layers[1].Data).toMatchObject({ ImageUrl: 'default.png', EmbedImage: true });
  });
  it('shows condition errors and missing placeholders while still resolving defaults', () => {
    const result = resolveDocument(fixture(), { 姓名: '张三' });
    expect(result.warnings.join(' ')).toContain('编号');
    expect(result.warnings.join(' ')).toContain('分数');
    expect(result.matchedConditions).toEqual({ 0: 0 });
  });
  it('recomputes conditional visibility independently for 500 synthetic rows', () => {
    const document = fixture();
    for (let i = 0; i < 500; i++) {
      const resolved = resolveDocument(document, {
        姓名: `人员${i + 1}`,
        编号: String(i + 1).padStart(4, '0'),
        分数: String(i % 100),
      });
      expect(resolved.document.Layers[1].Visible).toBe(i % 100 >= 80);
      expect((resolved.document.Layers[1].Data as ImageData).ImageUrl).toBe(
        `头像/${String(i + 1).padStart(4, '0')}.png`,
      );
    }
  });
});

describe('batch planning and filenames', () => {
  it('treats repeats as additional copies and honors inclusive selected end', () => {
    expect(planBatch(500, 3, 9, 2)).toEqual([
      { start: 3, end: 5, indices: [2, 3, 4] },
      { start: 6, end: 8, indices: [5, 6, 7] },
      { start: 9, end: 9, indices: [8] },
    ]);
  });
  it('handles final incomplete group and clamps to table length', () => {
    expect(planBatch(5, 1, 500, 2)).toEqual([
      { start: 1, end: 3, indices: [0, 1, 2] },
      { start: 4, end: 5, indices: [3, 4] },
    ]);
    expect(planBatch(500, 1, 500, 0)).toHaveLength(500);
    expect(planBatch(0, 1, 1, 0)).toEqual([]);
  });
  it.each([
    [5, 0, 5, 0],
    [5, 6, 7, 0],
    [5, 3, 2, 0],
    [5, 1, 5, -1],
    [5, 1.5, 5, 0],
  ])('rejects invalid batch values', (...args) =>
    expect(() => planBatch(...(args as [number, number, number, number]))).toThrow(),
  );
  it('replaces first-row columns and index range, sanitizes paths and Windows device names', () => {
    const rows = [
      { 姓名: '张/三', 编号: '0001' },
      { 姓名: '李四', 编号: '0002' },
    ];
    expect(filenameForBatch('{index}_{姓名}_{编号}', rows, [0, 1])).toBe('1-2_张_三_0001.png');
    expect(filenameForBatch('CON.png', rows, [0])).toBe('_CON.png');
    expect(filenameForBatch('../{姓名}.PNG', rows, [0])).toBe('.._张_三.png');
    expect(filenameForBatch('', rows, [0])).toBe('1.png');
  });
});
