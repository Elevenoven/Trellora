import { safeStorage } from 'electron';

export type ParsingEngine = 'mammoth' | 'mineru';

export interface ParsingConfig {
  engine: ParsingEngine;
  mineruEndpoint: string;
  cloudParsingConsent: boolean;
  hasMineruKey: boolean;
}

interface ParsingStore {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}

const parsingConfigKey = 'parsing';
const parsingSecretKey = 'parsingSecret';

export const defaultParsingConfig: ParsingConfig = {
  engine: 'mammoth',
  mineruEndpoint: '',
  cloudParsingConsent: true,
  hasMineruKey: false,
};

/** 读取解析配置；密钥不回显，仅以 hasMineruKey 表达是否已保存。 */
export function readParsingConfig(store: ParsingStore): ParsingConfig {
  const stored = store.get(parsingConfigKey);
  const record = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
  return {
    // Historical local-parser preferences migrate to the Mammoth route.
    engine: record.engine === 'mineru' ? 'mineru' : 'mammoth',
    mineruEndpoint: typeof record.mineruEndpoint === 'string' ? record.mineruEndpoint : '',
    // 历史版本要求额外确认；现在默认同意，避免隐藏的旧值阻断 PDF 解析。
    cloudParsingConsent: true,
    hasMineruKey: Boolean(store.get(parsingSecretKey)),
  };
}

/** 供主进程内部调用 MinerU 时取用解密后的密钥；渲染进程拿不到明文。 */
export function readMineruApiKey(store: ParsingStore): string | undefined {
  const encrypted = store.get(parsingSecretKey);
  if (typeof encrypted !== 'string' || !encrypted || !safeStorage.isEncryptionAvailable()) return undefined;
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  } catch {
    return undefined;
  }
}

export function saveParsingConfig(store: ParsingStore, patch: Partial<ParsingConfig> & { mineruApiKey?: string | null }): ParsingConfig {
  const current = readParsingConfig(store);
  const next: ParsingConfig = {
    // `engine` is kept for compatibility with previously saved preferences.
    // Routing is decided by file type: DOCX -> Mammoth, PDF -> MinerU.
    engine: patch.engine === undefined ? current.engine : patch.engine === 'mineru' ? 'mineru' : 'mammoth',
    mineruEndpoint: typeof patch.mineruEndpoint === 'string' ? normalizeMineruEndpoint(patch.mineruEndpoint) : current.mineruEndpoint,
    cloudParsingConsent: true,
    hasMineruKey: current.hasMineruKey,
  };
  const enteredKey = typeof patch.mineruApiKey === 'string' ? patch.mineruApiKey.trim() : '';
  if (enteredKey) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，API 密钥未保存。');
    store.set(parsingSecretKey, safeStorage.encryptString(enteredKey).toString('base64'));
    next.hasMineruKey = true;
  }
  store.set(parsingConfigKey, {
    engine: next.engine,
    mineruEndpoint: next.mineruEndpoint,
    cloudParsingConsent: next.cloudParsingConsent,
  });
  return next;
}

function normalizeMineruEndpoint(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('MinerU API 地址格式无效。');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('MinerU API 地址必须是不含账号、查询参数或锚点的 HTTP/HTTPS 地址。');
  }
  return trimmed.replace(/\/+$/u, '');
}
