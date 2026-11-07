// The deployment checklist. Every stage is a short list of plain questions ("requirements").
// Each requirement has a live TEST (is it already done?) and, where possible, a FIX (do it now).
// Tests only read. Fixes only run when someone presses the button, and only for a requirement that tested "no".
import { classifyDns, planWebRecords, mergeSpf, planPostmarkRecords, planMailRecords } from './dnscheck.mjs';
import { shq, randomPassword } from './clients.mjs';
import { buildDnsPlan, planOps } from './dnsplan.mjs';

/* ------------------------------------------------------------------ small helpers */
const R = (state, detail = '') => ({ state, detail });
const ok = (d) => R('ok', d), no = (d) => R('no', d), warn = (d) => R('warn', d), info = (d) => R('info', d), unk = (d) => R('unknown', d);
const SATISFIED = new Set(['ok', 'info', 'warn']);
export const isSatisfied = (s) => SATISFIED.has(s);
/** For ordering only: an item we could not look at (no SSH, say) must not hide the hand-done instructions of the items after it. */
export const depMet = (s) => SATISFIED.has(s) || s === 'unknown';

const memo = (ctx, k, fn) => { ctx.memo ||= {}; if (!(k in ctx.memo)) ctx.memo[k] = fn(); return ctx.memo[k]; };
const tempHost = (ch, cfg) => `${ch.slug}.${cfg.previewDomain}`;
const hostOnly = (u) => String(u || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
/** WordPress stores the site title HTML-escaped ("Yoga &amp; Fitness", "St. Paul&#039;s"), so compare titles after undoing that. */
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ' };
const unescapeHtml = (s) => String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
	const k = e.toLowerCase();
	if (k[0] === '#') { const cp = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10); return Number.isFinite(cp) ? String.fromCodePoint(cp) : m; }
	return k in ENT ? ENT[k] : m;
});
export const sameTitle = (a, b) => unescapeHtml(a).replace(/\s+/g, ' ').trim() === unescapeHtml(b).replace(/\s+/g, ' ').trim();

/* ---- where a site lives on the Hostinger account (looked for over SSH, in the usual places) */
const resolved = new Map();
const sitePath = (cfg, host) => resolved.get(host) || cfg.siteRoot.replace('{host}', host);
function rootCandidates(cfg, host) {
	const dom = cfg.previewDomain, label = host.endsWith('.' + dom) ? host.slice(0, -dom.length - 1) : '';
	const list = [cfg.siteRoot.replace('{host}', host), `$HOME/domains/${host}/public_html`];
	if (label) list.push(`$HOME/domains/${dom}/public_html/${label}`, `$HOME/domains/${dom}/${label}`, `$HOME/domains/${dom}/public_html/${host}`);
	return [...new Set(list)];
}
async function findRoot(ctx, host) {
	for (const c of rootCandidates(ctx.c.cfg, host)) {
		const r = await ctx.c.ssh.exec(`test -f ${c}/wp-config.php && echo FOUND`);
		if (r.code === 0 && /FOUND/.test(r.out)) { resolved.set(host, c); return c; }
	}
	resolved.delete(host);
	return '';
}
/** The folder the church's WordPress lives in. The folder keeps its place when the address changes, so try both names. */
const siteOf = (ctx, ch) => memo(ctx, 'site', async () => {
	if (!ctx.c.ssh.available()) return { unavailable: true };
	for (const h of [tempHost(ch, ctx.c.cfg), ch.domain].filter(Boolean)) if (await findRoot(ctx, h)) return { host: h };
	return { missing: true, tried: rootCandidates(ctx.c.cfg, tempHost(ch, ctx.c.cfg)) };
});
const wpRun = (ctx, host, args) => ctx.c.ssh.exec(`cd ${sitePath(ctx.c.cfg, host)} && ${ctx.c.cfg.wpCli} ${args}`);
const wpGet = async (ctx, host, args) => { const r = await wpRun(ctx, host, args); return r.code === 0 ? r.out.trim() : null; };
/** Plugins made by Hostinger (matched on slug or title), or null if the list can't be read. */
const hostingerPlugins = async (ctx, h) => { const t = await wpGet(ctx, h, 'plugin list --fields=name,title,status --format=json --skip-plugins --skip-themes'); if (t === null) return null; try { return JSON.parse(t).filter((p) => /hostinger/i.test(p.name) || /hostinger/i.test(p.title || '')); } catch { return null; } };
const handCmd = (ctx, ch, args) => `cd ${sitePath(ctx.c.cfg, tempHost(ch, ctx.c.cfg))} && ${ctx.c.cfg.wpCli} ${args}`;


/** Oxygen has no wp-config setting for its licence. It keeps the key in its own storage and activates it with its own server, so we call its licence manager (the same call its Settings → License page makes). The key comes from the portal's own settings and is never shown. */
const OXY_STATUS = "$m=\\Breakdance\\Licensing\\LicenseKeyManager::getInstance(); $v=$m->getStoredLicenseKeyValidityInfo(); $s=''; if(is_array($v)){array_walk_recursive($v,function($x,$k) use (&$s){ if($k==='license'&&is_string($x)&&$s==='') $s=$x; });} echo ($m->getStoredLicenseKey()?'HAS':'NONE').':'.$s;";
const oxyStatus = (t) => { const m = /^(HAS|NONE):(\w*)/.exec(String(t || '').trim().split('\n').pop()); return m ? { has: m[1] === 'HAS', state: m[2] } : null; };
export async function applyOxygenLicense(ctx, ch) {
	const key = ctx.c.cfg.oxygenLicense;
	if (!key) return { state: 'unknown', detail: 'Set OXYGEN_LICENSE_KEY in Railway so new sites can be licensed automatically.' };
	const s = await siteOf(ctx, ch);
	if (s.unavailable) return { state: 'unknown', detail: 'Hostinger SSH isn\'t set up on this server yet.' };
	if (s.missing) return { state: 'no', detail: 'The site doesn\'t exist yet on Hostinger.' };
	const before = oxyStatus(await wpGet(ctx, s.host, `eval ${shq(OXY_STATUS)}`));
	if (before?.has && before.state === 'valid') return { state: 'ok', detail: 'Oxygen is already licensed on this site.' };
	const php = `\\Breakdance\\Licensing\\LicenseKeyManager::getInstance()->changeLicenseKey('${key.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}');`;
	const r = await wpRun(ctx, s.host, `eval ${shq(php)}`);
	if (r.code) return { state: 'error', detail: (r.err || r.out || '').split(key).join('••••').trim().slice(-300) };
	const after = oxyStatus(await wpGet(ctx, s.host, `eval ${shq(OXY_STATUS)}`));
	if (after?.has && after.state === 'valid') return { state: 'ok', detail: 'Oxygen is licensed and activated on this site.' };
	return { state: 'error', detail: `The key was saved but Oxygen did not activate it${after?.state ? ` (it says: ${after.state})` : ''}. Check that the licence has a free site slot, then press Try again.` };
}

/** Free this site's Oxygen activation (best effort) so deleted previews don't use up the licence's site limit. */
export async function releaseOxygenLicense(ctx, ch) {
	try { const s = await siteOf(ctx, ch); if (s.unavailable || s.missing) return false; const r = await wpRun(ctx, s.host, `eval ${shq('\\Breakdance\\Licensing\\LicenseKeyManager::getInstance()->deactivateLicense();')}`); return r.code === 0; } catch { return false; }
}


/** What we would put in DNS for this customer. Looks only; changes nothing. */
export async function customerPlan(ctx, ch) {
	const cfg = ctx.c.cfg, cf = ctx.c.cloudflare;
	if (!ch.domain) throw new Error('This customer has no domain yet.');
	const z = cf.available() ? await zoneOf(ctx, ch.domain) : null;
	const existing = z ? await cfRecords(ctx, z.id) : [];
	const inv = existing.length ? [] : await inventory(ctx, ch.domain);
	let nameservers = []; if (z) { try { nameservers = (await cf.zone(z.id)).name_servers || []; } catch { /* shown later */ } }
	const email = ch.plan === 'email';
	return { domain: ch.domain, zone: !!z, zoneStatus: z?.status || '', nameservers, hostingerIp: cfg.hostingerIp || '', cloudflare: cf.available(), copiedFromPublic: inv.length, lines: buildDnsPlan({ domain: ch.domain, hostingerIp: cfg.hostingerIp, email, mailIp: cfg.mailIp, existing, inventory: inv }) };
}

/**
 * Set up the church's DNS in OUR Cloudflare from the plan: add the domain if needed, copy their records, add the website and email records.
 * Nothing goes live until the church switches its nameservers. Records are written DNS-only; a wrong record is corrected in place, never deleted.
 */
export async function customerDnsSetup(ctx, ch) {
	const cf = ctx.c.cloudflare;
	if (!cf.available()) throw new Error('Cloudflare isn\'t connected on this server.');
	if (!ctx.c.cfg.hostingerIp) throw new Error('HOSTINGER_IP isn\'t set on this server, so the website records can\'t be made.');
	if (!ch.domain) throw new Error('This customer has no domain yet.');
	let z = await zoneOf(ctx, ch.domain), created = false;
	if (!z) { z = await cf.createZone(ch.domain); created = true; ctx.memo = {}; }
	const p = await customerPlan(ctx, ch), { ops, flagged } = planOps(p.lines), done = [], errors = [];
	for (const o of ops) {
		const body = { type: o.type, name: o.name, content: o.content, proxied: false, ...(o.priority != null ? { priority: o.priority } : {}) };
		try { if (o.op === 'update') await cf.updateRecord(z.id, o.id, body); else await cf.createRecord(z.id, body); done.push(`${o.op === 'update' ? 'Corrected' : 'Added'} ${o.type} ${o.name}`); }
		catch (e) { errors.push(`${o.type} ${o.name}: ${String(e.message || e).slice(0, 160)}`); }
	}
	ctx.memo = {};
	return { created, zoneStatus: z.status || '', nameservers: z.name_servers || p.nameservers || [], done, flagged, errors };
}

/** Remove one record from the church's zone. Only records the plan marks as removable (old mail routes, strays, extras) can go: the website and mail records can't be deleted from here. */
export async function customerDnsDelete(ctx, ch, recordId) {
	const cf = ctx.c.cloudflare, z = await zoneOf(ctx, ch.domain);
	if (!z) throw new Error('The domain isn\'t in our Cloudflare.');
	const p = await customerPlan(ctx, ch), line = p.lines.find((l) => l.id === recordId);
	if (!line) throw new Error('That record isn\'t in the zone any more. Refresh the plan.');
	if (!line.removable) throw new Error('That record is part of the standard set, so it can\'t be removed here.');
	await cf.deleteRecord(z.id, recordId); ctx.memo = {};
	return { removed: `${line.type} ${line.name} → ${line.content}` };
}

/** Does the world see what we planned? Looks only. Each check is ok, no, warn or info (informational). */
export async function customerTest(ctx, ch) {
	const p = await customerPlan(ctx, ch), dns = ctx.c.dns, d = ch.domain, checks = [];
	const add = (id, label, state, detail = '') => checks.push({ id, label, state, detail });
	const norm = (t) => String(Array.isArray(t) ? t.join('') : t).replace(/^"|"$/g, '').trim().toLowerCase();
	let ns = [], nsErr = ''; try { ns = (await dns.ns(d)).map((n) => String(n).toLowerCase().replace(/\.$/, '')); } catch (e) { nsErr = String(e.message || e); }
	const want = (p.nameservers || []).map((n) => n.toLowerCase());
	if (!p.zone) add('zone', 'The domain is in our Cloudflare', 'no', 'Not yet. Press Set up DNS.');
	else add('ns', 'The domain uses our nameservers', ns.length && ns.every((n) => want.includes(n)) ? 'ok' : 'no', nsErr ? `Couldn't look up the nameservers (${nsErr}). Try again.` : ns.length ? `Right now: ${ns.join(', ')}. Ours: ${want.join(', ')}.` : 'No nameservers were found for this domain.');
	for (const l of p.lines) {
		if (l.action === 'replace' && l.content === l.was) continue; // an old record that is going away
		if (l.action === 'later') { add(`${l.type}:${l.name}`, `${l.type} ${l.name}`, 'info', l.note || 'Switched on later.'); continue; }
		if (l.action === 'copy' && !['MX', 'TXT'].includes(l.type) && !/^(mail|autodiscover|autoconfig)\./.test(l.name) && l.name !== d && l.name !== 'www.' + d) continue; // other copied records are not what we are proving here
		const label = `${l.type} ${l.name}`; let ok = false, seen = '';
		try {
			if (l.type === 'A' && l.proxy) { const a = await dns.a(l.name); ok = a.length > 0; seen = a.join(', '); }
			else if (l.type === 'CNAME' && l.proxy) { const a = await dns.a(l.name); ok = a.length > 0; seen = a.join(', '); }
			else if (l.type === 'A') { const a = await dns.a(l.name); ok = a.includes(l.content); seen = a.join(', '); }
			else if (l.type === 'CNAME') { const c = (await dns.cname(l.name)).map((x) => String(x).toLowerCase().replace(/\.$/, '')); ok = c.includes(l.content.toLowerCase()); seen = c.join(', '); }
			else if (l.type === 'MX') { const m = (await dns.mx(l.name)).map((x) => String(x.exchange).toLowerCase().replace(/\.$/, '')); ok = m.includes(l.content.toLowerCase()); seen = m.join(', '); }
			else if (l.type === 'TXT') { const t = (await dns.txt(l.name)).map(norm); ok = t.includes(norm(l.content)); seen = t.join(' | '); }
			else continue;
		} catch (e) { seen = 'lookup failed'; }
		add(`${l.type}:${l.name}`, label, ok ? 'ok' : 'no', ok ? '' : seen ? `Seen: ${seen.slice(0, 140)}. Expected: ${l.content}` : `Nothing found. Expected: ${l.content}`);
	}
	const site = await isOurSite(ctx, d);
	add('site', `https://${d} shows our new site`, site.ours ? 'ok' : 'info', site.ours ? '' : 'Not showing yet. That is expected until the site is moved onto the real domain.');
	return { domain: d, checks, ok: checks.every((c) => c.state === 'ok' || c.state === 'info'), nameservers: p.nameservers || [] };
}

/**
 * One pass at moving the preview site onto the real domain: add the domain to the Hostinger site, certificate, WordPress address, preview mode off, www/robots/sitemap,
 * then switch the website records to proxied in our Cloudflare. Each pass fixes what it can and stops at the first thing that needs time (Hostinger takes minutes).
 * Safe to run again: it only does what still tests "no".
 */
export async function customerGolive(ctx, ch) {
	const stage = stageByKey('golive'), items = [], res = {};
	if (!ch.domain) throw new Error('This customer has no domain yet.');
	let stopped = false;
	for (const q of reqsFor(stage, ch)) {
		if (stopped) { items.push({ id: q.id, label: q.label, state: 'blocked', detail: 'Waiting for the step before it.' }); res[q.id] = { state: 'blocked' }; continue; }
		if ((q.deps || []).some((d) => !depMet(res[d]?.state))) { items.push({ id: q.id, label: q.label, state: 'blocked', detail: 'Waiting for the step before it.' }); res[q.id] = { state: 'blocked' }; continue; }
		let r; try { r = await q.test.call(q, ctx, ch); } catch (e) { r = { state: 'error', detail: e.message }; }
		let note = '';
		if (r.state === 'no' && q.fix) {
			const f = await fixReq(ctx, ch, stage, q, r);
			note = f.detail || f.howTo || '';
			if (f.ok) { ctx.memo = {}; try { r = await q.test.call(q, ctx, ch); } catch (e) { r = { state: 'error', detail: e.message }; } }
		}
		res[q.id] = r;
		items.push({ id: q.id, label: q.label, state: r.state, detail: [note, r.detail].filter(Boolean).join('\n') });
		if (!isSatisfied(r.state) && q.id !== 'extras') stopped = true;
	}
	const allOk = reqsFor(stage, ch).every((q) => isSatisfied(res[q.id]?.state));
	// proxy the website records only once the certificate is good, and only in a zone we manage
	let proxy = null;
	if (allOk && ch.customer?.dns === 'ours' && ctx.c.cloudflare.available()) {
		const cf = ctx.c.cloudflare, z = await zoneOf(ctx, ch.domain);
		if (z) {
			const recs = (await cf.records(z.id)).filter((r) => (r.type === 'A' && r.name === ch.domain && r.content === ctx.c.cfg.hostingerIp) || (r.type === 'CNAME' && r.name === 'www.' + ch.domain));
			let n = 0; for (const r of recs) if (!r.proxied) { try { await cf.updateRecord(z.id, r.id, { type: r.type, name: r.name, content: r.content, proxied: true }); n++; } catch (e) { proxy = { state: 'error', detail: e.message }; } }
			proxy ||= { state: 'ok', detail: n ? `Switched on the Cloudflare proxy for ${n} website record${n > 1 ? 's' : ''}.` : 'The website records are already proxied.' };
		}
	}
	if (proxy) items.push({ id: 'proxy', label: 'Cloudflare proxy on for the website and www', ...proxy });
	return { items, live: allOk, results: res };
}

/** Run one WP-CLI command on a church's preview site. Returns { code, out, err } or { unavailable } / { missing }. */
export async function runWp(ctx, ch, args) {
	const s = await siteOf(ctx, ch);
	if (s.unavailable) return { unavailable: true };
	if (s.missing) return { missing: true };
	return wpRun(ctx, s.host, args);
}

/** Start a long WP-CLI command on a church's site and leave it running after the SSH session ends. Output goes to a log file in the account's home folder. */
export async function runWpBackground(ctx, ch, args, logName = 'job') {
	const s = await siteOf(ctx, ch);
	if (s.unavailable) return { unavailable: true };
	if (s.missing) return { missing: true };
	const log = `$HOME/cwai-portal-${String(logName).replace(/[^a-z0-9-]/gi, '')}.log`;
	const r = await ctx.c.ssh.exec(`cd ${sitePath(ctx.c.cfg, s.host)} && (nohup ${ctx.c.cfg.wpCli} ${args} > ${log} 2>&1 < /dev/null &) ; echo started`);
	return r;
}

/** Run a test that needs the WordPress folder. */
async function onSite(ctx, ch, fn) {
	const s = await siteOf(ctx, ch);
	if (s.unavailable) return unk('Can\'t look: Hostinger SSH isn\'t set up on this server yet.');
	if (s.missing) return no('The site doesn\'t exist yet on Hostinger.');
	return fn(s.host);
}
/** Run a fix that needs the WordPress folder. Without SSH it hands back the exact commands to run by hand. */
async function fixOnSite(ctx, ch, handCommands, fn) {
	const s = await siteOf(ctx, ch);
	if (s.unavailable) return { ok: false, howTo: 'SSH isn\'t set up on this server, so do this by hand on the Hostinger SSH session:\n' + handCommands.join('\n') };
	if (s.missing) return { ok: false, howTo: 'The site doesn\'t exist on Hostinger yet.' };
	return fn(s.host);
}

/* ---- Cloudflare / DNS helpers */
const cfRecords = async (ctx, zoneId) => (await ctx.c.cloudflare.records(zoneId)).map((r) => ({ id: r.id, type: r.type, name: r.name, content: r.content, priority: r.priority }));
const zoneOf = (ctx, d) => memo(ctx, 'zone:' + d, async () => (ctx.c.cloudflare.available() ? ctx.c.cloudflare.zoneByName(d) : null));
async function applyPlan(ctx, zoneId, plan) {
	const done = [], flagged = [];
	for (const p of plan) {
		if (p.action === 'keep') continue;
		if (p.action === 'needs-approval-delete') { flagged.push(`${p.type} ${p.name} → ${p.content}: ${p.note || 'remove by hand in Cloudflare'}`); continue; }
		const body = { type: p.type, name: p.name, content: p.content, proxied: !!p.proxied, ...(p.priority ? { priority: p.priority } : {}) };
		if (p.action === 'create') await ctx.c.cloudflare.createRecord(zoneId, body); else await ctx.c.cloudflare.updateRecord(zoneId, p.id, body);
		done.push(`${p.action === 'create' ? 'Added' : 'Changed'} ${p.type} ${p.name}`);
	}
	return { done, flagged };
}
const planText = (plan) => plan.filter((p) => p.action !== 'keep').map((p) => `${p.action === 'needs-approval-delete' ? 'Conflicts with' : p.action === 'create' ? 'Missing' : 'Wrong'}: ${p.type} ${p.name}${p.was ? ' (now ' + p.was + ')' : ''}`).join('\n');
const dnsFacts = async (ctx, d) => {
	const x = ctx.c.dns;
	const [ns, a, aaaa, wwwA, wwwCname, mx, txt] = await Promise.all([x.ns(d), x.a(d), x.aaaa(d), x.a('www.' + d), x.cname('www.' + d), x.mx(d), x.txt(d)]);
	return { ns, a, aaaa, wwwA, wwwCname, mx, txt };
};
const dnsInfo = (ctx, ch) => memo(ctx, 'dnsinfo', async () => {
	const facts = await dnsFacts(ctx, ch.domain);
	let zone = null; try { zone = await zoneOf(ctx, ch.domain); } catch { /* shown as unknown below */ }
	const cfg = ctx.c.cfg;
	return { facts, zone, cls: classifyDns(facts, { zone, hostingerIp: cfg.hostingerIp, dudaHosts: cfg.dudaHosts, dudaIps: cfg.dudaIps, ourMxHosts: cfg.ourMxHosts }) };
});
const noDomain = () => no('Enter the church\'s website address at the top of this page first.');

/** Best-effort copy of a domain's current records from public lookups of the usual names. */
async function inventory(ctx, d) {
	const x = ctx.c.dns, recs = [];
	for (const n of ['', 'www', 'mail', 'webmail', 'autodiscover', 'autoconfig', 'smtp', 'imap', 'pop', 'ftp']) {
		const fq = n ? `${n}.${d}` : d;
		const cn = await x.cname(fq);
		if (cn.length) { recs.push({ type: 'CNAME', name: fq, content: cn[0].replace(/\.$/, '') }); continue; }
		for (const ip of await x.a(fq)) recs.push({ type: 'A', name: fq, content: ip });
		for (const ip of await x.aaaa(fq)) recs.push({ type: 'AAAA', name: fq, content: ip });
	}
	for (const m of await x.mx(d)) recs.push({ type: 'MX', name: d, content: String(m.exchange).replace(/\.$/, ''), priority: m.priority });
	for (const t of await x.txt(d)) recs.push({ type: 'TXT', name: d, content: Array.isArray(t) ? t.join('') : t });
	for (const t of await x.txt('_dmarc.' + d)) recs.push({ type: 'TXT', name: '_dmarc.' + d, content: Array.isArray(t) ? t.join('') : t });
	const parking = /parkingpage\.namecheap\.com|registrar-servers\.com|^eforward\d\./i;
	return recs.filter((r) => !parking.test(r.content));
}
const isOurSite = async (ctx, d) => {
	const r = await ctx.c.http.get(`https://${d}/wp-json/`);
	return { status: r.status, ours: r.status === 200 && /"namespaces"/.test(r.text || ''), error: r.error };
};
const lines = (t) => String(t || '').split('\n').map((x) => x.trim()).filter(Boolean);
const tplHostOf = (cfg) => `${cfg.templateSlug}.${cfg.previewDomain}`;
const siteRecord = async (ctx, host) => (await ctx.c.hostinger.websites()).find((w) => w.domain === host) || null;
const needApi = (ctx) => (ctx.c.hostinger.available() ? null : unk('Can\'t look: the Hostinger API key isn\'t set up on this server.'));
const manual = (id, label, howTo) => ({ id, label, manual: true, howTo });

/* ------------------------------------------------------------------ the stages */
export const STAGES = [
	/* ============================================================ 1 */
	{
		key: 'preview', n: 1, title: 'Preview site', needs: [],
		blurb: 'A temporary copy of the new website at its own address, hidden from search engines, so the church can look at it.',
		reqs: [
			{
				id: 'site', label: 'Is the preview site created on Hostinger?', services: ['hostingerApi'], deps: [], fixLabel: 'Create the site',
				async test(ctx, ch) {
					const na = needApi(ctx); if (na) return na;
					const host = tempHost(ch, ctx.c.cfg), w = await siteRecord(ctx, host);
					return w ? ok(`Created on Hostinger (${w.website_type || 'site'}).`) : no(`${host} doesn't exist on Hostinger yet.`);
				},
				async fix(ctx, ch) {
					const host = tempHost(ch, ctx.c.cfg), acct = await ctx.c.hostinger.account();
					await ctx.c.hostinger.createWebsite(host, acct.order_id);
					return { ok: true, detail: `Hostinger is creating ${host}. This takes a minute or two: press Re-check.` };
				},
				howTo: (ch, cfg) => `In Hostinger (hPanel → Websites → Create site), add the address ${tempHost(ch, cfg)}. Then press Re-check.`,
			},
			{
				id: 'folder', label: 'Is WordPress installed on it?', services: ['hostingerApi'], deps: ['site'], fixLabel: 'Install WordPress',
				async test(ctx, ch) {
					const s = await siteOf(ctx, ch);
					if (s.unavailable) return unk('Can\'t look: Hostinger SSH isn\'t set up on this server yet.');
					return s.missing ? no(`No WordPress found in ${tempHost(ch, ctx.c.cfg)} yet.`) : ok(s.host);
				},
				async fix(ctx, ch) {
					const cfg = ctx.c.cfg, host = tempHost(ch, cfg), email = ch.contactEmail || cfg.wpAdminEmail;
					if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || '')) return { ok: false, detail: 'WordPress needs an admin email. Enter the church contact\'s email at the top of this page (or set WP_ADMIN_EMAIL in Railway).' };
					const w = await siteRecord(ctx, host); if (!w) return { ok: false, detail: 'The site doesn\'t exist on Hostinger yet.' };
					const password = (ctx.adminPassword && ctx.adminPassword(ch)) || randomPassword(18), login = 'cwadmin';
					await ctx.c.hostinger.installWordPress(w.username, { domain: host, site_title: ch.name, credentials: { email, login, password } });
					ctx.secret = { login, password, email, url: `https://${host}/wp-admin` };
					return { ok: true, detail: 'Hostinger is installing WordPress (a minute or two). The login for the new site is shown once below: copy it. Then press Re-check.' };
				},
				howTo: (ch, cfg) => `In Hostinger (hPanel → ${tempHost(ch, cfg)} → WordPress), install WordPress. Then press Re-check.`,
			},
			{
				id: 'dns', label: 'Does the preview address reach our server?', services: ['previewDns'], deps: [], fixLabel: 'Add the DNS record',
				async test(ctx, ch) {
					const host = tempHost(ch, ctx.c.cfg), a = await ctx.c.dns.a(host);
					return a.length ? ok(a.join(', ')) : no(`${host} doesn't exist in DNS yet.`);
				},
				async fix(ctx, ch) {
					const cfg = ctx.c.cfg, host = tempHost(ch, cfg);
					const plan = planWebRecords({ domain: host, ip: cfg.hostingerIp, existing: await cfRecords(ctx, cfg.previewZoneId) }).filter((p) => p.type === 'A');
					const r = await applyPlan(ctx, cfg.previewZoneId, plan);
					return { ok: true, detail: r.done.join('; ') || 'Already there.' };
				},
				howTo: (ch, cfg) => `In Cloudflare, add an A record for ${tempHost(ch, cfg)} pointing at the Hostinger IP (or use a wildcard record for *.${cfg.previewDomain}).`,
			},
			{
				id: 'plugins', label: 'Does the site have the same plugins as our template?', services: ['ssh'], deps: ['folder'], fixLabel: 'Copy our plugins',
				test: (ctx, ch) => onSite(ctx, ch, async (h) => {
					const tpl = tplHostOf(ctx.c.cfg);
					if (!(await findRoot(ctx, tpl))) return unk(`The template site (${tpl}) wasn't found on Hostinger.`);
					const want = lines(await wpGet(ctx, tpl, 'plugin list --status=active --field=name')), have = lines(await wpGet(ctx, h, 'plugin list --status=active --field=name'));
					const missing = want.filter((x) => !have.includes(x));
					return missing.length ? no(`Missing: ${missing.join(', ')}`) : ok(`${want.length} plugins, same as the template.`);
				}),
				fix: (ctx, ch) => fixOnSite(ctx, ch, [`# copy each active plugin folder from the template site's wp-content/plugins, then: wp plugin activate <names>`], async (h) => {
					const cfg = ctx.c.cfg, tpl = tplHostOf(cfg);
					if (!(await findRoot(ctx, tpl))) return { ok: false, detail: `The template site (${tpl}) wasn't found on Hostinger.` };
					const want = lines(await wpGet(ctx, tpl, 'plugin list --status=active --field=name')), have = lines(await wpGet(ctx, h, 'plugin list --status=active --field=name'));
					const missing = want.filter((x) => !have.includes(x) && /^[A-Za-z0-9._-]+$/.test(x));
					const from = sitePath(cfg, tpl), to = sitePath(cfg, h), failed = [];
					for (const n of missing) { const r = await ctx.c.ssh.exec(`[ -d ${from}/wp-content/plugins/${n} ] && { [ -d ${to}/wp-content/plugins/${n} ] || cp -a ${from}/wp-content/plugins/${n} ${to}/wp-content/plugins/; }`); if (r.code) failed.push(n); }
					const todo = missing.filter((n) => !failed.includes(n));
					if (todo.length) { const a = await wpRun(ctx, h, `plugin activate ${todo.map(shq).join(' ')}`); if (a.code) return { ok: false, detail: (a.err || a.out).trim().slice(-300) }; }
					return { ok: !failed.length, detail: `Copied and activated ${todo.length} plugin(s).${failed.length ? ' Couldn\'t copy: ' + failed.join(', ') : ''} Oxygen still needs its licence key (tick below).` };
				}),
			},
			{
				id: 'plugin', label: 'Is the ChurchWeb AI Assistant plugin active?', services: ['ssh'], deps: ['folder', 'plugins'], fixLabel: 'Activate it',
				test: (ctx, ch) => onSite(ctx, ch, async (h) => ((await wpRun(ctx, h, 'plugin is-active churchweb-ai-assistant')).code === 0 ? ok() : no('The plugin isn\'t active on this site.'))),
				fix: (ctx, ch) => fixOnSite(ctx, ch, [handCmd(ctx, ch, 'plugin activate churchweb-ai-assistant')], async (h) => {
					const r = await wpRun(ctx, h, 'plugin activate churchweb-ai-assistant');
					return r.code === 0 ? { ok: true, detail: 'Activated.' } : { ok: false, detail: /could not be found|not found|doesn.t exist|does not exist/i.test(r.err + r.out) ? 'The plugin isn\'t installed on this site. Upload churchweb-ai-assistant.zip in WordPress → Plugins → Add New, then press Re-check.' : (r.err || r.out).trim().slice(-300) };
				}),
			},
			{
				id: 'hostingerPlugins', label: 'Are the Hostinger plugins removed?', services: ['ssh'], deps: ['folder'], fixLabel: 'Deactivate and delete them',
				test: (ctx, ch) => onSite(ctx, ch, async (h) => { const l = await hostingerPlugins(ctx, h); return l === null ? unk('Couldn\'t read the plugin list.') : l.length ? no(`Still installed: ${l.map((p) => p.title || p.name).join(', ')}`) : ok('No Hostinger plugins.'); }),
				fix: (ctx, ch) => fixOnSite(ctx, ch, [handCmd(ctx, ch, 'plugin deactivate <each Hostinger plugin>'), handCmd(ctx, ch, 'plugin delete <each Hostinger plugin>')], async (h) => {
					const l = await hostingerPlugins(ctx, h); if (l === null) return { ok: false, detail: 'Couldn\'t read the plugin list.' };
					// One command for all of them, and without loading the plugins being removed (the Hostinger ones call out to the internet and can hang WP-CLI).
					const failed = [], names = l.map((p) => shq(p.name)).join(' '), fast = '--skip-plugins --skip-themes';
					if (l.length) {
						await wpRun(ctx, h, `plugin deactivate ${names} ${fast}`);
						const r = await wpRun(ctx, h, `plugin delete ${names} ${fast}`);
						if (r.code) { const left = (await hostingerPlugins(ctx, h)) || l; for (const p of left) failed.push(p.name); }
					}
					return { ok: !failed.length, detail: `Removed ${l.length - failed.length} Hostinger plugin(s).${failed.length ? ' Couldn\'t delete: ' + failed.join(', ') : ''}` };
				}),
				howTo: () => 'In WordPress → Plugins, deactivate and delete every plugin made by Hostinger (Hostinger AI, Hub, Preview Domain, Reach, Smart Auto Updates, Tools).',
			},
			{
				id: 'staffview', label: 'Is the simple staff view switched on?', services: ['ssh'], deps: ['plugin'], fixLabel: 'Turn it on',
				test: (ctx, ch) => onSite(ctx, ch, async (h) => ((await wpGet(ctx, h, `eval ${shq("$o = get_option('cwai_sv'); echo !empty($o['enabled']) ? '1' : '0';")}`)) === '1' ? ok() : no('Editors would see the full WordPress menu.'))),
				fix: (ctx, ch) => fixOnSite(ctx, ch, [handCmd(ctx, ch, `eval ${shq("update_option('cwai_sv', array_merge(CWAI_StaffView::defaults(), ['enabled' => true]));")}`)], async (h) => {
					const r = await wpRun(ctx, h, `eval ${shq("update_option('cwai_sv', array_merge(CWAI_StaffView::defaults(), ['enabled' => true]));")}`);
					return r.code ? { ok: false, detail: r.err.trim().slice(-300) } : { ok: true, detail: 'Staff view is on.' };
				}),
			},
			{
				id: 'teamLogin', label: 'Is the team\'s Editor login there (so staff don\'t use the Admin login)?', services: ['ssh', 'staffLogin'], deps: ['plugin', 'staffview'], fixLabel: 'Create the Editor login',
				test: (ctx, ch) => onSite(ctx, ch, async (h) => {
					if (!ctx.c.cfg.staffLoginPassword) return unk('Set STAFF_LOGIN_PASSWORD in Railway first (and optionally STAFF_LOGIN_USER, default "churchweb").');
					const u = (ctx.c.cfg.staffLoginUser || 'churchweb'), roles = await wpGet(ctx, h, `user get ${shq(u)} --field=roles`);
					return roles === null ? no(`There is no "${u}" login on this site.`) : /editor/i.test(roles) ? ok(`${u} (Editor)`) : no(`"${u}" exists but isn't an Editor (it is: ${roles}).`);
				}),
				fix: (ctx, ch) => fixOnSite(ctx, ch, [handCmd(ctx, ch, `user create ${(ctx.c.cfg.staffLoginUser || 'churchweb')} <email> --role=editor --user_pass=<STAFF_LOGIN_PASSWORD> --send-email=0`)], async (h) => {
					const cfg = ctx.c.cfg, u = cfg.staffLoginUser || 'churchweb', pw = cfg.staffLoginPassword; if (!pw) return { ok: false, detail: 'Set STAFF_LOGIN_PASSWORD in Railway first.' };
					const email = cfg.wpAdminEmail || `${u}@${cfg.previewDomain}`;
					const exists = (await wpGet(ctx, h, `user get ${shq(u)} --field=ID`)) !== null;
					const r = await wpRun(ctx, h, exists ? `user update ${shq(u)} --role=editor --user_pass=${shq(pw)}` : `user create ${shq(u)} ${shq(email)} --role=editor --user_pass=${shq(pw)} --send-email=0 --porcelain`);
					if (r.code) return { ok: false, detail: (r.err || r.out || '').split(pw).join('••••').trim().slice(-300) };
					return { ok: true, detail: exists ? `Reset "${u}" to an Editor with the standard password.` : `Created the "${u}" Editor login with the standard password.` };
				}),
				howTo: (ch, cfg) => `In WordPress → Users → Add New: username ${cfg.staffLoginUser || 'churchweb'}, role Editor, and the standard staff password.`,
			},
			{
				id: 'connected', label: 'Is the AI Assistant connected to our gateway?', services: ['gateway', 'ssh'], deps: ['folder', 'plugin'], fixLabel: 'Connect it',
				test: (ctx, ch) => onSite(ctx, ch, async (h) => {
					if (!ctx.c.gateway.available()) return unk('Can\'t check: the gateway key isn\'t set up on this server.');
					const want = (await ctx.c.gateway.mint(ch.slug)).token;
					const key = await wpGet(ctx, h, 'config get CWAI_API_KEY'), base = await wpGet(ctx, h, 'config get CWAI_API_BASE_URL');
					if (!key) return no('The site has no AI Assistant key yet.');
					if (key !== want) return no('The site has a key, but it isn\'t this church\'s key.');
					if ((base || '').replace(/\/$/, '') !== ctx.c.cfg.gatewayUrl) return no('The site isn\'t pointed at our gateway.');
					return (await ctx.c.gateway.tokenWorks(want)) ? ok('Key accepted by the gateway.') : no('The gateway doesn\'t accept the key (is this church switched off?).');
				}),
				fix: (ctx, ch) => fixOnSite(ctx, ch, [handCmd(ctx, ch, `config set CWAI_API_KEY '<key from the gateway>' --type=constant`), handCmd(ctx, ch, `config set CWAI_API_BASE_URL ${shq(ctx.c.cfg.gatewayUrl)} --type=constant`)], async (h) => {
					const cfg = ctx.c.cfg, token = (await ctx.c.gateway.mint(ch.slug)).token;
					if (cfg.defaultTokenCap || cfg.defaultImageCap) await ctx.c.gateway.setCap(ch.slug, cfg.defaultTokenCap, cfg.defaultImageCap);
					const a = await wpRun(ctx, h, `config set CWAI_API_KEY ${shq(token)} --type=constant`);
					const b = await wpRun(ctx, h, `config set CWAI_API_BASE_URL ${shq(cfg.gatewayUrl)} --type=constant`);
					if (a.code || b.code) return { ok: false, detail: (a.err || b.err || '').replace(token, '••••').trim().slice(-300) };
					return { ok: true, detail: 'Key created and written to the site.' };
				}),
			},
			{
				id: 'address', label: 'Is the site using its preview address?', services: ['ssh'], deps: ['folder'], fixLabel: 'Fix the address',
				test: (ctx, ch) => onSite(ctx, ch, async (h) => {
					const cur = await wpGet(ctx, h, 'option get siteurl'), want = tempHost(ch, ctx.c.cfg);
					if (!cur) return unk('Couldn\'t read the site address.');
					if (hostOnly(cur) === want || (ch.domain && hostOnly(cur) === ch.domain && ch.stages.golive?.done)) return ok(cur);
					return no(`The site thinks its address is ${hostOnly(cur)}.`);
				}),
				fix: (ctx, ch) => fixOnSite(ctx, ch, [handCmd(ctx, ch, `search-replace '<old address>' ${shq(tempHost(ch, ctx.c.cfg))} --all-tables --precise --recurse-objects --skip-columns=guid`)], async (h) => {
					const want = tempHost(ch, ctx.c.cfg), old = hostOnly(await wpGet(ctx, h, 'option get siteurl'));
					if (old && old !== want) {
						const r = await wpRun(ctx, h, `search-replace ${shq(old)} ${shq(want)} --all-tables --precise --recurse-objects --skip-columns=guid`);
						if (r.code) return { ok: false, detail: r.err.trim().slice(-300) };
					}
					await wpRun(ctx, h, `option update home ${shq('https://' + want)}`); await wpRun(ctx, h, `option update siteurl ${shq('https://' + want)}`);
					await wpRun(ctx, h, 'cache flush');
					return { ok: true, detail: `Address set to ${want}.` };
				}),
			},
			{
				id: 'title', label: 'Does the site have the church\'s name?', services: ['ssh'], deps: ['folder'], fixLabel: 'Set the name',
				test: (ctx, ch) => onSite(ctx, ch, async (h) => { const t = await wpGet(ctx, h, 'option get blogname'); return t !== null && sameTitle(t, ch.name) ? ok(unescapeHtml(t)) : no(`The site title is "${unescapeHtml(t)}".`); }),
				fix: (ctx, ch) => fixOnSite(ctx, ch, [handCmd(ctx, ch, `option update blogname ${shq(ch.name)}`)], async (h) => {
					const r = await wpRun(ctx, h, `option update blogname ${shq(ch.name)}`);
					return r.code ? { ok: false, detail: r.err.trim().slice(-300) } : { ok: true, detail: 'Name set.' };
				}),
			},
			{
				id: 'preview', label: 'Is preview mode on (hidden from Google)?', services: ['ssh'], deps: ['folder', 'plugin'], fixLabel: 'Turn it on',
				test: (ctx, ch) => onSite(ctx, ch, async (h) => ((await wpGet(ctx, h, 'option get blog_public')) === '0' ? ok('Search engines are told to stay away.') : no('The site is visible to search engines.'))),
				fix: (ctx, ch) => fixOnSite(ctx, ch, [handCmd(ctx, ch, `eval ${shq(`CWAI_Golive::apply('preview_on', ['label' => ${JSON.stringify('Preview of the proposed new website for ' + ch.name + '. This is not the live site.')}]);`)}`)], async (h) => {
					const php = `CWAI_Golive::apply('preview_on', ['label' => ${JSON.stringify('Preview of the proposed new website for ' + ch.name + '. This is not the live site.')}]);`;
					const r = await wpRun(ctx, h, `eval ${shq(php)}`);
					return r.code ? { ok: false, detail: r.err.trim().slice(-300) } : { ok: true, detail: 'Preview mode is on.' };
				}),
			},
			{ ...manual('oxygen', 'Is Oxygen licensed on this site?', 'Log in to the new site, open Oxygen → Settings → License and paste the licence key. Then tick this box.'), deps: ['folder'] },
		],
	},

	/* ============================================================ 2 */
	{
		key: 'dnscheck', n: 2, title: 'Where is the church today?', needs: [],
		blurb: 'Just looking, nothing changes. Where the church\'s domain, website and email are right now.',
		reqs: [
			{ id: 'domain', label: 'Do we have the church\'s website address?', test: async (ctx, ch) => (ch.domain ? ok(ch.domain) : noDomain()) },
			{
				id: 'dnshost', label: 'Is the domain\'s DNS already with us (Cloudflare)?', deps: ['domain'],
				async test(ctx, ch) {
					const { cls, facts } = await dnsInfo(ctx, ch);
					ctx.facts = { dns: { dnsHost: cls.dnsHost, web: cls.web, email: cls.email } };
					const where = { ours: '', 'cloudflare-pending': 'In our Cloudflare, but the church hasn\'t switched the nameservers yet', 'cloudflare-other': 'On someone else\'s Cloudflare account', duda: 'At Duda', other: 'At the registrar or another company', unknown: 'Couldn\'t tell' }[cls.dnsHost];
					return cls.dnsHost === 'ours' ? ok('Yes: ' + (facts.ns || []).join(', ')) : info(where + ' (' + (facts.ns || []).join(', ') + '). The Switch domain phase moves it.');
				},
			},
			{
				id: 'web', label: 'Where does the website point today?', deps: ['domain'],
				async test(ctx, ch) {
					const { cls, facts } = await dnsInfo(ctx, ch);
					const t = { duda: 'At Duda. Pointing it at the new site takes it off Duda, so only do that after approval.', ours: 'Already at our Hostinger server.', other: 'Somewhere else.', none: 'Nowhere (no website address is set).' }[cls.web];
					return (cls.web === 'duda' ? warn : info)(`${t} (${(facts.a || []).join(', ') || 'no address'})`);
				},
			},
			{
				id: 'email', label: 'Where does the church\'s email go today?', deps: ['domain'],
				async test(ctx, ch) {
					const { cls, facts } = await dnsInfo(ctx, ch);
					const t = { ours: 'To our mail server.', google: 'To Google Workspace.', microsoft: 'To Microsoft 365.', other: 'To another provider.', none: 'Nowhere: the domain has no email set up.' }[cls.email];
					const mx = (facts.mx || []).map((m) => m.exchange || m).join(', ');
					return (['google', 'microsoft', 'other'].includes(cls.email) ? warn : info)(t + (mx ? ' (' + mx + ')' : '') + (cls.email === 'google' || cls.email === 'microsoft' || cls.email === 'other' ? ' Don\'t change the MX records until the new mailboxes exist and old mail is moved.' : ''));
				},
			},
			{
				id: 'spf', label: 'Is the SPF record healthy?', deps: ['domain'],
				async test(ctx, ch) {
					const { cls } = await dnsInfo(ctx, ch);
					return cls.spf === 'duplicate' ? warn('There is more than one SPF record. The Email phase merges them into one.') : cls.spf === 'one' ? ok('One SPF record.') : info('No SPF record yet. The Email phase adds it.');
				},
			},
		],
	},

	/* ============================================================ 3 */
	{
		key: 'approval', n: 3, title: 'Approval and payment', needs: [],
		blurb: 'Nothing that changes the church\'s real domain happens until all four are ticked.',
		reqs: [
			{ id: 'domain', label: 'Do we have the church\'s website address?', test: async (ctx, ch) => (ch.domain ? ok(ch.domain) : noDomain()) },
			manual('approved', 'Has the church seen the preview and approved it?', 'Tick this once the church has said yes.'),
			manual('plan', 'Is their plan confirmed?', 'Confirm Website or Website + Email at the top of this page, then tick.'),
			manual('paid', 'Have they paid (subscription active in Stripe)?', 'Check Stripe, then tick.'),
			manual('registrar', 'Do we know who holds their domain registrar login?', 'You need this person to change the nameservers (Domain setup).'),
		],
	},

	/* ============================================================ 4 */
	{
		key: 'dns', n: 5, title: 'Switch the domain over', needs: ['approval'],
		blurb: 'Once the church has approved: they switch their nameservers to ours, then the website address is pointed at Hostinger. Records are only ever added or changed, never deleted.',
		reqs: [
			{
				id: 'ns', label: 'Has the church switched their nameservers to ours?', services: ['cloudflare'], deps: [], fixLabel: 'Ask Cloudflare to re-check',
				async test(ctx, ch) {
					if (!ch.domain) return noDomain();
					const z = await zoneOf(ctx, ch.domain); if (!z) return no('Add the domain to our Cloudflare first (Domain setup).');
					const mine = z.name_servers.map((x) => x.toLowerCase());
					const pub = (await ctx.c.dns.ns(ch.domain)).map((x) => x.toLowerCase().replace(/\.$/, ''));
					ctx.facts = { nameservers: z.name_servers };
					if (!pub.length || !pub.every((n) => mine.includes(n))) return no(`Not yet. Ask the church (or whoever holds the registrar login) to set the nameservers to: ${z.name_servers.join(' and ')}. Right now: ${pub.join(', ') || 'none'}.`);
					return z.status === 'active' ? ok('Switched, and Cloudflare is active.') : no('Switched, but Cloudflare hasn\'t activated the domain yet. Press the button, then re-check in a few minutes.');
				},
				async fix(ctx, ch) { const z = await zoneOf(ctx, ch.domain); if (!z) return { ok: false, detail: 'The domain isn\'t in our Cloudflare yet.' }; await ctx.c.cloudflare.activationCheck(z.id); return { ok: true, detail: 'Asked Cloudflare to re-check.' }; },
			},
			{
				id: 'site', label: 'Does the website address point at Hostinger?', services: ['cloudflare'], deps: ['ns'], fixLabel: 'Point it at Hostinger',
				async test(ctx, ch) {
					if (!ctx.c.cfg.hostingerIp) return unk('HOSTINGER_IP isn\'t set on this server.');
					const z = await zoneOf(ctx, ch.domain); if (!z) return no('Add the domain to our Cloudflare first (Domain setup).');
					const plan = planWebRecords({ domain: ch.domain, ip: ctx.c.cfg.hostingerIp, existing: await cfRecords(ctx, z.id) });
					return plan.every((p) => p.action === 'keep') ? ok('The domain and www point at our server.') : no(planText(plan));
				},
				async fix(ctx, ch) {
					const z = await zoneOf(ctx, ch.domain), plan = planWebRecords({ domain: ch.domain, ip: ctx.c.cfg.hostingerIp, existing: await cfRecords(ctx, z.id) });
					const r = await applyPlan(ctx, z.id, plan);
					return { ok: !r.flagged.length, detail: [...r.done, ...r.flagged.map((f) => 'A person must remove this in Cloudflare: ' + f)].join('\n') || 'Done.' };
				},
			},
		],
	},

	/* ============================================================ 5 */
	{
		key: 'golive', n: 5, title: 'Go live on the real domain', needs: ['dns'],
		blurb: 'Make the preview site answer on the church\'s real domain, turn preview mode off, and check everything.',
		reqs: [
			{
				id: 'added', label: 'Does the real domain show our new site?', services: ['hostingerApi'], deps: [], fixLabel: 'Add the domain to the site',
				async test(ctx, ch) {
					if (!ch.domain) return noDomain();
					const r = await isOurSite(ctx, ch.domain);
					return r.ours ? ok(`https://${ch.domain} is our WordPress site.`) : no(r.status ? `https://${ch.domain} answers, but it isn't our new site yet (it may still be the old one).` : `https://${ch.domain} doesn't answer (${r.error || 'no response'}).`);
				},
				async fix(ctx, ch) {
					const host = tempHost(ch, ctx.c.cfg), w = await siteRecord(ctx, host);
					if (!w) return { ok: false, detail: 'The preview site doesn\'t exist on Hostinger.' };
					// the real domain must not already be its own site on Hostinger: attaching it here would clash with (or replace) that site
					const other = (await ctx.c.hostinger.websites()).find((x) => String(x.domain || '').toLowerCase() === ch.domain && x.domain !== host);
					if (other) return { ok: false, detail: `${ch.domain} is already a separate website on Hostinger. Swap them by hand (remove it there first), then press this again, so the old site isn't overwritten.` };
					await ctx.c.hostinger.addParkedDomain(w.username, host, ch.domain);
					return { ok: true, detail: `Added ${ch.domain} to the site. The domain must already point at Hostinger (Domain setup). Hostinger needs a few minutes: press Re-check.` };
				},
				howTo: (ch) => `In Hostinger (hPanel → Websites → the church's site → Domains), add ${ch.domain || 'the domain'} and set it as primary. Then press Re-check.`,
			},
			{
				id: 'ssl', label: 'Is the security certificate (https) valid?', services: ['hostingerApi'], deps: ['added'], fixLabel: 'Issue the certificate',
				async test(ctx, ch) { const c = await ctx.c.tls(ch.domain); return c.authorized ? ok('Valid until ' + c.validTo) : no('Certificate problem: ' + (c.error || 'unknown')); },
				async fix(ctx, ch) {
					const host = tempHost(ch, ctx.c.cfg), w = await siteRecord(ctx, host);
					if (!w) return { ok: false, detail: 'The site doesn\'t exist on Hostinger.' };
					try { await ctx.c.hostinger.installSsl(w.username, ch.domain); } catch (e) { await ctx.c.hostinger.installSsl(w.username, host); }
					return { ok: true, detail: 'Asked Hostinger to issue the certificate. It can take a few minutes: press Re-check.' };
				},
				howTo: () => 'In Hostinger (hPanel → SSL), issue or renew the certificate for the domain. This can take a few minutes after adding the domain.',
			},
			{
				id: 'address', label: 'Is the site using the real address inside WordPress?', services: ['ssh'], deps: ['added'], fixLabel: 'Switch the address',
				test: (ctx, ch) => onSite(ctx, ch, async (h) => { const cur = hostOnly(await wpGet(ctx, h, 'option get siteurl')); return cur === ch.domain ? ok(cur) : no(`WordPress still uses ${cur}.`); }),
				fix: (ctx, ch) => fixOnSite(ctx, ch, [handCmd(ctx, ch, `search-replace '<preview address>' ${shq(ch.domain)} --all-tables --precise --recurse-objects --skip-columns=guid`)], async (h) => {
					const old = hostOnly(await wpGet(ctx, h, 'option get siteurl'));
					if (old && old !== ch.domain) { const r = await wpRun(ctx, h, `search-replace ${shq(old)} ${shq(ch.domain)} --all-tables --precise --recurse-objects --skip-columns=guid`); if (r.code) return { ok: false, detail: r.err.trim().slice(-300) }; }
					await wpRun(ctx, h, `option update home ${shq('https://' + ch.domain)}`); await wpRun(ctx, h, `option update siteurl ${shq('https://' + ch.domain)}`);
					await wpRun(ctx, h, 'rewrite flush'); await wpRun(ctx, h, 'cache flush');
					return { ok: true, detail: `Address set to ${ch.domain}.` };
				}),
			},
			{
				id: 'public', label: 'Is the site visible to Google (preview mode off)?', services: ['ssh'], deps: ['address'], fixLabel: 'Go live (preview off)',
				test: (ctx, ch) => onSite(ctx, ch, async (h) => ((await wpGet(ctx, h, 'option get blog_public')) === '1' ? ok('Search engines are allowed.') : no('Preview mode is still on: search engines are told to ignore the site.'))),
				fix: (ctx, ch) => fixOnSite(ctx, ch, [handCmd(ctx, ch, `eval ${shq("CWAI_Golive::apply('launch');")}`)], async (h) => {
					const r = await wpRun(ctx, h, `eval ${shq("CWAI_Golive::apply('launch');")}`);
					return r.code ? { ok: false, detail: r.err.trim().slice(-300) } : { ok: true, detail: 'Preview mode is off.' };
				}),
			},
			{
				id: 'extras', label: 'Do www, robots.txt and the sitemap work?', deps: ['added'],
				async test(ctx, ch) {
					const d = ch.domain, bad = [];
					const www = await ctx.c.http.get(`https://www.${d}/`); if (!(www.status === 200 || [301, 308].includes(www.status))) bad.push('www.' + d + ' doesn\'t work');
					const rb = await ctx.c.http.get(`https://${d}/robots.txt`); if (/^\s*Disallow:\s*\/\s*$/im.test(rb.text || '')) bad.push('robots.txt blocks the whole site');
					const sm = await ctx.c.http.get(`https://${d}/sitemap_index.xml`); if (sm.status !== 200) bad.push('no sitemap at /sitemap_index.xml yet');
					return bad.length ? warn(bad.join('; ') + '.') : ok('All fine.');
				},
			},
		],
	},

	/* ============================================================ 6 */
	{
		key: 'mailboxes', n: 6, title: 'Email accounts', needs: ['approval'], onlyPlan: 'email',
		blurb: 'Only for the Website + Email plan. Create the mailboxes first, move any old mail, and only then switch the email to our server.',
		reqs: [
			{
				...manual('boxes', 'Are the mailboxes created on our mail server?', 'Use the Email setup page (top of the screen): enter the domain, the addresses and a default password, then press "Create domain and mailboxes". Then tick this box.'),
				fixLabel: 'Generate temporary passwords',
				async fix(ctx, ch) {
					const names = (ch.mailboxes || []).length ? ch.mailboxes : ['info'];
					const boxes = names.map((n) => ({ address: `${n}@${ch.domain}`, password: randomPassword(14) }));
					ctx.secret = { boxes }; return { ok: true, detail: 'Passwords are shown once below. Copy them now: they aren\'t saved.' };
				},
			},
			manual('moved', 'Has their old email been moved over (or do they have none)?', 'Move old mail with imapsync, or confirm the church has no email to move. Then tick this box.'),
			{
				id: 'mx', label: 'Does email now go to our mail server?', services: ['cloudflare'], deps: ['boxes', 'moved'], fixLabel: 'Switch email to our server',
				async test(ctx, ch) { if (!ch.domain) return noDomain(); const mx = (await ctx.c.dns.mx(ch.domain)).map((m) => String(m.exchange || m).toLowerCase().replace(/\.$/, '')); return mx.some((h) => ctx.c.cfg.ourMxHosts.includes(h) || h === 'mail.' + ch.domain) ? ok(mx.join(', ')) : no(mx.length ? `Email still goes to ${mx.join(', ')}.` : 'No email records.'); },
				async fix(ctx, ch) {
					const z = await zoneOf(ctx, ch.domain); if (!z) return { ok: false, detail: 'The domain isn\'t in our Cloudflare yet (Domain setup).' };
					const plan = planMailRecords({ domain: ch.domain, mailHost: 'mail.' + ch.domain, existing: await cfRecords(ctx, z.id), cutoverMx: true });
					const r = await applyPlan(ctx, z.id, plan);
					return { ok: !r.flagged.length, detail: [...r.done, ...r.flagged.map((f) => 'A person must remove this in Cloudflare: ' + f)].join('\n') || 'Done.' };
				},
				confirm: 'Switch the church\'s email to OUR server now? Only do this once the mailboxes exist and old mail is moved.',
			},
		],
	},

	/* ============================================================ 7 */
	{
		key: 'sending', n: 7, title: 'Sending email (Postmark)', needs: ['cloudflare'],
		blurb: 'So the church\'s website emails (forms, notices) arrive and aren\'t marked as spam.',
		reqs: [
			{
				id: 'pm', label: 'Is the domain set up in Postmark?', services: ['postmark'], fixLabel: 'Set it up in Postmark',
				async test(ctx, ch) { if (!ch.domain) return noDomain(); const d = await ctx.c.postmark.domainByName(ch.domain); return d ? ok('Yes.') : no('Not in Postmark yet.'); },
				async fix(ctx, ch) { await ctx.c.postmark.createDomain(ch.domain); return { ok: true, detail: 'Added to Postmark.' }; },
			},
			{
				id: 'pmdns', label: 'Are Postmark\'s DNS records in Cloudflare?', services: ['cloudflare', 'postmark'], deps: ['pm'], fixLabel: 'Add the records',
				async test(ctx, ch) {
					const z = await zoneOf(ctx, ch.domain); if (!z) return no('The domain isn\'t in our Cloudflare yet (Domain setup).');
					const dom = await ctx.c.postmark.domain((await ctx.c.postmark.domainByName(ch.domain)).ID);
					const plan = planPostmarkRecords({ domain: ch.domain, pm: dom, existing: await cfRecords(ctx, z.id) });
					return plan.every((p) => p.action === 'keep') ? ok('DKIM and Return-Path records are there.') : no(planText(plan));
				},
				async fix(ctx, ch) {
					const z = await zoneOf(ctx, ch.domain); if (!z) return { ok: false, detail: 'The domain isn\'t in our Cloudflare yet (Domain setup).' };
					const dom = await ctx.c.postmark.domain((await ctx.c.postmark.domainByName(ch.domain)).ID);
					const r = await applyPlan(ctx, z.id, planPostmarkRecords({ domain: ch.domain, pm: dom, existing: await cfRecords(ctx, z.id) }));
					return { ok: true, detail: r.done.join('; ') || 'Already there.' };
				},
			},
			{
				id: 'auth', label: 'Are SPF and DMARC set up (one SPF record)?', services: ['cloudflare'], deps: [], fixLabel: 'Set them up',
				async plan(ctx, ch) {
					const z = await zoneOf(ctx, ch.domain); if (!z) return null;
					const existing = await cfRecords(ctx, z.id), cfg = ctx.c.cfg;
					const spf = mergeSpf(existing.filter((r) => r.type === 'TXT' && /^"?v=spf1/i.test(r.content)).map((r) => r.content.replace(/^"|"$/g, '')), { includes: ['spf.mtasv.net'], hosts: ch.plan === 'email' ? [cfg.mailHost] : [] });
					return { z, spf, plan: planMailRecords({ domain: ch.domain, mailHost: cfg.mailHost, existing, spf, dmarcRua: cfg.dmarcRua }) };
				},
				async test(ctx, ch) { if (!ch.domain) return noDomain(); const p = await this.plan(ctx, ch); if (!p) return no('The domain isn\'t in our Cloudflare yet (Domain setup).'); return p.plan.every((x) => x.action === 'keep') ? ok('One SPF record that includes Postmark.' + (p.spf.tooManyLookups ? ' (Too many lookups: ask for help.)' : '')) : no(planText(p.plan)); },
				async fix(ctx, ch) { const p = await this.plan(ctx, ch); if (!p) return { ok: false, detail: 'The domain isn\'t in our Cloudflare yet.' }; const r = await applyPlan(ctx, p.z.id, p.plan); return { ok: !r.flagged.length, detail: [...r.done, ...r.flagged.map((f) => 'A person must remove this in Cloudflare: ' + f)].join('\n') || 'Done.' }; },
			},
			{
				id: 'verified', label: 'Does Postmark confirm the domain is verified?', services: ['postmark'], deps: ['pmdns'], fixLabel: 'Ask Postmark to verify',
				async test(ctx, ch) { const d = await ctx.c.postmark.domain((await ctx.c.postmark.domainByName(ch.domain)).ID); return d.DKIMVerified && d.ReturnPathDomainVerified ? ok('DKIM and Return-Path verified.') : no(`Not verified yet (DKIM ${d.DKIMVerified ? 'yes' : 'no'}, Return-Path ${d.ReturnPathDomainVerified ? 'yes' : 'no'}). DNS can take a few minutes.`); },
				async fix(ctx, ch) { const id = (await ctx.c.postmark.domainByName(ch.domain)).ID; await ctx.c.postmark.verifyDkim(id); await ctx.c.postmark.verifyReturnPath(id); try { await ctx.c.postmark.verifySpf(id); } catch { /* optional */ } return { ok: true, detail: 'Asked Postmark to check.' }; },
			},
			{
				id: 'smtp', label: 'Does the website send its email through Postmark?', services: ['ssh', 'smtp'], deps: ['verified'], fixLabel: 'Connect the website to Postmark',
				test: (ctx, ch) => onSite(ctx, ch, async (h) => ((await wpGet(ctx, h, 'config get WPMS_SMTP_HOST')) === 'smtp.postmarkapp.com' ? ok('Sending through Postmark.') : no('The website isn\'t sending through Postmark.'))),
				fix: (ctx, ch) => fixOnSite(ctx, ch, ['config set WPMS_ON true --raw', 'config set WPMS_MAILER smtp', 'config set WPMS_SMTP_HOST smtp.postmarkapp.com', 'config set WPMS_SMTP_PORT 587 --raw', 'config set WPMS_SSL tls', 'config set WPMS_SMTP_AUTH true --raw', 'config set WPMS_SMTP_USER <Postmark server token>', 'config set WPMS_SMTP_PASS <Postmark server token>', `config set WPMS_MAIL_FROM info@${ch.domain}`].map((a) => handCmd(ctx, ch, a + ' --type=constant')), async (h) => {
					const tok = ctx.c.cfg.postmarkServerToken, set = (k, v, raw) => wpRun(ctx, h, `config set ${k} ${raw ? v + ' --raw' : shq(v)} --type=constant`);
					for (const [k, v, raw] of [['WPMS_ON', 'true', 1], ['WPMS_MAILER', 'smtp'], ['WPMS_SMTP_HOST', 'smtp.postmarkapp.com'], ['WPMS_SMTP_PORT', '587', 1], ['WPMS_SSL', 'tls'], ['WPMS_SMTP_AUTH', 'true', 1], ['WPMS_SMTP_USER', tok], ['WPMS_SMTP_PASS', tok], ['WPMS_MAIL_FROM', 'info@' + ch.domain]]) {
						const r = await set(k, v, raw); if (r.code) return { ok: false, detail: (r.err || '').split(tok).join('••••').trim().slice(-300) };
					}
					return { ok: true, detail: 'The website now sends through Postmark.' };
				}),
			},
			manual('testmail', 'Did a test email arrive?', 'Send a test email from the website (WP Mail SMTP → Email Test) to a real inbox, check it arrived and isn\'t in spam, then tick this box.'),
		],
	},

	/* ============================================================ domain in Cloudflare (first, safe on day one) */
	{
		key: 'cloudflare', n: 2, title: 'Domain in our Cloudflare', needs: [],
		blurb: 'Adding a domain to our Cloudflare changes nothing live until the church switches its nameservers, so this can be done on day one. It also gives you the nameservers to send them when you are ready to switch.',
		reqs: [
			{
				id: 'zone', label: 'Is the domain in our Cloudflare?', services: ['cloudflare'], fixLabel: 'Add it to Cloudflare',
				async test(ctx, ch) { if (!ch.domain) return noDomain(); const z = await zoneOf(ctx, ch.domain); if (z) ctx.facts = { nameservers: z.name_servers }; return z ? ok(`Yes (${z.status})`) : no('Not in our Cloudflare yet.'); },
				async fix(ctx, ch) { const z = await ctx.c.cloudflare.createZone(ch.domain); ctx.memo = {}; return { ok: true, detail: 'Added. The nameservers to give the church: ' + z.name_servers.join(' and ') }; },
				howTo: (ch) => `In the Cloudflare account for churches, add the site ${ch.domain || ''}.`,
			},
			{
				id: 'records', label: 'Have the church\'s existing DNS records been copied over?', services: ['cloudflare'], deps: ['zone'], fixLabel: 'Copy the records',
				async test(ctx, ch) {
					const z = await zoneOf(ctx, ch.domain), n = (await cfRecords(ctx, z.id)).length;
					if (n) return ok(`${n} records in Cloudflare.`);
					const waiting = (await inventory(ctx, ch.domain)).length;
					return waiting ? no(`The zone is empty, but the domain has ${waiting} record(s) today. Copy them before the nameservers change, or the church's email and subdomains stop working.`) : ok('Nothing to copy: the domain has no records yet.');
				},
				async fix(ctx, ch) {
					const z = await zoneOf(ctx, ch.domain), inv = await inventory(ctx, ch.domain);
					const r = await applyPlan(ctx, z.id, inv.map((x) => ({ action: 'create', ...x })));
					return { ok: true, detail: `${r.done.length} records copied from the church's current DNS. This is a best effort from public lookups: ask the church for a screenshot of their DNS to be sure nothing (verification codes, other subdomains) is missing.` };
				},
			},
			{
				id: 'nsinfo', label: 'Which nameservers will the church need to switch to?', services: ['cloudflare'], deps: ['zone'],
				async test(ctx, ch) {
					const z = await zoneOf(ctx, ch.domain); if (!z) return no('Add the domain to Cloudflare first.');
					ctx.facts = { nameservers: z.name_servers };
					return info(`Set these two nameservers at the registrar (for example Namecheap: Domain List → Manage → Nameservers → Custom DNS):\n${z.name_servers.join('\n')}\nDo this only when the church has approved and the new site is ready: it moves their website and email to our Cloudflare.`);
				},
			},
		],
	},

	/* ============================================================ 8 */
	{
		key: 'handover', n: 8, title: 'Hand the site over', needs: ['golive'],
		blurb: 'Give the church their login and make sure everything behind the scenes is in place.',
		reqs: [
			{
				id: 'login', label: 'Does the church have its own staff login?', services: ['ssh'], deps: [], fixLabel: 'Create the login',
				test: (ctx, ch) => onSite(ctx, ch, async (h) => { const l = await wpGet(ctx, h, 'user list --role=editor --field=user_login'); return l ? ok(l.split('\n')[0]) : no('No Editor login yet.'); }),
				fix: (ctx, ch) => fixOnSite(ctx, ch, [handCmd(ctx, ch, `user create ${shq(ch.slug + '-admin')} <church email> --role=editor --user_pass=<password> --send-email=0`)], async (h) => {
					const em = String(ch.contactEmail || '').trim();
					if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return { ok: false, detail: 'Enter the church contact\'s email at the top of this page first.' };
					const login = (ch.slug + '-admin').slice(0, 40), pw = randomPassword(16);
					const r = await wpRun(ctx, h, `user create ${shq(login)} ${shq(em)} --role=editor --user_pass=${shq(pw)} --send-email=0 --porcelain`);
					if (r.code) return { ok: false, detail: (r.err || '').split(pw).join('••••').trim().slice(-300) };
					ctx.secret = { login, password: pw, email: em }; return { ok: true, detail: 'Login created. The password is shown once below. Copy it now: it isn\'t saved.' };
				}),
			},
			{
				id: 'staffview', label: 'Is the simple staff view switched on?', services: ['ssh'], deps: ['login'], fixLabel: 'Turn it on',
				test: (ctx, ch) => onSite(ctx, ch, async (h) => ((await wpGet(ctx, h, `eval ${shq("$o = get_option('cwai_sv'); echo !empty($o['enabled']) ? '1' : '0';")}`)) === '1' ? ok() : no('The church would see the full WordPress menu.'))),
				fix: (ctx, ch) => fixOnSite(ctx, ch, [handCmd(ctx, ch, `eval ${shq("update_option('cwai_sv', array_merge(CWAI_StaffView::defaults(), ['enabled' => true]));")}`)], async (h) => {
					const r = await wpRun(ctx, h, `eval ${shq("update_option('cwai_sv', array_merge(CWAI_StaffView::defaults(), ['enabled' => true]));")}`);
					return r.code ? { ok: false, detail: r.err.trim().slice(-300) } : { ok: true, detail: 'Staff view is on.' };
				}),
			},
			{
				id: 'gateway', label: 'Is the AI Assistant switched on for this church?', services: ['gateway'], deps: [], fixLabel: 'Switch it on',
				async test(ctx, ch) { if (!ctx.c.gateway.available()) return unk('The gateway key isn\'t set up on this server.'); const s = await ctx.c.gateway.site(ch.slug); return s.revoked ? no('It is switched OFF at the gateway.') : ok(s.caps && s.caps.tokens ? `Daily limit ${s.caps.tokens} tokens.` : 'On.'); },
				async fix(ctx, ch) { await ctx.c.gateway.revoke(ch.slug, false); return { ok: true, detail: 'Switched on.' }; },
			},
			manual('welcome', 'Has the welcome email been sent to the church?', 'Send the login, how to use the Assistant, and the support address. Then tick this box.'),
			manual('stripe', 'Is the subscription recorded in Stripe with their name and domain?', 'Check Stripe, then tick.'),
			manual('backups', 'Is the site covered by Hostinger\'s nightly backup?', 'hPanel → Backups. Then tick.'),
			manual('monitor', 'Is the site in uptime monitoring?', 'Add it to your monitor. Then tick.'),
			{ ...manual('dudaRetire', 'Has the old DUDA site been unpublished, about two weeks after we went live?', 'Leave it up for about two weeks after going live, then unpublish the old site in DUDA once the new one has run smoothly. Then tick.'), onlyKind: 'migration' },
			{ ...manual('dudaBilling', 'Is the church\'s DUDA plan cancelled or removed from our DUDA bill?', 'Check the DUDA account, then tick.'), onlyKind: 'migration' },
		],
	},
	/* ============================================================ prospect (new sites only) */
	{
		key: 'sales', n: 0, title: 'Prospect and agreement', needs: [], onlyKind: 'new',
		blurb: 'For a church that is new to us. Nothing technical happens here: it records that we have spoken, who the contact is, and that they want to see a preview.',
		reqs: [
			{ id: 'contact', label: 'Do we have a contact person\'s email?', test: async (ctx, ch) => (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(ch.contactEmail || '').trim()) ? ok(ch.contactEmail) : no('Add the contact\'s email under Customer details.')) },
			manual('spoken', 'Have we been in touch with the church (a reply, a call or a meeting)?', 'Tick this once someone from the church has responded to us.'),
			manual('needs', 'Do we know what they want (new site, hosting, email, who updates it)?', 'Write what you learn in the notes under Customer details, then tick.'),
			manual('go', 'Has the church said yes to a free preview?', 'Tick this when they agree. The next phases build the preview site.'),
		],
	},

	/* ============================================================ move content from DUDA (migrations only) */
	{
		key: 'migrate', n: 0, title: 'Move the content from DUDA', needs: ['preview'], onlyKind: 'migration',
		blurb: 'For a church that is already on DUDA. The old site stays live and untouched until the domain is switched.',
		reqs: [
			manual('dudasite', 'Have we found the church\'s site in DUDA (name or site ID)?', 'Find it in DUDA and note the site name in the notes under Customer details, then tick.'),
			manual('exported', 'Has the content been exported from DUDA?', 'Use the Exporter tab with their DUDA site address, then tick.'),
			manual('imported', 'Is the content in the new WordPress site?', 'Pages, posts, images and menus. Then tick.'),
			manual('parity', 'Do pages, forms, menus and old web addresses match the old site?', 'Compare the two sites side by side. List any old addresses that need a redirect, add them, then tick.'),
		],
	},

];

/** The order a customer moves through. */
const ORDER = ['sales', 'dnscheck', 'cloudflare', 'preview', 'migrate', 'approval', 'dns', 'golive', 'mailboxes', 'sending', 'handover'];
STAGES.sort((a, b) => ORDER.indexOf(a.key) - ORDER.indexOf(b.key));
STAGES.forEach((st, i) => { st.n = i + 1; });

export const stageByKey = (k) => STAGES.find((s) => s.key === k);
/** A customer is either a 'new' site (prospect) or a 'migration' from DUDA. Older records have no kind and count as new. */
export const kindOf = (ch) => (ch && ch.kind === 'migration' ? 'migration' : 'new');
export const reqsFor = (stage, ch) => stage.reqs.filter((q) => !q.onlyKind || q.onlyKind === kindOf(ch));
export const stageSkipped = (stage, ch) => !!((stage.onlyPlan && stage.onlyPlan !== ch.plan) || (stage.onlyKind && stage.onlyKind !== kindOf(ch)));
export const reqOf = (stage, id) => stage.reqs.find((r) => r.id === id);
const manualDone = (ch, stage, id) => !!ch.stages[stage.key]?.manual?.[id];
const missingServices = (ctx, req) => (req.services || []).filter((s) => !ctx.configured[s]);

/** Which earlier stages must be finished before this stage's fixes may run. */
export function blockedBy(ch, stage) {
	const out = [];
	for (const need of stage.needs) if (!ch.stages[need]?.done) out.push(need);
	if (stage.onlyPlan && ch.plan !== stage.onlyPlan) out.push('plan');
	if (stage.onlyKind && stage.onlyKind !== kindOf(ch)) out.push('kind');
	return out;
}

/** Test every requirement of a stage, in order. Returns {id: {state, detail}}. A requirement whose prerequisite is not met is "blocked" and is not tested. */
export async function testStage(ctx, ch, stage) {
	const out = {};
	for (const req of reqsFor(stage, ch)) {
		const unmet = (req.deps || []).filter((d) => !depMet(out[d]?.state));
		if (unmet.length) { out[req.id] = R('blocked', 'Waiting for: ' + unmet.map((d) => reqOf(stage, d).label.replace(/\?$/, '')).join('; ')); continue; }
		if (req.manual) { out[req.id] = manualDone(ch, stage, req.id) ? ok('Ticked.') : no(''); continue; }
		try { out[req.id] = await req.test.call(req, ctx, ch); } catch (e) { out[req.id] = R('error', e.message); }
	}
	return out;
}

/** Fix one requirement (only if it currently tests "no"). Returns {ok, detail, howTo, unavailable}. */
export async function fixReq(ctx, ch, stage, req, current) {
	if (!req.fix) return { ok: false, howTo: typeof req.howTo === 'function' ? req.howTo(ch, ctx.c.cfg) : req.howTo || 'This one is done by hand.' };
	const missing = missingServices(ctx, req);
	if (missing.length) {
		const hand = typeof req.howTo === 'function' ? req.howTo(ch, ctx.c.cfg) : req.howTo;
		// SSH-based fixes build their own hand-done commands, so let them run and report them; others need the service.
		if (!(missing.length === 1 && missing[0] === 'ssh')) return { ok: false, unavailable: missing, howTo: hand || 'This server isn\'t set up for it yet (' + missing.join(', ') + '). Do it by hand for now.' };
	}
	try { return await req.fix.call(req, ctx, ch); } catch (e) { return { ok: false, detail: e.message }; }
}
