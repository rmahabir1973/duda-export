import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createStore } from '../deploy/store.mjs';
import { createProspects, nameFromTitle, platformFromHtml, PREVIEW_DAYS } from '../deploy/prospects.mjs';
import { buildBrief } from '../deploy/brief.mjs';
import { applyOxygenLicense } from '../deploy/checks.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pros-'));
const DAY = 86400000;
const OK = new Set(['ok', 'info', 'warn']);

function rig({ cwai = false, hostFails = false, autoDelete = false, golive = false } = {}) {
	const dir = tmp(), store = createStore(path.join(dir, 'deploy'));
	const clock = { t: 1_800_000_000_000 }, mail = [], hostDeleted = [], bg = [], wp = [];
	const st = { a: 'no', b: 'no', c: 'no' };
	const job = { status: 'queued', summary: { pages: 6, images: 14, zipMB: 3.2 }, lastLog: 'reading page 2', zipPath: path.join(dir, 'e.zip'), platform: 'DUDA' };
	fs.writeFileSync(job.zipPath, 'zip');
	const calls = { fix: [], enqueue: [] };
	const engine = {
		STAGES: [{ key: 'preview', reqs: [{ id: 'a', label: 'a', fix: true }, { id: 'b', label: 'b', fix: true }, { id: 'c', label: 'c', fix: true }, { id: 'oxygen', label: 'Oxygen', manual: true }] }],
		reqsFor: (s) => s.reqs, isSatisfied: (x) => OK.has(x),
		testStage: async (ctx, ch) => ({ a: { state: st.a }, b: { state: st.b }, c: { state: st.c }, oxygen: { state: ch.stages?.preview?.manual?.oxygen ? 'ok' : 'no' } }),
		fixReq: async (ctx, ch, stage, q) => { calls.fix.push(q.id); if (hostFails) return { ok: false, detail: 'Hostinger said no' }; st[q.id] = 'ok'; return { ok: true, detail: 'done' }; },
		applyOxygenLicense: async () => ({ state: 'ok', detail: 'Added the Oxygen licence key to the site.' }),
		runWp: async (ctx, ch, args) => { wp.push(args); return /^help cwai portal-build/.test(args) ? { code: cwai ? 0 : 1, out: '', err: '' } : { code: 0, out: '', err: '' }; },
		runWpBackground: async (ctx, ch, args) => { bg.push(args); return { code: 0, out: 'started', err: '' }; },
	};
	const clients = {
		cfg: { previewDomain: 'churchwebglobal.com', templateSlug: 'build2' },
		http: { get: async () => ({ status: 200, text: '<html><title>Grace United Church | Home</title><link href="https://static.cdn-website.com/x.css"></html>' }) },
		hostinger: { available: () => true, websites: async () => [{ domain: 'grace-united-church.churchwebglobal.com' }], deleteWebsite: async (d) => { hostDeleted.push(d); } },
		gateway: { available: () => false },
	};
	const exporter = { enqueue: async (b) => { calls.enqueue.push(b); return { id: 'job1' }; }, get: () => job };
	const p = createProspects({ store, clients, exporter, dataDir: dir, notify: async (m) => { mail.push(m); }, secret: 'k', now: () => clock.t, autoDelete, alertTo: ['boss@x.ca'], baseUrl: 'https://portal.test', engine, log: () => {} });
	return { p, store, clock, mail, hostDeleted, bg, wp, st, job, calls, dir, golive };
}
const make = async (r, o = {}) => { const c = await r.p.create({ url: 'https://www.graceunited.ca/', contactEmail: 'office@grace.ca', mode: 'preview', ...o }, 'staff@x.ca'); return c; };

test('names and platforms are worked out from the site', () => {
	assert.equal(nameFromTitle('Home | Grace United Church', 'graceunited.ca'), 'Grace United Church');
	assert.equal(nameFromTitle('Welcome - St. Andrew&#39;s Presbyterian Church: Toronto', 'x.ca'), "St. Andrew's Presbyterian Church");
	assert.equal(nameFromTitle('', 'britannia-united.ca'), 'Britannia United');
	assert.equal(platformFromHtml('<link href="https://static.cdn-website.com/a.css">'), 'DUDA');
	assert.equal(platformFromHtml('<script src="/wp-content/x.js">'), 'WordPress');
	assert.equal(platformFromHtml('<html></html>'), '');
});

test('the design brief: a preview runs on its own, a full site may ask about duplicates', () => {
	const pv = buildBrief({ name: 'Grace', domain: 'g.ca', platform: 'DUDA', mode: 'preview', docs: [{ name: 'info.txt', text: 'Minister is Rev. Smith' }, { name: 'a.pdf' }] });
	assert.match(pv, /modern/i); assert.match(pv, /Only ask a person a question when you cannot go on/); assert.match(pv, /Do not stop to ask about duplicates/);
	assert.match(pv, /Rev\. Smith/); assert.match(pv, /a\.pdf/); assert.match(pv, /QUESTION:/); assert.match(pv, /DONE:/); assert.doesNotMatch(pv, /Build every page/);
	const full = buildBrief({ name: 'Grace', mode: 'full' });
	assert.match(full, /Build every page/); assert.match(full, /duplicates/); assert.doesNotMatch(full, /Do not stop to ask about duplicates/);
});

test('create: name from the site, short name made, preview flag kept, platform noted', async () => {
	const r = rig(); const c = await make(r);
	assert.equal(c.name, 'Grace United Church'); assert.equal(c.slug, 'grace-united-church'); assert.equal(c.prospect.domain, 'graceunited.ca'); assert.equal(c.prospect.platform, 'DUDA'); assert.equal(c.prospect.mode, 'preview');
	const d = await make(r); assert.equal(d.slug, 'grace-united-church-2');
	await assert.rejects(() => r.p.create({ url: 'not a site' }), /does not look like a website/);
});

test('run: export, then site steps one after another, then the plugin is not ready so the build waits', async () => {
	const r = rig(); const c = await make(r); r.p.start(c.id);
	await r.p.tick(c.id);
	assert.equal(r.calls.enqueue[0].preview, true); assert.equal(r.calls.enqueue[0].domain, 'graceunited.ca');
	let v = r.p.view(r.store.get(c.id)); assert.equal(v.stages[1].state, 'working');
	r.job.status = 'running'; await r.p.tick(c.id); v = r.p.view(r.store.get(c.id)); assert.match(v.headline, /reading page 2/);
	r.job.status = 'done'; await r.p.tick(c.id);
	v = r.p.view(r.store.get(c.id)); assert.equal(v.stages[1].state, 'done'); assert.match(v.stages[1].message, /6 pages/); assert.ok(v.zipReady);
	await r.p.tick(c.id); // site: every quick step is done in one go
	assert.deepEqual(r.calls.fix, ['a', 'b', 'c']);
	const ch = r.store.get(c.id);
	assert.equal(ch.run.steps.site.state, 'done'); assert.equal(ch.stages.preview.manual.oxygen, true); assert.equal(ch.stages.preview.done, true);
	assert.ok(Math.abs(ch.prospect.expiresAt - (r.clock.t + PREVIEW_DAYS * DAY)) < 1000);
	await r.p.tick(c.id); // build
	const b = r.store.get(c.id);
	assert.equal(b.run.steps.build.state, 'blocked'); assert.equal(b.run.state, 'waiting'); assert.match(b.run.steps.build.message, /plugin/i);
	assert.ok(fs.readFileSync(path.join(r.dir, 'prospects', c.id, 'brief.md'), 'utf8').includes('Grace United Church'));
	assert.equal(r.p.view(b).canRetry, true);
});

test('a site step that keeps failing stops with a plain message after three tries and can be retried', async () => {
	const r = rig({ hostFails: true }); const c = await make(r); r.p.start(c.id);
	r.job.status = 'done'; await r.p.tick(c.id); await r.p.tick(c.id); // export starts then finishes
	for (let i = 0; i < 6 && r.store.get(c.id).run.state === 'running'; i++) { r.clock.t += 200000; await r.p.tick(c.id); }
	const ch = r.store.get(c.id);
	assert.equal(ch.run.state, 'failed'); assert.equal(ch.run.steps.site.state, 'failed'); assert.match(ch.run.steps.site.message, /did not work after 3 tries/);
	assert.equal(r.mail.at(-1).to[0], 'boss@x.ca', 'alerts go to the alert list');
	assert.equal(ch.run.steps.export.state, 'done', 'finished steps are kept');
	r.p.start(c.id); assert.equal(r.store.get(c.id).run.steps.export.state, 'done'); assert.equal(r.store.get(c.id).run.state, 'running');
});

test('build with a ready plugin: starts in the background, a question waits for an answer, the answer resumes it, done finishes', async () => {
	const r = rig({ cwai: true }); const c = await make(r); r.p.start(c.id);
	r.job.status = 'done'; await r.p.tick(c.id); await r.p.tick(c.id); await r.p.tick(c.id); await r.p.tick(c.id);
	assert.equal(r.bg.length, 1); assert.match(r.bg[0], /^cwai portal-build /); assert.match(r.bg[0], /--mode=preview/); assert.match(r.bg[0], /--package='https:\/\/portal\.test\/api\/build\/grace-united-church\/package\.zip\?t=/);
	assert.equal(r.store.get(c.id).run.steps.build.state, 'working');
	r.p.reportBuild(c.id, { state: 'working', message: 'Adding images (3 of 14)…', pct: 20 });
	assert.equal(r.p.view(r.store.get(c.id)).stages[3].pct, 20);
	r.p.reportBuild(c.id, { state: 'question', question: { text: 'Which logo?', options: ['A', 'B'] } });
	let ch = r.store.get(c.id); assert.equal(ch.run.state, 'needs_input'); assert.equal(ch.run.steps.build.state, 'needs_input');
	assert.match(r.mail.at(-1).subject, /answer is needed/i); assert.deepEqual(r.mail.at(-1).to, ['staff@x.ca', 'boss@x.ca']);
	assert.throws(() => r.p.answer(c.id, 'wrong', 'A'), /already been answered/);
	r.p.answer(c.id, ch.run.steps.build.question.id, 'Logo A'); await new Promise((x) => setTimeout(x, 5));
	assert.equal(r.bg.length, 2); assert.match(r.bg[1], /--resume/); assert.match(r.bg[1], /--answer='Logo A'/); assert.doesNotMatch(r.bg[1], /--package/);
	assert.equal(r.store.get(c.id).run.steps.build.state, 'working');
	r.p.reportBuild(c.id, { state: 'done', message: 'Built 6 pages.' });
	ch = r.store.get(c.id); assert.equal(ch.run.state, 'done'); const v = r.p.view(ch);
	assert.ok(v.stages.every((s) => s.state === 'done')); assert.equal(v.previewUrl, 'https://grace-united-church.churchwebglobal.com'); assert.equal(v.daysLeft, PREVIEW_DAYS);
	assert.match(r.mail.at(-1).subject, /Preview ready/);
});

test('signed links: right church only, and they expire', async () => {
	const r = rig(); const c = await make(r);
	const t = r.p.sign(c.id); assert.equal(r.p.verify(t), c.id);
	assert.equal(r.p.verify(t + 'x'), null); assert.equal(r.p.verify('junk'), null);
	r.clock.t += 9 * 3600000; assert.equal(r.p.verify(t), null);
});

test('the plugin-facing endpoints need the token; the brief and the package are served; a bad token is refused', async () => {
	const r = rig(); const c = await make(r); r.p.start(c.id); r.job.status = 'done'; await r.p.tick(c.id); await r.p.tick(c.id);
	const app = express(); app.use('/api/build', r.p.buildRouter());
	const srv = app.listen(0), port = srv.address().port, base = `http://127.0.0.1:${port}/api/build/${c.id}`;
	try {
		assert.equal((await fetch(`${base}/brief.md`)).status, 403);
		const t = r.p.sign(c.id);
		const b = await fetch(`${base}/brief.md?t=${t}`); assert.equal(b.status, 200); assert.match(await b.text(), /Grace United Church/);
		const z = await fetch(`${base}/package.zip?t=${t}`); assert.equal(z.status, 200); assert.equal(await z.text(), 'zip');
		const s = await fetch(`${base}/status`, { method: 'POST', headers: { authorization: 'Bearer ' + t, 'content-type': 'application/json' }, body: JSON.stringify({ state: 'working', message: 'hi', pct: 40 }) }); assert.equal(s.status, 200);
		assert.equal(r.store.get(c.id).run.steps.build.pct, 40);
		assert.equal((await fetch(`http://127.0.0.1:${port}/api/build/other/brief.md?t=${t}`)).status, 403, 'a token for one church does not open another');
	} finally { srv.close(); }
});

test('documents: stored, read into the brief when they are text, removed again; odd files refused', async () => {
	const r = rig(); const c = await make(r);
	r.p.addDoc(c.id, 'About us.txt', Buffer.from('We are a warm, traditional congregation.'));
	r.p.addDoc(c.id, 'bulletin.pdf', Buffer.from('%PDF-1.4'));
	assert.throws(() => r.p.addDoc(c.id, 'virus.exe', Buffer.from('x')), /Use a text/);
	assert.throws(() => r.p.addDoc(c.id, 'big.txt', Buffer.alloc(11 * 1048576)), /over 10 MB/);
	const brief = r.p.briefFor(r.store.get(c.id)); assert.match(brief, /warm, traditional/); assert.match(brief, /bulletin\.pdf/);
	r.p.removeDoc(c.id, 1); assert.doesNotMatch(r.p.briefFor(r.store.get(c.id)), /warm, traditional/);
});

test('30-day clean-up: warns once at 7 and 2 days, leaves live and kept sites alone, deletes only when switched on', async () => {
	const r = rig(); const c = await make(r);
	r.store.update(c.id, (x) => { x.prospect.expiresAt = r.clock.t + 6 * DAY; });
	await r.p.sweep(); await r.p.sweep(); assert.equal(r.mail.filter((m) => /deleted in 6 days/.test(m.subject)).length, 1);
	r.clock.t += 5 * DAY; await r.p.sweep(); assert.equal(r.mail.filter((m) => /deleted in 1 day/.test(m.subject)).length, 1);
	r.clock.t += 2 * DAY; const out = await r.p.sweep(); assert.equal(out.overdue, 1); assert.deepEqual(r.hostDeleted, [], 'automatic deletion is off by default'); assert.ok(r.store.get(c.id));
	r.p.keep(c.id); assert.ok(r.store.get(c.id).prospect.expiresAt > r.clock.t + 29 * DAY); assert.equal(r.store.get(c.id).prospect.warned7, undefined);

	const g = rig({ autoDelete: true }); const d = await make(g);
	g.store.update(d.id, (x) => { x.prospect.expiresAt = g.clock.t - DAY; });
	const o2 = await g.p.sweep(); assert.equal(o2.deleted, 1); assert.deepEqual(g.hostDeleted, ['grace-united-church.churchwebglobal.com']); assert.equal(g.store.get(d.id), null);
	const h = rig({ autoDelete: true }); const e = await make(h);
	h.store.update(e.id, (x) => { x.prospect.expiresAt = h.clock.t - DAY; x.stages.golive = { done: true }; });
	await h.p.sweep(); assert.deepEqual(h.hostDeleted, [], 'a live site is never deleted'); assert.ok(h.store.get(e.id));
});

test('applyOxygenLicense writes the key as a constant, never shows it, and says what is missing', async () => {
	const calls = [];
	const ssh = { available: () => true, exec: async (cmd) => { calls.push(cmd); if (/test -f .*wp-config\.php/.test(cmd)) return { code: 0, out: 'FOUND', err: '' }; if (/config get OXYGEN_LICENSE_KEY/.test(cmd)) return { code: 1, out: '', err: 'nope' }; if (/config set OXYGEN_LICENSE_KEY/.test(cmd)) return { code: 0, out: 'Success', err: '' }; return { code: 0, out: '', err: '' }; } };
	const mk = (key) => ({ c: { cfg: { oxygenLicense: key, previewDomain: 'churchwebglobal.com', siteRoot: '$HOME/domains/{host}/public_html', wpCli: 'wp' }, ssh }, memo: {} });
	const ch = { slug: 'grace', domain: '' };
	assert.equal((await applyOxygenLicense(mk(''), ch)).state, 'unknown');
	const r = await applyOxygenLicense(mk('SECRETKEY123'), ch);
	assert.equal(r.state, 'ok'); assert.ok(calls.some((c) => /config set OXYGEN_LICENSE_KEY 'SECRETKEY123' --type=constant/.test(c))); assert.doesNotMatch(JSON.stringify(r), /SECRETKEY123/);
});
