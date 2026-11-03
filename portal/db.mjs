// Postgres (Neon) access. One small interface: query(text, params) -> rows. Tests use PGlite behind the same interface.
import pg from 'pg';

export async function connectDb(url, { max = 5 } = {}) {
	if (url.startsWith('pglite:')) { const { PGlite } = await import('@electric-sql/pglite'); return pgliteDb(new PGlite(url.slice(7) || undefined)); }
	const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
	const pool = new pg.Pool({
		connectionString: url, max, idleTimeoutMillis: 20000, connectionTimeoutMillis: 15000,
		// Neon (and most hosted Postgres) requires TLS with a public certificate.
		ssl: /localhost|127\.0\.0\.1/.test(host) ? false : { rejectUnauthorized: true },
	});
	pool.on('error', (e) => console.error('database pool error:', e.message));
	const db = {
		kind: 'pg',
		query: async (text, params = []) => (await pool.query(text, params)).rows,
		/** Run several statements on one connection inside a transaction. */
		tx: async (fn) => {
			const c = await pool.connect();
			try { await c.query('BEGIN'); const out = await fn({ query: async (t, p = []) => (await c.query(t, p)).rows }); await c.query('COMMIT'); return out; }
			catch (e) { try { await c.query('ROLLBACK'); } catch { /* connection already gone */ } throw e; } finally { c.release(); }
		},
		close: () => pool.end(),
	};
	await db.query('select 1');
	return db;
}

/** Same interface over PGlite (real Postgres compiled to WASM), for tests. */
export function pgliteDb(pglite) {
	return {
		kind: 'pglite',
		query: async (text, params = []) => (await pglite.query(text, params)).rows,
		tx: async (fn) => pglite.transaction(async (t) => fn({ query: async (q, p = []) => (await t.query(q, p)).rows })),
		close: () => pglite.close(),
	};
}

const MIGRATIONS = [
	[1, `
	create table if not exists users (
		id bigserial primary key,
		email text not null unique,
		name text not null default '',
		role text not null default 'staff' check (role in ('admin','staff')),
		password_hash text not null,
		active boolean not null default true,
		must_change boolean not null default false,
		created_at timestamptz not null default now(),
		last_login timestamptz,
		created_by bigint
	);
	create table if not exists sessions (
		token_hash text primary key,
		user_id bigint not null references users(id) on delete cascade,
		created_at timestamptz not null default now(),
		expires_at timestamptz not null,
		last_seen timestamptz not null default now(),
		ip text, ua text
	);
	create index if not exists sessions_user on sessions(user_id);
	create table if not exists audit_log (
		id bigserial primary key,
		at timestamptz not null default now(),
		user_id bigint,
		user_email text not null default '',
		action text not null,
		target text not null default '',
		status int,
		detail jsonb,
		ip text
	);
	create index if not exists audit_at on audit_log(at desc);
	create index if not exists audit_user on audit_log(user_email);
	create index if not exists audit_action on audit_log(action);
	create table if not exists kv (key text primary key, value jsonb not null, updated_at timestamptz not null default now());
	`],
	[2, `
	create table if not exists directory (
		id bigserial primary key,
		source text not null unique,
		name text not null,
		type text not null default 'Congregation',
		address text not null default '',
		address2 text not null default '',
		city text not null default '',
		province text not null default '',
		postal text not null default '',
		phone text not null default '',
		email text not null default '',
		website text not null default '',
		domain text not null default '',
		email_domain text not null default '',
		pastoral_charge text not null default '',
		regional_council text not null default '',
		csv_existing boolean not null default false,
		is_customer boolean not null default false,
		outreach_status text not null default 'new',
		notes text not null default '',
		created_at timestamptz not null default now(),
		updated_at timestamptz not null default now()
	);
	create index if not exists directory_province on directory(province);
	create index if not exists directory_council on directory(regional_council);
	create index if not exists directory_domain on directory(domain);
	create index if not exists directory_edomain on directory(email_domain);
	create index if not exists directory_name on directory(lower(name));
	create table if not exists customer_domains (
		domain text primary key,
		source text not null default 'manual',
		added_at timestamptz not null default now()
	);
	`],
	[3, `
	alter table users add column if not exists totp_secret text;
	alter table users add column if not exists totp_pending text;
	alter table users add column if not exists totp_enabled boolean not null default false;
	alter table users add column if not exists totp_last_step bigint not null default 0;
	alter table users add column if not exists recovery_codes jsonb not null default '[]'::jsonb;
	alter table users add column if not exists failed_count int not null default 0;
	alter table users add column if not exists locked_until timestamptz;
	alter table sessions add column if not exists stage text not null default 'full';
	`],
	[4, `
	create table if not exists outreach_suppress (email text primary key, reason text not null default '', at timestamptz not null default now());
	create table if not exists outreach_log (
		id bigserial primary key, directory_id bigint, email text not null, campaign text not null, sent_by text not null default '',
		ok boolean not null default false, error text not null default '', sent_at timestamptz not null default now()
	);
	create index if not exists outreach_log_email on outreach_log(email, campaign);
	create index if not exists outreach_log_sent on outreach_log(sent_at);
	create table if not exists outreach_events (
		id bigserial primary key, wid text unique, email text not null default '', type text not null, source text not null default '', at timestamptz not null default now()
	);
	create index if not exists outreach_events_at on outreach_events(at);
	`],
	[5, `
	create table if not exists hosted_domains (
		domain text primary key,
		in_cloudflare boolean not null default false, cf_status text not null default '',
		in_duda boolean not null default false, duda_site text not null default '', duda_status text not null default '',
		in_smartermail boolean not null default false,
		in_hostinger boolean not null default false, hostinger_site text not null default '',
		first_seen timestamptz not null default now(), updated_at timestamptz not null default now()
	);
	`],
	[6, `
	create table if not exists support_tickets (
		id bigint primary key, tid text not null default '', subject text not null default '', sender text not null default '', sender_name text not null default '', client_id bigint not null default 0,
		status text not null default '', created timestamptz, last_reply timestamptz, last_by_customer boolean not null default true, messages int not null default 0,
		fp text not null default '', excerpt text not null default '',
		category text not null default '', priority int not null default 3, summary text not null default '', needs_human boolean not null default false, reason text not null default '',
		confidence real not null default 0, has_deadline boolean not null default false, sentiment text not null default '', kb_basis text not null default '', draft text not null default '',
		action text not null default '', state text not null default 'new', handled_by text not null default '', handled_at timestamptz, digest_at timestamptz, error text not null default '', updated_at timestamptz not null default now()
	);
	create index if not exists support_tickets_state on support_tickets(state, priority);
	create table if not exists support_log (id bigserial primary key, at timestamptz not null default now(), ticket_id bigint, action text not null, who text not null default '', detail text not null default '');
	create index if not exists support_log_at on support_log(at desc);
	`],
];

/** Applies any migration not yet applied. Safe to run on every start. */
export async function migrate(db) {
	await db.query('create table if not exists schema_migrations (version int primary key, applied_at timestamptz not null default now())');
	const done = new Set((await db.query('select version from schema_migrations')).map((r) => r.version));
	for (const [v, sql] of MIGRATIONS) {
		if (done.has(v)) continue;
		for (const stmt of sql.split(/;\s*\n/).map((x) => x.trim()).filter(Boolean)) await db.query(stmt);
		await db.query('insert into schema_migrations (version) values ($1)', [v]);
	}
}
export const MIGRATION_COUNT = MIGRATIONS.length;
