import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { MEMORY_CONSTANTS } from './memory/memoryConstants';

export const QA_MEMORY_SCHEMA_VERSION = 11;
export const QA_MEMORY_DIRECTORY_NAME = 'ConversationMemory';
export const QA_MEMORY_DATABASE_NAME = 'qa-memory.db';
const QA_MEMORY_LEGACY_DIRECTORY_NAME = '.menghan-meta';

const MEMORY_ITEM_V11_COLUMNS = [
  "proposal_action TEXT CHECK (proposal_action IS NULL OR proposal_action IN ('add','replace','retire'))",
  'replaces_id TEXT REFERENCES memory_items(id) ON DELETE SET NULL',
  'replaces_fingerprint TEXT CHECK (replaces_fingerprint IS NULL OR length(replaces_fingerprint) = 64)',
  'replaces_snapshot_json TEXT CHECK (replaces_snapshot_json IS NULL OR json_valid(replaces_snapshot_json))',
  "review_reason TEXT CHECK (review_reason IS NULL OR review_reason IN ('INFERRED_FACT','TARGET_REPLACEMENT','TARGET_RETIREMENT','AMBIGUOUS_RELATION','LEGACY_PROPOSAL','TARGET_CHANGED','TARGET_DELETED','TARGET_EXPIRED'))",
  "write_protection TEXT NOT NULL DEFAULT 'legacy' CHECK (write_protection IN ('user','none','legacy'))",
];

// Cross-row owner checks and state combinations apply equally to IPC writes and imports.
const MEMORY_PROPOSAL_V11_GUARDS_SQL = `
  CREATE TRIGGER IF NOT EXISTS memory_proposal_insert_guard BEFORE INSERT ON memory_items BEGIN
    SELECT CASE WHEN NOT COALESCE((
      (NEW.status = 'active' AND NEW.proposal_action IS NULL AND NEW.replaces_id IS NULL
        AND NEW.replaces_fingerprint IS NULL AND NEW.replaces_snapshot_json IS NULL)
      OR (NEW.status = 'pending' AND NEW.proposal_action = 'add' AND NEW.replaces_id IS NULL
        AND NEW.replaces_fingerprint IS NULL AND NEW.replaces_snapshot_json IS NULL)
      OR (NEW.status = 'pending' AND NEW.proposal_action IN ('replace','retire') AND NEW.replaces_id IS NOT NULL
        AND NEW.replaces_fingerprint IS NOT NULL AND NEW.replaces_snapshot_json IS NOT NULL
        AND json_type(NEW.replaces_snapshot_json) = 'object'
        AND json_extract(NEW.replaces_snapshot_json, '$.id') = NEW.replaces_id
        AND json_extract(NEW.replaces_snapshot_json, '$.memoryGeneration') = NEW.memory_generation)
      OR NEW.status IN ('archived','superseded')
    ), 0) THEN RAISE(ABORT, 'MEMORY_PROPOSAL_SHAPE_INVALID') END;
    SELECT CASE WHEN NEW.replaces_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM memory_items t WHERE t.id = NEW.replaces_id AND t.id <> NEW.id
        AND t.workspace_id = NEW.workspace_id AND t.principal_id = NEW.principal_id
    ) THEN RAISE(ABORT, 'MEMORY_PROPOSAL_SCOPE_INVALID') END;
  END;
  CREATE TRIGGER IF NOT EXISTS memory_proposal_update_guard BEFORE UPDATE ON memory_items BEGIN
    SELECT CASE WHEN NOT COALESCE((
      (NEW.status = 'active' AND NEW.proposal_action IS NULL AND NEW.replaces_id IS NULL
        AND NEW.replaces_fingerprint IS NULL AND NEW.replaces_snapshot_json IS NULL)
      OR (NEW.status = 'pending' AND NEW.proposal_action = 'add' AND NEW.replaces_id IS NULL
        AND NEW.replaces_fingerprint IS NULL AND NEW.replaces_snapshot_json IS NULL)
      OR (NEW.status = 'pending' AND NEW.proposal_action IN ('replace','retire') AND NEW.replaces_id IS NOT NULL
        AND NEW.replaces_fingerprint IS NOT NULL AND NEW.replaces_snapshot_json IS NOT NULL
        AND json_type(NEW.replaces_snapshot_json) = 'object'
        AND json_extract(NEW.replaces_snapshot_json, '$.id') = NEW.replaces_id
        AND json_extract(NEW.replaces_snapshot_json, '$.memoryGeneration') = NEW.memory_generation)
      OR NEW.status IN ('archived','superseded')
    ), 0) THEN RAISE(ABORT, 'MEMORY_PROPOSAL_SHAPE_INVALID') END;
    SELECT CASE WHEN NEW.replaces_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM memory_items t WHERE t.id = NEW.replaces_id AND t.id <> NEW.id
        AND t.workspace_id = NEW.workspace_id AND t.principal_id = NEW.principal_id
    ) THEN RAISE(ABORT, 'MEMORY_PROPOSAL_SCOPE_INVALID') END;
  END;
  CREATE TRIGGER IF NOT EXISTS memory_proposal_target_delete BEFORE DELETE ON memory_items BEGIN
    UPDATE memory_items SET status = 'archived', invalid_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      review_reason = 'TARGET_DELETED', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE replaces_id = OLD.id AND status = 'pending';
  END;
`;

const USER_PROFILE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS user_profile_settings (
    profile_id TEXT PRIMARY KEY,
    auto_extract_enabled INTEGER NOT NULL DEFAULT 0 CHECK (auto_extract_enabled IN (0, 1)),
    use_in_qa_context INTEGER NOT NULL DEFAULT 0 CHECK (use_in_qa_context IN (0, 1)),
    allow_chat INTEGER NOT NULL DEFAULT 1 CHECK (allow_chat IN (0, 1)),
    allow_knowledge_base INTEGER NOT NULL DEFAULT 1 CHECK (allow_knowledge_base IN (0, 1)),
    extraction_model_profile_id TEXT,
    profile_token_budget INTEGER NOT NULL DEFAULT 600 CHECK (profile_token_budget BETWEEN 128 AND 4000),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS user_profile_items (
    item_id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES user_profile_settings(profile_id) ON DELETE CASCADE,
    category TEXT NOT NULL CHECK (category IN ('identity', 'professional', 'expertise', 'technical-environment', 'goals', 'communication', 'collaboration', 'decision', 'constraints', 'interests')),
    item_key TEXT NOT NULL,
    field_label TEXT NOT NULL,
    value_text TEXT NOT NULL,
    normalized_value TEXT NOT NULL,
    cardinality TEXT NOT NULL CHECK (cardinality IN ('single', 'multiple')),
    temporal_status TEXT NOT NULL CHECK (temporal_status IN ('current', 'historical', 'unspecified')),
    assertion_kind TEXT NOT NULL CHECK (assertion_kind IN ('manual', 'explicit', 'inferred')),
    status TEXT NOT NULL CHECK (status IN ('active', 'suggested', 'rejected', 'superseded')),
    confidence REAL NOT NULL DEFAULT 1 CHECK (confidence BETWEEN 0 AND 1),
    stability TEXT NOT NULL DEFAULT 'stable' CHECK (stability IN ('stable', 'long-term', 'contextual')),
    user_locked INTEGER NOT NULL DEFAULT 1 CHECK (user_locked IN (0, 1)),
    source_count INTEGER NOT NULL DEFAULT 0 CHECK (source_count >= 0),
    valid_from TEXT,
    valid_to TEXT,
    expires_at TEXT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (profile_id, category, item_key, normalized_value)
  );
  CREATE TABLE IF NOT EXISTS user_profile_evidence (
    evidence_id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES user_profile_items(item_id) ON DELETE CASCADE,
    source_turn_id TEXT REFERENCES qa_turns(turn_id) ON DELETE CASCADE,
    source_session_id TEXT,
    source_scope TEXT NOT NULL CHECK (source_scope IN ('chat', 'knowledge-base', 'manual')),
    excerpt TEXT NOT NULL,
    assertion_kind TEXT NOT NULL CHECK (assertion_kind IN ('manual', 'explicit', 'inferred')),
    confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
    occurred_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS user_profile_extraction_jobs (
    job_id TEXT PRIMARY KEY,
    source_turn_id TEXT NOT NULL UNIQUE REFERENCES qa_turns(turn_id) ON DELETE CASCADE,
    profile_id TEXT NOT NULL REFERENCES user_profile_settings(profile_id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('chat', 'knowledge-base')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'empty', 'failed', 'blocked', 'unknown')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    failed_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempt_count >= 0),
    manual_retry_no INTEGER NOT NULL DEFAULT 0 CHECK (manual_retry_no >= 0),
    model_profile_id TEXT,
    provider_id TEXT NOT NULL DEFAULT '',
    model_id TEXT NOT NULL DEFAULT '',
    context_window_tokens INTEGER NOT NULL DEFAULT 128000 CHECK (context_window_tokens > 0),
    extractor_version TEXT NOT NULL DEFAULT '',
    input_hash TEXT NOT NULL DEFAULT '',
    output_hash TEXT NOT NULL DEFAULT '',
    observation_count INTEGER NOT NULL DEFAULT 0 CHECK (observation_count >= 0),
    applied_count INTEGER NOT NULL DEFAULT 0 CHECK (applied_count >= 0),
    filtered_sensitive_count INTEGER NOT NULL DEFAULT 0 CHECK (filtered_sensitive_count >= 0),
    filtered_invalid_count INTEGER NOT NULL DEFAULT 0 CHECK (filtered_invalid_count >= 0),
    input_chars INTEGER NOT NULL DEFAULT 0 CHECK (input_chars >= 0),
    output_chars INTEGER NOT NULL DEFAULT 0 CHECK (output_chars >= 0),
    input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
    output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
    duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
    error_code TEXT NOT NULL DEFAULT '',
    error_message TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS user_profile_revisions (
    revision_id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES user_profile_items(item_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision > 0),
    action TEXT NOT NULL CHECK (action IN ('create', 'update', 'lock', 'unlock', 'supersede', 'restore')),
    actor TEXT NOT NULL CHECK (actor IN ('user', 'system', 'extractor')),
    before_json TEXT,
    after_json TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (item_id, revision)
  );
  CREATE INDEX IF NOT EXISTS idx_user_profile_items_overview
    ON user_profile_items(profile_id, status, category, updated_at DESC, item_id DESC);
  CREATE INDEX IF NOT EXISTS idx_user_profile_items_key
    ON user_profile_items(profile_id, category, item_key, status);
  CREATE INDEX IF NOT EXISTS idx_user_profile_evidence_item_time
    ON user_profile_evidence(item_id, occurred_at DESC, evidence_id DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_user_profile_evidence_item_turn
    ON user_profile_evidence(item_id, source_turn_id) WHERE source_turn_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_user_profile_jobs_status
    ON user_profile_extraction_jobs(profile_id, status, created_at ASC);
  CREATE INDEX IF NOT EXISTS idx_user_profile_jobs_session
    ON user_profile_extraction_jobs(session_id, status, created_at ASC);
  CREATE INDEX IF NOT EXISTS idx_user_profile_revisions_item
    ON user_profile_revisions(item_id, revision DESC);
`;

const CONVERSATION_CHECKPOINT_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS qa_memory_checkpoints (
    session_id TEXT PRIMARY KEY REFERENCES qa_sessions(session_id) ON DELETE CASCADE,
    checkpoint_version INTEGER NOT NULL CHECK (checkpoint_version > 0),
    covered_from_seq INTEGER NOT NULL DEFAULT 1 CHECK (covered_from_seq = 1),
    covered_through_seq INTEGER NOT NULL CHECK (covered_through_seq >= 0),
    source_hash TEXT NOT NULL,
    summary_payload_json TEXT NOT NULL,
    summary_text TEXT NOT NULL,
    summary_tokens INTEGER NOT NULL CHECK (summary_tokens >= 0),
    target_tokens INTEGER NOT NULL CHECK (target_tokens >= 0),
    source_tokens INTEGER NOT NULL CHECK (source_tokens > 0),
    compression_ratio REAL NOT NULL CHECK (compression_ratio >= 0 AND compression_ratio <= 0.2),
    compressor TEXT NOT NULL CHECK (compressor IN ('llm', 'fallback')),
    model_profile TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS qa_memory_compaction_runs (
    run_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES qa_sessions(session_id) ON DELETE CASCADE,
    base_checkpoint_version INTEGER NOT NULL CHECK (base_checkpoint_version >= 0),
    source_from_seq INTEGER NOT NULL CHECK (source_from_seq > 0),
    source_to_seq INTEGER NOT NULL CHECK (source_to_seq >= source_from_seq),
    source_hash TEXT NOT NULL,
    source_tokens INTEGER NOT NULL CHECK (source_tokens > 0),
    target_tokens INTEGER NOT NULL CHECK (target_tokens >= 0),
    output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
    status TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed', 'cancelled', 'conflict', 'interrupted')),
    error_code TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_qa_memory_compaction_runs_session
    ON qa_memory_compaction_runs(session_id, created_at DESC, run_id DESC);
  CREATE INDEX IF NOT EXISTS idx_qa_memory_compaction_runs_status
    ON qa_memory_compaction_runs(status, created_at ASC);
`;

const WEKNORA_MEMORY_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS memory_workspace_settings (
    workspace_id TEXT PRIMARY KEY CHECK (length(workspace_id) > 0),
    enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
    write_mode TEXT NOT NULL DEFAULT 'explicit_only' CHECK (write_mode IN ('explicit_only', 'auto')),
    extract_model_id TEXT,
    max_items INTEGER NOT NULL DEFAULT 200 CHECK (max_items BETWEEN 1 AND 2000),
    extract_delay_seconds INTEGER NOT NULL DEFAULT 90 CHECK (extract_delay_seconds BETWEEN 5 AND 3600),
    extract_min_interval_seconds INTEGER NOT NULL DEFAULT 300 CHECK (extract_min_interval_seconds BETWEEN 1 AND 86400),
    extract_instructions TEXT NOT NULL DEFAULT '' CHECK (length(extract_instructions) <= 1000),
    interest_threshold INTEGER NOT NULL DEFAULT 3 CHECK (interest_threshold BETWEEN 1 AND 20),
    retrieval_conditioning INTEGER NOT NULL DEFAULT 1 CHECK (retrieval_conditioning IN (0, 1)),
    embedding_model_id TEXT,
    vector_recall INTEGER NOT NULL DEFAULT 1 CHECK (vector_recall IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS memory_subjects (
    workspace_id TEXT NOT NULL REFERENCES memory_workspace_settings(workspace_id) ON DELETE CASCADE,
    principal_id TEXT NOT NULL CHECK (length(principal_id) > 0),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    block_text TEXT NOT NULL DEFAULT '',
    item_count INTEGER NOT NULL DEFAULT 0 CHECK (item_count >= 0),
    last_extracted_at TEXT,
    extract_cursor_at TEXT,
    extract_cursor_message_id TEXT,
    pending_sessions_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(pending_sessions_json)),
    extract_scheduled_at TEXT,
    consolidated_at TEXT,
    forced_consolidated_at TEXT,
    memory_generation INTEGER NOT NULL DEFAULT 0 CHECK (memory_generation >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, principal_id),
    CHECK ((extract_cursor_at IS NULL) = (extract_cursor_message_id IS NULL))
  );

  CREATE TABLE IF NOT EXISTS memory_items (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    workspace_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('profile', 'preference', 'fact', 'task', 'interest')),
    content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 300),
    topic TEXT NOT NULL DEFAULT '' CHECK (length(topic) <= 80),
    normalized_key TEXT NOT NULL CHECK (length(normalized_key) BETWEEN 1 AND 200),
    importance INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
    origin TEXT NOT NULL CHECK (origin IN ('explicit', 'extracted', 'manual')),
    status TEXT NOT NULL CHECK (status IN ('active', 'pending', 'superseded', 'archived')),
    source_session_id TEXT,
    source_message_id TEXT,
    valid_from TEXT NOT NULL,
    invalid_at TEXT,
    expires_at TEXT,
    superseded_by TEXT,
    last_used_at TEXT,
    use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
    ${MEMORY_ITEM_V11_COLUMNS.join(',\n    ')},
    memory_generation INTEGER NOT NULL DEFAULT 0 CHECK (memory_generation >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (id, workspace_id, principal_id),
    FOREIGN KEY (workspace_id, principal_id)
      REFERENCES memory_subjects(workspace_id, principal_id) ON DELETE CASCADE,
    FOREIGN KEY (superseded_by) REFERENCES memory_items(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS memory_tombstones (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    workspace_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('profile', 'preference', 'fact', 'task', 'interest')),
    topic TEXT NOT NULL DEFAULT '' CHECK (length(topic) <= 80),
    fingerprint TEXT NOT NULL CHECK (length(fingerprint) > 0),
    source_message_id TEXT,
    memory_generation INTEGER NOT NULL DEFAULT 0 CHECK (memory_generation >= 0),
    created_at TEXT NOT NULL,
    FOREIGN KEY (workspace_id, principal_id)
      REFERENCES memory_subjects(workspace_id, principal_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS memory_topic_stats (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    workspace_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    normalized_key TEXT NOT NULL CHECK (length(normalized_key) BETWEEN 1 AND 120),
    topic TEXT NOT NULL CHECK (length(topic) BETWEEN 1 AND 80),
    aliases_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(aliases_json)),
    hits INTEGER NOT NULL DEFAULT 0 CHECK (hits >= 0),
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    promoted_item_id TEXT REFERENCES memory_items(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (workspace_id, principal_id)
      REFERENCES memory_subjects(workspace_id, principal_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS memory_doc_affinities (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    workspace_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    document_id TEXT NOT NULL CHECK (length(document_id) > 0),
    knowledge_base_id TEXT,
    title TEXT NOT NULL DEFAULT '',
    hits INTEGER NOT NULL DEFAULT 0 CHECK (hits >= 0),
    first_used_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL,
    FOREIGN KEY (workspace_id, principal_id)
      REFERENCES memory_subjects(workspace_id, principal_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS memory_doc_affinity_events (
    turn_id TEXT NOT NULL REFERENCES qa_turns(turn_id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    document_id TEXT NOT NULL CHECK (length(document_id) > 0),
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (turn_id, document_id),
    FOREIGN KEY (workspace_id, principal_id)
      REFERENCES memory_subjects(workspace_id, principal_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS memory_item_embeddings (
    item_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    model_id TEXT NOT NULL CHECK (length(model_id) > 0),
    dimensions INTEGER NOT NULL CHECK (dimensions > 0),
    embedding BLOB NOT NULL,
    content_fingerprint TEXT NOT NULL CHECK (length(content_fingerprint) > 0),
    updated_at TEXT NOT NULL,
    FOREIGN KEY (workspace_id, principal_id)
      REFERENCES memory_subjects(workspace_id, principal_id) ON DELETE CASCADE,
    FOREIGN KEY (item_id, workspace_id, principal_id)
      REFERENCES memory_items(id, workspace_id, principal_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS memory_extraction_jobs (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    workspace_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    captured_generation INTEGER NOT NULL DEFAULT 0 CHECK (captured_generation >= 0),
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'retry', 'done', 'failed', 'cancelled', 'stale')),
    due_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    claimed_sessions_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(claimed_sessions_json)),
    claimed_sources_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(claimed_sources_json)),
    source_model_profile_id TEXT,
    source_model_id TEXT,
    source_context_window_tokens INTEGER,
    lease_until TEXT,
    last_error TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (workspace_id, principal_id)
      REFERENCES memory_subjects(workspace_id, principal_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS memory_extraction_turn_receipts (
    workspace_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    memory_generation INTEGER NOT NULL CHECK (memory_generation >= 0),
    turn_id TEXT NOT NULL REFERENCES qa_turns(turn_id) ON DELETE CASCADE,
    source_fingerprint TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'legacy_baseline')),
    extractor_version TEXT NOT NULL,
    job_id TEXT,
    processed_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, principal_id, memory_generation, turn_id),
    FOREIGN KEY (workspace_id, principal_id) REFERENCES memory_subjects(workspace_id, principal_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS memory_extraction_pending_sources (
    workspace_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    memory_generation INTEGER NOT NULL,
    turn_id TEXT NOT NULL REFERENCES qa_turns(turn_id) ON DELETE CASCADE,
    source_fingerprint TEXT NOT NULL,
    due_at TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('external', 'backlog', 'continuation')),
    carried_attempts INTEGER NOT NULL DEFAULT 0 CHECK (carried_attempts >= 0),
    model_hint_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(model_hint_json)),
    PRIMARY KEY (workspace_id, principal_id, memory_generation, turn_id),
    FOREIGN KEY (workspace_id, principal_id) REFERENCES memory_subjects(workspace_id, principal_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_memory_extraction_pending_due ON memory_extraction_pending_sources(workspace_id, principal_id, memory_generation, due_at);

  CREATE TABLE IF NOT EXISTS conversation_search_documents (
    doc_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    turn_id TEXT NOT NULL UNIQUE REFERENCES qa_turns(turn_id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    search_text TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    embedding_model_id TEXT,
    embedding_dimensions INTEGER CHECK (embedding_dimensions IS NULL OR embedding_dimensions > 0),
    embedding BLOB,
    embedding_fingerprint TEXT,
    index_state TEXT NOT NULL DEFAULT 'pending' CHECK (index_state IN ('pending', 'ready', 'failed', 'disabled')),
    created_at TEXT NOT NULL,
    FOREIGN KEY (workspace_id, principal_id)
      REFERENCES memory_subjects(workspace_id, principal_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS assistant_used_memories (
    turn_id TEXT NOT NULL REFERENCES qa_turns(turn_id) ON DELETE CASCADE,
    item_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('profile', 'preference', 'fact', 'task', 'interest')),
    content_snapshot TEXT NOT NULL,
    used_at TEXT NOT NULL,
    PRIMARY KEY (turn_id, item_id)
  );

  CREATE TABLE IF NOT EXISTS memory_migration_audit (
    source_store TEXT NOT NULL,
    source_table TEXT NOT NULL,
    source_id TEXT NOT NULL,
    source_fingerprint TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT,
    mapping_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(mapping_json)),
    status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'skipped', 'failed', 'rolled-back')),
    error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (source_store, source_table, source_id)
  );

  CREATE TABLE IF NOT EXISTS qa_agent_messages (
    message_id TEXT PRIMARY KEY CHECK (length(message_id) > 0),
    turn_id TEXT NOT NULL REFERENCES qa_turns(turn_id) ON DELETE CASCADE,
    message_seq INTEGER NOT NULL CHECK (message_seq >= 0),
    role TEXT NOT NULL CHECK (role IN ('assistant', 'tool')),
    content TEXT NOT NULL DEFAULT '',
    reasoning_content TEXT NOT NULL DEFAULT '',
    tool_call_id TEXT,
    artifact_ref_json TEXT CHECK (artifact_ref_json IS NULL OR json_valid(artifact_ref_json)),
    created_at TEXT NOT NULL,
    UNIQUE (turn_id, message_seq),
    CHECK ((role = 'tool' AND tool_call_id IS NOT NULL) OR role = 'assistant')
  );

  CREATE TABLE IF NOT EXISTS qa_agent_tool_calls (
    call_id TEXT NOT NULL CHECK (length(call_id) > 0),
    message_id TEXT NOT NULL REFERENCES qa_agent_messages(message_id) ON DELETE CASCADE,
    call_seq INTEGER NOT NULL CHECK (call_seq >= 0),
    tool_name TEXT NOT NULL CHECK (length(tool_name) > 0),
    arguments_json TEXT NOT NULL CHECK (json_valid(arguments_json)),
    PRIMARY KEY (message_id, call_id),
    UNIQUE (message_id, call_seq)
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_qa_turns_request_attempt
    ON qa_turns(session_id, request_id, attempt_no);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_qa_turns_current_completed
    ON qa_turns(session_id, request_id)
    WHERE status IN ('complete', 'partial', 'not-found') AND replaced_by_turn_id IS NULL;
  CREATE INDEX IF NOT EXISTS idx_memory_items_scope_status
    ON memory_items(workspace_id, principal_id, status);
  CREATE INDEX IF NOT EXISTS idx_memory_items_scope_key
    ON memory_items(workspace_id, principal_id, normalized_key);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_items_active_key
    ON memory_items(workspace_id, principal_id, kind, normalized_key)
    WHERE status = 'active';
  CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_items_pending_key
    ON memory_items(workspace_id, principal_id, kind, normalized_key)
    WHERE status = 'pending';
  CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_items_pending_target
    ON memory_items(workspace_id, principal_id, replaces_id)
    WHERE status = 'pending' AND replaces_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_tombstones_scope_fingerprint
    ON memory_tombstones(workspace_id, principal_id, fingerprint);
  CREATE INDEX IF NOT EXISTS idx_memory_tombstones_scope_created
    ON memory_tombstones(workspace_id, principal_id, created_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_topic_stats_scope_key
    ON memory_topic_stats(workspace_id, principal_id, normalized_key);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_doc_affinities_scope_document
    ON memory_doc_affinities(workspace_id, principal_id, document_id);
  CREATE INDEX IF NOT EXISTS idx_memory_doc_affinity_events_scope
    ON memory_doc_affinity_events(workspace_id, principal_id, recorded_at DESC);
  CREATE INDEX IF NOT EXISTS idx_memory_item_embeddings_scope_model
    ON memory_item_embeddings(workspace_id, principal_id, model_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_extraction_jobs_live_scope
    ON memory_extraction_jobs(workspace_id, principal_id)
    WHERE status IN ('queued', 'running', 'retry');
  CREATE INDEX IF NOT EXISTS idx_memory_extraction_jobs_due
    ON memory_extraction_jobs(status, due_at ASC, id ASC);
  CREATE INDEX IF NOT EXISTS idx_conversation_search_scope_session_created
    ON conversation_search_documents(workspace_id, principal_id, session_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_assistant_used_memories_turn
    ON assistant_used_memories(turn_id);

  CREATE VIRTUAL TABLE IF NOT EXISTS conversation_search_fts USING fts5(
    question,
    answer,
    content='conversation_search_documents',
    content_rowid='doc_rowid',
    tokenize='unicode61'
  );
  CREATE TRIGGER IF NOT EXISTS conversation_search_documents_ai AFTER INSERT ON conversation_search_documents BEGIN
    INSERT INTO conversation_search_fts(rowid, question, answer)
    VALUES (new.doc_rowid, new.question, new.answer);
  END;
  CREATE TRIGGER IF NOT EXISTS conversation_search_documents_ad AFTER DELETE ON conversation_search_documents BEGIN
    INSERT INTO conversation_search_fts(conversation_search_fts, rowid, question, answer)
    VALUES ('delete', old.doc_rowid, old.question, old.answer);
  END;
  CREATE TRIGGER IF NOT EXISTS conversation_search_documents_au AFTER UPDATE ON conversation_search_documents BEGIN
    INSERT INTO conversation_search_fts(conversation_search_fts, rowid, question, answer)
    VALUES ('delete', old.doc_rowid, old.question, old.answer);
    INSERT INTO conversation_search_fts(rowid, question, answer)
    VALUES (new.doc_rowid, new.question, new.answer);
  END;
`;

export class QaMemoryDatabaseError extends Error {
  constructor(
    readonly code: 'QA_MEMORY_DATABASE_CORRUPT' | 'QA_MEMORY_DATABASE_UNAVAILABLE',
    message: string,
    readonly diagnostic?: string,
  ) {
    super(message);
  }
}

/**
 * Owns the unified Q&A memory database under `<workspace>/ConversationMemory/`.
 * This database is deliberately separate from assistant-memory.db and
 * conversation-memory.db. Data-source selection is per turn and never selects
 * a different Q&A memory database.
 */
export class QaMemoryDatabase {
  private readonly connections = new Map<string, Database.Database>();

  getDatabase(workspacePath: string): Database.Database {
    const normalizedWorkspacePath = path.resolve(workspacePath);
    const existing = this.connections.get(normalizedWorkspacePath);
    if (existing) return existing;

    const databasePath = getQaMemoryDatabasePath(normalizedWorkspacePath);
    let existed = fs.existsSync(databasePath);
    let database: Database.Database | undefined;
    try {
      copyLegacyQaMemoryDatabaseIfNeeded(normalizedWorkspacePath, databasePath);
      existed = fs.existsSync(databasePath);
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
      database = new Database(databasePath);
      database.pragma('journal_mode = WAL');
      database.pragma('foreign_keys = ON');
      database.pragma('busy_timeout = 5000');
      database.pragma('synchronous = NORMAL');
      database.pragma('temp_store = MEMORY');
      const integrity = database.pragma('quick_check', { simple: true });
      if (integrity !== 'ok') {
        throw new QaMemoryDatabaseError(
          'QA_MEMORY_DATABASE_CORRUPT',
          '问答记忆数据库完整性校验失败。请先备份并恢复 ConversationMemory/qa-memory.db。',
        );
      }
      if (existed && shouldBackupBeforeCheckpointShapeUpgrade(database)) {
        createQaMemoryCheckpointMigrationBackup(database, normalizedWorkspacePath);
      }
      const previousVersion = Number(database.pragma('user_version', { simple: true }));
      if (existed && previousVersion > 0 && previousVersion < QA_MEMORY_SCHEMA_VERSION) {
        const snapshotPath = `${databasePath}.pre-v${QA_MEMORY_SCHEMA_VERSION}-${new Date().toISOString().replace(/[:.]/gu, '-')}-${process.pid}.db`;
        database.prepare('VACUUM INTO ?').run(snapshotPath);
      }
      migrateQaMemoryDatabase(database);
      recoverExpiredMemoryExtractionJobLeases(database);
      this.connections.set(normalizedWorkspacePath, database);
      return database;
    } catch (error) {
      database?.close();
      if (error instanceof QaMemoryDatabaseError) throw error;
      const message = existed
        ? '无法打开问答记忆数据库。为避免丢失会话记忆，应用未自动重建该数据库。'
        : '无法创建问答记忆数据库。请检查系统工作区是否可写。';
      throw new QaMemoryDatabaseError(
        existed ? 'QA_MEMORY_DATABASE_CORRUPT' : 'QA_MEMORY_DATABASE_UNAVAILABLE',
        message,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  closeAll(): void {
    for (const database of this.connections.values()) database.close();
    this.connections.clear();
  }
}

export function getQaMemoryDatabasePath(workspacePath: string): string {
  return path.join(
    path.resolve(workspacePath),
    QA_MEMORY_DIRECTORY_NAME,
    QA_MEMORY_DATABASE_NAME,
  );
}

export function migrateQaMemoryDatabase(database: Database.Database): void {
  const version = Number(database.pragma('user_version', { simple: true }));
  if (!Number.isInteger(version) || version < 0 || version > QA_MEMORY_SCHEMA_VERSION) {
    throw new QaMemoryDatabaseError(
      'QA_MEMORY_DATABASE_UNAVAILABLE',
      '问答记忆数据库版本不受当前应用支持。',
    );
  }
  if (version === QA_MEMORY_SCHEMA_VERSION) {
    database.transaction(() => {
      assertCurrentMemoryShape(database);
      ensureUserProfileSchema(database);
      ensureConversationCheckpointPhase2Shape(database);
    })();
    return;
  }

  if (version === 0) {
    database.transaction(() => {
      database.exec(`
      CREATE TABLE qa_sessions (
        session_id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope IN ('chat', 'knowledge-base')),
        title TEXT NOT NULL,
        library_path TEXT,
        is_pinned INTEGER NOT NULL DEFAULT 0 CHECK (is_pinned IN (0, 1)),
        last_turn_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_turn_seq >= 0),
        summarized_through_seq INTEGER NOT NULL DEFAULT 0 CHECK (summarized_through_seq >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE qa_turns (
        turn_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES qa_sessions(session_id) ON DELETE CASCADE,
        turn_seq INTEGER NOT NULL CHECK (turn_seq > 0),
        request_id TEXT NOT NULL,
        attempt_no INTEGER NOT NULL DEFAULT 1 CHECK (attempt_no >= 1),
        replaced_by_turn_id TEXT REFERENCES qa_turns(turn_id) ON DELETE SET NULL,
        user_text TEXT NOT NULL,
        assistant_text TEXT,
        scope_label TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('pending', 'complete', 'partial', 'not-found', 'cancelled', 'error', 'interrupted')),
        user_tokens INTEGER NOT NULL DEFAULT 0,
        assistant_tokens INTEGER NOT NULL DEFAULT 0,
        result_json TEXT NOT NULL DEFAULT '{}',
        result_metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(result_metadata_json)),
        created_at TEXT NOT NULL,
        finished_at TEXT,
        UNIQUE (session_id, turn_seq),
        UNIQUE (session_id, request_id, attempt_no)
      );
      CREATE TABLE qa_summaries (
        batch_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES qa_sessions(session_id) ON DELETE CASCADE,
        turn_from INTEGER NOT NULL CHECK (turn_from > 0),
        turn_to INTEGER NOT NULL CHECK (turn_to >= turn_from),
        summary_text TEXT NOT NULL,
        tokens INTEGER NOT NULL DEFAULT 0,
        compressor TEXT NOT NULL CHECK (compressor IN ('llm', 'fallback')),
        status TEXT NOT NULL CHECK (status IN ('done', 'failed')),
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (session_id, turn_from)
      );
      CREATE TABLE qa_summary_rollups (
        rollup_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES qa_sessions(session_id) ON DELETE CASCADE,
        level INTEGER NOT NULL CHECK (level IN (2, 3)),
        source_start_seq INTEGER NOT NULL CHECK (source_start_seq > 0),
        source_end_seq INTEGER NOT NULL CHECK (source_end_seq >= source_start_seq),
        source_ids_json TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        summary_text TEXT NOT NULL,
        tokens INTEGER NOT NULL DEFAULT 0 CHECK (tokens >= 0),
        compressor TEXT NOT NULL CHECK (compressor IN ('llm', 'fallback')),
        status TEXT NOT NULL CHECK (status IN ('done', 'failed', 'stale')),
        summary_version INTEGER NOT NULL DEFAULT 1 CHECK (summary_version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (session_id, level, source_start_seq)
      );
      CREATE TABLE memory_migrations (
        migration_id TEXT PRIMARY KEY,
        source_path TEXT NOT NULL,
        source_fingerprint TEXT NOT NULL,
        migration_version INTEGER NOT NULL CHECK (migration_version > 0),
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
        source_session_count INTEGER NOT NULL DEFAULT 0 CHECK (source_session_count >= 0),
        source_turn_count INTEGER NOT NULL DEFAULT 0 CHECK (source_turn_count >= 0),
        copied_session_count INTEGER NOT NULL DEFAULT 0 CHECK (copied_session_count >= 0),
        copied_turn_count INTEGER NOT NULL DEFAULT 0 CHECK (copied_turn_count >= 0),
        source_hash TEXT NOT NULL DEFAULT '',
        target_hash TEXT NOT NULL DEFAULT '',
        backup_path TEXT NOT NULL DEFAULT '',
        error_message TEXT NOT NULL DEFAULT '',
        started_at TEXT NOT NULL,
        completed_at TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE (source_path, source_fingerprint, migration_version)
      );
      CREATE TABLE memory_migration_id_map (
        migration_id TEXT NOT NULL REFERENCES memory_migrations(migration_id) ON DELETE CASCADE,
        entity_type TEXT NOT NULL CHECK (entity_type IN ('session', 'turn')),
        legacy_id TEXT NOT NULL,
        qa_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        PRIMARY KEY (migration_id, entity_type, legacy_id),
        UNIQUE (migration_id, entity_type, qa_id)
      );
      CREATE INDEX idx_qa_sessions_order
        ON qa_sessions(scope, is_pinned DESC, updated_at DESC, session_id DESC);
      CREATE INDEX idx_qa_sessions_global_order
        ON qa_sessions(is_pinned DESC, updated_at DESC, session_id DESC);
      CREATE INDEX idx_qa_turns_session_seq
        ON qa_turns(session_id, turn_seq ASC);
      CREATE INDEX idx_qa_summaries_session_order
        ON qa_summaries(session_id, turn_from ASC);
      CREATE INDEX idx_qa_summary_rollups_session_level_order
        ON qa_summary_rollups(session_id, level, source_start_seq ASC);
      CREATE INDEX idx_memory_migrations_source
        ON memory_migrations(source_path, migration_version, status);
      CREATE INDEX idx_memory_migration_id_map_qa_id
        ON memory_migration_id_map(entity_type, qa_id);
      `);
      ensureUserProfileSchema(database);
      ensureConversationCheckpointPhase2Shape(database);
      ensureWeKnoraMemoryShape(database);
      database.pragma(`user_version = ${QA_MEMORY_SCHEMA_VERSION}`);
      assertCurrentMemoryShape(database);
    })();
    return;
  }

  database.transaction(() => {
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_qa_sessions_global_order
        ON qa_sessions(is_pinned DESC, updated_at DESC, session_id DESC);
      CREATE TABLE IF NOT EXISTS qa_summary_rollups (
        rollup_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES qa_sessions(session_id) ON DELETE CASCADE,
        level INTEGER NOT NULL CHECK (level IN (2, 3)),
        source_start_seq INTEGER NOT NULL CHECK (source_start_seq > 0),
        source_end_seq INTEGER NOT NULL CHECK (source_end_seq >= source_start_seq),
        source_ids_json TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        summary_text TEXT NOT NULL,
        tokens INTEGER NOT NULL DEFAULT 0 CHECK (tokens >= 0),
        compressor TEXT NOT NULL CHECK (compressor IN ('llm', 'fallback')),
        status TEXT NOT NULL CHECK (status IN ('done', 'failed', 'stale')),
        summary_version INTEGER NOT NULL DEFAULT 1 CHECK (summary_version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (session_id, level, source_start_seq)
      );
      CREATE INDEX IF NOT EXISTS idx_qa_summary_rollups_session_level_order
        ON qa_summary_rollups(session_id, level, source_start_seq ASC);
      CREATE TABLE IF NOT EXISTS memory_migrations (
        migration_id TEXT PRIMARY KEY,
        source_path TEXT NOT NULL,
        source_fingerprint TEXT NOT NULL,
        migration_version INTEGER NOT NULL CHECK (migration_version > 0),
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
        source_session_count INTEGER NOT NULL DEFAULT 0 CHECK (source_session_count >= 0),
        source_turn_count INTEGER NOT NULL DEFAULT 0 CHECK (source_turn_count >= 0),
        copied_session_count INTEGER NOT NULL DEFAULT 0 CHECK (copied_session_count >= 0),
        copied_turn_count INTEGER NOT NULL DEFAULT 0 CHECK (copied_turn_count >= 0),
        source_hash TEXT NOT NULL DEFAULT '',
        target_hash TEXT NOT NULL DEFAULT '',
        backup_path TEXT NOT NULL DEFAULT '',
        error_message TEXT NOT NULL DEFAULT '',
        started_at TEXT NOT NULL,
        completed_at TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE (source_path, source_fingerprint, migration_version)
      );
      CREATE TABLE IF NOT EXISTS memory_migration_id_map (
        migration_id TEXT NOT NULL REFERENCES memory_migrations(migration_id) ON DELETE CASCADE,
        entity_type TEXT NOT NULL CHECK (entity_type IN ('session', 'turn')),
        legacy_id TEXT NOT NULL,
        qa_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        PRIMARY KEY (migration_id, entity_type, legacy_id),
        UNIQUE (migration_id, entity_type, qa_id)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_migrations_source
        ON memory_migrations(source_path, migration_version, status);
      CREATE INDEX IF NOT EXISTS idx_memory_migration_id_map_qa_id
        ON memory_migration_id_map(entity_type, qa_id);
    `);
    ensureUserProfileSchema(database);
    ensureConversationCheckpointPhase2Shape(database);
    ensureWeKnoraMemoryShape(database);
    database.pragma(`user_version = ${QA_MEMORY_SCHEMA_VERSION}`);
    assertCurrentMemoryShape(database);
  })();
}

function ensureWeKnoraMemoryShape(database: Database.Database): void {
  ensureQaTurnV6Columns(database);
  ensureMemoryProposalV11Columns(database);
  database.exec(WEKNORA_MEMORY_SCHEMA_SQL);
  database.exec(MEMORY_PROPOSAL_V11_GUARDS_SQL);
  ensureMemoryExtractionJobV7Columns(database);
  ensureConversationSearchV8Columns(database);
}

/** Upgrade in the caller's migration transaction, without replaying or reattributing user history. */
function ensureMemoryProposalV11Columns(database: Database.Database): void {
  if (!hasDatabaseObject(database, 'table', 'memory_items')) return;
  const columns = new Set((database.prepare('PRAGMA table_info(memory_items)').all() as Array<{ name: string }>).map(row => row.name));
  const needsInitialization = !columns.has('write_protection');
  for (const definition of MEMORY_ITEM_V11_COLUMNS) {
    if (!columns.has(definition.split(' ')[0])) database.exec(`ALTER TABLE memory_items ADD COLUMN ${definition};`);
  }
  if (needsInitialization) {
    database.exec(`UPDATE memory_items SET
      proposal_action = CASE WHEN status = 'pending' THEN 'add' ELSE NULL END,
      review_reason = CASE WHEN status = 'pending' THEN 'LEGACY_PROPOSAL' ELSE NULL END,
      write_protection = CASE WHEN origin = 'extracted' THEN 'none'
        WHEN origin = 'explicit' AND EXISTS (SELECT 1 FROM qa_turns t
          WHERE t.turn_id = memory_items.source_message_id AND t.session_id = memory_items.source_session_id
            AND t.status = 'complete' AND t.replaced_by_turn_id IS NULL
            AND json_extract(t.result_metadata_json,'$.memoryScope.workspaceId') = memory_items.workspace_id
            AND json_extract(t.result_metadata_json,'$.memoryScope.principalId') = memory_items.principal_id
            AND json_extract(t.result_json,'$.memorySave.itemId') = memory_items.id
            AND json_extract(t.result_json,'$.memorySave.status') = 'saved') THEN 'user' ELSE 'legacy' END;`);
  }
  database.exec('DROP INDEX IF EXISTS idx_memory_items_live_key;');
}

function ensureMemoryExtractionJobV7Columns(database: Database.Database): void {
  const pendingColumns = new Set((database.prepare('PRAGMA table_info(memory_extraction_pending_sources)').all() as Array<{ name: string }>).map((column) => column.name));
  if (!pendingColumns.has('model_hint_json')) database.exec("ALTER TABLE memory_extraction_pending_sources ADD COLUMN model_hint_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(model_hint_json));");
  const columns = new Set((database.prepare('PRAGMA table_info(memory_extraction_jobs)').all() as Array<{ name: string }>).map((column) => column.name));
  if (!columns.has('source_model_profile_id')) database.exec('ALTER TABLE memory_extraction_jobs ADD COLUMN source_model_profile_id TEXT;');
  if (!columns.has('source_model_id')) database.exec('ALTER TABLE memory_extraction_jobs ADD COLUMN source_model_id TEXT;');
  if (!columns.has('source_context_window_tokens')) database.exec('ALTER TABLE memory_extraction_jobs ADD COLUMN source_context_window_tokens INTEGER;');
  // This executes only on upgrade, never on subsequent opens or late completions.
  if (!columns.has('claimed_sources_json')) {
    database.exec("ALTER TABLE memory_extraction_jobs ADD COLUMN claimed_sources_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(claimed_sources_json));");
    const timestamp = new Date().toISOString();
    database.prepare(`UPDATE memory_extraction_jobs SET status = 'stale', lease_until = NULL,
      last_error = CASE WHEN attempts > 0 THEN 'LEGACY_FAILURE_SOURCE_UNKNOWN' ELSE 'LEGACY_EXTRACTION_ELIGIBILITY_UNKNOWN' END,
      finished_at = ?, updated_at = ? WHERE status IN ('queued', 'running', 'retry')`).run(timestamp, timestamp);
    database.prepare(`UPDATE memory_extraction_jobs SET lease_until = NULL, last_error = 'LEGACY_FAILURE_SOURCE_UNKNOWN',
      finished_at = COALESCE(finished_at, ?), updated_at = ? WHERE status = 'failed'`).run(timestamp, timestamp);
    const legacy = database.prepare(`SELECT s.workspace_id, s.principal_id, s.memory_generation, t.turn_id, t.user_text, t.result_metadata_json
      FROM memory_subjects s JOIN qa_turns t
      ON json_extract(t.result_metadata_json, '$.memoryScope.workspaceId') = s.workspace_id
      AND json_extract(t.result_metadata_json, '$.memoryScope.principalId') = s.principal_id
      WHERE t.status = 'complete' AND t.replaced_by_turn_id IS NULL
      AND (t.created_at < s.extract_cursor_at OR (t.created_at = s.extract_cursor_at AND t.turn_id <= s.extract_cursor_message_id))`).all() as Array<{
        workspace_id: string; principal_id: string; memory_generation: number; turn_id: string; user_text: string; result_metadata_json: string;
      }>;
    const insert = database.prepare(`INSERT OR IGNORE INTO memory_extraction_turn_receipts VALUES (?, ?, ?, ?, ?, 'legacy_baseline', 'legacy-v9', NULL, ?)`);
    for (const row of legacy) insert.run(row.workspace_id, row.principal_id, row.memory_generation, row.turn_id,
      createHash('sha256').update(row.user_text + row.result_metadata_json).digest('hex'), timestamp);
  }
}

function ensureConversationSearchV8Columns(database: Database.Database): void {
  const columns = new Set((database.prepare('PRAGMA table_info(conversation_search_documents)').all() as Array<{ name: string }>).map((column) => column.name));
  if (!columns.has('embedding_dimensions')) {
    database.exec('ALTER TABLE conversation_search_documents ADD COLUMN embedding_dimensions INTEGER CHECK (embedding_dimensions IS NULL OR embedding_dimensions > 0);');
  }
  if (!columns.has('embedding')) database.exec('ALTER TABLE conversation_search_documents ADD COLUMN embedding BLOB;');
}

function ensureQaTurnV6Columns(database: Database.Database): void {
  const columns = new Set((database.prepare('PRAGMA table_info(qa_turns)').all() as Array<{ name: string }>).map((column) => column.name));
  if (!columns.has('request_id')) database.exec("ALTER TABLE qa_turns ADD COLUMN request_id TEXT NOT NULL DEFAULT '';");
  if (!columns.has('attempt_no')) database.exec('ALTER TABLE qa_turns ADD COLUMN attempt_no INTEGER NOT NULL DEFAULT 1 CHECK (attempt_no >= 1);');
  if (!columns.has('replaced_by_turn_id')) {
    database.exec('ALTER TABLE qa_turns ADD COLUMN replaced_by_turn_id TEXT REFERENCES qa_turns(turn_id) ON DELETE SET NULL;');
  }
  if (!columns.has('result_metadata_json')) {
    database.exec("ALTER TABLE qa_turns ADD COLUMN result_metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(result_metadata_json));");
  }
  database.exec(`
    UPDATE qa_turns SET request_id = turn_id WHERE request_id = '';
    UPDATE qa_turns SET result_metadata_json = '{}' WHERE NOT json_valid(result_metadata_json);
    UPDATE qa_turns
    SET result_json = CASE
      WHEN json_valid(result_json) AND json_type(result_json) = 'object'
        THEN json_remove(result_json, '$.answer', '$.thinkingText', '$.modelEvents')
      ELSE '{}'
    END;
  `);
}

function assertCurrentMemoryShape(database: Database.Database): void {
  assertV5Shape(database);
  const requiredTables = [
    'memory_workspace_settings',
    'memory_subjects',
    'memory_items',
    'memory_tombstones',
    'memory_topic_stats',
    'memory_doc_affinities',
    'memory_doc_affinity_events',
    'memory_item_embeddings',
    'memory_extraction_jobs',
    'memory_extraction_turn_receipts',
    'memory_extraction_pending_sources',
    'conversation_search_documents',
    'conversation_search_fts',
    'assistant_used_memories',
    'memory_migration_audit',
    'qa_agent_messages',
    'qa_agent_tool_calls',
  ];
  for (const table of requiredTables) {
    if (!hasDatabaseObject(database, 'table', table)) throw new Error(`qa-memory v10 结构缺少表：${table}`);
  }
  const requiredIndexes = [
    'idx_qa_turns_request_attempt',
    'idx_qa_turns_current_completed',
    'idx_memory_items_scope_status',
    'idx_memory_items_scope_key',
    'idx_memory_items_active_key',
    'idx_memory_items_pending_key',
    'idx_memory_items_pending_target',
    'idx_memory_tombstones_scope_fingerprint',
    'idx_memory_tombstones_scope_created',
    'idx_memory_topic_stats_scope_key',
    'idx_memory_doc_affinities_scope_document',
    'idx_memory_doc_affinity_events_scope',
    'idx_memory_item_embeddings_scope_model',
    'idx_memory_extraction_jobs_live_scope',
    'idx_memory_extraction_jobs_due',
    'idx_memory_extraction_pending_due',
    'idx_conversation_search_scope_session_created',
    'idx_assistant_used_memories_turn',
  ];
  for (const index of requiredIndexes) {
    if (!hasDatabaseObject(database, 'index', index)) throw new Error(`qa-memory v10 结构缺少索引：${index}`);
  }
  const itemColumns = new Set((database.prepare('PRAGMA table_info(memory_items)').all() as Array<{ name: string }>).map(row => row.name));
  for (const definition of MEMORY_ITEM_V11_COLUMNS) {
    if (!itemColumns.has(definition.split(' ')[0])) throw new Error(`qa-memory v11 memory_items 缺少字段：${definition.split(' ')[0]}`);
  }
  for (const trigger of ['memory_proposal_insert_guard', 'memory_proposal_update_guard', 'memory_proposal_target_delete']) {
    if (!hasDatabaseObject(database, 'trigger', trigger)) throw new Error(`qa-memory v11 缺少约束：${trigger}`);
  }
  for (const [name, status] of [['idx_memory_items_active_key', 'active'], ['idx_memory_items_pending_key', 'pending']]) {
    const sql = (database.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(name) as { sql: string }).sql;
    if (!sql.includes(`WHERE status = '${status}'`)) throw new Error(`qa-memory v11 索引定义错误：${name}`);
  }
  if (hasDatabaseObject(database, 'index', 'idx_memory_items_live_key')) throw new Error('qa-memory v11 仍包含旧 live 索引。');
  const itemForeignKeys = database.prepare('PRAGMA foreign_key_list(memory_items)').all() as Array<{ from: string; table: string; on_delete: string }>;
  if (!itemForeignKeys.some(key => key.from === 'replaces_id' && key.table === 'memory_items' && key.on_delete === 'SET NULL')) throw new Error('qa-memory v11 提案目标外键缺失。');
  const turnColumns = new Set((database.prepare('PRAGMA table_info(qa_turns)').all() as Array<{ name: string }>).map((column) => column.name));
  for (const column of ['request_id', 'attempt_no', 'replaced_by_turn_id', 'assistant_text', 'result_metadata_json']) {
    if (!turnColumns.has(column)) throw new Error(`qa-memory v10 qa_turns 缺少字段：${column}`);
  }
  const extractionColumns = new Set((database.prepare('PRAGMA table_info(memory_extraction_jobs)').all() as Array<{ name: string }>).map((column) => column.name));
  for (const column of ['source_model_profile_id', 'source_model_id', 'source_context_window_tokens', 'claimed_sources_json']) {
    if (!extractionColumns.has(column)) throw new Error(`qa-memory v10 memory_extraction_jobs 缺少字段：${column}`);
  }
  const pendingColumns = new Set((database.prepare('PRAGMA table_info(memory_extraction_pending_sources)').all() as Array<{ name: string }>).map((column) => column.name));
  if (!pendingColumns.has('model_hint_json')) throw new Error('qa-memory v10 pending sources 缺少 model_hint_json。');
  const conversationColumns = new Set((database.prepare('PRAGMA table_info(conversation_search_documents)').all() as Array<{ name: string }>).map((column) => column.name));
  for (const column of ['embedding_dimensions', 'embedding']) {
    if (!conversationColumns.has(column)) throw new Error(`qa-memory v10 conversation_search_documents 缺少字段：${column}`);
  }
  const foreignKeys = database.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeys.length) throw new Error('qa-memory v10 外键校验失败。');
}

export function recoverExpiredMemoryExtractionJobLeases(
  database: Database.Database,
  now = new Date(),
): number {
  if (!hasDatabaseObject(database, 'table', 'memory_extraction_jobs')) return 0;
  const timestamp = now.toISOString();
  return database.prepare(`
    UPDATE memory_extraction_jobs
    SET status = CASE WHEN attempts > ? THEN 'failed' ELSE 'retry' END, due_at = ?, lease_until = NULL,
        finished_at = CASE WHEN attempts > ? THEN ? ELSE NULL END,
        last_error = COALESCE(last_error, 'LEASE_EXPIRED'), updated_at = ?
    WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until <= ?
  `).run(MEMORY_CONSTANTS.writeAndExtraction.queueFailureRetryLimit, timestamp,
    MEMORY_CONSTANTS.writeAndExtraction.queueFailureRetryLimit, timestamp, timestamp, timestamp).changes;
}

function assertV5Shape(database: Database.Database): void {
  const requiredTables = [
    'qa_sessions',
    'qa_turns',
    'qa_summaries',
    'qa_summary_rollups',
    'memory_migrations',
    'memory_migration_id_map',
    'qa_memory_checkpoints',
    'qa_memory_compaction_runs',
    'user_profile_settings',
    'user_profile_items',
    'user_profile_evidence',
    'user_profile_extraction_jobs',
    'user_profile_revisions',
  ];
  for (const table of requiredTables) {
    const exists = database.prepare(`
      SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?
    `).get(table) as { present: number } | undefined;
    if (!exists) throw new Error(`qa-memory v5 结构缺少表：${table}`);
  }
  const globalOrderIndex = database.prepare(`
    SELECT 1 AS present FROM sqlite_master WHERE type = 'index' AND name = 'idx_qa_sessions_global_order'
  `).get() as { present: number } | undefined;
  if (!globalOrderIndex) throw new Error('qa-memory v5 结构缺少全局会话排序索引。');
  const rollupIndex = database.prepare(`
    SELECT 1 AS present FROM sqlite_master WHERE type = 'index' AND name = 'idx_qa_summary_rollups_session_level_order'
  `).get() as { present: number } | undefined;
  if (!rollupIndex) throw new Error('qa-memory v5 结构缺少分层摘要排序索引。');
  const migrationIndex = database.prepare(`
    SELECT 1 AS present FROM sqlite_master WHERE type = 'index' AND name = 'idx_memory_migrations_source'
  `).get() as { present: number } | undefined;
  if (!migrationIndex) throw new Error('qa-memory v5 结构缺少迁移审计索引。');
  const compactionRunIndex = database.prepare(`
    SELECT 1 AS present FROM sqlite_master WHERE type = 'index' AND name = 'idx_qa_memory_compaction_runs_session'
  `).get() as { present: number } | undefined;
  if (!compactionRunIndex) throw new Error('qa-memory v5 结构缺少 Checkpoint 压缩审计索引。');
  const profileOverviewIndex = database.prepare(`
    SELECT 1 AS present FROM sqlite_master WHERE type = 'index' AND name = 'idx_user_profile_items_overview'
  `).get() as { present: number } | undefined;
  if (!profileOverviewIndex) throw new Error('qa-memory v5 结构缺少用户信息总览索引。');
  const profileEvidenceIndex = database.prepare(`
    SELECT 1 AS present FROM sqlite_master WHERE type = 'index' AND name = 'idx_user_profile_evidence_item_time'
  `).get() as { present: number } | undefined;
  if (!profileEvidenceIndex) throw new Error('qa-memory v5 结构缺少用户信息证据索引。');
  const profileEvidenceTurnIndex = database.prepare(`
    SELECT 1 AS present FROM sqlite_master WHERE type = 'index' AND name = 'idx_user_profile_evidence_item_turn'
  `).get() as { present: number } | undefined;
  if (!profileEvidenceTurnIndex) throw new Error('qa-memory v5 结构缺少用户信息证据幂等索引。');
  const profileJobColumns = new Set((database.prepare('PRAGMA table_info(user_profile_extraction_jobs)').all() as Array<{ name: string }>).map((column) => column.name));
  for (const column of ['session_id', 'scope', 'attempt_count', 'manual_retry_no', 'model_profile_id', 'input_hash', 'observation_count', 'duration_ms']) {
    if (!profileJobColumns.has(column)) throw new Error(`qa-memory v5 画像任务表缺少字段：${column}`);
  }
  const checkpointColumns = new Set((database.prepare('PRAGMA table_info(qa_memory_checkpoints)').all() as Array<{ name: string }>).map((column) => column.name));
  for (const column of ['checkpoint_version', 'covered_through_seq', 'source_hash', 'summary_payload_json', 'summary_tokens', 'target_tokens', 'source_tokens', 'compression_ratio']) {
    if (!checkpointColumns.has(column)) throw new Error(`qa-memory v5 Checkpoint 表缺少字段：${column}`);
  }
  const foreignKeys = database.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeys.length) throw new Error('qa-memory v5 外键校验失败。');
}

function ensureUserProfileSchema(database: Database.Database): void {
  const hasPublishedPhase1Shape = [
    'user_profile_settings',
    'user_profile_items',
    'user_profile_evidence',
    'user_profile_extraction_jobs',
    'user_profile_revisions',
  ].every((table) => hasDatabaseObject(database, 'table', table));
  // The published Phase 1 tables predate indexes that reference Phase 2
  // columns, so rebuild that shape before running CREATE INDEX IF NOT EXISTS.
  if (hasPublishedPhase1Shape) ensureUserProfilePhase2Shape(database);
  database.exec(USER_PROFILE_SCHEMA_SQL);
  ensureUserProfilePhase2Shape(database);
}

function ensureConversationCheckpointPhase2Shape(database: Database.Database): void {
  database.exec(CONVERSATION_CHECKPOINT_SCHEMA_SQL);
}

function shouldBackupBeforeCheckpointShapeUpgrade(database: Database.Database): boolean {
  const version = Number(database.pragma('user_version', { simple: true }));
  if (!Number.isSafeInteger(version) || version <= 0) return false;
  return !hasDatabaseObject(database, 'table', 'qa_memory_checkpoints')
    || !hasDatabaseObject(database, 'table', 'qa_memory_compaction_runs');
}

/** Creates and re-opens a consistent SQLite snapshot before the additive v5 shape upgrade. */
export function createQaMemoryCheckpointMigrationBackup(
  database: Database.Database,
  workspacePath: string,
): string {
  const backupDirectory = path.join(path.resolve(workspacePath), QA_MEMORY_DIRECTORY_NAME, 'backups');
  fs.mkdirSync(backupDirectory, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const backupPath = path.join(backupDirectory, `qa-memory-pre-checkpoint-v5-${timestamp}-${process.pid}.db`);
  let verificationDatabase: Database.Database | undefined;
  try {
    fs.writeFileSync(backupPath, database.serialize(), { flag: 'wx' });
    verificationDatabase = new Database(backupPath, { readonly: true, fileMustExist: true });
    verificationDatabase.pragma('foreign_keys = ON');
    if (verificationDatabase.pragma('quick_check', { simple: true }) !== 'ok') {
      throw new Error('Checkpoint 迁移备份完整性校验失败。');
    }
    if (verificationDatabase.prepare('PRAGMA foreign_key_check').all().length > 0) {
      throw new Error('Checkpoint 迁移备份外键校验失败。');
    }
    return backupPath;
  } catch (error) {
    verificationDatabase?.close();
    verificationDatabase = undefined;
    fs.rmSync(backupPath, { force: true });
    throw error;
  } finally {
    verificationDatabase?.close();
  }
}

function hasDatabaseObject(database: Database.Database, type: 'table' | 'index' | 'trigger', name: string): boolean {
  return Boolean(database.prepare(`
    SELECT 1 AS present FROM sqlite_master WHERE type = ? AND name = ?
  `).get(type, name));
}

/**
 * Phase 1 already shipped user_version=5 with placeholder job/evidence tables.
 * Upgrade that same-version shape in place instead of inventing a destructive
 * downgrade or silently leaving existing workspaces unable to run Phase 2.
 */
function ensureUserProfilePhase2Shape(database: Database.Database): void {
  const settingsColumns = new Set((database.prepare('PRAGMA table_info(user_profile_settings)').all() as Array<{ name: string }>).map((column) => column.name));
  if (!settingsColumns.has('extraction_model_profile_id')) {
    database.exec('ALTER TABLE user_profile_settings ADD COLUMN extraction_model_profile_id TEXT;');
  }

  const jobColumns = new Set((database.prepare('PRAGMA table_info(user_profile_extraction_jobs)').all() as Array<{ name: string }>).map((column) => column.name));
  if (!jobColumns.has('manual_retry_no')) rebuildUserProfileJobsTable(database);

  const evidenceSql = database.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'user_profile_evidence'
  `).get() as { sql: string } | undefined;
  if (evidenceSql?.sql.includes('ON DELETE SET NULL')) rebuildUserProfileEvidenceTable(database);

  database.exec(`
    DELETE FROM user_profile_evidence
    WHERE source_turn_id IS NOT NULL
      AND rowid NOT IN (
        SELECT MIN(rowid) FROM user_profile_evidence
        WHERE source_turn_id IS NOT NULL
        GROUP BY item_id, source_turn_id
      );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_profile_evidence_item_turn
      ON user_profile_evidence(item_id, source_turn_id) WHERE source_turn_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_user_profile_jobs_status
      ON user_profile_extraction_jobs(profile_id, status, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_user_profile_jobs_session
      ON user_profile_extraction_jobs(session_id, status, created_at ASC);
    UPDATE user_profile_items
    SET source_count = (SELECT COUNT(*) FROM user_profile_evidence WHERE item_id = user_profile_items.item_id);
  `);
}

function rebuildUserProfileJobsTable(database: Database.Database): void {
  database.exec(`
    DROP INDEX IF EXISTS idx_user_profile_jobs_status;
    DROP INDEX IF EXISTS idx_user_profile_jobs_session;
    ALTER TABLE user_profile_extraction_jobs RENAME TO user_profile_extraction_jobs_phase1;
    CREATE TABLE user_profile_extraction_jobs (
      job_id TEXT PRIMARY KEY,
      source_turn_id TEXT NOT NULL UNIQUE REFERENCES qa_turns(turn_id) ON DELETE CASCADE,
      profile_id TEXT NOT NULL REFERENCES user_profile_settings(profile_id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('chat', 'knowledge-base')),
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'empty', 'failed', 'blocked', 'unknown')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      failed_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempt_count >= 0),
      manual_retry_no INTEGER NOT NULL DEFAULT 0 CHECK (manual_retry_no >= 0),
      model_profile_id TEXT,
      provider_id TEXT NOT NULL DEFAULT '',
      model_id TEXT NOT NULL DEFAULT '',
      context_window_tokens INTEGER NOT NULL DEFAULT 128000 CHECK (context_window_tokens > 0),
      extractor_version TEXT NOT NULL DEFAULT '',
      input_hash TEXT NOT NULL DEFAULT '',
      output_hash TEXT NOT NULL DEFAULT '',
      observation_count INTEGER NOT NULL DEFAULT 0 CHECK (observation_count >= 0),
      applied_count INTEGER NOT NULL DEFAULT 0 CHECK (applied_count >= 0),
      filtered_sensitive_count INTEGER NOT NULL DEFAULT 0 CHECK (filtered_sensitive_count >= 0),
      filtered_invalid_count INTEGER NOT NULL DEFAULT 0 CHECK (filtered_invalid_count >= 0),
      input_chars INTEGER NOT NULL DEFAULT 0 CHECK (input_chars >= 0),
      output_chars INTEGER NOT NULL DEFAULT 0 CHECK (output_chars >= 0),
      input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
      output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
      duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
      error_code TEXT NOT NULL DEFAULT '',
      error_message TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      updated_at TEXT NOT NULL
    );
    INSERT INTO user_profile_extraction_jobs (
      job_id, source_turn_id, profile_id, session_id, scope, status,
      attempt_count, failed_attempt_count, manual_retry_no, extractor_version,
      error_code, error_message, created_at, started_at, finished_at, updated_at
    )
    SELECT old.job_id, old.source_turn_id, old.profile_id, turns.session_id,
           CASE WHEN turns.scope_label LIKE '%资料库%' THEN 'knowledge-base' ELSE 'chat' END,
           CASE old.status WHEN 'skipped' THEN 'blocked' ELSE old.status END,
           CASE WHEN old.status = 'running' THEN 1 ELSE 0 END,
           CASE WHEN old.status = 'failed' THEN 1 ELSE 0 END,
           0, old.extractor_version, old.error_code, old.error_message,
           old.created_at, old.started_at, old.completed_at, old.updated_at
      FROM user_profile_extraction_jobs_phase1 AS old
      JOIN qa_turns AS turns ON turns.turn_id = old.source_turn_id;
    DROP TABLE user_profile_extraction_jobs_phase1;
  `);
}

function rebuildUserProfileEvidenceTable(database: Database.Database): void {
  database.exec(`
    DROP INDEX IF EXISTS idx_user_profile_evidence_item_time;
    DROP INDEX IF EXISTS idx_user_profile_evidence_item_turn;
    ALTER TABLE user_profile_evidence RENAME TO user_profile_evidence_phase1;
    CREATE TABLE user_profile_evidence (
      evidence_id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL REFERENCES user_profile_items(item_id) ON DELETE CASCADE,
      source_turn_id TEXT REFERENCES qa_turns(turn_id) ON DELETE CASCADE,
      source_session_id TEXT,
      source_scope TEXT NOT NULL CHECK (source_scope IN ('chat', 'knowledge-base', 'manual')),
      excerpt TEXT NOT NULL,
      assertion_kind TEXT NOT NULL CHECK (assertion_kind IN ('manual', 'explicit', 'inferred')),
      confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO user_profile_evidence
      SELECT * FROM user_profile_evidence_phase1;
    DROP TABLE user_profile_evidence_phase1;
    CREATE INDEX idx_user_profile_evidence_item_time
      ON user_profile_evidence(item_id, occurred_at DESC, evidence_id DESC);
    CREATE UNIQUE INDEX idx_user_profile_evidence_item_turn
      ON user_profile_evidence(item_id, source_turn_id) WHERE source_turn_id IS NOT NULL;
  `);
}

function copyLegacyQaMemoryDatabaseIfNeeded(workspacePath: string, databasePath: string): void {
  if (fs.existsSync(databasePath)) return;
  const legacyPath = path.join(workspacePath, QA_MEMORY_LEGACY_DIRECTORY_NAME, QA_MEMORY_DATABASE_NAME);
  if (!fs.existsSync(legacyPath)) return;

  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const migrationSuffix = `.migrating-${process.pid}-${Date.now()}`;
  const temporaryDatabasePath = `${databasePath}${migrationSuffix}`;
  let legacyDatabase: Database.Database | undefined;
  let publishedDatabase = false;
  try {
    // serialize() obtains a consistent SQLite snapshot including committed WAL
    // pages, avoiding a torn main-file/WAL pair during first-launch migration.
    legacyDatabase = new Database(legacyPath, { readonly: true, fileMustExist: true });
    fs.writeFileSync(temporaryDatabasePath, legacyDatabase.serialize(), { flag: 'wx' });
    legacyDatabase.close();
    legacyDatabase = undefined;
    fs.renameSync(temporaryDatabasePath, databasePath);
    publishedDatabase = true;
  } catch (error) {
    if (publishedDatabase) fs.rmSync(databasePath, { force: true });
    throw error;
  } finally {
    legacyDatabase?.close();
    fs.rmSync(temporaryDatabasePath, { force: true });
  }
}
