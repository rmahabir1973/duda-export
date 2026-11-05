import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../deploy/store.mjs';
import { createCustomers, cleanDomain } from '../deploy/customers.mjs';
import { buildDnsPlan, planCounts, planOps } from '../deploy/dnsplan.mjs';

const base = { domain: 'carlisleuc.ca', hostingerIp: '1.2.3.4', mailIp: '212.28.180.63' };
const find = (lines, type, name) => lines.filter((l) => l.type === type && l.name === name);
const DMARC = 'v=DMARC1; p=quarantine; pct=100';

test('plan: a church whose email is elsewhere gets the website only; their mail records are left exactly as they are', () => {
	const inventory = [{ type: 'A', name: 'carlisleuc.ca', content: '100.24.208.97' }, { type: 'AAAA', name: 'carlisleuc.ca', content: '2600::1' }, { type: 'CNAME', name: 'www.carlisleuc.ca', content: 's.multiscreensite.com' }, { type: 'MX', name: 'carlisleuc.ca', content: 'aspmx.l.google.com', priority: 1 }, { type: 'TXT', name: 'carlisleuc.ca', content: 'v=spf1 include:_spf.google.com ~all' }, { type: 'TXT', name: 'carlisleuc.ca', content: 'google-site-verification=abc' }, { type: 'TXT', name: '_dmarc.carlisleuc.ca', content: 'v=DMARC1; p=none' }];
	const lines = buildDnsPlan({ ...base, email: false, inventory });
	assert.deepEqual(find(lines, 'A', 'carlisleuc.ca').map((l) => [l.action, l.content, l.proxy]), [['create', '1.2.3.4', true], ['replace', '100.24.208.97', false]]);
	assert.equal(find(lines, 'AAAA', 'carlisleuc.ca')[0].action, 'replace', 'the IPv6 record would send people to the old host');
	assert.deepEqual(find(lines, 'CNAME', 'www.carlisleuc.ca').map((l) => [l.action, l.content, l.proxy]), [['create', 'carlisleuc.ca', true], ['replace', 's.multiscreensite.com', false]]);
	assert.equal(find(lines, 'MX', 'carlisleuc.ca')[0].action, 'copy');
	assert.equal(find(lines, 'TXT', 'carlisleuc.ca').find((l) => /spf1/.test(l.content)).content, 'v=spf1 include:_spf.google.com ~all', 'their SPF is not touched');
	assert.equal(find(lines, 'TXT', 'carlisleuc.ca').find((l) => /spf1/.test(l.content)).action, 'copy');
	assert.equal(find(lines, 'TXT', '_dmarc.carlisleuc.ca')[0].content, 'v=DMARC1; p=none', 'a strict DMARC is never forced onto someone else\'s mail');
	assert.equal(find(lines, 'TXT', 'carlisleuc.ca').find((l) => /google-site/.test(l.content)).action, 'copy', 'verification records are not lost');
	assert.ok(!lines.some((l) => /^(mail|autodiscover|autoconfig)\./.test(l.name)), 'no mail server records when email is not with us');
});

test('plan: carlisleuc.ca today (email with us, old brand records) becomes the standard set', () => {
	const inventory = [{ type: 'A', name: 'carlisleuc.ca', content: '100.24.208.97' }, { type: 'A', name: 'carlisleuc.ca', content: '35.172.94.1' }, { type: 'A', name: 'mail.carlisleuc.ca', content: '212.28.180.63' }, { type: 'CNAME', name: 'autoconfig.carlisleuc.ca', content: 'autoconfig.churchwebsupport.com' }, { type: 'CNAME', name: 'autodiscover.carlisleuc.ca', content: 'autodiscover.churchwebsupport.com' }, { type: 'CNAME', name: 'www.carlisleuc.ca', content: 's.multiscreensite.com' }, { type: 'MX', name: 'carlisleuc.ca', content: 'mail.carlisleuc.ca', priority: 10 }, { type: 'TXT', name: 'carlisleuc.ca', content: 'v=spf1 include:churchwebsupport.com ~all' }, { type: 'TXT', name: '_dmarc.carlisleuc.ca', content: 'v=DMARC1; p=quarantine; rua=mailto:postmaster@churchwebsupport.com; ruf=mailto:postmaster@churchwebsupport.com; fo=1; pct=100; ri=86400' }];
	const lines = buildDnsPlan({ ...base, email: true, inventory });
	assert.deepEqual(find(lines, 'A', 'mail.carlisleuc.ca').map((l) => [l.action, l.content, l.proxy]), [['create', '212.28.180.63', false]]);
	for (const n of ['autodiscover', 'autoconfig']) {
		const l = find(lines, 'CNAME', `${n}.carlisleuc.ca`);
		assert.deepEqual(l.map((x) => [x.action, x.content, x.proxy]), [['create', 'mail.carlisleuc.ca', false], ['replace', `${n}.churchwebsupport.com`, false]]);
	}
	const mx = find(lines, 'MX', 'carlisleuc.ca'); assert.equal(mx.length, 1); assert.deepEqual([mx[0].content, mx[0].priority, mx[0].action], ['mail.carlisleuc.ca', 10, 'copy'], 'their mail already comes to us, so it must exist the moment the nameservers change');
	const spf = find(lines, 'TXT', 'carlisleuc.ca'); assert.equal(spf.length, 1); assert.equal(spf[0].content, 'v=spf1 ip4:212.28.180.63 ~all'); assert.equal(spf[0].action, 'replace');
	const dm = find(lines, 'TXT', '_dmarc.carlisleuc.ca'); assert.equal(dm.length, 1); assert.equal(dm[0].content, DMARC); assert.equal(dm[0].action, 'replace');
	assert.equal(find(lines, 'TXT', '<selector>._domainkey.carlisleuc.ca')[0].action, 'later');
	assert.ok(!lines.some((l) => l.action !== 'replace' && /churchwebsupport/i.test(l.content)), 'nothing new points at the old brand');
});

test('plan: a new email customer gets the standard set, the MX waits for the mailboxes, and their own DMARC and other senders are kept', () => {
	const lines = buildDnsPlan({ ...base, email: true, inventory: [{ type: 'MX', name: 'carlisleuc.ca', content: 'old.mail.example', priority: 5 }, { type: 'TXT', name: 'carlisleuc.ca', content: 'v=spf1 include:servers.mcsv.net ~all' }, { type: 'TXT', name: '_dmarc.carlisleuc.ca', content: 'v=DMARC1; p=none; rua=mailto:it@church.ca' }] });
	const mx = find(lines, 'MX', 'carlisleuc.ca');
	assert.equal(mx.find((l) => l.content === 'mail.carlisleuc.ca').action, 'later');
	assert.equal(mx.find((l) => l.content === 'old.mail.example').action, 'copy', 'the old MX stays until the switch');
	assert.equal(find(lines, 'TXT', 'carlisleuc.ca')[0].content, 'v=spf1 include:servers.mcsv.net ip4:212.28.180.63 ~all');
	assert.equal(find(lines, 'TXT', '_dmarc.carlisleuc.ca')[0].content, 'v=DMARC1; p=none; rua=mailto:it@church.ca');
	assert.equal(buildDnsPlan({ ...base, email: true }).find((l) => l.name === '_dmarc.carlisleuc.ca').content, DMARC);
});

test('plan: once the zone holds the standard set the plan says so and does not copy again', () => {
	const r = (type, name, content, extra = {}) => ({ id: name + type, type, name, content, ...extra });
	const existing = [r('A', 'carlisleuc.ca', '1.2.3.4'), r('CNAME', 'www.carlisleuc.ca', 'carlisleuc.ca'), r('A', 'mail.carlisleuc.ca', '212.28.180.63'), r('CNAME', 'autodiscover.carlisleuc.ca', 'mail.carlisleuc.ca'), r('CNAME', 'autoconfig.carlisleuc.ca', 'mail.carlisleuc.ca'), r('MX', 'carlisleuc.ca', 'mail.carlisleuc.ca', { priority: 10 }), r('TXT', 'carlisleuc.ca', '"v=spf1 ip4:212.28.180.63 ~all"'), r('TXT', '_dmarc.carlisleuc.ca', `"${DMARC}"`)];
	const lines = buildDnsPlan({ ...base, email: true, existing, inventory: [{ type: 'A', name: 'carlisleuc.ca', content: '9.9.9.9' }] });
	assert.deepEqual(planCounts(lines), { keep: 8, later: 1 });
});

test('plan: without the Hostinger address the website records are left out rather than guessed', () => {
	assert.ok(!buildDnsPlan({ ...base, hostingerIp: '', email: false }).some((l) => l.name === 'carlisleuc.ca' && l.type === 'A'));
});

function rig() {
	const store = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'cust-')));
	const cfg = { previewDomain: 'churchwebglobal.com' };
	const engine = { customerPlan: async (ctx, ch) => ({ domain: ch.domain, lines: [{ type: 'A', name: ch.domain, content: '1.2.3.4', action: 'create' }], plan: ch.plan }) };
	const cu = createCustomers({ store, ctxFor: () => ({ c: { cfg } }), engine, now: () => 1_800_000_000_000 });
	const church = (id, domain, done = true) => { store.create({ name: id.toUpperCase() + ' Church', slug: id, domain }); store.update(id, (c) => { c.prospect = { domain, createdAt: 1 }; c.run = { state: done ? 'done' : 'running' }; }); };
	return { store, cu, church };
}

test('convert: needs a ready preview, a valid domain and a DNS choice; cleans the domain; keeps the preview from being auto-deleted', () => {
	const { store, cu, church } = rig();
	church('abc', 'abc.ca'); church('slow', 'slow.ca', false);
	assert.throws(() => cu.convert('slow', { domain: 'slow.ca', dns: 'ours' }), /ready/);
	assert.throws(() => cu.convert('abc', { domain: 'not a domain', dns: 'ours' }), /website address/);
	assert.throws(() => cu.convert('abc', { domain: 'abc.ca' }), /DNS/);
	assert.throws(() => cu.convert('abc', { domain: 'abc.ca', dns: 'ours', contactEmail: 'nope' }), /contact email/);
	const v = cu.convert('abc', { domain: 'https://www.ABC.ca/', dns: 'theirs', email: true, contactEmail: 'office@abc.ca' }, 'ryan@x.com');
	assert.equal(v.domain, 'abc.ca'); assert.equal(v.dns, 'theirs'); assert.equal(v.email, true);
	const c = store.get('abc'); assert.equal(c.plan, 'email'); assert.equal(c.prospect.kept, true); assert.equal(c.contactEmail, 'office@abc.ca');
	assert.throws(() => cu.convert('abc', { domain: 'abc.ca', dns: 'ours' }), /already/);
	assert.equal(cu.list().length, 1);
	assert.equal(cleanDomain('  HTTP://WWW.Example.org/path?x=1 '), 'example.org');
});

test('settings: the choices can change until the site is live; two customers can not share a domain; it can go back to prospects', () => {
	const { store, cu, church } = rig();
	church('abc', 'abc.ca'); church('def', 'def.ca');
	cu.convert('abc', { domain: 'abc.ca', dns: 'ours' }); cu.convert('def', { domain: 'def.ca', dns: 'ours' });
	assert.equal(cu.save('abc', { domain: 'abc.ca', dns: 'theirs', email: false }).dns, 'theirs');
	assert.throws(() => cu.save('def', { domain: 'abc.ca', dns: 'ours' }), /already belongs/);
	store.update('abc', (c) => { c.stages.golive = { done: true }; });
	assert.throws(() => cu.save('abc', { domain: 'other.ca', dns: 'ours' }), /live/);
	assert.throws(() => cu.revert('abc'), /live/);
	assert.deepEqual(cu.revert('def'), { ok: true }); assert.equal(store.get('def').customer, undefined);
});

test('plan route: only customers have a plan, and it carries their choices', async () => {
	const { cu, church } = rig();
	church('abc', 'abc.ca');
	await assert.rejects(() => cu.plan('abc'), /Not a customer/);
	cu.convert('abc', { domain: 'abc.ca', dns: 'ours', email: true });
	const p = await cu.plan('abc'); assert.equal(p.dns, 'ours'); assert.equal(p.email, true); assert.deepEqual(p.counts, { create: 1 }); assert.equal(p.plan, 'email');
});

test('planOps: a wrong record is corrected in place, a stray one is left for a person, nothing is deleted, later lines are skipped', () => {
	const lines = [
		{ type: 'A', name: 'a.ca', content: '1.2.3.4', proxy: true, action: 'create' },
		{ type: 'A', name: 'a.ca', content: '9.9.9.9', proxy: false, action: 'replace', was: '9.9.9.9', id: 'old1' },
		{ type: 'AAAA', name: 'a.ca', content: '2600::1', proxy: false, action: 'replace', was: '2600::1', id: 'old2' },
		{ type: 'TXT', name: 'a.ca', content: 'v=spf1 ip4:212.28.180.63 ~all', action: 'replace', was: 'v=spf1 include:churchwebsupport.com ~all', id: 'spf1' },
		{ type: 'MX', name: 'a.ca', content: 'mail.a.ca', priority: 10, action: 'copy' },
		{ type: 'TXT', name: 'k._domainkey.a.ca', content: 'x', action: 'later' },
		{ type: 'TXT', name: '_dmarc.a.ca', content: 'v=DMARC1; p=quarantine; pct=100', action: 'keep' },
	];
	const { ops, flagged } = planOps(lines);
	assert.deepEqual(ops.map((o) => [o.op, o.type, o.id || '']), [['update', 'A', 'old1'], ['update', 'TXT', 'spf1'], ['create', 'MX', '']]);
	assert.equal(ops[0].content, '1.2.3.4');
	assert.equal(ops[2].priority, 10);
	assert.equal(flagged.length, 1); assert.match(flagged[0], /AAAA a\.ca/);
});

test('nameserver email: needs the Cloudflare nameservers first, asks for a DNS screenshot and warns about DNSSEC; sending validates and records it', async () => {
	const sent = [];
	const store = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'cust-')));
	const engine = { customerPlan: async () => ({}), customerDnsSetup: async () => ({ created: true, nameservers: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'], done: ['Added A a.ca'], flagged: [], errors: [] }), customerTest: async () => ({ ok: true, checks: [] }) };
	const cu = createCustomers({ store, ctxFor: () => ({ c: { cfg: { previewDomain: 'x.com' } } }), engine, send: async (m) => { sent.push(m); }, from: 'support@churchwebglobal.com', now: () => 5 });
	store.create({ name: 'A Church', slug: 'abc', domain: 'a.ca' }); store.update('abc', (c) => { c.prospect = { domain: 'a.ca', createdAt: 1 }; c.run = { state: 'done' }; });
	cu.convert('abc', { domain: 'a.ca', dns: 'ours', contactEmail: 'office@a.ca' }, 'ryan');
	await assert.rejects(() => cu.nsEmail('abc'), /Set up DNS/);
	const r = await cu.setup('abc', 'ryan'); assert.equal(r.done.length, 1);
	const d = await cu.nsEmail('abc');
	assert.equal(d.to, 'office@a.ca'); assert.match(d.body, /ada\.ns\.cloudflare\.com/); assert.match(d.body, /DNSSEC/); assert.match(d.body, /screenshot/);
	await assert.rejects(() => cu.nsEmailSend('abc', { to: 'bad', subject: 's', body: d.body }), /email address/);
	await cu.nsEmailSend('abc', { to: 'office@a.ca', subject: d.subject, body: d.body }, 'chad');
	assert.equal(sent.length, 1); assert.equal(sent[0].From, 'support@churchwebglobal.com'); assert.equal(sent[0].To, 'office@a.ca');
	assert.equal(store.get('abc').customer.nsEmailAt, 5);
	cu.save('abc', { domain: 'a.ca', dns: 'theirs', email: false }, 'ryan');
	await assert.rejects(() => cu.setup('abc'), /manages its own/);
});
