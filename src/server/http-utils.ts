import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { resolve, join, extname } from 'node:path';
import { readFile } from 'node:fs/promises';
import { parseAppRoute } from '../shared/app-route.ts';

export function normalizeBasePath(value: string) {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, '');
  if (!trimmed) return '';
  if (!/^[a-zA-Z0-9/_-]+$/.test(trimmed) || trimmed.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('DOTS_BASE_PATH must be a safe URL path');
  }
  return `/${trimmed}`;
}

export async function readJson(req: IncomingMessage, maxBytes = 32_000): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk.toString();
    if (Buffer.byteLength(raw, 'utf8') > maxBytes) throw new Error('Request too large');
  }
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
}

export async function readBytes(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > limit) { tooLarge = true; chunks.length = 0; }
    else if (!tooLarge) chunks.push(bytes);
  }
  if (tooLarge) throw new Error('ATTACHMENT_TOO_LARGE');
  return Buffer.concat(chunks, size);
}

export function textAttachmentType(extension: string): string | null {
  const types: Record<string, string> = {
    '.txt': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values',
    '.json': 'application/json', '.yaml': 'text/yaml', '.yml': 'text/yaml', '.xml': 'application/xml', '.html': 'text/html', '.htm': 'text/html',
    '.css': 'text/css', '.js': 'text/javascript', '.jsx': 'text/javascript', '.ts': 'text/typescript', '.tsx': 'text/typescript',
    '.py': 'text/x-python', '.go': 'text/x-go', '.rs': 'text/x-rust', '.java': 'text/x-java', '.sql': 'text/x-sql', '.sh': 'text/x-shellscript',
    '.toml': 'text/toml', '.ini': 'text/plain', '.log': 'text/plain', '.c': 'text/x-c', '.h': 'text/x-c', '.cpp': 'text/x-c++', '.hpp': 'text/x-c++',
  };
  return types[extension] || null;
}

export function reply(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

export function rejectUpgrade(socket: Duplex, status: number, message: string) {
  if (socket.destroyed || !socket.writable) return;
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export function writeTaskArtifact(res: ServerResponse, artifact: { bytes: Buffer; mediaType: string; name: string; previewable: boolean }) {
  if (artifact.bytes.length > 25 * 1024 * 1024) return reply(res, 413, { error: '文件超过 25 MB，暂不支持预览' });
  const filename = artifact.name.replace(/[\r\n"\\]/g, '_').slice(0, 180) || 'artifact';
  const encodedFilename = encodeURIComponent(filename);
  res.writeHead(200, {
    'Content-Type': artifact.mediaType,
    'Content-Length': artifact.bytes.length,
    'Content-Disposition': `inline; filename="artifact"; filename*=UTF-8''${encodedFilename}`,
    'X-Content-Type-Options': 'nosniff',
    ...(artifact.previewable ? { 'Content-Security-Policy': "sandbox allow-scripts; default-src 'self' data: blob: https: http:; script-src 'self' 'unsafe-inline' 'unsafe-eval' https: http:; style-src 'self' 'unsafe-inline' https: http:; img-src 'self' data: blob: https: http:; font-src 'self' data: https: http:; connect-src https: http: wss: ws:; media-src 'self' data: blob: https: http:; object-src 'none'; base-uri 'none'; form-action 'none'" } : {}),
    'Cache-Control': 'private, no-store',
  });
  res.end(artifact.bytes);
}

export async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string) {
  if (req.method !== 'GET') return reply(res, 405, { error: 'Method not allowed' });
  if (pathname.includes('..')) return reply(res, 404, { error: 'Not found' });
  const relativePath = pathname === '/' ? '' : pathname.slice(1);
  const relative = parseAppRoute(pathname) ? 'index.html' : !relativePath || relativePath.endsWith('/') ? `${relativePath}index.html` : relativePath;
  const file = join(resolve('./dist'), relative);
  try {
    const bytes = await readFile(file);
    const type = ({
      '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon',
      '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.json': 'application/json; charset=utf-8',
    } as Record<string, string>)[extname(file)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(bytes);
  } catch { reply(res, 404, { error: 'Not found' }); }
}
