import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parse } from 'csv-parse/sync';
import { createCsvDelivery, inspectCsv } from '../deploy/linux-desktop/csv-delivery.mjs';

test('strict CSV parsing catches both misaligned numbers and uniform-width malformed quotes', () => {
  assert.equal(inspectCsv('name,value\n示例,1,234\n').ok, false);
  assert.match(inspectCsv('name,value\n示例,1,234\n').message, /应为 2 列，实际 3 列/);
  assert.equal(inspectCsv('name,value\n示例,"关键词"检索结果\n').ok, false);
  assert.equal(inspectCsv('a,b\n1,word"quote\n').ok, false);
  assert.equal(inspectCsv('a,b\n1,"unclosed\n').ok, false);
  assert.equal(inspectCsv('').ok, false);
  assert.equal(inspectCsv('a,b\n1,\0\n').ok, false);
  assert.deepEqual(inspectCsv('\ufeffa,b\r\n"line1\nline2","x,""quoted"""\r\n\r\n'), { ok: true, rows: 1, columns: 2 });
});

test('structured writer round trips Chinese, commas, quotes, newlines and typed scalars', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dots-csv-'));
  try {
    const delivery = await createCsvDelivery(root);
    const headers = ['公司', '金额', '备注', '可用', '空值'];
    const rows = [['示例公司', '1,234.50', '第一行\n他说"通过"', true, null], ['另一公司', 15, 'plain', false, '']];
    await delivery.tool.execute('write', { path: 'data/报告.csv', headers, rows });
    const text = await readFile(path.join(root, 'data/报告.csv'), 'utf8');
    assert.equal(text.charCodeAt(0), 0xfeff);
    assert.deepEqual(parse(text, { bom: true }), [headers, ...rows.map(row => row.map(value => value === null ? '' : String(value)))]);
    assert.deepEqual((await delivery.inspect('交付 data/报告.csv')).checked.map(x => [x.rows, x.columns]), [[2, 5]]);
    await assert.rejects(delivery.tool.execute('bad', { path: 'data/报告.csv', headers, rows: [['too short']] }), /列数/);
    assert.equal(await readFile(path.join(root, 'data/报告.csv'), 'utf8'), text);
    await delivery.tool.execute('empty-cell', { path: 'empty.csv', headers: ['value'], rows: [[null]] });
    assert.deepEqual(inspectCsv(await readFile(path.join(root, 'empty.csv'), 'utf8')), { ok: true, rows: 1, columns: 1 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('repair changes only quoting, preserves the original, and rejects altered values or unapproved paths', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dots-csv-repair-'));
  try {
    const file = path.join(root, 'report.csv'); const original = '\ufeffname,value\n示例,1,234\n';
    await writeFile(file, original);
    const delivery = await createCsvDelivery(root); const validation = await delivery.inspect('report.csv', undefined, ['report.csv']);
    assert.equal(validation.issues.length, 1);
    assert.equal(await delivery.beginRepair(validation.issues), true);
    await assert.rejects(delivery.tool.execute('changed', { path: 'report.csv', headers: ['name', 'value'], rows: [['示例', '9,999']] }), /不得删改/);
    await assert.rejects(delivery.tool.execute('other', { path: 'other.csv', headers: ['name'], rows: [['x']] }), /本轮只能/);
    assert.equal(await readFile(file, 'utf8'), original);
    await delivery.tool.execute('repair', { path: 'report.csv', headers: ['name', 'value'], rows: [['示例', '1,234']] });
    assert.equal((await delivery.inspect('report.csv')).issues.length, 0);
    const backups = await readdir(path.join(root, '.coke-dots-agent-runtime/csv-originals'));
    assert.equal(backups.length, 1);
    assert.equal(await readFile(path.join(root, '.coke-dots-agent-runtime/csv-originals', backups[0]), 'utf8'), original);
    delivery.endRepair();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('delivery validation skips dependency/source trees, checks named nested outputs and refuses symlink escapes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dots-csv-paths-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'dots-csv-outside-'));
  try {
    await mkdir(path.join(root, 'node_modules/pkg'), { recursive: true });
    await mkdir(path.join(root, 'research'));
    await mkdir(path.join(root, 'results'));
    await writeFile(path.join(root, 'node_modules/pkg/fixture.csv'), 'bad,"');
    await writeFile(path.join(root, 'research/raw.csv'), 'bad,"');
    await writeFile(path.join(root, 'results/报告.csv'), 'a,b\n1,2,3\n');
    const delivery = await createCsvDelivery(root);
    assert.equal((await delivery.inspect('完成了代码修改。')).issues.length, 0);
    assert.equal((await delivery.inspect('results/%E6%8A%A5%E5%91%8A.csv', undefined, ['results/报告.csv'])).issues.length, 1);
    await writeFile(path.join(outside, 'private.csv'), 'a,b\n1,2\n');
    await symlink(path.join(outside, 'private.csv'), path.join(root, 'escape.csv'));
    assert.equal((await delivery.inspect('escape.csv')).issues.some(x => x.code === 'CSV_UNREADABLE'), true);
    await symlink(outside, path.join(root, 'link'));
    await assert.rejects(delivery.tool.execute('escape', { path: 'link/new.csv', headers: ['a'], rows: [['x']] }), /超出/);
    await assert.rejects(delivery.tool.execute('parent', { path: '../escape.csv', headers: ['a'], rows: [['x']] }), /当前任务/);
    assert.deepEqual(await readdir(outside), ['private.csv']);
    await writeFile(path.join(root, 'invalid.csv'), Buffer.from([0xff, 0xfe]));
    assert.equal((await delivery.inspect('invalid.csv')).issues.some(x => x.path === 'invalid.csv' && x.code === 'CSV_UNREADABLE'), true);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
