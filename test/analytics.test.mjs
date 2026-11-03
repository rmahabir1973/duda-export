import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { pgliteDb, migrate } from '../portal/db.mjs';
import { createStore } from '../deploy/store.mjs';
import { STAGES } from '../deploy/checks.mjs';
import { makeGa4, ga4Report, readServiceAccount, cloudflareTraffic, postmarkStats, outreachStats, directoryStats, activityStats, pipelineStats, createAnalytics, fillDays } from '../portal/analytics.mjs';
import { analyticsRouter } from '../portal/analyticsRoutes.mjs';

const fresh = async () => { const db = pgliteDb(new PGlite()); await migrate(db); return db; };
const NOW = new Date('2026-11-02T12:00:00Z');
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const EMAIL = 'reader@proj.iam.gserviceaccount.com';

const ga4Fetch = (log = [], { status = 200 } = {}) => async (url, o) => {
	log.push(url);
	if (url === 'https://oauth2.googleapis.com/token') {
		const jwt = new URLSearchParams(String(o.body)).get('assertion'), [h, c, sig] = jwt.split('.'), claims = JSON.parse(Buffer.from(c, 'base64url'));
		const ok = crypto.createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, sig, 'base64url');
		if (!ok || claims.iss !== EMAIL || claims.scope !== 'https://www.googleapis.com/auth/analytics.readonly') return { ok: false, status: 400, json: async () => ({ error: 'invalid_grant', error_description: 'bad signature' }) };
		return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
	}
	if (status !== 200) return { ok: false, status, json: async () => ({ error: { message: 'User does not have access' } }) };
	assert.ok(url.endsWith('/properties/12345:runReport')); assert.equal(o.headers.authorization, 'Bearer tok');
	const b = JSON.parse(o.body), mv = (...v) => v.map((x) => ({ value: String(x) })), dv = (...v) => v.map((x) => ({ value: x }));
	const rows = b.dateRanges.length === 2 ? [{ dimensionValues: dv('date_range_0'), metricValues: mv(100, 60, 150, 400, 0.6, 95, 900, 7) }, { dimensionValues: dv('date_range_1'), metricValues: mv(80, 50, 120, 300, 0.5, 80, 700, 5) }]
		: b.dimensions[0].name === 'date' ? [{ dimensionValues: dv('20261031'), metricValues: mv(10, 14) }, { dimensionValues: dv('20261101'), metricValues: mv(12, 16) }]
		: [{ dimensionValues: dv('/' + b.dimensions[0].name), metricValues: mv(9, 4) }];
	return { ok: true, status: 200, json: async () => ({ rows }) };
};
const ga = (log, o) => makeGa4({ propertyId: '12345', email: EMAIL, key: PEM, fetchImpl: ga4Fetch(log, o) });

test('Google Analytics: signs in with the service account, reads the report, compares with the period before', async () => {
	const log = [], g = ga(log), r = await ga4Report(g, 7, NOW);
	assert.equal(r.totals.current.activeUsers, 100); assert.equal(r.totals.previous.activeUsers, 80); assert.equal(r.totals.current.keyEvents, 7);
	assert.equal(r.daily.length, 7); assert.deepEqual(r.daily.at(-2), { d: '2026-11-01', users: 12, sessions: 16 }); assert.equal(r.daily[0].users, 0, 'days with no data are zero, not missing');
	assert.equal(r.pages[0].path, '/pagePath'); assert.equal(r.pages[0].n, 9);
	assert.equal(log.filter((u) => u.includes('oauth2')).length, 1, 'one sign-in is reused for all eight reports');
});

test('Google Analytics: the key can be pasted as the whole JSON file or with \\n line breaks; bad setups give plain advice', async () => {
	assert.equal(readServiceAccount({ key: JSON.stringify({ private_key: PEM, client_email: EMAIL }) }).email, EMAIL);
	assert.ok(readServiceAccount({ email: EMAIL, key: PEM.replace(/\n/g, '\\n') }).key.includes('\n'));
	const viaJson = makeGa4({ propertyId: 'properties/12345', key: JSON.stringify({ private_key: PEM, client_email: EMAIL }), fetchImpl: ga4Fetch() }); assert.ok(viaJson.available()); await ga4Report(viaJson, 7, NOW);
	assert.equal(makeGa4({}).available(), false);
	await assert.rejects(() => makeGa4({ propertyId: 'G-ABC123', email: EMAIL, key: PEM, fetchImpl: ga4Fetch() }).run({}), /numeric GA4 property ID/);
	await assert.rejects(() => makeGa4({ propertyId: '12345', email: EMAIL, key: 'not a key', fetchImpl: ga4Fetch() }).run({}), (e) => /not a valid private key/.test(e.message) && !e.message.includes('not a key'));
	await assert.rejects(() => ga([], { status: 403 }).run({}), /Viewer in GA4/);
	const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
	await assert.rejects(() => makeGa4({ propertyId: '12345', email: EMAIL, key: other, fetchImpl: ga4Fetch() }).run({}), /Google refused/);
});

const zonesOf = (n) => [...Array.from({ length: n }, (_, i) => ({ id: 'z' + i, name: `church${i}.ca`, status: 'active' })), { id: 'own', name: 'churchwebglobal.com', status: 'active' }, { id: 'sub', name: 'x.churchwebglobal.com', status: 'active' }, { id: 'pend', name: 'pending.ca', status: 'pending' }];
const cfClients = (zones) => ({ cfg: { cloudflareBase: 'https://cf.test/client/v4', cloudflareToken: 'cftok', postmarkBase: 'https://pm.test', postmarkServerToken: 'pmtok' }, cloudflare: { available: () => true, zones: async () => zones } });
test('Cloudflare traffic: asks for 25 zones at a time, leaves out our own and unfinished zones, adds up per domain', async () => {
	const calls = [], f = async (url, o) => {
		const b = JSON.parse(o.body); calls.push(b.variables.tags.length); assert.equal(url, 'https://cf.test/client/v4/graphql'); assert.equal(o.headers.authorization, 'Bearer cftok');
		return { ok: true, status: 200, json: async () => ({ data: { viewer: { zones: b.variables.tags.map((t, i) => ({ zoneTag: t, httpRequests1dGroups: t === 'z0' ? [{ dimensions: { date: '2026-11-01' }, sum: { requests: 1000, pageViews: 400, bytes: 5e6, threats: 3, cachedRequests: 250 }, uniq: { uniques: 50 } }, { dimensions: { date: '2026-11-02' }, sum: { requests: 500, pageViews: 100, bytes: 1e6, threats: 0, cachedRequests: 250 }, uniq: { uniques: 30 } }] : t === 'z1' ? [{ dimensions: { date: '2026-11-02' }, sum: { requests: 10, pageViews: 5, bytes: 1000, threats: 0, cachedRequests: 0 }, uniq: { uniques: 2 } }] : [] })) } } }) };
	};
	const r = await cloudflareTraffic({ clients: cfClients(zonesOf(30)), days: 7, ownDomains: ['churchwebglobal.com'], fetchImpl: f, now: NOW });
	assert.deepEqual(calls, [25, 5], '30 customer zones, in two requests'); assert.equal(r.zones, 30);
	assert.equal(r.top[0].domain, 'church0.ca'); assert.equal(r.top[0].requests, 1500); assert.equal(r.top[0].visitors, 80); assert.equal(r.top[0].cachePct, 33.3);
	assert.equal(r.totals.requests, 1510); assert.equal(r.withTraffic, 2); assert.equal(r.quiet, 28); assert.equal(r.daily.length, 7); assert.equal(r.daily.at(-1).requests, 510);
	await assert.rejects(() => cloudflareTraffic({ clients: cfClients(zonesOf(2)), days: 7, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ errors: [{ message: 'not authorized to access this path' }] }) }), now: NOW }), /Account Analytics: Read/);
});

test('Postmark: totals, bounce rate and a daily series', async () => {
	const f = async (url) => ({ ok: true, status: 200, json: async () => (url.includes('/sends') ? { Days: [{ Date: '2026-11-02', Sent: 7 }], Sent: 7 } : { Sent: 200, Bounced: 10, SpamComplaints: 1, Opens: 80, UniqueOpens: 60, Tracked: 150 }) });
	const r = await postmarkStats({ clients: cfClients([]), days: 7, fetchImpl: f, now: NOW });
	assert.equal(r.delivered, 190); assert.equal(r.bounceRate, 5); assert.equal(r.daily.at(-1).sent, 7); assert.equal(r.daily.length, 7);
	await assert.rejects(() => postmarkStats({ clients: cfClients([]), days: 7, fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ Message: 'Invalid token' }) }), now: NOW }), /Invalid token/);
});

test('our own data: outreach, directory, activity and the customer pipeline', async () => {
	const db = await fresh(), at = (d) => new Date(NOW.getTime() - d * 86400000).toISOString();
	for (const [email, camp, ok, d] of [['a@a.ca', 'intro', true, 1], ['b@b.ca', 'intro', true, 2], ['c@c.ca', 'intro', false, 2], ['a@a.ca', 'old', true, 200]]) await db.query('insert into outreach_log (email, campaign, ok, sent_at) values ($1,$2,$3,$4)', [email, camp, ok, at(d)]);
	await db.query("insert into outreach_events (wid, email, type, at) values ('w1','a@a.ca','delivered',$1), ('w2','a@a.ca','opened',$1), ('w3','b@b.ca','delivered',$1)", [at(1)]);
	await db.query("insert into outreach_suppress (email, reason) values ('x@x.ca','bounced'), ('y@y.ca','unsubscribed'), ('z@z.ca','bounced')");
	const o = await outreachStats(db, 30, NOW);
	assert.equal(o.sent, 2, 'only the last 30 days'); assert.equal(o.failed, 1); assert.equal(o.campaigns.length, 1); assert.deepEqual(o.events.find((e) => e.type === 'delivered'), { type: 'delivered', n: 2 }); assert.equal(o.doNotContact, 3); assert.equal(o.daily.length, 30);
	await db.query("insert into directory (source, name, province, email, website, is_customer, outreach_status) values ('s1','A','ON','a@a.ca','a.ca',true,'customer'), ('s2','B','ON','','', false,'new'), ('s3','C','QC','c@c.ca','', false,'emailed')");
	const d = await directoryStats(db); assert.equal(d.total, 3); assert.equal(d.customers, 1); assert.equal(d.with_email, 2); assert.deepEqual(d.provinces[0], { province: 'ON', n: 2, customers: 1 });
	await db.query("insert into audit_log (user_email, action, status, at) values ('ryan@x.ca','customer.add',200,$1), ('chad@x.ca','task.check',500,$1), ('ryan@x.ca','task.check',200,$2)", [at(1), at(100)]);
	const a = await activityStats(db, 30, NOW); assert.equal(a.total, 2); assert.equal(a.failed, 1); assert.equal(a.users.length, 2);
	const store = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'an-'))); store.create({ name: 'Live United' }); store.create({ name: 'New United' }); store.create({ name: 'Mig United', kind: 'migration' });
	store.update('live-united', (c) => { for (const s of STAGES) c.stages[s.key] = { done: true }; });
	const p = pipelineStats(store, new Date(Date.now() + 5 * 86400000)); assert.equal(p.total, 3); assert.equal(p.live, 1); assert.equal(p.inProgress, 2);
	assert.deepEqual(Object.fromEntries(p.stages.map((s) => [s.key, s.n])), { sales: 1, dnscheck: 1, live: 1 }, 'a new site starts at sales, a migration skips it'); assert.ok(p.avgDaysInProgress >= 5);
	assert.equal(fillDays([{ d: '2026-11-02', n: 4 }], 3, NOW, ['n']).map((x) => x.n).join(), '0,0,4');
});

test('dashboard: a source that is not set up or fails never hides the others; results are cached; a failed refresh keeps the last good numbers', async () => {
	const db = await fresh(), store = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'an-'))); let cfFail = false, cfCalls = 0;
	const clients = { cfg: { cloudflareBase: 'https://cf.test/client/v4', cloudflareToken: 't', postmarkBase: 'https://pm.test', postmarkServerToken: '' }, cloudflare: { available: () => true, zones: async () => { cfCalls++; if (cfFail) throw new Error('Cloudflare: token cannot access'); return []; } } };
	const a = createAnalytics({ db, clients, ga4: ga([]), store, whmcs: { summary: async () => null }, hosted: { counts: async () => ({ total: 5, cloudflare: 4, duda: 1, smartermail: 2, hostinger: 3 }) }, ttlMs: 0, now: () => NOW, log: () => {} });
	let r = await a.report(30);
	assert.equal(r.sources.ga4.ok, true); assert.equal(r.sources.postmark.notSetUp, true); assert.match(r.sources.postmark.error, /POSTMARK_SERVER_TOKEN/); assert.equal(r.sources.billing.ok, false); assert.match(r.sources.billing.error, /Sync now/);
	assert.equal(r.sources.footprint.data.total, 5); assert.equal(r.sources.pipeline.data.total, 0); assert.equal(r.sources.cloudflare.ok, true);
	cfFail = true; r = await a.report(30);
	assert.equal(r.sources.cloudflare.ok, true); assert.equal(r.sources.cloudflare.stale, true); assert.match(r.sources.cloudflare.staleError, /token cannot access/, 'the last good numbers are shown, marked old');
	assert.equal(r.sources.ga4.ok, true, 'other sources are unaffected');
	const b = createAnalytics({ db, clients, ga4: ga([]), store, whmcs: null, hosted: null, ttlMs: 60000, now: () => NOW, log: () => {} }); cfFail = false; cfCalls = 0;
	await b.report(30); await b.report(30); assert.equal(cfCalls, 1, 'the second look uses the cache'); await b.report(7); assert.equal(cfCalls, 2, 'a different range is a different report');
	assert.equal((await b.report(999)).days, 30, 'an unknown range falls back to 30 days'); assert.equal((await b.report(30)).sources.footprint.notSetUp, true);
});

test('analytics route: admins only', async () => {
	const analytics = { report: async (d) => ({ days: +d || 30, generatedAt: 'now', sources: {} }) }; let user = { role: 'admin' };
	const app = express(); app.use((req, res, next) => { req.user = user; next(); }); app.use('/api/analytics', analyticsRouter({ need: (q, s, n) => n(), analytics }));
	const srv = app.listen(0), url = `http://127.0.0.1:${srv.address().port}/api/analytics`;
	try { assert.equal((await (await fetch(url + '?days=90')).json()).days, 90); for (const u of [{ role: 'staff' }, undefined]) { user = u; assert.equal((await fetch(url)).status, 403); } } finally { srv.close(); }
});
