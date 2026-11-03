// Express wiring for accounts, the audit log and the directory. Mounted only when the database is connected.
import express from 'express';
import QRCode from 'qrcode';
import crypto from 'node:crypto';
import { createAuth, createAudit, checkPassword, randomPassword } from './auth.mjs';
import { createDirectory, parseCsv, toRecords, csvLine, STATUSES } from './directory.mjs';

const parseCookies = (h) => Object.fromEntries(String(h || '').split(';').map((c) => c.trim().split(/=(.*)/s).slice(0, 2)).filter((x) => x[0]));
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const same = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
export const COOKIE = 'cw_user';

// A short, readable name for each kind of request, for the activity log. Bodies are never logged, only the safe fields below.
const LABELS = [
	[/^POST \/api\/deploy\/churches$/, 'customer.add'], [/^PATCH \/api\/deploy\/churches\/[^/]+$/, 'customer.edit'], [/^DELETE \/api\/deploy\/churches\/[^/]+$/, 'customer.delete'],
	[/^POST \/api\/deploy\/churches\/[^/]+\/stages\/[^/]+\/check$/, 'task.check'], [/^POST \/api\/deploy\/churches\/[^/]+\/stages\/[^/]+\/fix$/, 'task.fix'], [/^PUT \/api\/deploy\/churches\/[^/]+\/stages\/[^/]+\/manual$/, 'task.tick'],
	[/^POST \/api\/deploy\/churches\/[^/]+\/gateway$/, 'assistant.switch'], [/^POST \/api\/deploy\/hostinger-probe$/, 'hostinger.test'],
	[/^POST \/api\/email\/create$/, 'email.create'], [/^POST \/api\/email\/postmark$/, 'email.postmark'], [/^POST \/api\/email\/health$/, 'email.check'], [/^POST \/api\/email\/test$/, 'email.test'],
	[/^POST \/api\/directory\/import$/, 'directory.import'], [/^PATCH \/api\/directory\/\d+$/, 'directory.outreach'], [/^POST \/api\/directory\/customers$/, 'directory.customers.add'], [/^DELETE \/api\/directory\/customers$/, 'directory.customers.clear'],
	[/^POST \/api\/outreach\/preview$/, 'outreach.preview'], [/^POST \/api\/outreach\/send$/, 'outreach.send'], [/^POST \/api\/outreach\/suppress$/, 'outreach.suppress'],
	[/^POST \/api\/hosted\/sync$/, 'domains.sync'], [/^POST \/api\/hosted\/board-import$/, 'customer.import'],
	[/^POST \/api\/users$/, 'user.create'], [/^PATCH \/api\/users\/\d+$/, 'user.edit'], [/^POST \/api\/users\/\d+\/reset$/, 'user.reset-password'], [/^POST \/api\/users\/\d+\/reset-2fa$/, 'user.reset-2fa'], [/^POST \/api\/account\/2fa\/recovery$/, 'account.recovery-codes'], [/^POST \/api\/account\/password$/, 'account.password'],
	[/^(POST|DELETE) \/api\/jobs/, 'export.job'], [/^POST \/api\/batch$/, 'export.batch'],
];
const SAFE_BODY = ['campaign', 'expect', 'req', 'domain', 'dry', 'deleteSite', 'to', 'off', 'role', 'active', 'status', 'name', 'plan'];
const targetOf = (path) => { const m = /\/churches\/([^/]+)/.exec(path) || /\/users\/(\d+)/.exec(path) || /\/directory\/(\d+)/.exec(path); return m ? decodeURIComponent(m[1]) : ''; };

export async function createPortal({ db, sessionHours = 12, apiToken = '', bootstrapPassword = '', secureCookie = true, requireTwoFactor = true, encryptionKey = '', previousKeys = [], hooks = {} }) {
	const auth = createAuth(db, { sessionHours, requireTwoFactor, encryptionKey, previousKeys }), audit = createAudit(db), dir = createDirectory(db);
	const clientIp = (req) => req.ip || req.socket?.remoteAddress || '';
	const apiUser = { id: null, email: 'api-token', name: 'API token', role: 'staff' };
	const setCookie = (req, res, token) => res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: !!req.secure && secureCookie, maxAge: sessionHours * 3600 * 1000, path: '/' });

	/** Works out who is calling (cookie session or API token). Does not reject anyone: pages decide what to do. */
	const attach = async (req, res, next) => {
		try {
			const h = req.get('authorization') || '';
			if (apiToken && h.startsWith('Bearer ') && same(h.slice(7), apiToken)) { req.user = apiUser; req.viaToken = true; }
			else { const t = parseCookies(req.get('cookie'))[COOKIE]; req.sessionToken = t; req.user = await auth.lookup(t); }
			next();
		} catch (e) { next(e); }
	};
	const need = (req, res, next) => {
		if (!req.user) return res.status(401).json({ error: 'Not signed in' });
		if (!req.viaToken && req.method !== 'GET') { // a cookie-authenticated change must come from this site
			const o = req.get('origin');
			if (o && new URL(o).host !== req.get('host')) return res.status(403).json({ error: 'Bad origin' });
			if (req.get('x-requested-with') !== 'duda-export') return res.status(403).json({ error: 'Missing header' });
		}
		const full = req.baseUrl + req.path;
		if (req.user.mustChange && !full.startsWith('/api/account/') && full !== '/api/me') return res.status(403).json({ error: 'Choose your own password first.', mustChange: true });
		req.by = req.user.email;
		next();
	};
	const needAdmin = (req, res, next) => (req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Only an admin can do that.' }));

	/** After any change request finishes, record who did what and whether it worked. */
	const auditChanges = (req, res, next) => {
		const path = req.originalUrl.split('?')[0]; // captured now: routers rewrite req.path while they run
		if (req.method === 'GET' || !path.startsWith('/api/')) return next();
		res.on('finish', () => {
			if (!req.user) return;
			const key = `${req.method} ${path}`, hit = LABELS.find(([re]) => re.test(key));
			const detail = {}; for (const k of SAFE_BODY) if (req.body && typeof req.body === 'object' && k in req.body && typeof req.body[k] !== 'object') detail[k] = req.body[k];
			const sm = /\/stages\/([^/]+)\//.exec(path); if (sm) detail.stage = sm[1];
			audit.write({ user: req.user.id ? req.user : { id: null, email: req.user.email }, action: hit ? hit[1] : key, target: targetOf(path), status: res.statusCode, detail: Object.keys(detail).length ? detail : null, ip: clientIp(req) });
		});
		next();
	};

	function mount(app) {
		const r = express.Router();
		// ---- sign in / out (no session needed). Step 1 is the password, step 2 is the authenticator code.
		const sameOrigin = (req, res) => { const o = req.get('origin'); if (o && new URL(o).host !== req.get('host')) { res.status(403).json({ error: 'Bad origin' }); return false; } return true; };
		const cookieToken = (req) => parseCookies(req.get('cookie'))[COOKIE];
		const ua = (req) => req.get('user-agent') || '';
		app.get('/api/auth-mode', async (req, res) => res.json({ mode: 'accounts', firstRun: (await auth.userCount()) === 0, twoFactor: requireTwoFactor }));
		app.post('/login', async (req, res) => {
			const ip = clientIp(req);
			if (hooks.locked?.(ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 10 minutes.' });
			if (!sameOrigin(req, res)) return;
			const { email, password } = req.body || {};
			if (typeof email !== 'string' || typeof password !== 'string') return res.status(400).json({ error: 'Enter your email and password.' });
			const who = { id: null, email: email.trim().toLowerCase().slice(0, 120) };
			const s = await auth.login(email, password, { ip, ua: ua(req), bootstrapPassword });
			if (s?.locked) { await audit.write({ user: who, action: 'login.locked', status: 429, ip }); return res.status(429).json({ error: 'This account is locked for a few minutes after too many wrong attempts.' }); }
			if (!s) { hooks.noteFail?.(ip); await audit.write({ user: who, action: 'login.failed', status: 401, ip }); return res.status(401).json({ error: 'Wrong email or password.' }); }
			setCookie(req, res, s.token);
			if (s.first) await audit.write({ user: s.user, action: 'account.first-admin-created', status: 200, ip });
			if (s.need) return res.json({ ok: true, next: s.need });
			hooks.clearFail?.(ip); await audit.write({ user: s.user, action: s.first ? 'login.first-admin' : 'login', status: 200, ip });
			res.json({ ok: true, next: 'done', mustChange: s.user.mustChange });
		});
		app.post('/login/2fa/setup', async (req, res) => {
			if (!sameOrigin(req, res)) return;
			try { const { secret, otpauth } = await auth.enrolStart(cookieToken(req)); res.json({ secret, otpauth, qr: await QRCode.toString(otpauth, { type: 'svg', margin: 1, width: 210 }) }); }
			catch (e) { res.status(401).json({ error: e.message }); }
		});
		app.post('/login/2fa/enroll', async (req, res) => {
			const ip = clientIp(req); if (!sameOrigin(req, res)) return;
			try {
				const r = await auth.enrolFinish(cookieToken(req), req.body?.code, { ip, ua: ua(req) });
				setCookie(req, res, r.token); hooks.clearFail?.(ip);
				await audit.write({ user: r.user, action: '2fa.enrolled', status: 200, ip }); await audit.write({ user: r.user, action: 'login', status: 200, ip });
				res.json({ ok: true, recoveryCodes: r.recoveryCodes, mustChange: r.user.mustChange });
			} catch (e) { hooks.noteFail?.(ip); res.status(400).json({ error: e.message }); }
		});
		app.post('/login/2fa/verify', async (req, res) => {
			const ip = clientIp(req); if (hooks.locked?.(ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 10 minutes.' }); if (!sameOrigin(req, res)) return;
			const pend = await auth.pending(cookieToken(req));
			try {
				const r = await auth.secondFactor(cookieToken(req), req.body?.code, { ip, ua: ua(req) });
				setCookie(req, res, r.token); hooks.clearFail?.(ip);
				await audit.write({ user: r.user, action: r.usedRecovery ? 'login.recovery-code' : 'login', status: 200, ip, detail: r.usedRecovery ? { recoveryLeft: r.recoveryLeft } : null });
				res.json({ ok: true, mustChange: r.user.mustChange, usedRecovery: !!r.usedRecovery, recoveryLeft: r.recoveryLeft });
			} catch (e) { hooks.noteFail?.(ip); if (pend) await audit.write({ user: { id: pend.id, email: pend.email }, action: 'login.2fa-failed', status: 401, ip }); res.status(401).json({ error: e.message }); }
		});
		app.post('/logout', async (req, res) => {
			const t = cookieToken(req), u = await auth.lookup(t);
			await auth.logout(t); res.clearCookie(COOKIE, { path: '/' });
			if (u) await audit.write({ user: u, action: 'logout', status: 200, ip: clientIp(req) });
			res.json({ ok: true });
		});

		// ---- everything below needs a signed-in person
		r.use('/api', need);
		r.get('/api/me', (req, res) => res.json({ user: req.user && { email: req.user.email, name: req.user.name, role: req.user.role, mustChange: !!req.user.mustChange, twoFactor: !!req.user.twoFactor }, mode: 'accounts' }));
		r.post('/api/account/password', async (req, res) => {
			if (req.viaToken) return res.status(400).json({ error: 'The API token has no password.' });
			try { await auth.changeOwnPassword(req.user.id, String(req.body?.current || ''), String(req.body?.next || ''), req.sessionToken); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); }
		});

		r.get('/api/account/2fa', async (req, res) => res.json({ enabled: !!req.user.twoFactor, recoveryLeft: req.user.id ? await auth.recoveryLeft(req.user.id) : 0 }));
		r.post('/api/account/2fa/recovery', async (req, res) => { try { res.json({ codes: await auth.regenerateRecovery(req.user.id, String(req.body?.password || ''), String(req.body?.code || '')) }); } catch (e) { res.status(400).json({ error: e.message }); } });

		// ---- accounts (admin)
		r.get('/api/users', needAdmin, async (req, res) => res.json(await auth.listUsers()));
		r.post('/api/users', needAdmin, async (req, res) => {
			try {
				const b = req.body || {}, password = randomPassword();
				const u = await auth.createUser({ email: b.email, name: b.name, role: b.role === 'admin' ? 'admin' : 'staff', password, mustChange: true, createdBy: req.user.id });
				res.json({ user: u, tempPassword: password });
			} catch (e) { res.status(400).json({ error: e.message }); }
		});
		r.patch('/api/users/:id', needAdmin, async (req, res) => { try { res.json(await auth.updateUser(Number(req.params.id), { name: req.body?.name, role: req.body?.role, active: req.body?.active }, req.user.id)); } catch (e) { res.status(400).json({ error: e.message }); } });
		r.post('/api/users/:id/reset', needAdmin, async (req, res) => { try { const pw = randomPassword(); await auth.resetPassword(Number(req.params.id), pw); res.json({ tempPassword: pw }); } catch (e) { res.status(400).json({ error: e.message }); } });

		r.post('/api/users/:id/reset-2fa', needAdmin, async (req, res) => { try { await auth.resetTwoFactor(Number(req.params.id)); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); } });

		// ---- activity log (everyone sees the same shared log)
		r.get('/api/audit', async (req, res) => res.json({ ...(await audit.list({ q: req.query.q, user: req.query.user, limit: req.query.limit, offset: req.query.offset })), users: await audit.users() }));
		r.get('/api/audit/export.csv', async (req, res) => {
			const { rows } = await audit.list({ q: req.query.q, user: req.query.user, limit: 500, offset: 0 });
			res.type('text/csv').set('Content-Disposition', 'attachment; filename="portal-activity.csv"').send([csvLine(['When', 'Who', 'What', 'On', 'Result', 'Details']), ...rows.map((x) => csvLine([new Date(x.at).toISOString(), x.user_email, x.action, x.target, x.status ?? '', x.detail ? JSON.stringify(x.detail) : '']))].join('\n'));
		});

		// ---- directory
		const filters = (q) => ({ q: q.q, province: q.province, listing: q.listing, hasEmail: q.hasEmail === '1', hasWebsite: q.hasWebsite, council: q.council, charge: q.charge, customer: q.customer, status: q.status, sort: q.sort, dir: q.dir, limit: q.limit, offset: q.offset });
		r.get('/api/directory/meta', async (req, res) => res.json(await dir.meta()));
		r.get('/api/directory', async (req, res) => res.json(await dir.list(filters(req.query))));
		r.get('/api/directory/export.csv', async (req, res) => {
			const rows = await dir.exportRows(filters(req.query));
			const head = ['Name', 'Type', 'Address', 'Address line 2', 'City', 'Province', 'Postal code', 'Phone', 'Email', 'Website', 'Existing customer', 'Outreach status', 'Notes', 'Pastoral charge', 'Regional council', 'Source'];
			res.type('text/csv').set('Content-Disposition', 'attachment; filename="united-church-directory.csv"').send([csvLine(head), ...rows.map((x) => csvLine([x.name, x.type, x.address, x.address2, x.city, x.province, x.postal, x.phone, x.email, x.website, x.is_customer ? 'Yes' : 'No', x.outreach_status, x.notes, x.pastoral_charge, x.regional_council, x.source]))].join('\n'));
		});
		r.post('/api/directory/import', express.text({ type: ['text/csv', 'text/plain'], limit: '12mb' }), async (req, res) => {
			try { if (typeof req.body !== 'string' || !req.body.trim()) throw new Error('Choose the directory CSV file.'); res.json(await dir.import(toRecords(parseCsv(req.body)))); } catch (e) { res.status(400).json({ error: e.message }); }
		});
		r.patch('/api/directory/:id', async (req, res) => { try { res.json(await dir.setOutreach(Number(req.params.id), { status: req.body?.status, notes: req.body?.notes })); } catch (e) { res.status(400).json({ error: e.message }); } });
		r.post('/api/directory/customers', async (req, res) => res.json({ added: await dir.addCustomerDomains(req.body?.domains, 'manual'), ...(await dir.customerSummary()) }));
		r.delete('/api/directory/customers', async (req, res) => { await dir.clearCustomerDomains('manual'); res.json({ ok: true }); });

		app.use(r);
		return r;
	}
	return { auth, audit, dir, attach, need, needAdmin, auditChanges, mount, STATUSES };
}
