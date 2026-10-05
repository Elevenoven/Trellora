export type CapabilityState = 'available' | 'unconfigured' | 'unverified' | 'unreachable' | 'processing' | 'failed';
export type CapabilityId = 'editing' | 'keywordSearch' | 'generation' | 'materialFullText' | 'materialSemantic' | 'pdfParsing' | 'documentWorker';
export interface UserCapability {
  id: CapabilityId;
  state: CapabilityState;
  code: string;
  message: string;
  action: string;
  checkedAt: string;
}
export interface CapabilityRequest { libraryPath?: string; documentId?: string }
export interface CapabilitySnapshot extends CapabilityRequest { capabilities: UserCapability[] }
export interface CapabilityProbeRequest extends CapabilityRequest { requestId: string; capability: 'generation' | 'documentWorker' | 'materialSemantic' }
