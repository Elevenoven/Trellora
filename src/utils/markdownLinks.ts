export interface MarkdownRelativeLinkTarget {
  path: string;
  fragment?: string;
}

export function parseRelativeMarkdownLinkHref(href: string): MarkdownRelativeLinkTarget | null {
  const trimmedHref = href.trim();
  if (!trimmedHref || trimmedHref.startsWith('#') || trimmedHref.startsWith('/') || trimmedHref.startsWith('\\')) {
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmedHref)) return null;

  const hashIndex = trimmedHref.indexOf('#');
  const hrefWithoutFragment = hashIndex >= 0 ? trimmedHref.slice(0, hashIndex) : trimmedHref;
  const rawFragment = hashIndex >= 0 ? trimmedHref.slice(hashIndex + 1) : '';
  const queryIndex = hrefWithoutFragment.indexOf('?');
  const rawPath = queryIndex >= 0 ? hrefWithoutFragment.slice(0, queryIndex) : hrefWithoutFragment;
  if (!/\.(?:md|markdown)$/i.test(rawPath)) return null;

  try {
    const decodedPath = decodeURIComponent(rawPath).replace(/\\/g, '/');
    if (!decodedPath || decodedPath.includes('\0') || decodedPath.startsWith('/') || /^[a-z]:\//i.test(decodedPath)) {
      return null;
    }
    const fragment = rawFragment ? decodeURIComponent(rawFragment) : undefined;
    return fragment ? { path: decodedPath, fragment } : { path: decodedPath };
  } catch {
    return null;
  }
}
