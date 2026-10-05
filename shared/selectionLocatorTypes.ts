/** Only identity and selection structure cross IPC; full editor text stays local. */
export interface SelectionLocatorCapture {
  editorSessionId: string;
  docRevision: number;
  from: number;
  to: number;
  textOffset: number;
  documentTextHash: string;
  selectedTextHash: string;
  canonicalSliceJson: string;
  markdownFragment: string;
  selectionStructureSignature: string;
  documentStructureSignature: string;
  blockKinds: string[];
  rect: { left: number; top: number; right: number; bottom: number };
}
