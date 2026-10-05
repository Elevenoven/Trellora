import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { transpileLocalModules } from './lib/transpile-local.mjs';

const root = process.cwd();
const temporary = path.resolve('.package-staging', `memory-pagination-${process.pid}-${Date.now()}`);
const compiled = path.join(temporary, 'compiled');
let owner;
const checks = [];
try {
  transpileLocalModules(root, compiled, ['electron/knowledge/memory/memoryWriteService.ts',
    'electron/knowledge/memory/memoryTopicService.ts', 'electron/knowledge/memory/memoryAffinityService.ts']);
  const load = file => import(pathToFileURL(path.join(compiled, file.replace(/\.ts$/u, '.js'))).href);
  const { QaMemoryDatabase } = await load('electron/knowledge/qaMemoryDatabase.ts');
  const { MemoryScopeResolver } = await load('electron/knowledge/memory/memoryScope.ts');
  const { MemoryWriteService } = await load('electron/knowledge/memory/memoryWriteService.ts');
  const { MemoryTopicService } = await load('electron/knowledge/memory/memoryTopicService.ts');
  const { MemoryAffinityService } = await load('electron/knowledge/memory/memoryAffinityService.ts');
  owner = new QaMemoryDatabase();
  const storage = path.join(temporary, 'storage');
  const writer = new MemoryWriteService(owner, storage);
  const topics = new MemoryTopicService(owner, storage);
  const documents = new MemoryAffinityService(owner, storage);
  const db = owner.getDatabase(storage);
  const scopeFor = (name, principal) => {
    const workspace = path.join(temporary, name); mkdirSync(workspace, { recursive: true });
    const resolver = new MemoryScopeResolver({ getActiveWorkspacePath: () => workspace,
      listRegisteredWorkspacePaths: () => [workspace], getPrincipalId: () => principal });
    const scope = resolver.resolveActive().scope;
    writer.updateWorkspaceConfig(scope, { enabled: true });
    return scope;
  };
  const scope = scopeFor('workspace', 'principal-page');
  const otherPrincipal = scopeFor('workspace', 'principal-other');
  const otherWorkspace = scopeFor('another-workspace', 'principal-page');
  const now = '2026-10-04T00:00:00.000Z';
  const rows = [];
  const insertItem = db.prepare(`INSERT INTO memory_items (id,workspace_id,principal_id,kind,content,topic,normalized_key,
    importance,origin,status,valid_from,memory_generation,created_at,updated_at,proposal_action,review_reason,write_protection)
    VALUES (?,?,?,?,?,?,?,3,?,?,?,0,?,?,?,?, 'none')`);
  db.transaction(() => {
    for (const [target, prefix, count] of [[scope, 'owned', 401], [otherPrincipal, 'foreign', 25], [otherWorkspace, 'other', 23]]) {
      for (let index = 0; index < count; index++) {
        const id = `${prefix}-${String(index).padStart(5, '0')}`, kind = index % 2 ? 'profile' : 'fact';
        const status = ['active', 'pending', 'archived'][index % 3];
        insertItem.run(id, target.workspaceId, target.principalId, kind, `隔离分页验收记录${index}`, '分页验收', id,
          status === 'pending' ? 'extracted' : 'manual', status, now, now, now,
          status === 'pending' ? 'add' : null, status === 'pending' ? 'INFERRED_FACT' : null);
        if (target === scope) rows.push({ id, kind, status });
      }
    }
  })();
  const first = writer.listPage(scope, { pageSize: 10 });
  const second = writer.listPage(scope, { page: 2, pageSize: 10 });
  assert.equal(first.total, 401); assert.equal(first.totalPages, 41); assert.equal(first.items.length, 10);
  assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 20);
  const allIds = [];
  for (let page = 1; page <= first.totalPages; page++) allIds.push(...writer.listPage(scope, { page, pageSize: 10 }).items.map(item => item.id));
  assert.deepEqual(allIds, rows.map(row => row.id).sort().reverse());
  checks.push('all pages cover 401 tied-time records exactly once with deterministic ID ordering');
  const expected = rows.filter(row => row.kind === 'profile' && row.status === 'pending');
  const filtered = writer.listPage(scope, { page: 2, pageSize: 7, kinds: ['profile'], statuses: ['pending'] });
  assert.equal(filtered.total, expected.length);
  assert.ok(filtered.items.every(item => item.kind === 'profile' && item.status === 'pending'));
  assert.deepEqual(writer.getItemCounts(scope), { active: 134, pending: 134, all: 401 });
  checks.push('kind/status predicates apply to both COUNT and rows; global counts do not depend on the current page');
  assert.equal(writer.listPage(scope, { pageSize: 100000 }).items.length, 200);
  assert.equal(writer.listPage(scope).pageSize, 50);
  for (const value of [NaN, Infinity, 'untrusted']) assert.equal(writer.listPage(scope, { pageSize: value }).pageSize, 50);
  assert.equal(writer.listPage(scope, { page: -10, pageSize: -10 }).page, 1);
  const last = writer.listPage(scope, { page: Number.MAX_SAFE_INTEGER, pageSize: 10 });
  assert.equal(last.page, 41); assert.equal(last.items.length, 1);
  writer.delete(scope, last.items[0].id);
  const fallback = writer.listPage(scope, { page: 41, pageSize: 10 });
  assert.equal(fallback.page, 40); assert.equal(fallback.items.length, 10);
  checks.push('oversized page requests return at most 200; invalid sizes normalize and deleted final pages clamp to the last real page');
  assert.ok(writer.listPage(scope, { pageSize: 200, workspaceId: otherWorkspace.workspaceId, principalId: otherPrincipal.principalId }).items.every(item => item.id.startsWith('owned-')));
  assert.equal(writer.listPage(otherPrincipal).total, 25);
  assert.equal(writer.listPage(otherWorkspace).total, 23);
  checks.push('shared-database workspace/principal isolation is enforced for page rows and counts; caller scope fields are ignored');
  const cursorFirst = writer.list(scope, { limit: 20 });
  const cursorSecond = writer.list(scope, { limit: 20, cursor: cursorFirst.nextCursor });
  assert.equal(new Set([...cursorFirst.items, ...cursorSecond.items].map(item => item.id)).size, 40);
  assert.equal(writer.list(scope).items.length, 50);
  checks.push('the original cursor API and its default limit remain compatible');
  const insertTopic = db.prepare(`INSERT INTO memory_topic_stats
    (id,workspace_id,principal_id,normalized_key,topic,aliases_json,hits,first_seen_at,last_seen_at,created_at,updated_at)
    VALUES (?,?,?,?,?,'[]',2,?,?,?,?)`);
  const insertDocument = db.prepare(`INSERT INTO memory_doc_affinities
    (id,workspace_id,principal_id,document_id,title,hits,first_used_at,last_used_at) VALUES (?,?,?,?,?,2,?,?)`);
  db.transaction(() => {
    for (const [target, prefix, count] of [[scope, 'owned', 260], [otherPrincipal, 'foreign', 15]]) {
      for (let index = 0; index < count; index++) {
        const id = `${prefix}-${index}`;
        insertTopic.run(`topic-${id}`, target.workspaceId, target.principalId, id, `企业技术主题${index}`, now, now, now, now);
        insertDocument.run(`affinity-${id}`, target.workspaceId, target.principalId, `document-${id}`, `企业技术文档${index}`, now, now);
      }
    }
  })();
  for (const service of [topics, documents]) {
    const page1 = service.listPage(scope, { pageSize: 10 }), page2 = service.listPage(scope, { page: 2, pageSize: 10 });
    assert.equal(page1.total, 260); assert.equal(page1.items.length, 10);
    assert.equal(new Set([...page1.items, ...page2.items].map(item => item.id ?? item.documentId)).size, 20);
    assert.equal(service.listPage(scope, { pageSize: 100000 }).items.length, 200);
    assert.equal(service.listPage(otherPrincipal).total, 15);
  }
  assert.equal(topics.listCandidates(scope).length, 40);
  assert.equal(documents.list(scope).length, 50);
  checks.push('topics/documents page beyond their old display limits while preserving model candidate and affinity limits');
  writer.clear(scope);
  assert.deepEqual(writer.listPage(scope, { page: 10 }), { items: [], total: 0, page: 1, pageSize: 50, totalPages: 1 });
  assert.equal(topics.listPage(scope).total, 0); assert.equal(documents.listPage(scope).total, 0);
  assert.equal(writer.listPage(otherPrincipal).total, 25);
  assert.equal(db.pragma('quick_check', { simple: true }), 'ok'); assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  checks.push('empty/cleared pages normalize to page one without changing other owners; database and foreign keys remain valid');
  mkdirSync(path.resolve('docs/verification'), { recursive: true });
  writeFileSync(path.resolve('docs/verification/memory-pagination.json'), JSON.stringify({ verifiedAt: new Date().toISOString(),
    checks, method: 'real scoped SQLite services; isolated data, 401 owned memories and separate owners, 260 topics/documents',
    maximumReturnedItems: 200, defaultPageSize: 50, originalUserDataModified: false, databaseIntegrity: 'ok' }, null, 2));
  console.log(`Memory pagination acceptance passed (${checks.length} groups)`);
} finally {
  owner?.closeAll();
  assert.equal(path.dirname(temporary), path.resolve('.package-staging'));
  rmSync(temporary, { recursive: true, force: true });
}
