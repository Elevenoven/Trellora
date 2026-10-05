import { t } from '../../i18n';
import type { MemoryItemRecord } from '../../../electron/knowledge/memory/memoryTypes';

export function reviewReasonLabel(reason: MemoryItemRecord['reviewReason']): string {
  return reason ? t(({ INFERRED_FACT: '自动提炼，需确认', TARGET_REPLACEMENT: '更正已有记忆', TARGET_RETIREMENT: '撤销已有记忆',
    AMBIGUOUS_RELATION: '新增或更正关系不明确', LEGACY_PROPOSAL: '旧版待确认记忆', TARGET_CHANGED: '原记忆已变化', TARGET_DELETED: '原记忆已删除', TARGET_EXPIRED: '原记忆已过期' } as const)[reason]) : t('用户提交');
}
