// A read-only look at WHMCS: who pays how, so billing can be planned from facts (how many customers pay by cheque?).
// Nothing here can change WHMCS: only the actions in READ_ACTIONS can be called, and the sync stores a snapshot in Neon.
import { csvLine } from './directory.mjs';

export const READ_ACTIONS = new Set(['GetClients', 'GetClientsProducts', 'GetInvoices', 'GetPaymentMethods', 'GetTickets', 'GetTicket']);
/** The support login may also answer, close and flag tickets, and nothing else. It is a different WHMCS API credential from the billing one, which can never write. */
export const SUPPORT_ACTIONS = new Set(['GetTickets', 'GetTicket', 'AddTicketReply', 'UpdateTicket']);
export const CYCLE_MONTHS = { monthly: 1, quarterly: 3, 'semi-annually': 6, annually: 12, biennially: 24, triennially: 36 };
export const CATEGORIES = { card: 'Card / PayPal', cheque: 'Cheque / mail-in', bank: 'Bank transfer / e-transfer / PAD', other: 'Other', none: 'No payment method set' };
export const CATEGORY_KEYS = Object.keys(CATEGORIES);

/** Our best guess at what kind of payment a WHMCS gateway is, from its module name and display name. The admin can override it in the tab. */
export function guessCategory(module, name = '') {
	if (!module) return 'none';
	const s = `${module} ${name}`.toLowerCase();
	if (/\b(cheques?|checks?|money[\s-]?orders?|mail[\s-]?in|mailin)\b/.test(s)) return 'cheque';
	if (/stripe|paypal|authorize|braintree|square|credit|debit card|\bcards?\b/.test(s)) return 'card';
	if (/bank|wire|transfer|interac|\beft\b|\bpad\b|direct[\s-]?debit|\bach\b/.test(s)) return 'bank';
	return 'other';
}

const friendly = (m) => {
	const t = String(m || '').slice(0, 200);
	if (/invalid ip/i.test(t)) return 'WHMCS refused this server\'s IP address. Add it under WHMCS Settings > Security > API IP Access Restriction, or set WHMCS_ACCESS_KEY (the $api_access_key from configuration.php).';
	if (/authentication failed|invalid.*identifier/i.test(t)) return 'WHMCS rejected the API identifier or secret (WHMCS_API_IDENTIFIER / WHMCS_API_SECRET).';
	if (/not allowed|access denied|permission/i.test(t)) return 'The WHMCS API role is missing a permission this tab needs: ' + t;
	return 'WHMCS said: ' + t;
};

/** A small, read-only WHMCS API client. The secret only ever goes in the request body, never in a URL, a log line or an error. */
export function makeWhmcsClient({ url, identifier, secret, accessKey = '', fetchImpl = globalThis.fetch, actions = READ_ACTIONS }) {
	const base = String(url || '').trim().replace(/\/+$/, '').replace(/\/includes\/api\.php$/i, '');
	const host = (() => { try { return new URL(base).hostname; } catch { return ''; } })();
	const local = host === 'localhost' || host === '127.0.0.1';
	const self = {
		available: () => !!(base && identifier && secret),
		/** Which of the three settings are empty (never their values). */
		missing: () => [!base && 'url', !identifier && 'id', !secret && 'secret'].filter(Boolean),
		async call(action, params = {}) {
			if (!actions.has(action)) throw new Error(actions === READ_ACTIONS ? `The portal only reads from WHMCS; "${action}" is not allowed.` : `This WHMCS login may only use ${[...actions].join(', ')}; "${action}" is not allowed.`);
			if (!self.available()) throw new Error('WHMCS is not set up (WHMCS_URL, WHMCS_API_IDENTIFIER, WHMCS_API_SECRET).');
			if (!/^https:\/\//i.test(base) && !local) throw new Error('WHMCS_URL must start with https:// so the API login is not sent in the clear.');
			const body = new URLSearchParams({ identifier, secret, action, responsetype: 'json', ...(accessKey ? { accesskey: accessKey } : {}), ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) });
			let r;
			try { r = await fetchImpl(base + '/includes/api.php', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, redirect: 'error', signal: AbortSignal.timeout(30000) }); }
			catch (e) { throw new Error('Could not reach WHMCS: ' + String(e.cause?.code || e.message).slice(0, 120)); }
			const text = await r.text();
			let j; try { j = JSON.parse(text); } catch { throw new Error(`WHMCS did not answer with JSON (HTTP ${r.status}). Check WHMCS_URL.`); }
			if (j.result === 'error') throw new Error(friendly(j.message));
			return j;
		},
		/** Every row of a list action, page by page. WHMCS cannot return a page if one record has text it cannot encode ("Malformed UTF-8"):
		 *  then the page is split in halves until the bad record is alone, that one is skipped and noted in options.skipped, and the rest is read. */
		async all(action, listKey, itemKey, params = {}, { pageSize = 250, maxPages = 400, skipped = [], label = action } = {}) {
			const BAD = /malformed utf-?8|json encoded response/i;
			const read = async (start, size, prev = null) => {
				let j;
				try { j = await self.call(action, { ...params, limitstart: start, limitnum: size }); }
				catch (e) {
					if (!BAD.test(e.message)) throw e;
					if (size <= 1) return { rows: [], skips: [{ what: label, offset: start, afterId: prev }], total: undefined };
					const half = Math.ceil(size / 2), a = await read(start, half, prev), b = await read(start + a.rows.length + a.skips.length, size - half, a.rows.length ? a.rows.at(-1).id : prev);
					return { rows: [...a.rows, ...b.rows], skips: [...a.skips, ...b.skips], total: a.total ?? b.total };
				}
				const box = j[listKey], items = Array.isArray(box) ? box : box?.[itemKey] ?? [];
				return { rows: Array.isArray(items) ? items : [items], skips: [], total: Number(j.totalresults) || undefined };
			};
			const out = []; let start = 0, total;
			for (let page = 0; page < maxPages; page++) {
				const g = await read(start, pageSize, out.at(-1)?.id ?? null); total ??= g.total;
				skipped.push(...g.skips);
				out.push(...g.rows); const covered = g.rows.length + g.skips.length; start += covered;
				if (!covered || (total ? start >= total : g.rows.length < pageSize)) break;
			}
			return out;
		},
	};
	return self;
}

const str = (v, n = 200) => String(v ?? '').slice(0, n);
const num = (v) => { const x = parseFloat(v); return Number.isFinite(x) ? x : 0; };
const day = (v) => { const s = str(v, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) && s !== '0000-00-00' ? s : ''; };

/** Skipped records, grouped: "3 services between service ID 14 and 18". IDs are looked up from the rows that were read, so the person knows where in WHMCS to look. */
export function groupSkips(skips, lists) {
	const by = new Map();
	for (const x of skips) {
		const key = `${x.what}|${x.afterId}`, list = lists[x.what] || [], i = x.afterId == null ? -1 : list.findIndex((r) => String(r.id) === String(x.afterId));
		const g = by.get(key) || { what: x.what, afterId: x.afterId, beforeId: list[i + 1]?.id ?? null, count: 0 }; g.count++; by.set(key, g);
	}
	return [...by.values()];
}

/** Reads what the planning needs from WHMCS and returns a compact snapshot (customers, services, invoices, gateways). */
export async function readSnapshot(whmcs, { now = new Date() } = {}) {
	const gw = await whmcs.call('GetPaymentMethods');
	const gwBox = gw.paymentmethods?.paymentmethod ?? gw.paymentmethods ?? [];
	const gateways = (Array.isArray(gwBox) ? gwBox : [gwBox]).filter((g) => g && g.module).map((g) => ({ module: str(g.module, 60), name: str(g.displayname || g.module, 80) }));
	const skipped = [];
	const [clients, services, invoices] = await Promise.all([whmcs.all('GetClients', 'clients', 'client', {}, { skipped, label: 'customer' }), whmcs.all('GetClientsProducts', 'products', 'product', {}, { skipped, label: 'service' }), whmcs.all('GetInvoices', 'invoices', 'invoice', {}, { skipped, label: 'invoice' })]);
	const cutoff = new Date(now.getTime() - 800 * 86400000).toISOString().slice(0, 10); // about 26 months: enough for "last 12 months" and a year before
	return {
		at: now.toISOString(), skipped: groupSkips(skipped, { customer: clients, service: services, invoice: invoices }),
		gateways,
		clients: clients.map((c) => ({ id: Number(c.id), name: str(`${c.firstname || ''} ${c.lastname || ''}`.trim(), 120), company: str(c.companyname, 120), email: str(c.email, 120), status: str(c.status, 20) })),
		services: services.map((s) => ({ id: Number(s.id), clientid: Number(s.clientid), product: str(s.name || s.productname, 120), group: str(s.groupname, 80), status: str(s.status, 20), cycle: str(s.billingcycle, 30), next: day(s.nextduedate), amount: num(s.recurringamount ?? s.amount), module: str(s.paymentmethod, 60), domain: str(s.domain, 120) })),
		invoices: invoices.map((i) => ({ id: Number(i.id), clientid: Number(i.userid), status: str(i.status, 20), module: str(i.paymentmethod, 60), total: num(i.total), cur: str(i.currencycode, 6), date: day(i.date), due: day(i.duedate), paid: day(String(i.datepaid || '').slice(0, 10)) })).filter((i) => i.date >= cutoff || !['Paid', 'Cancelled', 'Refunded'].includes(i.status)),
	};
}

const isActive = (s) => String(s.status).toLowerCase() === 'active';
const annualOf = (s) => { const m = CYCLE_MONTHS[String(s.cycle).toLowerCase()]; return m ? s.amount * 12 / m : 0; };
const addTo = (obj, cur, v) => { obj[cur] = Math.round(((obj[cur] || 0) + v) * 100) / 100; };

/** Turns a snapshot plus the admin's gateway overrides into the numbers the tab shows. Recomputed on every read, so changing a mapping needs no new sync. */
export function summarize(snap, overrides = {}, { now = new Date() } = {}) {
	if (!snap) return null;
	const names = new Map(snap.gateways.map((g) => [g.module, g.name]));
	for (const s of snap.services) if (s.module && !names.has(s.module)) names.set(s.module, s.module);
	for (const i of snap.invoices) if (i.module && !names.has(i.module)) names.set(i.module, i.module);
	const catOf = (module) => (CATEGORIES[overrides[module]] && module ? overrides[module] : guessCategory(module, names.get(module)));
	const curOf = new Map(); for (const i of [...snap.invoices].sort((a, b) => (a.date < b.date ? -1 : 1))) if (i.cur) curOf.set(i.clientid, i.cur);
	const clients = new Map(snap.clients.map((c) => [c.id, c]));
	const today = now.toISOString().slice(0, 10), yearAgo = new Date(now.getTime() - 365 * 86400000).toISOString().slice(0, 10);

	const gateways = [...names.keys()].map((module) => ({ module, name: names.get(module), category: catOf(module), overridden: !!overrides[module], services: 0, clients: new Set(), annual: {} }));
	const gw = new Map(gateways.map((g) => [g.module, g]));
	const noneGw = { module: '', name: '(none set)', category: 'none', overridden: false, services: 0, clients: new Set(), annual: {} };
	const perClient = new Map();
	for (const s of snap.services.filter(isActive)) {
		const g = gw.get(s.module) || noneGw, cur = curOf.get(s.clientid) || 'unknown', a = annualOf(s);
		g.services++; g.clients.add(s.clientid); addTo(g.annual, cur, a);
		const c = perClient.get(s.clientid) || { id: s.clientid, services: 0, cats: {}, annual: {}, next: '', cur };
		c.services++; addTo(c.annual, cur, a); if (s.next && (!c.next || s.next < c.next)) c.next = s.next;
		if (a > 0 && g.category !== 'none') c.cats[g.category] = (c.cats[g.category] || 0) + 1; // free and one-time services have no renewal to collect, so they do not decide how a customer "pays"
		perClient.set(s.clientid, c);
	}
	if (noneGw.services) gateways.push(noneGw);

	const cats = Object.fromEntries(CATEGORY_KEYS.map((k) => [k, { category: k, label: CATEGORIES[k], clients: 0, anyClients: 0, services: 0, annual: {}, paid12m: 0, paidTotal: {}, unpaid: 0, overdue: 0, unpaidTotal: {}, avgDaysToPay: null, _days: [] }]));
	for (const c of perClient.values()) {
		c.primary = Object.entries(c.cats).sort((a, b) => b[1] - a[1] || CATEGORY_KEYS.indexOf(a[0]) - CATEGORY_KEYS.indexOf(b[0]))[0]?.[0] || 'none';
		cats[c.primary].clients++;
		for (const k of Object.keys(c.cats).length ? Object.keys(c.cats) : ['none']) cats[k].anyClients++;
	}
	for (const g of gateways) { const t = cats[g.category]; t.services += g.services; for (const [cur, v] of Object.entries(g.annual)) addTo(t.annual, cur, v); }
	for (const i of snap.invoices) {
		const t = cats[i.module ? catOf(i.module) : 'none'], cur = i.cur || 'unknown';
		if (i.status === 'Paid' && i.date >= yearAgo) {
			t.paid12m++; addTo(t.paidTotal, cur, i.total);
			if (i.paid) { const d = (Date.parse(i.paid) - Date.parse(i.date)) / 86400000; if (Number.isFinite(d) && d >= -1 && d < 400) t._days.push(Math.max(0, d)); }
		} else if (i.status === 'Unpaid') { t.unpaid++; addTo(t.unpaidTotal, cur, i.total); if (i.due && i.due < today) t.overdue++; }
	}
	for (const t of Object.values(cats)) { if (t._days.length) t.avgDaysToPay = Math.round(t._days.reduce((a, b) => a + b, 0) / t._days.length * 10) / 10; t.dayCount = t._days.length; delete t._days; }

	const active = perClient.size, mixed = [...perClient.values()].filter((c) => Object.keys(c.cats).length > 1).length;
	return {
		at: snap.at,
		totals: { clients: snap.clients.length, activeClients: active, activeServices: snap.services.filter(isActive).length, mixedClients: mixed, invoices: snap.invoices.length },
		categories: CATEGORY_KEYS.map((k) => cats[k]),
		gateways: gateways.map((g) => ({ module: g.module, name: g.name, category: g.category, overridden: g.overridden, services: g.services, clients: g.clients.size, annual: g.annual })).sort((a, b) => b.services - a.services),
		clientRows: [...perClient.values()].map((c) => { const cl = clients.get(c.id) || {}; return { id: c.id, name: cl.name || '', company: cl.company || '', email: cl.email || '', status: cl.status || '', services: c.services, primary: c.primary, categories: Object.keys(c.cats).length ? Object.keys(c.cats) : ['none'], annual: c.annual, next: c.next }; }),
	};
}

/** Sort keys for the customer list (and aliases people or the assistant might use). Blank values always go last, in either direction. */
const SORTS = { name: (r) => (r.company || r.name || '').toLowerCase(), email: (r) => String(r.email).toLowerCase(), status: (r) => String(r.status).toLowerCase(), services: (r) => r.services, kind: (r) => CATEGORIES[r.primary] || '', annual: (r) => Object.values(r.annual || {}).reduce((a, b) => a + b, 0), next: (r) => r.next || '' };
const SORT_ALIAS = { company: 'name', customer: 'name', next_due: 'next', nextdue: 'next', due: 'next', amount: 'annual', annual_recurring: 'annual', recurring: 'annual', pays_by: 'kind', payment: 'kind', payment_kind: 'kind', category: 'kind' };
export const SORT_KEYS = Object.keys(SORTS);
/** The customers list for the tab, the CSV and the assistant: filter by payment kind (primary kind, or "any service of this kind") and search text, then sort.
 *  Annual amounts in different currencies are compared as plain numbers, so sort by annual amount means "biggest number first". */
export function customerRows(summary, { category = '', q = '', any = false, sort = 'name', dir = 'asc' } = {}) {
	const needle = String(q || '').trim().toLowerCase(), key = SORTS[SORT_ALIAS[sort] || sort] ? SORT_ALIAS[sort] || sort : 'name', f = SORTS[key], sign = String(dir).toLowerCase() === 'desc' ? -1 : 1;
	const blank = (v) => v === '' || v === null || v === undefined;
	return (summary?.clientRows || []).filter((r) => (!category || (any ? r.categories.includes(category) : r.primary === category)) && (!needle || [r.name, r.company, r.email].some((x) => String(x).toLowerCase().includes(needle)))).sort((a, b) => {
		const x = f(a), y = f(b); if (blank(x) !== blank(y)) return blank(x) ? 1 : -1;
		const c = typeof x === 'number' ? x - y : String(x).localeCompare(String(y)); return (c * sign) || SORTS.name(a).localeCompare(SORTS.name(b));
	});
}
const safeCell = (v) => { const t = String(v ?? ''); return /^[=+\-@\t\r]/.test(t) ? "'" + t : t; }; // a spreadsheet must never run a customer's name as a formula
export const customersCsv = (rows) => ['WHMCS client ID,Name,Company,Email,Status,Active services,Pays mainly by,Other kinds,Annual recurring,Next due'].concat(rows.map((r) => csvLine([r.id, r.name, r.company, r.email, r.status, r.services, CATEGORIES[r.primary], r.categories.filter((c) => c !== r.primary).map((c) => CATEGORIES[c]).join('; '), Object.entries(r.annual).map(([c, v]) => `${v.toFixed(2)} ${c}`).join('; '), r.next].map(safeCell)))).join('\r\n') + '\r\n';

export function createWhmcs({ db, whmcs, log = console.log }) {
	let running = false;
	const get = async (key) => { const r = (await db.query('select value from kv where key = $1', [key]))[0]; return r ? ((typeof r.value === 'string' && /^[\[{"]/.test(r.value) ? JSON.parse(r.value) : r.value)) : null; };
	const put = (key, val) => db.query('insert into kv (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value, updated_at = now()', [key, JSON.stringify(val)]);
	const self = {
		available: () => whmcs.available(),
		async status() { return { configured: whmcs.available(), running, last: await get('whmcs_sync') }; },
		/** Reads WHMCS again. A failure is reported and the last good snapshot is kept. */
		async sync() {
			if (running) throw new Error('A sync is already running.');
			running = true; const at = new Date().toISOString();
			try {
				const snap = await readSnapshot(whmcs);
				await put('whmcs_snapshot', snap);
				const res = { ok: true, at, clients: snap.clients.length, services: snap.services.length, invoices: snap.invoices.length, skipped: snap.skipped || [] };
				await put('whmcs_sync', res); return res;
			} catch (e) { const res = { ok: false, at, error: String(e.message).slice(0, 400) }; await put('whmcs_sync', res); log('whmcs sync failed: ' + res.error); return res; }
			finally { running = false; }
		},
		async summary() { return summarize(await get('whmcs_snapshot'), (await get('whmcs_gateway_map')) || {}); },
		async setGatewayMap(module, category) {
			const snap = await get('whmcs_snapshot'), known = new Set([...(snap?.gateways || []).map((g) => g.module), ...(snap?.services || []).map((s) => s.module), ...(snap?.invoices || []).map((i) => i.module)].filter(Boolean));
			if (!known.has(module)) throw new Error('That payment gateway is not in the last sync.');
			const map = { ...((await get('whmcs_gateway_map')) || {}) };
			if (category === 'auto' || !category) delete map[module]; else if (CATEGORIES[category] && category !== 'none') map[module] = category; else throw new Error('Unknown payment kind.');
			await put('whmcs_gateway_map', map); return self.summary();
		},
	};
	return self;
}
