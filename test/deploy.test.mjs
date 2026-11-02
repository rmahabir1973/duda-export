import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import express from 'express';
import { createStore, slugify } from '../deploy/store.mjs';
import { mergeSpf, planWebRecords } from '../deploy/dnscheck.mjs';
import { STAGES, blockedBy } from '../deploy/stages.mjs';
import { createDeployRouter } from '../deploy/routes.mjs';
import { shq } from '../deploy/clients.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dep-'));
const baseCfg = { gatewayUrl: 'https://gw', gatewayAdminKey: 'k', previewZoneId: 'pz', previewDomain: 'churchwebglobal.com', hostingerIp: '1.2.3.4', templateSlug: 'build2', siteRoot: '/h/{host}', wpCli: 'wp', ourMxHosts: ['mail.churchwebglobal.com'], mailHost: 'mail.churchwebglobal.com', dudaHosts: undefined, dudaIps: ['9.9.9.9'], postmarkServerToken: 'SRVTOK', defaultTokenCap: 5000, defaultImageCap: 3, gatewayUrl2: '' };

function fakes(over = {}) {
	const calls = { ssh: [], cf: [], pm: [], gw: [] };
	const zones = new Map(); const recs = new Map();
	const c = {
		cfg: { ...baseCfg, ...(over.cfg || {}) },
		gateway: { available: () => true, mint: async (s) => (calls.gw.push(['mint', s]), { site: s, token: 'cwai_' + s + '_SECRETTOKEN', revoked: false }), site: async () => ({ revoked: false, caps: { tokens: 5000 } }), setCap: async (...a) => calls.gw.push(['cap', ...a]), revoke: async (...a) => calls.gw.push(['revoke', ...a]), tokenWorks: async () => true },
		cloudflare: {
			available: () => true,
			zoneByName: async (d) => zones.get(d) || null,
			createZone: async (d) => { const z = { id: 'z-' + d, name: d, status: 'pending', name_servers: ['a.ns.cloudflare.com', 'b.ns.cloudflare.com'] }; zones.set(d, z); recs.set(z.id, []); calls.cf.push(['zone', d]); return z; },
			zone: async (id) => [...zones.values()].find((z) => z.id === id),
			activationCheck: async () => true,
			records: async (id) => recs.get(id) || [],
			createRecord: async (id, r) => { calls.cf.push(['create', r.type, r.name, r.content]); (recs.get(id) || recs.set(id, []).get(id)).push({ id: 'r' + Math.random(), ...r }); },
			updateRecord: async (id, rid, r) => calls.cf.push(['update', r.type, r.name, r.content]),
		},
		postmark: { available: () => true, domainByName: async () => null, createDomain: async (d) => (calls.pm.push(['create', d]), { ID: 7 }), domain: async () => ({ ID: 7, DKIMPendingHost: '2026.pm._domainkey.x.org', DKIMPendingTextValue: 'k=rsa;p=ABC', ReturnPathDomain: 'pm-bounces.x.org', ReturnPathDomainCNAMEValue: 'pm.mtasv.net', DKIMVerified: false }), verifyDkim: async () => ({ DKIMVerified: true }), verifyReturnPath: async () => ({ ReturnPathDomainVerified: true }), verifySpf: async () => ({ SPFVerified: true }) },
		dns: { ns: async () => over.ns || ['ns1.duda.co'], a: async (d) => (over.a ? over.a(d) : ['9.9.9.9']), aaaa: async () => [], cname: async (d) => (over.cname ? over.cname(d) : []), mx: async () => over.mx || [{ exchange: 'aspmx.l.google.com', priority: 1 }], txt: async () => over.txt || [['v=spf1 include:_spf.google.com ~all']] },
		http: { get: async (u) => over.http ? over.http(u) : { status: 200, headers: {}, location: '', text: 'Britannia United Church' } },
		tls: async () => ({ authorized: true, validTo: 'Jan 1 2027' }),
		ssh: { available: () => over.noSsh ? false : true, exec: async (cmd) => (calls.ssh.push(cmd), { code: 0, out: 'ok', err: '' }) },
	};
	return { c, calls, zones, recs };
}

test('slugify and store', () => {
	assert.equal(slugify('St. Paul\'s & Friends'), 'st-paul-s-and-friends');
	const s = createStore(tmp());
	const ch = s.create({ name: 'Britannia United', domain: 'https://www.BritanniaUnited.ca/x', plan: 'email' });
	assert.equal(ch.slug, 'britannia-united'); assert.equal(ch.domain, 'britanniaunited.ca');
	assert.throws(() => s.create({ name: 'Britannia United' }), /already exists/);
	assert.throws(() => s.create({ name: 'Grace Church', domain: 'not a domain' }), /website address/);
});

test('shq prevents command injection through a church name', () => {
	assert.equal(shq("O'Brien; rm -rf /"), "'O'\\''Brien; rm -rf /'");
});

test('single SPF merge', () => {
	const m = mergeSpf(['v=spf1 include:_spf.google.com ~all', 'v=spf1 include:other.com ~all'], { includes: ['spf.mtasv.net'], hosts: [] });
	assert.equal((m.record.match(/v=spf1/g) || []).length, 1);
	for (const x of ['_spf.google.com', 'other.com', 'spf.mtasv.net']) assert.ok(m.record.includes(x));
});

test('stage 1 dry run changes nothing and never shows the token; real run writes it', async () => {
	const f = fakes(); const ch = createStore(tmp()).create({ name: 'Britannia United' });
	const ctx = { c: f.c };
	const dry = await STAGES[0].run(ctx, ch, { dry: true });
	assert.equal(f.calls.ssh.length, 0); assert.equal(f.calls.cf.length, 0);
	assert.ok(dry.items.every((i) => !JSON.stringify(i).includes('SECRETTOKEN')));
	const real = await STAGES[0].run(ctx, ch, { dry: false });
	assert.ok(f.calls.ssh.some((c) => c.includes('config set CWAI_API_KEY') && c.includes('SECRETTOKEN')));
	assert.ok(f.calls.cf.some((c) => c[0] === 'create' && c[2] === 'britannia-united.churchwebglobal.com'));
	assert.deepEqual(f.calls.gw.find((g) => g[0] === 'cap').slice(1), ['britannia-united', 5000, 3]);
	assert.ok(real.items.every((i) => !JSON.stringify(i).includes('SECRETTOKEN')), 'token must be masked in output');
	assert.ok(f.calls.ssh.some((c) => c.includes('search-replace') && c.includes('build2.churchwebglobal.com')));
});

test('stage 1 without SSH gives hand-done instructions instead of failing', async () => {
	const f = fakes({ noSsh: true }); const ch = createStore(tmp()).create({ name: 'Grace Church' });
	const r = await STAGES[0].run({ c: f.c }, ch, { dry: false });
	assert.ok(r.items.some((i) => i.status === 'manual' && i.detail.includes('wp')));
	assert.ok(r.ok);
});

test('stage 2 detects a Duda site and Google email', async () => {
	const f = fakes({ cname: (d) => (d.startsWith('www.') ? ['x.multiscreensite.com'] : []) });
	const ch = createStore(tmp()).create({ name: 'Grace Church', domain: 'grace.org' });
	const r = await STAGES[1].check({ c: f.c }, ch);
	const txt = r.items.map((i) => i.label).join('|');
	assert.match(txt, /Duda/); assert.match(txt, /Google/);
});

test('stage 4 creates the zone, never deletes, flags conflicts, and waits for nameservers', async () => {
	const f = fakes({ a: () => ['9.9.9.9'] }); const ch = createStore(tmp()).create({ name: 'Grace Church', domain: 'grace.org' });
	const r = await STAGES[3].run({ c: f.c, facts: null }, ch, { dry: false });
	assert.ok(f.zones.has('grace.org'));
	assert.ok(r.items.some((i) => i.id === 'ns' && i.status === 'warn' && i.detail.includes('a.ns.cloudflare.com')));
	assert.ok(!f.calls.cf.some((c) => c[0] === 'delete'));
});

test('stage 6 mailboxes: passwords generated, MX switch gated', async () => {
	const f = fakes(); const s = createStore(tmp()); const ch = s.create({ name: 'Grace Church', domain: 'grace.org', plan: 'email' });
	const ctx = { c: f.c }; const r = await STAGES[5].run(ctx, ch, { dry: false });
	assert.equal(ctx.secret.boxes[0].address, 'info@grace.org'); assert.ok(ctx.secret.boxes[0].password.length >= 14);
	const g = await STAGES[5].run({ c: f.c }, ch, { cutoverMx: true });
	assert.equal(g.ok, false);
	const web = await STAGES[5].run({ c: f.c }, { ...ch, plan: 'website' }, {});
	assert.ok(web.ok);
});

test('stage 7 adds Postmark records, one SPF, and uses the server token over SSH', async () => {
	const f = fakes(); const ch = createStore(tmp()).create({ name: 'Grace Church', domain: 'grace.org' });
	await f.c.cloudflare.createZone('grace.org');
	f.recs.get('z-grace.org').push({ id: 'old', type: 'TXT', name: 'grace.org', content: 'v=spf1 include:_spf.google.com ~all' });
	const r = await STAGES[6].run({ c: f.c }, ch, { dry: false });
	const spfWrites = f.calls.cf.filter((c) => /v=spf1/.test(c[3] || '') && ['create', 'update'].includes(c[0]));
	assert.ok(spfWrites.length <= 1);
	assert.ok(f.calls.cf.some((c) => c[1] === 'TXT' && /pm\._domainkey/.test(c[2])));
	assert.ok(f.calls.ssh.some((c) => c.includes('WPMS_SMTP_HOST smtp.postmarkapp.com')));
	assert.ok(r.items.every((i) => !JSON.stringify(i).includes('SRVTOK')));
});

test('gating: later stages are blocked until approval is complete', () => {
	const ch = createStore(tmp()).create({ name: 'Grace Church', domain: 'grace.org' });
	assert.deepEqual(blockedBy(ch, STAGES[3]), ['approval']);
	ch.stages.approval = { manual: Object.fromEntries(STAGES[2].manual.map((m) => [m.id, true])) };
	assert.deepEqual(blockedBy(ch, STAGES[3]), []);
});

test('router: create, gate, run, secrets not stored', async () => {
	const f = fakes(); const store = createStore(tmp());
	const app = express(); app.use(express.json());
	app.use('/api/deploy', createDeployRouter({ need: (q, s, n) => { q.by = 'test'; n(); }, store, clients: f.c }));
	const srv = app.listen(0); const base = `http://127.0.0.1:${srv.address().port}/api/deploy`;
	const j = async (p, m = 'GET', b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { s: r.status, j: await r.json() }; };
	try {
		let r = await j('/churches', 'POST', { name: 'Grace Church', domain: 'grace.org', plan: 'email' }); assert.equal(r.s, 200);
		r = await j('/churches/grace-church/stages/dns/run', 'POST', { confirm: true }); assert.equal(r.s, 409);
		r = await j('/churches/grace-church/stages/preview/run', 'POST', {}); assert.equal(r.s, 400, 'needs confirm');
		r = await j('/churches/grace-church/stages/preview/run', 'POST', { confirm: true }); assert.equal(r.s, 200);
		for (const m of STAGES[2].manual) await j('/churches/grace-church/stages/approval/manual', 'PUT', { id: m.id, value: true });
		r = await j('/churches/grace-church'); assert.equal(r.j.stageStates.approval.done, true);
		r = await j('/churches/grace-church/stages/mailboxes/run', 'POST', { confirm: true }); assert.equal(r.s, 200);
		assert.ok(r.j.secret.boxes[0].password);
		const saved = JSON.stringify(store.get('grace-church'));
		assert.ok(!saved.includes(r.j.secret.boxes[0].password), 'temporary password must not be stored');
		assert.ok(!saved.includes('SECRETTOKEN'));
	} finally { srv.close(); }
});

import { errText, configFromEnv, configured } from '../deploy/clients.mjs';
test('error text is always a readable string', () => {
	assert.equal(errText({ data: { type: 'error', error: { type: 'not_found_error', message: 'Not found' } }, status: 404 }), 'Not found');
	assert.equal(errText({ data: { error: 'Invalid admin key.' }, status: 401 }), 'Invalid admin key.');
	assert.equal(errText({ data: { errors: [{ message: 'Authentication error' }] }, status: 403 }, 'fix it'), 'Authentication error (fix it)');
	assert.equal(errText({ data: null, status: 0, error: 'timed out' }), 'timed out');
	assert.ok(!errText({ data: { error: { x: 1 } }, status: 500 }).includes('[object'));
});
test('Hostinger variable names are understood for SSH', () => {
	const cfg = configFromEnv({ HOSTINGER_IP: '1.2.3.4', HOSTINGER_USERNAME: 'u123', HOSTINGER_PORT: '65002', SSH_PRIVATE_KEY: 'k' });
	assert.deepEqual([cfg.sshHost, cfg.sshUser, cfg.sshPort], ['1.2.3.4', 'u123', 65002]);
	assert.equal(configured(cfg).ssh, true);
	assert.equal(configured(configFromEnv({ HOSTINGER_IP: '1.2.3.4', HOSTINGER_USERNAME: 'u' })).ssh, false);
});
test('every stage has a step breakdown', () => { for (const s of STAGES) assert.ok(s.steps.length >= 4, s.key); });
