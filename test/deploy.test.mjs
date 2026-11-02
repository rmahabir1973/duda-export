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
const baseCfg = { gatewayUrl: 'https://gw', gatewayAdminKey: 'k', previewZoneId: 'pz', previewDomain: 'churchwebglobal.com', hostingerIp: '1.2.3.4', templateSlug: 'build2', siteRoot: '/h/{host}', wpCli: 'wp', ourMxHosts: ['mail.churchwebglobal.com'], mailHost: 'mail.churchwebglobal.com', dudaIps: ['9.9.9.9'], postmarkServerToken: 'SRVTOK', postmarkAccountToken: 'ACC', cloudflareToken: 't', cloudflareAccountId: 'a', sshHost: 'h', sshUser: 'u', sshKey: 'k', defaultTokenCap: 5000, defaultImageCap: 3, hostingerApiKey: 'HK', wpAdminEmail: 'ops@example.com' };

/** Fake services with a tiny pretend WordPress that answers the WP-CLI commands the checklist uses. */
function fakes(over = {}) {
	const calls = { ssh: [], cf: [], pm: [], gw: [] };
	const zones = new Map(), recs = new Map([['pz', []]]);
	const wpState = { siteurl: 'https://build2.churchwebglobal.com', blogname: 'Template', blog_public: '1', active: false, activePlugins: [], installed: !over.noFolder, sv: '0', users: '', cfg: {}, ...(over.wp || {}) };
	const TPL = ['churchweb-ai-assistant', 'oxygen', 'seo-by-rank-math'];
	const sites = new Set(over.sites || ['grace-church.churchwebglobal.com', 'build2.churchwebglobal.com']);
	const exec = async (cmd) => {
		calls.ssh.push(cmd);
		if (/^test -f/.test(cmd)) return /build2/.test(cmd) || wpState.installed ? { code: 0, out: 'FOUND', err: '' } : { code: 1, out: '', err: '' };
		if (/cp -a/.test(cmd)) { const m2 = /plugins\/([A-Za-z0-9._-]+) /.exec(cmd); if (m2) wpState.activePlugins.push('copied:' + m2[1]); return { code: 0, out: '', err: '' }; }
		const m = /&& wp (.*)$/s.exec(cmd); const a = m ? m[1] : '';
		const ok = (out = '') => ({ code: 0, out, err: '' }), bad = (err = 'error') => ({ code: 1, out: '', err });
		let x;
		if (/^plugin list --status=active --field=name/.test(a)) return ok((/build2/.test(cmd) ? TPL : wpState.activePlugins.map((n) => n.replace('copied:', ''))).join('\n'));
		if ((x = /^plugin is-active/.exec(a))) return wpState.active ? ok() : bad();
		if ((x = /^plugin activate/.exec(a))) { if (over.pluginMissing) return bad('Error: The plugin could not be found.'); const names = [...a.matchAll(/'([^']+)'|(churchweb-ai-assistant)/g)].map((q) => q[1] || q[2]); if (names.includes('churchweb-ai-assistant')) wpState.active = true; return ok(); }
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
		hostinger: {
			available: () => !over.noHostingerApi,
			websites: async () => [...sites].map((d) => ({ domain: d, username: 'u1', order_id: 5, website_type: 'wordpress' })),
			account: async () => ({ username: 'u1', order_id: 5 }),
			createWebsite: async (d, o) => { calls.hst = calls.hst || []; calls.hst.push(['create', d, o]); sites.add(d); },
			installWordPress: async (u, b) => { calls.hst = calls.hst || []; calls.hst.push(['wp', u, b]); wpState.installed = true; },
			addParkedDomain: async (u, site, parked) => { calls.hst = calls.hst || []; calls.hst.push(['parked', u, site, parked]); },
			installSsl: async (u, d) => { calls.hst = calls.hst || []; calls.hst.push(['ssl', u, d]); },
			deleteWebsite: async (d) => { calls.hst = calls.hst || []; calls.hst.push(['delete', d]); sites.delete(d); },
		},
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
	assert.deepEqual(st, { site: 'ok', folder: 'ok', dns: 'no', plugins: 'no', plugin: 'blocked', connected: 'blocked', address: 'no', title: 'no', preview: 'blocked', oxygen: 'no' });
	assert.ok(f.calls.ssh.every((c) => !/config set|option update|search-replace|plugin activate/.test(c)), 'testing never changes anything');
});

test('a missing site: one clear "no", everything that needs it waits, nothing is changed', async () => {
	const f = fakes({ noFolder: true }); const ch = createStore(tmp()).create({ name: 'Grace Church' });
	const st = states(await testStage(ctxOf(f), ch, STAGES[0]));
	assert.equal(st.folder, 'no'); assert.equal(st.plugins, 'blocked'); assert.equal(st.plugin, 'blocked'); assert.equal(st.address, 'blocked'); assert.equal(st.title, 'blocked');
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
		assert.deepEqual(states(res), { site: 'ok', folder: 'ok', dns: 'ok', plugins: 'ok', plugin: 'ok', connected: 'ok', address: 'ok', title: 'ok', preview: 'ok', oxygen: 'no' });
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
	const f = fakes({ pluginMissing: true, wp: { activePlugins: ['churchweb-ai-assistant', 'oxygen', 'seo-by-rank-math'], active: false } }); const t = await app(f);
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

// ---------------------------------------------------------------- email setup
import { makeSmarterMail } from '../deploy/smartermail.mjs';
import { parseInput, createMailboxes, enablePostmark, healthCheck, sendTest } from '../deploy/email.mjs';

const PW = 'Sunday-Best-2026!';
/** A pretend SmarterMail server that records every request. */
function fakeMail({ domainExists = false, sysCanAddUsers = true, domainPathError = false } = {}) {
	const calls = [];
	const fetch = async (url, o) => {
		const path = new URL(url).pathname, body = o.body ? JSON.parse(o.body) : null, auth = (o.headers || {}).authorization || '';
		calls.push({ path, body, auth });
		const reply = (status, data) => ({ ok: status < 400, status, text: async () => JSON.stringify(data) });
		if (path === '/api/v1/auth/authenticate-user') return body.password === PW || body.username === 'admin' ? reply(200, { accessToken: 'tok-' + body.username, refreshToken: 'r' }) : reply(401, { message: 'bad' });
		if (path === '/api/v1/settings/sysadmin/domain-put') return domainPathError ? reply(400, { success: false, message: 'The path is not valid' }) : domainExists ? reply(200, { success: false, message: 'Domain already exists' }) : reply(200, { success: true });
		if (path === '/api/v1/settings/domain/user-put') return auth === 'Bearer tok-admin' && !sysCanAddUsers ? reply(401, { message: 'domain admins only' }) : body.userData.userName === 'dup' ? reply(400, { success: false, message: 'User already exists' }) : reply(200, { success: true });
		return reply(404, {});
	};
	return { calls, fetch };
}
const smCtx = (m, over = {}) => {
	const cfg = { ...baseCfg, smartermailUrl: 'https://mail.churchwebglobal.com', smartermailUser: 'admin', smartermailPassword: 'sysadmin-secret', smartermailDomainPath: 'C:\\SmarterMail\\Domains\\{domain}', smartermailDomainAdmin: 'postmaster', ...over };
	return { c: { cfg, smartermail: makeSmarterMail(cfg, { fetch: m.fetch }) }, configured: {}, memo: {} };
};

test('email form: validation says what is wrong in plain words', () => {
	assert.throws(() => parseInput({ domain: 'nope', addresses: 'a', password: PW }), /domain/);
	assert.throws(() => parseInput({ domain: 'grace.org', addresses: '', password: PW }), /at least one/);
	assert.throws(() => parseInput({ domain: 'grace.org', addresses: 'office', password: 'short' }), /12 characters/);
	assert.throws(() => parseInput({ domain: 'grace.org', addresses: 'office', password: 'alllowercase1234' }), /capital/);
	assert.throws(() => parseInput({ domain: 'grace.org', addresses: 'a@other.org', password: PW }), /isn't on grace\.org/);
	assert.throws(() => parseInput({ domain: 'grace.org', addresses: 'bad name!', password: PW }), /valid mailbox/);
	const ok = parseInput({ domain: 'https://www.Grace.org/', addresses: 'Office, pastor@grace.org\noffice', password: PW });
	assert.deepEqual([ok.domain, ok.names], ['grace.org', ['office', 'pastor']]);
});

test('create: logs in, adds the domain with the documented body, then each mailbox; no password in the output', async () => {
	const m = fakeMail(), ctx = smCtx(m);
	const items = await createMailboxes(ctx, parseInput({ domain: 'grace.org', addresses: 'office, pastor', password: PW }));
	assert.deepEqual(m.calls.map((c) => c.path), ['/api/v1/auth/authenticate-user', '/api/v1/settings/sysadmin/domain-put', '/api/v1/settings/domain/user-put', '/api/v1/settings/domain/user-put']);
	const dom = m.calls[1].body;
	assert.equal(dom.domainData.name, 'grace.org'); assert.equal(dom.domainData.path, 'C:\\SmarterMail\\Domains\\grace.org'); assert.equal(dom.domainData.hostname, 'mail.churchwebglobal.com');
	assert.equal(dom.domainLocation, 'Local'); assert.equal(dom.adminUsername, 'postmaster'); assert.equal(dom.adminPassword, PW);
	assert.equal(m.calls[1].auth, 'Bearer tok-admin');
	assert.deepEqual(m.calls[2].body.userData, { userName: 'office', password: PW, fullName: 'office', domain: 'grace.org' });
	assert.ok(items.every((i) => i.state === 'ok'), JSON.stringify(items));
	assert.ok(!JSON.stringify(items).includes(PW) && !JSON.stringify(items).includes('sysadmin-secret'));
});

test('create: preview changes nothing; an existing domain and an existing mailbox are not errors', async () => {
	let m = fakeMail(); let items = await createMailboxes(smCtx(m), parseInput({ domain: 'grace.org', addresses: 'office', password: PW }), { dry: true });
	assert.equal(m.calls.length, 0); assert.match(items[0].detail, /C:\\SmarterMail\\Domains\\grace\.org/);
	m = fakeMail({ domainExists: true }); items = await createMailboxes(smCtx(m), parseInput({ domain: 'grace.org', addresses: 'dup, new', password: PW }));
	assert.deepEqual(items.map((i) => i.state), ['ok', 'ok', 'ok']); assert.match(items[0].label, /already exists/); assert.match(items[1].detail, /Already existed/);
});

test('create: falls back to the domain administrator when the system admin cannot add users', async () => {
	const m = fakeMail({ sysCanAddUsers: false }), items = await createMailboxes(smCtx(m), parseInput({ domain: 'grace.org', addresses: 'office', password: PW }));
	assert.ok(items.every((i) => i.state === 'ok'), JSON.stringify(items));
	assert.ok(m.calls.some((c) => c.path.endsWith('authenticate-user') && c.body.username === 'postmaster@grace.org'));
});

test('create: a bad folder path gives a plain hint, and a wrong login says so', async () => {
	let items = await createMailboxes(smCtx(fakeMail({ domainPathError: true })), parseInput({ domain: 'grace.org', addresses: 'office', password: PW }));
	assert.equal(items.length, 1); assert.match(items[0].detail, /SMARTERMAIL_DOMAIN_PATH/);
	const m = fakeMail(); const ctx = smCtx(m); ctx.c.smartermail = makeSmarterMail({ ...ctx.c.cfg, smartermailUser: 'someone' }, { fetch: m.fetch });
	items = await createMailboxes(ctx, parseInput({ domain: 'grace.org', addresses: 'office', password: PW }));
	assert.equal(items[0].state, 'error'); assert.match(items[0].label, /sign in/);
});

test('health check: reports good and bad mail DNS like an MX toolbox', async () => {
	const dnsData = { mx: [{ exchange: 'mail.churchwebglobal.com', priority: 10 }], a: { 'mail.churchwebglobal.com': ['5.6.7.8'] }, txt: { 'grace.org': [['v=spf1 include:spf.mtasv.net a:mail.churchwebglobal.com ~all']], '_dmarc.grace.org': [] }, ptr: ['mail.churchwebglobal.com'] };
	const c = { cfg: baseCfg, dns: { mx: async () => dnsData.mx, a: async (n) => dnsData.a[n] || [], cname: async () => [], txt: async (n) => dnsData.txt[n] || [], ptr: async () => dnsData.ptr }, tls: async () => ({ authorized: true, validTo: 'Jan 1 2027' }), probe: async (h, p) => ({ open: p === 587 }), postmark: { available: () => true, domainByName: async () => ({ ID: 7 }), domain: async () => ({ DKIMVerified: true, ReturnPathDomainVerified: false }) } };
	const st = Object.fromEntries((await healthCheck({ c }, 'grace.org')).map((i) => [i.id, i.state]));
	assert.deepEqual([st.mx, st.mxhost, st.ptr, st.p587, st.p993, st.cert, st.spf, st.dmarc, st.dkim, st.rp], ['ok', 'ok', 'ok', 'ok', 'warn', 'ok', 'ok', 'warn', 'ok', 'no']);
	dnsData.mx = []; dnsData.txt['grace.org'] = [['v=spf1 a ~all'], ['v=spf1 mx ~all']];
	const bad = Object.fromEntries((await healthCheck({ c }, 'grace.org')).map((i) => [i.id, i.state]));
	assert.deepEqual([bad.mx, bad.spf], ['no', 'no']);
});

test('test email goes through Postmark from an address on the church domain', async () => {
	let sent; const ctx = { c: { cfg: baseCfg, postmark: { sendEmail: async (m) => ((sent = m), { MessageID: 'abc' }) } } };
	const r = await sendTest(ctx, 'grace.org', 'me@example.com');
	assert.equal(sent.From, 'test@grace.org'); assert.equal(sent.To, 'me@example.com'); assert.match(r[0].detail, /abc/);
	await assert.rejects(() => sendTest(ctx, 'grace.org', 'nope'), /address/);
});

test('enable Postmark: sets up the domain, DNS records and one SPF using the same checks as stage 7', async () => {
	const f = fakes(); await f.c.cloudflare.createZone('grace.org');
	const ctx = { c: f.c, configured: configured(f.c.cfg), memo: {} };
	const dry = await enablePostmark(ctx, 'grace.org', { dry: true });
	assert.equal(f.calls.pm.length, 0); assert.ok(dry.some((i) => /Would/.test(i.detail)));
	const items = await enablePostmark(ctx, 'grace.org');
	assert.deepEqual(items.map((i) => i.state), ['ok', 'ok', 'ok', 'ok']);
	assert.ok(f.calls.pm.some((c) => c[0] === 'create' && c[1] === 'grace.org'));
	assert.equal(f.recs.get('z-grace.org').filter((x) => /v=spf1/.test(x.content)).length, 1);
});

test('Hostinger access test: reads the website list, shows names and field names, never the key', async () => {
	const calls = []; const mk = (status, data) => ({ ...makeFakeClients(), });
	function makeFakeClients() { return {}; }
	const f = fakes();
	f.c.hostinger = { available: () => true, get: async (p) => { calls.push(p); return { ok: true, status: 200, data: { data: [{ domain: 'build1.churchwebglobal.com', order_id: 5, username: 'u1' }, { domain: 'build2.churchwebglobal.com' }] } }; } };
	const t = await app(f);
	try {
		const r = await t.j('/hostinger-probe', 'POST', {});
		assert.deepEqual(calls, ['/api/hosting/v1/websites']);
		assert.equal(r.j.items[0].state, 'ok'); assert.match(r.j.items[1].detail, /build2\.churchwebglobal\.com/); assert.match(r.j.items[2].detail, /order_id/);
		f.c.hostinger.get = async () => ({ ok: false, status: 401, data: { message: 'Unauthenticated' } });
		const bad = await t.j('/hostinger-probe', 'POST', {});
		assert.equal(bad.j.items[0].state, 'no'); assert.match(bad.j.items[0].detail, /HOSTINGER_API_KEY/);
		f.c.hostinger.available = () => false;
		assert.match((await t.j('/hostinger-probe', 'POST', {})).j.items[0].label, /No Hostinger API key/);
	} finally { t.close(); }
});

test('a brand-new customer: creates the site on Hostinger, installs WordPress, copies the plugins, connects it', async () => {
	const f = fakes({ sites: ['build2.churchwebglobal.com'], wp: { installed: false } }); const t = await app(f);
	try {
		await t.j('/churches', 'POST', { name: 'Grace Church', domain: 'grace.org' });
		let r = await t.j('/churches/grace-church/stages/preview/fix', 'POST', { req: 'all', confirm: true });
		assert.equal(r.s, 200);
		assert.deepEqual(f.calls.hst[0], ['create', 'grace-church.churchwebglobal.com', 5]);
		const wp = f.calls.hst.find((c) => c[0] === 'wp');
		assert.equal(wp[1], 'u1'); assert.equal(wp[2].domain, 'grace-church.churchwebglobal.com'); assert.equal(wp[2].site_title, 'Grace Church');
		assert.equal(wp[2].credentials.login, 'cwadmin'); assert.equal(wp[2].credentials.email, 'ops@example.com'); assert.ok(wp[2].credentials.password.length >= 16);
		assert.equal(r.j.secret.password, wp[2].credentials.password, 'the new site login is shown once');
		assert.ok(!JSON.stringify(t.store.get('grace-church')).includes(wp[2].credentials.password), 'and never stored');
		assert.deepEqual(states(r.j.church.stageStates.preview.results), { site: 'ok', folder: 'ok', dns: 'ok', plugins: 'ok', plugin: 'ok', connected: 'ok', address: 'ok', title: 'ok', preview: 'ok', oxygen: 'no' });
		assert.deepEqual(f.wpState.activePlugins.filter((x) => x.startsWith('copied:')).sort(), ['copied:churchweb-ai-assistant', 'copied:oxygen', 'copied:seo-by-rank-math']);
	} finally { t.close(); }
});

test('WordPress needs an admin email: asks for it plainly when none is set', async () => {
	const f = fakes({ sites: ['grace-church.churchwebglobal.com', 'build2.churchwebglobal.com'], wp: { installed: false }, cfg: { wpAdminEmail: '' } }); const t = await app(f);
	try {
		await t.j('/churches', 'POST', { name: 'Grace Church' });
		const r = await t.j('/churches/grace-church/stages/preview/fix', 'POST', { req: 'folder', confirm: true });
		assert.equal(r.j.fixed[0].ok, false); assert.match(r.j.fixed[0].detail, /admin email/);
		assert.ok(!(f.calls.hst || []).some((c) => c[0] === 'wp'));
	} finally { t.close(); }
});

test('go live: adds the real domain to the site and asks for the certificate through the API', async () => {
	const f = fakes({ http: () => ({ status: 200, headers: {}, location: '', text: '<html>old site</html>' }) }); const t = await app(f);
	try {
		await t.j('/churches', 'POST', { name: 'Grace Church', domain: 'grace.org' });
		await t.store.update('grace-church', (c) => { c.stages.dns = { done: true }; });
		let r = await t.j('/churches/grace-church/stages/golive/fix', 'POST', { req: 'added', confirm: true });
		assert.deepEqual(f.calls.hst.find((c) => c[0] === 'parked'), ['parked', 'u1', 'grace-church.churchwebglobal.com', 'grace.org']);
		f.c.http.get = async () => ({ status: 200, headers: {}, location: '', text: '{"namespaces":["wp/v2"]}' });
		f.c.tls = async () => ({ authorized: false, error: 'CERT_HAS_EXPIRED' });
		r = await t.j('/churches/grace-church/stages/golive/fix', 'POST', { req: 'ssl', confirm: true });
		assert.deepEqual(f.calls.hst.find((c) => c[0] === 'ssl'), ['ssl', 'u1', 'grace.org']);
		assert.equal(r.j.fixed[0].ok, true);
	} finally { t.close(); }
});

test('deleting a customer: needs the short name; can also remove their preview site; refuses template and live sites', async () => {
	const f = fakes({ sites: ['grace-church.churchwebglobal.com', 'build2.churchwebglobal.com', 'build1.churchwebglobal.com'] }); const t = await app(f);
	try {
		await t.j('/churches', 'POST', { name: 'Grace Church', domain: 'grace.org' });
		let r = await t.j('/churches/grace-church', 'DELETE', { confirm: 'wrong' }); assert.equal(r.s, 400); assert.ok(t.store.get('grace-church'));
		// a customer whose short name is a template/build site can never delete that site
		await t.j('/churches', 'POST', { name: 'Build Two', slug: 'build2' }); await t.store.update('build2', () => {});
		r = await t.j('/churches/build2', 'DELETE', { confirm: 'build2', deleteSite: true });
		assert.equal(r.s, 400); assert.match(r.j.error, /template or build/); assert.ok(!(f.calls.hst || []).some((c) => c[0] === 'delete'));
		// a live customer's site is never deleted by this button
		await t.store.update('grace-church', (c) => { c.stages.golive = { done: true }; });
		r = await t.j('/churches/grace-church', 'DELETE', { confirm: 'grace-church', deleteSite: true }); assert.equal(r.s, 400); assert.match(r.j.error, /is live/);
		await t.store.update('grace-church', (c) => { c.stages.golive = { done: false }; });
		// the normal case: remove the customer and only their own preview site
		r = await t.j('/churches/grace-church', 'DELETE', { confirm: 'grace-church', deleteSite: true });
		assert.equal(r.s, 200); assert.deepEqual(f.calls.hst.filter((c) => c[0] === 'delete'), [['delete', 'grace-church.churchwebglobal.com']]);
		assert.equal(t.store.get('grace-church'), null);
		assert.ok(f.calls.gw.some((g) => g[0] === 'revoke' && g[1] === 'grace-church'), 'the AI key is switched off');
		// without the option the Hostinger site is left alone
		await t.j('/churches', 'POST', { name: 'Keep Me' }); f.c.hostinger.websites = async () => [{ domain: 'keep-me.churchwebglobal.com', username: 'u1', order_id: 5 }];
		const before = f.calls.hst.length; r = await t.j('/churches/keep-me', 'DELETE', { confirm: 'keep-me' });
		assert.equal(r.s, 200); assert.equal(f.calls.hst.length, before);
	} finally { t.close(); }
});

test('"fix everything" keeps going past a failed fix; only the items that depend on it wait', async () => {
	const f = fakes({ wp: { activePlugins: ['churchweb-ai-assistant', 'oxygen', 'seo-by-rank-math'], active: true } }); const t = await app(f);
	f.c.gateway.mint = async () => { throw new Error('Gateway: Not found'); };
	try {
		await t.j('/churches', 'POST', { name: 'Grace Church', domain: 'grace.org' });
		const r = await t.j('/churches/grace-church/stages/preview/fix', 'POST', { req: 'all', confirm: true });
		const st = states(r.j.church.stageStates.preview.results);
		assert.equal(st.connected, 'error', 'the gateway problem is reported');
		assert.equal(st.title, 'ok'); assert.equal(st.address, 'ok'); assert.equal(st.dns, 'ok');
		assert.equal(st.preview, 'ok', 'preview mode was still fixed');
		assert.equal(r.j.fixed.find((x) => x.id === 'connected').ok, false);
	} finally { t.close(); }
});
