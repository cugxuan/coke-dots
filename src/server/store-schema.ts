import type { DatabaseSync } from 'node:sqlite';

export function initializeStoreSchema(db: DatabaseSync) {
  db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, issuer TEXT NOT NULL, subject TEXT NOT NULL,
        email TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(issuer, subject)
      );
      CREATE TABLE IF NOT EXISTS tenants (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memberships (
        tenant_id TEXT NOT NULL REFERENCES tenants(id), user_id TEXT NOT NULL REFERENCES users(id),
        role TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(tenant_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS memberships_user ON memberships(user_id, tenant_id);
      CREATE TABLE IF NOT EXISTS workspace_invitations (
        tenant_id TEXT NOT NULL REFERENCES tenants(id), email TEXT NOT NULL COLLATE NOCASE,
        role TEXT NOT NULL CHECK (role IN ('admin','member')), invited_by TEXT NOT NULL REFERENCES users(id),
        invited_at TEXT NOT NULL, expires_at TEXT NOT NULL, PRIMARY KEY(tenant_id,email)
      );
      CREATE INDEX IF NOT EXISTS workspace_invitations_email ON workspace_invitations(email,expires_at);
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
        active_tenant_id TEXT NOT NULL REFERENCES tenants(id), created_at TEXT NOT NULL, expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_flows (
        state_hash TEXT PRIMARY KEY, nonce TEXT NOT NULL, code_verifier TEXT NOT NULL, expires_at TEXT NOT NULL, handoff_hash TEXT, return_to TEXT
      );
      CREATE TABLE IF NOT EXISTS slack_oauth_flows (
        state_hash TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), user_id TEXT NOT NULL REFERENCES users(id),
        expires_at TEXT NOT NULL, return_to TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS slack_installations (
        tenant_id TEXT NOT NULL REFERENCES tenants(id), team_id TEXT NOT NULL, team_name TEXT NOT NULL,
        scopes_json TEXT NOT NULL, installed_at TEXT NOT NULL,
        contact_enabled INTEGER NOT NULL DEFAULT 0 CHECK(contact_enabled IN (0,1)), PRIMARY KEY(tenant_id,team_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS slack_one_contact_per_tenant ON slack_installations(tenant_id) WHERE contact_enabled=1;
      CREATE TABLE IF NOT EXISTS dingtalk_group_selections (
        tenant_id TEXT NOT NULL REFERENCES tenants(id), user_id TEXT NOT NULL REFERENCES users(id),
        conversation_id TEXT NOT NULL, group_name TEXT NOT NULL, corp_id TEXT NOT NULL DEFAULT '', selected_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id,user_id,conversation_id)
      );
      CREATE TABLE IF NOT EXISTS dingtalk_group_monitors (
        tenant_id TEXT NOT NULL REFERENCES tenants(id), user_id TEXT NOT NULL REFERENCES users(id),
        conversation_id TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
        keywords_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id,user_id,conversation_id)
      );
      CREATE TABLE IF NOT EXISTS desktop_handoffs (
        handoff_hash TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), tenant_id TEXT REFERENCES tenants(id), expires_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO tenants(id,name,kind,created_at) VALUES ('legacy','Personal workspace','personal',datetime('now'));
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT 'legacy', title TEXT NOT NULL, instruction TEXT NOT NULL,
        status TEXT NOT NULL, priority INTEGER NOT NULL, next_run_at TEXT,
        schedule_minutes INTEGER, result TEXT, error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        engine TEXT NOT NULL DEFAULT 'model', agent_session_id TEXT, parent_task_id TEXT,
        created_by_user_id TEXT REFERENCES users(id), automation_profile TEXT
      );
      CREATE TABLE IF NOT EXISTS entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL DEFAULT 'legacy', task_id TEXT,
        kind TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, attachment_ids_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS task_attachments (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), uploaded_by TEXT NOT NULL REFERENCES users(id),
        task_id TEXT REFERENCES tasks(id), name TEXT NOT NULL, media_type TEXT NOT NULL, size INTEGER NOT NULL CHECK(size > 0),
        content BLOB NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS voice_calls (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), user_id TEXT NOT NULL REFERENCES users(id),
        started_at TEXT NOT NULL, ended_at TEXT, duration_seconds INTEGER CHECK(duration_seconds IS NULL OR duration_seconds >= 0)
      );
      CREATE INDEX IF NOT EXISTS voice_calls_owner ON voice_calls(tenant_id,user_id,started_at DESC);
      CREATE TABLE IF NOT EXISTS voice_call_turns (
        call_id TEXT NOT NULL REFERENCES voice_calls(id), turn_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL REFERENCES tenants(id), user_id TEXT NOT NULL REFERENCES users(id),
        task_id TEXT NOT NULL REFERENCES tasks(id), created_at TEXT NOT NULL,
        PRIMARY KEY(call_id,turn_id)
      );
      CREATE INDEX IF NOT EXISTS voice_call_turns_owner ON voice_call_turns(tenant_id,user_id,call_id);
      CREATE TABLE IF NOT EXISTS voice_call_messages (
        call_id TEXT NOT NULL REFERENCES voice_calls(id), item_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL REFERENCES tenants(id), user_id TEXT NOT NULL REFERENCES users(id),
        role TEXT NOT NULL CHECK(role IN ('user','assistant')), entry_id INTEGER NOT NULL REFERENCES entries(id),
        PRIMARY KEY(call_id,item_id,role)
      );
      CREATE TABLE IF NOT EXISTS watches (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT 'legacy', url TEXT NOT NULL, interval_minutes INTEGER NOT NULL,
        status TEXT NOT NULL, next_check_at TEXT, last_checked_at TEXT,
        last_hash TEXT, last_status TEXT, error TEXT
      );
      CREATE TABLE IF NOT EXISTS tenant_profiles (
        tenant_id TEXT PRIMARY KEY REFERENCES tenants(id), name TEXT NOT NULL, shape TEXT NOT NULL, color TEXT NOT NULL,
        eyes TEXT NOT NULL DEFAULT 'dot', glasses TEXT NOT NULL DEFAULT 'none', accessory TEXT NOT NULL DEFAULT 'none',
        character TEXT NOT NULL DEFAULT 'ring', pet TEXT NOT NULL DEFAULT 'moss',
        avatar_setup_completed_at TEXT, onboarding_completed_at TEXT, onboarding_completed_name TEXT
      );
      CREATE TABLE IF NOT EXISTS tenant_settings (
        tenant_id TEXT NOT NULL REFERENCES tenants(id), key TEXT NOT NULL, value TEXT NOT NULL,
        PRIMARY KEY(tenant_id,key)
      );
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY, value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tenant_memories (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
        created_by TEXT NOT NULL REFERENCES users(id), note TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tenant_memories_scope ON tenant_memories(tenant_id,created_at DESC);
      CREATE TABLE IF NOT EXISTS dot_memories (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), user_id TEXT NOT NULL REFERENCES users(id),
        note TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS dot_memories_owner ON dot_memories(tenant_id,user_id,updated_at DESC);
      CREATE TABLE IF NOT EXISTS workspace_pages (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
        title TEXT NOT NULL, content TEXT NOT NULL,
        created_by TEXT REFERENCES users(id), source_task_id TEXT REFERENCES tasks(id),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS workspace_pages_scope ON workspace_pages(tenant_id,updated_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS workspace_pages_source_task ON workspace_pages(tenant_id,source_task_id) WHERE source_task_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS tenant_action_rules (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), scope TEXT NOT NULL CHECK (scope='scratchpad-write'),
        instruction TEXT NOT NULL, mode TEXT NOT NULL CHECK (mode IN ('without-asking','when-requested','ask-before','hand-off')),
        created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(tenant_id,scope)
      );
      CREATE TABLE IF NOT EXISTS page_action_approvals (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), task_id TEXT NOT NULL REFERENCES tasks(id),
        action_json TEXT NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending','approved','declined','cancelled')),
        resume_status TEXT NOT NULL CHECK (resume_status IN ('done','scheduled')), next_run_at TEXT,
        created_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT REFERENCES users(id)
      );
      CREATE INDEX IF NOT EXISTS page_action_approvals_task ON page_action_approvals(tenant_id,task_id,created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS page_action_approvals_one_pending ON page_action_approvals(tenant_id,task_id) WHERE status='pending';
    `);

  // Migrate the pre-auth single-user database into a reserved workspace. Its records
  // are claimed only when the first Google account signs in on this local instance.
  addColumnIfMissing('tasks', 'tenant_id', "TEXT NOT NULL DEFAULT 'legacy'");
  addColumnIfMissing('entries', 'tenant_id', "TEXT NOT NULL DEFAULT 'legacy'");
  addColumnIfMissing('entries', 'attachment_ids_json', "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing('watches', 'tenant_id', "TEXT NOT NULL DEFAULT 'legacy'");
  addColumnIfMissing('oauth_flows', 'handoff_hash', 'TEXT');
  addColumnIfMissing('oauth_flows', 'return_to', 'TEXT');
  addColumnIfMissing('tasks', 'engine', "TEXT NOT NULL DEFAULT 'model'");
  addColumnIfMissing('tasks', 'agent_session_id', 'TEXT');
  addColumnIfMissing('tasks', 'schedule_json', 'TEXT');
  addColumnIfMissing('tasks', 'parent_task_id', 'TEXT');
  addColumnIfMissing('tasks', 'created_by_user_id', 'TEXT REFERENCES users(id)');
  addColumnIfMissing('tasks', 'automation_profile', 'TEXT');
  addColumnIfMissing('tasks', 'followup_message', 'TEXT');
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_focus (
      tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, task_id TEXT NOT NULL,
      revision INTEGER NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(tenant_id,user_id)
    );
    CREATE TABLE IF NOT EXISTS chat_message_receipts (
      tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, message_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL, task_id TEXT NOT NULL, routing TEXT NOT NULL,
      reason TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(tenant_id,user_id,message_id)
    );
    CREATE INDEX IF NOT EXISTS tasks_chat_owner ON tasks(tenant_id,created_by_user_id,created_at DESC);
  `);
  addColumnIfMissing('voice_calls', 'request_id', 'TEXT');
  addColumnIfMissing('voice_call_turns', 'source_message_id', 'TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS voice_calls_request ON voice_calls(tenant_id,user_id,request_id)');
  addColumnIfMissing('dingtalk_group_selections', 'corp_id', "TEXT NOT NULL DEFAULT ''");
  const monitorColumns = db.prepare('PRAGMA table_info(dingtalk_group_monitors)').all() as { name: string }[];
  const hadDingtalkMonitorKeywords = monitorColumns.some(column => column.name === 'keywords_json');
  addColumnIfMissing('dingtalk_group_monitors', 'keywords_json', "TEXT NOT NULL DEFAULT '[]'");
  if (!hadDingtalkMonitorKeywords) db.exec("UPDATE dingtalk_group_monitors SET enabled=0 WHERE enabled=1");
  addColumnIfMissing('page_action_approvals', 'decided_by', 'TEXT REFERENCES users(id)');
  addColumnIfMissing('tenant_profiles', 'eyes', "TEXT NOT NULL DEFAULT 'classic'");
  addColumnIfMissing('tenant_profiles', 'glasses', "TEXT NOT NULL DEFAULT 'none'");
  addColumnIfMissing('tenant_profiles', 'accessory', "TEXT NOT NULL DEFAULT 'none'");
  addColumnIfMissing('tenant_profiles', 'character', "TEXT NOT NULL DEFAULT 'custom'");
  addColumnIfMissing('tenant_profiles', 'pet', "TEXT NOT NULL DEFAULT 'moss'");
  addColumnIfMissing('tenant_profiles', 'avatar_setup_completed_at', 'TEXT');
  addColumnIfMissing('tenant_profiles', 'onboarding_completed_at', 'TEXT');
  addColumnIfMissing('tenant_profiles', 'onboarding_completed_name', 'TEXT');
  db.exec('UPDATE tenant_profiles SET avatar_setup_completed_at=onboarding_completed_at WHERE avatar_setup_completed_at IS NULL AND onboarding_completed_at IS NOT NULL');
  db.exec("UPDATE tenant_profiles SET character='custom' WHERE character='classic'");
  ensurePageApprovalCancellationStatus();
  const oldProfile = tableExists('profile');
  if (oldProfile) db.exec("INSERT OR IGNORE INTO tenant_profiles(tenant_id,name,shape,color) SELECT 'legacy',name,shape,color FROM profile WHERE id=1");
  db.exec("INSERT OR IGNORE INTO tenant_profiles(tenant_id,name,shape,color,eyes,character,pet) VALUES ('legacy','Dot','circle','#c8cbd5','dot','ring','moss')");
  if (tableExists('settings')) db.exec("INSERT OR IGNORE INTO tenant_settings(tenant_id,key,value) SELECT 'legacy',key,value FROM settings");
  db.exec(`
      CREATE INDEX IF NOT EXISTS tasks_due ON tasks(status, next_run_at, priority);
      CREATE INDEX IF NOT EXISTS tasks_tenant ON tasks(tenant_id, created_at);
      CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(tenant_id, parent_task_id, created_at);
      CREATE INDEX IF NOT EXISTS entries_task ON entries(tenant_id, task_id, id);
      CREATE INDEX IF NOT EXISTS entries_timeline ON entries(tenant_id, id DESC);
      CREATE INDEX IF NOT EXISTS task_attachments_pending ON task_attachments(tenant_id, uploaded_by, task_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS task_attachments_task ON task_attachments(tenant_id, task_id, created_at);
      CREATE INDEX IF NOT EXISTS watches_due ON watches(status, next_check_at);
      CREATE INDEX IF NOT EXISTS watches_tenant ON watches(tenant_id, status, next_check_at);
      CREATE TABLE IF NOT EXISTS dingtalk_stream_event_receipts (
        tenant_id TEXT NOT NULL REFERENCES tenants(id), provider_message_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL, task_id TEXT NOT NULL, created_at TEXT NOT NULL,
        user_id TEXT REFERENCES users(id), group_name TEXT NOT NULL DEFAULT '',
        PRIMARY KEY(tenant_id,provider_message_id)
      );
      CREATE INDEX IF NOT EXISTS dingtalk_monitors_enabled ON dingtalk_group_monitors(enabled,tenant_id,conversation_id);
    `);
  addColumnIfMissing('dingtalk_stream_event_receipts', 'user_id', 'TEXT REFERENCES users(id)');
  addColumnIfMissing('dingtalk_stream_event_receipts', 'group_name', "TEXT NOT NULL DEFAULT ''");
  db.exec(`UPDATE dingtalk_stream_event_receipts SET user_id=(SELECT created_by_user_id FROM tasks WHERE tasks.tenant_id=dingtalk_stream_event_receipts.tenant_id AND tasks.id=dingtalk_stream_event_receipts.task_id)
      WHERE user_id IS NULL;
      UPDATE dingtalk_stream_event_receipts SET group_name=COALESCE((SELECT group_name FROM dingtalk_group_selections WHERE dingtalk_group_selections.tenant_id=dingtalk_stream_event_receipts.tenant_id AND dingtalk_group_selections.conversation_id=dingtalk_stream_event_receipts.conversation_id AND dingtalk_group_selections.user_id=dingtalk_stream_event_receipts.user_id),'钉钉群')
      WHERE group_name='';`);
  addColumnIfMissing('tasks', 'execution_json', 'TEXT');
  const now = new Date().toISOString();
  db.prepare("UPDATE tasks SET status='queued', next_run_at=?, updated_at=? WHERE status='working'").run(now, now);
  db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(now);
  db.prepare('DELETE FROM oauth_flows WHERE expires_at <= ?').run(now);
  db.prepare('DELETE FROM desktop_handoffs WHERE expires_at <= ?').run(now);

  function tableExists(name: string) {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  }

  function addColumnIfMissing(table: string, name: string, declaration: string) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!columns.some(column => column.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${declaration}`);
  }

  function ensurePageApprovalCancellationStatus() {
    const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='page_action_approvals'").get() as { sql: string } | undefined;
    if (!schema || schema.sql.includes("'cancelled'")) return;
    db.exec(`
      BEGIN IMMEDIATE;
      DROP INDEX IF EXISTS page_action_approvals_task;
      DROP INDEX IF EXISTS page_action_approvals_one_pending;
      ALTER TABLE page_action_approvals RENAME TO page_action_approvals_legacy;
      CREATE TABLE page_action_approvals (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), task_id TEXT NOT NULL REFERENCES tasks(id),
        action_json TEXT NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending','approved','declined','cancelled')),
        resume_status TEXT NOT NULL CHECK (resume_status IN ('done','scheduled')), next_run_at TEXT,
        created_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT REFERENCES users(id)
      );
      INSERT INTO page_action_approvals(id,tenant_id,task_id,action_json,message,status,resume_status,next_run_at,created_at,decided_at,decided_by)
        SELECT id,tenant_id,task_id,action_json,message,status,resume_status,next_run_at,created_at,decided_at,decided_by FROM page_action_approvals_legacy;
      DROP TABLE page_action_approvals_legacy;
      CREATE INDEX page_action_approvals_task ON page_action_approvals(tenant_id,task_id,created_at DESC);
      CREATE UNIQUE INDEX page_action_approvals_one_pending ON page_action_approvals(tenant_id,task_id) WHERE status='pending';
      COMMIT;
    `);
  }
}
