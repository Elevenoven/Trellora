import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';

export interface DocumentReference { href: string; image: boolean; start: number; end: number; html: boolean }
interface Node { type: string; url?: string; value?: string; lang?: string; identifier?: string; children?: Node[]; position?: { start: { offset?: number }; end: { offset?: number } } }
export const isDocumentRemoteReference = (href: string) => /^(?:https?:|mailto:|tel:|data:image\/(?:png|jpeg|gif|webp);base64,|#)/i.test(href.trim());

/** AST 定位引用及定义；仅替换 URL 字节范围，不重新序列化用户 Markdown。 */
export function collectDocumentReferences(content: string): { references: DocumentReference[]; unsupported: string[] } {
  const root = unified().use(remarkParse).use(remarkGfm).parse(content) as Node;
  const references: DocumentReference[] = [], unsupported: string[] = [], definitions = new Map<string, Node>(), used = new Map<string, boolean>();
  const walk = (node: Node, visit: (node: Node) => void) => { visit(node); node.children?.forEach(child => walk(child, visit)); };
  walk(root, node => {
    if (node.type === 'definition') definitions.set(node.identifier!.toUpperCase(), node);
    if (node.type === 'imageReference' || node.type === 'linkReference') used.set(node.identifier!.toUpperCase(), (used.get(node.identifier!.toUpperCase()) ?? false) || node.type === 'imageReference');
  });
  const add = (node: Node, image: boolean, definition = false) => {
    const start = node.position?.start.offset, end = node.position?.end.offset;
    if (start === undefined || end === undefined || !node.url || isDocumentRemoteReference(node.url)) return;
    const raw = content.slice(start, end);
    // 标准定义的冒号或行内链接的闭方括号只定位语法起点，资源来自 AST 的 URL。
    let inlinePrefix: number | undefined, depthOfLabel = 0;
    for (let i = raw.startsWith('!') ? 1 : 0; i < raw.length; i++) {
      if (raw[i] === '\\') { i++; continue; }
      if (raw[i] === '[') depthOfLabel++;
      if (raw[i] === ']' && --depthOfLabel === 0) { if (raw[i + 1] === '(') inlinePrefix = i + 2; break; }
    }
    const prefix = definition ? /^\s{0,3}\[[\s\S]*?\]:\s*/.exec(raw)?.[0].length : inlinePrefix;
    if (prefix === undefined || (!definition && prefix < 2)) { unsupported.push(raw); return; }
    let offset = prefix; while (/\s/.test(raw[offset] ?? '') && offset < raw.length) offset++;
    const angle = raw[offset] === '<'; if (angle) offset++;
    let stop = offset, depth = 0;
    for (; stop < raw.length; stop++) {
      const ch = raw[stop]; if (ch === '\\') { stop++; continue; }
      if (angle ? ch === '>' : /\s/.test(ch) || (ch === ')' && depth === 0)) break;
      if (ch === '(') depth++; if (ch === ')') depth--;
    }
    references.push({ href: node.url, image, start: start + offset, end: start + stop, html: false });
  };
  walk(root, node => {
    if (node.type === 'image' || node.type === 'link') add(node, node.type === 'image');
    if (node.type === 'definition' && used.has(node.identifier!.toUpperCase())) add(node, used.get(node.identifier!.toUpperCase())!, true);
    if (node.type === 'code' && node.lang?.toLowerCase() === 'mermaid' && /(?:\bimg\s*[:=]|\bimage\s*[:=]|<img\b|url\s*\()/i.test(node.value ?? '')) unsupported.push('Mermaid 图片资源');
    if (node.type !== 'html') return;
    const base = node.position?.start.offset ?? 0, value = node.value ?? '';
    const fragment = parseFragment(value, { sourceCodeLocationInfo: true });
    const htmlWalk = (element: DefaultTreeAdapterMap['node']) => {
      if ('attrs' in element) {
        for (const attribute of element.attrs) {
          if (!attribute.value || isDocumentRemoteReference(attribute.value)) continue;
          const name = attribute.name;
          if ((element.tagName === 'img' && name === 'src') || (element.tagName === 'a' && name === 'href')) {
            const location = element.sourceCodeLocation?.attrs?.[name];
            if (!location) { unsupported.push(value); continue; }
            const raw = value.slice(location.startOffset, location.endOffset), match = /=\s*(["']?)([\s\S]*?)\1$/.exec(raw);
            if (!match) { unsupported.push(value); continue; }
            const offset = raw.indexOf('=') + 1 + (raw.slice(raw.indexOf('=') + 1).match(/^\s*/)?.[0].length ?? 0) + match[1].length;
            references.push({ href: attribute.value, image: element.tagName === 'img', start: base + location.startOffset + offset, end: base + location.startOffset + offset + match[2].length, html: true });
          } else if (['src', 'href', 'srcset', 'poster', 'data', 'background'].includes(name) || /(?:url\s*\(|@import)/i.test(attribute.value)) unsupported.push(`${element.tagName}: ${name}`);
        }
      }
      if ('childNodes' in element) element.childNodes.forEach(htmlWalk);
    };
    fragment.childNodes.forEach(htmlWalk);
  });
  for (const identifier of used.keys()) if (!definitions.has(identifier)) unsupported.push(`未找到引用定义：${identifier}`);
  return { references, unsupported };
}

export function rewriteDocumentReferences(content: string, replacements: Record<string, string>): string {
  const edits = collectDocumentReferences(content).references.filter(ref => replacements[ref.href] !== undefined).sort((a, b) => b.start - a.start);
  for (const ref of edits) {
    const value = replacements[ref.href];
    const escaped = ref.html ? value.replace(/&/g, '&amp;').replace(/"/g, '&quot;') : value.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
    content = content.slice(0, ref.start) + escaped + content.slice(ref.end);
  }
  return content;
}
