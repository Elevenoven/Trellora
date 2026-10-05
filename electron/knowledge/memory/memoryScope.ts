import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { MemoryScope, TrustedMemoryScope, TrustedMemoryScopeContext } from './memoryTypes';

const trustedScopes = new WeakSet<object>();
const LOCAL_PRINCIPAL_STORE_KEY = 'memoryPrincipalId';
const WORKSPACE_ID_PREFIX = 'workspace:';
const PRINCIPAL_ID_PREFIX = 'local-principal-';

export interface MemoryPrincipalStore {
  get(key: string): unknown;
  set(key: string, value: string): void;
}

export interface MemoryScopeResolverDependencies {
  getActiveWorkspacePath(): string | undefined;
  listRegisteredWorkspacePaths(): readonly string[];
  getPrincipalId(): string;
}

export class MemoryScopeResolutionError extends Error {
  constructor(
    readonly code:
      | 'MEMORY_WORKSPACE_NOT_ACTIVE'
      | 'MEMORY_WORKSPACE_NOT_REGISTERED'
      | 'MEMORY_PRINCIPAL_INVALID'
      | 'MEMORY_SCOPE_UNTRUSTED',
    message: string,
  ) {
    super(message);
  }
}

/**
 * Converts main-process workspace/account state into an opaque scope. It never
 * accepts workspaceId or principalId from a renderer request.
 */
export class MemoryScopeResolver {
  constructor(private readonly dependencies: MemoryScopeResolverDependencies) {}

  resolveActive(): TrustedMemoryScopeContext {
    const activePath = this.dependencies.getActiveWorkspacePath()?.trim();
    if (!activePath) {
      throw new MemoryScopeResolutionError('MEMORY_WORKSPACE_NOT_ACTIVE', '尚未选择可用于记忆的工作区。');
    }
    return this.resolveRegisteredPath(activePath);
  }

  /** Revalidates a durable job scope against the current registry and account. */
  revalidatePersistedScope(scope: MemoryScope): TrustedMemoryScopeContext | undefined {
    const principalId = normalizePrincipalId(this.dependencies.getPrincipalId());
    if (scope.principalId !== principalId) return undefined;
    const workspacePath = this.dependencies.listRegisteredWorkspacePaths()
      .map(normalizeWorkspacePath)
      .find((candidate) => createMemoryWorkspaceId(candidate) === scope.workspaceId);
    return workspacePath ? createTrustedContext(workspacePath, principalId) : undefined;
  }

  private resolveRegisteredPath(workspacePath: string): TrustedMemoryScopeContext {
    const normalizedPath = normalizeWorkspacePath(workspacePath);
    const workspaceId = createMemoryWorkspaceId(normalizedPath);
    const isRegistered = this.dependencies.listRegisteredWorkspacePaths()
      .map(normalizeWorkspacePath)
      .some((candidate) => createMemoryWorkspaceId(candidate) === workspaceId);
    if (!isRegistered) {
      throw new MemoryScopeResolutionError(
        'MEMORY_WORKSPACE_NOT_REGISTERED',
        '当前工作区未在主进程注册，不能访问长期记忆。',
      );
    }
    return createTrustedContext(normalizedPath, normalizePrincipalId(this.dependencies.getPrincipalId()));
  }
}

export function ensureLocalMemoryPrincipalId(store: MemoryPrincipalStore): string {
  const existing = store.get(LOCAL_PRINCIPAL_STORE_KEY);
  if (typeof existing === 'string' && isValidPrincipalId(existing)) return existing;
  const principalId = `${PRINCIPAL_ID_PREFIX}${randomUUID()}`;
  store.set(LOCAL_PRINCIPAL_STORE_KEY, principalId);
  return principalId;
}

export function createMemoryWorkspaceId(workspacePath: string): string {
  const canonicalPath = normalizeWorkspacePath(workspacePath).toLocaleLowerCase('en-US');
  return `${WORKSPACE_ID_PREFIX}${createHash('sha256').update(canonicalPath).digest('hex').slice(0, 48)}`;
}

export function assertTrustedMemoryScope(scope: MemoryScope): asserts scope is TrustedMemoryScope {
  if (!scope || typeof scope !== 'object' || !trustedScopes.has(scope)) {
    throw new MemoryScopeResolutionError(
      'MEMORY_SCOPE_UNTRUSTED',
      '记忆作用域必须由主进程从当前工作区和本地身份解析。',
    );
  }
}

function createTrustedContext(workspacePath: string, principalId: string): TrustedMemoryScopeContext {
  const scope = {
    workspaceId: createMemoryWorkspaceId(workspacePath),
    principalId,
  } as TrustedMemoryScope;
  trustedScopes.add(scope);
  Object.freeze(scope);
  return Object.freeze({ scope, workspacePath });
}

function normalizeWorkspacePath(workspacePath: string): string {
  return path.normalize(path.resolve(workspacePath.trim()));
}

function normalizePrincipalId(value: string): string {
  const principalId = value.trim();
  if (!isValidPrincipalId(principalId)) {
    throw new MemoryScopeResolutionError('MEMORY_PRINCIPAL_INVALID', '当前本地记忆身份无效。');
  }
  return principalId;
}

function isValidPrincipalId(value: string): boolean {
  return value.length > 0
    && value.length <= 200
    && Array.from(value).every((character) => (character.codePointAt(0) ?? 0) >= 0x20);
}
