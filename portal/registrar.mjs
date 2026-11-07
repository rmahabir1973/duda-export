// The Registrar tab: what is registered through our Ascio account and when it comes up for renewal, so renewals get actioned in the portal
// instead of from Ascio's emails. Reads the hosted_domains table the Domains sync fills; adds a decision per domain and window alerts.
// Only live registrations matter here: deleted, transferred-away and already-expired domains are kept out of the list and the alerts.
const DAY = 86400000;
export const WINDOWS = [60, 30, 14, 7, 1];
/** Ascio statuses that mean the registration is gone (matched case-insensitively as substrings). */
const GONE = ['deleted', 'transferred', 'expired', 'cancel', 'redemption', 'pendingdelete'];
export const DECISIONS = { '': 'No decision yet', renewing: 'Renewing (auto or ordered)', contact: 'Contact the church', expire: 'Let it expire' };
const goneSql = (col = 'ascio_status') => `(${GONE.map((g) => `lower(${col}) like '%${g}%'`).join(' or ')})`;

export function createRegistrar({ db, hosted, store = null, whmcs = null, notify = null, alertTo = [], baseUrl = '', ownDomains = [], previewDomain = 'churchwebglobal.com', now = () => Date.now(), log = console.log }) {
	const own = new Set([previewDomain, ...ownDomains].map((d) => String(d).toLowerCase()));
	const LIVE = `in_ascio and ascio_expires is not null and ascio_expires >= now() and not ${goneSql()}`;
	const toDays = (t) => Math.ceil((new Date(t).getTime() - now()) / DAY);

	/** domain → WHMCS client, from the last WHMCS snapshot (nothing is read from WHMCS live). */
	async function whmcsIndex() {
		if (!whmcs) return new Map();
		const r = (await db.query('select value from kv where key = $1', ['whmcs_snapshot']))[0]; if (!r) return new Map();
		const snap = typeof r.value === 'string' ? JSON.parse(r.value) : r.value;
		const clients = new Map((snap.clients || []).map((c) => [c.id, c])), m = new Map();
		for (const s of snap.services || []) { const d = String(s.domain || '').toLowerCase().replace(/^www\./, ''); if (!d || m.has(d)) continue; const c = clients.get(s.clientid); m.set(d, { client: c ? (c.company || c.name) : 'client ' + s.clientid, email: c?.email || '', product: s.product, service_status: s.status, next_due: s.next }); }
		return m;
	}
	const boardIndex = () => { const m = new Map(); if (!store) return m; for (const c of store.list()) { const d = String(c.domain || '').toLowerCase().replace(/^www\./, ''); if (d && !m.has(d)) m.set(d, { id: c.id, name: c.name, kind: c.kind }); } return m; };

	const self = {
		WINDOWS, DECISIONS,
		/** Live registrations, soonest expiry first. window: days ahead (0 = everything live). decision: '', renewing, contact, expire, any. */
		async list({ q = '', window = 0, decision = 'any', limit = 300, offset = 0 } = {}) {
			const w = [LIVE], p = [];
			if (q) { p.push('%' + String(q).toLowerCase().replace(/[\\%_]/g, '\\$&') + '%'); w.push(`(h.domain like $${p.length} or lower(h.ascio_owner) like $${p.length} or lower(h.ascio_ref) like $${p.length})`); }
			const win = Math.max(0, +window || 0); if (win) { p.push(String(win)); w.push(`h.ascio_expires < now() + ($${p.length} || ' days')::interval`); }
			if (decision !== 'any') { p.push(decision || ''); w.push(`coalesce(a.decision, '') = $${p.length}`); }
			const sql = `from hosted_domains h left join registrar_actions a on a.domain = h.domain where ${w.join(' and ')}`;
			const total = Number((await db.query(`select count(*)::int as n ${sql}`, p))[0].n);
			const lim = Math.min(1000, Math.max(1, +limit || 300)), off = Math.max(0, +offset || 0);
			const rows = await db.query(`select h.domain, h.ascio_expires, h.ascio_status, h.ascio_lock, h.ascio_ns, h.ascio_owner, h.ascio_ref, h.in_cloudflare, h.in_duda, h.duda_site, h.in_smartermail, h.in_hostinger, h.hostinger_site, coalesce(a.decision, '') as decision, coalesce(a.note, '') as note, a.by as decided_by, a.at as decided_at ${sql} order by h.ascio_expires, h.domain limit ${lim} offset ${off}`, p);
			const [wi, bi] = [await whmcsIndex(), boardIndex()];
			return { total, rows: rows.map((r) => ({ ...r, days: toDays(r.ascio_expires), own: own.has(r.domain) || [...own].some((o) => r.domain.endsWith('.' + o)), nameservers: Array.isArray(r.ascio_ns) ? r.ascio_ns : [], whmcs: wi.get(r.domain) || null, board: bi.get(r.domain) || null })) };
		},
		async summary() {
			const c = (await db.query(`select count(*)::int as live, count(*) filter (where ascio_expires < now() + interval '90 days')::int as d90, count(*) filter (where ascio_expires < now() + interval '60 days')::int as d60, count(*) filter (where ascio_expires < now() + interval '30 days')::int as d30, count(*) filter (where ascio_expires < now() + interval '7 days')::int as d7 from hosted_domains where ${LIVE}`))[0];
			const hidden = (await db.query(`select count(*)::int as n from hosted_domains where in_ascio and not (${LIVE})`))[0].n;
			const und = (await db.query(`select count(*)::int as n from hosted_domains h left join registrar_actions a on a.domain = h.domain where ${LIVE} and h.ascio_expires < now() + interval '60 days' and coalesce(a.decision, '') = ''`))[0].n;
			const st = await hosted.status();
			return { ...c, hidden, undecided60: und, ascio: st.sources.ascio || null, configured: !!st.configured.ascio, last_alert: await kv('registrar_last_alert') };
		},
		/** Record what we are doing about a domain. An empty decision clears it. */
		async decide(domain, { decision = '', note = '' } = {}, by = '') {
			const d = String(domain || '').toLowerCase().trim(); if (!d) throw new Error('Which domain?');
			if (!(decision in DECISIONS)) throw new Error('Decision must be one of: ' + Object.keys(DECISIONS).filter(Boolean).join(', '));
			if (!(await db.query('select 1 from hosted_domains where domain = $1 and in_ascio', [d])).length) throw new Error('That domain is not registered through our Ascio account.');
			if (!decision && !note) { await db.query('delete from registrar_actions where domain = $1', [d]); return { domain: d, decision: '', note: '' }; }
			await db.query('insert into registrar_actions (domain, decision, note, by, at) values ($1, $2, $3, $4, now()) on conflict (domain) do update set decision = $2, note = $3, by = $4, at = now()', [d, decision, String(note).slice(0, 500), String(by).slice(0, 120)]);
			return { domain: d, decision, note: String(note).slice(0, 500) };
		},
		/**
		 * Alerts: a domain entering a window (60, 30, 14, 7, 1 days) is reported once per window. One email per run listing everything new,
		 * to the people in alertTo. "Let it expire" decisions are left out. Returns what it found so the caller can log it.
		 */
		async checkAlerts({ send = true } = {}) {
			const rows = await db.query(`select h.domain, h.ascio_expires, h.ascio_status, h.in_cloudflare, h.in_duda, h.in_hostinger, h.in_smartermail, coalesce(a.decision, '') as decision, coalesce(a.note, '') as note from hosted_domains h left join registrar_actions a on a.domain = h.domain where ${LIVE} and h.ascio_expires < now() + interval '${WINDOWS[0]} days' order by h.ascio_expires`);
			const done = new Set((await db.query('select domain, window_days from registrar_alerts')).map((r) => r.domain + '|' + r.window_days));
			const fresh = [];
			for (const r of rows) {
				const days = toDays(r.ascio_expires), win = [...WINDOWS].reverse().find((w) => days <= w && !done.has(r.domain + '|' + w)); // the tightest window not yet reported
				if (win === undefined) continue;
				// mark every wider window as reported too, so a domain first seen at 12 days does not fire 60, 30 and 14 one after another
				for (const w of WINDOWS) if (days <= w && !done.has(r.domain + '|' + w)) { await db.query('insert into registrar_alerts (domain, window_days, expires, at) values ($1, $2, $3, now()) on conflict (domain, window_days) do nothing', [r.domain, w, r.ascio_expires]); done.add(r.domain + '|' + w); }
				if (r.decision !== 'expire') fresh.push({ ...r, days, window: win });
			}
			// a renewed domain (expiry moved out) gets a clean slate, so next year's windows fire again
			await db.query(`delete from registrar_alerts al using hosted_domains h where h.domain = al.domain and h.ascio_expires > al.expires + interval '30 days'`);
			let sent = false;
			if (fresh.length && send && notify && alertTo.length) {
				const line = (r) => `${r.domain} — ${r.days <= 0 ? 'expires today' : 'expires in ' + r.days + ' day' + (r.days === 1 ? '' : 's')} (${new Date(r.ascio_expires).toISOString().slice(0, 10)})${r.decision ? ' · ' + DECISIONS[r.decision] : ' · no decision yet'}${r.note ? ' · ' + r.note : ''}\n   DNS ${r.in_cloudflare ? 'in Cloudflare' : 'elsewhere'}${r.in_duda ? ' · site on DUDA' : r.in_hostinger ? ' · site on Hostinger' : ' · no site with us'}${r.in_smartermail ? ' · email with us' : ''}`;
				const soon = fresh.filter((r) => r.days <= 7), rest = fresh.filter((r) => r.days > 7);
				const text = `${fresh.length} domain${fresh.length === 1 ? '' : 's'} registered through Ascio ${fresh.length === 1 ? 'is' : 'are'} coming up for renewal.\n\n${soon.length ? 'WITHIN 7 DAYS\n' + soon.map(line).join('\n') + '\n\n' : ''}${rest.length ? (soon.length ? 'COMING UP\n' : '') + rest.map(line).join('\n') + '\n\n' : ''}Decide what to do with each one on the Registrar tab:\n${baseUrl}/registrar\n\nYou get one email per domain per window (60, 30, 14, 7 and 1 days), not a daily reminder.`;
				try { await notify({ to: alertTo, subject: `Domain renewals: ${soon.length ? soon.length + ' within 7 days, ' : ''}${fresh.length} to decide`, text }); sent = true; }
				catch (e) { log('registrar: could not send the renewal alert:', e.message); }
			}
			await putKv('registrar_last_alert', { at: new Date(now()).toISOString(), found: fresh.length, sent, domains: fresh.slice(0, 50).map((r) => r.domain) });
			return { found: fresh.length, sent, domains: fresh.map((r) => ({ domain: r.domain, days: r.days, window: r.window })) };
		},
	};
	const kv = async (k) => { const r = (await db.query('select value from kv where key = $1', [k]))[0]; return r ? (typeof r.value === 'string' ? JSON.parse(r.value) : r.value) : null; };
	const putKv = (k, v) => db.query('insert into kv (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value, updated_at = now()', [k, JSON.stringify(v)]);
	return self;
}
