import fs from 'node:fs';
import path from 'node:path';
import type { MaterialsDocument } from '../materialsLibrary';
import { assertInsideDirectory } from '../pathGuards';
import { atomicWriteJson } from './pathLayout';

/** Authorization belongs to one imported document revision, never to an API key. */
export class CloudAuthorization {
  private file(libraryPath: string): string {
    return assertInsideDirectory(path.join(libraryPath, '.menghan-meta', 'cloud-authorization.json'), libraryPath);
  }
  private read(libraryPath: string): Record<string, { contentHash: string; authorizedAt: string }> {
    try {
      const file = this.file(libraryPath);
      if (fs.statSync(file).size > 2 * 1024 * 1024) return {};
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      return value?.schemaVersion === 1 && value.documents && typeof value.documents === 'object' ? value.documents : {};
    } catch { return {}; }
  }
  has(libraryPath: string, document: Pick<MaterialsDocument, 'id' | 'contentHash'>): boolean {
    return this.read(libraryPath)[document.id]?.contentHash === document.contentHash;
  }
  authorize(libraryPath: string, documents: Array<Pick<MaterialsDocument, 'id' | 'contentHash'>>): void {
    const entries = this.read(libraryPath);
    for (const document of documents) entries[document.id] = { contentHash: document.contentHash, authorizedAt: new Date().toISOString() };
    const file = this.file(libraryPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    atomicWriteJson(this.file(libraryPath), { schemaVersion: 1, documents: entries });
  }
}

export const cloudAuthorizationRequired = () => ({ code: 'CLOUD_AUTHORIZATION_REQUIRED', message: '文件已保存在本地。点击开始解析并确认上传至 MinerU 后继续。', retryable: false });
