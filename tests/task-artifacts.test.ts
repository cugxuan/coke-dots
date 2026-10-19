import assert from 'node:assert/strict';
import test from 'node:test';
import { orderTaskArtifacts, taskArtifactDownloadPath } from '../src/shared/task-artifacts.ts';
import type { TaskArtifact } from '../src/shared/types.ts';

const file = (path: string): TaskArtifact => ({ path, name: path.split('/').at(-1)!, size: 12, mediaType: 'text/plain', previewable: true });

test('result references put the report before source files without losing other outputs', () => {
  const files = [file('data/annual.pdf'), file('data/annual.txt'), file('data/final summary.md'), file('extract.mjs')];
  const result = '汇总表：data/final summary.md（详见 annual.pdf）。';
  assert.deepEqual(orderTaskArtifacts(files, result).map(file => file.path), [
    'data/final summary.md', 'data/annual.pdf', 'data/annual.txt', 'extract.mjs',
  ]);
  assert.equal(files[0].path, 'data/annual.pdf', 'Do not mutate the worker response');
  assert.deepEqual(orderTaskArtifacts(files, null), files);
});

test('file references handle absolute and Chinese paths but not longer names or ambiguous basenames', () => {
  const files = [file('data/report.md'), file('notes/report.md'), file('结果/汇总 #1.csv')];
  assert.deepEqual(orderTaskArtifacts(files, '请下载 /workspace/tasks/id/结果/汇总 #1.csv。report.md'), [files[2], files[0], files[1]]);
  assert.deepEqual(orderTaskArtifacts(files, 'notes/report.md.bak、汇总 #1.csv.old'), files);
  assert.deepEqual(orderTaskArtifacts(files, '请查看 notes/report.md。'), [files[1], files[0], files[2]]);
});

test('task download links encode each path segment including spaces, Chinese and URL delimiters', () => {
  const url = taskArtifactDownloadPath('task-id', '导出/汇总 #1?.csv');
  assert.equal(url, '/api/tasks/task-id/artifacts/file/%E5%AF%BC%E5%87%BA/%E6%B1%87%E6%80%BB%20%231%3F.csv');
});
