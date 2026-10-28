// Helpdesk tables. Called from db.js migrate(); takes the db handle to avoid a circular import.
/** Adds a column to a table created by an earlier version. */
function addColumnIfMissing(db, table, column, ddl) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

export function migrateHelpdesk(db) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS hd_cases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_no TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'open',
    category TEXT,
    sub_category TEXT,
    sub_key TEXT,
    details TEXT,
    impact TEXT,
    priority TEXT NOT NULL DEFAULT 'Average',
    priority_reasons TEXT,
    contract_inferred INTEGER NOT NULL DEFAULT 0,
    department TEXT,
    owner_id INTEGER REFERENCES users(id),
    language TEXT DEFAULT 'en',
    subject TEXT,
    customer_name TEXT,
    customer_email TEXT,
    customer_id INTEGER REFERENCES customers(id),
    contract_no TEXT,
    booking_id INTEGER REFERENCES bookings(id),
    amount REAL,
    currency TEXT DEFAULT 'AED',
    fine_ref TEXT,
    card_last4 TEXT,
    location TEXT,
    conversation_id TEXT,
    parent_case_id INTEGER REFERENCES hd_cases(id),
    channel TEXT NOT NULL DEFAULT 'email',
    sensitive INTEGER NOT NULL DEFAULT 0,
    confidence REAL,
    classified_by TEXT,
    matched_terms TEXT,
    ai_summary TEXT,
    needs_review INTEGER NOT NULL DEFAULT 0,
    first_received_at TEXT,
    last_inbound_at TEXT,
    last_outbound_at TEXT,
    due_at TEXT,
    next_followup_at TEXT,
    followup_count INTEGER NOT NULL DEFAULT 0,
    escalation_level INTEGER NOT NULL DEFAULT 0,
    escalated_at TEXT,
    closed_at TEXT,
    closure_reason TEXT,
    closure_note TEXT,
    closed_by INTEGER REFERENCES users(id),
    reopened_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_hd_cases_status ON hd_cases(status);
  CREATE INDEX IF NOT EXISTS idx_hd_cases_conv ON hd_cases(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_hd_cases_contract ON hd_cases(contract_no);
  CREATE INDEX IF NOT EXISTS idx_hd_cases_email ON hd_cases(customer_email);
  CREATE INDEX IF NOT EXISTS idx_hd_cases_owner ON hd_cases(owner_id);
  CREATE INDEX IF NOT EXISTS idx_hd_cases_due ON hd_cases(due_at);
  CREATE INDEX IF NOT EXISTS idx_hd_cases_received ON hd_cases(first_received_at);

  CREATE TABLE IF NOT EXISTS hd_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id INTEGER NOT NULL REFERENCES hd_cases(id) ON DELETE CASCADE,
    provider_id TEXT UNIQUE,
    internet_id TEXT,
    conversation_id TEXT,
    direction TEXT NOT NULL,
    from_name TEXT,
    from_email TEXT,
    to_email TEXT,
    cc TEXT,
    subject TEXT,
    body TEXT,
    attachments TEXT,
    web_link TEXT,
    received_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_hd_messages_case ON hd_messages(case_id);

  CREATE TABLE IF NOT EXISTS hd_drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id INTEGER NOT NULL REFERENCES hd_cases(id) ON DELETE CASCADE,
    reply_to_message_id INTEGER REFERENCES hd_messages(id),
    kind TEXT NOT NULL DEFAULT 'reply',
    template_id INTEGER,
    template_name TEXT,
    language TEXT DEFAULT 'en',
    to_email TEXT,
    subject TEXT,
    body TEXT,
    original_body TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    generated_by TEXT NOT NULL DEFAULT 'template',
    sensitive INTEGER NOT NULL DEFAULT 0,
    incomplete INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    edited INTEGER NOT NULL DEFAULT 0,
    reviewed_by INTEGER REFERENCES users(id),
    reviewed_at TEXT,
    sent_at TEXT,
    provider_draft_id TEXT,
    discard_reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_hd_drafts_case ON hd_drafts(case_id);
  CREATE INDEX IF NOT EXISTS idx_hd_drafts_status ON hd_drafts(status);

  CREATE TABLE IF NOT EXISTS hd_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sub_key TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'initial',
    language TEXT NOT NULL DEFAULT 'en',
    name TEXT NOT NULL,
    subject TEXT,
    body TEXT NOT NULL,
    approved INTEGER NOT NULL DEFAULT 0,
    approved_by INTEGER REFERENCES users(id),
    approved_at TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    note TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_hd_templates_lookup ON hd_templates(sub_key, kind, language);

  CREATE TABLE IF NOT EXISTS hd_keywords (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sub_key TEXT NOT NULL,
    language TEXT NOT NULL DEFAULT 'en',
    term TEXT NOT NULL,
    weight INTEGER NOT NULL DEFAULT 3,
    kind TEXT NOT NULL DEFAULT 'phrase',
    active INTEGER NOT NULL DEFAULT 1,
    source TEXT NOT NULL DEFAULT 'default',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_hd_keywords_sub ON hd_keywords(sub_key);

  CREATE TABLE IF NOT EXISTS hd_routing_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sub_key TEXT NOT NULL,
    department TEXT NOT NULL,
    owner_id INTEGER REFERENCES users(id),
    active INTEGER NOT NULL DEFAULT 1,
    note TEXT
  );

  CREATE TABLE IF NOT EXISTS hd_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id INTEGER REFERENCES hd_cases(id) ON DELETE SET NULL,
    at TEXT NOT NULL DEFAULT (datetime('now')),
    actor_type TEXT NOT NULL DEFAULT 'system',
    actor_id INTEGER,
    actor_name TEXT,
    action TEXT NOT NULL,
    field TEXT,
    old_value TEXT,
    new_value TEXT,
    detail TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_hd_audit_case ON hd_audit(case_id);
  CREATE INDEX IF NOT EXISTS idx_hd_audit_action ON hd_audit(action);
  CREATE INDEX IF NOT EXISTS idx_hd_audit_at ON hd_audit(at);

  CREATE TABLE IF NOT EXISTS hd_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS hd_state (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS hd_contract_financials (
    contract_no TEXT PRIMARY KEY,
    deposit_amount REAL,
    deposit_status TEXT,
    deposit_refund_due TEXT,
    preauth_amount REAL,
    preauth_status TEXT,
    preauth_released_at TEXT,
    card_last4 TEXT
  );

  CREATE TABLE IF NOT EXISTS hd_channel_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    day TEXT NOT NULL,
    channel TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    UNIQUE(day, channel)
  );

  CREATE TABLE IF NOT EXISTS hd_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    generated_at TEXT NOT NULL DEFAULT (datetime('now')),
    title TEXT,
    summary TEXT,
    data TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_hd_reports_period ON hd_reports(kind, period_start);

  CREATE TABLE IF NOT EXISTS hd_demo_inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    processed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS hd_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id INTEGER NOT NULL REFERENCES hd_cases(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id),
    user_name TEXT,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_hd_notes_case ON hd_notes(case_id);

  -- What the customer systems (or the CRM) said about the customer, contract and invoices when the case was opened or last refreshed.
  -- Kept apart from hd_cases so the case list stays light and a failed lookup can be retried without touching the case.
  CREATE TABLE IF NOT EXISTS hd_case_accounts (
    case_id INTEGER PRIMARY KEY REFERENCES hd_cases(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    status TEXT NOT NULL,
    identity TEXT NOT NULL DEFAULT 'none',
    verified_by INTEGER REFERENCES users(id),
    verified_at TEXT,
    verified_key TEXT,
    fetched_at TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_try_at TEXT,
    last_error TEXT,
    json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_hd_case_accounts_retry ON hd_case_accounts(next_try_at);

  CREATE TABLE IF NOT EXISTS hd_test_cases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT,
    body TEXT NOT NULL,
    expected_sub_key TEXT NOT NULL,
    expected_priority TEXT,
    language TEXT,
    source TEXT NOT NULL DEFAULT 'built-in',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS hd_test_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ran_at TEXT NOT NULL DEFAULT (datetime('now')),
    engine TEXT NOT NULL,
    total INTEGER,
    correct INTEGER,
    result TEXT
  );
  `);

  addColumnIfMissing(db, 'hd_cases', 'contract_inferred', 'INTEGER NOT NULL DEFAULT 0');
}
