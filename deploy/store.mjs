// A tiny JSON-file store for churches (one record per church). Writes are atomic.
import fs from 'node:fs';
import path from 'node:path';

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,28})[a-z0-9]$/;
export const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
export const slugify = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/g, '');
export const normDomain = (d) => String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '');

/** One record per church. Kept in memory and saved on every change: to a file in `dir`, and (when a database is given) to Neon, so a redeploy that wipes the file loses nothing.
 *  Call `await store.init()` once at start-up: it loads from the database, or seeds the database from the file the first time. */
export function createStore(dir, { db: sql = null, log: say = console.error } = {}) {
	let fileOk = true;
	try { fs.mkdirSync(dir, { recursive: true }); } catch { fileOk = false; }
	const file = path.join(dir, 'churches.json');
	let db = {};
	try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { db = {}; }
	let queue = Promise.resolve();
	const KEY = 'deploy_churches';
	const toDb = () => { if (!sql) return; const snap = JSON.stringify(db); queue = queue.then(() => sql.query('insert into kv (key, value) values ($1, $2::jsonb) on conflict (key) do update set value = excluded.value, updated_at = now()', [KEY, snap])).catch((e) => say('customer board: could not save to the database:', e.message)); };
	const save = () => {
		if (fileOk) { try { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db, null, 2)); fs.renameSync(tmp, file); } catch (e) { fileOk = false; say('customer board: the data folder is not writable:', e.message); } }
		toDb();
	};
	const clone = (o) => JSON.parse(JSON.stringify(o));
	return {
		/** The database is the source of truth once it has a copy; before that, whatever was in the file is copied into it. */
		async init() {
			if (!sql) return { source: 'file', count: Object.keys(db).length };
			const row = (await sql.query('select value from kv where key = $1', [KEY]))[0];
			if (row && row.value && typeof row.value === 'object') { db = row.value; return { source: 'database', count: Object.keys(db).length }; }
			toDb(); await queue; return { source: 'seeded from file', count: Object.keys(db).length };
		},
		flush: () => queue,
		list: () => Object.values(db).map(clone).sort((a, b) => b.created - a.created),
		get: (id) => (db[id] ? clone(db[id]) : null),
		create(input, by = '') {
			const name = String(input.name || '').trim().slice(0, 80);
			if (!name) throw new Error('Enter the church name.');
			const slug = input.slug ? String(input.slug).toLowerCase().trim() : slugify(name);
			if (!SLUG_RE.test(slug)) throw new Error('The short name must be 3 to 30 characters: lowercase letters, numbers and dashes (for example "britannia-united").');
			if (db[slug]) throw new Error('A church with the short name "' + slug + '" already exists.');
			const domain = input.domain ? normDomain(input.domain) : '';
			if (domain && !DOMAIN_RE.test(domain)) throw new Error('That does not look like a website address (for example britanniaunited.ca).');
			const plan = input.plan === 'email' ? 'email' : 'website';
			const kind = input.kind === 'migration' ? 'migration' : 'new';
			const c = {
				id: slug, slug, name, domain, plan, kind, contactEmail: String(input.contactEmail || '').trim().slice(0, 120), notes: String(input.notes || '').slice(0, 2000),
				mailboxes: [], created: Date.now(), createdBy: by, stages: {}, facts: {}, log: [],
			};
			db[slug] = c; save(); return clone(c);
		},
		update(id, fn) {
			if (!db[id]) throw new Error('Church not found.');
			const c = db[id]; fn(c); save(); return clone(c);
		},
		log(id, by, text, level = 'info') {
			if (!db[id]) return;
			db[id].log.push({ at: Date.now(), by: by || '', level, text: String(text).slice(0, 500) });
			if (db[id].log.length > 300) db[id].log.splice(0, db[id].log.length - 300);
			save();
		},
		remove(id) { delete db[id]; save(); },
	};
}
