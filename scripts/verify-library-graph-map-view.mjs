import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// 地图视图纯函数单测（方案 §5）：与 verify-knowledge-map-view.mjs 同模式，esbuild bundle 后直接断言。
const rootDir = process.cwd();
const outFile = path.join(rootDir, '.package-staging', 'verify-library-graph-map-view', 'view.mjs');
await build({ entryPoints: [path.join(rootDir, 'src', 'utils', 'libraryGraphMapView.ts')], outfile: outFile, bundle: true, platform: 'node', format: 'esm' });
const view = await import(pathToFileURL(outFile).href);

// ---------------------------------------------------------------------------
// 确定性调色板与尺寸映射
// ---------------------------------------------------------------------------

assert.equal(view.hashPaletteColor('c-0-0000'), view.hashPaletteColor('c-0-0000'), '着色必须确定性');
assert.notEqual(view.hashPaletteColor('c-0-0000'), undefined);
const entitySizes = [0, 1, 4, 100].map((degree) => view.entityNodeSize(degree));
assert.ok(entitySizes.every((size, index) => index === 0 || size >= entitySizes[index - 1]), '实体尺寸必须随 degree 单调不减');
assert.ok(entitySizes.every((size) => size >= 8 && size <= 34), '实体尺寸必须在 8~34px');
assert.ok(view.communityNodeSize(100) > view.communityNodeSize(2), '社区尺寸必须随成员数增大');
assert.ok(view.relationEdgeWidth(1) >= 1 && view.relationEdgeWidth(1000) <= 6, '边宽必须钳制在 1~6px');

// ---------------------------------------------------------------------------
// 测试载荷：两社区 + 跨社区边
// ---------------------------------------------------------------------------

const payload = {
  status: { graphKey: 'g', engine: 'leiden', levels: 2, entityCount: 4, relationCount: 4, communityCount: 3, summaryCoverage: 2, summaryGeneratedAt: '', vectorCoverage: 0, vectorGeneratedAt: '', importedAt: '' },
  entities: [
    { canonicalKey: 'a1', mention: '实体A1', type: 'person', description: '', degree: 3, communityId: 'c0', docIds: ['d1'] },
    { canonicalKey: 'b1', mention: '实体B1', type: 'person', description: '', degree: 3, communityId: 'c1', docIds: ['d2'] },
    { canonicalKey: 'a2', mention: '实体A2', type: 'concept', description: '', degree: 2, communityId: 'c0', docIds: ['d1'] },
    { canonicalKey: 'b2', mention: '实体B2', type: 'concept', description: '', degree: 2, communityId: 'c1', docIds: ['d2'] },
  ],
  edges: [
    { sourceKey: 'a1', targetKey: 'a2', weight: 3, kinds: ['协作'] },
    { sourceKey: 'b1', targetKey: 'b2', weight: 2, kinds: ['依赖'] },
    { sourceKey: 'a1', targetKey: 'b1', weight: 4, kinds: ['跨域'] },
    { sourceKey: 'a2', targetKey: 'b2', weight: 1, kinds: ['跨域'] },
  ],
  communities: [
    { communityId: 'c0', level: 0, parentId: null, memberCount: 2, memberKeys: ['a1', 'a2'], summary: '社区零。', tokens: 10 },
    { communityId: 'c1', level: 0, parentId: null, memberCount: 2, memberKeys: ['b1', 'b2'], summary: '社区一。', tokens: 10 },
    { communityId: 'c10', level: 1, parentId: 'c0', memberCount: 2, memberKeys: ['a1', 'a2'], summary: '', tokens: 0 },
  ],
  communityEdges: [
    { sourceCommunityId: 'c0', targetCommunityId: 'c1', weight: 5, edgeCount: 2 },
    { sourceCommunityId: 'c0', targetCommunityId: 'c9', weight: 9, edgeCount: 1 },
  ],
  truncated: false,
};

// ---------------------------------------------------------------------------
// 实体视图与钻取
// ---------------------------------------------------------------------------

const entityView = view.createEntityViewElements(payload);
assert.equal(entityView.nodes.length, 4, '实体视图必须包含全部实体');
assert.equal(entityView.edges.length, 4, '实体视图必须包含全部保留边');
assert.equal(entityView.nodes[0].id, 'entity:a1', '节点 id 必须加 entity: 前缀');
assert.equal(entityView.edges[0].label, '协作', '边标签取首个 kind');

const drilled = view.buildCommunityDrillDown(payload, 'c0');
assert.deepEqual(drilled.nodes.map((node) => node.ref).sort(), ['a1', 'a2'], '钻取只画该社区成员');
assert.equal(drilled.edges.length, 1, '钻取只保留两端都在社区内的边');
assert.equal(drilled.edges[0].source, 'entity:a1');

const drilledSub = view.buildCommunityDrillDown(payload, 'c10');
assert.deepEqual(drilledSub.nodes.map((node) => node.ref).sort(), ['a1', 'a2'], '子社区钻取必须走 memberKeys（实体归属字段存的是 level0 id）');
assert.equal(drilledSub.edges.length, 1, '子社区钻取边过滤与实体视图一致');
const drilledMissing = view.buildCommunityDrillDown(payload, 'c-none');
assert.equal(drilledMissing.nodes.length, 0, '未知社区钻取返回空元素而非全图');
assert.equal(drilledMissing.edges.length, 0, '未知社区钻取不得残留边');

// ---------------------------------------------------------------------------
// 社区视图：聚合边过滤未知社区 + 层级边
// ---------------------------------------------------------------------------

const communityView = view.createCommunityViewElements(payload);
assert.equal(communityView.nodes.length, 3, '社区视图包含 level 0/1 社区');
const aggregate = communityView.edges.find((edge) => edge.kind === 'community');
assert.deepEqual({ id: aggregate.id, width: aggregate.width > 1 }, { id: 'community:c0->c1', width: true }, '聚合边只保留载荷内社区（c9 必须被过滤）');
assert.equal(communityView.edges.filter((edge) => edge.kind === 'community').length, 1, '未知社区的聚合边不得渲染');
const hierarchy = communityView.edges.filter((edge) => edge.kind === 'hierarchy');
assert.equal(hierarchy.length, 1, 'level1→level0 父子边必须渲染');
assert.equal(hierarchy[0].source, 'community:c10');
assert.equal(hierarchy[0].target, 'community:c0');
assert.equal(communityView.nodes.find((node) => node.ref === 'c0').label, '实体A1', '社区画布标签取头部成员实体名，与实体视图简洁命名一致');
assert.equal(communityView.nodes.find((node) => node.ref === 'c10').label, '实体A1 · 子社区', '子社区标签加后缀区分同名父子社区');
assert.equal(view.communityShortLabel({ communityId: 'c9', level: 0, parentId: null, memberCount: 0, memberKeys: [], summary: '', tokens: 0 }), '社区 c9', '无成员社区回退到 id 标签');

// ---------------------------------------------------------------------------
// 文档筛选（左侧多选面板）
// ---------------------------------------------------------------------------

assert.equal(view.applyDocumentFilter(payload, new Set()), payload, '空选择 = 不筛选，原样返回载荷');
const docFiltered = view.applyDocumentFilter(payload, new Set(['d1']));
assert.deepEqual(docFiltered.entities.map((entity) => entity.canonicalKey), ['a1', 'a2'], '文档筛选只保留 docIds 命中的实体');
assert.equal(docFiltered.edges.length, 1, '文档筛选只保留两端可见的边');
assert.deepEqual(docFiltered.communities.map((community) => community.communityId), ['c0', 'c10'], '无可见成员的社区必须剔除');
assert.equal(docFiltered.communities[0].memberCount, 2, '社区成员数按可见成员重算');
assert.equal(docFiltered.communityEdges.length, 0, '跨社区聚合边在可见集内重聚合（同社区边不聚合）');
const docFilteredView = view.createCommunityViewElements(docFiltered);
assert.equal(docFilteredView.edges.filter((edge) => edge.kind === 'hierarchy').length, 1, '筛选后父子层级边仍完整');
assert.equal(docFilteredView.nodes.length, 2, '筛选后社区视图只画可见社区');

// ---------------------------------------------------------------------------
// 查询辅助与空态
// ---------------------------------------------------------------------------

assert.equal(view.findEntity(payload, 'a1').mention, '实体A1');
assert.equal(view.findEntity(payload, '不存在'), null);
assert.equal(view.findCommunity(payload, 'c0').summary, '社区零。');
assert.equal(view.getEntityRelatedEdges(payload, 'a1').length, 2, '相关边必须覆盖出边与入边');
assert.deepEqual(view.getEntityRelatedEdges(payload, 'a2').map((row) => row.otherKey).sort(), ['a1', 'b2']);
assert.ok(view.communityTitle(payload.communities[0]).includes('a1'), '社区标题以首个成员命名');
assert.equal(view.getLibraryGraphEmptyState({ hasLibrary: false, payload: null }), 'no-library');
assert.equal(view.getLibraryGraphEmptyState({ hasLibrary: true, payload: null }), 'no-projection');
assert.equal(view.getLibraryGraphEmptyState({ hasLibrary: true, payload: { ...payload, entities: [], communities: [] } }), 'no-entities');
assert.equal(view.getLibraryGraphEmptyState({ hasLibrary: true, payload }), null);

console.log('verify-library-graph-map-view: 全部断言通过');
