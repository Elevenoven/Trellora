import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { markdownToHtmlWithParser, type MarkdownAssetContext } from './markdown';
import {
  createPreviewMarkdownExtension,
  createRelaxedStrongExtension,
  createWikiLinkExtension,
  prepareMarkdownDocument,
  type MarkdownDiagnostic,
  type MarkdownFrontmatterMode,
} from './markdownExtensions';
import { createMathMarkdownExtension, renderMathHtml } from './markdownMath';

const allowedPreviewUriPattern = /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix|menghan-image|trellora-resource):|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))/i;

export interface MarkdownPreviewRenderContext extends MarkdownAssetContext {
  frontmatter?: MarkdownFrontmatterMode;
}

export interface MarkdownPreviewRenderResult {
  html: string;
  diagnostics: MarkdownDiagnostic[];
}

export function renderPreviewHtml(markdown: string, renderContext?: MarkdownPreviewRenderContext): string {
  return renderPreviewHtmlWithDiagnostics(markdown, renderContext).html;
}

export function renderPreviewHtmlWithDiagnostics(
  markdown: string,
  renderContext?: MarkdownPreviewRenderContext,
): MarkdownPreviewRenderResult {
  const preparedDocument = prepareMarkdownDocument(markdown, renderContext?.frontmatter);
  const marked = new Marked(
    createWikiLinkExtension(),
    createPreviewMarkdownExtension(),
    createRelaxedStrongExtension(),
    createMathMarkdownExtension((token) => renderMathHtml(token.text, token.displayMode)),
  );

  const katexHtml = markdownToHtmlWithParser(
    preparedDocument.markdown,
    (preparedMarkdown) => marked.parse(preparedMarkdown, { async: false }) as string,
    { ...renderContext, taskListMode: 'readonly' },
  );

  return {
    html: DOMPurify.sanitize(katexHtml, {
      ADD_ATTR: ['data-wiki-link', 'data-wiki-alias', 'data-menghan-relative', 'target'],
      ALLOWED_URI_REGEXP: allowedPreviewUriPattern,
    }),
    diagnostics: preparedDocument.diagnostics,
  };
}

export function createStandaloneHtml(
  title: string,
  bodyHtml: string,
  options?: { resolvedTheme?: 'light' | 'dark'; styles?: string },
): string {
  const resolvedTheme = options?.resolvedTheme ?? 'light';
  const styles = options?.styles ?? `
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif; max-width: 860px; margin: 40px auto; padding: 0 24px; line-height: 1.7; color: #242424; }
    pre { background: #0f172a; color: #e5e7eb; padding: 14px 16px; border-radius: 6px; overflow-x: auto; }
    code { font-family: Consolas, Menlo, monospace; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border: 1px solid #ddd; padding: 8px 10px; }
    blockquote { border-left: 4px solid #ddd; margin-left: 0; padding-left: 14px; color: #555; }
    .callout { border: 1px solid #ddd; border-left-width: 4px; border-radius: 6px; padding: 10px 12px; margin: 1em 0; background: #f8fafc; }
    .callout-title { font-weight: 700; margin-bottom: 4px; }
    img { max-width: 100%; }
  `;
  return `<!doctype html>
<html lang="zh-CN" data-theme="${resolvedTheme}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:;" />
  <title>${escapeHtmlText(title)}</title>
  <style>${styles}</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
