import type { SelectionExpansionCapabilities, SelectionExpansionEvidence, SelectionExpansionPlan, SelectionExpansionResult, SelectionExpansionSettings } from '../electron';
import type { SelectionSnapshot, SelectionWritebackCapability } from './selectionActions';

/** Renderer-only session. It is deliberately separate from persisted default settings. */
export interface SelectionExpansionDraftSession {
  id: string;
  snapshot: SelectionSnapshot;
  writeback: SelectionWritebackCapability;
  settings: SelectionExpansionSettings;
  capabilities: SelectionExpansionCapabilities;
  status: 'configuring' | 'planning' | 'researching' | 'synthesizing' | 'completed' | 'partial' | 'not-found' | 'cancelled' | 'stale' | 'error';
  message?: string;
  requestId?: string;
  taskSessionId?: string;
  sequence: number;
  plan?: SelectionExpansionPlan;
  evidence: SelectionExpansionEvidence[];
  result?: SelectionExpansionResult;
  error?: string;
}

/** Explicit user confirmation to write a reviewed suggestion back through the live editor. */
export interface SelectionExpansionApplyRequest {
  id: string;
  snapshot: SelectionSnapshot;
  text: string;
}
