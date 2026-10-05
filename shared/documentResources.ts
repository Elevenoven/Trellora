import { marked } from 'marked';

const remote = (href: string) => /^(?:https?:|mailto:|tel:|data:image\/(?:png|jpeg|gif|webp);base64,|#)/i.test(href.trim());
/** EF-1 不迁移本地资源；解析真实 Markdown token，HTML 和 Wiki 引用保守处理。 */
export function hasDocumentLocalReferences(content: string): boolean {
  let local = false;
  try {
    marked.walkTokens(marked.lexer(content), token => {
      if (token.type === 'code' && token.lang?.toLowerCase() === 'mermaid' && /(?:\bimg\s*[:=]|\bimage\s*[:=]|<img\b|url\s*\()/i.test(token.text)) local = true;
      if ((token.type === 'image' || token.type === 'link') && !remote(token.href)) local = true;
      if (token.type === 'html' && /<(?:img|a|video|audio|source|iframe|object)\b/i.test(token.text)) local = true;
      if (token.type === 'html' && /(?:url\s*\(|@import|\b(?:src|href|srcset|poster|background|data|xlink:href)\s*=)/i.test(token.text)) local = true;
      if (token.type !== 'code' && token.type !== 'codespan' && /\[\[[^\]]+\]\]/.test(token.raw)) local = true;
    });
  } catch { return true; }
  return local;
}
