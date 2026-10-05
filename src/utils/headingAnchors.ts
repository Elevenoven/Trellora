export const markdownHeadingSelector = 'h1, h2, h3, h4, h5, h6';

export interface HeadingTextSource {
  textContent: string | null;
  innerText?: string;
}

export interface HeadingAnchorEntry {
  id: string;
  text: string;
  index: number;
}

export function normalizeHeadingText(source: HeadingTextSource): string {
  return (source.innerText ?? source.textContent ?? '').replace(/\s+/g, ' ').trim();
}

export function slugifyHeading(text: string, index: number): string {
  const slug = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return slug || `heading-${index + 1}`;
}

/**
 * Allocate document-wide heading ids without collisions. Checking the final id
 * as well as the base slug also keeps inputs such as "Title", "Title" and
 * "Title-2" unique instead of assigning "title-2" twice.
 */
export function createHeadingAnchorIds(texts: ArrayLike<string>): string[] {
  const usedIds = new Set<string>();

  return Array.from(texts, (text, index) => {
    const baseId = slugifyHeading(text, index);
    let candidate = baseId;
    let suffix = 2;
    while (usedIds.has(candidate)) {
      candidate = `${baseId}-${suffix}`;
      suffix += 1;
    }
    usedIds.add(candidate);
    return candidate;
  });
}

export function enhanceHeadingAnchors(root: ParentNode): HeadingAnchorEntry[] {
  const headings = [...root.querySelectorAll<HTMLElement>(markdownHeadingSelector)]
    .filter((heading) => !heading.closest('pre, code'));
  const texts = headings.map(normalizeHeadingText);
  const ids = createHeadingAnchorIds(texts);

  return headings.map((heading, index) => {
    const id = ids[index];
    const text = texts[index];
    heading.id = id;
    heading.setAttribute('tabindex', '-1');

    let permalink = heading.querySelector<HTMLAnchorElement>(':scope > .markdown-heading-anchor');
    if (!permalink) {
      permalink = document.createElement('a');
      permalink.className = 'markdown-heading-anchor';
      heading.appendChild(permalink);
    }
    permalink.setAttribute('href', `#${encodeURIComponent(id)}`);
    permalink.setAttribute('aria-label', `永久链接：${text || id}`);
    permalink.title = '跳转到此标题';

    return { id, text, index };
  });
}

export function decodeHeadingFragment(href: string): string | null {
  if (!href.startsWith('#') || href.length === 1) return null;
  try {
    return decodeURIComponent(href.slice(1));
  } catch {
    return null;
  }
}

export function scrollToHeadingAnchor(root: ParentNode, id: string): HTMLElement | null {
  const target = [...root.querySelectorAll<HTMLElement>(markdownHeadingSelector)]
    .find((heading) => heading.id === id) ?? null;
  if (!target) return null;

  target.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  target.classList.remove('markdown-heading-target');
  // Force style recalculation so repeated jumps replay the highlight animation.
  void target.offsetWidth;
  target.classList.add('markdown-heading-target');
  return target;
}
