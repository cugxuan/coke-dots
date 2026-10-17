import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import type { ModelSecretRead } from './k3d-model-secret.ts';

/** Instance secret on the control plane; never placed in SQLite or tenant volumes. */
export class FileModelSecretStore {
  constructor(private readonly filename = () => resolve(process.env.DOTS_MODEL_SECRET_FILE || resolve(process.env.DOTS_DATA_DIR || './data', 'secrets', 'model-api-key'))) {}

  read(): ModelSecretRead {
    let descriptor: number | undefined;
    try {
      const path = this.filename();
      assertPrivateDirectory(dirname(path));
      descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = fstatSync(descriptor);
      if (!info.isFile() || info.nlink !== 1 || info.size > 5000 || (info.mode & 0o077) !== 0 || !ownedByProcess(info.uid)) {
        throw new Error('Invalid secret file permissions');
      }
      const value = readFileSync(descriptor, 'utf8').trim();
      if (/[\r\n\0]/.test(value)) throw new Error('Invalid secret contents');
      return value ? { status: 'configured', value } : { status: 'missing', value: null };
    } catch (error) {
      return { status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unavailable', value: null };
    } finally { if (descriptor !== undefined) closeSync(descriptor); }
  }

  save(value: string) {
    const clean = value.trim();
    if (!clean || Buffer.byteLength(clean) > 5000 || /[\r\n\0]/.test(clean)) throw new Error('模型 API 密钥格式无效');
    const path = this.filename();
    const directory = dirname(path);
    let temporary: string | undefined;
    let descriptor: number | undefined;
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      assertPrivateDirectory(directory);
      try {
        const info = lstatSync(path);
        if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0 || !ownedByProcess(info.uid)) throw new Error('Unsafe secret file');
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      temporary = path + '.' + randomUUID() + '.tmp';
      descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      writeFileSync(descriptor, clean);
      fsyncSync(descriptor);
      closeSync(descriptor); descriptor = undefined;
      renameSync(temporary, path); temporary = undefined;
      descriptor = openSync(directory, constants.O_RDONLY);
      fsyncSync(descriptor);
    } catch {
      throw new Error('无法保存实例模型密钥。请检查密钥目录归属及权限（目录 0700，文件 0600）。');
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      if (temporary) { try { unlinkSync(temporary); } catch { /* Do not mask the storage error. */ } }
    }
  }
}

function ownedByProcess(uid: number) { return typeof process.getuid !== 'function' || uid === process.getuid(); }

function assertPrivateDirectory(directory: string) {
  const info = lstatSync(directory);
  if (!info.isDirectory() || !ownedByProcess(info.uid) || (info.mode & 0o077) !== 0) throw new Error('Unsafe secret directory');
}
