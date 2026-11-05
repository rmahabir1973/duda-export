import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { pgliteDb, migrate } from '../portal/db.mjs';
import { createAuth, createAudit, hashPassword, verifyPassword, checkPassword, hotp, b32encode, b32decode, totpNow, checkTotp, seal, unseal } from '../portal/auth.mjs';
import { parseCsv, toRecords, createDirectory, hostOf, emailDomain } from '../portal/directory.mjs';
import { createPortal } from '../portal/routes.mjs';
import { verifyAccessJwt } from '../portal/access.mjs';

const KEY = 'test-encryption-key';
const PW = 'Correct-Horse-9';
const fresh = async () => { const db = pgliteDb(new PGlite()); await migrate(db); return db; };

test('2FA codes match the RFC 6238 test vector, and drift is limited to one step', () => {
	const secret = Buffer.from('12345678901234567890');
	assert.equal(hotp(secret, Math.floor(59 / 30)), '287082');
	assert.equal(hotp(secret, Math.floor(1111111109 / 30)), '081804');
	const b = b32encode(secret); assert.deepEqual(b32decode(b), secret);
	const now = 1_700_000_000_000;
	assert.ok(checkTotp(b, totpNow(b, now), 0, now));
	assert.ok(checkTotp(b, totpNow(b, now - 30000), 0, now), 'one step late is fine');
	assert.equal(checkTotp(b, totpNow(b, now - 90000), 0, now), 0, 'three steps old is not');
	const step = checkTotp(b, totpNow(b, now), 0, now);
	assert.equal(checkTotp(b, totpNow(b, now), step, now), 0, 'the same code cannot be used twice');
	assert.equal(checkTotp(b, '12345', 0, now), 0); assert.equal(checkTotp(b, 'abcdef', 0, now), 0);
});

test('secrets are sealed with AES-GCM: round-trips, and fails with the wrong key or a tampered value', () => {
	const s = seal('JBSWY3DPEHPK3PXP', KEY);
	assert.equal(unseal(s, KEY), 'JBSWY3DPEHPK3PXP'); assert.notEqual(s, seal('JBSWY3DPEHPK3PXP', KEY));
	assert.throws(() => unseal(s, 'other-key'));
	const bad = Buffer.from(s, 'base64url'); bad[bad.length - 1] ^= 1; assert.throws(() => unseal(bad.toString('base64url'), KEY));
});

test('passwords: scrypt hashes verify, are salted, and weak ones are refused', async () => {
	const h = await hashPassword(PW);
	assert.ok(await verifyPassword(PW, h)); assert.ok(!(await verifyPassword('wrong', h))); assert.notEqual(h, await hashPassword(PW));
	assert.match(checkPassword('short1A'), /12 characters/); assert.match(checkPassword('alllowercase12345'), /capital/); assert.equal(checkPassword(PW), '');
});

test('sign-in: password first, then 2FA enrolment; nothing opens until both are done; tokens are not stored in the clear', async () => {
	const db = await fresh(), auth = createAuth(db, { encryptionKey: KEY });
	const s = await auth.login('boss@example.org', PW, { bootstrapPassword: PW });
	assert.equal(s.need, 'enroll'); assert.equal(s.first, true); assert.equal(s.user.role, 'admin');
	assert.equal(await auth.lookup(s.token), null, 'a password-only session can not open anything');
	const { secret } = await auth.enrolStart(s.token);
	await assert.rejects(() => auth.enrolFinish(s.token, '000000'), /isn't right/);
	const full = await auth.enrolFinish(s.token, totpNow(secret));
	assert.equal(full.recoveryCodes.length, 8); assert.ok(/^[a-z2-7]{5}-[a-z2-7]{5}$/.test(full.recoveryCodes[0]));
	assert.equal((await auth.lookup(full.token)).email, 'boss@example.org'); assert.equal(await auth.lookup(s.token), null, 'the pre-login token is dead: a new one is issued');
	const raw = JSON.stringify(await db.query('select * from sessions')) + JSON.stringify(await db.query('select totp_secret, totp_pending, recovery_codes, password_hash from users'));
	assert.ok(!raw.includes(full.token) && !raw.includes(secret) && !raw.includes(full.recoveryCodes[0]) && !raw.includes(PW), 'no token, secret, recovery code or password is stored in the clear');
});

test('sign-in with 2FA: wrong and replayed codes fail, recovery codes work once, five wrong codes lock the account', async () => {
	const db = await fresh(), auth = createAuth(db, { encryptionKey: KEY });
	const s = await auth.login('a@example.org', PW, { bootstrapPassword: PW }); const { secret } = await auth.enrolStart(s.token);
	const e = await auth.enrolFinish(s.token, totpNow(secret));
	// next login: needs a code
	let l = await auth.login('a@example.org', PW); assert.equal(l.need, 'code');
	await assert.rejects(() => auth.secondFactor(l.token, totpNow(secret)), /isn't right/); // that code was used to enrol
	const ok = await auth.secondFactor(l.token, totpNow(secret, Date.now() + 30000)); assert.ok(ok.token);
	l = await auth.login('a@example.org', PW);
	await assert.rejects(() => auth.secondFactor(l.token, totpNow(secret, Date.now() + 30000)), /isn't right/); // replay
	// recovery code: once
	const rc = e.recoveryCodes[0];
	const viaRecovery = await auth.secondFactor(l.token, rc); assert.equal(viaRecovery.usedRecovery, true); assert.equal(viaRecovery.recoveryLeft, 7);
	l = await auth.login('a@example.org', PW); await assert.rejects(() => auth.secondFactor(l.token, rc), /isn't right/);
	// lockout
	for (let i = 0; i < 3; i++) await assert.rejects(() => auth.secondFactor(l.token, '111111'), /isn't right/); // failures add up until a success: the reused recovery code was the first
	await assert.rejects(() => auth.secondFactor(l.token, '111111'), /locked/);
	assert.deepEqual(await auth.login('a@example.org', PW), { locked: true });
	assert.equal((await auth.listUsers())[0].locked, true);
});

test('wrong passwords count toward the lock; unknown emails look the same as wrong passwords', async () => {
	const db = await fresh(), auth = createAuth(db, { encryptionKey: KEY });
	await auth.createUser({ email: 'c@example.org', password: PW });
	assert.equal(await auth.login('nobody@example.org', 'whatever-123A'), null);
	for (let i = 0; i < 5; i++) assert.equal(await auth.login('c@example.org', 'bad-password-1A'), null);
	assert.deepEqual(await auth.login('c@example.org', PW), { locked: true }, 'even the right password is refused while locked');
});

test('accounts: the last admin is protected; admins reset 2FA; resetting forces re-enrolment; a password change ends other sessions', async () => {
	const db = await fresh(), auth = createAuth(db, { encryptionKey: KEY });
	const admin = await auth.createUser({ email: 'admin@example.org', role: 'admin', password: PW, mustChange: false });
	const staff = await auth.createUser({ email: 'staff@example.org', role: 'staff', password: PW, mustChange: false });
	await assert.rejects(() => auth.updateUser(admin.id, { active: false }, staff.id), /at least one active admin/);
	await assert.rejects(() => auth.updateUser(admin.id, { role: 'staff' }, admin.id), /your own account/);
	await assert.rejects(() => auth.createUser({ email: 'ADMIN@example.org', password: PW }), /already an account/);
	// staff enrols, then an admin resets their 2FA
	let l = await auth.login('staff@example.org', PW); const { secret } = await auth.enrolStart(l.token); await auth.enrolFinish(l.token, totpNow(secret));
	await auth.resetTwoFactor(staff.id); assert.equal((await auth.login('staff@example.org', PW)).need, 'enroll');
	// password change keeps this session, ends the others
	const a = await auth.login('admin@example.org', PW); const b = await auth.login('admin@example.org', PW);
	const sa = await auth.enrolStart(a.token); const fa = await auth.enrolFinish(a.token, totpNow(sa.secret));
	const sb = await auth.login('admin@example.org', PW); const fb = await auth.secondFactor(sb.token, totpNow(sa.secret, Date.now() + 30000));
	await auth.changeOwnPassword(admin.id, PW, 'Brand-New-Passw0rd', fa.token);
	assert.ok(await auth.lookup(fa.token)); assert.equal(await auth.lookup(fb.token), null);
	await assert.rejects(() => auth.changeOwnPassword(admin.id, 'wrong', 'Another-Passw0rd9', fa.token), /current password/);
	// disabling an account ends its sessions and blocks sign-in
	await auth.updateUser(staff.id, { active: false }, admin.id); assert.equal(await auth.login('staff@example.org', PW), null);
});

/* ------------------------------------------------------------------ the real routes, end to end */
async function server() {
	const db = await fresh();
	const portal = await createPortal({ db, apiToken: 'x'.repeat(30), bootstrapPassword: PW, encryptionKey: KEY, hooks: {} });
	const app = express(); app.set('trust proxy', 1); app.use(express.json({ limit: '20kb' })); app.use(portal.attach); app.use(portal.auditChanges); portal.mount(app);
	app.get('/secret', portal.need, (req, res) => res.json({ by: req.by }));
	const srv = app.listen(0), base = `http://127.0.0.1:${srv.address().port}`;
	const client = () => { let cookie = ''; return async (path, method = 'GET', body, headers = {}) => {
		const r = await fetch(base + path, { method, redirect: 'manual', headers: { 'content-type': 'application/json', 'x-requested-with': 'duda-export', ...(cookie ? { cookie } : {}), ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
		const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
		const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch { /* not json */ } return { s: r.status, j, text };
	}; };
	return { db, portal, client, close: () => srv.close() };
}
async function signUp(c, email, pw = PW) { // password, enrol, returns the secret
	let r = await c('/login', 'POST', { email, password: pw }); const next = r.j.next; assert.ok(['enroll', 'code'].includes(next), JSON.stringify(r));
	if (next === 'enroll') { r = await c('/login/2fa/setup', 'POST', {}); const secret = r.j.secret; r = await c('/login/2fa/enroll', 'POST', { code: totpNow(secret) }); assert.equal(r.s, 200, JSON.stringify(r.j)); return { secret, recoveryCodes: r.j.recoveryCodes, mustChange: r.j.mustChange }; }
}

test('end to end: first admin, QR code, 2FA, accounts for staff, shared activity log, and no way around the gates', async () => {
	const t = await server();
	try {
		const admin = t.client();
		assert.equal((await admin('/api/me')).s, 401); assert.equal((await admin('/secret')).s, 401);
		assert.deepEqual((await admin('/api/auth-mode')).j, { mode: 'accounts', firstRun: true, twoFactor: true });
		assert.equal((await admin('/login', 'POST', { email: 'boss@example.org', password: 'wrong-password-1A' })).s, 401, 'the setup password only works when there are no accounts, and only the right one');
		let r = await admin('/login', 'POST', { email: 'boss@example.org', password: PW }); assert.equal(r.j.next, 'enroll');
		assert.equal((await admin('/api/me')).s, 401, 'password alone opens nothing');
		assert.equal((await admin('/api/users')).s, 401);
		r = await admin('/login/2fa/setup', 'POST', {}); assert.match(r.j.qr, /^<svg/); assert.match(r.j.otpauth, /^otpauth:\/\/totp\/ChurchWeb%20Portal:boss%40example\.org\?secret=/);
		assert.equal((await admin('/login/2fa/enroll', 'POST', { code: '123456' })).s, 400);
		r = await admin('/login/2fa/enroll', 'POST', { code: totpNow(r.j.secret) }); assert.equal(r.j.recoveryCodes.length, 8); assert.equal(r.j.mustChange, true);
		// first-run admin must choose a personal password before anything else
		assert.equal((await admin('/api/users')).s, 403); assert.equal((await admin('/api/me')).j.user.mustChange, true);
		r = await admin('/api/account/password', 'POST', { current: PW, next: 'My-Own-Passw0rd' }); assert.equal(r.s, 200);
		assert.equal((await admin('/api/users')).s, 200);
		// CSRF: a cookie session must send the header
		assert.equal((await admin('/api/account/password', 'POST', { current: 'x', next: 'y' }, { 'x-requested-with': '' })).s, 403);
		// create Chad: a temporary password, shown once, 2FA required, must change
		r = await admin('/api/users', 'POST', { email: 'chad@example.org', name: 'Chad', role: 'staff' }); const temp = r.j.tempPassword; assert.ok(temp.length >= 14);
		const chad = t.client(); const cs = await signUp(chad, 'chad@example.org', temp); assert.equal(cs.mustChange, true);
		assert.equal((await chad('/api/audit')).s, 403, 'must choose a password first'); await chad('/api/account/password', 'POST', { current: temp, next: 'Chads-Own-Passw0rd' });
		assert.equal((await chad('/api/audit')).s, 200, 'everyone shares the same activity log');
		assert.equal((await chad('/api/users')).s, 403, 'staff cannot manage accounts'); assert.equal((await chad('/api/users', 'POST', { email: 'x@example.org' })).s, 403);
		// an admin resets Chad's 2FA: his old session dies, he must enrol again
		const chadId = (await admin('/api/users')).j.find((u) => u.email === 'chad@example.org').id;
		assert.equal((await admin(`/api/users/${chadId}/reset-2fa`, 'POST', {})).s, 200); assert.equal((await chad('/api/me')).s, 401);
		const again = t.client(); assert.equal((await again('/login', 'POST', { email: 'chad@example.org', password: 'Chads-Own-Passw0rd' })).j.next, 'enroll');
		// the API token works for scripts but is a plain staff identity
		assert.equal((await t.client()('/secret', 'GET', undefined, { authorization: 'Bearer ' + 'x'.repeat(30) })).j.by, 'api-token');
		// logout kills the session
		await admin('/logout', 'POST', {}); assert.equal((await admin('/api/me')).s, 401);
		// the log says who did what, and holds no secrets
		const log = await t.portal.audit.list({ limit: 200 }); const acts = log.rows.map((x) => x.action);
		for (const a of ['account.first-admin-created', '2fa.enrolled', 'user.create', 'user.reset-2fa', 'account.password', 'logout', 'login.failed']) assert.ok(acts.includes(a), a + ' in ' + acts.join());
		const dump = JSON.stringify(log.rows); for (const bad of [PW, temp, 'Chads-Own-Passw0rd', 'My-Own-Passw0rd', cs.secret]) assert.ok(!dump.includes(bad), 'a secret leaked into the activity log');
	} finally { t.close(); }
});

test('the login page API refuses cross-site posts and locks an IP after repeated failures', async () => {
	const db = await fresh(); const fails = new Map();
	const portal = await createPortal({ db, bootstrapPassword: PW, encryptionKey: KEY, hooks: { locked: (ip) => (fails.get(ip) || 0) >= 3, noteFail: (ip) => fails.set(ip, (fails.get(ip) || 0) + 1), clearFail: (ip) => fails.delete(ip) } });
	const app = express(); app.use(express.json()); app.use(portal.attach); portal.mount(app); const srv = app.listen(0), base = `http://127.0.0.1:${srv.address().port}`;
	try {
		const post = (b, h = {}) => fetch(base + '/login', { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(b) });
		assert.equal((await post({ email: 'a@example.org', password: PW }, { origin: 'https://evil.example' })).status, 403);
		for (let i = 0; i < 3; i++) assert.equal((await post({ email: 'a@example.org', password: 'nope-nope-1A' })).status, 401);
		assert.equal((await post({ email: 'a@example.org', password: PW })).status, 429);
	} finally { srv.close(); }
});

test('Cloudflare Access tokens: only a genuine, current one for this site gets through', () => {
	const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
	const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1' }, jwks = { keys: [jwk] };
	const team = 'team.cloudflareaccess.com', aud = 'abc123', now = 1_700_000_000_000;
	const make = (claims, key = privateKey, header = { alg: 'RS256', kid: 'k1' }) => { const p = (o) => Buffer.from(JSON.stringify(o)).toString('base64url'); const data = p(header) + '.' + p(claims); return data + '.' + crypto.sign('RSA-SHA256', Buffer.from(data), key).toString('base64url'); };
	const good = { iss: 'https://' + team, aud: [aud], exp: now / 1000 + 600, email: 'chad@example.org' };
	assert.equal(verifyAccessJwt(make(good), jwks, { teamDomain: team, aud, now }).email, 'chad@example.org');
	const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
	for (const [why, tok] of [['expired', make({ ...good, exp: now / 1000 - 5 })], ['wrong audience', make({ ...good, aud: ['nope'] })], ['wrong issuer', make({ ...good, iss: 'https://evil.cloudflareaccess.com' })], ['forged signature', make(good, other)], ['alg none', make(good, privateKey, { alg: 'none', kid: 'k1' })], ['unknown key', make(good, privateKey, { alg: 'RS256', kid: 'zzz' })], ['garbage', 'a.b']]) assert.throws(() => verifyAccessJwt(tok, jwks, { teamDomain: team, aud, now }), undefined, why);
});

/* ------------------------------------------------------------------ the directory */
const CSV = 'Name,Type,Address,Address line 2,City,Province,Postal code,Phone,Email,Website,Existing customer,Pastoral charge,Regional council,Source\r\n' +
	'"Abbey United Church",Congregation,246 Dennis ST,,Abbey,SK,S0N 0A0,(306) 689-0008,st4ucc@gmail.com,,No,Abbey-Lancer Pastoral Charge,Living Skies Regional Council,https://united-church.ca/search/locator/all/1\r\n' +
	'"Granby ""Hope"" United, Church",Congregation,96 Impasse Belmont,,Granby,qc,J2H 1T7,450-372-1417,office@granbyunited.com,https://www.granbyunited.com/about,Yes,,Eastern Regional Council,https://united-church.ca/search/locator/all/2\r\n' +
	'Abbey-Lancer Pastoral Charge,Pastoral Charge,,,,,,,,,No,,Living Skies Regional Council,https://united-church.ca/search/locator/all/3\r\n' +
	'Pine 100% United,Congregation,1 Main,,Pine,ON,K1A 0B1,,pine@pineunited.ca,pineunited.ca,No,,Ottawa Regional Council,https://united-church.ca/search/locator/all/4\r\n' +
	'Duplicate Row,Congregation,,,,ON,,,,,No,,,https://united-church.ca/search/locator/all/4\r\n';

test('directory: reads quoted commas, quotes and CRLF; skips duplicates; normalises provinces and domains', () => {
	const rows = parseCsv(CSV); assert.equal(rows.length, 6);
	assert.equal(rows[2][0], 'Granby "Hope" United, Church');
	const recs = toRecords(rows); assert.equal(recs.length, 4);
	assert.equal(recs[1].province, 'QC'); assert.equal(recs[1].domain, 'granbyunited.com'); assert.equal(recs[1].email_domain, 'granbyunited.com'); assert.equal(recs[1].csv_existing, true);
	assert.equal(recs[0].email_domain, '', 'a gmail address is not a church domain'); assert.equal(hostOf('HTTP://WWW.Example.org/x?y'), 'example.org'); assert.equal(emailDomain('a@Yahoo.ca'), '');
	assert.throws(() => toRecords(parseCsv('Foo,Bar\r\n1,2')), /no "Name" column/);
});

test('directory: import, filters, search (with % and quotes), sort, export, outreach, and customer matching', async () => {
	const db = await fresh(), dir = createDirectory(db);
	assert.deepEqual(await dir.import(toRecords(parseCsv(CSV))), { added: 4, updated: 0, total: 4 });
	const m = await dir.meta(); assert.deepEqual(m.stats, { total: 4, churches: 3, charges: 1, withEmail: 3, provinces: 3, customers: 1 }); assert.equal(m.source.source, 'united-church.ca');
	assert.equal((await dir.list({ q: 'granby' })).total, 1); assert.equal((await dir.list({ q: '100%' })).rows[0].name, 'Pine 100% United'); assert.equal((await dir.list({ q: '%' })).total, 1, 'a % is searched for, not a wildcard');
	assert.equal((await dir.list({ q: "x'; drop table directory;--" })).total, 0); assert.equal((await dir.meta()).stats.total, 4);
	assert.equal((await dir.list({ province: 'ON' })).total, 1); assert.equal((await dir.list({ listing: 'charge' })).total, 1); assert.equal((await dir.list({ hasEmail: true })).total, 3);
	assert.equal((await dir.list({ hasWebsite: 'yes' })).total, 2); assert.equal((await dir.list({ council: 'Ottawa Regional Council' })).total, 1); assert.equal((await dir.list({ customer: 'yes' })).total, 1);
	assert.deepEqual((await dir.list({ sort: 'name', dir: 'desc', limit: 2 })).rows.map((r) => r.name), ['Pine 100% United', 'Granby "Hope" United, Church']);
	// re-import keeps outreach work; customers found by website or email domain
	const abbey = (await dir.list({ q: 'Abbey United' })).rows[0]; await dir.setOutreach(abbey.id, { status: 'contacted', notes: 'Called Tuesday' });
	await assert.rejects(() => dir.setOutreach(abbey.id, { status: 'bogus' }), /Unknown/);
	assert.deepEqual(await dir.import(toRecords(parseCsv(CSV))), { added: 0, updated: 4, total: 4 }); assert.equal((await dir.list({ status: 'contacted' })).rows[0].notes, 'Called Tuesday');
	await dir.addCustomerDomains('pineunited.ca\nwww.nowhere-church.org, granbyunited.com'); const cs = await dir.customerSummary();
	assert.deepEqual([cs.total, cs.found, cs.notFound.map((x) => x.domain)], [3, 2, ['nowhere-church.org']]); assert.equal((await dir.list({ customer: 'yes' })).total, 2);
	await dir.clearCustomerDomains(); assert.equal((await dir.list({ customer: 'yes' })).total, 1, 'the file\'s own "Existing customer = Yes" is kept');
	assert.equal((await dir.exportRows({ province: 'ON' })).length, 1);
});

test('directory API: signed-in only, CSV import and export through the real routes', async () => {
	const t = await server();
	try {
		const c = t.client(); assert.equal((await c('/api/directory')).s, 401);
		await signUp(c, 'boss@example.org'); await c('/api/account/password', 'POST', { current: PW, next: 'My-Own-Passw0rd' });
		assert.equal((await c('/api/directory/import', 'POST', '', { 'content-type': 'text/csv' })).s, 400);
		let r = await c('/api/directory/import', 'POST', CSV, { 'content-type': 'text/csv' }); assert.deepEqual(r.j, { added: 4, updated: 0, total: 4 });
		r = await c('/api/directory?q=granby&limit=10'); assert.equal(r.j.total, 1);
		r = await c('/api/directory/export.csv?province=ON'); assert.match(r.text, /^Name,Type,Address/); assert.match(r.text, /Pine 100% United/); assert.ok(!/Granby/.test(r.text));
		const id = (await c('/api/directory?q=pine')).j.rows[0].id; assert.equal((await c(`/api/directory/${id}`, 'PATCH', { status: 'to contact' })).j.outreach_status, 'to contact');
		assert.equal((await c('/api/directory/meta')).j.stats.churches, 3);
		const acts = (await t.portal.audit.list({ limit: 50 })).rows.map((x) => x.action); assert.ok(acts.includes('directory.import') && acts.includes('directory.outreach'));
	} finally { t.close(); }
});

test('the signed /api/build/* endpoints the church sites call are not behind the sign-in, everything else under /api still is', async () => {
	const db = await fresh();
	const portal = await createPortal({ db, bootstrapPassword: PW, encryptionKey: KEY, hooks: {} });
	const app = express(); app.use(express.json()); app.use(portal.attach); portal.mount(app);
	app.use('/api/build', (req, res) => res.json({ reached: true }));
	const srv = app.listen(0), base = `http://127.0.0.1:${srv.address().port}`;
	try {
		assert.equal((await fetch(base + '/api/build/x/state')).status, 200);
		assert.equal((await fetch(base + '/api/prospects')).status, 401);
		assert.equal((await fetch(base + '/api/buildx')).status, 401, 'only /api/build/ itself is open');
	} finally { srv.close(); }
});
