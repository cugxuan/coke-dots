import './task-artifacts.css';

export function ReplyDownload({ body, title }: { body: string; title?: string }) {
  function download() {
    const name = (title || 'Dot回复').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').slice(0, 80).trim().replace(/[. ]+$/, '') || 'Dot回复';
    const url = URL.createObjectURL(new Blob([body], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${name}-回复.md`;
    document.body.append(link);
    link.click();
    link.remove();
    // Give the browser time to start saving before releasing the blob.
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  return <button type="button" className="task-artifact-action message-download-reply" data-testid="download-reply" title="将这条回复保存为 Markdown 文件" onClick={download}>下载回复</button>;
}
