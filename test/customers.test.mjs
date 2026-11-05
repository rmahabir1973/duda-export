import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../deploy/store.mjs';
import { createCustomers, cleanDomain } from '../deploy/customers.mjs';
import { buildDnsPlan, planCounts } from '../deploy/dnsplan.mjs';

const base = { domain: 'carlisleuc.ca', hostingerIp: '1.2.3.4', mailIp: '212.28.180.63', autodiscover: 'autodiscover.churchwebsupport.com', autoconfig: 'autoconfig.churchwebsupport.com', dmarcRua: 'postmaster@churchwebglobal.com' };
const find = (lines, type, name) => lines.filter((l) => l.type === type && l.name === name);

test('plan: a church with its own email elsewhere gets the website, SPF and DMARC, and its old records are copied', () => {
	const inventory = [{ type: 'A', name: 'carlisleuc.ca', content: '100.24.208.97' }, { type: 'AAAA', name: 'carlisleuc.ca', content: '2600::1' }, { type: 'CNAME', name: 'www.carlisleuc.ca', content: 's.multiscreensite.com' }, { type: 'MX', name: 'carlisleuc.ca', content: 'aspmx.l.google.com', priority: 1 }, { type: 'TXT', name: 'carlisleuc.ca', content: 'v=spf1 include:_spf.google.com ~all' }, { type: 'TXT', name: 'carlisleuc.ca', content: 'google-site-verification=abc' }];
	const lines = buildDnsPlan({ ...base, email: false, inventory });
	assert.deepEqual(find(lines, 'A', 'carlisleuc.ca').map((l) => [l.action, l.content, l.proxy]), [['create', '1.2.3.4', true], ['replace', '100.24.208.97', false]]);
	assert.equal(find(lines, 'AAAA', 'carlisleuc.ca')[0].action, 'replace', 'the IPv6 record would send people to the old host');
	assert.deepEqual(find(lines, 'CNAME', 'www.carlisleuc.ca').map((l) => [l.action, l.content, l.proxy]), [['create', 'carlisleuc.ca', true], ['replace', 's.multiscreensite.com', false]]);
	assert.equal(find(lines, 'MX', 'carlisleuc.ca')[0].action, 'copy', 'their own mail keeps working');
	const spf = find(lines, 'TXT', 'carlisleuc.ca').filter((l) => /^v=spf1/.test(l.content));
	assert.equal(spf.length, 1); assert.match(spf[0].content, /include:_spf\.google\.com/); assert.match(spf[0].content, /include:spf\.mtasv\.net/); assert.equal(spf[0].action, 'replace');
	assert.equal(find(lines, 'TXT', 'carlisleuc.ca').find((l) => /google-site/.test(l.content)).action, 'copy', 'verification records are not lost');
	assert.equal(find(lines, 'TXT', '_dmarc.carlisleuc.ca')[0].action, 'create');
	assert.ok(!lines.some((l) => l.name === 'mail.carlisleuc.ca'), 'no mail server records when email is not with us');
});

test('plan: email with us adds mail, autodiscover and autoconfig (never proxied) and holds the MX back until the mailboxes exist', () => {
	const lines = buildDnsPlan({ ...base, email: true, inventory: [{ type: 'MX', name: 'carlisleuc.ca', content: 'old.mail.example', priority: 5 }] });
	assert.deepEqual(find(lines, 'A', 'mail.carlisleuc.ca').map((l) => [l.action, l.content, l.proxy]), [['create', '212.28.180.63', false]]);
	assert.equal(find(lines, 'CNAME', 'autodiscover.carlisleuc.ca')[0].proxy, false);
	assert.equal(find(lines, 'CNAME', 'autoconfig.carlisleuc.ca')[0].content, 'autoconfig.churchwebsupport.com');
	const mx = find(lines, 'MX', 'carlisleuc.ca');
	assert.equal(mx.find((l) => l.content === 'mail.carlisleuc.ca').action, 'later');
	assert.equal(mx.find((l) => l.content === 'old.mail.example').action, 'copy', 'the old MX stays until the switch');
	assert.match(find(lines, 'TXT', 'carlisleuc.ca')[0].content, /a:mail\.carlisleuc\.ca/);
});

test('plan: once the zone exists the plan says what is already in place and does not copy again', () => {
	const existing = [{ id: '1', type: 'A', name: 'carlisleuc.ca', content: '1.2.3.4' }, { id: '2', type: 'CNAME', name: 'www.carlisleuc.ca', content: 'carlisleuc.ca' }, { id: '3', type: 'TXT', name: 'carlisleuc.ca', content: '"v=spf1 include:spf.mtasv.net ~all"' }, { id: '4', type: 'TXT', name: '_dmarc.carlisleuc.ca', content: 'v=DMARC1; p=none' }];
	const lines = buildDnsPlan({ ...base, email: false, existing, inventory: [{ type: 'A', name: 'carlisleuc.ca', content: '9.9.9.9' }] });
	assert.deepEqual(planCounts(lines), { keep: 4 });
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
