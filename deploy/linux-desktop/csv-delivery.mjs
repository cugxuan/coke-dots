import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { Type } from 'typebox';

const maxBytes = 25 * 1024 * 1024;
const ignored = new Set(['node_modules', '__pycache__', 'npm-cache']);
const inside = (root, file) => file.startsWith(root + path.sep);
const checkAbort = signal => { if (signal?.aborted) throw signal.reason || new Error('Task stopped'); };

export function inspectCsv(text) {
  try {
    if (text.includes('\0')) return { ok: false, code: 'CSV_NUL', message: '包含空字节' };
    const rows = parse(text, { bom: true, skip_empty_lines: true, relax_quotes: false, relax_column_count: false, max_record_size: 2 * 1024 * 1024 });
    if (!rows.length) return { ok: false, code: 'CSV_EMPTY', message: '缺少表头' };
    return { ok: true, rows: rows.length - 1, columns: rows[0].length };
  } catch (error) {
    const line = Number.isInteger(error.lines) ? error.lines : undefined;
    const width = ['CSV_INCONSISTENT_RECORD_LENGTH', 'CSV_RECORD_INCONSISTENT_FIELDS_LENGTH'].includes(error.code);
    const columns = width ? parse(text, { bom: true, skip_empty_lines: true, to: 1 })[0]?.length : undefined;
    return { ok: false, code: error.code || 'CSV_INVALID', ...(line ? { line } : {}), message: width
      ? `列数不一致：应为 ${columns} 列，实际 ${error.record?.length} 列`
      : '引号或分隔符不符合 CSV 语法' };
  }
}

function csvText(headers, rows) {
  if (!headers.length || headers.length > 256 || rows.length > 50_000) throw new Error('CSV 表头或行数超出限制');
  const cell = value => {
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) throw new Error('CSV 单元格必须是字符串、数字、布尔值或 null');
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('CSV 数字必须有限');
    const text = value === null ? '' : String(value);
    return text === '' || /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  if (headers.some(value => typeof value !== 'string')) throw new Error('CSV 表头必须为字符串');
  if (rows.some(row => !Array.isArray(row) || row.length !== headers.length)) throw new Error('CSV 每行列数必须与表头一致');
  const text = '\ufeff' + [headers, ...rows].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
  if (Buffer.byteLength(text) > maxBytes) throw new Error('CSV 超过 25 MiB');
  const result = inspectCsv(text);
  if (!result.ok) throw new Error(result.message);
  return text;
}

// A format-only repair may add/escape quotes and normalize record line endings.
// All other bytes (including commas, values, headers and record order) must stay.
function formatContent(text) {
  return text.replace(/^\ufeff/, '').replace(/\r\n|\r/g, '\n').replaceAll('"', '').replace(/\n$/, '');
}

export async function createCsvDelivery(cwd) {
  const root = await realpath(cwd);
  const written = new Set();
  const baseline = new Map();
  let repairFiles;
  const fingerprint = info => `${info.ino}:${info.size}:${info.mtimeMs}`;
  const scan = async (visit, signal) => {
    const pending = [root]; let entries = 0;
    while (pending.length) {
      const directory = pending.pop();
      let contents;
      try { contents = await readdir(directory, { withFileTypes: true }); }
      catch (error) { if (['EACCES', 'EPERM', 'ENOENT'].includes(error.code)) continue; throw error; }
      for (const entry of contents) {
        checkAbort(signal);
        if (++entries > 5000) return false;
        if (entry.name.startsWith('.') || ignored.has(entry.name)) continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) { pending.push(file); continue; }
        if (/\.csv$/i.test(entry.name)) await visit(file, await lstat(file));
      }
    }
    return true;
  };
  await scan((file, info) => baseline.set(file, fingerprint(info)));
  const resolve = value => {
    if (typeof value !== 'string' || !value || value.length > 500 || /[\\\0]/.test(value) || !/\.csv$/i.test(value)) throw new Error('CSV 路径无效');
    const file = path.resolve(root, value);
    if (!inside(root, file) || path.relative(root, file).split(path.sep).some(part => part.startsWith('.'))) throw new Error('CSV 必须位于当前任务目录');
    return file;
  };
  const read = async file => {
    const real = await realpath(file);
    if (real !== file || !inside(root, real)) throw new Error('CSV 路径不能通过符号链接跳转');
    if (!(await lstat(real)).isFile()) throw new Error('CSV 必须是普通文件');
    const handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > maxBytes) throw new Error('CSV 必须是小于 25 MiB 的普通文件');
      const bytes = await handle.readFile();
      if (bytes.length > maxBytes) throw new Error('CSV 超过 25 MiB');
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } finally { await handle.close(); }
  };
  const save = async (value, text, signal) => {
    checkAbort(signal);
    const file = resolve(value);
    if (repairFiles) {
      if (!repairFiles.has(file)) throw new Error('本轮只能修复已报告的 CSV 文件');
      if (formatContent(text) !== formatContent(repairFiles.get(file))) throw new Error('格式修复不得删改数据、表头或记录顺序');
      if (await read(file) !== repairFiles.get(file)) throw new Error('CSV 已发生变化，拒绝覆盖');
    }
    let ancestor = path.dirname(file);
    while (true) {
      try {
        const real = await realpath(ancestor);
        if (real !== root && !inside(root, real)) throw new Error('CSV 父目录超出当前任务');
        break;
      } catch (error) { if (error.code !== 'ENOENT') throw error; ancestor = path.dirname(ancestor); }
    }
    await mkdir(path.dirname(file), { recursive: true });
    if (await realpath(path.dirname(file)) !== path.dirname(file)) throw new Error('CSV 父目录不能是符号链接');
    const previous = await lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (previous && !previous.isFile()) throw new Error('CSV 目标必须是普通文件');
    const temporary = path.join(path.dirname(file), '.csv-' + randomUUID());
    try {
      await writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
      checkAbort(signal);
      await rename(temporary, file);
    } finally { await rm(temporary, { force: true }); }
    written.add(file);
    if (repairFiles) repairFiles.delete(file);
    return { path: path.relative(root, file).split(path.sep).join('/'), ...inspectCsv(text), bytes: Buffer.byteLength(text) };
  };
  const scalar = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]);
  const tool = {
    name: 'write_csv', label: '生成并校验 CSV',
    executionMode: 'sequential',
    description: '用结构化 headers 和 rows 生成 CSV 交付物，正确转义逗号、引号和换行；每行校验通过后原子写入。不要手工拼接 CSV 文本。',
    parameters: Type.Object({ path: Type.String(), headers: Type.Array(Type.String(), { minItems: 1, maxItems: 256 }), rows: Type.Array(Type.Array(scalar), { maxItems: 50_000 }) }, { additionalProperties: false }),
    async execute(_id, { path: target, headers, rows }, signal) {
      const result = await save(target, csvText(headers, rows), signal);
      return { content: [{ type: 'text', text: `CSV 已写入并通过格式检查：${JSON.stringify(result)}` }], details: result };
    },
  };
  return {
    tool,
    async inspect(message, signal, declaredPaths = []) {
      checkAbort(signal);
      let text = String(message);
      try { text += '\n' + decodeURIComponent(text); } catch { /* Plain filenames are still usable. */ }
      const files = new Set(written);
      if (!Array.isArray(declaredPaths) || declaredPaths.length > 100) throw new Error('CSV 交付文件列表无效（最多 100 个）');
      for (const value of declaredPaths) files.add(resolve(value));
      const complete = await scan((file, info) => {
        const relative = path.relative(root, file).split(path.sep).join('/');
        if (baseline.get(file) !== fingerprint(info) && (path.dirname(file) === root || text.includes(relative) || text.includes(path.basename(file)))) files.add(file);
      }, signal);
      if (!complete && files.size) throw new Error('CSV 交付检查超过文件扫描上限；请将交付物放在任务根目录');
      const checked = []; const issues = [];
      for (const file of files) {
        const name = path.relative(root, file).split(path.sep).join('/');
        try {
          const contents = await read(file); const result = inspectCsv(contents);
          if (result.ok) checked.push({ path: name, ...result });
          else issues.push({ path: name, ...result, contents });
        } catch (error) { issues.push({ path: name, ok: false, code: 'CSV_UNREADABLE', message: error.message }); }
      }
      return { checked, issues };
    },
    async beginRepair(issues) {
      if (issues.length > 3 || issues.some(issue => typeof issue.contents !== 'string') || issues.reduce((n, issue) => n + issue.contents.length, 0) > 18_000) return false;
      repairFiles = new Map(issues.map(issue => [resolve(issue.path), issue.contents]));
      const backup = path.join(root, '.coke-dots-agent-runtime', 'csv-originals');
      await mkdir(backup, { recursive: true, mode: 0o700 });
      if (!(await realpath(backup)).startsWith(root + path.sep)) throw new Error('CSV 备份目录超出任务');
      for (const issue of issues) await writeFile(path.join(backup, randomUUID() + '.csv'), issue.contents, { mode: 0o600, flag: 'wx' });
      return true;
    },
    endRepair() { repairFiles = undefined; },
  };
}

export function csvFailure(issues) {
  return 'CSV 交付校验未通过：' + issues.map(issue => `${issue.path}${issue.line ? ` 第 ${issue.line} 行` : ''}：${issue.message}`).join('；') + '。文件与会话已保留。';
}
