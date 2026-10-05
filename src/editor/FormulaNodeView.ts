import type { NodeViewRendererProps } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import type { NodeView } from '@tiptap/pm/view';
import { t } from '../i18n';
import { renderMathHtml } from '../utils/markdownMath';

/** Render math separately from contentDOM so KaTeX markup never enters the saved source. */
export function createFormulaNodeView({ node: initialNode, editor, view, getPos }: NodeViewRendererProps): NodeView {
  let node = initialNode;
  const block = node.type.name === 'formulaBlock';
  const dom = document.createElement(block ? 'div' : 'span');
  dom.className = `formula-node ${block ? 'formula-block' : 'formula-inline'}`;
  dom.dataset.type = node.type.name;
  dom.dataset.editing = 'false';

  const preview = document.createElement('span');
  preview.className = 'formula-preview';
  preview.contentEditable = 'false';
  preview.title = t('点击编辑公式');
  const contentDOM = document.createElement('code');
  contentDOM.className = 'formula-source';
  dom.append(preview, contentDOM);
  let finishingEditClick = false;

  const render = () => {
    const display = block || node.attrs.mathDisplay === 'true';
    dom.dataset.display = String(display);
    preview.innerHTML = renderMathHtml(node.textContent, display);
  };
  const syncSelection = () => {
    const pos = getPos();
    const { from, to } = view.state.selection;
    dom.dataset.editing = String(editor.isFocused && typeof pos === 'number'
      && from >= pos + 1 && to <= pos + node.nodeSize - 1);
  };
  const placeCaret = () => {
    const pos = getPos();
    if (typeof pos !== 'number') return;
    dom.dataset.editing = 'true';
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + 1)));
    view.focus();
    // Native inline-node boundary selection may land before the node; anchor inside its source.
    view.dom.ownerDocument.getSelection()?.collapse(contentDOM.firstChild ?? contentDOM, 0);
    syncSelection();
  };
  const finishEditClick = () => {
    if (!finishingEditClick) return;
    finishingEditClick = false;
    placeCaret();
  };
  const edit = (event: MouseEvent) => {
    if (!editor.isEditable || event.button !== 0) return;
    event.preventDefault();
    // Reveal contentDOM before ProseMirror maps the new text selection into the DOM.
    finishingEditClick = true;
    placeCaret();
    view.dom.ownerDocument.addEventListener('mouseup', finishEditClick, { once: true });
  };
  preview.addEventListener('mousedown', edit);
  editor.on('selectionUpdate', syncSelection);
  editor.on('focus', syncSelection);
  editor.on('blur', syncSelection);
  render();

  return {
    dom,
    contentDOM,
    update(nextNode: ProseMirrorNode) {
      if (nextNode.type !== node.type) return false;
      const changed = nextNode.textContent !== node.textContent || nextNode.attrs.mathDisplay !== node.attrs.mathDisplay;
      node = nextNode;
      if (changed) render();
      syncSelection();
      return true;
    },
    stopEvent(event) {
      return preview.contains(event.target as globalThis.Node);
    },
    ignoreMutation(mutation) {
      if (mutation.type === 'selection') return false;
      return mutation.type === 'attributes' || !contentDOM.contains(mutation.target);
    },
    destroy() {
      preview.removeEventListener('mousedown', edit);
      view.dom.ownerDocument.removeEventListener('mouseup', finishEditClick);
      editor.off('selectionUpdate', syncSelection);
      editor.off('focus', syncSelection);
      editor.off('blur', syncSelection);
    },
  };
}
