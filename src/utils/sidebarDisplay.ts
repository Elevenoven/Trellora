interface SidebarDisplayNode {
    name: string;
    isDirectory: boolean;
}
export function getSidebarDisplayName(node: SidebarDisplayNode): string {
    if (node.isDirectory) return node.name;
    return getEditableEntryName(node.name);
}

export function getEditableEntryName(fileName: string): string {
    return fileName.replace(/\.[^.]+$/, '');
}
