import assert from 'node:assert/strict';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FileModelSecretStore } from '../src/server/file-model-secret.ts';
import { effectiveModelConfig, loadModelSettings, modelSecretBackend, publicModelSettings, saveModelKey } from '../src/server/model-settings.ts';

test('file model secret persists across instances, rotates atomically and stays private', () => {
  const root = mkdtempSync(join(tmpdir(), 'dots-file-secret-'));
  const path = join(root, 'secrets', 'model-api-key');
  try {
    const secret = new FileModelSecretStore(() => path);
    assert.deepEqual(secret.read(), { value: null, status: 'missing' });
    secret.save('first-test-key');
    assert.equal(statSync(join(root, 'secrets')).mode & 0o777, 0o700);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(new FileModelSecretStore(() => path).read().value, 'first-test-key');
    secret.save('second-test-key');
    assert.deepEqual(readdirSync(join(root, 'secrets')), ['model-api-key']);
    assert.equal(new FileModelSecretStore(() => path).read().value, 'second-test-key');
    for (const value of ['', 'key\nINJECT=value', 'a'.repeat(5001)]) assert.throws(() => secret.save(value));
    assert.equal(secret.read().value, 'second-test-key');
    rmSync(path);
    assert.equal(secret.read().status, 'missing', 'Removing a file must not leave a cached key active');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('file storage refuses public permissions, symlinks and hard links without changing targets', () => {
  const root = mkdtempSync(join(tmpdir(), 'dots-file-secret-permissions-'));
  const directory = join(root, 'secrets');
  const path = join(directory, 'key');
  const target = join(root, 'unrelated');
  try {
    mkdirSync(directory, { mode: 0o700 });
    writeFileSync(target, 'unrelated-key', { mode: 0o600 });
    const secret = new FileModelSecretStore(() => path);
    symlinkSync(target, path);
    assert.equal(secret.read().status, 'unavailable');
    assert.throws(() => secret.save('replacement'), /无法保存/);
    assert.equal(readFileSync(target, 'utf8'), 'unrelated-key');
    rmSync(path);
    linkSync(target, path);
    assert.equal(secret.read().status, 'unavailable');
    assert.throws(() => secret.save('replacement'), /无法保存/);
    rmSync(path);
    secret.save('private-test-key');
    chmodSync(path, 0o644);
    assert.equal(secret.read().status, 'unavailable');
    assert.throws(() => secret.save('replacement'), /无法保存/);
    chmodSync(path, 0o600);
    chmodSync(directory, 0o755);
    assert.equal(secret.read().status, 'unavailable');
    assert.throws(() => secret.save('replacement'), /无法保存/);
    chmodSync(directory, 0o700);
    const alias = join(root, 'alias');
    symlinkSync(directory, alias);
    assert.equal(new FileModelSecretStore(() => join(alias, 'key')).read().status, 'unavailable');
    assert.equal(readFileSync(target, 'utf8'), 'unrelated-key');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('SSH Docker defaults to instance file credentials without Kubernetes, including production', () => {
  const root = mkdtempSync(join(tmpdir(), 'dots-file-secret-production-'));
  const keys = ['NODE_ENV', 'DOTS_COMPUTER_BACKEND', 'DOTS_MODEL_SECRET_BACKEND', 'DOTS_MODEL_SECRET_FILE', 'DOTS_DATA_DIR', 'DOTS_KUBECTL', 'DOTS_MODEL_API_KEY'] as const;
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, { NODE_ENV: 'production', DOTS_COMPUTER_BACKEND: 'ssh-docker', DOTS_DATA_DIR: root,
      DOTS_KUBECTL: join(root, 'kubectl-is-not-installed'), DOTS_MODEL_API_KEY: 'ignored-environment-key' });
    delete process.env.DOTS_MODEL_SECRET_BACKEND;
    delete process.env.DOTS_MODEL_SECRET_FILE;
    assert.equal(modelSecretBackend(), 'file');
    loadModelSettings('https://model.example.test/v1', 'test-model', 'alpha');
    assert.equal(effectiveModelConfig(), null);
    saveModelKey('file-backed-test-key');
    assert.equal(effectiveModelConfig('alpha')?.apiKey, 'file-backed-test-key');
    assert.deepEqual(effectiveModelConfig('beta'), effectiveModelConfig('alpha'));
    assert.equal(publicModelSettings().secretBackend, 'file');
    assert.equal(publicModelSettings().apiKeyStatus, 'available');
    assert.equal(JSON.stringify(publicModelSettings()).includes('file-backed-test-key'), false);
    assert.equal(readFileSync(join(root, 'secrets', 'model-api-key'), 'utf8'), 'file-backed-test-key');
    process.env.DOTS_COMPUTER_BACKEND = 'linux-desktop';
    assert.equal(modelSecretBackend(), 'kubernetes', 'Existing deployments retain their credential backend');
    process.env.DOTS_MODEL_SECRET_BACKEND = 'file';
    assert.equal(effectiveModelConfig('beta')?.apiKey, 'file-backed-test-key');
    process.env.DOTS_MODEL_SECRET_BACKEND = 'typo';
    assert.throws(() => modelSecretBackend(), /DOTS_MODEL_SECRET_BACKEND/);
  } finally {
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});
