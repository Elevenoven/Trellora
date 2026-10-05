import { useState } from 'react';
import { Alert, Badge, Button, Group, Stack, Text, Title } from '@mantine/core';
import { ArrowRight, Check, FileText, Library, Map, MessageSquare, Settings, Sparkles, Upload } from 'lucide-react';
import type { MainView } from '../NavRail';
import type { OnboardingController } from './useOnboarding';
import { t, useI18n } from '../../i18n';
import './OnboardingGuide.css';

const menuIntroductions = [
  { id: 'home', label: '助手', icon: MessageSquare, description: '向 AI 提问，也可以选择资料库进行知识问答。', detail: '第一轮练习从开放式问答开始，无需导入资料。' },
  { id: 'notes', label: '笔记', icon: FileText, description: '编辑、保存和搜索你的本地笔记。', detail: '不用配置 AI，也可以随时记录想法。' },
  { id: 'sources', label: '资料', icon: Upload, description: '导入文档，解析并建立可检索的资料库。', detail: '向量模型在需要资料检索时再配置。' },
  { id: 'wiki', label: 'Wiki', icon: Sparkles, description: '把资料整理为关联的知识页面。', detail: '先准备资料，再逐步生成与阅读 Wiki。' },
  { id: 'graph', label: '地图', icon: Map, description: '查看资料和知识之间的关联。', detail: '资料完成索引后，可以在地图中探索主题。' },
  { id: 'libraries', label: '笔记库', icon: Library, description: '创建、打开和管理本地笔记库。', detail: '选择一个本地文件夹，用来存放你的笔记。' },
  { id: 'settings', label: '设置', icon: Settings, description: '调整外观、模型和数据存放位置。', detail: '下一步在这里配置第一条语言模型连接。' },
] as const;

export function OnboardingBar({ guide }: { guide: OnboardingController }) {
  useI18n();
  return <header className="onboarding-bar" data-testid="onboarding-bar">
    <span className="onboarding-bar-title">{guide.review ? t('重新查看引导') : t('首次使用引导')}</span>
    <ol aria-label={t('引导步骤')}>{(['menus', 'ai', 'question'] as const).map((step, index) => <li key={step} aria-current={guide.step === step ? 'step' : undefined}><span>{guide.state?.progress[step] === 'done' ? <Check size={12} /> : index + 1}</span><b>{t(['认识菜单', '配置 AI', '第一次提问'][index])}</b></li>)}</ol>
    <Button variant="subtle" color="gray" size="compact-sm" disabled={guide.busy} onClick={() => void guide.pause()}>{guide.review ? t('关闭引导') : t('稍后继续')}</Button>
  </header>;
}

export function OnboardingMenus({ guide, selected, onSelect }: { guide: OnboardingController; selected: MainView; onSelect: (view: MainView) => void }) {
  useI18n();
  const current = menuIntroductions.find(item => item.id === selected) ?? menuIntroductions[0];
  const Icon = current.icon;
  return <section className="onboarding-menus" data-testid="first-run-guide" aria-labelledby="onboarding-menu-title">
    <div className="onboarding-eyebrow">Trellora · {t('第 1 步，共 3 步')}</div><Title order={1} id="onboarding-menu-title">{t('先认识你的工作空间')}</Title>
    <Text c="dimmed">{t('点击卡片或左侧菜单了解用途，准备好后继续配置 AI。')}</Text>
    <div className="onboarding-menu-grid">{menuIntroductions.map(item => { const MenuIcon = item.icon; return <button type="button" key={item.id} className="onboarding-menu-card" data-selected={selected === item.id || undefined} aria-pressed={selected === item.id} onClick={() => onSelect(item.id)}><MenuIcon size={19} /><strong>{t(item.label)}</strong><span>{t(item.description)}</span></button>; })}</div>
    <div className="onboarding-menu-detail" aria-live="polite"><Icon size={22} /><div><strong>{t(current.label)}</strong><p>{t(current.detail)}</p></div><Badge variant="light">{t('菜单预览')}</Badge></div>
    {guide.error && <Alert color="red">{guide.error}</Alert>}
    <Group justify="space-between" className="onboarding-menu-footer"><Text size="xs" c="dimmed">{t('本地笔记无需 AI，也能正常使用。')}</Text><Button rightSection={<ArrowRight size={16} />} loading={guide.busy} onClick={() => void guide.nextMenus()}>{t('我了解了，配置 AI')}</Button></Group>
  </section>;
}

export interface OnboardingModelDraft { profileId: string; dirty: boolean; busy: boolean }
export function OnboardingAiTask({ guide, draft }: { guide: OnboardingController; draft?: OnboardingModelDraft }) {
  useI18n();
  const connection = guide.state?.connection;
  const saved = connection?.profileId === draft?.profileId && !draft?.dirty && connection?.state !== 'missing';
  const tested = saved && connection?.state === 'tested';
  const failed = saved && connection?.state === 'failed';
  return <aside className="onboarding-task" aria-label={t('配置 AI 任务卡')} data-testid="onboarding-ai-task"><Stack gap="md">
    <div className="onboarding-eyebrow">{t('第 2 步，共 3 步')}</div><Title order={3}>{t('连接你的第一个模型')}</Title><Text size="sm" c="dimmed">{t('只需配置一个语言模型，就能开始提问。向量、重排和解析服务可以以后再配。')}</Text>
    <ol className="onboarding-checklist"><li>{t('选择本地 Ollama 或远程 API')}</li><li>{t('填写地址、密钥和模型名称')}</li><li>{t('测试连接，再保存模型设置')}</li></ol>
    <Text size="xs" c="dimmed">{t('测试连接检查服务与模型目录；真正生成回答将在下一步验证。')}</Text>
    {guide.review ? <Badge variant="light">{t('查看已保存的模型设置')}</Badge> : <Badge variant="light" color={tested ? 'teal' : failed ? 'orange' : 'gray'}>{t(draft?.dirty ? '配置已修改，请重新测试并保存' : tested ? '已测试并保存' : failed ? '目录检测失败，配置已保存' : saved ? '已保存，尚未测试' : '请填写并保存模型配置')}</Badge>}
    {failed && <Text size="sm">{t('部分网关不开放模型目录。确认配置已保存后，可以尝试一次真实提问。')}</Text>}
    {guide.error && <Alert color="red">{guide.error}</Alert>}
    <Button fullWidth disabled={!guide.review && (!tested || draft?.busy || guide.busy)} onClick={() => void guide.nextQuestion()}>{t('下一步，去提问')}</Button>
    {failed && !guide.review && <Button fullWidth variant="light" disabled={draft?.busy || guide.busy} onClick={() => void guide.nextQuestion()}>{t('配置已保存，尝试一次提问')}</Button>}
    {saved && !tested && !failed && !guide.review && <Button fullWidth variant="light" disabled={draft?.busy || guide.busy} onClick={() => void guide.nextQuestion()}>{t('使用已有模型，直接提问')}</Button>}
    <Button fullWidth variant="subtle" color="gray" disabled={guide.busy || draft?.busy} onClick={() => guide.review ? void guide.nextQuestion() : void guide.act('skip-ai')}>{t(connection?.state !== 'missing' && connection?.profileId ? '跳过配置，使用已有模型' : '先跳过，查看提问方式')}</Button>
    <Button variant="subtle" color="gray" size="xs" onClick={guide.backMenus}>{t('返回菜单介绍')}</Button>
  </Stack></aside>;
}

export function OnboardingCompletion({ guide, onNotes, onMaterials }: { guide: OnboardingController; onNotes: () => void; onMaterials: () => void }) {
  useI18n();
  const [importError, setImportError] = useState<string>();
  const [importing, setImporting] = useState(false);
  const importSample = async () => { setImporting(true); setImportError(undefined); try { await window.electronAPI.importOnboardingSample(); await guide.refresh(); } catch (failure) { setImportError(failure instanceof Error ? t(failure.message) : t('示例导入失败，请重试。')); } finally { setImporting(false); } };
  return <section className="onboarding-completion" data-testid="onboarding-completion" aria-live="polite"><div><Check size={20} /><strong>{t('你已经完成第一次提问')}</strong><span>{t('练习对话已保留，可以继续聊。')}</span></div><Group gap="xs"><Button size="xs" onClick={guide.closeCelebration}>{t('继续提问')}</Button><Button size="xs" variant="default" onClick={onNotes}>{t('去写笔记')}</Button><Button size="xs" variant="default" onClick={onMaterials}>{t('导入我的资料')}</Button>{guide.state?.libraryPath && <Button size="xs" variant="subtle" loading={importing} disabled={guide.state.sampleImported} onClick={() => void importSample()}>{guide.state.sampleImported ? t('示例已导入') : t('导入中文示例')}</Button>}</Group>{importError && <Text c="red" size="xs">{importError}</Text>}</section>;
}
