import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  StreamLanguage,
  syntaxHighlighting,
} from '@codemirror/language';
import { cpp } from '@codemirror/lang-cpp';
import { css } from '@codemirror/lang-css';
import { go } from '@codemirror/lang-go';
import { html } from '@codemirror/lang-html';
import { java } from '@codemirror/lang-java';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { sql } from '@codemirror/lang-sql';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { searchKeymap } from '@codemirror/search';
import { EditorState, StateEffect, type Extension } from '@codemirror/state';
import {
  drawSelection,
  EditorView as CodeMirrorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  type ViewUpdate,
} from '@codemirror/view';
import { csharp } from '@replit/codemirror-lang-csharp';
import { exitCode } from '@tiptap/pm/commands';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Selection, TextSelection } from '@tiptap/pm/state';
import type { EditorView as ProseMirrorEditorView, NodeView } from '@tiptap/pm/view';
import { CODE_LANGUAGE_OPTIONS, normalizeCodeLanguage } from '../utils/codeLanguages';

function getCodeBlockLanguage(node: ProseMirrorNode): string {
  return normalizeCodeLanguage(typeof node.attrs.language === 'string' ? node.attrs.language : '');
}

export function isMermaidCodeBlock(node: ProseMirrorNode): boolean {
  return getCodeBlockLanguage(node) === 'mermaid';
}

const codeMirrorLanguageExtensions: Partial<Record<string, () => Extension>> = {
  bash: () => StreamLanguage.define(shell),
  cpp,
  csharp,
  css,
  go,
  html,
  java,
  javascript: () => javascript({ jsx: true }),
  json,
  markdown,
  python,
  rust,
  sql,
  typescript: () => javascript({ jsx: true, typescript: true }),
  xml,
  yaml,
};

function getCodeBlockLanguageLabel(language: string): string {
  return CODE_LANGUAGE_OPTIONS.find(option => option.value === language)?.label
    ?? language;
}

class CodeMirrorCodeBlockNodeView implements NodeView {
  dom: HTMLElement;
  private node: ProseMirrorNode;
  private readonly outerView: ProseMirrorEditorView;
  private readonly getPos: () => number;
  private readonly codeMirrorHost: HTMLElement;
  private readonly languageLabel: HTMLSpanElement;
  private readonly baseExtensions: Extension[];
  private codeMirror: CodeMirrorView;
  private updating = false;
  private destroyed = false;

  constructor(node: ProseMirrorNode, outerView: ProseMirrorEditorView, getPos: () => number) {
    this.node = node;
    this.outerView = outerView;
    this.getPos = getPos;
    const language = getCodeBlockLanguage(node);

    this.dom = document.createElement('div');
    this.dom.className = 'code-block-node-view';
    this.dom.dataset.codeBlock = 'true';
    if (language !== 'plaintext') this.dom.dataset.language = language;

    const header = document.createElement('div');
    header.className = 'code-block-node-view-header';
    header.setAttribute('aria-hidden', 'true');
    this.languageLabel = document.createElement('span');
    this.languageLabel.textContent = getCodeBlockLanguageLabel(language);
    header.append(this.languageLabel);

    this.codeMirrorHost = document.createElement('div');
    this.codeMirrorHost.className = 'code-block-codemirror';
    this.dom.append(header, this.codeMirrorHost);

    this.baseExtensions = [
      lineNumbers(),
      highlightActiveLineGutter(),
      foldGutter(),
      drawSelection(),
      highlightActiveLine(),
      bracketMatching(),
      closeBrackets(),
      autocompletion(),
      history(),
      syntaxHighlighting(defaultHighlightStyle),
      keymap.of([
        ...this.codeMirrorKeymap(),
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap,
        ...completionKeymap,
        ...closeBracketsKeymap,
        ...searchKeymap,
      ]),
      CodeMirrorView.updateListener.of(update => this.forwardUpdate(update)),
      CodeMirrorView.domEventHandlers({
        focus: () => {
          this.forwardFocus();
          return false;
        },
      }),
    ];

    this.codeMirror = new CodeMirrorView({
      state: EditorState.create({ doc: node.textContent, extensions: this.baseExtensions }),
      parent: this.codeMirrorHost,
    });
    this.configureLanguage(language);
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type) return false;
    if (isMermaidCodeBlock(node)) return false;
    const previousLanguage = getCodeBlockLanguage(this.node);
    const language = getCodeBlockLanguage(node);
    this.node = node;

    if (!this.updating) this.replaceCodeMirrorDocument(node.textContent);
    if (language !== previousLanguage) {
      if (language === 'plaintext') delete this.dom.dataset.language;
      else this.dom.dataset.language = language;
      this.languageLabel.textContent = getCodeBlockLanguageLabel(language);
      this.configureLanguage(language);
    }
    return true;
  }

  stopEvent(event: Event): boolean {
    return this.codeMirrorHost.contains(event.target as Node);
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.destroyed = true;
    this.codeMirror.destroy();
  }

  private getCurrentPosition(): number | null {
    try {
      const position = this.getPos();
      return typeof position === 'number' ? position : null;
    } catch {
      return null;
    }
  }

  private configureLanguage(language: string): void {
    const createExtension = codeMirrorLanguageExtensions[language];
    if (!createExtension) {
      this.reconfigure([]);
      return;
    }

    this.reconfigure([createExtension()]);
  }

  private reconfigure(languageExtensions: Extension[]): void {
    if (this.destroyed) return;
    this.codeMirror.dispatch({
      effects: StateEffect.reconfigure.of([...this.baseExtensions, ...languageExtensions]),
    });
  }

  private replaceCodeMirrorDocument(nextText: string): void {
    const currentText = this.codeMirror.state.doc.toString();
    if (currentText === nextText) return;
    let from = 0;
    while (from < currentText.length && currentText[from] === nextText[from]) from += 1;
    let currentTo = currentText.length;
    let nextTo = nextText.length;
    while (currentTo > from && nextTo > from && currentText[currentTo - 1] === nextText[nextTo - 1]) {
      currentTo -= 1;
      nextTo -= 1;
    }

    this.updating = true;
    try {
      this.codeMirror.dispatch({ changes: { from, to: currentTo, insert: nextText.slice(from, nextTo) } });
    } finally {
      this.updating = false;
    }
  }

  private forwardUpdate(update: ViewUpdate): void {
    if (this.updating || !update.docChanged) return;
    const position = this.getCurrentPosition();
    if (position === null) return;

    let offset = position + 1;
    const transaction = this.outerView.state.tr;
    update.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
      transaction.insertText(inserted.toString(), offset + fromA, offset + toA);
      offset += (toB - fromB) - (toA - fromA);
    });

    const selection = update.state.selection.main;
    const from = position + 1 + selection.from;
    const to = position + 1 + selection.to;
    const outerSelection = this.outerView.state.selection;
    if (outerSelection.from !== from || outerSelection.to !== to) {
      transaction.setSelection(TextSelection.create(transaction.doc, from, to));
    }

    this.updating = true;
    try {
      this.outerView.dispatch(transaction);
    } finally {
      this.updating = false;
    }
  }

  private forwardFocus(): void {
    const position = this.getCurrentPosition();
    if (position === null) return;
    const selection = this.codeMirror.state.selection.main;
    const from = position + 1 + selection.from;
    const to = position + 1 + selection.to;
    const outerSelection = this.outerView.state.selection;
    if (outerSelection.from === from && outerSelection.to === to) return;
    this.outerView.dispatch(this.outerView.state.tr.setSelection(
      TextSelection.create(this.outerView.state.doc, from, to),
    ));
  }

  private codeMirrorKeymap() {
    return [
      { key: 'ArrowUp', run: () => this.maybeEscape('line', -1) },
      { key: 'ArrowDown', run: () => this.maybeEscape('line', 1) },
      { key: 'ArrowLeft', run: () => this.maybeEscape('char', -1) },
      { key: 'ArrowRight', run: () => this.maybeEscape('char', 1) },
      { key: 'Mod-Enter', run: () => this.exitCodeBlock() },
    ];
  }

  private maybeEscape(unit: 'line' | 'char', direction: -1 | 1): boolean {
    const selection = this.codeMirror.state.selection.main;
    if (!selection.empty) return false;
    if (unit === 'line') {
      const line = this.codeMirror.state.doc.lineAt(selection.head);
      if (direction < 0 ? line.number > 1 : line.number < this.codeMirror.state.doc.lines) return false;
    } else if (direction < 0 ? selection.head > 0 : selection.head < this.codeMirror.state.doc.length) {
      return false;
    }

    const position = this.getCurrentPosition();
    if (position === null) return false;
    const target = position + (direction < 0 ? 0 : this.node.nodeSize);
    const selectionOutside = Selection.near(this.outerView.state.doc.resolve(target), direction);
    this.outerView.dispatch(this.outerView.state.tr.setSelection(selectionOutside).scrollIntoView());
    this.outerView.focus();
    return true;
  }

  private exitCodeBlock(): boolean {
    const exited = exitCode(this.outerView.state, transaction => this.outerView.dispatch(transaction));
    if (exited) this.outerView.focus();
    return exited;
  }
}

export function createCodeMirrorCodeBlockNodeView(
  node: ProseMirrorNode,
  view: ProseMirrorEditorView,
  getPos: () => number,
): NodeView {
  return new CodeMirrorCodeBlockNodeView(node, view, getPos);
}
