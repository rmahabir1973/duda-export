import { parseBatch, MAX_BATCH, slug, csvCell } from './batch.mjs';
import express from 'express';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './deploy/store.mjs';
import { configFromEnv, makeClients } from './deploy/clients.mjs';
import { createDeployRouter } from './deploy/routes.mjs';
import { createEmailRouter } from './deploy/emailroutes.mjs';
import { connectDb, migrate } from './portal/db.mjs';
import { createPortal } from './portal/routes.mjs';
import { createLoops } from './portal/loops.mjs';
import { createOutreach } from './portal/outreach.mjs';
import { outreachRouter, loopsWebhook } from './portal/outreachRoutes.mjs';
import { buildTools } from './portal/assistantTools.mjs';
import { createAssistant } from './portal/assistant.mjs';
import { assistantRouter } from './portal/assistantRoutes.mjs';
import { createHosted, makeDudaMcp } from './portal/hosted.mjs';
import { hostedRouter } from './portal/hostedRoutes.mjs';
import { makeWhmcsClient, createWhmcs, SUPPORT_ACTIONS } from './portal/whmcs.mjs';
import { whmcsRouter } from './portal/whmcsRoutes.mjs';
import { createSupport } from './portal/support.mjs';
import { supportRouter } from './portal/supportRoutes.mjs';
import { createAnalytics, makeGa4 } from './portal/analytics.mjs';
import { analyticsRouter } from './portal/analyticsRoutes.mjs';
import { createAccessGuard } from './portal/access.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;

/* ---------------------------------------------------------------- config */
const PORT = Number(env.PORT || 3000);
const APP_PASSWORD = env.APP_PASSWORD || '';
const API_TOKEN = env.API_TOKEN || '';
if (APP_PASSWORD.length < 10) {
	console.error('Set APP_PASSWORD (at least 10 characters).');
	process.exit(1);
}
if (API_TOKEN && API_TOKEN.length < 24) {
	console.error('API_TOKEN must be at least 24 characters (or leave it unset).');
	process.exit(1);
}
const SESSION_SECRET = env.SESSION_SECRET || crypto.createHash('sha256').update('cw-session:' + APP_PASSWORD).digest('hex');
const DATA_DIR = path.resolve(env.DATA_DIR || path.join(__dirname, 'data'));
const MAX_CONCURRENT = Math.max(1, Number(env.MAX_CONCURRENT_JOBS || 1));
const MAX_QUEUE = Number(env.MAX_QUEUE || 40);
const MAX_PAGES_CAP = Number(env.MAX_PAGES_CAP || 500);
const RETENTION_MS = Number(env.RETENTION_HOURS || 48) * 3600 * 1000;
const JOB_TIMEOUT_MS = Number(env.JOB_TIMEOUT_MIN || 45) * 60 * 1000;
const SESSION_HOURS = Number(env.SESSION_HOURS || 12);
const ALLOWED_DOMAINS = (env.ALLOWED_DOMAINS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const API_AVAILABLE = Boolean(env.DUDA_MCP_TOKEN || (env.DUDA_API_USER && env.DUDA_API_PASS));
const EXPORTER = path.join(__dirname, 'exporter', 'duda-export.mjs');

fs.mkdirSync(path.join(DATA_DIR, 'jobs'), { recursive: true });

/* ---------------------------------------------------------------- helpers */
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const b64u = (b) => Buffer.from(b).toString('base64url');
const sign = (v) => crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('base64url');
const makeSession = () => {
	const exp = Date.now() + SESSION_HOURS * 3600 * 1000;
	return `${exp}.${sign(String(exp))}`;
};
const validSession = (tok) => {
	if (!tok) return false;
	const [exp, sig] = String(tok).split('.');
	return Boolean(exp && sig && Number(exp) > Date.now() && safeEq(sig, sign(exp)));
};
const parseCookies = (h) => Object.fromEntries(String(h || '').split(';').map((c) => c.trim().split(/=(.*)/s).slice(0, 2)).filter((x) => x[0]));
const html = (f) => fs.readFileSync(path.join(__dirname, 'views', f), 'utf8');

function isPrivateIp(ip) {
	if (net.isIPv4(ip)) {
		const [a, b] = ip.split('.').map(Number);
		return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
	}
	const x = ip.toLowerCase();
	return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80') || x.startsWith('::ffff:127.') || x.startsWith('::ffff:10.') || x.startsWith('::ffff:192.168.') || x.startsWith('::ffff:169.254.');
}
async function validateDomain(raw) {
	let d = String(raw || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#].*$/, '');
	if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(d) || d.length > 253) throw new Error('Enter a domain like www.example.org');
	if (net.isIP(d)) throw new Error('Use a domain name, not an IP address');
	if (ALLOWED_DOMAINS.length && !ALLOWED_DOMAINS.some((s) => d === s || d.endsWith('.' + s))) throw new Error('That domain is not on this server\'s allow-list');
	let addrs;
	try {
		addrs = await dns.lookup(d, { all: true });
	} catch {
		throw new Error('That domain does not resolve');
	}
	if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('That domain points at a private or internal address');
	return d;
}

/* ---------------------------------------------------------------- jobs */
const jobs = new Map();
const jobDir = (id) => path.join(DATA_DIR, 'jobs', id);
const publicJob = (j) => ({ id: j.id, label: j.label || '', domain: j.domain, site: j.site || '', useApi: j.useApi, status: j.status, created: j.created, started: j.started, ended: j.ended, summary: j.summary, error: j.error, by: j.by, opts: j.opts });
function persist(j) {
	try {
		fs.writeFileSync(path.join(jobDir(j.id), 'job.json'), JSON.stringify({ ...publicJob(j), zip: j.zip }, null, 2));
	} catch {}
}
for (const id of fs.readdirSync(path.join(DATA_DIR, 'jobs'))) {
	try {
		const j = JSON.parse(fs.readFileSync(path.join(jobDir(id), 'job.json'), 'utf8'));
		j.log = (() => { try { return fs.readFileSync(path.join(jobDir(id), 'log.txt'), 'utf8').split('\n').slice(-400); } catch { return []; } })();
		if (j.status === 'queued' || j.status === 'running') {
			j.status = 'failed';
			j.error = 'The server restarted while this job was running. Start it again.';
			j.ended = Date.now();
		}
		jobs.set(id, j);
	} catch {}
}
const running = new Set();
const queue = [];

function logLine(j, line) {
	if (!line) return;
	j.log.push(line);
	if (j.log.length > 400) j.log.shift();
	try {
		fs.appendFileSync(path.join(jobDir(j.id), 'log.txt'), line + '\n');
	} catch {}
}

function pump() {
	while (running.size < MAX_CONCURRENT && queue.length) {
		const j = queue.shift();
		if (j.status !== 'queued') continue;
		start(j);
	}
}

function start(j) {
	j.status = 'running';
	j.started = Date.now();
	running.add(j.id);
	persist(j);
	const dir = jobDir(j.id);
	const args = [EXPORTER, '--domain', j.domain, '--out', dir, '--concurrency', '3'];
	if (j.opts.maxPages) args.push('--max-pages', String(j.opts.maxPages));
	if (j.opts.skipImages) args.push('--skip-images');
	if (j.opts.mode && j.opts.mode !== 'auto') args.push('--mode', j.opts.mode);
	if (j.opts.preview) args.push('--preview');
	if (j.useApi) {
		if (j.site) args.push('--site', j.site);
		else args.push('--find-site');
	}
	const childEnv = { ...env };
	for (const k of ['APP_PASSWORD', 'API_TOKEN', 'SESSION_SECRET']) delete childEnv[k];
	if (!j.useApi) {
		delete childEnv.DUDA_API_USER;
		delete childEnv.DUDA_API_PASS;
		delete childEnv.DUDA_MCP_TOKEN;
		delete childEnv.DUDA_MCP_URL;
	}
	const child = spawn(process.execPath, args, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
	j.pid = child.pid;
	let buf = '';
	const feed = (d) => {
		buf += d.toString();
		const parts = buf.split('\n');
		buf = parts.pop();
		parts.forEach((l) => logLine(j, l.replace(/\r$/, '')));
	};
	child.stdout.on('data', feed);
	child.stderr.on('data', feed);
	const timer = setTimeout(() => {
		j.timedOut = true;
		child.kill('SIGKILL');
	}, JOB_TIMEOUT_MS);
	child.on('close', (code) => {
		clearTimeout(timer);
		if (buf) logLine(j, buf);
		running.delete(j.id);
		j.ended = Date.now();
		if (j.canceled) j.status = 'canceled';
		else if (j.timedOut) {
			j.status = 'failed';
			j.error = `Stopped after ${JOB_TIMEOUT_MS / 60000} minutes.`;
		} else if (code === 0) {
			const zip = fs.readdirSync(dir).find((f) => f.endsWith('.zip'));
			if (zip) {
				j.zip = zip;
				j.status = 'done';
				try {
					const folder = fs.readdirSync(dir).find((f) => f.endsWith('-duda-export') && fs.statSync(path.join(dir, f)).isDirectory());
					const pages = JSON.parse(fs.readFileSync(path.join(dir, folder, 'data/pages.json'), 'utf8'));
					const flags = fs.readFileSync(path.join(dir, folder, 'data/flags.csv'), 'utf8').split('\n').filter((l) => l && !l.startsWith('"info"') && !l.startsWith('"severity"')).length;
					j.summary = {
						pages: pages.length,
						images: fs.readdirSync(path.join(dir, folder, 'images')).length,
						documents: fs.readdirSync(path.join(dir, folder, 'documents')).length,
						flags,
						zipMB: +(fs.statSync(path.join(dir, zip)).size / 1048576).toFixed(1),
					};
					// keep only the ZIP: the folder duplicates it
					fs.rmSync(path.join(dir, folder), { recursive: true, force: true });
				} catch (e) {
					logLine(j, 'summary unavailable: ' + e.message);
				}
			} else {
				j.status = 'failed';
				j.error = 'The export finished but produced no ZIP.';
			}
		} else {
			j.status = 'failed';
			j.error = `Exporter exited with code ${code}. See the log.`;
		}
		persist(j);
		pump();
	});
	child.on('error', (e) => {
		running.delete(j.id);
		j.status = 'failed';
		j.error = e.message;
		j.ended = Date.now();
		persist(j);
		pump();
	});
}

function cleanup() {
	const cut = Date.now() - RETENTION_MS;
	for (const [id, j] of jobs) {
		if ((j.ended || j.created) < cut && !running.has(id) && j.status !== 'queued') {
			fs.rmSync(jobDir(id), { recursive: true, force: true });
			jobs.delete(id);
		}
	}
}
cleanup();
setInterval(cleanup, 30 * 60 * 1000).unref();

/* ---------------------------------------------------------------- accounts + database (optional: falls back to the single password) */
let portal = null, portalDb = null;
const dbUrl = (env.NEON_DATABASE_URL || env.DATABASE_URL || '').trim();
if (dbUrl) {
	try {
		const db = await connectDb(dbUrl);
		await migrate(db); portalDb = db;
		if (!env.PORTAL_ENC_KEY) console.warn('portal: PORTAL_ENC_KEY is not set, so the 2FA secrets are encrypted with a key derived from SESSION_SECRET / APP_PASSWORD. Set PORTAL_ENC_KEY (a long random value) in Railway and never change it.');
		portal = await createPortal({ db, sessionHours: SESSION_HOURS, apiToken: API_TOKEN, bootstrapPassword: APP_PASSWORD, requireTwoFactor: env.REQUIRE_2FA !== '0', encryptionKey: env.PORTAL_ENC_KEY || SESSION_SECRET, previousKeys: [SESSION_SECRET, ...(env.PORTAL_ENC_KEY_OLD || '').split(',').map((x) => x.trim())].filter(Boolean), hooks: { locked: (ip) => locked(ip), noteFail: (ip) => noteFail(ip), clearFail: (ip) => fails.delete(ip) } });
		console.log(`portal: database connected, user accounts are on, two-factor ${env.REQUIRE_2FA === '0' ? 'OFF (REQUIRE_2FA=0)' : 'required'}`);
		if (env.RESET_2FA_FOR) { const done = await portal.auth.resetTwoFactorByEmail(env.RESET_2FA_FOR); console.warn(`portal: RESET_2FA_FOR is set: ${done ? 'cleared 2FA for ' + env.RESET_2FA_FOR : 'no account ' + env.RESET_2FA_FOR}. Remove the variable now.`); }
	} catch (e) { console.error('portal: database not available, using the single password login instead:', e.message); }
} else console.log('portal: no DATABASE_URL, using the single password login');

/* prospect outreach through Loops (needs the database) */
const loops = createLoops({ apiKey: (env.LOOPS_API_KEY || '').trim() });
const LOOPS_WEBHOOK_SECRET = (env.LOOPS_WEBHOOK_SECRET || '').trim();
const outreach = portal && portalDb ? createOutreach({ db: portalDb, dir: portal.dir, loops, audit: portal.audit, eventName: (env.LOOPS_OUTREACH_EVENT || 'prospect_outreach').trim(), dailyCap: env.OUTREACH_DAILY_CAP ?? 25 }) : null;
if (outreach) console.log(`outreach: Loops ${loops.available() ? 'connected' : 'NOT configured (LOOPS_API_KEY)'}, daily cap ${outreach.cap}, webhook ${LOOPS_WEBHOOK_SECRET ? 'secret set' : 'secret missing'}`);

/* ---------------------------------------------------------------- web */
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
if (env.CF_ACCESS_TEAM_DOMAIN && env.CF_ACCESS_AUD) { app.use(createAccessGuard({ teamDomain: env.CF_ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, ''), aud: env.CF_ACCESS_AUD, exempt: ['/healthz', '/webhooks/loops'] })); console.log('portal: only requests that passed Cloudflare Access are accepted'); }
app.use((req, res, next) => {
	if (req.secure) res.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
	res.set({
		'X-Content-Type-Options': 'nosniff',
		'X-Frame-Options': 'DENY',
		'Referrer-Policy': 'no-referrer',
		'Cache-Control': 'no-store',
		'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
		'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
		'Cross-Origin-Opener-Policy': 'same-origin',
		'Cross-Origin-Resource-Policy': 'same-origin',
	});
	next();
});
app.get('/healthz', (req, res) => res.type('text').send('ok'));
if (outreach) app.post('/webhooks/loops', ...loopsWebhook({ outreach, secret: LOOPS_WEBHOOK_SECRET })); // signed by Loops, checked on the raw body
app.use('/api/assistant', express.json({ limit: '300kb' }));
app.use(express.json({ limit: '20kb' }));
if (portal) { app.use(portal.attach); app.use(portal.auditChanges); }
app.use('/assets', express.static(path.join(__dirname, 'public'), { index: false }));

const fails = new Map();
const locked = (ip) => (fails.get(ip)?.until || 0) > Date.now();
const noteFail = (ip) => {
	const f = fails.get(ip) || { n: 0, until: 0 };
	f.n++;
	if (f.n >= 5) {
		f.until = Date.now() + 10 * 60 * 1000;
		f.n = 0;
	}
	fails.set(ip, f);
};

function auth(req) {
	const h = req.get('authorization') || '';
	if (API_TOKEN && h.startsWith('Bearer ') && safeEq(h.slice(7), API_TOKEN)) return 'api';
	if (validSession(parseCookies(req.get('cookie')).cw_session)) return 'session';
	return null;
}
const legacyNeed = (req, res, next) => {
	const how = auth(req);
	if (!how) return res.status(401).json({ error: 'Not signed in' });
	// cookie-authenticated writes must come from this site
	if (how === 'session' && req.method !== 'GET') {
		const o = req.get('origin');
		if (o && new URL(o).host !== req.get('host')) return res.status(403).json({ error: 'Bad origin' });
		if (req.get('x-requested-with') !== 'duda-export') return res.status(403).json({ error: 'Missing header' });
	}
	req.by = how;
	next();
};
const need = portal ? portal.need : legacyNeed;
const signedIn = (req) => (portal ? !!req.user : auth(req) === 'session');
const page = (file, { dbOnly = false } = {}) => (req, res) => res.type('html').send(html(!signedIn(req) ? 'login.html' : dbOnly && !portal ? 'needsdb.html' : file));

app.get('/', (req, res) => (signedIn(req) ? res.redirect('/deploy') : res.type('html').send(html('login.html'))));
app.get('/exporter', page('app.html'));
if (portal) portal.mount(app);
else app.get('/api/auth-mode', (req, res) => res.json({ mode: 'password', firstRun: false }));
if (!portal) app.get('/api/me', legacyNeed, (req, res) => res.json({ user: { email: 'admin', name: 'Shared password', role: 'admin', mustChange: false }, mode: 'password' }));

if (!portal) app.post('/login', (req, res) => {
	if (locked(req.ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 10 minutes.' });
	const o = req.get('origin');
	if (o && new URL(o).host !== req.get('host')) return res.status(403).json({ error: 'Bad origin' });
	if (typeof req.body?.password !== 'string' || !safeEq(req.body.password, APP_PASSWORD)) {
		noteFail(req.ip);
		return res.status(401).json({ error: 'Wrong password' });
	}
	fails.delete(req.ip);
	res.cookie('cw_session', makeSession(), { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: SESSION_HOURS * 3600 * 1000, path: '/' });
	res.json({ ok: true });
});
if (!portal) app.post('/logout', (req, res) => {
	res.clearCookie('cw_session', { path: '/' });
	res.json({ ok: true });
});

const deployClients = makeClients(configFromEnv(env));
const deployStore = createStore(path.join(DATA_DIR, 'deploy'), { db: portalDb });
const boardInit = await deployStore.init();
console.log(`customer board: ${boardInit.count} customers loaded (${boardInit.source})`);
app.use('/api/deploy', createDeployRouter({ need, store: deployStore, clients: deployClients }));
app.use('/api/email', createEmailRouter({ need, clients: deployClients }));
const hosted = portal && portalDb ? createHosted({ db: portalDb, clients: deployClients, duda: makeDudaMcp({ token: (env.DUDA_MCP_TOKEN || '').trim() }), dir: portal.dir, ownDomains: (env.OWN_DOMAINS || 'churchwebglobal.com,churchwebsupport.com').split(',').map((x) => x.trim()).filter(Boolean), previewDomain: deployClients.cfg.previewDomain }) : null;
if (hosted) {
	app.use('/api/hosted', hostedRouter({ need, hosted, store: deployStore }));
	const hours = Number(env.HOSTED_SYNC_HOURS ?? 6);
	if (hours > 0) { const run = () => hosted.sync().then((r) => console.log('hosted sync:', Object.entries(r).map(([k, v]) => `${k} ${v.ok ? v.count : 'failed'}`).join(', '))).catch((e) => console.error('hosted sync:', e.message)); setTimeout(run, 45000).unref(); setInterval(run, hours * 3600 * 1000).unref(); }
}
const whmcsCfg = { url: (env.WHMCS_URL || '').trim(), accessKey: (env.WHMCS_ACCESS_KEY || '').trim() };
const whmcsClient = makeWhmcsClient({ ...whmcsCfg, identifier: (env.WHMCS_API_IDENTIFIER || env.WHMCS_API_ID || '').trim(), secret: (env.WHMCS_API_SECRET || '').trim() });
const whmcs = portal && portalDb ? createWhmcs({ db: portalDb, whmcs: whmcsClient }) : null;
if (whmcs) {
	app.use('/api/whmcs', whmcsRouter({ need, whmcs, audit: portal.audit }));
	const wh = Number(env.WHMCS_SYNC_HOURS ?? 12);
	if (wh > 0 && whmcs.available()) { const run = () => whmcs.sync().then((r) => console.log('whmcs sync:', r.ok ? `${r.clients} clients, ${r.services} services, ${r.invoices} invoices` : 'failed')).catch((e) => console.error('whmcs sync:', e.message)); setTimeout(run, 90000).unref(); setInterval(run, wh * 3600 * 1000).unref(); }
}
let analytics = null;
if (portal && portalDb) {
	const ga4 = makeGa4({ propertyId: (env.GOOGLE_ANALYTICS_PROPERTY_ID || '').trim(), email: (env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '').trim(), key: env.GOOGLE_SERVICE_ACCOUNT_KEY || '' });
	analytics = createAnalytics({ db: portalDb, clients: deployClients, ga4, store: deployStore, whmcs, hosted, ownDomains: (env.OWN_DOMAINS || 'churchwebglobal.com,churchwebsupport.com').split(',').map((x) => x.trim()).filter(Boolean) });
	app.use('/api/analytics', analyticsRouter({ need, analytics }));
}
let assistant = null, support = null;
if (portal) {
	assistant = createAssistant({ tools: buildTools({ store: deployStore, clients: deployClients, dir: portal.dir, outreach, audit: portal.audit, hosted, whmcs, analytics, getSupport: () => support }), audit: portal.audit, clients: deployClients, env });
	app.use('/api/assistant', assistantRouter({ need, assistant }));
}
if (portal && portalDb && assistant) {
	// Support has its own WHMCS login (ticket actions only). Billing stays read-only. With only the billing login, tickets can be read but not answered.
	const supportClient = makeWhmcsClient({ ...whmcsCfg, identifier: (env.WHMCS_SUPPORT_API_ID || '').trim(), secret: (env.WHMCS_SUPPORT_API_SECRET || '').trim(), actions: SUPPORT_ACTIONS });
	const mail = deployClients.cfg.postmarkServerToken ? { send: ({ to, subject, text }) => deployClients.postmark.sendEmail({ From: (env.SUPPORT_FROM || 'support@churchwebglobal.com').trim(), To: to.join(','), Subject: subject, TextBody: text, MessageStream: 'outbound' }) } : null;
	support = createSupport({ db: portalDb, reader: supportClient.available() ? supportClient : whmcsClient, writer: supportClient, ai: { available: () => assistant.configured(), complete: assistant.complete }, mail, env });
	app.use('/api/support', supportRouter({ need, support }));
	const mins = Number(env.SUPPORT_POLL_MINUTES ?? 5);
	if (mins > 0) { const run = () => support.run().then((r) => r.skipped || console.log('support:', `${r.synced} changed, ${r.triaged} sorted, ${r.acted} handled${r.errors.length ? ', problems: ' + r.errors.join('; ') : ''}`)).catch((e) => console.error('support:', e.message)); setTimeout(run, 120000).unref(); setInterval(run, mins * 60000).unref(); }
}
if (outreach) app.use('/api/outreach', outreachRouter({ need, outreach, loops, webhookSecret: LOOPS_WEBHOOK_SECRET }));
app.get('/email', page('email.html'));
app.get('/deploy', page('deploy.html'));
app.get('/directory', page('directory.html', { dbOnly: true }));
app.get('/activity', page('activity.html', { dbOnly: true }));
app.get('/domains', page('domains.html', { dbOnly: true }));
app.get('/whmcs', page('whmcs.html', { dbOnly: true }));
app.get('/support', page('support.html', { dbOnly: true }));
app.get('/analytics', page('analytics.html', { dbOnly: true }));
app.get('/users', page('users.html', { dbOnly: true }));
app.get('/account', page('account.html', { dbOnly: true }));

app.get('/api/config', need, (req, res) => res.json({ apiAvailable: API_AVAILABLE, maxPagesCap: MAX_PAGES_CAP, retentionHours: RETENTION_MS / 3600000, allowedDomains: ALLOWED_DOMAINS }));
app.get('/api/jobs', need, (req, res) => res.json([...jobs.values()].sort((a, b) => b.created - a.created).map(publicJob)));
app.get('/api/jobs/:id', need, (req, res) => {
	const j = jobs.get(req.params.id);
	if (!j) return res.status(404).json({ error: 'Not found' });
	res.json({ ...publicJob(j), log: j.log.slice(-200) });
});
async function enqueue(b, by) {
	if (queue.length + running.size >= MAX_QUEUE) {
		const e = new Error('The queue is full. Wait for some jobs to finish.');
		e.status = 429;
		throw e;
	}
	const domain = await validateDomain(b.domain);
	const site = b.site ? String(b.site).trim() : '';
	if (site && !/^[A-Za-z0-9_-]{3,40}$/.test(site)) throw new Error('Site name looks wrong (letters and numbers only)');
	const useApi = Boolean(b.useApi) && API_AVAILABLE;
	const maxPages = Math.min(MAX_PAGES_CAP, Math.max(0, parseInt(b.maxPages, 10) || 0));
	const id = crypto.randomBytes(8).toString('hex');
	fs.mkdirSync(jobDir(id), { recursive: true });
	const mode = ['auto', 'duda', 'generic'].includes(b.mode) ? b.mode : 'auto';
	const preview = Boolean(b.preview);
	const label = String(b.label || '').replace(/[\u0000-\u001f]/g, '').slice(0, 80);
	const j = { id, label, domain, site, useApi, status: 'queued', created: Date.now(), log: [], by, opts: { maxPages, skipImages: Boolean(b.skipImages), mode, preview } };
	jobs.set(id, j);
	persist(j);
	queue.push(j);
	logLine(j, `queued: ${label ? label + ' · ' : ''}${domain}${useApi ? (site ? ` (DUDA site ${site})` : ' (DUDA API, site lookup by domain)') : ' (public pages only)'}`);
	pump();
	return j;
}
app.post('/api/jobs', need, async (req, res) => {
	try {
		res.status(201).json(publicJob(await enqueue(req.body || {}, req.by)));
	} catch (e) {
		res.status(e.status || 400).json({ error: e.message });
	}
});
// Several prospects at once: one per line ("Church name, website" or just the website). Runs one after another.
app.post('/api/batch', need, async (req, res) => {
	const b = req.body || {};
	const rows = parseBatch(b.text);
	if (!rows.length) return res.status(400).json({ error: 'Paste at least one website, one per line.' });
	if (rows.length > MAX_BATCH) return res.status(400).json({ error: `Up to ${MAX_BATCH} websites at a time (you pasted ${rows.length}).` });
	const results = [];
	for (const r of rows) {
		if (r.duplicate) {
			results.push({ ...r, ok: false, error: 'Listed twice; skipped.' });
			continue;
		}
		try {
			const j = await enqueue({ ...b, domain: r.domain, label: r.label, site: '', useApi: false }, req.by);
			results.push({ label: r.label, domain: j.domain, ok: true, id: j.id });
		} catch (e) {
			results.push({ label: r.label, domain: r.domain, ok: false, error: e.message });
			if (e.status === 429) {
				const rest = rows.slice(results.length);
				for (const x of rest) results.push({ label: x.label, domain: x.domain, ok: false, error: 'Not queued: the queue is full.' });
				break;
			}
		}
	}
	res.json({ queued: results.filter((x) => x.ok).length, results });
});
app.get('/api/jobs.csv', need, (req, res) => {
	const rows = [['Name', 'Website', 'Status', 'Pages', 'Images', 'Documents', 'Zip MB', 'To check', 'Started', 'Error']];
	for (const j of [...jobs.values()].sort((a, b) => a.created - b.created)) {
		const s = j.summary || {};
		rows.push([j.label || '', j.domain, j.status, s.pages ?? '', s.images ?? '', s.documents ?? '', s.zipMB ?? '', s.flags ?? '', j.started ? new Date(j.started).toISOString() : '', j.error || '']);
	}
	res.type('text/csv').set('Content-Disposition', 'attachment; filename="exports.csv"').send(rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n');
});
app.post('/api/jobs/:id/cancel', need, (req, res) => {
	const j = jobs.get(req.params.id);
	if (!j) return res.status(404).json({ error: 'Not found' });
	if (j.status === 'queued') {
		j.status = 'canceled';
		j.ended = Date.now();
		persist(j);
	} else if (j.status === 'running') {
		j.canceled = true;
		try {
			process.kill(j.pid, 'SIGKILL');
		} catch {}
	}
	res.json(publicJob(j));
});
app.delete('/api/jobs/:id', need, (req, res) => {
	const j = jobs.get(req.params.id);
	if (!j) return res.status(404).json({ error: 'Not found' });
	if (j.status === 'running' || j.status === 'queued') return res.status(409).json({ error: 'Cancel it first' });
	fs.rmSync(jobDir(j.id), { recursive: true, force: true });
	jobs.delete(j.id);
	res.json({ ok: true });
});
app.get('/api/jobs/:id/download', need, (req, res) => {
	const j = jobs.get(req.params.id);
	if (!j || j.status !== 'done' || !j.zip) return res.status(404).json({ error: 'No ZIP for this job' });
	res.download(path.join(jobDir(j.id), j.zip), (slug(j.label) || slug(j.domain) || 'export') + '.zip');
});
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, () => console.log(`duda-export-web listening on :${PORT} (data: ${DATA_DIR}, concurrency ${MAX_CONCURRENT}, DUDA API ${API_AVAILABLE ? 'configured' : 'not configured'})`));
