import { useEffect, useId, useState } from 'react';
import type { TaskArtifact } from '../shared/types.ts';
import { taskArtifactDownloadPath } from '../shared/task-artifacts.ts';
import { appFetch, appPath } from './api.ts';
import './task-artifacts.css';

export function TaskArtifacts({ taskId, refreshKey, autoPreview = true, onOpenComputer }: { taskId: string; refreshKey?: string; autoPreview?: boolean; onOpenComputer: () => void }) {
  const [artifacts, setArtifacts] = useState<TaskArtifact[] | null>(null);
  const [error, setError] = useState('');
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const [openingPath, setOpeningPath] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const listId = useId();

  useEffect(() => {
    const controller = new AbortController();
    setArtifacts(null);
    setError('');
    setPreviewPath(null);
    setPreviewUrls({});
    setExpanded(false);
    void (async () => {
      try {
        const response = await appFetch(`/api/tasks/${encodeURIComponent(taskId)}/artifacts`, { signal: controller.signal });
        if (!response.ok) throw new Error('文件暂时无法读取');
        const value = await response.json() as { artifacts: TaskArtifact[] };
        if (controller.signal.aborted) return;
        setArtifacts(value.artifacts);

        // HTML is the most useful task output to see immediately (for example,
        // a small game or interactive report). Keep other files opt-in so a
        // task with many outputs does not flood the conversation.
        const html = autoPreview && value.artifacts.find(artifact => artifact.mediaType === 'text/html' && artifact.previewable);
        if (!html) return;
        try {
          const previewResponse = await appFetch(`/api/tasks/${encodeURIComponent(taskId)}/artifacts/preview-url?path=${encodeURIComponent(html.path)}`, { signal: controller.signal });
          const preview = await previewResponse.json() as { url?: string; error?: string };
          if (!previewResponse.ok || !preview.url) throw new Error(preview.error || '无法预览这个文件');
          if (!controller.signal.aborted) {
            setPreviewUrls(current => ({ ...current, [html.path]: appPath(preview.url!) }));
            setPreviewPath(html.path);
          }
        } catch (reason) {
          if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '无法预览这个文件');
        }
      } catch (reason) {
        if (!controller.signal.aborted) {
          setArtifacts([]);
          setError(reason instanceof Error ? reason.message : '文件暂时无法读取');
        }
      }
    })();
    return () => controller.abort();
  }, [taskId, refreshKey, autoPreview]);

  async function togglePreview(artifactPath: string) {
    if (previewPath === artifactPath) { setPreviewPath(null); return; }
    setError('');
    try {
      const response = await appFetch(`/api/tasks/${encodeURIComponent(taskId)}/artifacts/preview-url?path=${encodeURIComponent(artifactPath)}`);
      const value = await response.json() as { url?: string; error?: string };
      if (!response.ok || !value.url) throw new Error(value.error || '无法预览这个文件');
      setPreviewUrls(current => ({ ...current, [artifactPath]: appPath(value.url!) }));
      setPreviewPath(artifactPath);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '无法预览这个文件'); }
  }

  async function openInComputer(artifactPath: string) {
    setOpeningPath(artifactPath);
    setError('');
    try {
      const response = await appFetch(`/api/tasks/${encodeURIComponent(taskId)}/artifacts/open-in-computer`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: artifactPath }),
      });
      const value = await response.json() as { error?: string };
      if (!response.ok) throw new Error(value.error || '无法在云电脑中打开文件');
      onOpenComputer();
    } catch (reason) { setError(reason instanceof Error ? reason.message : '无法在云电脑中打开文件'); }
    finally { setOpeningPath(null); }
  }

  if (artifacts === null) return <section className="task-artifacts" data-testid="task-artifacts-loading" aria-label="任务文件"><span>正在查找生成的文件…</span></section>;
  if (!artifacts.length && !error) return null;

  return <section className="task-artifacts" data-testid="task-artifacts" data-task-id={taskId} aria-label="任务文件">
    <div className="task-artifacts-heading"><span aria-hidden="true">▤</span><strong>生成的文件</strong>{artifacts.length > 0 && <small>{artifacts.length}</small>}</div>
    {artifacts.length > 0 && <p className="task-artifact-hint">下载到你自己的电脑，随时查看和使用。</p>}
    {error && <p className="task-artifact-error" role="status">{error}</p>}
    {artifacts.length > 0 && <div className="task-artifact-list" id={listId}>
      {(expanded ? artifacts : artifacts.slice(0, 5)).map(artifact => {
        const url = appPath(taskArtifactDownloadPath(taskId, artifact.path));
        const isPreviewed = previewPath === artifact.path;
        return <article key={artifact.path} className="task-artifact" data-testid="task-artifact" data-artifact-path={artifact.path}>
          <span className="task-artifact-file-icon" aria-hidden="true">{artifact.mediaType.startsWith('image/') ? '▧' : artifact.mediaType === 'text/html' ? '◉' : '▤'}</span>
          <span className="task-artifact-file-copy"><strong title={artifact.path}>{artifact.name}</strong><small>{formatSize(artifact.size)}{artifact.previewable ? ' · 可预览' : ''}</small></span>
          {artifact.previewable && <button type="button" className="task-artifact-action" aria-expanded={isPreviewed} onClick={() => void togglePreview(artifact.path)}>{isPreviewed ? '收起预览' : '预览'}</button>}
          {artifact.mediaType === 'text/html' && <button type="button" className="task-artifact-action" data-testid="open-artifact-in-computer" disabled={openingPath !== null} onClick={() => void openInComputer(artifact.path)}>{openingPath === artifact.path ? '正在打开…' : '在云电脑中打开'}</button>}
          <a className="task-artifact-action" href={url} download={artifact.name}>下载到本机</a>
          {isPreviewed && previewUrls[artifact.path] && <iframe className="task-artifact-preview" data-testid="task-artifact-preview" title={`预览 ${artifact.name}`} src={previewUrls[artifact.path]} sandbox="allow-scripts" referrerPolicy="no-referrer" />}
        </article>;
      })}
    </div>}
    {artifacts.length > 5 && <button type="button" className="task-artifact-action task-artifact-toggle" aria-expanded={expanded} aria-controls={listId} onClick={() => setExpanded(current => !current)}><span>{expanded ? '收起文件列表' : `展开其余 ${artifacts.length - 5} 个文件`}</span><span className="task-artifact-chevron" aria-hidden="true">⌄</span></button>}
  </section>;
}

function formatSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
