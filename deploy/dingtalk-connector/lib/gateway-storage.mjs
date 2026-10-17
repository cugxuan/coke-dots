import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sealProfileBytes, openProfileBytes } from './gateway-credentials.mjs';
import { allowedErrors } from './gateway-errors.mjs';

const maxArchiveBytes = 32 * 1024 * 1024;

async function runTar(args, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', args, { shell: false, stdio: ['ignore', 'ignore', 'ignore'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('error', () => { clearTimeout(timer); reject(new Error('DINGTALK_PROFILE_ARCHIVE_FAILED')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(); else reject(new Error('DINGTALK_PROFILE_ARCHIVE_FAILED'));
    });
  });
}

export async function writeEncryptedProfile({ storageRoot, ownerKey, masterKey, sourceRoot, tempRoot }) {
  const archivePath = path.join(tempRoot, `save-${randomUUID()}.tar.gz`);
  const encryptedPath = path.join(storageRoot, `${ownerKey}.dws`);
  const pendingPath = `${encryptedPath}.${randomUUID()}.tmp`;
  try {
    await runTar(['-czf', archivePath, '-C', sourceRoot, '.']);
    const archiveInfo = await stat(archivePath);
    if (archiveInfo.size > maxArchiveBytes) throw new Error('DINGTALK_PROFILE_TOO_LARGE');
    const archive = await readFile(archivePath);
    await writeFile(pendingPath, sealProfileBytes(archive, ownerKey, masterKey), { mode: 0o600, flag: 'wx' });
    await rename(pendingPath, encryptedPath);
    await chmodPrivate(encryptedPath, 0o600);
  } finally {
    await rm(archivePath, { force: true });
    await rm(pendingPath, { force: true });
  }
}

export async function restoreEncryptedProfile({ storageRoot, ownerKey, masterKey, destinationRoot, tempRoot }) {
  const encryptedPath = path.join(storageRoot, `${ownerKey}.dws`);
  let ciphertext;
  try { ciphertext = await readFile(encryptedPath); } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw new Error('DINGTALK_PROFILE_READ_FAILED');
  }
  if (ciphertext.length > maxArchiveBytes + 64) throw new Error('DINGTALK_PROFILE_TOO_LARGE');
  const archivePath = path.join(tempRoot, `restore-${randomUUID()}.tar.gz`);
  try {
    const plaintext = openProfileBytes(ciphertext, ownerKey, masterKey);
    if (plaintext.length > maxArchiveBytes) throw new Error('DINGTALK_PROFILE_TOO_LARGE');
    await mkdir(destinationRoot, { recursive: true, mode: 0o700 });
    await writeFile(archivePath, plaintext, { mode: 0o600, flag: 'wx' });
    await runTar(['-xzf', archivePath, '-C', destinationRoot, '--no-same-owner', '--no-same-permissions']);
    await chmodPrivate(destinationRoot, 0o700);
    return true;
  } finally { await rm(archivePath, { force: true }); }
}

export async function chmodPrivate(target, mode) {
  await chmod(target, mode);
}

export async function ensurePrivateStorageRoot(storageRoot) {
  await mkdir(storageRoot, { recursive: true, mode: 0o700 });
  const info = await lstat(storageRoot);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()) throw new Error('DINGTALK_STORAGE_UNSAFE');
  await chmod(storageRoot, 0o700);
}

async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()) throw new Error('DWS_DOC_OPERATION_STORAGE_FAILED');
  await chmodPrivate(directory, 0o700);
}

async function writeDocumentOperationRecord(file, value) {
  const pending = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(pending, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(pending, file);
    await chmodPrivate(file, 0o600);
    await syncDirectory(path.dirname(file));
  } finally { await handle?.close().catch(() => undefined); await rm(pending, { force: true }); }
}

async function syncDirectory(directory) {
  let handle;
  try { handle = await open(directory, 'r'); await handle.sync(); }
  catch (error) { if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EBADF'].includes(error?.code)) throw error; }
  finally { await handle?.close().catch(() => undefined); }
}

export function createDocumentWriteOnce(storageRoot) {
  return async ({ ownerKey, requestId, operation, input, work }) => {
    const ownerDirectory = path.join(storageRoot, '.document-operations', ownerKey);
    await ensurePrivateDirectory(path.dirname(ownerDirectory));
    await ensurePrivateDirectory(ownerDirectory);
    const requestHash = createHash('sha256').update(requestId).digest('hex');
    const recordPath = path.join(ownerDirectory, `${requestHash}.json`);
    const fingerprint = createHash('sha256').update(JSON.stringify({ operation, input })).digest('hex');
    let existing;
    try { existing = JSON.parse(await readFile(recordPath, 'utf8')); }
    catch (error) { if (error?.code !== 'ENOENT') throw new Error('DWS_DOC_OPERATION_STORAGE_FAILED'); }
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error('DWS_DOC_REQUEST_CONFLICT');
      if (existing.state === 'complete' && existing.result && typeof existing.result === 'object') return existing.result;
      throw new Error(existing.error || 'DWS_DOC_COMMIT_UNKNOWN');
    }

    const started = { state: 'running', fingerprint, createdAt: new Date().toISOString() };
    try {
      const handle = await open(recordPath, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(started)); await handle.sync(); }
      finally { await handle.close(); }
      await syncDirectory(ownerDirectory);
    }
    catch (error) {
      if (error?.code === 'EEXIST') {
        let raced;
        try { raced = JSON.parse(await readFile(recordPath, 'utf8')); } catch { throw new Error('DWS_DOC_COMMIT_UNKNOWN'); }
        if (raced.fingerprint !== fingerprint) throw new Error('DWS_DOC_REQUEST_CONFLICT');
        if (raced.state === 'complete' && raced.result && typeof raced.result === 'object') return raced.result;
        throw new Error(raced.error || 'DWS_DOC_COMMIT_UNKNOWN');
      }
      throw new Error('DWS_DOC_OPERATION_STORAGE_FAILED');
    }

    try {
      const result = await work();
      await writeDocumentOperationRecord(recordPath, { ...started, state: 'complete', result });
      return result;
    } catch (error) {
      const rawCode = typeof error?.message === 'string' && allowedErrors.has(error.message) ? error.message : 'DWS_DOC_COMMIT_UNKNOWN';
      const uncertain = ['DWS_DOC_COMMIT_UNKNOWN', 'DWS_DOC_PARTIAL_SUCCESS'].includes(rawCode);
      await writeDocumentOperationRecord(recordPath, { ...started, state: uncertain ? 'unknown' : 'failed', error: rawCode }).catch(() => undefined);
      throw error;
    }
  };
}
