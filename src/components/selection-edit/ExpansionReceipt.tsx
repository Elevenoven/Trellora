import { t, useI18n } from '../../i18n';
import { Text } from '@mantine/core';
import type { SelectionContextReceipt, SelectionEditQualityReceipt } from '../../../electron/knowledge/selectionEditTypes';

/** Both entrypoints show length for review, without a minimum or deficit warning. */
export default function ExpansionReceipt({ context, quality }: { context?: SelectionContextReceipt; quality?: SelectionEditQualityReceipt }) {
  useI18n();
  const length = quality?.lengthReceipt;
  return <>
    {context?.contextMode === 'full-note' ? <Text size="xs" c="dimmed">{t("上下文：当前笔记全文 ·")} {context.fullNoteCharacters} {t("字符，已完整纳入。")}</Text>
      : context?.contextMode === 'related-original' ? <Text size="xs" c="dimmed">{t("上下文：ReAct 深读相关原文 · 已纳入")} {context.includedCharacters ?? 0}{context.fullNoteCharacters === undefined ? '' : t(" / 当前笔记全文 {0}", { '0': context.fullNoteCharacters })} {t("字符。")}</Text>
        : context?.contextMode === 'nearby' ? <Text size="xs" c="dimmed">{t("上下文：相邻文字。")}</Text> : null}
    {length ? <>
      <Text size="xs" c="dimmed">{t("原文")} {length.originalCharacters} {t("· 目标")} {length.targetCharacters} {t("· 实际")} {length.actualCharacters} {t("个有效字符。")}</Text>
      <Text size="xs" c="dimmed">{t("字数仅供参考，请核对内容后再应用。")}</Text>
    </> : null}
  </>;
}
