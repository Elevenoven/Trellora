import { Extension } from '@tiptap/core';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { TextSelection } from '@tiptap/pm/state';
import { ReactNodeViewRenderer } from '@tiptap/react';
import CodeBlockNodeView from './CodeBlockNodeView';
import { createCodeMirrorCodeBlockNodeView, isMermaidCodeBlock } from './CodeMirrorCodeBlockNodeView';
import { getCurrentCodeBlockTextRange } from './codeBlockShortcuts';
import { CODE_LANGUAGE_OPTIONS, normalizeCodeLanguage } from '../utils/codeLanguages';

interface CodeLanguageHighlighter {
  highlightAuto: (
    value: string,
    options?: { subset?: ReadonlyArray<string> | null },
  ) => { data?: { language?: string } };
  registered: (language: string) => boolean;
}

const MAX_PASTED_CODE_LANGUAGE_DETECTION_LENGTH = 100_000;
const DETECTABLE_CODE_LANGUAGES = CODE_LANGUAGE_OPTIONS
  .map(option => option.value)
  .filter(language => language !== 'plaintext' && language !== 'mermaid');

function normalizeSourceLanguage(value: string | null | undefined): string | null {
  const language = value?.trim().toLocaleLowerCase('en-US') ?? '';
  return language || null;
}

function getLanguageAttribute(element: Element | null | undefined): string | null {
  if (!element) return null;
  return normalizeSourceLanguage(
    element.getAttribute('data-language')
    || element.getAttribute('data-lang')
    || element.getAttribute('data-code-language')
    || element.getAttribute('data-highlighted-language'),
  );
}

function getLanguageClass(element: Element | null): string | null {
  if (!element) return null;
  const languageClass = [...element.classList]
    .find(className => /^(?:language|lang)-/i.test(className));
  return normalizeSourceLanguage(languageClass?.replace(/^(?:language|lang)-/i, ''));
}

function getSourceLanguage(element: HTMLElement): string | null {
  const code = element.querySelector('code');
  const directLanguage = getLanguageAttribute(element)
    || getLanguageAttribute(code)
    || getLanguageClass(element)
    || getLanguageClass(code);
  if (directLanguage) {
    return directLanguage;
  }

  // Several Markdown renderers put the language on the wrapper that owns the
  // toolbar instead of on <pre>/<code>. Inspect only the two nearest wrappers
  // so unrelated page-level data attributes cannot leak into the code block.
  const parentLanguage = getLanguageAttribute(element.parentElement);
  return parentLanguage || getLanguageAttribute(element.parentElement?.parentElement);
}

function detectPastedCodeLanguage(
  source: string,
  syntaxHighlighter: CodeLanguageHighlighter,
): string | null {
  if (!source.trim() || source.length > MAX_PASTED_CODE_LANGUAGE_DETECTION_LENGTH) return null;

  const subset = DETECTABLE_CODE_LANGUAGES.filter(language => syntaxHighlighter.registered(language));
  if (subset.length === 0) return null;

  try {
    const detected = syntaxHighlighter.highlightAuto(source, { subset }).data?.language;
    const normalized = normalizeCodeLanguage(detected);
    return normalized && normalized !== 'plaintext' ? normalized : null;
  } catch {
    return null;
  }
}

/**
 * Preserves language metadata supplied by external Markdown renderers. If a
 * pasted code block has no language metadata, use the editor's existing
 * lowlight instance to detect one before ProseMirror parses the clipboard HTML.
 */
export function normalizePastedCodeBlockLanguages(
  html: string,
  syntaxHighlighter: CodeLanguageHighlighter,
): string {
  if (!/<pre(?:\s|>)/i.test(html)) return html;

  const template = document.createElement('template');
  template.innerHTML = html;
  template.content.querySelectorAll<HTMLElement>('pre').forEach((pre) => {
    const language = getSourceLanguage(pre)
      || detectPastedCodeLanguage(pre.textContent ?? '', syntaxHighlighter);
    if (language) pre.dataset.language = language;
  });
  return template.innerHTML;
}

/**
 * Keeps a fenced Markdown language as a CodeBlock attribute while the note is
 * being parsed. The explicit data attribute is also retained in editor HTML,
 * so it remains available to UI controls even if syntax-highlight decorations
 * replace the contents of the code element.
 */
export const MarkdownCodeBlockLowlight = CodeBlockLowlight.extend({
  // Schema priority also decides which node fills a generic `block+` slot.
  // Keep code below paragraphs so new table cells are paragraphs, not empty
  // code blocks. The high-priority Mod-A behavior lives in a plain extension.
  priority: 90,
  addAttributes() {
    return {
      ...this.parent?.(),
      language: {
        default: this.options.defaultLanguage,
        parseHTML: element => getSourceLanguage(element as HTMLElement),
        renderHTML: attributes => {
          const language = normalizeSourceLanguage(
            typeof attributes.language === 'string' ? attributes.language : null,
          );
          return language ? { 'data-language': language } : {};
        },
      },
    };
  },
  addNodeView() {
    const renderMermaidNodeView = ReactNodeViewRenderer(CodeBlockNodeView, {
      // A span keeps the editable code content valid inside the node view's
      // <code> element while the diagram preview remains non-editable.
      contentDOMElementTag: 'span',
      update: ({ newNode, updateProps }) => {
        if (!isMermaidCodeBlock(newNode)) return false;
        updateProps();
        return true;
      },
    });
    return props => {
      if (isMermaidCodeBlock(props.node)) return renderMermaidNodeView(props);
      return createCodeMirrorCodeBlockNodeView(props.node, props.view, props.getPos);
    };
  },
});

export const CodeBlockSelectAll = Extension.create({
  name: 'menghanCodeBlockSelectAll',
  priority: 1_100,

  addKeyboardShortcuts() {
    return {
      'Mod-a': () => {
        const range = getCurrentCodeBlockTextRange(this.editor.state.selection);
        if (!range) return false;
        this.editor.view.dispatch(this.editor.state.tr.setSelection(
          TextSelection.create(this.editor.state.doc, range.from, range.to),
        ));
        return true;
      },
    };
  },
});
