import type { TaskArtifact } from './types.ts';

/** Put files actually named in the result ahead of supporting material. */
export function orderTaskArtifacts(artifacts: TaskArtifact[], result: string | null | undefined): TaskArtifact[] {
  if (!result) return artifacts;
  const nameCounts = new Map<string, number>();
  for (const artifact of artifacts) nameCounts.set(artifact.name, (nameCounts.get(artifact.name) || 0) + 1);
  const position = (path: string) => {
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`(?<![\\p{L}\\p{N}_-])${escaped}(?![\\p{L}\\p{N}_/-]|\\.[\\p{L}\\p{N}_-])`, 'u').exec(result);
    return match?.index ?? Infinity;
  };
  return artifacts.map((artifact, index) => ({
    artifact, index,
    position: Math.min(position(artifact.path), nameCounts.get(artifact.name) === 1 ? position(artifact.name) : Infinity),
  })).sort((left, right) => left.position - right.position || left.index - right.index).map(item => item.artifact);
}

export function taskArtifactDownloadPath(taskId: string, path: string) {
  return `/api/tasks/${encodeURIComponent(taskId)}/artifacts/file/${path.split('/').map(part => encodeURIComponent(part)).join('/')}`;
}
