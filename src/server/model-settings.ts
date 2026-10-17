import { K3dModelSecretStore } from './k3d-model-secret.ts';
import { FileModelSecretStore } from './file-model-secret.ts';

export type ModelApiKeyStatus = 'available' | 'missing' | 'unavailable';
export interface ModelSettings { baseUrl: string; model: string; hasKey: boolean; adminTenantId: string | null; apiKeyStatus: ModelApiKeyStatus; secretBackend?: 'kubernetes' | 'file' }

const kubernetesSecretStore = new K3dModelSecretStore();
const fileSecretStore = new FileModelSecretStore();
export function modelSecretBackend(): 'kubernetes' | 'file' {
  const backend = process.env.DOTS_MODEL_SECRET_BACKEND?.trim() || (process.env.DOTS_COMPUTER_BACKEND === 'ssh-docker' ? 'file' : 'kubernetes');
  if (backend !== 'kubernetes' && backend !== 'file') throw new Error('DOTS_MODEL_SECRET_BACKEND 只支持 kubernetes 或 file');
  return backend;
}
const sharedSecretStore = () => modelSecretBackend() === 'file' ? fileSecretStore : kubernetesSecretStore;
const testModelFixtureEnabled = () => process.env.NODE_ENV === 'test' && process.env.DOTS_E2E_AUTH === '1';
let stored: ModelSettings = { baseUrl: '', model: '', hasKey: false, adminTenantId: null, apiKeyStatus: 'missing' };

/** Endpoint/model are instance metadata; credentials use the selected server-only store. */
export function loadModelSettings(baseUrl: string | null, model: string | null, adminTenantId: string | null = null) {
  const apiKeyStatus = sharedModelApiKeyStatus();
  stored = { baseUrl: baseUrl || '', model: model || '', hasKey: apiKeyStatus === 'available', adminTenantId, apiKeyStatus };
}

/** Never store the shared credential in tenant data or SQLite. */
export function saveModelKey(value: string) {
  sharedSecretStore().save(value);
  stored = { ...stored, hasKey: true, apiKeyStatus: 'available' };
}

export function setModelMetadata(baseUrl: string, model: string, adminTenantId: string | null = stored.adminTenantId) {
  stored = { ...stored, baseUrl, model, adminTenantId };
}

export function publicModelSettings(adminTenantId: string | null = stored.adminTenantId): ModelSettings {
  const apiKeyStatus = sharedModelApiKeyStatus();
  return { ...stored, hasKey: apiKeyStatus === 'available', apiKeyStatus, adminTenantId, secretBackend: modelSecretBackend() };
}

export function sharedModelApiKeyStatus(secretStore: Pick<K3dModelSecretStore, 'read'> = sharedSecretStore()): ModelApiKeyStatus {
  if (environmentModelKey()) return 'available';
  const status = secretStore.read().status;
  if (status === 'configured') return 'available';
  return status;
}

export function effectiveModelConfig(_tenantId = 'legacy', secretStore: Pick<K3dModelSecretStore, 'read'> = sharedSecretStore()) {
  const apiKey = secretStore.read().value || environmentModelKey();
  const model = stored.model || process.env.DOTS_MODEL?.trim() || '';
  const baseUrl = stored.baseUrl || process.env.DOTS_MODEL_BASE_URL?.trim() || 'https://api.openai.com/v1';
  return apiKey && model ? { apiKey, model, baseUrl: baseUrl.replace(/\/$/, '') } : null;
}

function environmentModelKey(): string | null {
  const value = process.env.DOTS_MODEL_API_KEY?.trim();
  return value && testModelFixtureEnabled() ? value : null;
}

export function clearSharedModelSecretForTests() {
  kubernetesSecretStore.clearTestValue();
}
