import {
  Archive,
  BookOpen,
  Briefcase,
  FileText,
  Folder,
  GraduationCap,
  Library,
  Lightbulb,
  type LucideIcon,
} from 'lucide-react';

export interface MaterialsIconOption {
  id: string;
  label: string;
  color: string;
  Icon: LucideIcon;
}

export const DEFAULT_MATERIALS_ICON_ID = 'file';

export const MATERIALS_ICON_OPTIONS: MaterialsIconOption[] = [
  { id: 'file', label: '文档', color: 'gray', Icon: FileText },
  { id: 'book', label: '书籍', color: 'violet', Icon: BookOpen },
  { id: 'archive', label: '档案', color: 'teal', Icon: Archive },
  { id: 'folder', label: '文件夹', color: 'orange', Icon: Folder },
  { id: 'library', label: '书库', color: 'pink', Icon: Library },
  { id: 'study', label: '学习', color: 'yellow', Icon: GraduationCap },
  { id: 'work', label: '工作', color: 'gray', Icon: Briefcase },
  { id: 'idea', label: '灵感', color: 'yellow', Icon: Lightbulb },
];

export function getMaterialsIconOption(iconId: string | null | undefined): MaterialsIconOption {
  return MATERIALS_ICON_OPTIONS.find((option) => option.id === iconId)
    ?? MATERIALS_ICON_OPTIONS[0];
}
