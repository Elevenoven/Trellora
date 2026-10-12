import { renderPreviewHtml } from './preview';
import type { MarkdownFrontmatterMode } from './markdownExtensions';
import { t } from '../i18n';

interface ExternalImageSlot { href: string; image: HTMLImageElement }
export interface ExternalPreviewBody { html: string; images: ExternalImageSlot[] }
const allowedHref = /^(?:https?:\/\/|#|mailto:|tel:|data:image\/(?:png|jpeg|gif|webp);base64,)/i;
const allowedImage = /^(?:https?:\/\/|data:image\/(?:png|jpeg|gif|webp);base64,)/i;

/** Keep sanitized local image templates out of the live DOM until the document service grants a URL. */
export function prepareExternalPreview(content: string, frontmatter: MarkdownFrontmatterMode): ExternalPreviewBody {
    const rendered = renderPreviewHtml(content, { frontmatter });
    // 已清洗且不含图片或资源属性的正文直接复用，避免再解析、序列化一遍完整 DOM。
    const needsResourceCleanup = /<img(?=[\s/>])|\s(?:srcset|src|poster|data|background|href|xlink:href|style|fill|filter|clip-path|stroke|data-external-image-(?:slot|url|state))\s*=/i.test(rendered);
    if (!needsResourceCleanup) return { html: rendered, images: [] };
    const template = document.createElement('template');
    template.innerHTML = rendered;
    const sources = new Map<HTMLImageElement, string>();
    template.content.querySelectorAll<HTMLImageElement>('img').forEach(img => sources.set(img, img.getAttribute('src') ?? ''));
    // Most paragraphs/tables have none of these attributes; inspect only nodes needing resource cleanup.
    template.content.querySelectorAll<HTMLElement>('[srcset], [src], [poster], [data], [background], [href], [xlink\\:href], [style], [fill], [filter], [clip-path], [stroke], [data-external-image-slot], [data-external-image-url], [data-external-image-state]').forEach(element => {
        element.removeAttribute('srcset'); element.removeAttribute('data-external-image-slot');
        element.removeAttribute('data-external-image-url'); element.removeAttribute('data-external-image-state');
        for (const attribute of ['src', 'poster', 'data', 'background', 'href', 'xlink:href']) {
            const value = element.getAttribute(attribute);
            if (value && !allowedHref.test(value)) {
                if (element.tagName === 'A' && attribute === 'href') element.dataset.externalDocumentHref = value;
                element.removeAttribute(attribute);
            }
        }
        for (const attribute of ['style', 'fill', 'filter', 'clip-path', 'stroke']) {
            if (/(?:url\s*\(|@import)/i.test(element.getAttribute(attribute) ?? '')) element.removeAttribute(attribute);
        }
    });
    const images: ExternalImageSlot[] = [];
    for (const [image, href] of sources) {
        if (allowedImage.test(href)) continue;
        images.push({ href, image: image.cloneNode(true) as HTMLImageElement });
        image.replaceWith(imagePlaceholder(images.length - 1, image.alt));
    }
    template.content.querySelectorAll<HTMLAnchorElement>('a[href]').forEach(anchor => {
        if (!/^(?:https?:\/\/|mailto:|tel:|#)/i.test(anchor.getAttribute('href') ?? '')) {
            anchor.removeAttribute('href'); anchor.setAttribute('aria-disabled', 'true');
        }
    });
    return { html: template.innerHTML, images };
}

/** Resource refresh replaces only image slots, preserving the paragraph DOM, selection and scroll position. */
export function applyExternalPreviewResources(container: HTMLElement, body: ExternalPreviewBody, urls: Record<string, string>): void {
    const decode = (value: string) => { try { return decodeURIComponent(value); } catch { return value; } };
    const grants = new Map(Object.entries(urls).map(([href, url]) => [decode(href), url]));
    container.querySelectorAll<HTMLElement>('[data-external-image-slot]').forEach(element => {
        const index = Number(element.dataset.externalImageSlot), slot = body.images[index];
        if (!slot || !Number.isInteger(index)) return;
        const url = grants.get(decode(slot.href));
        // Only unadorned, main-process-issued UUID resource tokens can reach the image src.
        if (!url || !/^trellora-resource:\/\/resource\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(url)) {
            if (element.tagName === 'IMG') element.replaceWith(imagePlaceholder(index, slot.image.alt));
            return;
        }
        if (element.dataset.externalImageUrl === url) return;
        const image = slot.image.cloneNode(true) as HTMLImageElement;
        image.dataset.externalImageSlot = String(index); image.dataset.externalImageUrl = url;
        image.dataset.externalImageState = 'loading'; image.dataset.menghanRelative = slot.href;
        image.onload = () => { image.dataset.externalImageState = 'ready'; };
        image.onerror = () => {
            if (!container.contains(image)) return;
            const placeholder = imagePlaceholder(index, slot.image.alt);
            placeholder.dataset.externalImageUrl = url; placeholder.dataset.externalImageState = 'error';
            placeholder.textContent += ` · ${t('图片加载失败')} `;
            const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = t('重试图片');
            retry.onclick = () => { delete placeholder.dataset.externalImageUrl; applyExternalPreviewResources(container, body, urls); };
            placeholder.append(retry); image.replaceWith(placeholder);
        };
        image.src = url; element.replaceWith(image);
    });
}

/** Render labels as text and retain only an internal slot index, never an active local URL. */
function imagePlaceholder(index: number, alt: string): HTMLSpanElement {
    const placeholder = document.createElement('span');
    placeholder.className = 'external-resource-placeholder'; placeholder.dataset.externalImageSlot = String(index);
    placeholder.textContent = alt || t('[本地图片]');
    return placeholder;
}
