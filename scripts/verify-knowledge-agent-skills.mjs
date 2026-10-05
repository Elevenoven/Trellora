import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-knowledge-agent-skills');
const workspaceDir = path.join(outDir, 'workspace');
const sourceDir = path.join(outDir, 'sources');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(workspaceDir, { recursive: true });
mkdirSync(sourceDir, { recursive: true });

// electron 打桩：依赖链（rerankAdapters → modelHub）仅在密钥读写时触碰
// safeStorage，mock store 下不会触发，这里给出安全缺省即可。
writeFileSync(
  path.join(outDir, 'electron-stub.cjs'),
  'module.exports = { safeStorage: { isEncryptionAvailable: () => false } };\n',
);

await build({
  stdin: {
    contents: `
      export { runKnowledgeAgentTurn } from './electron/knowledge/knowledgeAgentTurn';
      export { buildKnowledgeSkillsBlock } from './electron/knowledge/knowledgeAgentPrompt';
      export { createReadSkillTool } from './electron/knowledge/knowledgeTools/readSkillTool';
      export { resolveSkillDefinitions } from './electron/knowledge/skillDefinitionResolver';
      export { loadDirectorySkills, mergeKnowledgeSkillSources, parseSkillMarkdown, validateDirectorySkillMetadata, listSkillResourceFiles, readSkillResourceFile } from './electron/knowledge/skillDirectoryLoader';
      export { importAiSkillSource, buildAiSkillsOverview, createDirectorySkillFromForm, updateDirectorySkillDocument, exportDirectorySkillToZip, removeDirectoryRecursively } from './electron/knowledge/skillImportService';
      export { aiSkillWorkspaceDirectoryName } from './electron/knowledge/aiSkillWorkspace';
      export { ensureBundledSkills } from './electron/knowledge/bundledSkills';
      export { loadAssistantSkills, resolveAssistantSkillSelection } from './electron/knowledge/assistantSkills';
      export { defaultExtensionsSettings, validateExtensionsSettings } from './electron/knowledge/aiSettings';
      export { createAssistantChatPrompt } from './electron/knowledge/assistantTurn';
      export { ModelCallCoordinator } from './electron/knowledge/modelCallCoordinator';
      export { ModelCallBudgetGate } from './electron/knowledge/modelCallBudget';
      export { ensureMaterialsRoot, createMaterialsLibraryDirectory, importMaterialsDocuments, listMaterialsDocuments } from './electron/materialsLibrary';
    `,
    resolveDir: rootDir,
    loader: 'ts',
  },
  outfile: path.join(outDir, 'skills.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  alias: { electron: path.join(outDir, 'electron-stub.cjs') },
});

const {
  runKnowledgeAgentTurn,
  buildKnowledgeSkillsBlock,
  createReadSkillTool,
  resolveSkillDefinitions,
  loadDirectorySkills,
  mergeKnowledgeSkillSources,
  parseSkillMarkdown,
  validateDirectorySkillMetadata,
  listSkillResourceFiles,
  readSkillResourceFile,
  importAiSkillSource,
  buildAiSkillsOverview,
  createDirectorySkillFromForm,
  updateDirectorySkillDocument,
  exportDirectorySkillToZip,
  removeDirectoryRecursively,
  aiSkillWorkspaceDirectoryName,
  ensureBundledSkills,
  loadAssistantSkills,
  resolveAssistantSkillSelection,
  defaultExtensionsSettings,
  validateExtensionsSettings,
  createAssistantChatPrompt,
  ModelCallCoordinator,
  ModelCallBudgetGate,
  ensureMaterialsRoot,
  createMaterialsLibraryDirectory,
  importMaterialsDocuments,
  listMaterialsDocuments,
} = await import(pathToFileURL(path.join(outDir, 'skills.cjs')).href);

// 1. 搭建一个真实资料库目录（含一个 md 文档）。
const root = ensureMaterialsRoot(workspaceDir);
const created = createMaterialsLibraryDirectory(root, 'skills-lib', new Date(2026, 7, 28, 10, 0, 0));
const sourceFile = path.join(sourceDir, 'demo-note.md');
writeFileSync(sourceFile, '# 技能接入样例\n\n这是一份用于技能接入验证的样例文档。\n');
importMaterialsDocuments(created.path, [sourceFile]);
const documents = listMaterialsDocuments(created.path);
assert.ok(documents.length >= 1, '资料库应包含至少一个文档');

// 技能夹具：两条启用 + 一条停用（停用技能不得进目录）。
const SKILL_FIXTURES = [
  { id: 'skill_fix_knowledge', name: '知识问答', description: '当用户基于资料提出事实性问题时使用；当用户只是闲聊时不要使用。', instruction: '优先依据已选范围的资料作答；资料不足时明确说明。', generationStyle: 'factual', enabled: true, system: true },
  { id: 'skill_fix_learning', name: '学习规划', description: '当用户要求制定学习计划时使用；当用户只是查询单个事实时不要使用。', instruction: '给出循序渐进、可执行的学习步骤。', generationStyle: 'balanced', enabled: true, system: true },
  { id: 'skill_fix_disabled', name: '停用技能', description: '不应出现在目录中。', instruction: 'SECRET_DISABLED_BODY', generationStyle: 'balanced', enabled: false, system: false },
];
const skillInstructionById = new Map(
  SKILL_FIXTURES.filter((skill) => skill.enabled).map((skill) => [skill.id, skill.instruction]),
);

// 2. 单元：buildKnowledgeSkillsBlock 的投影契约。
{
  assert.equal(buildKnowledgeSkillsBlock({ selected: [], catalog: [] }), '', '无技能时应返回空串');
  const resolved = resolveSkillDefinitions(SKILL_FIXTURES, ['skill_fix_learning']);
  const block = buildKnowledgeSkillsBlock(resolved);
  assert.ok(block.includes('### 已选技能（必须遵守）'), '已选技能应带必须遵守标记');
  assert.ok(block.includes('给出循序渐进、可执行的学习步骤。'), '已选技能应注入指令全文');
  assert.ok(block.includes('### 可用技能目录'), '未选技能应进目录块');
  assert.ok(block.includes('知识问答'), '目录应列出未选技能');
  const catalogSection = block.slice(block.indexOf('### 可用技能目录'));
  assert.ok(!catalogSection.includes('学习规划'), '已选技能不得再出现在目录块');
  assert.ok(!block.includes('SECRET_DISABLED_BODY'), '停用技能不得出现');
  assert.ok(block.includes('read_skill'), '目录块应附匹配协议与工具指引');
}

// 3. 单元：read_skill 工具的命中 / 去重 / 未知技能语义。
{
  const resolved = resolveSkillDefinitions(SKILL_FIXTURES, []);
  const tool = createReadSkillTool(resolved, skillInstructionById);
  const hit = await tool.execute({ skill_name: '学习规划' }, {});
  assert.ok(hit.ok, '命中技能应成功');
  assert.ok(hit.observation.includes('给出循序渐进、可执行的学习步骤。'), '观察应含指令全文');
  assert.ok(hit.observation.includes('<skill'), '观察应为 XML 良构');
  assert.ok(hit.observation.includes('知识问答'), '观察应列出剩余技能');
  const duplicate = await tool.execute({ skill_name: ' 学习规划 ' }, {});
  assert.ok(duplicate.ok && duplicate.observation.includes('already_loaded'), '重复加载应返回短提示');
  const unknown = await tool.execute({ skill_name: '不存在' }, {});
  assert.ok(!unknown.ok, '未知技能应失败');
  assert.ok(unknown.observation.includes('<tool_error>') && unknown.observation.includes('知识问答'), '未知技能应列出可用技能');
}

// 4. 端到端公共输入（注入 mock 改写服务，保持脚本封闭）。
function createMockStore() {
  const data = new Map();
  return {
    get: (key) => data.get(key),
    set: (key, value) => { data.set(key, JSON.parse(JSON.stringify(value))); },
    delete: (key) => { data.delete(key); },
  };
}

function createCoordinator() {
  return new ModelCallCoordinator(new ModelCallBudgetGate({ maxModelCalls: 10 }), 32_000, 'react-turn', undefined, {
    providerKind: 'openai-compatible',
    model: 'mock-model',
  });
}

function createBaseInput() {
  return {
    event: {},
    request: { requestId: 'req-skills-1', userText: '帮我制定学习计划' },
    controller: new AbortController(),
    source: { libraryPath: created.path, label: 'skills-lib' },
    model: 'mock-model',
    provider: 'openai-compatible',
    providerConfig: { baseUrl: 'http://mock.local', apiKey: 'mock-key' },
    contextWindowTokens: 128_000,
    modelCallCoordinator: createCoordinator(),
    store: createMockStore(),
    emitTurnEvent: () => {},
    prepareMaterialSearchContext: async () => ({
      libraryPath: created.path,
      documents,
      hybridSearch: async () => ({ entries: [], timings: {} }),
      lexicalSearch: async () => ({ entries: [], timings: {} }),
      parentChunkById: new Map(),
      rerank: undefined,
    }),
    qaRecentTurns: [],
    qaSessionId: 'sess-skills-1',
    rewriteQuestion: async ({ question }) => ({ rewrite: question, shouldSplit: false, subQuestions: [question], model: 'mock-model', elapsedMs: 1 }),
  };
}

// 5. 端到端（目录 + 按需加载）：L1 常驻目录，模型调用 read_skill 加载指令。
{
  const capturedSystemPrompts = [];
  const capturedToolSchemas = [];
  const events = [];
  const traces = [];
  let callIndex = 0;
  const input = {
    ...createBaseInput(),
    emitTurnEvent: (payload) => events.push(payload),
    onDetailedTrace: (entry) => traces.push(entry),
    skills: resolveSkillDefinitions(SKILL_FIXTURES, []),
    skillInstructionById,
    transport: {
      capability: 'native-tools',
      chat: async (_config, { messages, tools }) => {
        callIndex += 1;
        capturedSystemPrompts.push(messages[0].content);
        capturedToolSchemas.push(tools.map((tool) => tool.name));
        if (callIndex === 1) {
          return { content: '', toolCalls: [{ id: 'tc-1', name: 'read_skill', arguments: { skill_name: '学习规划' } }] };
        }
        const toolMessage = messages.find((message) => message.role === 'tool' && message.toolCallId === 'tc-1');
        assert.ok(toolMessage && toolMessage.content.includes('给出循序渐进、可执行的学习步骤。'), '工具观察应回填指令全文');
        return { content: '已按学习规划技能作答。', toolCalls: [] };
      },
    },
  };
  const outcome = await runKnowledgeAgentTurn(input);
  assert.ok(outcome.result, '技能链路应产出回答');
  assert.ok(capturedSystemPrompts[0].includes('### 可用技能目录'), 'system prompt 应含技能目录');
  assert.ok(capturedSystemPrompts[0].includes('匹配协议'), 'system prompt 应含匹配协议');
  assert.ok(capturedToolSchemas[0].includes('read_skill'), '工具列表应含 read_skill');
  assert.equal(outcome.metrics.toolCalls, 1, '应记录一次工具调用');
  const skillEvents = events.filter((payload) => payload.type === 'tool' && payload.event.tool === 'knowledge_agent_skill');
  assert.ok(skillEvents.some((payload) => payload.event.state === 'started'), '应下发 read_skill started 事件');
  assert.ok(skillEvents.some((payload) => payload.event.state === 'completed' && payload.event.message.includes('学习规划')), '应下发 read_skill completed 事件');
  const skillsTrace = traces.find((entry) => entry.stage === 'skills' && entry.action === 'catalog');
  assert.ok(skillsTrace && skillsTrace.status === 'completed', '应落 skills/catalog 轨迹');
  assert.equal(skillsTrace.output.selectedCount, 0);
  assert.equal(skillsTrace.output.catalogCount, 2);
}

// 6. 端到端（已选预加载）：选中技能全文注入，不再出现在目录块。
{
  const capturedSystemPrompts = [];
  const input = {
    ...createBaseInput(),
    onDetailedTrace: () => {},
    skills: resolveSkillDefinitions(SKILL_FIXTURES, ['skill_fix_learning']),
    skillInstructionById,
    transport: {
      capability: 'native-tools',
      chat: async (_config, { messages }) => {
        capturedSystemPrompts.push(messages[0].content);
        return { content: '已遵循已选技能作答。', toolCalls: [] };
      },
    },
  };
  const outcome = await runKnowledgeAgentTurn(input);
  assert.ok(outcome.result, '已选技能链路应产出回答');
  const prompt = capturedSystemPrompts[0];
  assert.ok(prompt.includes('### 已选技能（必须遵守）'), '已选技能应注入必须遵守块');
  assert.ok(prompt.includes('给出循序渐进、可执行的学习步骤。'), '已选技能应注入指令全文');
  const catalogSection = prompt.slice(prompt.indexOf('### 可用技能目录'));
  assert.ok(!catalogSection.includes('学习规划'), '已选技能不得重复出现在目录块');
  assert.ok(catalogSection.includes('知识问答'), '其余启用技能仍应在目录块');
}

// 7. 端到端（无技能零回归）：不注入块、不注册工具，整轮正常完成。
{
  const capturedSystemPrompts = [];
  const capturedToolSchemas = [];
  const input = {
    ...createBaseInput(),
    onDetailedTrace: () => {},
    transport: {
      capability: 'native-tools',
      chat: async (_config, { messages, tools }) => {
        capturedSystemPrompts.push(messages[0].content);
        capturedToolSchemas.push(tools.map((tool) => tool.name));
        return { content: '无技能链路的回答。', toolCalls: [] };
      },
    },
  };
  const outcome = await runKnowledgeAgentTurn(input);
  assert.ok(outcome.result, '无技能链路应正常完成');
  assert.ok(!capturedSystemPrompts[0].includes('可用技能目录'), '无技能时不应注入目录块');
  assert.ok(!capturedToolSchemas[0].includes('read_skill'), '无技能时不应注册 read_skill');
}

// 8. 单元（P2）：SKILL.md frontmatter 解析与元数据校验。
{
  const parsed = parseSkillMarkdown('---\nname: 学习笔记\ndescription: "当用户整理笔记时使用；当用户要求修改文件时不要使用。"\n---\n\n请循序渐进地整理。\n');
  assert.ok(parsed, '合法 SKILL.md 应解析成功');
  assert.equal(parsed.name, '学习笔记');
  assert.ok(parsed.description.includes('当用户整理笔记时使用'), '引号包裹的标量应去引号');
  assert.equal(parsed.instructions, '请循序渐进地整理。');
  assert.equal(parseSkillMarkdown('# 无 frontmatter\n正文'), undefined, '缺 frontmatter 不得解析');
  assert.equal(parseSkillMarkdown('---\nname: 只有开头\n'), undefined, 'frontmatter 未闭合不得解析');
  assert.equal(
    parseSkillMarkdown('---\nname: 转义测试\ndescription: "第一行\\n第二行\\t\\\\路径"\n---\n\n正文').description,
    '第一行\n第二行\t\\路径',
    '双引号 YAML 标量应按 JSON 语义还原常见转义',
  );
  assert.ok(validateDirectorySkillMetadata({ name: '', description: 'x', instructions: 'y' }), '缺 name 应校验失败');
  assert.ok(validateDirectorySkillMetadata({ name: 'system-helper', description: 'x', instructions: 'y' }), '保留词应校验失败');
  assert.ok(validateDirectorySkillMetadata({ name: '非法<名', description: 'x', instructions: 'y' }), '非法字符应校验失败');
  assert.ok(validateDirectorySkillMetadata({ name: '合法', description: '', instructions: 'y' }), '缺 description 应校验失败');
  assert.ok(validateDirectorySkillMetadata({ name: '合法', description: 'x', instructions: '' }), '正文为空应校验失败');
  assert.equal(validateDirectorySkillMetadata({ name: '合法Name-1', description: 'x', instructions: 'y' }), undefined, '合法元数据应通过');
}

// 9. 单元（P2）：目录形态技能发现与资源文件读写边界。
const aiSkillRoot = path.join(workspaceDir, aiSkillWorkspaceDirectoryName);
const goodSkillDir = path.join(aiSkillRoot, 'learning-notes');
mkdirSync(path.join(goodSkillDir, 'refs'), { recursive: true });
writeFileSync(path.join(goodSkillDir, 'SKILL.md'), '---\nname: 学习笔记\ndescription: 当用户整理笔记时使用；当用户要求直接修改文件时不要使用。\n---\n\n请循序渐进，并引用模板参考。\n');
writeFileSync(path.join(goodSkillDir, 'refs', 'template.md'), '# 模板\n这是附加文档正文。\n');
writeFileSync(path.join(goodSkillDir, 'script.py'), 'print("should not be readable")\n');
const badSkillDir = path.join(aiSkillRoot, 'broken-skill');
mkdirSync(badSkillDir, { recursive: true });
writeFileSync(path.join(badSkillDir, 'SKILL.md'), '没有 frontmatter 的技能文件\n');
const plainDir = path.join(aiSkillRoot, 'plain-dir');
mkdirSync(plainDir, { recursive: true });
writeFileSync(path.join(plainDir, 'README.md'), '不是技能目录\n');
writeFileSync(path.join(aiSkillRoot, 'skill_fix_knowledge.md'), '---\nmanagedBy: "menghan-notes"\n---\n');

const directoryOutcome = loadDirectorySkills(workspaceDir);
{
  assert.equal(directoryOutcome.skills.length, 1, '应只发现一个合法目录技能');
  const dirSkill = directoryOutcome.skills[0];
  assert.equal(dirSkill.name, '学习笔记');
  assert.ok(dirSkill.instruction.includes('循序渐进'), '指令正文应完整解析');
  assert.ok(dirSkill.id.startsWith('skill_file_'), '目录技能 id 应用 skill_file_ 前缀');
  assert.equal(directoryOutcome.skipped.length, 1, '缺 frontmatter 应进 skipped');
  assert.ok(directoryOutcome.skipped[0].reason.includes('frontmatter'));

  const resources = listSkillResourceFiles(goodSkillDir);
  assert.deepEqual(resources, ['refs/template.md', 'script.py'], '资源清单应为相对路径且排除 SKILL.md');

  const okRead = readSkillResourceFile(goodSkillDir, 'refs/template.md');
  assert.ok(okRead.ok && okRead.content.includes('附加文档正文'), '合法文件应读取成功');
  assert.ok(!readSkillResourceFile(goodSkillDir, '../escape.md').ok, '路径穿越应被拒绝');
  assert.ok(!readSkillResourceFile(goodSkillDir, 'C:/Windows/win.ini').ok, '绝对路径应被拒绝');
  assert.ok(!readSkillResourceFile(goodSkillDir, 'script.py').ok, '非白名单扩展名应被拒绝');
  assert.ok(!readSkillResourceFile(goodSkillDir, 'refs/missing.md').ok, '不存在的文件应被拒绝');
}

// 10. 单元（P2）：设置技能与目录技能合并 + read_skill 的 file_path 语义。
{
  const resolved = resolveSkillDefinitions(SKILL_FIXTURES, []);
  const merged = mergeKnowledgeSkillSources({
    resolved,
    configInstructionById: skillInstructionById,
    directorySkills: directoryOutcome.skills,
  });
  const dirSkill = directoryOutcome.skills[0];
  assert.equal(merged.skills.catalog.length, 3, '目录应包含设置技能 + 目录技能');
  assert.equal(merged.mergedDirectoryCount, 1);
  assert.ok(merged.skillInstructionById.get(dirSkill.id).includes('循序渐进'), '目录技能指令应进查询表');
  assert.equal(merged.skillResourceRootById.get(dirSkill.id), dirSkill.basePath, '资源根应进查询表');
  // 与设置技能重名：设置技能优先，目录技能放弃并入。
  const clashDir = path.join(aiSkillRoot, 'knowledge-clash');
  mkdirSync(clashDir, { recursive: true });
  writeFileSync(path.join(clashDir, 'SKILL.md'), '---\nname: 知识问答\ndescription: 与设置技能同名。\n---\n\n不应被并入。\n');
  const clashMerged = mergeKnowledgeSkillSources({
    resolved,
    configInstructionById: skillInstructionById,
    directorySkills: loadDirectorySkills(workspaceDir).skills,
  });
  assert.equal(clashMerged.nameConflicts.length, 1, '同名目录技能应被放弃');
  assert.ok(!clashMerged.skills.catalog.some((entry) => entry.id.startsWith('skill_file_knowledge-clash')), '同名目录技能不得进目录');

  const tool = createReadSkillTool(merged.skills, merged.skillInstructionById, merged.skillResourceRootById);
  const load = await tool.execute({ skill_name: '学习笔记' }, {});
  assert.ok(load.ok && load.observation.includes('<available_files>'), '目录技能加载应列出附加文件');
  assert.ok(load.observation.includes('refs/template.md'));
  const fileRead = await tool.execute({ skill_name: '学习笔记', file_path: 'refs/template.md' }, {});
  assert.ok(fileRead.ok && fileRead.observation.includes('<skill_file'), 'file_path 应返回文件观察');
  assert.ok(fileRead.observation.includes('附加文档正文'));
  const duplicateFile = await tool.execute({ skill_name: '学习笔记', file_path: 'refs/template.md' }, {});
  assert.ok(duplicateFile.ok && duplicateFile.observation.includes('already_loaded'), '重复读同一文件应返回短观察');
  const traversal = await tool.execute({ skill_name: '学习笔记', file_path: '../../package.json' }, {});
  assert.ok(!traversal.ok && traversal.observation.includes('<tool_error>'), '路径穿越应返回错误观察');
  const noResourceRoot = await tool.execute({ skill_name: '知识问答', file_path: 'refs/template.md' }, {});
  assert.ok(!noResourceRoot.ok, '无资源根的设置技能不得按 file_path 读取');
}

// 11. 单元（P2）：技能块的 file_path 指引条件出现。
{
  const resolved = resolveSkillDefinitions(SKILL_FIXTURES, []);
  const withoutResource = buildKnowledgeSkillsBlock({ ...resolved, hasResourceSkills: false });
  const withResource = buildKnowledgeSkillsBlock({ ...resolved, hasResourceSkills: true });
  assert.ok(!withoutResource.includes('file_path'), '无目录技能时不得出现 file_path 指引');
  assert.ok(withResource.includes('file_path') && withResource.includes('<available_files>'), '有目录技能时应附 file_path 指引');
}

// 12. 端到端（P2）：目录技能合并后走完整 turn（L2 加载 + file_path 读文件）。
{
  const resolved = resolveSkillDefinitions(SKILL_FIXTURES, []);
  const merged = mergeKnowledgeSkillSources({
    resolved,
    configInstructionById: skillInstructionById,
    directorySkills: directoryOutcome.skills,
  });
  const capturedSystemPrompts = [];
  const events = [];
  let callIndex = 0;
  const input = {
    ...createBaseInput(),
    emitTurnEvent: (payload) => events.push(payload),
    onDetailedTrace: () => {},
    skills: merged.skills,
    skillInstructionById: merged.skillInstructionById,
    skillResourceRootById: merged.skillResourceRootById,
    transport: {
      capability: 'native-tools',
      chat: async (_config, { messages }) => {
        callIndex += 1;
        capturedSystemPrompts.push(messages[0].content);
        if (callIndex === 1) {
          return { content: '', toolCalls: [{ id: 'tc-1', name: 'read_skill', arguments: { skill_name: '学习笔记' } }] };
        }
        if (callIndex === 2) {
          return { content: '', toolCalls: [{ id: 'tc-2', name: 'read_skill', arguments: { skill_name: '学习笔记', file_path: 'refs/template.md' } }] };
        }
        return { content: '已按学习笔记技能与模板文件作答。', toolCalls: [] };
      },
    },
  };
  const outcome = await runKnowledgeAgentTurn(input);
  assert.ok(outcome.result, '目录技能链路应产出回答');
  const prompt = capturedSystemPrompts[0];
  assert.ok(prompt.includes('学习笔记'), 'system prompt 目录应含目录技能');
  assert.ok(prompt.includes('file_path'), 'system prompt 应含 file_path 指引');
  assert.equal(outcome.metrics.toolCalls, 2, '应记录两次工具调用');
  const skillEvents = events.filter((payload) => payload.type === 'tool' && payload.event.tool === 'knowledge_agent_skill');
  assert.ok(skillEvents.filter((payload) => payload.event.state === 'completed').length >= 2, '两次 read_skill 均应下发 completed 事件');
}

// 13. 单元（P1）：技能导入服务——归一化、校验、安全边界、停用与总览投影。
const JSZipModule = await import('jszip');
async function createSkillZip(entries) {
  const zip = new JSZipModule.default();
  for (const [name, content] of Object.entries(entries)) zip.file(name, content);
  return zip.generateAsync({ type: 'nodebuffer' });
}
const importConfigSkillNames = new Set(['知识问答', '学习规划']);
const countImportTempDirectories = () => readdirSync(aiSkillRoot).filter((name) => name.startsWith('.import-')).length;

{
  // 文件夹导入：SKILL.md + 附加文档，落盘为标准目录。
  const folderSource = path.join(sourceDir, 'import-folder');
  mkdirSync(path.join(folderSource, 'guide'), { recursive: true });
  writeFileSync(path.join(folderSource, 'SKILL.md'), '---\nname: 导入笔记\ndescription: 通过文件夹导入的技能。\n---\n\n按步骤整理。\n');
  writeFileSync(path.join(folderSource, 'guide', 'steps.md'), '第一步。\n');
  const folderResult = await importAiSkillSource({ kind: 'directory', path: folderSource }, { workspacePath: workspaceDir, existingConfigSkillNames: importConfigSkillNames });
  assert.equal(folderResult.ok, true, `文件夹导入应成功：${folderResult.error}`);
  assert.equal(folderResult.skillName, '导入笔记');
  assert.equal(folderResult.resourceFileCount, 1);
  assert.ok(existsSync(path.join(aiSkillRoot, '导入笔记', 'SKILL.md')), '导入应产出标准技能目录');
  assert.ok(existsSync(path.join(aiSkillRoot, '导入笔记', 'guide', 'steps.md')), '附加文件应随导入落盘');
  assert.equal(countImportTempDirectories(), 0, '成功导入不得遗留临时目录');

  const binaryFolderSource = path.join(sourceDir, 'binary-import-folder');
  mkdirSync(path.join(binaryFolderSource, 'refs'), { recursive: true });
  writeFileSync(path.join(binaryFolderSource, 'SKILL.md'), '---\nname: 文件夹二进制\ndescription: x\n---\n\n正文。\n');
  writeFileSync(path.join(binaryFolderSource, 'refs', 'binary.md'), Buffer.from([0x00, 0x01, 0x02]));
  const binaryFolderResult = await importAiSkillSource({ kind: 'directory', path: binaryFolderSource }, { workspacePath: workspaceDir, existingConfigSkillNames: importConfigSkillNames });
  assert.equal(binaryFolderResult.ok, false, '文件夹来源中的二进制附件应导入失败');
  assert.ok(binaryFolderResult.error.includes('二进制'), `失败原因应说明二进制：${binaryFolderResult.error}`);
  assert.ok(!existsSync(path.join(aiSkillRoot, '文件夹二进制')), '含二进制附件的文件夹不得落盘');

  // zip 导入：允许单层包裹目录（兼容 GitHub zipball）。
  const zipPath = path.join(sourceDir, 'wrapped-skill.zip');
  writeFileSync(zipPath, await createSkillZip({
    'wrapped-skill/SKILL.md': '---\nname: 压缩技能\ndescription: 通过 zip 导入。\n---\n\n压缩包技能正文。\n',
    'wrapped-skill/refs/a.md': '附加 A。\n',
  }));
  const zipResult = await importAiSkillSource({ kind: 'zip', path: zipPath }, { workspacePath: workspaceDir, existingConfigSkillNames: importConfigSkillNames });
  assert.equal(zipResult.ok, true, `zip 导入应成功：${zipResult.error}`);
  assert.equal(zipResult.skillName, '压缩技能');
  assert.equal(zipResult.resourceFileCount, 1);
  assert.ok(existsSync(path.join(aiSkillRoot, '压缩技能', 'refs', 'a.md')), 'zip 附加文件应解压到技能目录');

  // 非法元数据：缺 description，导入失败且不落盘、不留临时目录。
  const badZipPath = path.join(sourceDir, 'bad-skill.zip');
  writeFileSync(badZipPath, await createSkillZip({ 'SKILL.md': '---\nname: 坏技能\n---\n\n正文。\n' }));
  const badResult = await importAiSkillSource({ kind: 'zip', path: badZipPath }, { workspacePath: workspaceDir, existingConfigSkillNames: importConfigSkillNames });
  assert.equal(badResult.ok, false, '缺 description 的 SKILL.md 应导入失败');
  assert.ok(badResult.error.includes('description'), `失败原因应指明 description：${badResult.error}`);
  assert.ok(!existsSync(path.join(aiSkillRoot, '坏技能')), '失败导入不得落盘');
  assert.equal(countImportTempDirectories(), 0, '失败导入不得遗留临时目录');

  // 安全边界：zip 内二进制内容（含 NUL）与非白名单扩展名必须拒绝。
  const binaryPath = path.join(sourceDir, 'binary-skill.zip');
  writeFileSync(binaryPath, await createSkillZip({
    'SKILL.md': '---\nname: 二进制技能\ndescription: x\n---\n\n正文。\n',
    'asset.bin': Buffer.from([0x00, 0x01, 0x02, 0x03]),
  }));
  const binaryResult = await importAiSkillSource({ kind: 'zip', path: binaryPath }, { workspacePath: workspaceDir, existingConfigSkillNames: importConfigSkillNames });
  assert.equal(binaryResult.ok, false, '含二进制文件的 zip 应导入失败');
  assert.ok(binaryResult.error.includes('二进制'), `失败原因应说明二进制：${binaryResult.error}`);
  assert.ok(!existsSync(path.join(aiSkillRoot, '二进制技能')), '失败导入不得落盘');

  // JSZip 会把 `..` 从 entry.name 中移除，但在 unsafeOriginalName 保留原值；
  // 导入服务必须检查原值，不能把穿越条目当成根级普通文件。
  const traversalPath = path.join(sourceDir, 'traversal-skill.zip');
  writeFileSync(traversalPath, await createSkillZip({
    'SKILL.md': '---\nname: 穿越技能\ndescription: x\n---\n\n正文。\n',
    '../escape.md': '不得导入。\n',
  }));
  const traversalResult = await importAiSkillSource({ kind: 'zip', path: traversalPath }, { workspacePath: workspaceDir, existingConfigSkillNames: importConfigSkillNames });
  assert.equal(traversalResult.ok, false, '含 .. 路径的 zip 应导入失败');
  assert.ok(traversalResult.error.includes('路径穿越'), `失败原因应说明路径穿越：${traversalResult.error}`);
  assert.ok(!existsSync(path.join(aiSkillRoot, '穿越技能')), '穿越 zip 不得落盘');

  const symlinkPath = path.join(sourceDir, 'symlink-skill.zip');
  const symlinkZip = new JSZipModule.default();
  symlinkZip.file('SKILL.md', '---\nname: 链接技能\ndescription: x\n---\n\n正文。\n');
  symlinkZip.file('refs/link.md', 'target.md', { unixPermissions: 0o120777 });
  writeFileSync(symlinkPath, await symlinkZip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' }));
  const symlinkResult = await importAiSkillSource({ kind: 'zip', path: symlinkPath }, { workspacePath: workspaceDir, existingConfigSkillNames: importConfigSkillNames });
  assert.equal(symlinkResult.ok, false, '含符号链接的 zip 应导入失败');
  assert.ok(symlinkResult.error.includes('符号链接'), `失败原因应说明符号链接：${symlinkResult.error}`);
  assert.ok(!existsSync(path.join(aiSkillRoot, '链接技能')), '符号链接 zip 不得落盘');

  const scriptPath = path.join(sourceDir, 'script-skill.zip');
  writeFileSync(scriptPath, await createSkillZip({
    'SKILL.md': '---\nname: 脚本技能\ndescription: x\n---\n\n正文。\n',
    'run.py': 'print("no")\n',
  }));
  const scriptResult = await importAiSkillSource({ kind: 'zip', path: scriptPath }, { workspacePath: workspaceDir, existingConfigSkillNames: importConfigSkillNames });
  assert.equal(scriptResult.ok, false, '含脚本文件的 zip 应导入失败');
  assert.ok(scriptResult.error.includes('文本类型'), `失败原因应说明仅支持文本类型：${scriptResult.error}`);

  // 冲突：与设置技能重名。
  const clashSource = path.join(sourceDir, 'clash-skill');
  mkdirSync(clashSource, { recursive: true });
  writeFileSync(path.join(clashSource, 'SKILL.md'), '---\nname: 知识问答\ndescription: 与设置技能同名。\n---\n\n正文。\n');
  const clashResult = await importAiSkillSource({ kind: 'directory', path: clashSource }, { workspacePath: workspaceDir, existingConfigSkillNames: importConfigSkillNames });
  assert.equal(clashResult.ok, false, '与设置技能重名应导入失败');
  assert.ok(clashResult.error.includes('重名'), `失败原因应说明重名：${clashResult.error}`);

  // 冲突：重复导入同名技能（目标目录已存在）。
  const repeatResult = await importAiSkillSource({ kind: 'zip', path: zipPath }, { workspacePath: workspaceDir, existingConfigSkillNames: importConfigSkillNames });
  assert.equal(repeatResult.ok, false, '重复导入同名技能应失败');
  assert.ok(repeatResult.error.includes('已存在同名技能目录'), `失败原因应说明目录已存在：${repeatResult.error}`);

  // 单文件导入：归一化为 SKILL.md。
  const singlePath = path.join(sourceDir, 'single.md');
  writeFileSync(singlePath, '---\nname: 单文件技能\ndescription: 单文件导入。\n---\n\n单文件正文。\n');
  const singleResult = await importAiSkillSource({ kind: 'markdown', path: singlePath }, { workspacePath: workspaceDir, existingConfigSkillNames: importConfigSkillNames });
  assert.equal(singleResult.ok, true, `单文件导入应成功：${singleResult.error}`);
  assert.equal(singleResult.skillName, '单文件技能');
  assert.equal(singleResult.resourceFileCount, 0);

  // 停用过滤：disabledNames 不进 catalog，记录到 disabled；无过滤时可加载。
  const filteredOutcome = loadDirectorySkills(workspaceDir, { disabledNames: new Set(['导入笔记']) });
  assert.ok(!filteredOutcome.skills.some((entry) => entry.name === '导入笔记'), '停用技能不得进 catalog');
  assert.ok(filteredOutcome.disabled.some((entry) => entry.directory === '导入笔记' && entry.reason.includes('停用')), '停用技能应记录在 disabled');
  const unfilteredOutcome = loadDirectorySkills(workspaceDir);
  assert.ok(unfilteredOutcome.skills.some((entry) => entry.name === '导入笔记'), '无停用过滤时应能加载全部技能');

  // 总览投影：overrides 启停 + 来源标识 + 重名/校验失败回显。
  const overview = buildAiSkillsOverview({
    outcome: unfilteredOutcome,
    overrides: { '导入笔记': { enabled: false, importedAt: '2026-08-28T00:00:00.000Z' } },
    configSkillNames: ['知识问答'],
  });
  const overviewEntry = overview.directorySkills.find((entry) => entry.name === '导入笔记');
  assert.ok(overviewEntry, '总览应包含导入技能');
  assert.equal(overviewEntry.enabled, false, '总览应投影停用状态');
  assert.equal(overviewEntry.importedAt, '2026-08-28T00:00:00.000Z', '导入来源应携带时间');
  assert.equal(overviewEntry.resourceFileCount, 1, '总览应统计附加文件数');
  const externalEntry = overview.directorySkills.find((entry) => entry.name === '学习笔记');
  assert.ok(externalEntry && !externalEntry.importedAt && externalEntry.enabled, '手动放置技能应标记为外部且默认启用');
  assert.ok(overview.nameConflicts.some((issue) => issue.directory === 'knowledge-clash'), '与设置技能重名的目录技能应出现在 nameConflicts');
  assert.ok(!overview.directorySkills.some((entry) => entry.name === '知识问答'), '重名技能不得出现在总览列表');
  assert.equal(overview.skipped.length, 1, '校验失败目录技能应回显');
}

// 14. 单元（P2）：表单创建目录技能、就地更新文档与 zip 导出回环。
{
  // 表单创建：走导入同一校验链路；缺字段与重名都被拒绝。
  const emptyResult = createDirectorySkillFromForm({ name: '', description: 'x', instruction: 'y' }, { workspacePath: workspaceDir, existingConfigSkillNames: importConfigSkillNames });
  assert.equal(emptyResult.ok, false, '缺名称的表单创建应失败');
  const clashResult = createDirectorySkillFromForm({ name: '知识问答', description: 'x', instruction: 'y' }, { workspacePath: workspaceDir, existingConfigSkillNames: importConfigSkillNames });
  assert.equal(clashResult.ok, false, '与设置技能重名的表单创建应失败');
  const formResult = createDirectorySkillFromForm({ name: '表单技能', description: '通过表单创建。', instruction: '按表单约束工作。' }, { workspacePath: workspaceDir, existingConfigSkillNames: importConfigSkillNames });
  assert.equal(formResult.ok, true, `表单创建应成功：${formResult.error}`);
  assert.equal(formResult.skillName, '表单技能');
  const formContent = readFileSync(path.join(aiSkillRoot, '表单技能', 'SKILL.md'), 'utf8');
  assert.ok(formContent.startsWith('---\nname: 表单技能\n'), '生成文档应为标准 frontmatter');
  assert.ok(formContent.includes('"通过表单创建。"'), 'description 应以引号标量转义');

  // 就地更新：description 保留引号转义，非法内容拒绝且不破坏原文档。
  const formDir = path.join(aiSkillRoot, '表单技能');
  const badUpdate = updateDirectorySkillDocument({ basePath: formDir, name: '表单技能', description: '', instruction: 'y' });
  assert.equal(badUpdate.ok, false, '空 description 的更新应失败');
  assert.ok(readFileSync(path.join(formDir, 'SKILL.md'), 'utf8').includes('通过表单创建。'), '失败更新不得破坏原文档');
  const okUpdate = updateDirectorySkillDocument({ basePath: formDir, name: '表单技能', description: '更新后的描述。', instruction: '更新后的约束。' });
  assert.equal(okUpdate.ok, true, `文档更新应成功：${okUpdate.error}`);
  const updatedContent = readFileSync(path.join(formDir, 'SKILL.md'), 'utf8');
  assert.ok(updatedContent.includes('更新后的约束。') && updatedContent.includes('"更新后的描述。"'), '更新内容应原子落盘');
  const reparsed = loadDirectorySkills(workspaceDir).skills.find((entry) => entry.name === '表单技能');
  assert.ok(reparsed && reparsed.instruction.includes('更新后的约束'), '更新后的技能应仍可通过加载器校验');

  // zip 导出回环：导出 → 删除 → 重新导入，内容一致。
  const exportPath = path.join(sourceDir, 'exported-skill.zip');
  const exportResult = await exportDirectorySkillToZip({ basePath: formDir, name: '表单技能' }, exportPath);
  assert.equal(exportResult.ok, true, `zip 导出应成功：${exportResult.error}`);
  assert.ok(existsSync(exportPath), '导出文件应存在');
  removeDirectoryRecursively(formDir);
  const reimportResult = await importAiSkillSource({ kind: 'zip', path: exportPath }, { workspacePath: workspaceDir, existingConfigSkillNames: importConfigSkillNames });
  assert.equal(reimportResult.ok, true, `导出包应可重新导入：${reimportResult.error}`);
  assert.equal(reimportResult.skillName, '表单技能');
  assert.ok(readFileSync(path.join(aiSkillRoot, '表单技能', 'SKILL.md'), 'utf8').includes('更新后的约束。'), '重导入内容应与导出一致');
}

// 15. 发布资源初始化、用户修改保留、启停校验及本轮提示词边界。
{
  const bundledWorkspace = path.join(outDir, 'bundled-workspace');
  const bundleRoot = path.join(rootDir, 'build', 'builtin-skills');
  ensureBundledSkills(bundledWorkspace, bundleRoot);
  const defaults = defaultExtensionsSettings();
  assert.deepEqual(defaults.skills, [], '旧的三个预设不应再由设置默认值生成');
  const retired = ['knowledge', 'learning', 'organize'].map((name) => ({ id: `skill_builtin_${name}`, enabled: true }));
  assert.deepEqual(validateExtensionsSettings({ ...defaults, skills: retired }).skills, [], '旧设置中的预设应迁移移除');
  const snapshot = loadAssistantSkills(bundledWorkspace, defaults);
  assert.equal(snapshot.available.length, 5, '空工作区必须自带五个完整技能');
  assert.ok(snapshot.available.every((skill) => skill.system));
  const overview = buildAiSkillsOverview({ outcome: snapshot.directoryOutcome, configSkillNames: [], overrides: undefined });
  assert.ok(overview.directorySkills.every((skill) => skill.system), '管理页必须正确显示内置来源');
  const report = snapshot.available.find((skill) => skill.name === '实验报告生成');
  const study = snapshot.available.find((skill) => skill.name === '学习文档生成');
  const selection = resolveAssistantSkillSelection(snapshot, [report.id]);
  assert.deepEqual(selection.skills.catalog.map((skill) => skill.id), [report.id], '本轮可读目录只包含已选技能');
  const prompt = createAssistantChatPrompt('生成实验报告', [], selection.selectedSkills.map((skill) => skill.instruction));
  assert.ok(prompt.includes(report.instruction), '聊天提示词必须包含实际选中的完整指令');
  assert.ok(!prompt.includes(study.instruction), '未选技能正文不能进入提示词');
  const block = buildKnowledgeSkillsBlock({ ...selection.skills, hasResourceSkills: true });
  assert.match(block, /已选技能（必须遵守）/u);
  assert.match(block, /file_path/u, '预加载技能仍须能读取其模板');
  assert.doesNotMatch(block, /可用技能目录/u, '不得推荐自动加载未选技能');
  const resourceTool = createReadSkillTool(selection.skills, selection.skillInstructionById, selection.skillResourceRootById);
  const template = await resourceTool.execute({ skill_name: report.name, file_path: 'templates/实验报告模板.md' }, {});
  assert.equal(template.ok, true, '发布技能的附加模板必须可读');
  assert.equal((await resourceTool.execute({ skill_name: study.name }, {})).ok, false, '工具不得加载本轮未选技能');
  const emptySelection = resolveAssistantSkillSelection(snapshot);
  assert.deepEqual(emptySelection.skills, { catalog: [], selected: [] });
  assert.equal(emptySelection.skillResourceRootById.size, 0);
  const disabledSettings = { ...defaults, directorySkillOverrides: { [report.name]: { enabled: false } } };
  const disabledSnapshot = loadAssistantSkills(bundledWorkspace, disabledSettings);
  assert.equal(disabledSnapshot.available.length, 4);
  assert.throws(() => resolveAssistantSkillSelection(disabledSnapshot, [report.id]), /不存在或已停用/u, '旧页面提交已停用技能必须被拒绝');
  assert.throws(() => resolveAssistantSkillSelection(snapshot, snapshot.available.slice(0, 4).map((skill) => skill.id)), /最多选择 3/u);
  const edited = path.join(bundledWorkspace, 'AI-Skill', 'builtin-knowledge', 'SKILL.md');
  const userContent = readFileSync(edited, 'utf8') + '\n用户自定义规则：保留这条规则。\n';
  writeFileSync(edited, userContent);
  ensureBundledSkills(bundledWorkspace, bundleRoot);
  assert.equal(readFileSync(edited, 'utf8'), userContent, '重启不得覆盖用户编辑的内置技能');
  const custom = { id: 'skill_custom_report', name: report.name, description: '自定义报告技能', instruction: '用户定制报告规则', generationStyle: 'factual', enabled: true, system: false };
  const customized = loadAssistantSkills(bundledWorkspace, { ...defaults, skills: [custom] });
  assert.equal(customized.available.filter((skill) => skill.name === report.name).length, 1, '同名技能只展示一个');
  assert.equal(customized.available.find((skill) => skill.name === report.name).instruction, custom.instruction, '保留已有设置技能的同名优先级');
  rmSync(bundledWorkspace, { recursive: true, force: true });
}

console.log('verify-knowledge-agent-skills: all assertions passed');
