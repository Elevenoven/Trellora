PRAGMA foreign_keys = ON;

CREATE TABLE assistant_note_identity (
  note_id TEXT PRIMARY KEY,
  relative_path TEXT NOT NULL UNIQUE,
  last_content_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'missing', 'deleted')),
  missing_since TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE assistant_sessions (
  session_id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES assistant_note_identity(note_id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  last_turn_seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (session_id, note_id)
);

CREATE TABLE assistant_turns (
  turn_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES assistant_sessions(session_id) ON DELETE CASCADE,
  turn_seq INTEGER NOT NULL,
  note_content_hash TEXT NOT NULL,
  user_text TEXT NOT NULL,
  assistant_text TEXT,
  route TEXT NOT NULL,
  context_mode TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'complete', 'partial', 'not-found', 'cancelled', 'error', 'interrupted')),
  stop_reason TEXT,
  provider_fingerprint TEXT NOT NULL,
  model TEXT NOT NULL,
  usage_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE (session_id, turn_id),
  UNIQUE (session_id, turn_seq)
);

CREATE TABLE assistant_memory_state (
  session_id TEXT PRIMARY KEY REFERENCES assistant_sessions(session_id) ON DELETE CASCADE,
  note_content_hash TEXT NOT NULL,
  summarized_through_seq INTEGER NOT NULL DEFAULT 0,
  rolling_summary TEXT NOT NULL DEFAULT '',
  unresolved_questions_json TEXT NOT NULL DEFAULT '[]',
  memory_version INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE assistant_claims (
  claim_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES assistant_sessions(session_id) ON DELETE CASCADE,
  source_turn_id TEXT NOT NULL,
  note_content_hash TEXT NOT NULL,
  normalized_key TEXT NOT NULL,
  claim_text TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'superseded', 'stale')),
  revision INTEGER NOT NULL,
  supersedes_claim_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (session_id, claim_id),
  UNIQUE (session_id, normalized_key, revision),
  FOREIGN KEY (session_id, source_turn_id) REFERENCES assistant_turns(session_id, turn_id) ON DELETE CASCADE,
  FOREIGN KEY (session_id, supersedes_claim_id) REFERENCES assistant_claims(session_id, claim_id) ON DELETE SET NULL
);

CREATE TABLE assistant_evidence_refs (
  session_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  note_id TEXT NOT NULL,
  note_content_hash TEXT NOT NULL,
  block_ids_json TEXT NOT NULL,
  heading_path_json TEXT NOT NULL,
  line_from INTEGER NOT NULL CHECK (line_from > 0),
  line_to INTEGER NOT NULL CHECK (line_to >= line_from),
  text_hash TEXT NOT NULL,
  preview TEXT NOT NULL,
  source_tool TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'stale')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, evidence_id),
  UNIQUE (session_id, note_content_hash, block_ids_json, line_from, line_to, text_hash),
  FOREIGN KEY (session_id, note_id) REFERENCES assistant_sessions(session_id, note_id) ON DELETE CASCADE
);

CREATE TABLE assistant_turn_evidence (
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  PRIMARY KEY (session_id, turn_id, evidence_id),
  FOREIGN KEY (session_id, turn_id) REFERENCES assistant_turns(session_id, turn_id) ON DELETE CASCADE,
  FOREIGN KEY (session_id, evidence_id) REFERENCES assistant_evidence_refs(session_id, evidence_id) ON DELETE CASCADE
);

CREATE TABLE assistant_claim_evidence (
  session_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  PRIMARY KEY (session_id, claim_id, evidence_id),
  FOREIGN KEY (session_id, claim_id) REFERENCES assistant_claims(session_id, claim_id) ON DELETE CASCADE,
  FOREIGN KEY (session_id, evidence_id) REFERENCES assistant_evidence_refs(session_id, evidence_id) ON DELETE CASCADE
);

CREATE TABLE assistant_memory_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE assistant_section_digests (
  digest_id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES assistant_note_identity(note_id) ON DELETE CASCADE,
  note_content_hash TEXT NOT NULL,
  section_id TEXT NOT NULL,
  section_hash TEXT NOT NULL,
  heading_path_json TEXT NOT NULL,
  line_from INTEGER NOT NULL CHECK (line_from > 0),
  line_to INTEGER NOT NULL CHECK (line_to >= line_from),
  provider_fingerprint TEXT NOT NULL,
  model TEXT NOT NULL,
  digest_version INTEGER NOT NULL,
  scope TEXT NOT NULL DEFAULT 'note-derived' CHECK (scope = 'note-derived'),
  digest_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('complete', 'partial', 'stale')),
  created_at TEXT NOT NULL,
  UNIQUE (note_id, section_hash, provider_fingerprint, model, digest_version)
);

INSERT INTO assistant_note_identity (note_id, relative_path, last_content_hash, state, created_at, updated_at)
VALUES ('note-fixture-1', 'fixture.md', 'hash-fixture-v1', 'active', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z');
INSERT INTO assistant_sessions (session_id, note_id, title, status, last_turn_seq, created_at, updated_at)
VALUES ('session-fixture-1', 'note-fixture-1', '旧会话', 'active', 1, '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z');
INSERT INTO assistant_memory_state (session_id, note_content_hash, memory_version, updated_at)
VALUES ('session-fixture-1', 'hash-fixture-v1', 1, '2026-08-22T00:00:00.000Z');
INSERT INTO assistant_turns (turn_id, session_id, turn_seq, note_content_hash, user_text, route, context_mode, status, provider_fingerprint, model, created_at, finished_at)
VALUES ('turn-fixture-1', 'session-fixture-1', 1, 'hash-fixture-v1', '旧问题', 'current-note-react', 'react-search', 'complete', 'fixture|model', 'model', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:01.000Z');
INSERT INTO assistant_evidence_refs (session_id, evidence_id, note_id, note_content_hash, block_ids_json, heading_path_json, line_from, line_to, text_hash, preview, source_tool, state, created_at)
VALUES ('session-fixture-1', 'evidence-fixture-1', 'note-fixture-1', 'hash-fixture-v1', '["block-1"]', '["标题"]', 1, 1, 'quote-hash-fixture-1', '最小证据预览', 'current-note-react', 'active', '2026-08-22T00:00:01.000Z');
INSERT INTO assistant_turn_evidence (session_id, turn_id, evidence_id)
VALUES ('session-fixture-1', 'turn-fixture-1', 'evidence-fixture-1');

PRAGMA user_version = 2;
