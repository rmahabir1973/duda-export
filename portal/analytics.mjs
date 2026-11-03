// The Analytics dashboard: gathers every number we can get, one source at a time. Each source reports on its own, so one that is
// not set up (or failing) never blanks the others. Nothing here changes anything: every call is a read.
import crypto from 'node:crypto';
import { STAGES, stageSkipped } from '../deploy/checks.mjs';

const DAY = 86400000;
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const num = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
export const RANGES = [7, 30, 90];

/** One value per day for the whole window (days with nothing count as 0), so a chart has no gaps. */
export function fillDays(rows, days, now = new Date(), keys = ['n']) {
	const by = new Map(rows.map((r) => [r.d, r]));
	return Array.from({ length: days }, (_, i) => { const d = iso(now.getTime() - (days - 1 - i) * DAY); const r = by.get(d); return { d, ...Object.fromEntries(keys.map((k) => [k, r ? num(r[k]) : 0])) }; });
}

/* ------------------------------------------------------------------ Google Analytics 4 (the Data API, with a service account) */
const b64u = (b) => Buffer.from(b).toString('base64url');
export function readServiceAccount({ email = '', key = '' }) {
	let k = String(key || '').trim(), e = String(email || '').trim();
	if (k.startsWith('{')) { try { const j = JSON.parse(k); k = j.private_key || ''; e = e || j.client_email || ''; } catch { /* handled below */ } }
	k = k.replace(/\\n/g, '\n').trim();
	return { email: e, key: k };
}

export function makeGa4({ propertyId, email, key, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
	const sa = readServiceAccount({ email, key });
	const pid = String(propertyId || '').trim().replace(/^properties\//, '');
	let token = null, exp = 0, pending = null;
	const self = {
		available: () => !!(pid && sa.email && sa.key),
		accessToken() { // parallel reports share one sign-in
			if (token && now() < exp - 60000) return Promise.resolve(token);
			return (pending ||= self.signIn().finally(() => { pending = null; }));
		},
		async signIn() {
			if (!/^\d+$/.test(pid)) throw new Error('GOOGLE_ANALYTICS_PROPERTY_ID must be the numeric GA4 property ID (Admin > Property details), not a measurement ID that starts with G-.');
			const iat = Math.floor(now() / 1000);
			const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' })), claims = b64u(JSON.stringify({ iss: sa.email, scope: 'https://www.googleapis.com/auth/analytics.readonly', aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 }));
			let sig; try { sig = crypto.createSign('RSA-SHA256').update(`${head}.${claims}`).sign(sa.key, 'base64url'); } catch { throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is not a valid private key (paste the private_key from the service account JSON, or the whole JSON file).'); }
			const r = await fetchImpl('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${sig}` }), signal: AbortSignal.timeout(20000) });
			const j = await r.json().catch(() => ({}));
			if (!r.ok || !j.access_token) throw new Error('Google refused the service account sign-in' + (j.error_description || j.error ? ': ' + String(j.error_description || j.error).slice(0, 150) : '') + '.');
			token = j.access_token; exp = now() + num(j.expires_in || 3600) * 1000; return token;
		},
		async run(body) {
			const t = await self.accessToken();
			const r = await fetchImpl(`https://analyticsdata.googleapis.com/v1beta/properties/${pid}:runReport`, { method: 'POST', headers: { authorization: 'Bearer ' + t, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
			const j = await r.json().catch(() => ({}));
			if (!r.ok) {
				const m = String(j.error?.message || 'HTTP ' + r.status).slice(0, 220);
				throw new Error(r.status === 403 ? 'Google Analytics says the service account has no access to this property: add GOOGLE_SERVICE_ACCOUNT_EMAIL as a Viewer in GA4 (Admin > Property access management), and make sure the Analytics Data API is enabled. (' + m + ')' : 'Google Analytics: ' + m);
			}
			return j;
		},
	};
	return self;
}
const gaRows = (j) => (j.rows || []).map((r) => ({ dims: (r.dimensionValues || []).map((x) => x.value), m: (r.metricValues || []).map((x) => num(x.value)) }));

export async function ga4Report(ga4, days, now = new Date()) {
	const cur = { startDate: `${days - 1}daysAgo`, endDate: 'today' }, prev = { startDate: `${2 * days - 1}daysAgo`, endDate: `${days}daysAgo` };
	const mt = ['activeUsers', 'newUsers', 'sessions', 'screenPageViews', 'engagementRate', 'averageSessionDuration', 'eventCount', 'keyEvents'];
	const q = (dimension, metric, limit = 10) => ({ dateRanges: [cur], dimensions: [{ name: dimension }], metrics: [{ name: metric }], orderBys: [{ metric: { metricName: metric }, desc: true }], limit });
	const [totals, daily, pages, channels, sources, countries, devices, events] = await Promise.all([
		ga4.run({ dateRanges: [cur, prev], metrics: mt.map((name) => ({ name })) }),
		ga4.run({ dateRanges: [cur], dimensions: [{ name: 'date' }], metrics: [{ name: 'activeUsers' }, { name: 'sessions' }], orderBys: [{ dimension: { dimensionName: 'date' } }], limit: 200 }),
		ga4.run({ dateRanges: [cur], dimensions: [{ name: 'pagePath' }], metrics: [{ name: 'screenPageViews' }, { name: 'activeUsers' }], orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }], limit: 15 }),
		ga4.run(q('sessionDefaultChannelGroup', 'sessions')), ga4.run(q('sessionSource', 'sessions')), ga4.run(q('country', 'activeUsers')), ga4.run(q('deviceCategory', 'sessions', 5)), ga4.run(q('eventName', 'eventCount', 15)),
	]);
	const t = gaRows(totals), pick = (i) => Object.fromEntries(mt.map((k, n) => [k, t[i]?.m[n] ?? 0]));
	const list = (j, a = 'name') => gaRows(j).map((r) => ({ [a]: r.dims[0] || '(not set)', n: r.m[0], n2: r.m[1] ?? null }));
	return {
		totals: { current: pick(0), previous: pick(1) },
		daily: fillDays(gaRows(daily).map((r) => ({ d: `${r.dims[0].slice(0, 4)}-${r.dims[0].slice(4, 6)}-${r.dims[0].slice(6, 8)}`, users: r.m[0], sessions: r.m[1] })), days, now, ['users', 'sessions']),
		pages: list(pages, 'path'), channels: list(channels), sources: list(sources), countries: list(countries), devices: list(devices), events: list(events),
	};
}

/* ------------------------------------------------------------------ Cloudflare traffic for the customers' domains */
const CF_QUERY = `query($tags:[String!],$from:Date!,$to:Date!){viewer{zones(filter:{zoneTag_in:$tags}){zoneTag httpRequests1dGroups(limit:200,orderBy:[date_ASC],filter:{date_geq:$from,date_leq:$to}){dimensions{date} sum{requests pageViews bytes threats cachedRequests} uniq{uniques}}}}}`;
export async function cloudflareTraffic({ clients, days, ownDomains = [], fetchImpl = globalThis.fetch, now = new Date() }) {
	const own = ownDomains.map((d) => d.toLowerCase()), isOwn = (n) => own.some((o) => n === o || n.endsWith('.' + o));
	const zones = (await clients.cloudflare.zones()).filter((z) => z.status === 'active' && !isOwn(z.name)), name = new Map(zones.map((z) => [z.id, z.name]));
	const from = iso(now.getTime() - (days - 1) * DAY), to = iso(now);
	const per = new Map(), dailyTotals = new Map();
	for (let i = 0; i < zones.length; i += 25) {
		const tags = zones.slice(i, i + 25).map((z) => z.id);
		const r = await fetchImpl(clients.cfg.cloudflareBase + '/graphql', { method: 'POST', headers: { authorization: 'Bearer ' + clients.cfg.cloudflareToken, 'content-type': 'application/json' }, body: JSON.stringify({ query: CF_QUERY, variables: { tags, from, to } }), signal: AbortSignal.timeout(30000) });
		const j = await r.json().catch(() => ({}));
		if (!r.ok || j.errors?.length) throw new Error('Cloudflare analytics: ' + String(j.errors?.[0]?.message || 'HTTP ' + r.status).slice(0, 200) + (r.status === 403 || /authoriz|permission|access/i.test(j.errors?.[0]?.message || '') ? ' (the API token needs Account Analytics: Read, or Zone Analytics: Read, on the churches account)' : ''));
		for (const z of j.data?.viewer?.zones || []) {
			const e = per.get(z.zoneTag) || { domain: name.get(z.zoneTag) || z.zoneTag, requests: 0, pageViews: 0, visitors: 0, bytes: 0, threats: 0, cached: 0 };
			for (const g of z.httpRequests1dGroups || []) {
				e.requests += num(g.sum?.requests); e.pageViews += num(g.sum?.pageViews); e.bytes += num(g.sum?.bytes); e.threats += num(g.sum?.threats); e.cached += num(g.sum?.cachedRequests); e.visitors += num(g.uniq?.uniques);
				const d = g.dimensions?.date, t = dailyTotals.get(d) || { d, requests: 0, pageViews: 0 }; t.requests += num(g.sum?.requests); t.pageViews += num(g.sum?.pageViews); dailyTotals.set(d, t);
			}
			per.set(z.zoneTag, e);
		}
	}
	const rows = [...per.values()].sort((a, b) => b.requests - a.requests);
	const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
	return {
		zones: zones.length, withTraffic: rows.filter((r) => r.requests > 0).length,
		totals: { requests: sum('requests'), pageViews: sum('pageViews'), visitors: sum('visitors'), bytes: sum('bytes'), threats: sum('threats'), cachePct: sum('requests') ? Math.round(sum('cached') / sum('requests') * 1000) / 10 : 0 },
		daily: fillDays([...dailyTotals.values()], days, now, ['requests', 'pageViews']),
		top: rows.slice(0, 30).map((r) => ({ ...r, cachePct: r.requests ? Math.round(r.cached / r.requests * 1000) / 10 : 0 })),
		quiet: rows.filter((r) => r.requests === 0).length + zones.length - rows.length,
		note: 'Visitors are each domain\'s unique visitors per day added together, so the same person on two days counts twice.',
	};
}

/* ------------------------------------------------------------------ Postmark sending statistics */
export async function postmarkStats({ clients, days, fetchImpl = globalThis.fetch, now = new Date() }) {
	const from = iso(now.getTime() - (days - 1) * DAY), to = iso(now), h = { 'x-postmark-server-token': clients.cfg.postmarkServerToken, accept: 'application/json' };
	const get = async (p) => { const r = await fetchImpl(`${clients.cfg.postmarkBase}/stats/outbound${p}?fromdate=${from}&todate=${to}`, { headers: h, signal: AbortSignal.timeout(20000) }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error('Postmark: ' + String(j.Message || 'HTTP ' + r.status).slice(0, 160)); return j; };
	const [all, sends] = await Promise.all([get(''), get('/sends')]);
	const sent = num(all.Sent), bounced = num(all.Bounced);
	return { sent, bounced, delivered: Math.max(0, sent - bounced), bounceRate: sent ? Math.round(bounced / sent * 1000) / 10 : 0, spam: num(all.SpamComplaints), opens: num(all.Opens), uniqueOpens: num(all.UniqueOpens), tracked: num(all.Tracked), daily: fillDays((sends.Days || []).map((x) => ({ d: String(x.Date).slice(0, 10), sent: x.Sent })), days, now, ['sent']) };
}

/* ------------------------------------------------------------------ our own data: outreach, directory, activity, pipeline, billing */
const since = (days) => 'now() - make_interval(days => $1::int)';
export async function outreachStats(db, days, now = new Date()) {
	const [daily, campaigns, events, suppressed] = await Promise.all([
		db.query(`select to_char(sent_at, 'YYYY-MM-DD') as d, count(*) filter (where ok)::int as sent, count(*) filter (where not ok)::int as failed from outreach_log where sent_at >= ${since()} group by 1 order by 1`, [days]),
		db.query(`select campaign, count(*) filter (where ok)::int as sent, count(*) filter (where not ok)::int as failed, count(distinct email) filter (where ok)::int as recipients from outreach_log where sent_at >= ${since()} group by campaign order by 2 desc limit 20`, [days]),
		db.query(`select type, count(*)::int as n from outreach_events where at >= ${since()} group by type order by n desc`, [days]),
		db.query('select reason, count(*)::int as n from outreach_suppress group by reason order by n desc'),
	]);
	const sent = daily.reduce((a, r) => a + r.sent, 0), failed = daily.reduce((a, r) => a + r.failed, 0);
	return { sent, failed, daily: fillDays(daily, days, now, ['sent', 'failed']), campaigns, events, suppressed, doNotContact: suppressed.reduce((a, r) => a + r.n, 0) };
}
export async function directoryStats(db) {
	const [tot] = await db.query("select count(*)::int as total, count(*) filter (where is_customer)::int as customers, count(*) filter (where email <> '')::int as with_email, count(*) filter (where website <> '')::int as with_website from directory");
	return { ...tot, byStatus: await db.query('select outreach_status as status, count(*)::int as n from directory group by 1 order by n desc'), provinces: await db.query("select province, count(*)::int as n, count(*) filter (where is_customer)::int as customers from directory where province <> '' group by 1 order by n desc limit 12") };
}
export async function activityStats(db, days, now = new Date()) {
	const [daily, actions, users, [tot]] = await Promise.all([
		db.query(`select to_char(at, 'YYYY-MM-DD') as d, count(*)::int as n from audit_log where at >= ${since()} group by 1 order by 1`, [days]),
		db.query(`select action, count(*)::int as n from audit_log where at >= ${since()} group by 1 order by n desc limit 12`, [days]),
		db.query(`select user_email as who, count(*)::int as n from audit_log where at >= ${since()} group by 1 order by n desc limit 8`, [days]),
		db.query(`select count(*)::int as total, count(*) filter (where status >= 400)::int as failed from audit_log where at >= ${since()}`, [days]),
	]);
	return { total: tot.total, failed: tot.failed, daily: fillDays(daily, days, now, ['n']), actions, users };
}
export function pipelineStats(store, now = new Date()) {
	const list = store.list(), by = (f) => { const m = {}; for (const c of list) { const k = f(c); m[k] = (m[k] || 0) + 1; } return m; };
	const stageOf = (c) => { const s = STAGES.find((st) => !stageSkipped(st, c) && !c.stages?.[st.key]?.done); return s ? s.key : 'live'; };
	const order = [...STAGES.map((s) => s.key), 'live'], titles = Object.fromEntries(STAGES.map((s) => [s.key, s.title]));
	const at = by(stageOf), notLive = list.filter((c) => stageOf(c) !== 'live'), age = (c) => Math.max(0, Math.floor((now.getTime() - c.created) / DAY));
	const months = {}; for (const c of list) { const m = iso(c.created).slice(0, 7); months[m] = (months[m] || 0) + 1; }
	return {
		total: list.length, live: at.live || 0, inProgress: notLive.length,
		kinds: by((c) => (c.kind === 'migration' ? 'DUDA migration' : 'New site')), plans: by((c) => (c.plan === 'email' ? 'Email only' : 'Website')),
		stages: order.filter((k) => at[k]).map((k) => ({ key: k, title: k === 'live' ? 'Live' : titles[k], n: at[k] })),
		created: Object.entries(months).sort().slice(-12).map(([m, n]) => ({ m, n })),
		avgDaysInProgress: notLive.length ? Math.round(notLive.reduce((a, c) => a + age(c), 0) / notLive.length) : 0,
		oldest: notLive.sort((a, b) => a.created - b.created).slice(0, 5).map((c) => ({ name: c.name, days: age(c), stage: stageOf(c) === 'live' ? 'Live' : titles[stageOf(c)] })),
	};
}

/* ------------------------------------------------------------------ putting it together */
export function createAnalytics({ db, clients, ga4, store, whmcs, hosted, ownDomains = [], fetchImpl = globalThis.fetch, ttlMs = 10 * 60000, now = () => new Date(), log = console.log }) {
	const cache = new Map();
	const NOT_SET = { ga4: 'Google Analytics is not set up (GOOGLE_ANALYTICS_PROPERTY_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_SERVICE_ACCOUNT_KEY).', cloudflare: 'Cloudflare is not set up (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID).', postmark: 'Postmark is not set up (POSTMARK_SERVER_TOKEN).' };
	const sources = {
		ga4: { ok: () => ga4.available(), run: (d) => ga4Report(ga4, d, now()) },
		cloudflare: { ok: () => clients.cloudflare.available(), run: (d) => cloudflareTraffic({ clients, days: d, ownDomains, fetchImpl, now: now() }) },
		postmark: { ok: () => !!clients.cfg.postmarkServerToken, run: (d) => postmarkStats({ clients, days: d, fetchImpl, now: now() }) },
		outreach: { ok: () => true, run: (d) => outreachStats(db, d, now()) },
		directory: { ok: () => true, run: () => directoryStats(db) },
		activity: { ok: () => true, run: (d) => activityStats(db, d, now()) },
		pipeline: { ok: () => true, run: async () => pipelineStats(store, now()) },
		footprint: { ok: () => !!hosted, run: async () => hosted.counts() },
		billing: { ok: () => !!whmcs, run: async () => { const s = await whmcs.summary(); if (!s) throw new Error('WHMCS has not been synced yet: open the WHMCS tab and press Sync now.'); const c = Object.fromEntries(s.categories.map((x) => [x.category, x])); return { at: s.at, activeClients: s.totals.activeClients, activeServices: s.totals.activeServices, chequeClients: c.cheque.clients, cardClients: c.card.clients, annual: s.categories.reduce((acc, x) => { for (const [k, v] of Object.entries(x.annual)) acc[k] = Math.round(((acc[k] || 0) + v) * 100) / 100; return acc; }, {}), unpaid: s.categories.reduce((a, x) => a + x.unpaid, 0), overdue: s.categories.reduce((a, x) => a + x.overdue, 0) }; } },
	};
	return {
		sources: Object.keys(sources),
		async report(days = 30, { refresh = false } = {}) {
			days = RANGES.includes(+days) ? +days : 30;
			const out = {};
			await Promise.all(Object.entries(sources).map(async ([name, s]) => {
				const key = `${name}:${days}`, hit = cache.get(key);
				if (hit && Date.now() - hit.at < (refresh ? 30000 : ttlMs)) { out[name] = hit.v; return; }
				let v; const at = new Date().toISOString();
				if (!s.ok()) v = { ok: false, notSetUp: true, error: NOT_SET[name] || 'Not available.', at };
				else try { v = { ok: true, at, data: await s.run(days) }; } catch (e) { v = { ok: false, at, error: String(e.message).slice(0, 400) }; log(`analytics: ${name} failed: ${v.error}`); }
				if (v.ok || v.notSetUp) cache.set(key, { at: Date.now(), v });
				else if (hit?.v.ok) v = { ...hit.v, stale: true, staleError: v.error }; // a failed refresh keeps the last good numbers, marked as old, and is tried again next time
				out[name] = v;
			}));
			return { days, generatedAt: new Date().toISOString(), sources: out };
		},
	};
}
