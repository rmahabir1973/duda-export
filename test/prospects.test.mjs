import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createStore } from '../deploy/store.mjs';
import { createProspects, nameFromTitle, platformFromHtml, PREVIEW_DAYS } from '../deploy/prospects.mjs';
import { buildBrief } from '../deploy/brief.mjs';
import { extractDocument } from '../deploy/docs.mjs';
import { zipSync, strToU8 } from 'fflate';
import { applyOxygenLicense } from '../deploy/checks.mjs';
import { priceTable, priceDelta, snapshot } from '../deploy/pricing.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pros-'));
const DAY = 86400000;
const OK = new Set(['ok', 'info', 'warn']);

function rig({ extra = null, ssh = null, cwai = false, hostFails = false, autoDelete = false, golive = false, gw = null } = {}) {
	const dir = tmp(), store = createStore(path.join(dir, 'deploy'));
	const clock = { t: 1_800_000_000_000 }, mail = [], hostDeleted = [], bg = [], wp = [];
	const st = { a: 'no', b: 'no', c: 'no' };
	const job = { status: 'queued', summary: { pages: 6, images: 14, zipMB: 3.2 }, lastLog: 'reading page 2', zipPath: path.join(dir, 'e.zip'), platform: 'DUDA' };
	fs.writeFileSync(job.zipPath, 'zip');
	const calls = { fix: [], enqueue: [] }, sites = [];
	const optionResult = { code: 1, out: '', err: '' };
	const loginResult = { code: 0, out: 'Success: hi\nhttps://grace-united-church.churchwebglobal.com/?cwai_login=' + 'a'.repeat(64) + '\n', err: '' };
	const engine = {
		STAGES: [{ key: 'preview', reqs: [{ id: 'dns', label: 'dns', fix: true }, { id: 'hostingerPlugins', label: 'hp', fix: true }, { id: 'a', label: 'a', fix: true }, { id: 'b', label: 'b', fix: true }, { id: 'c', label: 'c', fix: true }, { id: 'oxygen', label: 'Oxygen', manual: true }] }],
		reqsFor: (s) => s.reqs, isSatisfied: (x) => OK.has(x),
		testStage: async (ctx, ch) => ({ dns: { state: 'no' }, hostingerPlugins: { state: 'no' }, a: { state: st.a }, b: { state: st.b }, c: { state: st.c }, oxygen: { state: ch.stages?.preview?.manual?.oxygen ? 'ok' : 'no' } }),
		fixReq: async (ctx, ch, stage, q) => { if (q.id === 'dns') throw new Error('Cloudflare must not be called'); if (q.id === 'hostingerPlugins') { calls.cleanup = (calls.cleanup || 0) + 1; return { ok: true, detail: 'Removed 3 Hostinger plugin(s).' }; } calls.fix.push(q.id); if (!hostFails && !sites.includes(ch.slug)) sites.push(ch.slug); if (hostFails) return { ok: false, detail: 'Hostinger said no' }; st[q.id] = 'ok'; return { ok: true, detail: 'done' }; },
		applyOxygenLicense: async () => ({ state: 'ok', detail: 'Added the Oxygen licence key to the site.' }),
		runWp: async (ctx, ch, args) => { wp.push(args); if (/option get cwai_portal_build/.test(args)) return optionResult; if (/portal-login/.test(args)) return loginResult; return /^help cwai portal-build/.test(args) ? { code: cwai ? 0 : 1, out: '', err: '' } : { code: 0, out: '', err: '' }; },
		runWpBackground: async (ctx, ch, args) => { bg.push(args); return { code: 0, out: 'started', err: '' }; },
	};
	const clients = {
		cfg: { previewDomain: 'churchwebglobal.com', templateSlug: 'build2' },
		http: { get: async () => ({ status: 200, text: '<html><title>Grace United Church | Home</title><link href="https://static.cdn-website.com/x.css"></html>' }) },
		hostinger: { available: () => true, websites: async () => [...sites, ...(extra || [])].map((x) => ({ domain: x.includes('.') ? x : x + '.churchwebglobal.com' })), deleteWebsite: async (d) => { hostDeleted.push(d); } },
		gateway: gw || { available: () => false },
		...(ssh ? { ssh } : {}),
	};
	const exporter = { enqueue: async (b) => { calls.enqueue.push(b); return { id: 'job1' }; }, get: () => job };
	const p = createProspects({ store, clients, exporter, dataDir: dir, notify: async (m) => { mail.push(m); }, secret: 'k', now: () => clock.t, autoDelete, alertTo: ['boss@x.ca'], baseUrl: 'https://portal.test', engine, log: () => {} });
	return { sites, p, engine, store, clock, mail, hostDeleted, bg, wp, st, job, calls, dir, golive, loginResult, optionResult };
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

test('documents: stored, read into the brief, removed again; odd files refused', async () => {
	const r = rig(); const c = await make(r);
	await r.p.addDoc(c.id, 'About us.txt', Buffer.from('We are a warm, traditional congregation.'));
	await r.p.addDoc(c.id, 'scan.pdf', Buffer.from('%PDF-1.4 not really'));
	await assert.rejects(() => r.p.addDoc(c.id, 'virus.exe', Buffer.from('x')), /Use a text/);
	await assert.rejects(() => r.p.addDoc(c.id, 'big.txt', Buffer.alloc(11 * 1048576)), /over 10 MB/);
	const brief = r.p.briefFor(r.store.get(c.id)); assert.match(brief, /warm, traditional/); assert.match(brief, /scan\.pdf/); assert.match(brief, /could not be read/);
	const v = r.p.view(r.store.get(c.id)); assert.equal(v.docs[0].readable, true); assert.equal(v.docs[1].readable, false); assert.ok(v.docs[1].note);
	r.p.removeDoc(c.id, 1); assert.doesNotMatch(r.p.briefFor(r.store.get(c.id)), /warm, traditional/);
});

const pdfOf = (text) => {
	const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>', null, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
	const stream = `BT /F1 14 Tf 20 100 Td (${text}) Tj ET`;
	objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
	let out = '%PDF-1.4\n'; const off = [];
	objs.forEach((o, i) => { off.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
	const x = out.length;
	out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + off.map((n) => String(n).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF`;
	return Buffer.from(out);
};

test('reading Word, Excel, OpenDocument, PDF and RTF files', async () => {
	const docx = Buffer.from(zipSync({ 'word/document.xml': strToU8('<w:document><w:body><w:p><w:r><w:t>Sunday worship 10:30 am</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Rev.</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Smith &amp; Co</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>') }));
	let g = await extractDocument('service.docx', docx); assert.equal(g.readable, true); assert.match(g.text, /Sunday worship 10:30 am/); assert.match(g.text, /Rev\. \| Smith & Co/);

	const xlsx = Buffer.from(zipSync({
		'xl/workbook.xml': strToU8('<workbook><sheets><sheet name="Events" sheetId="1" r:id="rId1"/></sheets></workbook>'),
		'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>'),
		'xl/sharedStrings.xml': strToU8('<sst><si><t>Event</t></si><si><t>Date</t></si><si><t>Bake sale</t></si></sst>'),
		'xl/worksheets/sheet1.xml': strToU8('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>42</v></c><c r="C2" t="inlineStr"><is><t>June 5</t></is></c></row></sheetData></worksheet>'),
	}));
	g = await extractDocument('events.xlsx', xlsx); assert.equal(g.readable, true); assert.match(g.text, /## Sheet: Events/); assert.match(g.text, /Event \| \| Date/); assert.match(g.text, /Bake sale \| 42 \| June 5/);

	const odt = Buffer.from(zipSync({ 'content.xml': strToU8('<office:text><text:h>Welcome</text:h><text:p>All are <text:s/>welcome.</text:p></office:text>') }));
	g = await extractDocument('letter.odt', odt); assert.match(g.text, /Welcome\nAll are welcome\./);

	g = await extractDocument('news.pdf', pdfOf('Choir practice Thursday')); assert.equal(g.readable, true); assert.match(g.text, /Choir practice Thursday/);
	g = await extractDocument('memo.rtf', Buffer.from('{\\rtf1\\ansi {\\b Hello} church\\par Second line}')); assert.match(g.text, /Hello church\nSecond line/);

	g = await extractDocument('old.doc', Buffer.from('x')); assert.equal(g.readable, false); assert.match(g.note, /save it as \.docx/i);
	g = await extractDocument('broken.docx', Buffer.from('not a zip')); assert.equal(g.readable, false); assert.match(g.note, /Could not read/);
	g = await extractDocument('empty.txt', Buffer.from('   ')); assert.equal(g.readable, false);
});

test('30-day clean-up: warns once at 7 and 2 days, leaves live and kept sites alone, deletes only when switched on', async () => {
	const r = rig(); const c = await make(r);
	r.store.update(c.id, (x) => { x.prospect.expiresAt = r.clock.t + 6 * DAY; });
	await r.p.sweep(); await r.p.sweep(); assert.equal(r.mail.filter((m) => /deleted in 6 days/.test(m.subject)).length, 1);
	r.clock.t += 5 * DAY; await r.p.sweep(); assert.equal(r.mail.filter((m) => /deleted in 1 day/.test(m.subject)).length, 1);
	r.clock.t += 2 * DAY; const out = await r.p.sweep(); assert.equal(out.overdue, 1); assert.deepEqual(r.hostDeleted, [], 'automatic deletion is off by default'); assert.ok(r.store.get(c.id));
	r.p.extend(c.id, 7); assert.ok(r.store.get(c.id).prospect.expiresAt > r.clock.t + 6 * DAY && r.store.get(c.id).prospect.expiresAt <= r.clock.t + 7 * DAY + 1000); assert.equal(r.store.get(c.id).prospect.warned7, undefined);

	const g = rig({ autoDelete: true }); const d = await make(g); g.sites.push(d.slug);
	g.store.update(d.id, (x) => { x.prospect.expiresAt = g.clock.t - DAY; });
	const o2 = await g.p.sweep(); assert.equal(o2.deleted, 1); assert.deepEqual(g.hostDeleted, ['grace-united-church.churchwebglobal.com']); assert.equal(g.store.get(d.id), null);
	const h = rig({ autoDelete: true }); const e = await make(h);
	h.store.update(e.id, (x) => { x.prospect.expiresAt = h.clock.t - DAY; x.stages.golive = { done: true }; });
	await h.p.sweep(); assert.deepEqual(h.hostDeleted, [], 'a live site is never deleted'); assert.ok(h.store.get(e.id));
});

test('applyOxygenLicense uses Oxygen\'s licence manager, checks it took, never shows the key, and says what is missing', async () => {
	const calls = []; let stored = false;
	const ssh = { available: () => true, exec: async (cmd) => { calls.push(cmd); if (/test -f .*wp-config\.php/.test(cmd)) return { code: 0, out: 'FOUND', err: '' }; if (/changeLicenseKey/.test(cmd)) { stored = true; return { code: 0, out: '', err: '' }; } if (/getStoredLicenseKeyValidityInfo/.test(cmd)) return { code: 0, out: stored ? 'HAS:valid' : 'NONE:', err: '' }; return { code: 0, out: '', err: '' }; } };
	const mk = (key) => ({ c: { cfg: { oxygenLicense: key, previewDomain: 'churchwebglobal.com', siteRoot: '$HOME/domains/{host}/public_html', wpCli: 'wp' }, ssh }, memo: {} });
	const ch = { slug: 'grace', domain: '' };
	assert.equal((await applyOxygenLicense(mk(''), ch)).state, 'unknown');
	const r = await applyOxygenLicense(mk("SECRET'KEY123"), ch);
	assert.equal(r.state, 'ok'); assert.ok(calls.some((c) => /LicenseKeyManager::getInstance\(\)->changeLicenseKey\(/.test(c))); assert.ok(!calls.some((c) => /OXYGEN_LICENSE_KEY/.test(c)), 'no wp-config constant any more'); assert.doesNotMatch(JSON.stringify(r), /SECRET/);
	const n = calls.length; assert.equal((await applyOxygenLicense(mk('SECRETKEY123'), ch)).state, 'ok'); assert.ok(!calls.slice(n).some((c) => /changeLicenseKey/.test(c)), 'already licensed: not changed again');
	stored = false; const ssh2 = { ...ssh, exec: async (cmd) => /getStoredLicenseKeyValidityInfo/.test(cmd) ? { code: 0, out: 'HAS:invalid', err: '' } : ssh.exec(cmd) };
	const bad = await applyOxygenLicense({ c: { cfg: { oxygenLicense: 'K', previewDomain: 'churchwebglobal.com', siteRoot: '$HOME/domains/{host}/public_html', wpCli: 'wp' }, ssh: ssh2 }, memo: {} }, ch);
	assert.equal(bad.state, 'error'); assert.match(bad.detail, /did not activate it \(it says: invalid\)/);
});

async function readyRig(o = {}) {
	const r = rig({ cwai: true, ...o }); const c = await make(r); r.p.start(c.id);
	r.job.status = 'done'; for (let i = 0; i < 4; i++) await r.p.tick(c.id);
	r.p.reportBuild(c.id, { state: 'done', message: 'Built.' });
	return { r, c };
}

test('extend: +7 days at a time, from the current end, never past 30 days from today', async () => {
	const { r, c } = await readyRig();
	r.store.update(c.id, (x) => { x.prospect.expiresAt = r.clock.t + 3 * DAY; });
	let v = r.p.view(r.p.extend(c.id)); assert.equal(v.daysLeft, 10);
	r.p.extend(c.id, 7); r.p.extend(c.id, 7); assert.equal(r.p.view(r.store.get(c.id)).daysLeft, 24);
	v = r.p.view(r.p.extend(c.id, 7)); assert.equal(v.daysLeft, 30, 'capped at 30 days from today');
	assert.throws(() => r.p.extend(c.id), /most it can have/);
	r.store.update(c.id, (x) => { x.prospect.expiresAt = r.clock.t - 2 * DAY; });
	assert.equal(r.p.view(r.p.extend(c.id)).daysLeft, 7, 'an overdue preview restarts from today');
});

test('delete from the dashboard removes the Hostinger site and the record; live sites are refused', async () => {
	const { r, c } = await readyRig();
	assert.equal(r.p.view(r.store.get(c.id)).canDelete, true);
	await r.p.remove(c.id); assert.deepEqual(r.hostDeleted, ['grace-united-church.churchwebglobal.com']); assert.equal(r.store.get(c.id), null);
	const g = await readyRig(); g.r.store.update(g.c.id, (x) => { x.stages.golive = { done: true }; });
	assert.equal(g.r.p.view(g.r.store.get(g.c.id)).canDelete, false);
	await assert.rejects(() => g.r.p.remove(g.c.id), /live or is a template/); assert.ok(g.r.store.get(g.c.id));
});

test('switch to the full site: same site, fresh full export, the build adds the rest in the same design', async () => {
	const { r, c } = await readyRig();
	let v = r.p.view(r.store.get(c.id)); assert.equal(v.canFull, true); assert.equal(v.mode, 'preview');
	const buildsBefore = r.bg.length, fixesBefore = r.calls.fix.length;
	r.p.switchToFull(c.id);
	v = r.p.view(r.store.get(c.id)); assert.equal(v.mode, 'full'); assert.equal(v.canFull, false); assert.equal(v.stages[2].state, 'done', 'the site is kept'); assert.equal(v.stages[1].state, 'waiting'); assert.equal(v.zipReady, false);
	await r.p.tick(c.id); assert.equal(r.calls.enqueue.at(-1).preview, false, 'a full export is queued'); r.job.status = 'done'; await r.p.tick(c.id);
	await r.p.tick(c.id); await r.p.tick(c.id);
	assert.equal(r.calls.fix.length, fixesBefore, 'no new site is made'); assert.equal(r.bg.length, buildsBefore + 1); assert.match(r.bg.at(-1), /--mode=full/); assert.match(r.bg.at(-1), /--package=/);
	const brief = r.p.briefFor(r.store.get(c.id)); assert.match(brief, /Keep that design/); assert.match(brief, /Build every page/);
	assert.throws(() => r.p.switchToFull(c.id), /already set to the full site/);
	const p = await readyRig(); p.r.store.update(p.c.id, (x) => { x.run.state = 'running'; });
	assert.throws(() => p.r.p.switchToFull(p.c.id), /Wait for the current step/);
});

test('one-click WP-Admin link: asks the site for it, only accepts a link for that site', async () => {
	const { r, c } = await readyRig();
	assert.equal(r.p.view(r.store.get(c.id)).canLogin, true);
	const out = await r.p.adminLink(c.id); assert.match(out.url, /^https:\/\/grace-united-church\.churchwebglobal\.com\/\?cwai_login=a{64}$/); assert.ok(r.wp.includes('cwai portal-login'));
	r.loginResult.out = 'https://evil.example/?cwai_login=' + 'b'.repeat(64);
	await assert.rejects(() => r.p.adminLink(c.id), /different address/);
	r.loginResult.code = 1; r.loginResult.out = ''; r.loginResult.err = "Error: 'portal-login' is not a registered wp command.";
	await assert.rejects(() => r.p.adminLink(c.id), /1\.12\.0/);
	const n = rig(); const d = await make(n); await assert.rejects(() => n.p.adminLink(d.id), /not ready/);
});

test('Hostinger plugins are removed last, after the build, and never hold the run up', async () => {
	const r = rig({ cwai: true }); const c = await make(r); r.p.start(c.id);
	r.job.status = 'done'; for (let i = 0; i < 4; i++) await r.p.tick(c.id);
	assert.equal(r.calls.cleanup, undefined, 'not removed while the site is being built');
	assert.equal(r.store.get(c.id).run.steps.site.state, 'done');
	r.p.reportBuild(c.id, { state: 'done', message: 'Built.' });
	await new Promise((x) => setTimeout(x, 20));
	assert.equal(r.calls.cleanup, 1); assert.equal(r.store.get(c.id).run.cleanup.state, 'done'); assert.equal(r.store.get(c.id).run.state, 'done');
	await r.p.tickAll(); assert.equal(r.calls.cleanup, 1, 'only once');
});

test('stop & restart: a build that is running or stuck is stopped on the site and started again from scratch', async () => {
	const { r, c } = await (async () => { const r = rig({ cwai: true }); const c = await make(r); r.p.start(c.id); r.job.status = 'done'; for (let i = 0; i < 4; i++) await r.p.tick(c.id); return { r, c }; })();
	assert.equal(r.store.get(c.id).run.steps.build.state, 'working'); assert.equal(r.p.view(r.store.get(c.id)).canRestart, true);
	const before = r.bg.length;
	await r.p.restartBuild(c.id);
	assert.equal(r.store.get(c.id).run.steps.build.state, 'waiting'); assert.equal(r.store.get(c.id).run.state, 'running');
	await r.p.tick(c.id); assert.equal(r.bg.length, before + 1); assert.match(r.bg.at(-1), /--package=/); assert.equal(r.store.get(c.id).run.steps.build.state, 'working');
	r.p.reportBuild(c.id, { state: 'done', message: 'ok' });
	assert.equal(r.p.view(r.store.get(c.id)).canRestart, false);
	await assert.rejects(() => r.p.restartBuild(c.id), /no build to restart/);
});

test('a silent build is asked directly: the site\'s own saved state shows the real error even if its messages never arrive', async () => {
	const r = rig({ cwai: true }); const c = await make(r); r.p.start(c.id);
	r.job.status = 'done'; for (let i = 0; i < 4; i++) await r.p.tick(c.id);
	assert.equal(r.store.get(c.id).run.steps.build.state, 'working');
	await r.p.tick(c.id); assert.equal(r.store.get(c.id).run.steps.build.state, 'working', 'not asked straight away');
	r.clock.t += 90000;
	Object.assign(r.optionResult, { code: 0, out: JSON.stringify({ state: 'failed', message: 'The portal did not send the package (HTTP 403).', updated: Math.floor(r.clock.t / 1000) }) });
	await r.p.tick(c.id);
	const b = r.store.get(c.id).run.steps.build; assert.equal(b.state, 'failed'); assert.match(b.message, /HTTP 403/); assert.equal(r.store.get(c.id).run.state, 'failed');
	// stale state from an earlier run is ignored
	r.p.start(c.id); await r.p.tick(c.id); r.clock.t += 90000;
	Object.assign(r.optionResult, { out: JSON.stringify({ state: 'failed', message: 'old', updated: Math.floor((r.clock.t - 3600000) / 1000) }) });
	await r.p.tick(c.id); assert.notEqual(r.store.get(c.id).run.steps.build.message, 'old');
});

test('the ZIP and the brief are put on the site over SSH, the build imports them from there, and the site is polled for questions', async () => {
	const puts = [], ssh = { available: () => true, exec: async (cmd, o = {}) => {
		if (/^echo \$HOME/.test(cmd)) return { code: 0, out: '/home/u1\n', err: '' };
		const m = /cat > '([^']+)'/.exec(cmd); if (m) { puts.push({ to: m[1], bytes: o.input.length }); return { code: 0, out: String(o.input.length), err: '' }; }
		return { code: 0, out: '', err: '' };
	} };
	const r = rig({ cwai: true, ssh }); const c = await make(r); r.p.start(c.id);
	r.job.status = 'done'; for (let i = 0; i < 4; i++) await r.p.tick(c.id);
	assert.deepEqual(puts.map((p) => p.to), ['/home/u1/cwai-portal/grace-united-church/package.zip', '/home/u1/cwai-portal/grace-united-church/brief.md']); assert.equal(puts[0].bytes, 3);
	assert.match(r.bg[0], /--package='\/home\/u1\/cwai-portal\/grace-united-church\/package\.zip'/); assert.match(r.bg[0], /--brief='\/home\/u1\/cwai-portal\/grace-united-church\/brief\.md'/); assert.doesNotMatch(r.bg[0], /https:\/\/portal\.test\/api\/build\/[^/]+\/package/);
	// the site asks a question, but its message to the portal never arrives: the portal finds it by asking the site
	r.clock.t += 20000;
	Object.assign(r.optionResult, { code: 0, out: JSON.stringify({ state: 'question', message: 'The AI needs an answer to carry on.', question: { text: 'Which logo?', options: ['A', 'B'] }, updated: Math.floor(r.clock.t / 1000) }) });
	await r.p.tick(c.id);
	const ch = r.store.get(c.id); assert.equal(ch.run.state, 'needs_input'); assert.equal(r.p.view(ch).question.text, 'Which logo?'); assert.deepEqual(r.p.view(ch).question.options, ['A', 'B']);
	// a failed copy is a plain failure, not a hang
	const bad = rig({ cwai: true, ssh: { available: () => true, exec: async (cmd) => (/^echo/.test(cmd) ? { code: 0, out: '/home/u1', err: '' } : { code: 1, out: '', err: 'No space left on device' }) } }); const d = await make(bad); bad.p.start(d.id);
	bad.job.status = 'done'; for (let i = 0; i < 4; i++) await bad.p.tick(d.id);
	assert.equal(bad.store.get(d.id).run.steps.build.state, 'failed'); assert.match(bad.store.get(d.id).run.steps.build.message, /Could not copy package\.zip/);
});

test('pricing: cache tokens are priced, an earlier reading is subtracted, unknown models are flagged', () => {
	const t = priceTable('');
	const now = { 'claude-sonnet-5-5': { req: 25, tin: 1500000, tout: 100000, cr: 10000000, cw: 2000000, img: 0 }, 'claude-haiku-5-5': { req: 4, tin: 1000000, tout: 200000, cr: 0, cw: 0, img: 0 } };
	const base = { 'claude-sonnet-5-5': { req: 5, tin: 500000, tout: 0, cr: 0, cw: 0, img: 0 } };
	const r = priceDelta(now, base, t);
	assert.equal(r.usd, 9.2); assert.equal(r.calls, 24); assert.equal(r.estimated, true, 'Haiku is priced at its lower rate, so the total is a floor');
	assert.deepEqual(r.tokens, { input: 2000000, output: 300000, cacheWrite: 2000000, cacheRead: 10000000 });
	assert.equal(priceDelta({ 'mystery-model': { req: 1, tin: 1000000, tout: 0, cr: 0, cw: 0, img: 0 } }, {}, t).estimated, true);
	assert.equal(priceDelta(base, now, t).usd, 0, 'a counter that went backwards never gives a negative cost');
	assert.equal(priceTable('{"x":{"in":1,"out":2}}').x.cw, 1.25); assert.equal(priceTable('not json')['claude-sonnet-5-5'].out, 10);
	assert.deepEqual(snapshot([{ site: 'a', model: 'm', req: 1, tin: 2, tout: 3, cr: 4, cw: 5, img: 0 }, { site: 'b', model: 'm', req: 9, tin: 9, tout: 9, cr: 9, cw: 9, img: 9 }], 'a'), { m: { req: 1, tin: 2, tout: 3, cr: 4, cw: 5, img: 0 } });
});

test('AI cost: a job costs what the gateway counted since it started, survives deletion in the averages, and a full build is its own job', async () => {
	const rows = [{ site: 'grace-united-church', model: 'claude-sonnet-5-5', req: 5, tin: 500000, tout: 0, cr: 0, cw: 0, img: 0 }]; // an earlier site with the same name
	const gw = { available: () => true, usageDetail: async () => ({ sites: rows.map((x) => ({ ...x })) }) };
	const r = rig({ cwai: true, gw }); const c = await make(r); r.p.start(c.id);
	r.job.status = 'done'; for (let i = 0; i < 8 && !r.store.get(c.id).run.buildStartedAt; i++) await r.p.tick(c.id);
	assert.ok(r.store.get(c.id).prospect.cost.preview.base['claude-sonnet-5-5'], 'a reading was taken before the build started');
	assert.equal(r.p.view(r.store.get(c.id)).cost.preview.usd, 0);
	rows[0] = { ...rows[0], req: 25, tin: 1500000, tout: 100000, cr: 10000000, cw: 2000000 };
	await r.p.costRefresh(c.id, true);
	let v = r.p.view(r.store.get(c.id)).cost; assert.equal(v.preview.usd, 9); assert.equal(v.preview.state, 'running'); assert.equal(v.preview.calls, 20);
	r.p.reportBuild(c.id, { state: 'done', message: 'Built.' }); for (let i = 0; i < 20 && r.p.view(r.store.get(c.id)).cost.preview.state !== 'final'; i++) await new Promise((x) => setTimeout(x, 10));
	assert.equal(r.p.view(r.store.get(c.id)).cost.preview.state, 'final');
	rows[0] = { ...rows[0], tin: 9e9 }; await r.p.costRefresh(c.id); assert.equal(r.p.view(r.store.get(c.id)).cost.preview.usd, 9, 'a closed job stops counting');
	// the full build is a separate job with its own starting reading
	r.p.switchToFull(c.id); r.job.status = 'done'; for (let i = 0; i < 8 && !r.store.get(c.id).prospect.cost.full; i++) await r.p.tick(c.id);
	assert.ok(r.store.get(c.id).prospect.cost.full.base); assert.equal(r.p.view(r.store.get(c.id)).cost.preview.usd, 9);
	// delete: the figures stay in the averages
	await r.p.remove(c.id);
	const sum = r.p.costSummary(); assert.equal(sum.preview.n, 1); assert.equal(sum.preview.avg, 9); assert.equal(sum.total, 9);
});

test('AI cost: if the gateway cannot give a reading the build still runs and the screen says why', async () => {
	const gw = { available: () => true, usageDetail: async () => { throw new Error('Gateway: the live gateway does not have the usage-detail endpoint yet: deploy the new cwai-gateway.zip'); } };
	const r = rig({ cwai: true, gw }); const c = await make(r); r.p.start(c.id);
	r.job.status = 'done'; for (let i = 0; i < 8 && !r.store.get(c.id).run.buildStartedAt; i++) await r.p.tick(c.id);
	assert.ok(r.store.get(c.id).run.buildStartedAt, 'the build started anyway');
	const v = r.p.view(r.store.get(c.id)).cost; assert.equal(v.preview.state, 'unavailable'); assert.match(v.preview.note, /deploy the new cwai-gateway\.zip/);
	const q = rig(); const cc = await make(q); assert.equal(q.p.view(q.store.get(cc.id)).cost.tracked, false, 'without a gateway key nothing is tracked');
});

test('licence: the dashboard can apply the Oxygen licence to an existing site, and says what went wrong', async () => {
	const { r, c } = await readyRig();
	assert.deepEqual(await r.p.licence(c.id), { state: 'ok', detail: 'Added the Oxygen licence key to the site.' });
	r.engine.applyOxygenLicense = async () => ({ state: 'error', detail: 'The key was saved but Oxygen did not activate it (it says: invalid).' });
	const bad = await r.p.licence(c.id); assert.equal(bad.state, 'error'); assert.match(bad.detail, /invalid/);
	await assert.rejects(() => r.p.licence('nope'), /Not a prospect/);
});

test('guard: a name already used by a Hostinger site is never reused, and a site we did not create is never built over', async () => {
	const r = rig({ extra: ['grace-united-church.churchwebglobal.com'] });
	const c = await make(r); assert.equal(c.slug, 'grace-united-church-2', 'the taken address is skipped');
	// the same thing if the site appears after the prospect was made: the first pass stops before changing anything
	const r2 = rig(); const d = await make(r2);
	r2.engine.testStage = async () => ({ site: { state: 'ok' }, oxygen: { state: 'no' } });
	r2.engine.reqsFor = (s) => s.reqs;
	r2.p.start(d.id); await r2.p.tick(d.id); r2.job.status = 'done'; await r2.p.tick(d.id); await r2.p.tick(d.id);
	const v = r2.p.view(r2.store.get(d.id));
	assert.equal(r2.calls.fix.length, 0, 'nothing was fixed or installed'); assert.equal(v.runState, 'failed'); assert.match(v.headline, /already exists/);
});
