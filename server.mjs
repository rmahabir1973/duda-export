import { parseBatch, MAX_BATCH, slug, csvCell } from './batch.mjs';
import express from 'express';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

/* ---------------------------------------------------------------- web */
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req, res, next) => {
	res.set({
		'X-Content-Type-Options': 'nosniff',
		'X-Frame-Options': 'DENY',
		'Referrer-Policy': 'no-referrer',
		'Cache-Control': 'no-store',
		'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
	});
	next();
});
app.get('/healthz', (req, res) => res.type('text').send('ok'));
app.use(express.json({ limit: '20kb' }));
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
const need = (req, res, next) => {
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

app.get('/', (req, res) => res.type('html').send(html(auth(req) === 'session' ? 'app.html' : 'login.html')));

app.post('/login', (req, res) => {
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
app.post('/logout', (req, res) => {
	res.clearCookie('cw_session', { path: '/' });
	res.json({ ok: true });
});

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
