import type {
  SelectionEditAction,
  SelectionEditContextScope,
  SelectionEditSourceAuthorization,
  SelectionEditWritebackMode,
} from './selectionEditTypes';

export const selectionEditContextStrategies = ['local-first', 'current-note-adaptive', 'content-classified'] as const;
export type SelectionEditContextStrategy = typeof selectionEditContextStrategies[number];

export const selectionEditEvidencePolicies = ['forbid-new-facts', 'require-for-new-facts', 'when-additive'] as const;
export type SelectionEditEvidencePolicy = typeof selectionEditEvidencePolicies[number];

export const selectionEditProtectedAnchorKinds = [
  'number',
  'date',
  'url',
  'code',
  'proper-noun',
  'link-target',
  'placeholder',
] as const;
export type SelectionEditProtectedAnchorKind = typeof selectionEditProtectedAnchorKinds[number];

export interface SelectionEditActionProfile {
  label: string;
  description: string;
  contextStrategy: SelectionEditContextStrategy;
  defaultContextScope: SelectionEditContextScope;
  defaultWritebackMode: SelectionEditWritebackMode;
  defaultAllowedSources: SelectionEditSourceAuthorization;
  evidencePolicy: SelectionEditEvidencePolicy;
  protectedAnchorKinds: readonly SelectionEditProtectedAnchorKind[];
}

const localOnlySources: SelectionEditSourceAuthorization = {
  currentNote: true,
  noteLibrary: false,
  materialsLibrary: false,
  web: false,
  personalization: false,
};

/**
 * SE-0 defaults. They describe intended routing only; they do not make any
 * source available before the corresponding capability adapter is implemented.
 */
export const selectionEditProfiles = {
  polish: {
    label: '润色表达',
    description: '改善清晰度和连贯性，不新增事实。',
    contextStrategy: 'local-first',
    defaultContextScope: 'auto',
    defaultWritebackMode: 'replace',
    defaultAllowedSources: localOnlySources,
    evidencePolicy: 'forbid-new-facts',
    protectedAnchorKinds: selectionEditProtectedAnchorKinds,
  },
  shorten: {
    label: '精简',
    description: '保留关键结论和限定条件，删除重复表达。',
    contextStrategy: 'current-note-adaptive',
    defaultContextScope: 'auto',
    defaultWritebackMode: 'replace',
    defaultAllowedSources: localOnlySources,
    evidencePolicy: 'forbid-new-facts',
    protectedAnchorKinds: selectionEditProtectedAnchorKinds,
  },
  expand: {
    label: '扩写',
    description: '按需读取当前笔记相关原文，并为新增事实提供依据。',
    contextStrategy: 'current-note-adaptive',
    defaultContextScope: 'auto',
    defaultWritebackMode: 'insert-below',
    defaultAllowedSources: localOnlySources,
    evidencePolicy: 'require-for-new-facts',
    protectedAnchorKinds: selectionEditProtectedAnchorKinds,
  },
  proofread: {
    label: '校对',
    description: '修正语病、标点和术语一致性，不改变原意。',
    contextStrategy: 'local-first',
    defaultContextScope: 'auto',
    defaultWritebackMode: 'replace',
    defaultAllowedSources: localOnlySources,
    evidencePolicy: 'forbid-new-facts',
    protectedAnchorKinds: selectionEditProtectedAnchorKinds,
  },
  explain: {
    label: '解释',
    description: '结合当前笔记的定义和论证补充说明。',
    contextStrategy: 'current-note-adaptive',
    defaultContextScope: 'auto',
    defaultWritebackMode: 'insert-below',
    defaultAllowedSources: localOnlySources,
    evidencePolicy: 'require-for-new-facts',
    protectedAnchorKinds: selectionEditProtectedAnchorKinds,
  },
  translate: {
    label: '翻译',
    description: '保持术语、专名、代码和链接一致。',
    contextStrategy: 'local-first',
    defaultContextScope: 'auto',
    defaultWritebackMode: 'replace',
    defaultAllowedSources: localOnlySources,
    evidencePolicy: 'forbid-new-facts',
    protectedAnchorKinds: selectionEditProtectedAnchorKinds,
  },
  custom: {
    label: '自定义',
    description: '先区分形式改写与内容增补，再决定来源和写回方式。',
    contextStrategy: 'content-classified',
    defaultContextScope: 'auto',
    defaultWritebackMode: 'copy-only',
    defaultAllowedSources: localOnlySources,
    evidencePolicy: 'when-additive',
    protectedAnchorKinds: selectionEditProtectedAnchorKinds,
  },
} as const satisfies Record<SelectionEditAction, SelectionEditActionProfile>;
