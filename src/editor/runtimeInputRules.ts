import { defaultEditorPreferences } from '../../shared/editorPreferences';
import { type AnyExtension, InputRule, Extension } from '@tiptap/core';

/** Gate each installed rule at execution time; keep the editor, schema and history intact. */
export function withRuntimeInputRules<T extends AnyExtension>(extension: T, enabled?: () => boolean): T {
  return extension.extend({
    addInputRules() {
      return (this.parent?.() ?? []).map(rule => new InputRule({
        find: rule.find,
        handler: props => (enabled ? enabled() : this.editor.storage.editorPreferences.editorMarkdownAutoConvert) ? rule.handler(props) : null,
      }));
    },
  }) as T;
}

export const RuntimeEditorPreferences = Extension.create({ name: 'editorPreferences', addStorage() { return { ...defaultEditorPreferences }; } });
