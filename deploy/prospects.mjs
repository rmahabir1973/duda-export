// Prospects: one simple flow per church (add, export, create site, build, ready) that runs on its own.
// It chains the existing exporter and the existing preview-site checks/fixes, so there is no second copy of that logic.
// Each church record gets `prospect` (what staff entered) and `run` (what the runner is doing and how far it got).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import * as realChecks from './checks.mjs';
import { priceTable, snapshot, priceDelta } from './pricing.mjs';
import { configured, shq } from './clients.mjs';
import { slugify, normDomain, SLUG_RE, DOMAIN_RE } from './store.mjs';
import { extractDocument } from './docs.mjs';
import { buildBrief } from './brief.mjs';

const DAY = 86400000;
export const PREVIEW_DAYS = 30;
const FIX_WAIT_MS = 180000; // after a fix that was accepted, give Hostinger this long before trying again
const MAX_ATTEMPTS = 3;
const BUILD_SILENCE_MS = 25 * 60000; // the build stopped reporting
const DOC_EXT = /\.(txt|md|csv|html?|rtf|pdf|docx?|odt|xlsx?)$/i;
const MAX_DOC = 10 * 1048576;
const EXTEND_DAYS = 7;
const POLL_AFTER_MS = 15000, POLL_EVERY_MS = 15000;
// A preview lives on *.churchwebglobal.com, which already resolves through the wildcard record, so the portal never touches DNS for it. DNS comes back at go-live.
// The Hostinger plugins are removed last, after the build, because removing them first stalled on some sites.
const SKIP_REQS = new Set(['dns', 'hostingerPlugins']);
const CLEANUP_MS = 5 * 60000;
const needed = (engine, stage, ch) => engine.reqsFor(stage, ch).filter((q) => !SKIP_REQS.has(q.id));

/** What the screen says while each preview-site step is being done. */
const DOING = {
	site: 'Creating the site on Hostinger', folder: 'Installing WordPress', dns: 'Setting up the preview address', plugins: 'Copying our plugins',
	plugin: 'Switching on the AI Assistant', hostingerPlugins: 'Removing the Hostinger extras', staffview: 'Turning on the simple staff view',
	teamLogin: 'Creating the team login', connected: 'Connecting the AI Assistant', address: 'Setting the site address', title: 'Setting the church name', preview: 'Hiding the site from Google', oxygen: 'Adding the Oxygen licence',
};
const doing = (q) => DOING[q.id] || q.label;
const blankStep = () => ({ state: 'waiting', message: '', pct: null });
export const blankRun = () => ({ state: 'idle', steps: { export: blankStep(), site: blankStep(), build: blankStep() }, attempts: {}, lastFix: {}, answers: {}, started: null, updated: null });

const clip = (s, n = 300) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
/** Plain words for a failure: keep it short and never show a stack trace or a secret-looking string. */
export const plain = (m) => clip(String(m || 'Something went wrong.').replace(/\b[A-Za-z0-9_-]{32,}\b/g, '••••'), 240);

/** Pull a church name out of a page title: drop "Home", "Welcome", and the tagline after a separator. */
export function nameFromTitle(title, domain) {
	const t = String(title || '').replace(/&amp;/g, '&').replace(/&#0*39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
	const parts = t.split(/\s*(?:\||–|—|·|•|:| - )\s*/).map((x) => x.trim()).filter((x) => x && !/^(home|welcome|homepage|home page|main)$/i.test(x));
	const church = parts.find((x) => /church|chapel|parish|cathedral|synagogue|congregation|ministr|united|baptist|anglican|lutheran|presbyterian|catholic/i.test(x));
	const pick = church || parts[0];
	if (pick && pick.length >= 3 && pick.length <= 80) return pick;
	const label = String(domain || '').split('.')[0].replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
	return label || 'New church';
}
export function platformFromHtml(html) {
	const h = String(html || '').slice(0, 400000);
	if (/static\.cdn-website\.com|dmAlbum|_dm_|dudaone|multiscreensite\.com/i.test(h)) return 'DUDA';
	if (/wp-content\/|wp-includes\//i.test(h)) return 'WordPress';
	if (/wixstatic\.com|wix\.com/i.test(h)) return 'Wix';
	if (/squarespace/i.test(h)) return 'Squarespace';
	if (/weebly/i.test(h)) return 'Weebly';
	return '';
}
const titleOf = (html) => { const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || '').slice(0, 200000)); return m ? m[1] : ''; };

export function createProspects({ store, clients, exporter, dataDir, notify = null, secret = '', now = Date.now, autoDelete = false, alertTo = [], baseUrl = '', engine = realChecks, log = console.error } = {}) {
	const dir = (id) => path.join(dataDir, 'prospects', id);
	const key = crypto.createHash('sha256').update('prospects|' + (secret || crypto.randomBytes(32).toString('hex'))).digest();
	const busy = new Set();
	const sign = (id, ttlMs = 8 * 3600000) => { const exp = now() + ttlMs, body = `${id}.${exp}`; return Buffer.from(body).toString('base64url') + '.' + crypto.createHmac('sha256', key).update(body).digest('base64url'); };
	const verify = (token) => {
		try {
			const [b, mac] = String(token || '').split('.'), body = Buffer.from(b, 'base64url').toString(), want = crypto.createHmac('sha256', key).update(body).digest('base64url');
			if (!mac || mac.length !== want.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
			const i = body.lastIndexOf('.'), id = body.slice(0, i), exp = Number(body.slice(i + 1));
			return exp > now() ? id : null;
		} catch { return null; }
	};
	const adminPw = (ch) => crypto.createHmac('sha256', key).update('wp-admin|' + ch.slug).digest('base64url').slice(0, 20) + 'aA1!';
	const ctxFor = () => ({ c: clients, configured: configured(clients.cfg), memo: {}, facts: null, secret: null, adminPassword: adminPw });
	const mailTo = (ch) => [...new Set([/@/.test(ch.createdBy || '') ? ch.createdBy : '', ...(alertTo || [])].filter(Boolean))];
	const tell = async (ch, subject, text, alert = false) => { if (!notify) return; try { await notify({ to: alert ? [...new Set(alertTo || [])] : mailTo(ch), subject, text }); } catch (e) { log('prospects: could not send a notice:', e.message); } };

	/* ------------------------------------------------------------ run helpers */
	const patch = (id, fn) => store.update(id, (c) => { c.run ||= blankRun(); fn(c.run, c); c.run.updated = now(); });
	const setStep = (id, k, p, runPatch) => patch(id, (r) => { r.steps[k] = { ...r.steps[k], ...p }; if (runPatch) Object.assign(r, runPatch); });
	const note = (id, text, level = 'info') => store.log(id, 'prospects', text, level);

	/* ------------------------------------------------------------ step 2: export */
	async function stepExport(ch) {
		const p = ch.prospect, run = ch.run;
		if (run.steps.export.state === 'done') return false;
		if (!run.exportJobId) {
			try {
				const j = await exporter.enqueue({ domain: p.domain, label: ch.name, preview: p.mode !== 'full', mode: 'auto' }, 'prospects');
				patch(ch.id, (r) => { r.exportJobId = j.id; r.steps.export = { state: 'working', message: 'Waiting to start the export…', pct: null }; });
				note(ch.id, 'Export started');
			} catch (e) { setStep(ch.id, 'export', { state: 'failed', message: plain(e.message) }, { state: 'failed' }); await tell(ch, `Export could not start: ${ch.name}`, plain(e.message), true); }
			return true;
		}
		const j = exporter.get(run.exportJobId);
		if (!j) { patch(ch.id, (r) => { r.exportJobId = null; r.steps.export = { state: 'failed', message: 'The export was lost (the portal restarted). Press Try again.', pct: null }; r.state = 'failed'; }); return true; }
		if (j.status === 'queued') { setStep(ch.id, 'export', { state: 'working', message: 'Waiting in line for the export…' }); return true; }
		if (j.status === 'running') { setStep(ch.id, 'export', { state: 'working', message: clip(j.lastLog || 'Reading the church website…', 140) }); return true; }
		if (j.status === 'done' && j.zipPath) {
			fs.mkdirSync(dir(ch.id), { recursive: true });
			fs.copyFileSync(j.zipPath, path.join(dir(ch.id), 'export.zip'));
			const s = j.summary || {}, platform = ch.prospect.platform || j.platform || '';
			store.update(ch.id, (c) => { c.prospect.platform = platform; c.prospect.exported = { pages: s.pages ?? null, images: s.images ?? null, zipMB: s.zipMB ?? null, at: now() }; });
			setStep(ch.id, 'export', { state: 'done', message: s.pages != null ? `Exported ${s.pages} page${s.pages === 1 ? '' : 's'} and ${s.images ?? 0} images.` : 'Export finished.', pct: 100 });
			note(ch.id, 'Export finished');
			return true;
		}
		const why = plain(j.error || 'The export did not finish.');
		patch(ch.id, (r) => { r.steps.export = { state: 'failed', message: why, pct: null }; r.state = 'failed'; });
		await tell(ch, `Export failed: ${ch.name}`, `${ch.prospect.domain}: ${why}`, true);
		return true;
	}

	/* ------------------------------------------------------------ step 3: create the site */
	async function stepSite(ch) {
		const run = ch.run;
		if (run.steps.site.state === 'done') return false;
		const stage = engine.STAGES.find((s) => s.key === 'preview');
		for (let guard = 0; guard < 24; guard++) {
			const cur = store.get(ch.id), ctx = ctxFor();
			const results = await engine.testStage(ctx, cur, stage);
			const reqs = needed(engine, stage, cur).filter((q) => !q.manual);
			const total = reqs.length + 1, done = reqs.filter((q) => engine.isSatisfied(results[q.id]?.state)).length;
			const saveResults = (extra = {}) => store.update(ch.id, (c) => { const st = (c.stages.preview ||= {}); st.results = { ...results, ...extra }; st.at = now(); st.done = needed(engine, stage, c).every((q) => engine.isSatisfied(st.results[q.id]?.state)); });
			const next = reqs.find((q) => !engine.isSatisfied(results[q.id]?.state) && results[q.id]?.state !== 'blocked');
			if (!next) {
				// everything else is in place: the Oxygen licence, then we are done
				const lic = await engine.applyOxygenLicense(ctx, cur);
				if (lic.state !== 'ok') { saveResults(); setStep(ch.id, 'site', { state: 'failed', message: plain(lic.detail), pct: Math.round(100 * done / total) }, { state: 'failed' }); await tell(cur, `Site setup stopped: ${cur.name}`, plain(lic.detail), true); return true; }
				store.update(ch.id, (c) => { const st = (c.stages.preview ||= {}); (st.manual ||= {}).oxygen = true; st.results = { ...results, oxygen: { state: 'ok', detail: lic.detail } }; st.at = now(); st.done = needed(engine, stage, c).every((q) => engine.isSatisfied(st.results[q.id]?.state)); c.prospect.siteReadyAt = now(); c.prospect.expiresAt = now() + PREVIEW_DAYS * DAY; });
				setStep(ch.id, 'site', { state: 'done', message: `The preview site is ready at ${previewHost(cur)}.`, pct: 100 });
				note(ch.id, 'Preview site created');
				return true;
			}
			saveResults();
			const r = results[next.id] || {};
			const pct = Math.round(100 * done / total);
			if (r.state === 'unknown') { setStep(ch.id, 'site', { state: 'failed', message: plain(r.detail || `Can't check: ${next.label}`), pct }, { state: 'failed' }); await tell(cur, `Site setup stopped: ${cur.name}`, plain(r.detail), true); return true; }
			if (!next.fix) { setStep(ch.id, 'site', { state: 'failed', message: plain(`This step needs a person: ${next.label}`), pct }, { state: 'failed' }); return true; }
			const last = cur.run.lastFix?.[next.id];
			if (last && last.ok && now() - last.at < FIX_WAIT_MS) { setStep(ch.id, 'site', { state: 'working', message: `${doing(next)}… (this can take a minute or two)`, pct }); return true; }
			const tries = cur.run.attempts?.[next.id] || 0;
			if (tries >= MAX_ATTEMPTS) { const m = `${doing(next)} did not work after ${MAX_ATTEMPTS} tries. ${plain(last?.detail || r.detail)}`; setStep(ch.id, 'site', { state: 'failed', message: m, pct }, { state: 'failed' }); await tell(cur, `Site setup stopped: ${cur.name}`, m, true); return true; }
			setStep(ch.id, 'site', { state: 'working', message: `${doing(next)}…`, pct });
			let out;
			try { out = await engine.fixReq(ctx, cur, stage, next, r); } catch (e) { out = { ok: false, detail: e.message }; }
			patch(ch.id, (rr) => { rr.attempts[next.id] = (rr.attempts[next.id] || 0) + 1; rr.lastFix[next.id] = { at: now(), ok: !!out.ok, detail: clip(out.detail, 200) }; });
			note(ch.id, `${doing(next)}: ${out.ok ? 'done' : 'could not do it'}${out.detail && !out.ok ? ' (' + clip(out.detail, 120) + ')' : ''}`, out.ok ? 'info' : 'warn');
			if (out.ok && !['site', 'folder', 'dns'].includes(next.id)) continue; // quick steps: carry straight on
			return true;
		}
		return true;
	}

	/* ------------------------------------------------------------ step 4: build */

	/** Start (or, after a question, resume) the plugin's build on the church's site. It runs on the server on its own and reports back through the signed callback. */
	async function triggerBuild(ch, ctx, { resume = false, answer = '' } = {}) {
		const tok = sign(ch.id), q = (p) => `${baseUrl}/api/build/${ch.id}/${p}?t=${encodeURIComponent(tok)}`;
		const parts = ['cwai portal-build', `--callback=${shq(`${baseUrl}/api/build/${ch.id}/status`)}`, `--token=${shq(tok)}`, `--mode=${ch.prospect.mode === 'full' ? 'full' : 'preview'}`];
		const paths = ch.run?.pushed;
		if (resume) parts.push('--resume', `--answer=${shq(answer)}`); else parts.push(`--package=${shq(paths?.package || q('package.zip'))}`, `--brief=${shq(paths?.brief || q('brief.md'))}`);
		return engine.runWpBackground(ctx, ch, parts.join(' '), ch.slug);
	}
	/** Put the ZIP and the brief on the site's server over SSH, so the site never has to reach the portal to get them. */
	async function pushFiles(ch) {
		const ssh = clients.ssh;
		if (!ssh?.available?.()) return null;
		const home = String((await ssh.exec('echo $HOME', { timeout: 20000 })).out || '').trim();
		if (!/^\/[\w./-]+$/.test(home)) throw new Error('Could not find the home folder on the server.');
		const d = `${home}/cwai-portal/${ch.slug}`, put = async (name, buf) => {
			const r = await ssh.exec(`mkdir -p ${shq(d)} && cat > ${shq(`${d}/${name}`)} && wc -c < ${shq(`${d}/${name}`)}`, { input: buf, timeout: 600000 });
			if (r.code !== 0 || Number(String(r.out).trim()) !== buf.length) throw new Error(`Could not copy ${name} to the site (${String(r.err || r.out).trim().slice(-120)}).`);
		};
		await put('package.zip', fs.readFileSync(path.join(dir(ch.id), 'export.zip')));
		await put('brief.md', Buffer.from(briefFor(ch)));
		return { package: `${d}/package.zip`, brief: `${d}/brief.md` };
	}
	const previewHost = (ch) => `${ch.slug}.${clients.cfg.previewDomain}`;
	/* ------------------------------------------------------------ what the AI cost
	   Each church site has its own gateway key, and the gateway counts every call per site. A job's cost is the difference between the gateway's totals when the job started and now, so a re-used site name or a retry can't muddy it.
	   A retry adds to the same job (it is money spent), and the finished figure is kept in a small file so deleted previews still count toward the averages. */
	const prices = priceTable(clients.cfg?.aiPrices);
	const ledgerFile = path.join(dataDir, 'ai-costs.json');
	const readLedger = () => { try { return JSON.parse(fs.readFileSync(ledgerFile, 'utf8')) || {}; } catch { return {}; } };
	const jobOf = (ch) => (ch.prospect?.mode === 'full' ? 'full' : 'preview');
	const COST_EVERY_MS = 30000;
	async function costBase(ch) {
		const job = jobOf(ch);
		if (ch.prospect.cost?.[job] || !clients.gateway?.available?.() || !clients.gateway.usageDetail) return;
		let entry;
		try { const d = await clients.gateway.usageDetail(ch.slug); entry = { base: snapshot(d.sites, ch.slug), startedAt: now(), usd: 0, calls: 0 }; }
		catch (e) { entry = { base: null, startedAt: now(), error: clip(e.message, 200) }; }
		store.update(ch.id, (c) => { (c.prospect.cost ||= {})[job] = entry; });
	}
	async function costRefresh(id, force = false) {
		const ch = store.get(id), job = ch?.prospect && jobOf(ch), e = job && ch.prospect.cost?.[job];
		if (!e || !e.base || (e.final && !force) || !clients.gateway?.usageDetail) return;
		if (!force && now() - (e.at || 0) < COST_EVERY_MS) return;
		let d;
		try { d = await clients.gateway.usageDetail(ch.slug); } catch (err) { log('prospects cost:', err.message); return; }
		const r = priceDelta(snapshot(d.sites, ch.slug), e.base, prices);
		store.update(id, (c) => { const x = c.prospect.cost?.[job]; if (x) Object.assign(x, { usd: r.usd, calls: r.calls, tokens: r.tokens, images: r.images, byModel: r.byModel, estimated: r.estimated, at: now() }); });
		try { const l = readLedger(); l[`${id}:${job}`] = { id, name: ch.name, job, usd: r.usd, calls: r.calls, startedAt: e.startedAt, at: now(), final: !!e.final }; fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(ledgerFile, JSON.stringify(l)); } catch { /* the figure on the church record still shows */ }
	}
	/** The build finished or stopped: take the last reading. A finished build closes the job; a failed one stays open in case it is retried. */
	async function costClose(id, done) {
		const ch = store.get(id); if (!ch?.prospect) return;
		await costRefresh(id, true);
		if (done) { const job = jobOf(ch); store.update(id, (c) => { const x = c.prospect.cost?.[job]; if (x) { x.final = true; x.endedAt = now(); } }); await costRefresh(id, true); }
	}
	const costView = (ch) => {
		const c = ch.prospect?.cost || {};
		const one = (j) => { const e = c[j]; if (!e) return null; if (!e.base) return { state: 'unavailable', note: e.error || 'No reading was taken when the build started.' }; return { state: e.final ? 'final' : 'running', usd: Math.round((e.usd || 0) * 100) / 100, calls: e.calls || 0, estimated: !!e.estimated, tokens: e.tokens || null, byModel: e.byModel || [] }; };
		return { preview: one('preview'), full: one('full'), tracked: !!clients.gateway?.available?.() };
	};
	/** Averages and totals over every finished or running job, including previews that were deleted since. */
	function costSummary() {
		const rows = Object.values(readLedger()), by = (job) => rows.filter((x) => x.job === job && x.usd > 0);
		const stat = (list) => ({ n: list.length, avg: list.length ? Math.round(list.reduce((a, x) => a + x.usd, 0) / list.length * 100) / 100 : 0, max: list.length ? Math.round(Math.max(...list.map((x) => x.usd)) * 100) / 100 : 0 });
		const since = now() - 30 * DAY;
		return { total: Math.round(rows.reduce((a, x) => a + x.usd, 0) * 100) / 100, last30: Math.round(rows.filter((x) => x.at >= since).reduce((a, x) => a + x.usd, 0) * 100) / 100, preview: stat(by('preview')), full: stat(by('full')) };
	}

	const briefFor = (ch) => buildBrief({ name: ch.name, domain: ch.prospect.domain, platform: ch.prospect.platform, mode: ch.prospect.mode, notes: ch.prospect.notes, docs: ch.prospect.docs, existing: !!ch.prospect.switchedAt });
	async function stepBuild(ch) {
		const run = ch.run, b = run.steps.build;
		if (b.state === 'done' || b.state === 'needs_input') return false;
		if (b.state === 'working' && run.buildStartedAt) {
			// If the site has gone quiet, ask it directly (the progress messages can be blocked on the way here): its own saved state says what happened.
			if (now() - (run.buildHeardAt || run.buildStartedAt) > POLL_AFTER_MS && now() - (run.polledAt || 0) > POLL_EVERY_MS) {
				patch(ch.id, (r) => { r.polledAt = now(); });
				try {
					const o = await engine.runWp(ctxFor(), ch, 'option get cwai_portal_build --format=json');
					const st = o.code === 0 ? JSON.parse(String(o.out || '').trim().split('\n').pop() || '{}') : null;
					if (st && Number(st.updated) * 1000 >= run.buildStartedAt - 5000 && ['failed', 'done', 'working', 'question'].includes(st.state) && (st.message || st.state !== 'working')) {
						const seen = run.steps.build;
						if (st.state === 'working' && st.message === seen.message && st.pct === seen.pct) return false; // nothing new
						reportBuild(ch.id, { state: st.state, message: st.message, pct: st.pct, question: st.question });
						return true;
					}
				} catch { /* the normal timeout below still applies */ }
			}
			if (now() - (run.buildHeardAt || run.buildStartedAt) > BUILD_SILENCE_MS) { setStep(ch.id, 'build', { state: 'failed', message: 'The build stopped reporting back. Press Try again.' }, { state: 'failed' }); await tell(ch, `Build stalled: ${ch.name}`, 'The build stopped reporting back.', true); }
			return false; // progress arrives from the plugin
		}
		fs.mkdirSync(dir(ch.id), { recursive: true });
		fs.writeFileSync(path.join(dir(ch.id), 'brief.md'), briefFor(ch));
		const ctx = ctxFor();
		const has = await engine.runWp(ctx, ch, 'help cwai portal-build');
		if (has.unavailable) { setStep(ch.id, 'build', { state: 'failed', message: 'Hostinger SSH isn\'t set up on this server, so the build can\'t be started.' }, { state: 'failed' }); return true; }
		if (has.code !== 0) {
			patch(ch.id, (r) => { r.steps.build = { state: 'blocked', message: 'The site is ready and the content is packaged. The AI Assistant plugin needs its portal-build update before the portal can start the design on its own. Until then, import the ZIP by hand.', pct: null }; r.state = 'waiting'; });
			note(ch.id, 'Build waiting for the plugin\'s portal-build command', 'warn');
			return true;
		}
		await costBase(ch); ch = store.get(ch.id);
		try { const pushed = await pushFiles(ch); patch(ch.id, (rr) => { rr.pushed = pushed; }); ch = store.get(ch.id); }
		catch (e) { setStep(ch.id, 'build', { state: 'failed', message: plain(e.message) }, { state: 'failed' }); return true; }
		const r = await triggerBuild(ch, ctx, {});
		if (r.code !== 0) { setStep(ch.id, 'build', { state: 'failed', message: plain('Could not start the build. ' + (r.err || r.out || '')) }, { state: 'failed' }); return true; }
		patch(ch.id, (rr) => { rr.buildStartedAt = now(); rr.buildHeardAt = now(); rr.polledAt = 0; rr.steps.build = { state: 'working', message: 'Importing the content and starting the design…', pct: 5 }; });
		note(ch.id, 'Build started');
		return true;
	}

	/** After the site is built: deactivate and delete Hostinger's own plugins. It never holds anything up: a failure is only noted. */
	async function cleanup(id) {
		const ch = store.get(id); if (!ch?.run || ch.run.cleanup || ch.run.steps.build.state !== 'done') return;
		patch(id, (r) => { r.cleanup = { state: 'working', message: 'Removing the Hostinger plugins…', at: now() }; });
		const stage = engine.STAGES.find((x) => x.key === 'preview'), req = engine.reqsFor(stage, ch).find((q) => q.id === 'hostingerPlugins');
		let out;
		try {
			if (!req) out = { ok: true, detail: 'Nothing to remove.' };
			else out = await Promise.race([engine.fixReq(ctxFor(), store.get(id) || ch, stage, req, {}), new Promise((res) => setTimeout(() => res({ ok: false, detail: 'It took too long. Remove them by hand in WordPress → Plugins.' }), CLEANUP_MS).unref())]);
		} catch (e) { out = { ok: false, detail: e.message }; }
		if (!store.get(id)) return;
		patch(id, (r) => { r.cleanup = { state: out.ok ? 'done' : 'failed', message: plain(out.detail || ''), at: now() }; });
		note(id, `Hostinger plugins: ${out.ok ? 'removed' : 'could not remove (' + clip(out.detail, 120) + ')'}`, out.ok ? 'info' : 'warn');
	}
	const cleaning = new Set();
	const runCleanup = (id) => { if (cleaning.has(id)) return; cleaning.add(id); cleanup(id).catch((e) => log('prospects cleanup:', e.message)).finally(() => cleaning.delete(id)); };

	/* ------------------------------------------------------------ the runner */
	async function tick(id) {
		if (busy.has(id)) return;
		busy.add(id);
		try {
			let ch = store.get(id);
			if (!ch?.run || ch.run.state !== 'running') return;
			if (await stepExport(ch)) return;
			ch = store.get(id); if (ch.run.state !== 'running') return;
			if (await stepSite(ch)) return;
			ch = store.get(id); if (ch.run.state !== 'running') return;
			if (await stepBuild(ch)) return;
			ch = store.get(id);
			if (ch.run.steps.build.state === 'done' && ch.run.state === 'running') { patch(id, (r) => { r.state = 'done'; }); }
		} catch (e) {
			log('prospects tick:', e.message);
			try { patch(id, (r) => { r.state = 'failed'; const k = ['export', 'site', 'build'].find((s) => r.steps[s].state !== 'done'); if (k) r.steps[k] = { ...r.steps[k], state: 'failed', message: plain(e.message) }; }); } catch { /* record gone */ }
		} finally { busy.delete(id); }
	}
	const tickAll = async () => { for (const c of store.list()) { if (['running', 'needs_input'].includes(c.run?.state) && c.prospect?.cost) costRefresh(c.id).catch((e) => log('prospects cost:', e.message)); if (c.run?.state === 'running') await tick(c.id); else if (c.run?.state === 'done' && !c.run.cleanup) runCleanup(c.id); } };

	/** Start (or restart after a failure, or resume) a church's run. Finished steps are never redone. */
	function start(id) {
		const ch = store.get(id);
		if (!ch?.prospect) throw new Error('Not a prospect.');
		patch(id, (r) => {
			r.state = 'running'; r.started ||= now();
			for (const k of ['export', 'site', 'build']) if (r.steps[k].state === 'failed' || r.steps[k].state === 'blocked') r.steps[k] = { state: 'waiting', message: '', pct: null };
			r.attempts = {}; r.lastFix = {};
			if (r.steps.export.state === 'waiting') { r.exportJobId = null; }
		});
		return store.get(id);
	}

	/** Called by the plugin (through the signed callback): progress, a question, or the result. */
	function reportBuild(id, body = {}) {
		const ch = store.get(id); if (!ch?.run) throw new Error('Unknown church.');
		const state = String(body.state || ''), message = clip(body.message || '', 300), pct = Number.isFinite(Number(body.pct)) ? Math.max(0, Math.min(100, Number(body.pct))) : null;
		patch(id, (r) => {
			r.buildHeardAt = now();
			if (state === 'working') r.steps.build = { state: 'working', message: message || 'Building the site…', pct: pct ?? r.steps.build.pct };
			else if (state === 'question') {
				const qid = clip(body.question?.id || crypto.randomBytes(4).toString('hex'), 40);
				r.steps.build = { state: 'needs_input', message: 'The AI needs an answer to carry on.', pct: r.steps.build.pct, question: { id: qid, text: clip(body.question?.text, 600), options: (body.question?.options || []).map((o) => clip(o, 120)).slice(0, 6), asked: now() } };
				r.state = 'needs_input';
			} else if (state === 'done') { r.steps.build = { state: 'done', message: message || 'The site is built.', pct: 100 }; r.state = 'done'; }
			else if (state === 'failed') { r.steps.build = { state: 'failed', message: plain(message || 'The build failed.'), pct: null }; r.state = 'failed'; }
		});
		const after = store.get(id), s = after.run.steps.build;
		if (s.state === 'needs_input') tell(after, `Your answer is needed: ${after.name}`, `The AI building ${after.name} has a question:\n\n${s.question.text}\n\nAnswer it in the portal: ${baseUrl}/prospects`);
		if (s.state === 'done') runCleanup(id);
		if (s.state === 'done' || s.state === 'failed') costClose(id, s.state === 'done').catch((e) => log('prospects cost:', e.message));
		if (s.state === 'done') tell(after, `Preview ready: ${after.name}`, `The preview for ${after.name} is ready:\nhttps://${previewHost(after)}\n\nIt will be deleted on ${new Date(after.prospect.expiresAt).toISOString().slice(0, 10)} unless you keep it.`);
		if (s.state === 'failed') tell(after, `Build failed: ${after.name}`, s.message, true);
		return after;
	}

	function answer(id, qid, text) {
		const ch = store.get(id), q = ch?.run?.steps.build.question;
		if (!q || ch.run.steps.build.state !== 'needs_input') throw new Error('There is no question waiting.');
		if (qid && qid !== q.id) throw new Error('That question has already been answered.');
		const a = clip(text, 1000); if (!a) throw new Error('Type an answer first.');
		patch(id, (r) => { r.answers[q.id] = { text: a, at: now() }; r.steps.build = { state: 'working', message: 'Thanks. The AI is carrying on…', pct: r.steps.build.pct }; r.state = 'running'; r.buildHeardAt = now(); });
		note(id, 'Answered the AI\'s question');
		const after = store.get(id);
		triggerBuild(after, ctxFor(), { resume: true, answer: a }).then((r) => {
			if (!r || r.code !== 0) { setStep(id, 'build', { state: 'failed', message: plain('Could not pass your answer to the site. ' + (r?.err || r?.out || '')) }, { state: 'failed' }); }
		}).catch((e) => setStep(id, 'build', { state: 'failed', message: plain(e.message) }, { state: 'failed' }));
		return after;
	}

	/* ------------------------------------------------------------ creating a prospect, documents */
	async function detect(urlText) {
		const domain = normDomain(urlText);
		if (!DOMAIN_RE.test(domain)) throw new Error('That does not look like a website address (for example britanniaunited.ca).');
		let html = '';
		try { const r = await clients.http.get(`https://${domain}/`); if (r && r.status < 400) html = r.text || ''; } catch { /* name from the address instead */ }
		return { domain, name: nameFromTitle(titleOf(html), domain), platform: platformFromHtml(html) };
	}
	async function create({ url, name, contactEmail, mode, notes }, by = '') {
		const d = await detect(url);
		const nm = String(name || '').trim() || d.name;
		let slug = slugify(nm).slice(0, 30).replace(/-+$/g, ''), n = 1;
		const base = slug;
		while (!SLUG_RE.test(slug) || store.get(slug)) { n++; slug = (base.slice(0, 27) + '-' + n).replace(/-+/g, '-'); if (n > 50) throw new Error('Could not make a short name for this church.'); }
		const email = String(contactEmail || '').trim();
		if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('That email address does not look right.');
		const c = store.create({ name: nm, slug, domain: d.domain, plan: 'website', kind: 'new', contactEmail: email, notes: '' }, by);
		store.update(c.id, (x) => { x.prospect = { url: String(url).trim(), domain: d.domain, mode: mode === 'full' ? 'full' : 'preview', platform: d.platform, notes: String(notes || '').slice(0, 2000), docs: [], createdAt: now() }; x.run = blankRun(); });
		return store.get(c.id);
	}
	async function addDoc(id, filename, buf) {
		const ch = store.get(id); if (!ch?.prospect) throw new Error('Not a prospect.');
		const name = path.basename(String(filename || '')).replace(/[^\w.\- ()]/g, '_').slice(0, 100);
		if (!DOC_EXT.test(name)) throw new Error('Use a text, Word, PDF, spreadsheet or HTML file.');
		if (!buf?.length) throw new Error('That file is empty.');
		if (buf.length > MAX_DOC) throw new Error('That file is over 10 MB.');
		if ((ch.prospect.docs || []).length >= 8) throw new Error('That is enough files for one church (8).');
		fs.mkdirSync(path.join(dir(id), 'docs'), { recursive: true });
		const n = (ch.prospect.docs || []).reduce((m, d) => Math.max(m, d.n), 0) + 1;
		fs.writeFileSync(path.join(dir(id), 'docs', `${n}-${name}`), buf);
		const got = await extractDocument(name, buf);
		store.update(id, (c) => { c.prospect.docs.push({ n, name, size: buf.length, text: got.text, readable: got.readable, note: got.note }); });
		return store.get(id);
	}
	function removeDoc(id, n) {
		const ch = store.get(id), d = ch?.prospect?.docs?.find((x) => x.n === Number(n)); if (!d) throw new Error('Not found.');
		try { fs.rmSync(path.join(dir(id), 'docs', `${d.n}-${d.name}`), { force: true }); } catch { /* ignore */ }
		store.update(id, (c) => { c.prospect.docs = c.prospect.docs.filter((x) => x.n !== d.n); });
	}

	/* ------------------------------------------------------------ what the screen shows */
	const STAGE_DEFS = [['add', 'Add church'], ['export', 'Export'], ['site', 'Create site'], ['build', 'Build site'], ['ready', 'Ready']];
	function view(ch) {
		if (!ch.prospect) return { id: ch.id, name: ch.name, domain: ch.domain, legacy: true, created: ch.created };
		const run = ch.run || blankRun(), s = run.steps, p = ch.prospect;
		const left = p.expiresAt ? Math.ceil((p.expiresAt - now()) / DAY) : null;
		const stages = STAGE_DEFS.map(([k, title]) => {
			if (k === 'add') return { key: k, title, state: 'done', message: p.mode === 'full' ? 'Full site' : 'Preview (5 key pages)' };
			if (k === 'ready') return { key: k, title, state: s.build.state === 'done' ? 'done' : 'waiting', message: s.build.state === 'done' ? `Live at ${previewHost(ch)}` : '' };
			return { key: k, title, ...s[k] };
		});
		const cur = stages.find((x) => x.state !== 'done');
		const headline = !cur ? 'Preview ready' : (cur.message || (cur.state === 'waiting' ? 'Waiting to start' : ''));
		return {
			id: ch.id, name: ch.name, domain: p.domain, mode: p.mode, platform: p.platform || '', contactEmail: ch.contactEmail || '', createdAt: p.createdAt, createdBy: ch.createdBy || '',
			runState: run.state, headline, stages, currentStage: cur?.key || 'ready', docs: (p.docs || []).map((d) => ({ n: d.n, name: d.name, size: d.size, readable: !!d.readable, note: d.note || '' })),
			previewUrl: s.site.state === 'done' ? `https://${previewHost(ch)}` : '', expiresAt: p.expiresAt || null, daysLeft: left, kept: !!p.kept, exported: p.exported || null,
			canStart: ['idle', 'failed', 'waiting'].includes(run.state), canRetry: run.state === 'failed' || s.build.state === 'blocked',
			zipReady: fs.existsSync(path.join(dir(ch.id), 'export.zip')),
			question: s.build.state === 'needs_input' ? s.build.question : null,
			notes: p.notes || '', url: p.url || '', siteReadyAt: p.siteReadyAt || null, switchedAt: p.switchedAt || null, slug: ch.slug,
			canFull: p.mode !== 'full' && s.build.state === 'done' && run.state === 'done',
			canLogin: s.site.state === 'done',
			canDelete: !ch.stages?.golive?.done,
			canRestart: s.site.state === 'done' && ['working', 'needs_input', 'blocked'].includes(s.build.state),
			tidy: run.cleanup ? { state: run.cleanup.state, message: run.cleanup.message } : null,
			cost: costView(ch),
		};
	}

	/* ------------------------------------------------------------ the 30-day clean-up */
	async function removePreview(ch) {
		const cfg = clients.cfg, host = previewHost(ch), tpl = `${cfg.templateSlug}.${cfg.previewDomain}`;
		if (host === tpl || /^build\d*$/.test(ch.slug) || ch.stages?.golive?.done) return { skipped: 'protected' };
		if (!clients.hostinger.available()) return { skipped: 'Hostinger API key missing' };
		const w = (await clients.hostinger.websites()).find((x) => x.domain === host);
		if (w && engine.releaseOxygenLicense) { try { await Promise.race([engine.releaseOxygenLicense(ctxFor(), ch), new Promise((res) => setTimeout(res, 30000).unref?.())]); } catch { /* best effort */ } }
		if (w) await clients.hostinger.deleteWebsite(host);
		if (clients.gateway.available()) { try { await clients.gateway.revoke(ch.slug, true); } catch { /* best effort */ } }
		try { fs.rmSync(dir(ch.id), { recursive: true, force: true }); } catch { /* ignore */ }
		store.remove(ch.id);
		return { deleted: true };
	}
	async function sweep() {
		const out = { warned: 0, deleted: 0, overdue: 0 };
		for (const ch of store.list()) {
			const p = ch.prospect; if (!p?.expiresAt || p.kept || ch.stages?.golive?.done) continue;
			const left = Math.ceil((p.expiresAt - now()) / DAY);
			const flag = (k) => { if (p[k]) return false; store.update(ch.id, (c) => { c.prospect[k] = now(); }); return true; };
			if (left <= 0) {
				if (autoDelete) { try { const r = await removePreview(ch); if (r.deleted) { out.deleted++; await tell(ch, `Preview deleted: ${ch.name}`, `The preview for ${ch.name} reached 30 days and was deleted.`); } } catch (e) { log('prospects sweep:', e.message); } }
				else if (flag('overdueNotified')) { out.overdue++; await tell(ch, `Preview is past its 30 days: ${ch.name}`, `${previewHost(ch)} is past its 30 days. Automatic deletion is switched off (PROSPECT_AUTODELETE), so it was left alone. Delete it in the portal or press +7 days.`, true); }
			} else if (left <= 2 && flag('warned2')) { out.warned++; await tell(ch, `Preview deleted in ${left} day${left === 1 ? '' : 's'}: ${ch.name}`, `${previewHost(ch)} will be deleted on ${new Date(p.expiresAt).toISOString().slice(0, 10)}. Open Prospects and press +7 days to save it.`); }
			else if (left <= 7 && flag('warned7')) { out.warned++; await tell(ch, `Preview deleted in ${left} days: ${ch.name}`, `${previewHost(ch)} will be deleted on ${new Date(p.expiresAt).toISOString().slice(0, 10)}. Open Prospects and press +7 days to save it.`); }
		}
		return out;
	}
	/** Give a preview more time. 7 days at a time by default, and never more than 30 days from today, so nothing is kept forever by accident. */
	function extend(id, days = EXTEND_DAYS) {
		const ch = store.get(id); if (!ch?.prospect) throw new Error('Not a prospect.');
		const d = Math.max(1, Math.min(30, Math.round(Number(days) || EXTEND_DAYS)));
		const base = Math.max(ch.prospect.expiresAt || now(), now()), cap = now() + PREVIEW_DAYS * DAY;
		if (base >= cap) throw new Error('This preview already has 30 days left, which is the most it can have.');
		store.update(id, (c) => { c.prospect.expiresAt = Math.min(base + d * DAY, cap); c.prospect.kept = false; for (const k of ['warned7', 'warned2', 'overdueNotified']) delete c.prospect[k]; });
		note(id, `Preview extended by ${d} day${d === 1 ? '' : 's'}`);
		return store.get(id);
	}
	const keep = (id) => extend(id, EXTEND_DAYS);

	/** Delete the preview site and the church record, from the dashboard. */
	async function remove(id) {
		const ch = store.get(id); if (!ch?.prospect) throw new Error('Not a prospect.');
		const r = await removePreview(ch);
		if (!r.deleted) throw new Error(r.skipped === 'protected' ? 'This site is live or is a template, so it can\'t be deleted here.' : `Could not delete: ${r.skipped}.`);
		return r;
	}

	/** Keep the same preview site and carry on to the whole thing: a fresh full export, then the build adds the rest in the same design. */
	function switchToFull(id) {
		const ch = store.get(id); if (!ch?.prospect) throw new Error('Not a prospect.');
		if (ch.prospect.mode === 'full') throw new Error('This church is already set to the full site.');
		if (ch.run?.steps.site.state !== 'done') throw new Error('Wait until the preview site has been created.');
		if (['running', 'needs_input'].includes(ch.run.state)) throw new Error('Wait for the current step to finish first.');
		try { fs.rmSync(path.join(dir(id), 'export.zip'), { force: true }); } catch { /* ignore */ }
		store.update(id, (c) => { c.prospect.mode = 'full'; c.prospect.switchedAt = now(); });
		patch(id, (r) => {
			r.state = 'running'; r.exportJobId = null; r.answers = {}; r.pushed = null; r.attempts = {}; r.lastFix = {}; r.buildStartedAt = null; r.buildHeardAt = null;
			r.steps.export = { state: 'waiting', message: '', pct: null };
			r.steps.build = { state: 'waiting', message: '', pct: null };
		});
		note(id, 'Switched to the full site');
		return store.get(id);
	}

	/** Stop a build that is running (or looks stuck) on the site and start it again from the beginning. Only this church's own build process is stopped. */
	async function restartBuild(id) {
		const ch = store.get(id); if (!ch?.prospect) throw new Error('Not a prospect.');
		if (ch.run?.steps.site.state !== 'done') throw new Error('The site has not been created yet.');
		if (!['working', 'needs_input', 'blocked', 'failed'].includes(ch.run.steps.build.state)) throw new Error('There is no build to restart.');
		const ssh = clients.ssh;
		if (ssh?.available?.()) { try { await ssh.exec(`pkill -f ${shq(`[a]pi/build/${id}/status`)}; rm -f $HOME/cwai-portal-${ch.slug}.log; echo stopped`, { timeout: 20000 }); } catch { /* it may already have ended */ } }
		patch(id, (r) => { r.state = 'running'; r.answers = {}; r.pushed = null; r.buildStartedAt = null; r.buildHeardAt = null; r.attempts = {}; r.lastFix = {}; r.steps.build = { state: 'waiting', message: '', pct: null }; });
		note(id, 'Build restarted by a person');
		return store.get(id);
	}

	/** One-click sign-in to the church's WordPress admin: ask the site for a single-use link. */
	async function adminLink(id) {
		const ch = store.get(id); if (!ch?.prospect) throw new Error('Not a prospect.');
		if (ch.run?.steps.site.state !== 'done') throw new Error('The site is not ready yet.');
		const ctx = ctxFor();
		const r = await engine.runWp(ctx, ch, 'cwai portal-login');
		if (r.unavailable) throw new Error('Hostinger SSH isn\'t set up on this server.');
		const url = String(r.out || '').split('\n').map((x) => x.trim()).reverse().find((x) => /^https:\/\/\S+cwai_login=/.test(x));
		if (r.code !== 0 || !url) throw new Error(/not a registered wp command|is not a registered/i.test(`${r.err}${r.out}`) ? 'This site needs the AI Assistant plugin 1.12.0 or newer for one-click sign-in. Use the password under Details for now.' : plain('Could not make a sign-in link. ' + (r.err || r.out || '')));
		try { if (new URL(url).hostname !== previewHost(ch)) throw new Error('x'); } catch { throw new Error('The site gave back a link for a different address, so it was not used.'); }
		return { url };
	}

	/* ------------------------------------------------------------ routes */
	function router({ need }) {
		const r = express.Router();
		r.use(need);
		const pick = (req, res) => { const c = store.get(req.params.id); if (!c?.prospect) { res.status(404).json({ error: 'Prospect not found' }); return null; } return c; };
		const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { res.status(e.status || 400).json({ error: e.message }); } };
		r.get('/', (req, res) => res.json(store.list().map(view)));
		r.get('/costs', (req, res) => res.json(costSummary()));
		r.get('/detect', wrap(async (req, res) => res.json(await detect(req.query.url))));
		r.post('/', wrap(async (req, res) => { const c = await create(req.body || {}, req.by); if (req.body?.start !== false) { start(c.id); tick(c.id); } res.status(201).json(view(store.get(c.id))); }));
		r.get('/:id', (req, res) => { const c = pick(req, res); if (c) res.json(view(c)); });
		r.post('/:id/run', wrap(async (req, res) => { if (!pick(req, res)) return; start(req.params.id); tick(req.params.id); res.json(view(store.get(req.params.id))); }));
		r.post('/:id/answer', wrap(async (req, res) => { if (!pick(req, res)) return; answer(req.params.id, req.body?.questionId, req.body?.answer); res.json(view(store.get(req.params.id))); }));
		r.post('/:id/keep', wrap(async (req, res) => { if (!pick(req, res)) return; res.json(view(keep(req.params.id))); }));
		r.post('/:id/extend', wrap(async (req, res) => { if (!pick(req, res)) return; res.json(view(extend(req.params.id, req.body?.days))); }));
		r.post('/:id/full', wrap(async (req, res) => { if (!pick(req, res)) return; switchToFull(req.params.id); tick(req.params.id); res.json(view(store.get(req.params.id))); }));
		r.post('/:id/restart', wrap(async (req, res) => { if (!pick(req, res)) return; await restartBuild(req.params.id); tick(req.params.id); res.json(view(store.get(req.params.id))); }));
		r.post('/:id/login', wrap(async (req, res) => { if (!pick(req, res)) return; res.json(await adminLink(req.params.id)); }));
		r.delete('/:id', wrap(async (req, res) => { if (!pick(req, res)) return; await remove(req.params.id); res.json({ deleted: true }); }));
		r.post('/:id/docs', express.raw({ type: () => true, limit: MAX_DOC + 1024 }), wrap(async (req, res) => { if (!pick(req, res)) return; res.json(view(await addDoc(req.params.id, decodeURIComponent(req.get('x-filename') || ''), req.body))); }));
		r.delete('/:id/docs/:n', wrap(async (req, res) => { if (!pick(req, res)) return; removeDoc(req.params.id, req.params.n); res.json(view(store.get(req.params.id))); }));
		r.get('/:id/package', (req, res) => { const c = pick(req, res); if (!c) return; const f = path.join(dir(c.id), 'export.zip'); if (!fs.existsSync(f)) return res.status(404).json({ error: 'No export yet.' }); res.download(f, `${c.slug}-export.zip`); });
		r.get('/:id/admin-login', (req, res) => { const c = pick(req, res); if (!c) return; if (req.user && req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only.' }); res.json({ url: `https://${previewHost(c)}/wp-admin`, login: 'cwadmin', password: adminPw(c) }); });
		return r;
	}
	/** The signed endpoints the WordPress plugin calls. No sign-in: every request carries a token that is only good for one church and for a few hours. */
	function buildRouter() {
		const r = express.Router();
		r.use(express.json({ limit: '50kb' }));
		r.use('/:id', (req, res, next) => {
			const t = req.query.t || String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
			const id = verify(t);
			if (!id || id !== req.params.id) return res.status(403).json({ error: 'This link has expired.' });
			req.church = store.get(id);
			if (!req.church?.prospect) return res.status(404).json({ error: 'Unknown church' });
			next();
		});
		r.get('/:id/package.zip', (req, res) => { const f = path.join(dir(req.church.id), 'export.zip'); if (!fs.existsSync(f)) return res.status(404).json({ error: 'No export.' }); res.download(f, `${req.church.slug}-export.zip`); });
		r.get('/:id/brief.md', (req, res) => res.type('text/markdown').send(briefFor(req.church)));
		r.get('/:id/docs/:n', (req, res) => { const d = req.church.prospect.docs.find((x) => x.n === Number(req.params.n)); if (!d) return res.status(404).json({ error: 'Not found' }); res.download(path.join(dir(req.church.id), 'docs', `${d.n}-${d.name}`), d.name); });
		r.get('/:id/state', (req, res) => res.json({ state: req.church.run.steps.build.state, mode: req.church.prospect.mode, answers: req.church.run.answers || {} }));
		r.post('/:id/status', (req, res) => { try { reportBuild(req.church.id, req.body || {}); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); } });
		return r;
	}

	let timers = [];
	const startTimers = ({ everyMs = 6000 } = {}) => {
		timers.push(setInterval(() => tickAll().catch((e) => log('prospects:', e.message)), everyMs).unref());
		timers.push(setInterval(() => sweep().catch((e) => log('prospects sweep:', e.message)), 3600000).unref());
		timers.push(setTimeout(() => sweep().catch(() => {}), 60000).unref());
	};
	const stopTimers = () => { for (const t of timers) { clearInterval(t); clearTimeout(t); } timers = []; };

	return { create, detect, start, tick, tickAll, costRefresh, costSummary, reportBuild, answer, cleanup, restartBuild, addDoc, removeDoc, keep, extend, remove, switchToFull, adminLink, sweep, view, router, buildRouter, sign, verify, startTimers, stopTimers, briefFor };
}
