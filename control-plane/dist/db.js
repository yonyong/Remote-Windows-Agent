import { DatabaseSync } from 'node:sqlite';
export function openDb(dbPath) {
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL;');
    migrate(db);
    return db;
}
function migrate(db) {
    db.exec(`
    create table if not exists users (
      id text primary key,
      email text not null unique,
      password_hash text not null,
      created_at_ms integer not null
    );

    create table if not exists devices (
      id text primary key,
      owner_user_id text not null,
      name text not null,
      device_token text not null unique,
      created_at_ms integer not null,
      revoked_at_ms integer,
      foreign key(owner_user_id) references users(id)
    );

    create table if not exists pairings (
      pairing_code text primary key,
      agent_socket_id text,
      created_at_ms integer not null,
      claimed_by_user_id text,
      claimed_device_id text,
      claimed_at_ms integer
    );

    create table if not exists commands (
      id text primary key,
      device_id text not null,
      user_id text not null,
      input_text text not null,
      status text not null,
      created_at_ms integer not null,
      started_at_ms integer,
      finished_at_ms integer,
      approved_at_ms integer,
      approved_by_user_id text,
      last_error text,
      last_screenshot_base64 text,
      foreign key(device_id) references devices(id),
      foreign key(user_id) references users(id)
    );

    create table if not exists command_events (
      id text primary key,
      command_id text not null,
      at_ms integer not null,
      level text not null,
      message text not null,
      foreign key(command_id) references commands(id)
    );
  `);
    ensureColumn(db, 'commands', 'approved_at_ms integer');
    ensureColumn(db, 'commands', 'approved_by_user_id text');
    ensureColumn(db, 'commands', 'llm_parse_json text');
    db.exec(`
    create table if not exists device_chat_messages (
      id text primary key,
      user_id text not null,
      device_id text not null,
      role text not null,
      content text not null,
      command_id text,
      kind text not null default 'message',
      created_at_ms integer not null,
      foreign key(user_id) references users(id),
      foreign key(device_id) references devices(id)
    );
    create index if not exists idx_device_chat_device_time on device_chat_messages(device_id, created_at_ms);
  `);
    ensureColumn(db, 'device_chat_messages', 'attachment_base64 text');
    ensureColumn(db, 'device_chat_messages', 'llm_parse_raw text');
    db.exec(`
    create table if not exists user_parse_settings (
      user_id text primary key,
      parse_mode text not null default 'rule',
      llm_provider text not null default 'zhipu',
      llm_api_key text,
      llm_base_url text,
      llm_model text not null default 'glm-4-flash',
      updated_at_ms integer not null,
      foreign key(user_id) references users(id)
    );
  `);
}
function ensureColumn(db, table, columnDef) {
    const colName = columnDef.trim().split(/\s+/)[0];
    const existing = db.prepare(`pragma table_info(${table})`).all();
    if (existing.some((c) => c.name === colName))
        return;
    db.exec(`alter table ${table} add column ${columnDef}`);
}
