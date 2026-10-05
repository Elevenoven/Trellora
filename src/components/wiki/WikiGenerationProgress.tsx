import { t, useI18n } from '../../i18n';
import { ActionIcon, Badge, Group, Progress, Stack, Text, Tooltip } from '@mantine/core';
import { CircleAlert, LoaderCircle, RotateCcw } from 'lucide-react';
import type { WikiGenerationJob } from '../../wiki/wikiTypes';

interface WikiGenerationProgressProps {
  job: WikiGenerationJob;
  onRetryTask: (taskId: string) => void;
}

export default function WikiGenerationProgress({ job, onRetryTask }: WikiGenerationProgressProps) {
  useI18n();
  return (
    <section className="wiki-generation-progress" aria-label={t("整篇 Wiki 生成进度")}>
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <div>
          <Text size="sm" fw={680}>{t("整篇生成")}</Text>
          <Text size="xs" c="dimmed" mt={2}>{job.stage}{job.etaSeconds ? t(" · 预计约 {0} 秒", { '0': job.etaSeconds }) : ''}</Text>
        </div>
        <Text size="sm" fw={680}>{job.progress}%</Text>
      </Group>
      <Progress value={job.progress} color={job.status === 'partial' ? 'yellow' : 'teal'} mt="sm" size={7} />
      <Stack className="wiki-generation-task-list" gap={0} mt="sm">
        {job.tasks.map((task) => (
          <div key={task.id} className="wiki-generation-task">
            <span className={`wiki-generation-task-icon status-${task.status}`}>
              {task.status === 'running' ? <LoaderCircle size={14} /> : task.status === 'failed' ? <CircleAlert size={14} /> : <span />}
            </span>
            <div className="wiki-generation-task-copy">
              <Text size="xs" fw={620} lineClamp={1}>{task.title}</Text>
              <Text size="10px" c="dimmed" lineClamp={1}>{task.error ?? task.stage}</Text>
            </div>
            <Badge size="xs" variant="light" color={getTaskColor(task.status)}>{task.progress}%</Badge>
            {task.status === 'failed' ? (
              <Tooltip label={t("只重试此章节")} withArrow>
                <ActionIcon size="sm" variant="subtle" color="yellow" aria-label={t("重试 {0}", { '0': task.title })} onClick={() => onRetryTask(task.id)}>
                  <RotateCcw size={14} />
                </ActionIcon>
              </Tooltip>
            ) : null}
          </div>
        ))}
      </Stack>
    </section>
  );
}

function getTaskColor(status: WikiGenerationJob['tasks'][number]['status']): string {
  if (status === 'complete') return 'teal';
  if (status === 'failed') return 'red';
  if (status === 'running') return 'blue';
  return 'gray';
}
