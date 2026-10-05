import { mergeAttributes, Node } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { createFormulaNodeView } from './FormulaNodeView';

const formulaAttributes = () => Object.fromEntries(
  ['mathSource', 'mathMarkdown', 'mathDelimiter', 'mathDisplay'].map((name) => {
    const attribute = `data-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
    return [name, {
      default: null,
      parseHTML: (element: HTMLElement) => element.getAttribute(attribute),
      renderHTML: (attributes: Record<string, unknown>) => attributes[name] == null ? {} : { [attribute]: attributes[name] },
    }];
  }),
);

/** Display math keeps editable text and its original delimiters, with a separate KaTeX view. */
export const FormulaBlock = Node.create({
  name: 'formulaBlock',

  group: 'block',
  content: 'text*',
  code: true,
  marks: '',
  defining: true,
  isolating: true,

  addAttributes: formulaAttributes,
  addNodeView: () => createFormulaNodeView,

  parseHTML() {
    return [{
      tag: 'div[data-type="formulaBlock"]',
      contentElement: 'code',
    }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'formulaBlock',
        'data-formula-block': 'true',
      }),
      ['code', 0],
    ];
  },
});

/** Inline math also covers display delimiters embedded in an existing paragraph. */
export const InlineFormula = Node.create({
  name: 'inlineFormula',
  group: 'inline',
  inline: true,
  content: 'text*',
  marks: '',
  code: true,
  isolating: true,
  addAttributes: formulaAttributes,
  addNodeView: () => createFormulaNodeView,
  addProseMirrorPlugins() {
    const insertSource = (view: import('@tiptap/pm/view').EditorView, text: string) => {
      const { $from, $to } = view.state.selection;
      if ($from.parent.type.name !== this.name || !$from.sameParent($to)) return false;
      view.dispatch(view.state.tr.insertText(text).scrollIntoView());
      return true;
    };
    return [new Plugin({
      props: {
        // Native DOM reparsing moves input out of a non-leaf inline node at its boundary.
        // Commit source typing through the document transaction before that reparse.
        handleDOMEvents: {
          beforeinput(view, event) {
            const input = event as InputEvent;
            if (input.inputType !== 'insertText' || input.isComposing || input.data == null) return false;
            if (!insertSource(view, input.data)) return false;
            event.preventDefault();
            return true;
          },
        },
        handleTextInput(view, _from, _to, text) {
          return insertSource(view, text);
        },
      },
    })];
  },
  parseHTML() {
    return [{ tag: 'span[data-type="inlineFormula"]', contentElement: 'code' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-type': 'inlineFormula' }), ['code', 0]];
  },
});
