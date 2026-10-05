import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-assistant-turn');
const typesFile = path.join(outDir, 'types.cjs');
const turnFile = path.join(outDir, 'turn.cjs');
const settingsFile = path.join(outDir, 'settings.cjs');
const workspaceSkillFile = path.join(outDir, 'workspace-skill.cjs');
const generationPolicyFile = path.join(outDir, 'assistant-generation-policy.cjs');
const contextBudgetFile = path.join(outDir, 'assistant-context-budget.cjs');
const intentClassifierFile = path.join(outDir, 'assistant-intent-classifier.cjs');
const mainBundleFile = path.join(outDir, 'main.cjs');
const knowledgePanelBundleFile = path.join(outDir, 'knowledge-panel.cjs');

await Promise.all([
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'assistantTurnTypes.ts')], outfile: typesFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'assistantTurn.ts')], outfile: turnFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'aiSettings.ts')], outfile: settingsFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'aiSkillWorkspace.ts')], outfile: workspaceSkillFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'assistantGenerationPolicy.ts')], outfile: generationPolicyFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'shared', 'assistantContextBudget.ts')], outfile: contextBudgetFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'assistantIntentClassifier.ts')], outfile: intentClassifierFile, bundle: true, platform: 'node', format: 'cjs' }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'main.ts')], outfile: mainBundleFile, bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'better-sqlite3'] }),
  build({ entryPoints: [path.join(rootDir, 'src', 'components', 'KnowledgePanel.tsx')], outfile: knowledgePanelBundleFile, bundle: true, platform: 'browser', format: 'cjs' }),
]);

const { validateAssistantTurnRequest } = await import(pathToFileURL(typesFile).href);
const { createAssistantChatPrompt, createAssistantChatPromptMessages, createKnowledgeAnswerPrompt, createKnowledgeAnswerPromptMessages, formatAnswerDepthRules, formatSkillRules } = await import(pathToFileURL(turnFile).href);
const { defaultExtensionsSettings, validateExtensionsSettings } = await import(pathToFileURL(settingsFile).href);
const { getAiSkillFileName, syncAiSkillsToWorkspace } = await import(pathToFileURL(workspaceSkillFile).href);
const { resolveAssistantAnswerTemperature } = await import(pathToFileURL(generationPolicyFile).href);
const { ASSISTANT_CONTEXT_BUDGET_TOKENS, ASSISTANT_SOURCE_BUDGET_TOKENS } = await import(pathToFileURL(contextBudgetFile).href);
const {
  ASSISTANT_QUERY_UNDERSTANDING_JSON_SCHEMA,
  createAssistantIntentClassifier,
  createAssistantIntentClassificationPrompt,
  parseAssistantInteractionRoute,
  parseAssistantQueryUnderstanding,
  resolveAssistantInteractionRoute,
} = await import(pathToFileURL(intentClassifierFile).href);

assert.equal(ASSISTANT_CONTEXT_BUDGET_TOKENS, 131_072);
assert.equal(ASSISTANT_SOURCE_BUDGET_TOKENS, 20_000);

const valid = validateAssistantTurnRequest({
  requestId: 'assistant_12345678',
  intent: 'ask',
  scope: 'library-search',
  userText: '如何备份？',
  contextSources: [{ kind: 'note-library', libraryPath: 'C:/Notes/secondary', label: '备用笔记库' }, { kind: 'knowledge-base', libraryPath: 'C:/Notes/knowledge', label: '个人知识库' }],
  attachments: [{ kind: 'text', attachmentId: 'text-fixture-turn-01', path: 'C:/Notes/context.md', name: 'context.md', sizeBytes: 128 }],
  conversation: [{ role: 'user', content: '之前的问题' }, { role: 'assistant', content: '之前的回答' }],
  modelProfileId: 'model_local_0001',
  thinkingMode: 'advanced',
  answerDepth: 'detailed',
  skillIds: ['skill_custom_0001'],
});
assert.equal(valid.intent, 'ask');
assert.equal(valid.conversation.length, 2);
assert.equal(valid.modelProfileId, 'model_local_0001');
assert.equal(valid.thinkingMode, 'advanced');
assert.equal(valid.answerDepth, 'detailed');
assert.deepEqual(valid.skillIds, ['skill_custom_0001']);
assert.equal(valid.contextSources?.length, 2);
assert.equal(valid.contextSources?.[1]?.kind, 'knowledge-base');
assert.equal(valid.attachments?.[0]?.name, 'context.md');
const directChat = validateAssistantTurnRequest({
  requestId: 'assistant_chat_12345678',
  intent: 'ask',
  scope: 'chat',
  userText: '帮我想三个标题',
  conversation: [],
});
assert.equal(directChat.scope, 'chat');
assert.equal(directChat.answerDepth, 'auto');
const directChatWithoutWeb = validateAssistantTurnRequest({ ...directChat, webSearch: 'off' });
assert.equal(directChatWithoutWeb.webSearch, 'off', 'IPC 校验必须保留本轮联网关闭开关。');
await assert.rejects(
  async () => validateAssistantTurnRequest({ ...directChat, webSearch: 'disabled' }),
  /联网搜索开关无效/,
);
const dedicatedKnowledgeBaseSession = validateAssistantTurnRequest({
  requestId: 'assistant_kb_12345678',
  intent: 'ask',
  scope: 'library-search',
  userText: '资料里怎么说？',
  sessionId: 'workspace_session_12345678',
  contextSources: [{ kind: 'knowledge-base', libraryPath: 'C:/Notes/knowledge', label: '个人知识库' }],
  conversation: [],
});
assert.equal(dedicatedKnowledgeBaseSession.sessionId, 'workspace_session_12345678');
const dedicatedKnowledgeBaseSessionWithDocument = validateAssistantTurnRequest({
  ...dedicatedKnowledgeBaseSession,
  requestId: 'assistant_kb_doc_12345678',
  attachments: [{
    kind: 'document',
    attachmentId: 'document-fixture-kb-01',
    path: 'C:/Notes/test111.docx',
    name: 'test111.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    sizeBytes: 38_000,
  }],
});
assert.equal(dedicatedKnowledgeBaseSessionWithDocument.sessionId, 'workspace_session_12345678', '知识库会话添加文档附件后必须继续复用原会话');
assert.equal(dedicatedKnowledgeBaseSessionWithDocument.attachments?.[0]?.kind, 'document');
await assert.rejects(
  async () => validateAssistantTurnRequest({ ...directChat, contextSources: [{ kind: 'knowledge-base', libraryPath: 'C:/Notes/knowledge' }] }),
  /普通 AI 问答不接受资料库来源/,
);
// 多模态开发方案 §5.1：chat scope 放行显式附件；非图片附件在 main 中强制转入证据回答链路。
const chatWithImage = validateAssistantTurnRequest({
  requestId: 'assistant_chat_img_12345678',
  intent: 'ask',
  scope: 'chat',
  userText: '这张图里有什么？',
  conversation: [],
  attachments: [{
    kind: 'image',
    attachmentId: 'image-fixture-chat-01',
    name: 'pasted.png',
    mimeType: 'image/png',
    sizeBytes: 1024,
    dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
  }],
});
assert.equal(chatWithImage.attachments?.[0]?.kind, 'image');
const chatWithDocument = validateAssistantTurnRequest({
  ...directChat,
  requestId: 'assistant_chat_doc_12345678',
  attachments: [{ kind: 'document', attachmentId: 'document-fixture-chat-01', path: 'C:/a.pdf', name: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 1 }],
});
assert.equal(chatWithDocument.attachments?.[0]?.kind, 'document');
await assert.rejects(
  async () => validateAssistantTurnRequest({ ...valid, intent: 'learning-plan', scope: 'current-note' }),
  /不能使用该笔记范围/,
);
await assert.rejects(
  async () => validateAssistantTurnRequest({ ...valid, model: 'untrusted-model' }),
  /不允许的字段/,
);
await assert.rejects(
  async () => validateAssistantTurnRequest({ ...valid, thinkingMode: 'extreme' }),
  /思考强度无效/,
);
await assert.rejects(
  async () => validateAssistantTurnRequest({ ...valid, answerDepth: 'verbose' }),
  /回答深度无效/,
);
await assert.rejects(
  async () => validateAssistantTurnRequest({ ...valid, conversation: Array.from({ length: 7 }, () => ({ role: 'user', content: 'x' })) }),
  /会话上下文格式无效/,
);
const longHistory = validateAssistantTurnRequest({ ...valid, conversation: [{ role: 'assistant', content: `${'长回答。'.repeat(1500)}尾部结论` }] });
assert.equal(longHistory.conversation[0]?.content.length, 2_000);
assert.match(longHistory.conversation[0]?.content, /尾部结论$/, 'Over-long history messages must be tail-truncated instead of rejecting the turn.');
await assert.rejects(
  async () => validateAssistantTurnRequest({ ...valid, conversation: Array.from({ length: 3 }, () => ({ role: 'user', content: 'x'.repeat(2_500) })) }),
  /会话上下文不能超过 4000 字符/,
);

const prompt = createKnowledgeAnswerPrompt('现在的问题', valid.conversation, [{ title: '备份策略', content: '只保存本地 Markdown。' }]);
assert.match(prompt, /当前问题：\n现在的问题/);
assert.match(prompt, /用户：之前的问题/);
assert.match(prompt, /\[1\] 备份策略/);
assert.match(prompt, /不可信数据/);
assert.match(prompt, /回答深度：自适应/);
const knowledgeMessages = createKnowledgeAnswerPromptMessages('现在的问题', valid.conversation, [{ title: '备份策略', content: '只保存本地 Markdown。' }], ['输出检查清单。']);
assert.match(knowledgeMessages.systemPrompt, /私有知识助手/);
assert.match(knowledgeMessages.systemPrompt, /输出检查清单/);
assert.doesNotMatch(knowledgeMessages.systemPrompt, /只保存本地 Markdown/);
assert.doesNotMatch(knowledgeMessages.systemPrompt, /现在的问题/);
assert.match(knowledgeMessages.userPrompt, /现在的问题/);
assert.match(knowledgeMessages.userPrompt, /只保存本地 Markdown/);
assert.match(knowledgeMessages.userPrompt, /用户：之前的问题/);
assert.doesNotMatch(knowledgeMessages.userPrompt, /输出检查清单/);
assert.equal(knowledgeMessages.prompt, createKnowledgeAnswerPrompt('现在的问题', valid.conversation, [{ title: '备份策略', content: '只保存本地 Markdown。' }], ['输出检查清单。']));
assert.match(formatAnswerDepthRules('detailed'), /原理、关键步骤、示例、适用边界/);
assert.match(formatSkillRules(['输出检查清单。']), /不改变上述范围/);
const boundedPrompt = createKnowledgeAnswerPrompt('检查资料预算', [], Array.from({ length: 8 }, (_, index) => ({ title: `资料 ${index + 1}`, content: '甲'.repeat(4_000) })));
assert.ok((boundedPrompt.match(/甲/gu) ?? []).length <= ASSISTANT_SOURCE_BUDGET_TOKENS, 'Assistant sources must stay inside the shared source budget.');
const chatPrompt = createAssistantChatPrompt('你好', valid.conversation);
assert.match(chatPrompt, /当前没有读取任何笔记或资料/);
assert.match(chatPrompt, /用户：之前的问题/);
assert.match(chatPrompt, /定义类问题通常说明/);
assert.doesNotMatch(chatPrompt, /自然、简洁地回应用户/);
const chatMessages = createAssistantChatPromptMessages('帮我想标题', valid.conversation, ['优先使用四字标题。']);
assert.match(chatMessages.systemPrompt, /聊天助手/);
assert.match(chatMessages.systemPrompt, /优先使用四字标题/);
assert.doesNotMatch(chatMessages.systemPrompt, /帮我想标题/);
assert.match(chatMessages.userPrompt, /帮我想标题/);
assert.doesNotMatch(chatMessages.userPrompt, /优先使用四字标题/);
const conciseChatPrompt = createAssistantChatPrompt('你好', [], [], 'concise');
assert.match(conciseChatPrompt, /回答深度：简洁/);
const detailedKnowledgePrompt = createKnowledgeAnswerPrompt('解释原理', [], [{ title: '资料', content: '证据' }], [], 'detailed');
assert.match(detailedKnowledgePrompt, /回答深度：详细/);
assert.match(detailedKnowledgePrompt, /只可依据下方“资料”回答/);

assert.equal(parseAssistantInteractionRoute({ route: 'chat' }), 'chat');
assert.throws(() => parseAssistantInteractionRoute({ route: 'chat', explanation: 'ignored' }), /意图识别结果无效/);
const intentPrompt = createAssistantIntentClassificationPrompt('它和 RAG 有什么区别？', [{ role: 'user', content: '先解释 BM25' }], 'current-note', {
  imageCount: 1,
  documentNames: ['检索设计.md'],
  language: '简体中文',
});
assert.match(intentPrompt, /"rewrite_query":"string","intent":"string","image_description":"string"/);
assert.match(intentPrompt, /改写结果会直接替换 PlanAI 的 question/);
assert.match(intentPrompt, /“RAG 是什么”且当前已选择笔记库 → kb_search/);
assert.match(intentPrompt, /<images_uploaded count="1" \/>/);
assert.match(intentPrompt, /检索设计\.md/);
assert.match(intentPrompt, /不确定时一律选择 kb_search/);
assert.equal(ASSISTANT_QUERY_UNDERSTANDING_JSON_SCHEMA.schema.additionalProperties, false);
assert.deepEqual(ASSISTANT_QUERY_UNDERSTANDING_JSON_SCHEMA.schema.required, ['rewrite_query', 'intent', 'image_description']);

const parsedUnderstanding = parseAssistantQueryUnderstanding({
  rewrite_query: 'BM25 和 RAG 有什么区别？',
  intent: 'kb_search',
  image_description: '',
}, { hasImages: false, hasDocuments: false });
assert.deepEqual(parsedUnderstanding, {
  rewriteQuery: 'BM25 和 RAG 有什么区别？',
  intent: 'kb_search',
  imageDescription: '',
});
assert.throws(() => parseAssistantQueryUnderstanding({
  rewrite_query: '你好', intent: 'greeting', image_description: '', explanation: '多余字段',
}, { hasImages: false, hasDocuments: false }), /字段无效/);
assert.throws(() => parseAssistantQueryUnderstanding({
  rewrite_query: '描述图片', intent: 'image_only', image_description: '',
}, { hasImages: false, hasDocuments: false }), /没有图片/);
assert.throws(() => parseAssistantQueryUnderstanding({
  rewrite_query: '总结文件', intent: 'doc_only', image_description: '',
}, { hasImages: false, hasDocuments: false }), /没有文件/);
assert.throws(() => parseAssistantQueryUnderstanding({
  rewrite_query: '描述图片', intent: 'image_only', image_description: '',
}, { hasImages: true, hasDocuments: false }), /图片描述不能为空/);
assert.throws(() => parseAssistantQueryUnderstanding({
  rewrite_query: '你好', intent: 'greeting', image_description: '不应存在',
}, { hasImages: false, hasDocuments: false }), /图片描述必须为空/);
assert.throws(() => parseAssistantQueryUnderstanding({
  rewrite_query: Array.from({ length: 31 }, (_, index) => `word${index}`).join(' '), intent: 'kb_search', image_description: '',
}, { hasImages: false, hasDocuments: false, language: 'en' }), /超过 30 个词/);
assert.equal(resolveAssistantInteractionRoute('kb_search'), 'react');
assert.equal(resolveAssistantInteractionRoute('clarification'), 'react');
assert.equal(resolveAssistantInteractionRoute('doc_only'), 'react');
assert.equal(resolveAssistantInteractionRoute('follow_up'), 'chat');
assert.equal(resolveAssistantInteractionRoute('image_only'), 'chat');

let capturedClassificationRequest;
const classifier = createAssistantIntentClassifier({
  generateJson: async (request) => {
    capturedClassificationRequest = request;
    return {
      rewrite_query: 'BM25 和 RAG 有什么区别？',
      intent: 'kb_search',
      image_description: '一张深色界面截图，可见文字 BM25 与 RAG。',
    };
  },
});
const classified = await classifier.classify({
  question: '它和 RAG 有什么区别？',
  conversation: [{ role: 'user', content: '先解释 BM25' }],
  scope: 'library-search',
  signal: new AbortController().signal,
  images: [{ dataUrl: 'data:image/png;base64,iVBORw0KGgo=', mimeType: 'image/png', name: 'screen.png' }],
  language: '简体中文',
});
assert.equal(classified.rewriteQuery, 'BM25 和 RAG 有什么区别？');
assert.equal(classified.intent, 'kb_search');
assert.equal(classified.interactionRoute, 'react');
assert.equal(classified.usedFallback, false);
assert.equal(capturedClassificationRequest.images.length, 1);
assert.equal(capturedClassificationRequest.jsonSchema, ASSISTANT_QUERY_UNDERSTANDING_JSON_SCHEMA);
assert.equal(capturedClassificationRequest.temperature, 0.1);

const fallbackClassifier = createAssistantIntentClassifier({ generateJson: async () => ({
  rewrite_query: '笔记里写了什么？', intent: 'unknown', image_description: '',
}) });
const fallbackUnderstanding = await fallbackClassifier.classify({
  question: '笔记里写了什么？',
  conversation: [],
  scope: 'current-note',
  signal: new AbortController().signal,
});
assert.equal(fallbackUnderstanding.rewriteQuery, '笔记里写了什么？');
assert.equal(fallbackUnderstanding.intent, 'kb_search');
assert.equal(fallbackUnderstanding.interactionRoute, 'react');
assert.equal(fallbackUnderstanding.usedFallback, true);
const imageFallbackUnderstanding = await fallbackClassifier.classify({
  question: '笔记库里有类似图片吗？',
  conversation: [],
  scope: 'library-search',
  signal: new AbortController().signal,
  images: [{ dataUrl: 'data:image/png;base64,iVBORw0KGgo=', mimeType: 'image/png', name: 'screen.png' }],
});
assert.match(imageFallbackUnderstanding.imageDescription, /下游模型需直接分析原始图片/);

const extensions = defaultExtensionsSettings();
assert.deepEqual(extensions.skills, [], '默认技能由五个发布目录资源提供，设置不再生成旧预设。');
assert.equal(resolveAssistantAnswerTemperature({ grounded: true, skills: [{ generationStyle: 'creative' }] }), 0.2);
assert.equal(resolveAssistantAnswerTemperature({ grounded: false, skills: [] }), 0.4);
assert.equal(resolveAssistantAnswerTemperature({ grounded: false, skills: [{ generationStyle: 'creative' }] }), 0.7);
assert.equal(resolveAssistantAnswerTemperature({ grounded: false, skills: [{ generationStyle: 'creative' }, { generationStyle: 'factual' }] }), 0.2);
const customizedSkill = { id: 'skill_custom_0002', name: '资料核验', instruction: '只依据已提供资料作答，并标记无法核验的结论。', generationStyle: 'factual', enabled: true, system: false };
const normalizedExtensions = validateExtensionsSettings({ ...extensions, skills: [customizedSkill, { id: 'skill_custom_0001', name: '标题创作', instruction: '提供多个标题。', enabled: true, system: false }] });
assert.equal(normalizedExtensions.skills[0]?.name, '资料核验');
assert.equal(normalizedExtensions.skills[0]?.instruction, '只依据已提供资料作答，并标记无法核验的结论。');
assert.equal(normalizedExtensions.skills.at(-1)?.generationStyle, 'balanced', '旧版自定义 Skill 缺少生成风格时应平滑迁移为均衡表达。');
await assert.rejects(
  async () => validateExtensionsSettings({ ...extensions, skills: [{ ...customizedSkill, generationStyle: 'random' }] }),
  /生成风格无效/,
);

const skillWorkspace = fs.mkdtempSync(path.join(outDir, 'workspace-'));
try {
  const manualFile = path.join(skillWorkspace, 'AI-Skill', 'manual-reference.md');
  fs.mkdirSync(path.dirname(manualFile), { recursive: true });
  fs.writeFileSync(manualFile, '# 手工资料\n', 'utf8');
  const staleFile = path.join(skillWorkspace, 'AI-Skill', 'skill_retired_12345678.md');
  fs.writeFileSync(staleFile, '---\nmanagedBy: "menghan-notes"\n---\n', 'utf8');
  syncAiSkillsToWorkspace(skillWorkspace, normalizedExtensions);
  const generatedFile = path.join(skillWorkspace, 'AI-Skill', getAiSkillFileName(normalizedExtensions.skills[0]));
  assert.match(fs.readFileSync(generatedFile, 'utf8'), /managedBy: "menghan-notes"/);
  assert.match(fs.readFileSync(generatedFile, 'utf8'), /# 资料核验/);
  assert.match(fs.readFileSync(generatedFile, 'utf8'), /generationStyle: "factual"/);
  assert.match(fs.readFileSync(generatedFile, 'utf8'), /schemaVersion: 3/);
  assert.match(fs.readFileSync(generatedFile, 'utf8'), /## 能力描述/u);
  assert.equal(fs.existsSync(staleFile), false, 'Removed Skills must remove only their managed workspace file.');
  assert.equal(fs.readFileSync(manualFile, 'utf8'), '# 手工资料\n', 'Manual AI-Skill materials must be preserved.');
} finally {
  fs.rmSync(skillWorkspace, { recursive: true, force: true });
}

const settingsPanel = fs.readFileSync(path.join(rootDir, 'src', 'components', 'SettingsPanel.tsx'), 'utf8');
const knowledgePanel = fs.readFileSync(path.join(rootDir, 'src', 'components', 'KnowledgePanel.tsx'), 'utf8');
const composerAttachments = fs.readFileSync(path.join(rootDir, 'src', 'components', 'assistant', 'AssistantComposerAttachments.tsx'), 'utf8');
const messageAttachments = fs.readFileSync(path.join(rootDir, 'src', 'components', 'assistant', 'AssistantMessageAttachments.tsx'), 'utf8');
const imageViewer = fs.readFileSync(path.join(rootDir, 'src', 'components', 'assistant', 'AssistantImageViewer.tsx'), 'utf8');
const attachmentHook = fs.readFileSync(path.join(rootDir, 'src', 'components', 'assistant', 'useAssistantAttachments.ts'), 'utf8');
const preloadSource = fs.readFileSync(path.join(rootDir, 'electron', 'preload.ts'), 'utf8');
const mainProcess = fs.readFileSync(path.join(rootDir, 'electron', 'main.ts'), 'utf8');
const documentParser = fs.readFileSync(path.join(rootDir, 'electron', 'knowledge', 'assistantDocumentAttachmentParser.ts'), 'utf8');
assert.match(settingsPanel, /const saveSkillEnabled = async/, 'Skill state changes must save immediately.');
assert.match(settingsPanel, /<Modal opened=\{Boolean\(viewingSkillId\)\}/, 'Skill text must be viewable in a modal.');
assert.match(settingsPanel, /setViewingSkillId\(row\.skill\.id\)/, 'Each skill row must provide a view action.');
assert.match(settingsPanel, /setEditingSkillId\(row\.skill\.id\)/, 'Each skill row must provide an edit action.');
assert.match(settingsPanel, /AI-Skill/, 'The settings page must disclose the workspace Skill folder.');
assert.match(settingsPanel, /label="生成风格"/, 'Skill settings must expose a generation-style control.');
assert.match(mainProcess, /syncAiSkillsToWorkspace\(getConfiguredWorkspacePath\(\), settings, getBundledAiSkillsPath\(\)\)/, 'Saving Skills must synchronize their workspace files and bundled resources.');
assert.match(settingsPanel, /title="上下文窗口"[\s\S]*?aria-label="用户上下文上限"/u, 'Per-model context-window input must expose the explicit user cap introduced by the runtime profile.');
assert.match(settingsPanel, /const contextWindowPresetTokens = \[16_384, 32_768, 65_536, 131_072, 262_144\] as const;/u, 'Context-window controls must use doubling 16K-256K presets.');
assert.match(settingsPanel, /<Select aria-label="用户上下文上限"/u, 'Context-window caps must use a discrete preset selector.');
assert.doesNotMatch(settingsPanel, /<NumberInput aria-label="用户上下文上限"/u, 'Context-window caps must not use 1K numeric stepping.');
assert.match(mainProcess, /await resolveAssistantContextWindow\(selectedProfile\.config, model\)/, 'Assistant turns must resolve the selected model runtime window before budgeting.');
assert.match(mainProcess, /contextWindowTokens: resolveConfiguredAssistantContextWindow\(profile\.config\)\.tokens/, 'Assistant model options must expose the configured effective context window.');
assert.match(mainProcess, /createAssistantIntentClassifier/, 'Ask turns must classify chat, clarification, and knowledge routes before retrieval.');
assert.match(mainProcess, /const rewrittenQuestion = queryUnderstanding\.rewriteQuery \|\| request\.userText\.trim\(\)/, 'Ask turns must retain a safe original-question fallback after query rewriting.');
assert.match(mainProcess, /runLibraryPlanAgent\(\{[\s\S]*?question: rewrittenQuestion,/, 'Whole-library PlanAI must receive rewrite_query instead of the raw question.');
assert.match(mainProcess, /runCurrentNoteAgent\(\{[\s\S]*?question: rewrittenQuestion,/, 'Current-note PlanAI must receive rewrite_query instead of the raw question.');
assert.match(mainProcess, /retrievalQuery: rewrittenQuestion,/, 'Fallback retrieval must use rewrite_query as its search query.');
assert.match(mainProcess, /allowKnowledgeSources: queryUnderstanding\.intent !== 'doc_only'/, 'Document-only requests must not silently add note-library evidence.');
assert.match(mainProcess, /thinkingMode: callKind === 'route-classify' \? 'simple' : request\.thinkingMode/, 'Query understanding must use the stable simple-thinking mode.');
assert.match(mainProcess, /type: 'route', interactionRoute/, 'The classified route must reach the renderer before answer streaming starts.');
assert.match(mainProcess, /interactionRoute === 'chat'/, 'The chat route must use the source-free branch.');
assert.match(mainProcess, /const queryUnderstanding:[\s\S]*?request\.scope === 'chat'\s*\?\s*\{[\s\S]*?interactionRoute: documentNames\.length \? 'react' as const : 'chat' as const/, 'Selecting no database must deterministically bypass note retrieval while keeping local document attachments grounded.');
assert.match(mainProcess, /interactionRoute === 'clarify'/, 'The clarification route must return a follow-up before retrieval.');
assert.match(knowledgePanel, /event\.type === 'route'/, 'The user-visible label must update as soon as the route is classified.');
assert.match(knowledgePanel, /interactionRoute === 'chat'\) return '普通聊天'/, 'User-visible labels must distinguish ordinary chat from note questions.');
assert.match(knowledgePanel, /thinkingMode, setThinkingMode/, 'The composer must expose a per-turn thinking selector.');
assert.match(knowledgePanel, /answerDepth, setAnswerDepth/, 'The dedicated Q&A composer must expose a per-turn answer-depth selector.');
assert.match(knowledgePanel, /<Menu\.Label>回答深度<\/Menu\.Label>/, 'The answer-depth selector must be distinct from thinking strength.');
assert.match(knowledgePanel, /answerDepth,\s*skillIds:/, 'The selected answer depth must be sent with each assistant request.');
assert.doesNotMatch(knowledgePanel, /webSearchMode/u, '联网搜索不得在对话区维护本轮覆盖状态。');
assert.doesNotMatch(knowledgePanel, /联网：跟随设置|本轮启用|本轮关闭/u, '对话区不得展示联网搜索开关。');
assert.match(settingsPanel, /aria-label="启用联网搜索"/u, '联网搜索开关必须位于设置页。');
assert.match(settingsPanel, /启用 AI 问答的联网搜索/u, '设置页总开关必须覆盖所有 AI 问答。');
assert.match(knowledgePanel, /AssistantDataSourceSelector/, 'The dedicated Q&A composer must provide a database selector.');
assert.match(knowledgePanel, /不检索资料库，直接询问 AI/, 'The database selector must include an explicit no-database route.');
assert.match(knowledgePanel, /<AssistantComposerAddMenu/, '问答输入框必须通过统一的加号入口添加上下文。');
assert.match(knowledgePanel, /onChooseImages=\{\(\) => void chooseAttachments\('image'\)\}/u, '加号入口必须提供图片选择。');
assert.match(knowledgePanel, /onChooseFiles=\{\(\) => void chooseAttachments\('file'\)\}/u, '加号入口必须提供文件附件选择。');
assert.match(knowledgePanel, /选择技能（\{selectedSkills\.length\}\/3）/u, '技能选择必须整合到加号入口，并显示本轮选择数。');
assert.ok((mainProcess.match(/thinkingMode: request\.thinkingMode/g) ?? []).length >= 3, 'The selected thinking mode must reach chat, direct, and dedicated knowledge-base RAG provider calls.');
assert.ok((mainProcess.match(/answerDepth: request\.answerDepth/g) ?? []).length >= 4, 'The selected answer depth must reach chat, direct, and dedicated knowledge-base answer prompts.');
assert.ok((mainProcess.match(/systemPrompt:/g) ?? []).length >= 3, 'Chat and grounded answer calls must pass native system instructions.');
assert.ok((mainProcess.match(/userPrompt:/g) ?? []).length >= 3, 'Chat and grounded answer calls must keep untrusted content in the user role.');
assert.ok((mainProcess.match(/resolveAssistantAnswerTemperature/g) ?? []).length >= 4, 'Every answer route must use the controlled temperature policy.');
assert.match(knowledgePanel, /return scope === 'current-note' \? '当前笔记问答' : '知识库问答'/, 'User-visible labels must distinguish the current note from the knowledge base.');
assert.match(knowledgePanel, /attachments: \[\.\.\.attachments\]/, '已发送附件必须保留在当前用户消息中用于回显。');
assert.match(knowledgePanel, /<AssistantMessageAttachments attachments=\{message\.attachments \?\? \[\]\}/, '用户消息必须渲染附件缩略图。');
assert.doesNotMatch(composerAttachments, /图片直传/u, 'Composer 不应向用户暴露“图片直传”实现术语。');
assert.match(composerAttachments, /attachment\.kind === 'image' \? ' image-only' : ''/, 'Composer 图片附件必须使用纯图片布局。');
assert.match(composerAttachments, /attachment\.kind === 'image'[\s\S]*?<Image[\s\S]*?: \([\s\S]*?assistant-attachment-meta/u, 'Composer 图片附件不得渲染文件名或容量信息。');
assert.match(messageAttachments, /<AssistantImageViewer image=\{previewImage\}/u, '图片缩略图必须接入共用弹窗预览。');
assert.match(imageViewer, /<Modal[\s\S]*?fullScreen/u, '图片缩略图必须提供沉浸式弹窗预览。');
assert.match(imageViewer, /aria-label="缩小图片"[\s\S]*?aria-label="放大图片"/u, '图片预览必须提供明确的缩放控制。');
assert.match(mainProcess, /\{ name: '文档', extensions: \[\.\.\.assistantDocumentExtensions\]/u, '附件选择器必须开放 PDF / DOCX 文档。');
assert.match(mainProcess, /parseAssistantDocumentAttachments\(request\.attachments \?\? \[\], \{[\s\S]*?signal,[\s\S]*?assistantMineru/u, '普通问答与学习路径必须先解析文档附件，并注入受主进程授权控制的 MinerU。');
assert.match(mainProcess, /function resolveAssistantMineruRuntimeConfig\(\)[\s\S]*?readMineruApiKey[\s\S]*?cloudParsingConsent/u, 'MinerU 必须同时受云端授权与主进程安全密钥控制。');
assert.match(mainProcess, /interactionRoute: documentNames\.length \? 'react' as const : 'chat' as const/u, '显式文本或文档附件必须绕过普通聊天分支并进入证据回答链路。');
assert.match(documentParser, /getDocument[\s\S]*?getTextContent/u, 'PDF 附件必须通过本地 PDF.js 提取文本。');
assert.match(documentParser, /runMammothDocxParse/u, 'DOCX 附件必须复用隔离的 Mammoth Worker。');
assert.match(documentParser, /removeOwnedTempDirectory/u, 'DOCX 附件解析必须清理本轮临时产物。');
assert.match(documentParser, /documentKind: 'PDF' \| 'DOCX'/u, '文档图片占位符必须显式区分 PDF 与 DOCX。');
assert.match(documentParser, /const placeholder = `\[\[\$\{documentKind\}_IMAGE:\$\{imageId\}\]\]`;/u, 'PDF / DOCX 图片必须通过统一逻辑映射为稳定占位符。');
assert.match(documentParser, /materializeAssistantDocumentImages/u, '相关文档图片必须经过数量、大小与哈希边界后再转成 VLM 输入。');
assert.match(preloadSource, /webUtils\.getPathForFile\(file\)/u, 'preload 必须只通过 Electron webUtils 获取用户拖入文件的真实路径。');
assert.match(preloadSource, /ingest-assistant-dropped-files/u, '拖入的文档路径必须交给主进程处理。');
assert.match(mainProcess, /collectAssistantAttachmentsFromPaths/u, '文件选择与拖拽必须复用同一套主进程白名单和大小校验。');
assert.match(mainProcess, /pickerKind === 'image' \? '添加 AI 图片'/u, '图片入口必须打开图片专用的选择器。');
assert.match(preloadSource, /selectAssistantAttachments: \(kind\?: 'image' \| 'file'\)/u, 'preload 必须向主进程传递附件选择类型。');
assert.match(attachmentHook, /ingestAssistantDroppedFiles\(localFiles\)/u, '附件 Hook 必须把拖入的 PDF\/DOCX\/文本交给 preload。');

// 多模态直传（方案 §8 Phase 3）：main.ts 必须从 image 附件提取 dataUrl，并在 chat / direct 两个回答调用点透传 images。
assert.match(mainProcess, /const turnImages: AiTransportImage\[\] = \(request\.attachments \?\? \[\]\)\.flatMap/, 'runAssistantTurn 必须从本轮 image 附件提取多模态直传数据。');
assert.ok((mainProcess.match(/\.\.\.\(turnImages\.length \? \{ images: turnImages \} : \{\}\)/g) ?? []).length >= 2, '显式图片必须透传到 Wiki 与 chat 调用点。');
assert.match(mainProcess, /const answerImages = \[\.\.\.turnImages, \.\.\.context\.images\]/u, '普通问答必须合并显式图片与相关文档图片。');
assert.match(mainProcess, /\.\.\.\(answerImages\.length \? \{ images: answerImages \} : \{\}\)/u, '合并后的图片必须透传到 direct VLM 调用点。');
assert.match(mainProcess, /if \(chatWebRuntime && turnImages\.length === 0 && !controller\.signal\.aborted\)/, '带图聊天必须绕开仅支持文本的联网 ReAct，进入 direct VLM 链路。');
const assistantTurnSource = fs.readFileSync(path.join(rootDir, 'electron', 'knowledge', 'assistantTurn.ts'), 'utf8');
assert.match(assistantTurnSource, /images\?: AiTransportImage\[\];/, 'streamKnowledgeAnswer 入参必须声明 images。');
assert.match(assistantTurnSource, /\.\.\.\(input\.images\?\.length \? \{ images: input\.images \} : \{\}\)/, 'streamKnowledgeAnswer 必须把 images 透传给 streamAiText。');

console.log('Assistant turn verification passed');
