// "What do we host?": pulls domain names from Cloudflare, DUDA, SmarterMail, Hostinger and Ascio (the registrar) into one table, so the portal (and the assistant) can answer it.
// Each source reports its own result; a source that fails never wipes what the others found.
const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
import { SLUG_RE } from '../deploy/store.mjs';
export const normHost = (d) => String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#:].*$/, '').replace(/^www\./, '').replace(/\.$/, '');
const apex = (d) => d; // Cloudflare zones and DUDA custom domains are already registrable names; subdomains stay as they are

/** A tiny client for the DUDA MCP server (the same account token the exporter uses). */
export function makeDudaMcp({ token, url = 'https://mcp.duda.co/mcp', fetchImpl = globalThis.fetch }) {
	let session = null, auth = null, id = 0, ready = false;
	const post = async (body) => {
		for (const a of auth ? [auth] : [token, 'Bearer ' + token]) {
			const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: a, ...(session ? { 'mcp-session-id': session } : {}) };
			const r = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body) });
			if (r.status === 401 || r.status === 403) continue;
			auth = a; session = r.headers.get('mcp-session-id') || session;
			const text = await r.text(); if (!r.ok && r.status !== 202) throw new Error('DUDA MCP HTTP ' + r.status); if (!text.trim()) return null;
			let msgs = [];
			if (/event-stream/.test(r.headers.get('content-type') || '')) for (const ev of text.split(/\n\n+/)) { const data = ev.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join(''); if (data) try { msgs.push(JSON.parse(data)); } catch { /* skip */ } }
			else { const j = JSON.parse(text); msgs = Array.isArray(j) ? j : [j]; }
			return msgs.find((m) => m.id === body.id) || msgs[0] || null;
		}
		throw new Error('DUDA rejected the token (DUDA_MCP_TOKEN).');
	};
	const init = async () => { if (ready) return; await post({ jsonrpc: '2.0', id: ++id, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'churchweb-portal', version: '1' } } }); await post({ jsonrpc: '2.0', method: 'notifications/initialized' }); ready = true; };
	return {
		available: () => !!token,
		async call(name, args) {
			await init();
			const m = await post({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } });
			if (m?.error) throw new Error('DUDA: ' + (m.error.message || 'error'));
			const text = (m?.result?.content || []).map((c) => c.text || '').join('\n');
			if (m?.result?.isError) throw new Error('DUDA: ' + text.slice(0, 200));
			return text;
		},
	};
}

export function createHosted({ db, clients, duda, dir, ownDomains = [], previewDomain = 'churchwebglobal.com', log = console.log }) {
	const own = new Set([previewDomain, ...ownDomains].map(normHost));
	const isOwn = (d) => [...own].some((o) => d === o || d.endsWith('.' + o));
	let running = false;

	const sources = {
		async cloudflare() { if (!clients.cloudflare.available()) throw new Error('Cloudflare is not set up (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID).'); const z = await clients.cloudflare.zones(); return z.map((x) => ({ domain: x.name, cf_status: x.status })); },
		async duda() {
			if (!duda.available()) throw new Error('DUDA is not set up (DUDA_MCP_TOKEN).');
			const sites = [];
			for (let offset = 0; offset < 3000; offset += 100) {
				const j = JSON.parse(await duda.call('list_sites', { limit: 100, offset }));
				sites.push(...(j.results || [])); if (!j.has_more) break;
			}
			const out = [], published = sites.filter((s) => s.publish_status === 'PUBLISHED');
			let i = 0, failed = 0;
			await Promise.all(Array.from({ length: 4 }, async () => { while (i < published.length) { const s = published[i++]; try { const t = await duda.call('get_site_details', { site_name: s.site_name }); const m = /"site_domain"\s*:\s*"([^"]+)"/.exec(t); const d = normHost(m ? m[1] : ''); if (d && d.includes('.') && !d.endsWith('multiscreensite.com')) out.push({ domain: d, duda_site: s.site_name, duda_status: 'published' }); } catch { failed++; } } }));
			if (failed && !out.length) throw new Error(`Could not read any of ${published.length} DUDA sites.`);
			return { rows: out, note: `${sites.length} DUDA sites, ${published.length} published${failed ? `, ${failed} could not be read` : ''}` };
		},
		async smartermail() { const sm = clients.smartermail; if (!sm.available()) throw new Error('SmarterMail is not set up (SMARTERMAIL_URL and admin login).'); const r = await sm.domains(await sm.sysLogin()); if (!r.ok) throw new Error(r.error); return r.domains.map((d) => ({ domain: d })); },
		async hostinger() {
			if (!clients.hostinger.available()) throw new Error('Hostinger is not set up (HOSTINGER_API_KEY).');
			const sites = await clients.hostinger.websites(), out = [];
			for (const w of sites) { const d = normHost(w.domain || w.name); if (d) out.push({ domain: d, hostinger_site: d }); }
			let i = 0;
			await Promise.all(Array.from({ length: 4 }, async () => { while (i < sites.length) { const w = sites[i++]; if (!w.username || !(w.domain || w.name)) continue; try { for (const p of await clients.hostinger.parkedDomains(w.username, w.domain || w.name)) { const d = normHost(typeof p === 'string' ? p : p.domain || p.parked_domain || p.name); if (d) out.push({ domain: d, hostinger_site: normHost(w.domain || w.name) }); } } catch { /* parked domains are a bonus */ } } }));
			return out;
		},
		/** The registrar: every domain registered through our Ascio account, with expiry, status, lock and nameservers. */
		async ascio() {
			const a = clients.ascio; if (!a?.available()) throw new Error('Ascio is not set up (ASCIO_ACCOUNT, ASCIO_PASSWORD; whitelist this server\'s IPs in the Ascio portal).');
			const r = await a.allDomains();
			const rows = r.domains.filter((d) => d.domain).map((d) => ({ domain: d.domain, ascio_handle: d.handle, ascio_status: d.status, ascio_expires: d.expires, ascio_created: d.created, ascio_lock: d.transfer_lock, ascio_ns: JSON.stringify(d.nameservers), ascio_owner: d.owner_org || d.owner_name, ascio_ref: d.customer_ref }));
			return { rows, note: `${r.total} registered${rows.length !== r.total ? `, ${rows.length} read` : ''}` };
		},
	};
	const COLS = { cloudflare: 'in_cloudflare', duda: 'in_duda', smartermail: 'in_smartermail', hostinger: 'in_hostinger', ascio: 'in_ascio' };
	const EXTRA = { cloudflare: ['cf_status'], duda: ['duda_site', 'duda_status'], hostinger: ['hostinger_site'], ascio: ['ascio_handle', 'ascio_status', 'ascio_expires', 'ascio_created', 'ascio_lock', 'ascio_ns', 'ascio_owner', 'ascio_ref'] };

	const self = {
		sources: Object.keys(sources),
		isOwn,
		ascio: clients.ascio || null,
		async status() {
			const rows = await db.query("select key, value from kv where key like 'hosted_sync_%'");
			const s = {}; for (const r of rows) s[r.key.replace('hosted_sync_', '')] = (typeof r.value === 'string' && /^[\[{"]/.test(r.value) ? JSON.parse(r.value) : r.value);
			return { running, sources: s, configured: { cloudflare: clients.cloudflare.available(), duda: duda.available(), smartermail: clients.smartermail.available(), hostinger: clients.hostinger.available(), ascio: !!clients.ascio?.available() } };
		},
		/** Reads every source, updates the table, and refreshes the "customer domains" the directory matches against. */
		async sync() {
			if (running) throw new Error('A sync is already running.');
			running = true;
			try {
				const results = {};
				await Promise.all(Object.keys(sources).map(async (name) => {
					const at = new Date().toISOString();
					try {
						const got = await sources[name](), rows = (Array.isArray(got) ? got : got.rows).map((r) => ({ ...r, domain: apex(normHost(r.domain)) })).filter((r) => DOMAIN_RE.test(r.domain));
						const col = COLS[name];
						await db.query(`update hosted_domains set ${col} = false, updated_at = now() where ${col}`);
						for (const r of rows) {
							const sets = { [col]: true }; for (const k of EXTRA[name] || []) sets[k] = r[k] ?? (k.endsWith('_expires') || k.endsWith('_created') ? null : k === 'ascio_ns' ? '[]' : '');
							const keys = Object.keys(sets);
							await db.query(`insert into hosted_domains (domain, ${keys.join(', ')}) values ($1, ${keys.map((_, i) => '$' + (i + 2)).join(', ')}) on conflict (domain) do update set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now()`, [r.domain, ...keys.map((k) => sets[k])]);
						}
						if (name === 'duda') await db.query("update hosted_domains set duda_site = '', duda_status = '' where not in_duda");
						results[name] = { ok: true, at, count: new Set(rows.map((r) => r.domain)).size, note: got.note || '' };
					} catch (e) { results[name] = { ok: false, at, error: String(e.message).slice(0, 300) }; log(`hosted sync: ${name} failed: ${e.message}`); }
					await db.query("insert into kv (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value, updated_at = now()", ['hosted_sync_' + name, JSON.stringify(results[name])]);
				}));
				await db.query('delete from hosted_domains where not (in_cloudflare or in_duda or in_smartermail or in_hostinger or in_ascio)');
				await self.feedDirectory();
				return results;
			} finally { running = false; }
		},
		/** Everything we host that is not our own infrastructure counts as a customer domain for the directory match. */
		async feedDirectory() {
			const rows = await db.query('select domain from hosted_domains where in_cloudflare or in_duda or in_smartermail or in_ascio');
			const list = rows.map((r) => r.domain).filter((d) => !isOwn(d));
			await db.query("delete from customer_domains where source = 'sync'");
			for (const d of list) await db.query("insert into customer_domains (domain, source) values ($1, 'sync') on conflict (domain) do nothing", [d]);
			await dir.rematch();
			return list.length;
		},
		async list({ q = '', gap = '', limit = 200, offset = 0 } = {}) {
			const w = [], p = [];
			if (q) { p.push('%' + String(q).toLowerCase().replace(/[\\%_]/g, '\\$&') + '%'); w.push(`domain like $${p.length}`); }
			const expiryViews = new Set(['expiring', 'expired', 'ascio']);
			if (!expiryViews.has(gap)) for (const o of own) { p.push(o); w.push(`domain <> $${p.length}`); p.push('%.' + o); w.push(`domain not like $${p.length}`); } // our own infrastructure is not a customer (but its renewals still matter, so the registrar views keep it)
			const g = { 'duda-not-cloudflare': 'in_duda and not in_cloudflare', 'cloudflare-not-duda': 'in_cloudflare and not in_duda', 'mail-not-cloudflare': 'in_smartermail and not in_cloudflare', 'not-in-cloudflare': 'not in_cloudflare', 'no-mail': 'not in_smartermail', 'duda': 'in_duda', 'cloudflare': 'in_cloudflare', 'smartermail': 'in_smartermail', 'hostinger': 'in_hostinger',
				'ascio': 'in_ascio', 'ascio-not-cloudflare': 'in_ascio and not in_cloudflare', 'cloudflare-not-ascio': 'in_cloudflare and not in_ascio', 'expiring': `in_ascio and ascio_expires is not null and ascio_expires < now() + interval '60 days'`, 'expired': 'in_ascio and ascio_expires is not null and ascio_expires < now()', 'ascio-ns-elsewhere': `in_ascio and in_cloudflare and not (ascio_ns::text ilike '%cloudflare%')` }[gap];
			if (g) w.push(g);
			const sql = w.length ? 'where ' + w.join(' and ') : '';
			const total = Number((await db.query(`select count(*)::int as n from hosted_domains ${sql}`, p))[0].n);
			const lim = Math.min(500, Math.max(1, +limit || 200)), off = Math.max(0, +offset || 0);
			const order = expiryViews.has(gap) ? 'ascio_expires nulls last, domain' : 'domain';
			const rows = await db.query(`select domain, in_cloudflare, cf_status, in_duda, duda_site, in_smartermail, in_hostinger, hostinger_site, in_ascio, ascio_status, ascio_expires, ascio_lock, ascio_ns, ascio_owner, ascio_ref from hosted_domains ${sql} order by ${order} limit ${lim} offset ${off}`, p);
			return { total, rows };
		},
		/** Sites we built on Hostinger (slug.<preview domain>) that are not on the Customers board, with the real domain parked on them when the sync knows it. */
		async boardCandidates(store, { templateSlug = 'build2' } = {}) {
			const suffix = '.' + previewDomain, by = new Map();
			for (const r of await db.query('select domain, hostinger_site, in_duda from hosted_domains where in_hostinger')) {
				const host = r.hostinger_site; if (!host || !host.endsWith(suffix)) continue;
				const slug = host.slice(0, -suffix.length); if (slug.includes('.') || /^build\d*$/.test(slug) || slug === templateSlug) continue;
				const e = by.get(slug) || { slug, host, domains: [], duda: false };
				if (r.domain !== host) { e.domains.push(r.domain); if (r.in_duda) e.duda = true; }
				by.set(slug, e);
			}
			const title = (s) => s.split('-').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
			return [...by.values()].filter((c) => SLUG_RE.test(c.slug) && !store.get(c.slug)).sort((a, b) => a.slug.localeCompare(b.slug)).map((c) => ({ ...c, name: title(c.slug), domain: c.domains.sort((a, b) => a.length - b.length)[0] || '', kind: c.duda ? 'migration' : 'new' }));
		},
		async boardImport(store, slugs, by = '') {
			const want = new Set(slugs || []), created = [], skipped = [];
			for (const c of (await self.boardCandidates(store)).filter((x) => want.has(x.slug))) {
				const base = { name: c.name, slug: c.slug, kind: c.kind, notes: 'Added from the Hostinger site list. Check the name, the domain and the type under Customer details.' };
				try { created.push(store.create({ ...base, domain: c.domain }, by)); }
				catch (e) { try { created.push(store.create({ ...base, domain: '' }, by)); } catch (e2) { skipped.push({ slug: c.slug, error: e2.message }); } }
			}
			return { created: created.map((c) => ({ slug: c.slug, name: c.name, domain: c.domain, kind: c.kind })), skipped };
		},
		async counts() { const r = (await db.query("select count(*)::int as total, count(*) filter (where in_cloudflare)::int as cloudflare, count(*) filter (where in_duda)::int as duda, count(*) filter (where in_smartermail)::int as smartermail, count(*) filter (where in_hostinger)::int as hostinger, count(*) filter (where in_ascio)::int as ascio, count(*) filter (where in_ascio and ascio_expires < now() + interval '60 days')::int as expiring from hosted_domains"))[0]; return r; },
		/** Domains registered through us that come up for renewal soon (our own included), soonest first. */
		async expiring({ days = 60, limit = 50 } = {}) { return db.query(`select domain, ascio_expires, ascio_status, ascio_lock, in_cloudflare, in_duda, in_hostinger from hosted_domains where in_ascio and ascio_expires is not null and ascio_expires < now() + ($1 || ' days')::interval order by ascio_expires limit $2`, [String(Math.max(1, +days || 60)), Math.min(500, +limit || 50)]); },
		/** Everything we know about one domain: where it is hosted, whether it is on the board, and its directory listing. */
		async lookup(domainInput, store) {
			const d = normHost(domainInput); if (!DOMAIN_RE.test(d)) throw new Error('That is not a domain name.');
			const h = (await db.query('select * from hosted_domains where domain = $1', [d]))[0] || null;
			const board = store ? store.list().filter((c) => normHost(c.domain) === d).map((c) => ({ id: c.id, name: c.name, type: c.kind === 'migration' ? 'DUDA migration' : 'new site' })) : [];
			const listings = await db.query("select id, name, city, province, is_customer, outreach_status from directory where domain = $1 or email_domain = $1 order by id limit 5", [d]);
			const reg = h?.in_ascio ? { registrar: 'Ascio (our account)', expires: h.ascio_expires, status: h.ascio_status, transfer_lock: h.ascio_lock, nameservers: Array.isArray(h.ascio_ns) ? h.ascio_ns : [], owner: h.ascio_owner, customer_ref: h.ascio_ref } : { registrar: 'not registered through our Ascio account' };
			return { domain: d, hosted: h && { cloudflare: h.in_cloudflare ? 'yes (' + (h.cf_status || 'zone') + ')' : 'no', duda: h.in_duda ? 'yes (site ' + h.duda_site + ')' : 'no', smartermail: h.in_smartermail ? 'yes' : 'no', hostinger: h.in_hostinger ? 'yes (' + h.hostinger_site + ')' : 'no', ascio: h.in_ascio ? 'yes (expires ' + (h.ascio_expires ? new Date(h.ascio_expires).toISOString().slice(0, 10) : 'unknown') + ')' : 'no' }, registration: h ? reg : null, on_customers_board: board, directory_listings: listings, note: h ? '' : 'Not found in the last sync of Cloudflare, DUDA, SmarterMail, Hostinger or Ascio. Check the sync status: a source that failed or has not run can hide it.' };
		},
	};
	return self;
}
