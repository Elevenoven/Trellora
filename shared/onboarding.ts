export type OnboardingStep = 'menus' | 'ai' | 'question';
export type OnboardingStatus = 'pending' | 'active' | 'deferred' | 'completed' | 'dismissed';
export type OnboardingAction = 'start' | 'acknowledge-menus' | 'skip-ai' | 'defer' | 'resume' | 'dismiss' | 'finish' | 'show-ai' | 'show-question';

/** Only tutorial progress is persisted; credentials and answers stay in their existing stores. */
export interface OnboardingProgress {
  version: 2;
  flowVersion: 1;
  revision: number;
  status: OnboardingStatus;
  currentStep: OnboardingStep;
  progress: { menus: 'pending' | 'done'; ai: 'pending' | 'skipped' | 'done'; question: 'pending' | 'done' };
  selectedProfileId?: string;
  practiceSessionId?: string;
  successfulRequestId?: string;
  sampleImported: boolean;
  updatedAt: string;
  completedAt?: string;
}

export interface OnboardingConnection {
  profileId: string | null;
  state: 'missing' | 'saved-unverified' | 'tested' | 'failed';
  testAttempted: boolean;
}

export interface OnboardingState extends OnboardingProgress {
  workspacePath: string;
  libraryPath: string | null;
  connection: OnboardingConnection;
}

export interface OnboardingUpdate { action: OnboardingAction; expectedRevision: number }
export interface OnboardingPracticeBinding { profileId: string; sessionId: string; expectedRevision: number }

export const ONBOARDING_QUESTION = '请用 3 个步骤教我整理一次项目会议纪要。';

/** Bundled, fictional examples; importing uses exclusive creation and preserves user edits. */
export const ONBOARDING_SAMPLES = [
  { name: '欢迎使用 Trellora.md', content: '# 欢迎使用 Trellora\n\n这是一份可编辑的示例笔记。所有人物与项目均为虚构。\n\n## 先从本地开始\n\n修改这一段并等待保存。无需配置模型，也能编辑、保存和搜索关键词。\n\n## 连接笔记\n\n阅读 [[项目资料示例]]，尝试搜索“项目验收”。\n\n## 可选智能回答\n\n在设置中配置语言模型并检测连接后，可以让助手总结笔记。资料语义检索需要单独配置向量模型；PDF 云解析需要 MinerU。\n' },
  { name: '项目资料示例.md', content: '---\ntitle: 项目资料示例\ntags: [示例, 项目管理]\n---\n\n# 项目资料示例\n\n澄川科技的内部知识整理试点（虚构）由林晓负责。\n\n## 项目验收\n\n- 完成 20 份培训材料整理。\n- 用关键词检索“项目验收”，确认能找到本笔记。\n- 原始文件保存在所选笔记库中。\n\n## 待办\n\n- [ ] 编辑一次笔记并确认保存。\n- [ ] 回到 [[欢迎使用 Trellora]]。\n' },
];
