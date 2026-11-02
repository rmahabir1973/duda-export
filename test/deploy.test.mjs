import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import express from 'express';
import { createStore, slugify } from '../deploy/store.mjs';
import { mergeSpf } from '../deploy/dnscheck.mjs';
import { STAGES, stageByKey, testStage, blockedBy } from '../deploy/checks.mjs';
import { createDeployRouter } from '../deploy/routes.mjs';
import { shq, errText, configFromEnv, configured } from '../deploy/clients.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dep-'));
const baseCfg = { gatewayUrl: 'https://gw', gatewayAdminKey: 'k', previewZoneId: 'pz', previewDomain: 'churchwebglobal.com', hostingerIp: '1.2.3.4', templateSlug: 'build2', siteRoot: '/h/{host}', wpCli: 'wp', ourMxHosts: ['mail.churchwebglobal.com'], mailHost: 'mail.churchwebglobal.com', dudaIps: ['9.9.9.9'], postmarkServerToken: 'SRVTOK', postmarkAccountToken: 'ACC', cloudflareToken: 't', cloudflareAccountId: 'a', sshHost: 'h', sshUser: 'u', sshKey: 'k', defaultTokenCap: 5000, defaultImageCap: 3 };

/** Fake services with a tiny pretend WordPress that answers the WP-CLI commands the checklist uses. */
function fakes(over = {}) {
	const calls = { ssh: [], cf: [], pm: [], gw: [] };
	const zones = new Map(), recs = new Map([['pz', []]]);
	const wpState = { siteurl: 'https://build2.churchwebglobal.com', blogname: 'Template', blog_public: '1', active: false, sv: '0', users: '', cfg: {}, ...(over.wp || {}) };
	const exec = async (cmd) => {
		calls.ssh.push(cmd);
		if (/^test -f/.test(cmd)) return over.noFolder ? { code: 1, out: '', err: '' } : { code: 0, out: 'FOUND', err: '' };
		const m = /&& wp (.*)$/s.exec(cmd); const a = m ? m[1] : '';
		const ok = (out = '') => ({ code: 0, out, err: '' }), bad = (err = 'error') => ({ code: 1, out: '', err });
		let x;
		if ((x = /^plugin is-active/.exec(a))) return wpState.active ? ok() : bad();
		if ((x = /^plugin activate/.exec(a))) { if (over.pluginMissing) return bad('Error: The plugin could not be found.'); wpState.active = true; return ok(); }
		if ((x = /^config get (\w+)/.exec(a))) return wpState.cfg[x[1]] ? ok(wpState.cfg[x[1]]) : bad();
		if ((x = /^config set (\w+) '?([^' ]*)'?/.exec(a))) { wpState.cfg[x[1]] = x[2]; return ok(); }
		if ((x = /^option get (\w+)/.exec(a))) return ok(wpState[x[1]]);
		if ((x = /^option update (\w+) '?([^']*)'?/.exec(a))) { wpState[x[1]] = x[2]; return ok(); }
		if ((x = /^search-replace '([^']*)' '([^']*)'/.exec(a))) { wpState.siteurl = wpState.siteurl.replace(x[1], x[2]); return ok(); }
		if (/preview_on/.test(a)) { wpState.blog_public = '0'; return ok(); }
		if (/'launch'/.test(a)) { wpState.blog_public = '1'; return ok(); }
		if (/cwai_sv/.test(a) && /get_option/.test(a)) return ok(wpState.sv);
		if (/cwai_sv/.test(a)) { wpState.sv = '1'; return ok(); }
		if (/^user list/.test(a)) return ok(wpState.users);
		if ((x = /^user create '([^']*)'/.exec(a))) { wpState.users = x[1]; return ok('7'); }
		return ok();
	};
	const c = {
		cfg: { ...baseCfg, ...(over.cfg || {}) },
		gateway: { available: () => true, mint: async (s) => (calls.gw.push(['mint', s]), { site: s, token: 'cwai_' + s + '_SECRETTOKEN', revoked: false }), site: async () => ({ revoked: !!over.revoked, caps: { tokens: 5000 } }), setCap: async (...a) => calls.gw.push(['cap', ...a]), revoke: async (...a) => { calls.gw.push(['revoke', ...a]); over.revoked = a[1]; }, tokenWorks: async () => true },
		cloudflare: {
			available: () => true,
			zoneByName: async (d) => zones.get(d) || null,
			createZone: async (d) => { const z = { id: 'z-' + d, name: d, status: 'pending', name_servers: ['a.ns.cloudflare.com', 'b.ns.cloudflare.com'] }; zones.set(d, z); recs.set(z.id, []); calls.cf.push(['zone', d]); return z; },
			zone: async (id) => [...zones.values()].find((z) => z.id === id),
			activationCheck: async (id) => { calls.cf.push(['activate', id]); const z = [...zones.values()].find((q) => q.id === id); z.status = 'active'; return true; },
			records: async (id) => recs.get(id) || [],
			createRecord: async (id, r) => { calls.cf.push(['create', r.type, r.name, r.content]); (recs.get(id) || recs.set(id, []).get(id)).push({ id: 'r' + Math.random(), ...r }); },
			updateRecord: async (id, rid, r) => { calls.cf.push(['update', r.type, r.name, r.content]); const l = recs.get(id); const i = l.findIndex((q) => q.id === rid); l[i] = { ...l[i], ...r }; },
		},
		postmark: { available: () => true, _d: null, domainByName: async function () { return c.postmark._d; }, createDomain: async (d) => (calls.pm.push(['create', d]), (c.postmark._d = { ID: 7, Name: d })), domain: async () => ({ ID: 7, DKIMPendingHost: '2026.pm._domainkey.grace.org', DKIMPendingTextValue: 'k=rsa;p=ABC', ReturnPathDomain: 'pm-bounces.grace.org', ReturnPathDomainCNAMEValue: 'pm.mtasv.net', DKIMVerified: !!c.postmark._v, ReturnPathDomainVerified: !!c.postmark._v }), verifyDkim: async () => { c.postmark._v = true; return {}; }, verifyReturnPath: async () => ({}), verifySpf: async () => ({}) },
		dns: {
			ns: async () => over.ns || ['ns1.duda.co'],
			a: async (d) => { const all = [...recs.values()].flat().filter((r) => r.type === 'A' && r.name === d).map((r) => r.content); return all.length ? all : over.a ? over.a(d) : []; },
			aaaa: async () => [], cname: async (d) => (over.cname ? over.cname(d) : []), mx: async () => over.mx || [{ exchange: 'aspmx.l.google.com', priority: 1 }], txt: async () => over.txt || [['v=spf1 include:_spf.google.com ~all']],
		},
		http: { get: async (u) => (over.http ? over.http(u) : { status: 200, headers: {}, location: '', text: '{"namespaces":["wp/v2"]}' }) },
		tls: async () => ({ authorized: true, validTo: 'Jan 1 2027' }),
		ssh: { available: () => !over.noSsh, exec },
	};
	return { c, calls, zones, recs, wpState };
}
const ctxOf = (f) => ({ c: f.c, configured: configured(f.c.cfg), memo: {}, facts: null, secret: null });
const states = (res) => Object.fromEntries(Object.entries(res).map(([k, v]) => [k, v.state]));

test('slugify, store, shell quoting, SPF merge', () => {
	assert.equal(slugify('St. Paul\'s & Friends'), 'st-paul-s-and-friends');
	const s = createStore(tmp());
	const ch = s.create({ name: 'Britannia United', domain: 'https://www.BritanniaUnited.ca/x', plan: 'email' });
	assert.equal(ch.slug, 'britannia-united'); assert.equal(ch.domain, 'britanniaunited.ca');
	assert.throws(() => s.create({ name: 'Britannia United' }), /already exists/);
	assert.throws(() => s.create({ name: 'Grace Church', domain: 'not a domain' }), /website address/);
	assert.equal(shq("O'Brien; rm -rf /"), "'O'\\''Brien; rm -rf /'");
	const m = mergeSpf(['v=spf1 include:_spf.google.com ~all', 'v=spf1 include:other.com ~all'], { includes: ['spf.mtasv.net'] });
	assert.equal((m.record.match(/v=spf1/g) || []).length, 1);
});

test('stage 1 tests: a fresh church shows what is missing, and later items wait for earlier ones', async () => {
	const f = fakes(); const ch = createStore(tmp()).create({ name: 'Grace Church' });
	const st = states(await testStage(ctxOf(f), ch, STAGES[0]));
	assert.deepEqual(st, { folder: 'ok', dns: 'no', plugin: 'no', connected: 'blocked', address: 'no', title: 'no', preview: 'blocked', oxygen: 'no' });
	assert.ok(f.calls.ssh.every((c) => !/config set|option update|search-replace|plugin activate/.test(c)), 'testing never changes anything');
});

test('a missing site: one clear "no", everything that needs it waits, nothing is changed', async () => {
	const f = fakes({ noFolder: true }); const ch = createStore(tmp()).create({ name: 'Grace Church' });
	const st = states(await testStage(ctxOf(f), ch, STAGES[0]));
	assert.equal(st.folder, 'no'); assert.equal(st.plugin, 'blocked'); assert.equal(st.address, 'blocked'); assert.equal(st.title, 'blocked');
	assert.ok(f.calls.ssh.every((c) => /^test -f/.test(c)));
});

test('without SSH, tests say they cannot look instead of failing', async () => {
	const f = fakes({ noSsh: true }); const ch = createStore(tmp()).create({ name: 'Grace Church' });
	const st = states(await testStage(ctxOf(f), ch, STAGES[0]));
	assert.equal(st.folder, 'unknown'); assert.equal(st.title, 'unknown', 'items after it still show, with hand-done help');
});

test('mailbox and manual items follow the ticks', async () => {
	const f = fakes(); const ch = createStore(tmp()).create({ name: 'Grace Church', domain: 'grace.org', plan: 'email' });
	ch.stages.approval = { manual: { approved: true, paid: true } };
	const st = states(await testStage(ctxOf(f), ch, STAGES[2]));
	assert.deepEqual(st, { domain: 'ok', approved: 'ok', plan: 'no', paid: 'ok', registrar: 'no' });
});

test('stage 2 reports Duda, Google email and duplicate SPF as facts', async () => {
	const f = fakes({ cname: (d) => (d.startsWith('www.') ? ['x.multiscreensite.com'] : []), txt: [['v=spf1 a ~all'], ['v=spf1 include:x.com ~all']] });
	const ch = createStore(tmp()).create({ name: 'Grace Church', domain: 'grace.org' });
	const res = await testStage(ctxOf(f), ch, STAGES[1]);
	assert.equal(res.web.state, 'warn'); assert.match(res.web.detail, /Duda/);
	assert.match(res.email.detail, /Google/); assert.equal(res.spf.state, 'warn');
});

// ---------- through the router, like the real page does it
async function app(f, store = createStore(tmp())) {
	const a = express(); a.use(express.json());
	a.use('/api/deploy', createDeployRouter({ need: (q, s, n) => { q.by = 'test'; n(); }, store, clients: f.c }));
	const srv = a.listen(0); const base = `http://127.0.0.1:${srv.address().port}/api/deploy`;
	const j = async (p, m = 'GET', b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { s: r.status, j: await r.json() }; };
	return { j, store, close: () => srv.close() };
}

test('"fix everything" repairs stage 1 in order, never leaks the key, and re-tests to confirm', async () => {
	const f = fakes(); const t = await app(f);
	try {
		await t.j('/churches', 'POST', { name: 'Grace Church', domain: 'grace.org' });
		let r = await t.j('/churches/grace-church/stages/preview/fix', 'POST', { req: 'all' }); assert.equal(r.s, 400, 'must confirm');
		r = await t.j('/churches/grace-church/stages/preview/fix', 'POST', { req: 'all', confirm: true }); assert.equal(r.s, 200);
		const res = r.j.church.stageStates.preview.results;
		assert.deepEqual(states(res), { folder: 'ok', dns: 'ok', plugin: 'ok', connected: 'ok', address: 'ok', title: 'ok', preview: 'ok', oxygen: 'no' });
		assert.equal(f.wpState.cfg.CWAI_API_KEY, 'cwai_grace-church_SECRETTOKEN');
		assert.equal(f.wpState.siteurl, 'https://grace-church.churchwebglobal.com');
		assert.equal(f.wpState.blogname, 'Grace Church'); assert.equal(f.wpState.blog_public, '0');
		assert.deepEqual(f.calls.gw.find((g) => g[0] === 'cap').slice(1), ['grace-church', 5000, 3]);
		assert.ok(!JSON.stringify(r.j).includes('SECRETTOKEN'), 'the key must never appear in a response');
		assert.ok(!JSON.stringify(t.store.get('grace-church')).includes('SECRETTOKEN'), 'or in storage');
		assert.equal(r.j.church.stageStates.preview.done, false, 'Oxygen licence still needs a human tick');
		r = await t.j('/churches/grace-church/stages/preview/manual', 'PUT', { id: 'oxygen', value: true });
		assert.equal(r.j.stageStates.preview.done, true);
	} finally { t.close(); }
});

test('a plugin that is not installed gives a plain instruction instead of an error dump', async () => {
	const f = fakes({ pluginMissing: true }); const t = await app(f);
	try {
		await t.j('/churches', 'POST', { name: 'Grace Church' });
		const r = await t.j('/churches/grace-church/stages/preview/fix', 'POST', { req: 'plugin', confirm: true });
		assert.equal(r.j.fixed[0].ok, false); assert.match(r.j.fixed[0].detail, /Upload churchweb-ai-assistant\.zip/);
	} finally { t.close(); }
});

test('without SSH the fix button hands back the exact commands to run by hand', async () => {
	const f = fakes({ noSsh: true }); const t = await app(f);
	try {
		await t.j('/churches', 'POST', { name: 'Grace Church' });
		const r = await t.j('/churches/grace-church/stages/preview/fix', 'POST', { req: 'title', confirm: true });
		assert.equal(r.j.fixed[0].ok, false); assert.match(r.j.fixed[0].howTo, /option update blogname 'Grace Church'/);
	} finally { t.close(); }
});

test('stages 4 and 7 are gated until approval and DNS are done', async () => {
	const f = fakes(); const t = await app(f);
	try {
		await t.j('/churches', 'POST', { name: 'Grace Church', domain: 'grace.org' });
		let r = await t.j('/churches/grace-church/stages/dns/fix', 'POST', { req: 'zone', confirm: true });
		assert.equal(r.s, 409); assert.match(r.j.error, /Approval and payment/);
		r = await t.j('/churches/grace-church/stages/sending/fix', 'POST', { req: 'pm', confirm: true });
		assert.equal(r.s, 409);
	} finally { t.close(); }
});

test('stage 4: zone, records, nameserver wait, then website records, never deleting', async () => {
	const f = fakes({ a: (d) => (d === 'grace.org' ? ['9.9.9.9'] : []) }); const t = await app(f);
	try {
		await t.j('/churches', 'POST', { name: 'Grace Church', domain: 'grace.org' });
		for (const id of ['approved', 'plan', 'paid', 'registrar']) await t.j('/churches/grace-church/stages/approval/manual', 'PUT', { id, value: true });
		await t.j('/churches/grace-church/stages/approval/check', 'POST', {});
		let r = await t.j('/churches/grace-church/stages/dns/fix', 'POST', { req: 'all', confirm: true });
		assert.equal(r.s, 200);
		let st = states(r.j.church.stageStates.dns.results);
		assert.equal(st.zone, 'ok'); assert.equal(st.records, 'ok'); assert.equal(st.ns, 'no'); assert.equal(st.site, 'blocked');
		assert.match(r.j.church.stageStates.dns.results.ns.detail, /a\.ns\.cloudflare\.com/);
		// the church switches their nameservers
		f.c.dns.ns = async () => ['a.ns.cloudflare.com', 'b.ns.cloudflare.com'];
		r = await t.j('/churches/grace-church/stages/dns/fix', 'POST', { req: 'all', confirm: true });
		st = states(r.j.church.stageStates.dns.results);
		assert.deepEqual(st, { zone: 'ok', records: 'ok', ns: 'ok', site: 'ok' });
		assert.ok(f.calls.cf.some((c) => c[0] === 'update' || (c[0] === 'create' && c[1] === 'A' && c[2] === 'grace.org' && c[3] === '1.2.3.4')) || f.recs.get('z-grace.org').some((x) => x.content === '1.2.3.4'));
		assert.ok(!f.calls.cf.some((c) => c[0] === 'delete'));
		assert.equal(r.j.church.stageStates.dns.done, true);
	} finally { t.close(); }
});

test('stage 6: passwords shown once and never stored; MX switch needs the ticks and its own confirmation', async () => {
	const f = fakes(); const t = await app(f);
	try {
		await t.j('/churches', 'POST', { name: 'Grace Church', domain: 'grace.org', plan: 'email' });
		for (const id of ['approved', 'plan', 'paid', 'registrar']) await t.j('/churches/grace-church/stages/approval/manual', 'PUT', { id, value: true });
		await t.j('/churches/grace-church/stages/approval/check', 'POST', {});
		let r = await t.j('/churches/grace-church/stages/mailboxes/fix', 'POST', { req: 'boxes', confirm: true });
		assert.equal(r.s, 200); assert.match(r.j.secret.boxes[0].address, /@grace\.org$/);
		assert.ok(!JSON.stringify(t.store.get('grace-church')).includes(r.j.secret.boxes[0].password));
		r = await t.j('/churches/grace-church/stages/mailboxes/fix', 'POST', { req: 'mx', confirm: true });
		assert.equal(r.j.fixed[0].ok, false); assert.match(r.j.fixed[0].detail, /Waiting/);
		for (const id of ['boxes', 'moved']) await t.j('/churches/grace-church/stages/mailboxes/manual', 'PUT', { id, value: true });
		await f.c.cloudflare.createZone('grace.org');
		r = await t.j('/churches/grace-church/stages/mailboxes/fix', 'POST', { req: 'all', confirm: true });
		assert.ok(!f.calls.cf.some((c) => c[1] === 'MX'), '"fix everything" must never switch the MX');
		r = await t.j('/churches/grace-church/stages/mailboxes/fix', 'POST', { req: 'mx', confirm: true });
		assert.ok(f.calls.cf.some((c) => c[0] === 'create' && c[1] === 'MX' && c[3] === 'mail.churchwebglobal.com'));
	} finally { t.close(); }
});

test('stage 7: Postmark domain, records, one SPF, verification, and the site\'s mail settings', async () => {
	const f = fakes(); const t = await app(f);
	try {
		await t.j('/churches', 'POST', { name: 'Grace Church', domain: 'grace.org' });
		await f.c.cloudflare.createZone('grace.org'); f.recs.get('z-grace.org').push({ id: 'old', type: 'TXT', name: 'grace.org', content: 'v=spf1 include:_spf.google.com ~all' });
		await t.store.update('grace-church', (c) => { c.stages.dns = { done: true }; });
		const r = await t.j('/churches/grace-church/stages/sending/fix', 'POST', { req: 'all', confirm: true });
		assert.equal(r.s, 200);
		const st = states(r.j.church.stageStates.sending.results);
		assert.deepEqual({ ...st, testmail: 'x' }, { pm: 'ok', pmdns: 'ok', auth: 'ok', verified: 'ok', smtp: 'ok', testmail: 'x' });
		assert.equal(f.recs.get('z-grace.org').filter((x) => x.type === 'TXT' && /v=spf1/.test(x.content)).length, 1);
		assert.ok(/spf\.mtasv\.net/.test(f.recs.get('z-grace.org').find((x) => /v=spf1/.test(x.content)).content));
		assert.equal(f.wpState.cfg.WPMS_SMTP_HOST, 'smtp.postmarkapp.com');
		assert.ok(!JSON.stringify(r.j).includes('SRVTOK'));
	} finally { t.close(); }
});

test('stage 8: login created once with the password shown once; staff view and gateway switch', async () => {
	const f = fakes({ revoked: true }); const t = await app(f);
	try {
		await t.j('/churches', 'POST', { name: 'Grace Church', domain: 'grace.org', contactEmail: 'office@grace.org' });
		await t.store.update('grace-church', (c) => { c.stages.golive = { done: true }; });
		const r = await t.j('/churches/grace-church/stages/handover/fix', 'POST', { req: 'all', confirm: true });
		assert.equal(r.s, 200); assert.equal(r.j.secret.login, 'grace-church-admin'); assert.ok(r.j.secret.password.length >= 16);
		assert.ok(!JSON.stringify(t.store.get('grace-church')).includes(r.j.secret.password));
		const st = states(r.j.church.stageStates.handover.results);
		assert.equal(st.login, 'ok'); assert.equal(st.staffview, 'ok'); assert.equal(st.gateway, 'ok');
	} finally { t.close(); }
});

test('error text is readable; Hostinger variable names are understood; pasted tokens are cleaned', () => {
	assert.equal(errText({ data: { type: 'error', error: { type: 'not_found_error', message: 'Not found' } }, status: 404 }), 'Not found');
	assert.equal(errText({ data: { errors: [{ message: 'Authentication error' }] }, status: 403 }, 'fix it'), 'Authentication error (fix it)');
	assert.ok(!errText({ data: { error: { x: 1 } }, status: 500 }).includes('[object'));
	const cfg = configFromEnv({ HOSTINGER_IP: '1.2.3.4', HOSTINGER_USERNAME: 'u123', HOSTINGER_PORT: '65002', SSH_PASSWORD: 'p' });
	assert.deepEqual([cfg.sshHost, cfg.sshUser, cfg.sshPort, configured(cfg).ssh], ['1.2.3.4', 'u123', 65002, true]);
	assert.equal(configFromEnv({ CLOUDFLARE_API_TOKEN: ' "Bearer abc123"\n' }).cloudflareToken, 'abc123');
});

test('every stage has plain-language questions only', () => {
	for (const s of STAGES) for (const q of s.reqs) assert.ok(q.label.length > 10 && /[?]$/.test(q.label), `${s.key}.${q.id}`);
});
