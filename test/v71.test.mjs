import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgliteDb, migrate } from '../portal/db.mjs';
import { parseCsv, toRecords, createDirectory } from '../portal/directory.mjs';
import { createAudit } from '../portal/auth.mjs';
import { createLoops, verifyLoopsWebhook } from '../portal/loops.mjs';
import { createOutreach } from '../portal/outreach.mjs';
import { createAssistant } from '../portal/assistant.mjs';
import { STAGES, kindOf, reqsFor, stageSkipped, blockedBy } from '../deploy/checks.mjs';
import { createStore } from '../deploy/store.mjs';

const fresh = async () => { const db = pgliteDb(new PGlite()); await migrate(db); return db; };

/* ---------------------------------------------------------------- customer types */
test('customer types: new sites and DUDA migrations get different stages and tasks', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v71-')); const store = createStore(dir);
	const n = store.create({ name: 'Grace United' }), m = store.create({ name: 'Hope United', kind: 'migration' });
	assert.equal(n.kind, 'new'); assert.equal(m.kind, 'migration');
	assert.equal(kindOf({}), 'new', 'older records count as new sites');
	const sales = STAGES.find((s) => s.key === 'sales'), migrate = STAGES.find((s) => s.key === 'migrate'), handover = STAGES.find((s) => s.key === 'handover');
	assert.equal(stageSkipped(sales, n), false); assert.equal(stageSkipped(sales, m), true);
	assert.equal(stageSkipped(migrate, n), true); assert.equal(stageSkipped(migrate, m), false);
	assert.ok(reqsFor(handover, m).some((q) => q.id === 'dudaRetire')); assert.ok(!reqsFor(handover, n).some((q) => q.id === 'dudaRetire'));
	assert.ok(blockedBy(n, migrate).includes('kind'), 'a new site is told the stage does not apply');
	assert.deepEqual(STAGES.map((s) => s.key).slice(0, 2), ['sales', 'dnscheck'], 'the prospect stage comes first');
});

/* ---------------------------------------------------------------- Loops client + webhook signature */
const sign = (secret, id, ts, body) => 'v1,' + crypto.createHmac('sha256', Buffer.from(secret.replace('whsec_', ''), 'base64')).update(`${id}.${ts}.${body}`).digest('base64');

test('Loops webhooks: valid signature passes; tampering, old timestamps and wrong secret fail', () => {
	const secret = 'whsec_' + crypto.randomBytes(24).toString('base64'), id = 'msg_1', body = '{"eventName":"email.delivered"}', now = 1_800_000_000_000, ts = String(Math.floor(now / 1000));
	const ok = { secret, id, timestamp: ts, signature: sign(secret, id, ts, body), rawBody: body, now };
	assert.ok(verifyLoopsWebhook(ok));
	assert.ok(verifyLoopsWebhook({ ...ok, signature: 'v1,AAAA ' + ok.signature }), 'any of several signatures may match');
	assert.equal(verifyLoopsWebhook({ ...ok, rawBody: body + ' ' }), false);
	assert.equal(verifyLoopsWebhook({ ...ok, now: now + 10 * 60 * 1000 }), false);
	assert.equal(verifyLoopsWebhook({ ...ok, secret: 'whsec_' + crypto.randomBytes(24).toString('base64') }), false);
	assert.equal(verifyLoopsWebhook({ ...ok, secret: '' }), false);
});

test('Loops client: updates a contact that already exists, and reports a bad key', async () => {
	const seen = [];
	const f = async (url, o) => { seen.push(`${o.method} ${url.replace('https://app.loops.so/api/v1', '')}`); const code = url.endsWith('/contacts/create') ? 409 : 200; return { ok: code < 300, status: code, json: async () => ({ success: code < 300, message: 'exists' }) }; };
	const l = createLoops({ apiKey: 'k', fetchImpl: f });
	assert.deepEqual(await l.upsertContact({ email: 'a@b.ca' }), { ok: true, created: false }); assert.deepEqual(seen, ['POST /contacts/create', 'PUT /contacts/update']);
	assert.equal(createLoops({}).available(), false);
	const bad = createLoops({ apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
	assert.match((await bad.ping()).message, /rejected/);
});

/* ---------------------------------------------------------------- outreach */
const CSV = `Name,Type,Address,City,Province,Postal Code,Phone,Email,Website
Alpha United Church,Congregation,1 Main,Toronto,ON,M1M1M1,,alpha@alpha.ca,alpha.ca
Beta United Church,Congregation,2 Main,Ottawa,ON,K1K1K1,,beta@beta.ca,
Gamma United Church,Congregation,3 Main,Hamilton,ON,L1L1L1,,beta@beta.ca,
Delta United Church,Congregation,4 Main,Halifax,NS,B1B1B1,,,delta.ca
Echo United Church,Congregation,5 Main,Calgary,AB,T1T1T1,,echo@echo.ca,
Foxtrot United Church,Congregation,6 Main,Regina,SK,S1S1S1,,not-an-email,
`;
async function outreachEnv({ cap = 25, fail = false } = {}) {
	const db = await fresh(), dir = createDirectory(db); await dir.import(toRecords(parseCsv(CSV)));
	const sent = [], loops = { available: () => true, upsertContact: async (p) => (fail ? { ok: false, message: 'boom' } : { ok: true }), sendEvent: async (email, ev, props, key) => { sent.push({ email, ev, props, key }); return { ok: true }; } };
	const outreach = createOutreach({ db, dir, loops, audit: createAudit(db), dailyCap: cap, paceMs: 0 });
	return { db, dir, outreach, sent };
}

test('outreach preview leaves out customers, missing/invalid emails, duplicate addresses, and anyone suppressed', async () => {
	const { dir, outreach, db } = await outreachEnv();
	let pv = await outreach.preview({}, 'intro-1');
	assert.equal(pv.eligible, 3, 'alpha, beta (once, shared by gamma) and echo');
	await dir.addCustomerDomains('echo.ca', 'manual'); pv = await outreach.preview({}, 'intro-1'); assert.equal(pv.eligible, 2, 'a customer is never emailed');
	await outreach.suppress('alpha@alpha.ca', 'bounced'); pv = await outreach.preview({}, 'intro-1'); assert.equal(pv.eligible, 1);
	assert.equal((await db.query("select outreach_status from directory where email = 'alpha@alpha.ca'"))[0].outreach_status, 'do not contact');
});

test('outreach send needs the exact confirmed count, respects the daily cap and the repeat window', async () => {
	const { outreach, sent, db } = await outreachEnv({ cap: 2 });
	await assert.rejects(outreach.send({ filters: {}, campaign: 'intro-1', expect: 3, user: { email: 'r@x.ca' } }), /list changed: 2 would be sent/);
	await assert.rejects(outreach.send({ filters: {}, campaign: 'Bad Name', expect: 2, user: {} }), /Campaign name/);
	const r = await outreach.send({ filters: {}, campaign: 'intro-1', expect: 2, user: { email: 'r@x.ca' } }); assert.equal(r.started, 2); assert.deepEqual(await r.done, { sent: 2, failed: 0 });
	assert.equal(sent.length, 2); assert.equal(sent[0].ev, 'prospect_outreach'); assert.match(sent[0].key, /^intro-1-\d+-\d{4}-/);
	assert.equal((await db.query("select count(*)::int as n from directory where outreach_status = 'contacted'"))[0].n >= 2, true);
	await assert.rejects(outreach.send({ filters: {}, campaign: 'intro-1', expect: 1, user: {} }), /limit \(2\) has been reached/);
	assert.equal((await outreach.stats()).sentToday, 2);
});

test('outreach: the same campaign is not repeated inside the window, a different one is allowed, and failures are logged', async () => {
	const a = await outreachEnv({ cap: 50 });
	await (await a.outreach.send({ filters: {}, campaign: 'intro-1', expect: 3, user: {} })).done;
	assert.equal((await a.outreach.preview({}, 'intro-1')).eligible, 0, 'already emailed');
	assert.equal((await a.outreach.preview({}, 'follow-up')).eligible, 3, 'a new campaign may go to them again (their status is contacted, which is still allowed)');
	const b = await outreachEnv({ fail: true });
	const r = await b.outreach.send({ filters: {}, campaign: 'intro-1', expect: 3, user: {} }); assert.deepEqual(await r.done, { sent: 0, failed: 3 });
	assert.equal((await b.db.query('select count(*)::int as n from outreach_log where not ok'))[0].n, 3);
	assert.equal((await b.outreach.preview({}, 'intro-1')).eligible, 3, 'failed sends can be retried');
	await assert.rejects(createOutreach({ db: a.db, dir: a.dir, loops: { available: () => false }, audit: createAudit(a.db) }).send({ filters: {}, campaign: 'x-y-z', expect: 1, user: {} }), /not set up/);
});

test('Loops events: unsubscribes and bounces go on the do-not-contact list, repeats are ignored, opens are counted', async () => {
	const { outreach, db } = await outreachEnv();
	const ev = (name, email) => ({ eventName: name, contactIdentity: { email } });
	assert.deepEqual(await outreach.handleEvent('w1', ev('email.opened', 'beta@beta.ca')), { recorded: 'email.opened' });
	assert.deepEqual(await outreach.handleEvent('w1', ev('email.opened', 'beta@beta.ca')), { duplicate: true });
	assert.deepEqual(await outreach.handleEvent('w2', ev('email.hardBounced', 'Beta@Beta.ca')), { suppressed: 'beta@beta.ca' });
	await outreach.handleEvent('w3', ev('contact.unsubscribed', 'echo@echo.ca'));
	assert.equal((await outreach.preview({}, 'intro-1')).eligible, 1, 'only alpha is left');
	const s = await outreach.stats(); assert.equal(s.opened, 1); assert.equal(s.suppressed, 2); assert.equal(s.bounced, 1); assert.equal(s.unsubscribed, 1);
	assert.equal((await db.query("select count(*)::int as n from directory where outreach_status = 'do not contact'"))[0].n, 3, 'beta and gamma share an address, plus echo');
});

/* ---------------------------------------------------------------- assistant */
function scripted(replies) { const calls = []; const f = async (url, o) => { const body = JSON.parse(o.body); calls.push(body); const next = replies.shift(); return { ok: true, status: 200, json: async () => ({ content: next }) }; }; f.calls = calls; return f; }
const TOOLS = (log) => [
	{ name: 'look', kind: 'read', description: 'd', input_schema: { type: 'object', properties: {} }, run: async () => ({ answer: 42 }) },
	{ name: 'change', kind: 'write', description: 'd', input_schema: { type: 'object', properties: {} }, summary: (i) => `Change ${i.what}`, run: async (i) => { log.push(i.what); return { ok: true, forModel: 'Changed ' + i.what, display: [{ title: 'Shown once', lines: ['s3cret'] }] }; } },
];
const clients = { gateway: { available: () => false }, cfg: {} };
const user = { email: 'chad@x.ca', name: 'Chad', role: 'staff' };
const mk = async (replies, log = []) => { const db = await fresh(); const f = scripted(replies); return { a: createAssistant({ tools: TOOLS(log), audit: createAudit(db), clients, env: { ANTHROPIC_API_KEY: 'k' }, fetchImpl: f }), f, db, log }; };

test('assistant: read tools run by themselves and feed the answer', async () => {
	const { a, f } = await mk([[{ type: 'tool_use', id: 't1', name: 'look', input: {} }], [{ type: 'text', text: 'It is 42.' }]]);
	const r = await a.chat(user, [{ role: 'user', content: 'what is it' }]);
	assert.equal(r.text, 'It is 42.'); assert.equal(r.pending, undefined);
	assert.match(JSON.stringify(f.calls[1].messages.at(-1)), /42/);
	assert.match(f.calls[0].system, /Chad/); assert.equal(f.calls[0].tools.length, 2);
});

test('assistant: a change waits for approval, runs only what was proposed, shows the secret only to the person, and is audited', async () => {
	const log = [], { a, f, db } = await mk([[{ type: 'text', text: 'Proposing.' }, { type: 'tool_use', id: 'w1', name: 'change', input: { what: 'mailbox' } }], [{ type: 'text', text: 'Done.' }]], log);
	const r = await a.chat(user, [{ role: 'user', content: 'do it' }]);
	assert.equal(log.length, 0, 'nothing ran yet'); assert.equal(r.pending.actions[0].summary, 'Change mailbox');
	await assert.rejects(a.resolve({ ...user, email: 'wayne@x.ca' }, { groupId: r.pending.groupId, decisions: { w1: true }, messages: r.messages }), /expired/, 'another person cannot approve it');
	const out = await a.resolve(user, { groupId: r.pending.groupId, decisions: { w1: true }, messages: r.messages });
	assert.deepEqual(log, ['mailbox']); assert.equal(out.text, 'Done.'); assert.equal(out.display[0].lines[0], 's3cret');
	assert.ok(!JSON.stringify(f.calls[1]).includes('s3cret'), 'the model never sees the secret');
	assert.equal((await db.query("select count(*)::int as n from audit_log where action = 'assistant.change'"))[0].n, 1);
	await assert.rejects(a.resolve(user, { groupId: r.pending.groupId, decisions: { w1: true }, messages: r.messages }), /expired/, 'approval works once');
});

test('assistant: declining does nothing and tells the model so; forged tool names are ignored', async () => {
	const log = [], { a, f } = await mk([[{ type: 'tool_use', id: 'w1', name: 'change', input: { what: 'x' } }, { type: 'tool_use', id: 'r1', name: 'nope', input: {} }], [{ type: 'text', text: 'OK, not doing it.' }]], log);
	const r = await a.chat(user, [{ role: 'user', content: 'go' }]);
	const out = await a.resolve(user, { groupId: r.pending.groupId, decisions: { w1: false }, messages: r.messages });
	assert.equal(log.length, 0); assert.match(JSON.stringify(f.calls[1].messages.at(-1)), /declined/); assert.match(JSON.stringify(f.calls[1].messages.at(-1)), /Unknown tool/);
	assert.equal(out.text, 'OK, not doing it.');
});

test('assistant: history is cleaned (no orphaned tool results, bad parts rejected) and questions are rate limited', async () => {
	const { a } = await mk(Array.from({ length: 50 }, () => [{ type: 'text', text: 'ok' }]));
	await assert.rejects(a.chat(user, [{ role: 'user', content: [{ type: 'image', source: 'x' }] }]), /Bad message part/);
	await assert.rejects(a.chat(user, []), /Nothing to answer/);
	const r = await a.chat(user, [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old', content: 'x' }] }, { role: 'assistant', content: 'hi' }, { role: 'user', content: 'real question' }]);
	assert.equal(r.messages[0].content, 'real question');
	let err; for (let i = 0; i < 45 && !err; i++) { try { await a.chat(user, [{ role: 'user', content: 'q' }]); } catch (e) { err = e; } }
	assert.match(err.message, /lot of questions/);
	const off = createAssistant({ tools: [], audit: {}, clients, env: {}, fetchImpl: async () => ({}) });
	await assert.rejects(off.chat(user, [{ role: 'user', content: 'hi' }]), /not set up/);
});

/* ---------------------------------------------------------------- hosted domains */
import { createHosted } from '../portal/hosted.mjs';
import { makeSmarterMail } from '../deploy/smartermail.mjs';
import { buildTools } from '../portal/assistantTools.mjs';

const DIRCSV = `Name,Type,Address,City,Province,Postal Code,Phone,Email,Website
Erindale United Church,Congregation,1 Main,Mississauga,ON,L5L1L1,,office@erindaleunited.church,https://www.erindaleunited.church
Other United Church,Congregation,2 Main,Ottawa,ON,K1K1K1,,info@otherchurch.ca,otherchurch.ca
`;
const fakeDuda = (sites) => ({ available: () => true, call: async (name, a) => name === 'list_sites' ? JSON.stringify({ results: sites.map((s) => ({ site_name: s.n, publish_status: s.pub ? 'PUBLISHED' : 'NOT_PUBLISHED_YET' })), has_more: false }) : `Domain Information:\n{\n  "site_domain": "${sites.find((s) => s.n === a.site_name).d}",\n  "site_name": "${a.site_name}"\n}` });
async function hostedEnv({ cf = ['erindaleunited.church', 'zoneonly.org', 'churchwebglobal.com'], mail = ['erindaleunited.church', 'mailonly.ca'], cfFails = false, dudaSites } = {}) {
	const db = await fresh(), dir = createDirectory(db); await dir.import(toRecords(parseCsv(DIRCSV)));
	const clients = {
		cloudflare: { available: () => true, zones: async () => { if (cfFails) throw new Error('Cloudflare: token cannot access this account'); return cf.map((name) => ({ id: 'z' + name, name, status: 'active' })); } },
		smartermail: { available: () => true, sysLogin: async () => 'tok', domains: async () => ({ ok: true, domains: mail }) },
		hostinger: { available: () => true, websites: async () => [{ domain: 'grace.churchwebglobal.com', username: 'u1' }], parkedDomains: async () => ['www.erindaleunited.church'] },
	};
	const duda = fakeDuda(dudaSites || [{ n: 'aaa', pub: true, d: 'www.erindaleunited.church' }, { n: 'bbb', pub: false, d: '' }, { n: 'ccc', pub: true, d: 'dudaonly.ca' }]);
	const hosted = createHosted({ db, clients, duda, dir, ownDomains: ['churchwebsupport.com'], log: () => {} });
	return { db, dir, hosted };
}

test('hosted sync: merges the four sources per domain, leaves out our own domains, and marks directory churches as customers', async () => {
	const { hosted, dir, db } = await hostedEnv();
	const res = await hosted.sync();
	assert.deepEqual(Object.fromEntries(Object.entries(res).map(([k, v]) => [k, v.ok])), { cloudflare: true, duda: true, smartermail: true, hostinger: true });
	const l = await hosted.lookup('www.ErindaleUnited.church');
	assert.deepEqual(l.hosted, { cloudflare: 'yes (active)', duda: 'yes (site aaa)', smartermail: 'yes', hostinger: 'yes (grace.churchwebglobal.com)' });
	assert.equal(l.directory_listings[0].name, 'Erindale United Church'); assert.equal(l.directory_listings[0].is_customer, true);
	const all = (await hosted.list({})).rows.map((r) => r.domain);
	assert.ok(!all.some((d) => d.endsWith('churchwebglobal.com')), 'our own domains and preview sites are not customers'); assert.ok(all.includes('zoneonly.org') && all.includes('dudaonly.ca') && all.includes('mailonly.ca'));
	assert.deepEqual((await hosted.list({ gap: 'duda-not-cloudflare' })).rows.map((r) => r.domain), ['dudaonly.ca']);
	assert.deepEqual((await hosted.list({ gap: 'mail-not-cloudflare' })).rows.map((r) => r.domain), ['mailonly.ca']);
	assert.equal((await dir.list({ customer: 'yes' })).rows.length, 1, 'only Erindale matches; the other church is not hosted by us');
	assert.equal((await db.query("select count(*)::int as n from customer_domains where source = 'sync'"))[0].n, all.length);
	const unknown = await hosted.lookup('nothostedhere.org'); assert.equal(unknown.hosted, null); assert.match(unknown.note, /Not found in the last sync/);
});

test('hosted sync: a failing source is reported and never wipes what the others found; a later sync removes domains that left', async () => {
	const { hosted, db } = await hostedEnv();
	await hosted.sync();
	const again = await hostedEnv({ cfFails: true }); // fresh db: Cloudflare failing from the start
	const r = await again.hosted.sync();
	assert.equal(r.cloudflare.ok, false); assert.match(r.cloudflare.error, /cannot access/); assert.equal(r.duda.ok, true);
	assert.equal((await again.hosted.lookup('erindaleunited.church')).hosted.cloudflare, 'no');
	const st = await again.hosted.status(); assert.equal(st.sources.cloudflare.ok, false); assert.equal(st.running, false);
	// a domain that disappears from every source is dropped on the next sync
	await db.query("insert into hosted_domains (domain, in_cloudflare) values ('stale.org', true)");
	await hosted.sync(); assert.equal((await db.query("select count(*)::int as n from hosted_domains where domain = 'stale.org'"))[0].n, 0);
});

test('assistant tool lookup_domain answers from the sync, with source health', async () => {
	const { hosted, dir, db } = await hostedEnv({ cfFails: true });
	await hosted.sync();
	const store = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'hd-'))); store.create({ name: 'Erindale United', domain: 'erindaleunited.church', kind: 'migration' });
	const tool = buildTools({ store, clients: {}, dir, outreach: null, audit: createAudit(db), hosted }).find((t) => t.name === 'lookup_domain');
	const out = await tool.run({ domain: 'erindaleunited.church' });
	assert.equal(out.hosted.duda, 'yes (site aaa)'); assert.equal(out.on_customers_board[0].type, 'DUDA migration');
	assert.match(out.sources_last_sync.cloudflare, /^FAILED/); assert.equal(buildTools({ store, clients: {}, dir, audit: {} }).some((t) => t.name === 'lookup_domain'), false);
});

test('SmarterMail domain list: tries the known calls and reads the names from whichever shape comes back', async () => {
	const seen = [];
	const f = async (url, o) => { seen.push(o.method + ' ' + url.split('/').pop()); const ok = url.endsWith('domain-list') && o.method === 'POST'; return { ok, status: ok ? 200 : 404, text: async () => JSON.stringify(ok ? { domains: [{ name: 'A.ca', hostname: 'mail' }, { name: 'b.org' }] } : { message: 'nope' }) }; };
	const sm = makeSmarterMail({ smartermailUrl: 'https://mail.x', smartermailUser: 'u', smartermailPassword: 'p' }, { fetch: f });
	assert.deepEqual(await sm.domains('t'), { ok: true, domains: ['a.ca', 'b.org'], via: 'api/v1/settings/sysadmin/domain-list' });
	const none = await makeSmarterMail({ smartermailUrl: 'https://mail.x' }, { fetch: async () => ({ ok: false, status: 404, text: async () => '{}' }) }).domains('t');
	assert.equal(none.ok, false); assert.match(none.error, /did not return a domain list/);
});
