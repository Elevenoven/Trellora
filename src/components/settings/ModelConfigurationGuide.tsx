import { useRef, useState } from 'react';
import { Accordion, Alert, Anchor, Badge, Box, Button, Code, Group, List, Modal, SegmentedControl, Stack, Tabs, Text } from '@mantine/core';
import { Bot, Database, ExternalLink, Filter, Info } from 'lucide-react';
import { t, useI18n } from '../../i18n';
import type { ModelSlotId } from '../../../shared/modelHubTypes';
import './ModelConfigurationGuide.css';

type GuideStep = { title: string; detail: string; command?: string };

const remoteGenerationSteps: GuideStep[] = [
  { title: '获取服务商的 API Key', detail: '登录你要使用的服务商开放平台，开通模型调用并创建 API Key。网页版聊天账号或订阅不等于 API 调用权限。' },
  { title: '添加语言模型连接', detail: '关闭教程，点击“添加连接” → “语言模型”。填写便于辨认的名称，在“连接方式”选择“远程 API”，再选择对应的“API 厂商”。' },
  { title: '填写 API 地址与密钥', detail: '选择厂商后会自动填入默认 API 地址。若控制台提供地域或专属地址，以控制台为准。填写新 API Key；编辑已有连接时，密钥留空会保留原密钥。' },
  { title: '选择模型', detail: '点击“获取目录”，选择账号可用的语言模型。目录没有返回时，可开启“自定义模型名”，填写服务商文档中的完整模型 ID；不要填写网页产品名或连接名称。' },
  { title: '测试并保存', detail: '点击“测试连接”，成功后点击“保存模型设置”。需要作为默认模型时，先点击“设为默认”，再保存。“上下文窗口”通常保持“自动识别”即可。' },
];

const remoteEmbeddingSteps: GuideStep[] = [
  { title: '准备支持向量化的服务', detail: '确认服务商提供 Embedding 接口，并为账号开通该模型。语言模型、向量模型可以使用不同的厂商和密钥。' },
  { title: '添加 Embedding 连接', detail: '关闭教程，点击“添加连接” → “Embedding”。在“连接方式”选择远程厂商，核对“API 厂商”与“API 地址”，再填写 API Key。' },
  { title: '选择向量模型', detail: '点击“获取目录”后选择向量模型，例如百炼 text-embedding-v3；也可开启“自定义模型名”。普通聊天模型不能代替 Embedding。' },
  { title: '保存并应用到资料库', detail: '点击“保存配置”，然后到资料库的向量模型设置中选择并绑定模型，完成向量化后再验证语义检索。这里的默认模型不会自动替换已有资料库的绑定。' },
];

const rerankSteps: GuideStep[] = [
  { title: '确认是否需要 Rerank', detail: 'Rerank 会对已检索出的候选片段再次排序，让更相关的内容排在前面。它是可选能力，初次配置可以先完成语言模型与 Embedding。' },
  { title: '选择支持重排序的服务商', detail: '点击“添加连接” → “Rerank”，在“连接方式”选择远程厂商。服务商必须提供重排序接口；能调用聊天模型，并不代表支持 Rerank。' },
  { title: '填写连接并选择重排序模型', detail: '核对“API 厂商”和“API 地址”，填写 API Key，再从“获取目录”或“自定义模型名”选择重排序模型，例如 BAAI/bge-reranker-v2-m3。模型名以服务商可用目录为准。' },
  { title: '保存后验证资料问答', detail: '点击“保存配置”，再用已处理的资料库发起问答并查看检索结果。保存成功只代表配置已写入；实际调用仍需服务商支持、模型权限和可用网络。需要关闭时选择“暂不使用”并保存。' },
];

function localSteps(category: 'generation' | 'embedding'): GuideStep[] {
  const generation = category === 'generation';
  return [
    { title: '安装 Ollama 并下载模型', detail: '先从 Ollama 官网安装并启动应用，在终端运行下方命令下载模型。首次下载需要联网；模型名称可换成你选择的本地模型。', command: generation ? 'ollama pull qwen3:4b\nollama list' : 'ollama pull bge-m3\nollama list' },
    { title: '选择本地连接方式', detail: generation ? '点击“添加连接” → “语言模型”，在“连接方式”选择“本地模型（Ollama）”，填写便于辨认的连接名称。' : '点击“添加连接” → “Embedding”，在“连接方式”选择“本地模型（Ollama）”。请使用向量模型，不要选择下载的聊天模型。' },
    { title: '填写地址与模型名', detail: 'Ollama 地址通常填写 http://127.0.0.1:11434，不要附加 /api/chat、/api/embed 或 /v1。从列表选择已下载模型；列表为空时，先确认 Ollama 正在运行，或开启“自定义模型名”填写 ollama list 显示的完整名称。' },
    { title: generation ? '测试并保存' : '保存并应用到资料库', detail: generation ? '本地 Ollama 无需 API Key。点击“测试连接”，成功后点击“保存模型设置”，再到助手发送一条问题验证。' : '本地 Ollama 无需 API Key。点击“保存配置”，再到资料库绑定该向量模型并完成向量化，最后验证语义检索。已有资料库不会自动更换模型。' },
  ];
}

function Steps({ steps }: { steps: GuideStep[] }) {
  return <List type="ordered" spacing="md" className="model-guide-steps">
    {steps.map(step => <List.Item key={step.title}>
      <Text size="sm" fw={650}>{t(step.title)}</Text>
      <Text size="sm" c="dimmed" mt={4} lh={1.8}>{t(step.detail)}</Text>
      {step.command && <Code block mt="xs" className="model-guide-code">{step.command}</Code>}
    </List.Item>)}
  </List>;
}

/** Tutorials only present instructions; viewing them never reads keys or changes a model draft. */
export default function ModelConfigurationGuide({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  useI18n();
  const [category, setCategory] = useState<ModelSlotId>('generation');
  const [connection, setConnection] = useState('remote');
  const scrollRef = useRef<HTMLDivElement>(null);
  const isLocal = connection === 'local' && category !== 'rerank';
  const steps = category === 'rerank' ? rerankSteps : isLocal ? localSteps(category) : category === 'embedding' ? remoteEmbeddingSteps : remoteGenerationSteps;

  return <Modal opened={opened} onClose={onClose} title={t('模型配置教程')} centered size={820} padding="lg" classNames={{ content: 'model-configuration-guide', body: 'model-guide-body' }}>
    <Box className="model-guide-scroll" ref={scrollRef}>
      <Text size="sm" c="dimmed" mb="md" lh={1.8}>{t('先配置语言模型来问答，再配置 Embedding 做资料语义检索；Rerank 用于进一步改善检索排序，可稍后配置。')}</Text>
      <Tabs value={category} onChange={value => {
        if (value === 'generation' || value === 'embedding' || value === 'rerank') {
          setCategory(value);
          scrollRef.current?.scrollTo({ top: 0 });
        }
      }} keepMounted={false}>
        <Tabs.List className="model-guide-tabs" grow>
          <Tabs.Tab value="generation" leftSection={<Bot size={16} />}>{t('语言模型')}</Tabs.Tab>
          <Tabs.Tab value="embedding" leftSection={<Database size={16} />}>Embedding</Tabs.Tab>
          <Tabs.Tab value="rerank" leftSection={<Filter size={16} />}>Rerank <Badge size="xs" color="gray" variant="light" ml={4}>{t('可选')}</Badge></Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value={category} pt="md">
      <Stack gap="lg">
        <Group justify="space-between" align="center" gap="sm">
          <Text size="sm" fw={650}>{t(category === 'generation' ? '用于问答、摘要与内容生成' : category === 'embedding' ? '用于把资料转成可检索的语义向量' : '用于对检索候选结果再次排序')}</Text>
          {category !== 'rerank' && <SegmentedControl size="xs" value={connection} onChange={value => { setConnection(value); scrollRef.current?.scrollTo({ top: 0 }); }} aria-label={t('教程连接方式')} data={[{ value: 'remote', label: t('在线服务') }, { value: 'local', label: t('本地 Ollama') }]} />}
        </Group>
        <Steps steps={steps} />
        {category === 'generation' && !isLocal && <Alert color="blue" variant="light" icon={<Info size={17} />}>
          <Text size="sm" lh={1.8}>{t('DeepSeek、百炼等选择对应厂商即可；Claude 与 Gemini 也应选择各自厂商。只有明确提供 OpenAI 兼容接口的网关，才选择“自定义 OpenAI 兼容 API”。API 地址填写服务根地址，不要附加 /chat/completions 或 /responses。')}</Text>
        </Alert>}
        {category === 'embedding' && <Alert color="blue" variant="light" icon={<Info size={17} />}>
          <Text size="sm" lh={1.8}>{t('已建立向量索引的资料库绑定了自己的模型。更换模型需要在该资料库中迁移或重建向量索引，不能直接混用不同模型生成的向量。')}</Text>
        </Alert>}
        {category === 'rerank' && <Alert color="orange" variant="light" icon={<Info size={17} />}>
          <Text size="sm" lh={1.8}>{t('当前版本的 Ollama 连接不提供 Rerank 能力，请选择支持重排序的远程服务，或保留“暂不使用”。')}</Text>
        </Alert>}
        <Accordion variant="contained" className="model-guide-faq">
          <Accordion.Item value="troubleshooting"><Accordion.Control>{t('配置遇到问题？')}</Accordion.Control><Accordion.Panel>
            <Stack gap="sm">
              <Text size="sm" lh={1.8}><strong>{t('认证失败（401 / 403）：')}</strong>{t('检查 API Key 是否完整、是否属于当前服务商和地域，以及账号是否开通了该模型。')}</Text>
              <Text size="sm" lh={1.8}><strong>{t('模型不存在或目录为空：')}</strong>{t('先核对模型 ID 与权限。获取目录失败不一定代表不能调用，可按官方文档填写自定义模型名；Ollama 则先检查 ollama list。')}</Text>
              <Text size="sm" lh={1.8}><strong>{t('连接失败或超时：')}</strong>{t('检查地址、网络及代理；本地连接检查 Ollama 是否运行。不要把网页聊天地址填入 API 地址。')}</Text>
              <Text size="sm" lh={1.8}><strong>{t('额度不足或请求过多（429）：')}</strong>{t('检查服务商账号余额、模型额度和调用频率，稍后再试。')}</Text>
              <Text size="sm" lh={1.8}><strong>{t('保存后仍无法语义检索：')}</strong>{t('确认当前资料库已绑定向量模型、完成向量化，并且向量模型服务可用。仅保存默认 Embedding 不会生成资料库索引。')}</Text>
            </Stack>
          </Accordion.Panel></Accordion.Item>
        </Accordion>
        <Group gap="md" className="model-guide-docs">
          <Text size="xs" c="dimmed">{t('官方文档')}</Text>
          {isLocal ? <><DocLink href="https://ollama.com/download" label="安装 Ollama" /><DocLink href={category === 'generation' ? 'https://ollama.com/library/qwen3' : 'https://ollama.com/library/bge-m3'} label="模型与下载命令" /></> : category === 'generation' ? <><DocLink href="https://api-docs.deepseek.com/" label="DeepSeek 接入指南" /><DocLink href="https://help.aliyun.com/zh/model-studio/get-api-key" label="百炼 API Key" /></> : category === 'embedding' ? <DocLink href="https://help.aliyun.com/zh/model-studio/text-embedding-synchronous-api" label="百炼向量模型" /> : <DocLink href="https://docs.siliconflow.cn/docs/api/rerank-post" label="SiliconFlow 重排序" />}
        </Group>
      </Stack>
        </Tabs.Panel>
      </Tabs>
    </Box>
    <Group className="model-guide-footer" justify="space-between" gap="sm">
      <Text size="xs" c="dimmed">{t('配置完成后，记得保存并验证实际使用效果。')}</Text>
      <Button size="sm" variant="light" onClick={onClose}>{t('关闭教程')}</Button>
    </Group>
  </Modal>;
}

function DocLink({ href, label }: { href: string; label: string }) {
  return <Anchor href={href} target="_blank" rel="noopener noreferrer" size="xs" className="model-guide-doc-link">{t(label)}<ExternalLink size={12} aria-hidden="true" /></Anchor>;
}
