import { createHash } from 'node:crypto';
import type {
  ContextMemoryAdapter,
  ContextMemoryRequest,
  ContextMemoryResult,
  SupplementalContextAdapter,
} from './contextMemoryTypes';

/**
 * Resolves one route-scoped memory adapter and combines it with the project
 * context adapter. It deliberately owns neither SQL nor Prompt rendering.
 */
export class ContextMemoryRegistry {
  constructor(
    private readonly projectAdapter: ContextMemoryAdapter,
    private readonly routeAdapters: readonly ContextMemoryAdapter[],
    private readonly supplementalAdapters: readonly SupplementalContextAdapter[] = [],
  ) {}

  async load(request: ContextMemoryRequest): Promise<ContextMemoryResult> {
    const routeMatches = this.routeAdapters.filter((adapter) => adapter.supports(request));
    if (routeMatches.length !== 1) {
      throw new Error(`ContextMemoryRegistry 路由 ${request.route} 需要且只能命中一个记忆 Adapter，实际 ${routeMatches.length} 个。`);
    }
    const adapters = [this.projectAdapter, routeMatches[0]].filter((adapter) => adapter.supports(request));
    const primaryResults = await Promise.all(adapters.map((adapter) => adapter.load(request)));
    const supplementalResults = await Promise.all(this.supplementalAdapters.map(async (adapter) => {
      try {
        if (!adapter.supports(request)) return undefined;
        return await adapter.load(request);
      } catch {
        return unavailableSupplementalResult(adapter.id);
      }
    }));
    const results = [...primaryResults, ...supplementalResults.filter((result): result is ContextMemoryResult => Boolean(result))];
    const materials = results.flatMap((result) => result.materials);
    const materialIds = new Set<string>();
    for (const material of materials) {
      if (materialIds.has(material.id)) throw new Error(`ContextMemoryRegistry 检测到重复 Material：${material.id}`);
      materialIds.add(material.id);
    }
    return {
      materials,
      version: createHash('sha256').update(JSON.stringify(results.map((result) => result.version)), 'utf8').digest('hex'),
      diagnostics: {
        source: results.map((result) => result.diagnostics.source).join('+'),
        loadedTurns: results.reduce((sum, result) => sum + result.diagnostics.loadedTurns, 0),
        loadedSummaries: results.reduce((sum, result) => sum + result.diagnostics.loadedSummaries, 0),
        recalledTurns: results.reduce((sum, result) => sum + result.diagnostics.recalledTurns, 0),
        staleItems: results.reduce((sum, result) => sum + result.diagnostics.staleItems, 0),
      },
    };
  }
}

function unavailableSupplementalResult(id: string): ContextMemoryResult {
  return {
    materials: [],
    version: `${id}:unavailable`,
    diagnostics: {
      source: `${id}:unavailable`,
      loadedTurns: 0,
      loadedSummaries: 0,
      recalledTurns: 0,
      staleItems: 1,
    },
  };
}
