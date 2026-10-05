import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { ModelConfigurationChange, ModelConfigurationSaveResult, ModelConnectionImpact, ModelProviderCatalogDraft } from '../../shared/modelConfiguration';
import { normalizeEndpointIdentity } from '../pipeline/materialEmbeddingTypes';
import { readModelHub, resolveProviderCredentials, type HubStore, type ModelHub } from './modelHub';
import { fetchRemoteProviderModels } from './remoteModelClient';
import { generationProfile, readActiveGeneration } from '../pipeline/materialVectorGenerationStore';

export interface ModelConfigurationStore extends HubStore {
  store: Record<string, unknown>;
}

interface LockedBinding {
  profileHash: string;
  sourceId: string;
  endpoint: string;
  model: string;
}

interface ServiceOptions {
  store: ModelConfigurationStore;
  libraries: () => Array<{ path: string; alias?: string }>;
  prepare: (change: ModelConfigurationChange, draft: ModelConfigurationStore) => Omit<Extract<ModelConfigurationSaveResult, { status: 'saved' }>, 'status'>;
  afterSave: (change: ModelConfigurationChange) => void;
  readBinding?: (libraryPath: string) => LockedBinding | undefined;
}

/** 在内存副本上完成校验和密钥加密，正式配置只通过一次 store 替换提交。 */
export function createModelConfigurationDraft(snapshot: Record<string, unknown>): ModelConfigurationStore {
  const data = structuredClone(snapshot);
  return {
    store: data,
    get: key => data[key],
    set: (key, value) => { data[key] = value; },
    delete: key => { delete data[key]; },
  };
}

/** 确认仅授权本次端点变更；提交前重新读取全部绑定，新增绑定会使旧确认失效。 */
export class ModelConfigurationService {
  private readonly options: ServiceOptions;
  private readonly confirmations = new Map<string, { fingerprint: string; expiresAt: number }>();

  constructor(options: ServiceOptions) {
    this.options = options;
  }

  save(change: ModelConfigurationChange, confirmationToken?: string): ModelConfigurationSaveResult {
    const draft = createModelConfigurationDraft(this.options.store.store);
    const currentHub = readModelHub(createModelConfigurationDraft(this.options.store.store));
    const prepared = this.options.prepare(change, draft);
    const nextHub = prepared.hub;
    const previousEndpoints = endpoints(currentHub);
    const changed = [...endpoints(nextHub)].filter(([source, endpoint]) => previousEndpoints.get(source) !== endpoint);
    const impacts: ModelConnectionImpact[] = [];
    const bindings: Array<{ libraryPath: string; profileHash: string }> = [];
    if (changed.length) {
      const nextEndpoints = new Map(changed);
      for (const library of this.options.libraries()) {
        const binding = (this.options.readBinding ?? readLockedBinding)(library.path);
        if (!binding || !nextEndpoints.has(binding.sourceId)) continue;
        const nextEndpoint = nextEndpoints.get(binding.sourceId)!;
        if (nextEndpoint === binding.endpoint) continue;
        bindings.push({ libraryPath: library.path, profileHash: binding.profileHash });
        impacts.push({
          libraryPath: library.path,
          libraryName: library.alias || path.basename(library.path),
          model: binding.model,
          previousEndpoint: binding.endpoint,
          nextEndpoint,
        });
      }
    }
    const fingerprint = createHash('sha256').update(JSON.stringify({
      changed: changed.sort(([a], [b]) => a.localeCompare(b)),
      previous: [...previousEndpoints].sort(([a], [b]) => a.localeCompare(b)),
      bindings: bindings.sort((a, b) => a.libraryPath.localeCompare(b.libraryPath)),
    })).digest('hex');
    const confirmation = confirmationToken ? this.confirmations.get(confirmationToken) : undefined;
    if (impacts.length && (!confirmation || confirmation.expiresAt < Date.now() || confirmation.fingerprint !== fingerprint)) {
      if (confirmationToken) this.confirmations.delete(confirmationToken);
      for (const [token, entry] of this.confirmations) if (entry.expiresAt < Date.now()) this.confirmations.delete(token);
      if (this.confirmations.size >= 100) this.confirmations.delete(this.confirmations.keys().next().value!);
      const token = randomUUID();
      this.confirmations.set(token, { fingerprint, expiresAt: Date.now() + 5 * 60_000 });
      return { status: 'confirmation-required', impacts, confirmationToken: token };
    }
    this.options.store.store = draft.store;
    if (confirmationToken) this.confirmations.delete(confirmationToken);
    this.options.afterSave(change);
    return { status: 'saved', ...prepared };
  }
}

function endpoints(hub: ModelHub): Map<string, string> {
  return new Map([
    ['ollama', normalizeEndpointIdentity(hub.ollamaEndpoint || 'http://127.0.0.1:11434')],
    ...hub.providers.map(provider => [provider.id, provider.endpoint ? normalizeEndpointIdentity(provider.endpoint) : ''] as [string, string]),
  ]);
}

/** 目录请求只消费临时地址和密钥，跨端点不复用旧密钥，不更新正式模型目录。 */
export async function fetchModelProviderCatalog(store: ModelConfigurationStore, id: string, draft?: ModelProviderCatalogDraft) {
  const snapshot = createModelConfigurationDraft(store.store);
  const credentials = resolveProviderCredentials(snapshot, id);
  const hub = readModelHub(snapshot);
  const provider = hub.providers.find(entry => entry.id === id);
  if (!provider) throw new Error('未知的模型厂商。');
  const endpoint = draft ? normalizeEndpointIdentity(draft.endpoint) : credentials.endpoint;
  const sameEndpoint = endpoint && credentials.endpoint && normalizeEndpointIdentity(endpoint) === normalizeEndpointIdentity(credentials.endpoint);
  const apiKey = draft?.apiKey?.trim() || (sameEndpoint ? credentials.apiKey : undefined);
  if (!apiKey) throw new Error('当前草稿连接需要 API Key；修改地址后请重新填写密钥。');
  return { result: await fetchRemoteProviderModels(endpoint, apiKey, provider.api), hub };
}

/** 影响检查只读现有 SQLite，不创建表、不触发旧向量迁移。 */
function readLockedBinding(libraryPath: string): LockedBinding | undefined {
  if (!fs.existsSync(libraryPath)) throw new Error(`资料库“${path.basename(libraryPath)}”当前不可访问，无法核对连接影响。请恢复目录后重试。`);
  const databasePath = path.join(libraryPath, '.menghan-meta', 'index.db');
  if (!fs.existsSync(databasePath)) return undefined;
  const database = new Database(databasePath, { readonly: true });
  try {
    const active = readActiveGeneration(database);
    if (active) {
      const profile = generationProfile(active);
      return { profileHash: profile.profileHash, sourceId: profile.sourceId, endpoint: profile.endpointIdentity, model: profile.requestedModel };
    }
    if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'material_embedding_profile'").get()) return undefined;
    const row = database.prepare("SELECT profile_hash, source_id, endpoint_identity, requested_model FROM material_embedding_profile WHERE singleton_id = 1 AND state = 'LOCKED'").get() as { profile_hash: string; source_id: string; endpoint_identity: string; requested_model: string } | undefined;
    return row ? { profileHash: row.profile_hash, sourceId: row.source_id, endpoint: normalizeEndpointIdentity(row.endpoint_identity), model: row.requested_model } : undefined;
  } finally {
    database.close();
  }
}
