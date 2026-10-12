import { useRef, useState } from 'react';
import { Accordion, Alert, Box, Button, Code, Group, List, Modal, Paper, Stack, Tabs, Text } from '@mantine/core';
import { FolderInput, Info, PencilLine, Sparkles } from 'lucide-react';
import { t, useI18n } from '../../i18n';
import './ModelConfigurationGuide.css';

type GuideSection = 'create' | 'import' | 'use';
type GuideStep = { title: string; detail: string };

const createSteps: GuideStep[] = [
  { title: '打开新建表单', detail: '关闭教程，点击“新建技能”。技能是助手的任务说明与输出规则，可先用内置技能，再按自己的工作习惯创建。' },
  { title: '填写技能名称与能力描述', detail: '名称用于识别技能；能力描述简短说明“什么时候用、用来做什么”。名称支持汉字、字母、数字和连字符，最多 64 个字符，不含空格或下划线；不要与已有技能重名。' },
  { title: '写清工作约束', detail: '填写处理步骤、输出格式和边界，例如如何整理结论、如何标记缺失信息。不要只写“你是一个专家”；具体规则更容易检查效果。' },
  { title: '创建并检查', detail: '三个字段都填写后，点击“创建技能”。成功后会返回技能库，可点击“查看”检查内容，再确认状态已启用。' },
];

const importSteps: GuideStep[] = [
  { title: '准备技能文件', detail: '技能入口是 SKILL.md：文件开头用两行 --- 包住 name 和 description，下面写 Markdown 工作约束。name 和 description 都必须填写在单行中，正文不能为空。' },
  { title: '选择合适的导入方式', detail: '点击“导入技能”：有完整技能目录时选“选择文件夹（内含 SKILL.md）”；有压缩包时选“选择 .zip 技能包”；只有规则文件时选“选择 SKILL.md 文件”。单文件导入只复制该文件，不会带上旁边的附加文档。' },
  { title: '确认导入结果', detail: '导入成功后，技能会出现在列表中，并保存在当前工作区的 AI-Skill/技能名/ 下。检查能力描述、工作约束与附加文件数量，再启用并到助手选择。' },
];

const useSteps: GuideStep[] = [
  { title: '启用需要的技能', detail: '在技能库打开状态开关，切换会立即保存。启用表示可以被选择；每轮是否使用，还取决于助手中选了哪些技能。' },
  { title: '在助手中选择', detail: '打开助手，点击输入框旁的“＋”（添加图片、附件或技能），在“选择技能”中点击需要的技能，勾选后再发送问题。每轮最多选 3 个，再次点击已选技能可取消。' },
  { title: '配合真实资料验证', detail: '例如选择“会议纪要整理”，提供会议记录并要求输出纪要。需要根据笔记或资料库作答时，另行选择对应资料来源；技能规定工作方式，实际内容来自你提供的资料。' },
  { title: '查看、编辑与备份', detail: '“查看”用于检查规则；“编辑”修改能力描述和工作约束后要点“保存”。目录技能可用“打开目录”查看 SKILL.md 与附加文档，用“导出”保存为 zip，之后可重新导入。' },
];

const exampleDescription = '用户提供会议记录并需要整理纪要时使用；输出议题、结论与待办。';
const exampleInstruction = '1. 按议题整理讨论内容与已确认结论。\n2. 用表格列出待办、负责人和截止日期。\n3. 资料未提及的信息标记为“待确认”，不得编造。';

function Steps({ steps }: { steps: GuideStep[] }) {
  return <List type="ordered" spacing="md" className="model-guide-steps">
    {steps.map(step => <List.Item key={step.title}>
      <Text size="sm" fw={650}>{t(step.title)}</Text>
      <Text size="sm" c="dimmed" mt={4} lh={1.8}>{t(step.detail)}</Text>
    </List.Item>)}
  </List>;
}

/** Read-only help follows the current skill import and per-turn selection contracts. */
export default function SkillConfigurationGuide({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  useI18n();
  const [section, setSection] = useState<GuideSection>('create');
  const scrollRef = useRef<HTMLDivElement>(null);
  const steps = section === 'create' ? createSteps : section === 'import' ? importSteps : useSteps;

  return <Modal opened={opened} onClose={onClose} title={t('技能配置教程')} centered size={820} padding="lg" classNames={{ content: 'model-configuration-guide skill-configuration-guide', body: 'model-guide-body' }}>
    <Box className="model-guide-scroll" ref={scrollRef}>
      <Text size="sm" c="dimmed" mb="md" lh={1.8}>{t('先新建或导入技能，再启用并在助手中选择。技能用来约定处理任务的方法和输出格式。')}</Text>
      <Tabs value={section} onChange={value => {
        if (value === 'create' || value === 'import' || value === 'use') {
          setSection(value);
          scrollRef.current?.scrollTo({ top: 0 });
        }
      }} keepMounted={false}>
        <Tabs.List className="model-guide-tabs" grow>
          <Tabs.Tab value="create" leftSection={<PencilLine size={16} />}>{t('新建技能')}</Tabs.Tab>
          <Tabs.Tab value="import" leftSection={<FolderInput size={16} />}>{t('导入技能')}</Tabs.Tab>
          <Tabs.Tab value="use" leftSection={<Sparkles size={16} />}>{t('使用与管理')}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value={section} pt="md">
          <Stack gap="lg">
            <Steps steps={steps} />
            {section === 'create' && <Paper withBorder radius="sm" p="md">
              <Stack gap="sm">
                <Text size="sm" fw={650}>{t('填写示例：会议纪要整理')}</Text>
                <Text size="sm"><strong>{t('技能名称')}：</strong>{t('会议纪要整理')}</Text>
                <Text size="sm" lh={1.8}><strong>{t('能力描述')}：</strong>{t(exampleDescription)}</Text>
                <Box><Text size="sm" fw={650} mb={4}>{t('工作约束')}</Text><Text size="sm" lh={1.8} style={{ whiteSpace: 'pre-wrap' }}>{t(exampleInstruction)}</Text></Box>
              </Stack>
            </Paper>}
            {section === 'import' && <Box>
              <Text size="sm" fw={650} mb="xs">{t('SKILL.md 最小示例')}</Text>
              <Code block className="model-guide-code">{`---\nname: ${t('会议纪要整理')}\ndescription: "${t(exampleDescription)}"\n---\n\n${t(exampleInstruction)}`}</Code>
            </Box>}
            {section === 'use' && <Alert color="blue" variant="light" icon={<Info size={17} />}>
              <Text size="sm" lh={1.8}>{t('每次发送前确认所选技能与任务匹配。助手只使用本轮选中技能的工作约束；需要根据资料回答时，也要提供或选择相应资料。')}</Text>
            </Alert>}
            <Accordion variant="contained" className="model-guide-faq">
              <Accordion.Item value="troubleshooting"><Accordion.Control>{t('技能配置常见问题')}</Accordion.Control><Accordion.Panel>
                <Stack gap="sm">
                  <Text size="sm" lh={1.8}><strong>{t('助手中找不到技能：')}</strong>{t('先确认状态已启用，再重新打开输入框的“＋”菜单刷新列表。技能较多时可以翻页；若设置页提示“部分目录技能未生效”，按列出的原因修正。')}</Text>
                  <Text size="sm" lh={1.8}><strong>{t('名称重复或格式不正确：')}</strong>{t('同名技能不会被覆盖，请改用新名称。name 遵守名称规则，description 不能为空且最多 500 个字符；避免在名称和描述中使用 XML 标签或 system、default 等保留词作为名称的一部分。')}</Text>
                  <Text size="sm" lh={1.8}><strong>{t('附加文档怎么带入？')}</strong>{t('用文件夹或 zip 一起导入，与 SKILL.md 放在同一技能目录中。支持 Markdown、TXT、CSV、TSV、JSON 和 YAML 文本，可作为模板或补充规则按需读取；技能不会执行脚本。PDF、Word、图片等应通过助手附件或资料库提供。')}</Text>
                </Stack>
              </Accordion.Panel></Accordion.Item>
            </Accordion>
          </Stack>
        </Tabs.Panel>
      </Tabs>
    </Box>
    <Group className="model-guide-footer" justify="space-between" gap="sm">
      <Text size="xs" c="dimmed">{t('配置完成后，到助手选择技能并发送一条实际任务验证。')}</Text>
      <Button size="sm" variant="light" onClick={onClose}>{t('关闭教程')}</Button>
    </Group>
  </Modal>;
}
