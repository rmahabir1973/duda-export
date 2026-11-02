// A tiny JSON-file store for churches (one record per church). Writes are atomic.
import fs from 'node:fs';
import path from 'node:path';

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,28})[a-z0-9]$/;
export const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
export const slugify = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/g, '');
export const normDomain = (d) => String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '');

export function createStore(dir) {
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, 'churches.json');
	let db = {};
	try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { db = {}; }
	const save = () => { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db, null, 2)); fs.renameSync(tmp, file); };
	const clone = (o) => JSON.parse(JSON.stringify(o));
	return {
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
