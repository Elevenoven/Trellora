import type { HeadingEntry } from '../electron';
import {
    createHeadingAnchorIds,
    normalizeHeadingText,
    type HeadingTextSource,
} from './headingAnchors';

export interface RenderedHeadingSource extends HeadingTextSource {
    tagName: string;
}

export interface OutlineTreeNode {
    key: string;
    heading: HeadingEntry;
    children: OutlineTreeNode[];
}

export interface VisibleOutlineRow {
    key: string;
    heading: HeadingEntry;
    depth: number;
    hasChildren: boolean;
    isCollapsed: boolean;
}

export function extractRenderedHeadings(root: ParentNode): HeadingEntry[] {
    const headings = root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6');
    const visibleHeadings = [...headings].filter((heading) => !heading.closest('pre, code'));
    return createHeadingEntriesFromElements(visibleHeadings);
}

export function createHeadingEntriesFromElements(elements: ArrayLike<RenderedHeadingSource>): HeadingEntry[] {
    const headings = Array.from(elements).map((element) => {
        const level = Number(element.tagName.match(/[1-6]$/)?.[0] ?? 1) as HeadingEntry['level'];
        const text = normalizeHeadingText(element);
        return { level, text };
    });
    const ids = createHeadingAnchorIds(headings.map((heading) => heading.text));

    return headings
        .map((heading, index) => ({
            id: ids[index],
            level: heading.level,
            text: heading.text,
            line: index + 1,
            index,
        }))
        .filter((heading) => heading.text.length > 0);
}

export function getOutlineHeadingKey(heading: HeadingEntry): string {
    return `${heading.index}:${heading.id}`;
}

export function buildOutlineTree(headings: HeadingEntry[]): OutlineTreeNode[] {
    const roots: OutlineTreeNode[] = [];
    const ancestors: OutlineTreeNode[] = [];

    for (const heading of headings) {
        while (ancestors.length > 0 && ancestors[ancestors.length - 1].heading.level >= heading.level) {
            ancestors.pop();
        }

        const node: OutlineTreeNode = {
            key: getOutlineHeadingKey(heading),
            heading,
            children: [],
        };
        const parent = ancestors[ancestors.length - 1];
        if (parent) parent.children.push(node);
        else roots.push(node);
        ancestors.push(node);
    }

    return roots;
}

export function collectCollapsibleOutlineKeys(nodes: OutlineTreeNode[]): string[] {
    const result: string[] = [];
    const visit = (node: OutlineTreeNode) => {
        if (node.children.length > 0) result.push(node.key);
        node.children.forEach(visit);
    };
    nodes.forEach(visit);
    return result;
}

export function flattenVisibleOutlineTree(nodes: OutlineTreeNode[], collapsedKeys: ReadonlySet<string>): VisibleOutlineRow[] {
    const result: VisibleOutlineRow[] = [];
    const visit = (node: OutlineTreeNode, depth: number) => {
        const hasChildren = node.children.length > 0;
        const isCollapsed = hasChildren && collapsedKeys.has(node.key);
        result.push({
            key: node.key,
            heading: node.heading,
            depth,
            hasChildren,
            isCollapsed,
        });
        if (!isCollapsed) node.children.forEach((child) => visit(child, depth + 1));
    };
    nodes.forEach((node) => visit(node, 0));
    return result;
}
