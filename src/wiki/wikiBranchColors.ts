import type { WikiMapNode } from './wikiTypes';

const branchColors = [
  'var(--accent-knowledge)',
  'var(--accent-ai)',
  'var(--accent-primary)',
  'var(--accent-violet)',
  'var(--accent-coral)',
  'var(--accent-slate)',
];

/** 按一级章节 ID 着色，后代继承；折叠、搜索和调整顺序不会换色。 */
export function createWikiBranchColorMap(nodes: readonly WikiMapNode[]): Map<string, string> {
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  // 用稳定 ID 排序分配色阶，前六个章节各用一色，避免短树的哈希撞色。
  const chapters = nodes.filter(node => node.parentId && nodeById.get(node.parentId)?.parentId === null)
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const colors = new Map(chapters.map((node, index) => [node.id, branchColors[index % branchColors.length]]));
  for (const node of nodes) {
    const trail = new Set<string>();
    let current: WikiMapNode | undefined = node;
    let color = 'var(--accent-primary)';
    while (current && !trail.has(current.id)) {
      const cached = colors.get(current.id);
      if (cached) { color = cached; break; }
      trail.add(current.id);
      if (!current.parentId) break;
      current = nodeById.get(current.parentId);
    }
    trail.forEach(id => colors.set(id, color));
  }
  return colors;
}
