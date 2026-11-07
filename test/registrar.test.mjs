import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { pgliteDb, migrate } from '../portal/db.mjs';
import { createRegistrar } from '../portal/registrar.mjs';

const DAY = 86400000;
const iso = (d) => new Date(Date.now() + d * DAY).toISOString();
async function env({ alertTo = ['chad@x.com', 'wayne@x.com'] } = {}) {
	const db = pgliteDb(new PGlite()); await migrate(db);
	const add = (domain, days, status = 'Active', extra = {}) => db.query('insert into hosted_domains (domain, in_ascio, ascio_status, ascio_expires, ascio_lock, ascio_ns, in_cloudflare, in_duda, ascio_owner) values ($1, true, $2, $3, $4, $5, $6, $7, $8)', [domain, status, days === null ? null : iso(days), extra.lock || 'Lock', JSON.stringify(extra.ns || ['ada.ns.cloudflare.com']), !!extra.cf, !!extra.duda, extra.owner || '']);
	await add('soon.ca', 5, 'Active', { cf: true, duda: true, owner: 'Soon United' });
	await add('month.ca', 25); await add('quarter.ca', 80); await add('nextyear.ca', 300);
	await add('gone.ca', 40, 'Deleted'); await add('past.ca', -10); await add('moved.ca', 20, 'TransferredAway'); await add('nodate.ca', null);
	await add('churchwebglobal.com', 12, 'Active', { owner: 'ChurchWeb Global Inc.' });
	await db.query("insert into kv (key, value) values ('whmcs_snapshot', $1)", [JSON.stringify({ clients: [{ id: 7, name: 'Jane Doe', company: 'Month United Church', email: 'j@month.ca' }], services: [{ id: 1, clientid: 7, domain: 'www.month.ca', product: 'Website Hosting', status: 'Active', next: '2027-01-01' }] })]);
	const sent = [];
	const hosted = { status: async () => ({ sources: { ascio: { ok: true, at: 'now', count: 9 } }, configured: { ascio: true } }) };
	const reg = createRegistrar({ db, hosted, whmcs: {}, store: { list: () => [{ id: 'x', name: 'Quarter Board', domain: 'quarter.ca', kind: 'migration' }] }, notify: async (m) => { sent.push(m); }, alertTo, baseUrl: 'https://p.test', ownDomains: ['churchwebsupport.com'], log: () => {} });
	return { db, reg, sent };
}

test('registrar: lists only live registrations, soonest first, with WHMCS client and board matches; windows and decisions filter', async () => {
	const { reg } = await env();
	const all = await reg.list({ window: 0 });
	assert.deepEqual(all.rows.map((r) => r.domain), ['soon.ca', 'churchwebglobal.com', 'month.ca', 'quarter.ca', 'nextyear.ca'], 'deleted, transferred, expired and undated are hidden');
	assert.equal(all.rows[0].days, 5); assert.equal(all.rows[0].in_duda, true); assert.deepEqual(all.rows[0].nameservers, ['ada.ns.cloudflare.com']);
	assert.equal(all.rows.find((r) => r.domain === 'month.ca').whmcs.client, 'Month United Church');
	assert.equal(all.rows.find((r) => r.domain === 'quarter.ca').board.name, 'Quarter Board');
	assert.equal(all.rows.find((r) => r.domain === 'churchwebglobal.com').own, true);
	assert.deepEqual((await reg.list({ window: 30 })).rows.map((r) => r.domain), ['soon.ca', 'churchwebglobal.com', 'month.ca']);
	assert.deepEqual((await reg.list({ q: 'united' })).rows.map((r) => r.domain), ['soon.ca'], 'search covers the owner');
	const s = await reg.summary(); assert.equal(s.live, 5); assert.equal(s.d30, 3); assert.equal(s.d7, 1); assert.equal(s.hidden, 4); assert.equal(s.undecided60, 3);
	await reg.decide('month.ca', { decision: 'renewing', note: 'auto-renew on' }, 'chad@x.com');
	assert.deepEqual((await reg.list({ decision: 'renewing' })).rows.map((r) => [r.domain, r.note, r.decided_by]), [['month.ca', 'auto-renew on', 'chad@x.com']]);
	assert.deepEqual((await reg.list({ window: 60, decision: '' })).rows.map((r) => r.domain), ['soon.ca', 'churchwebglobal.com']);
	assert.equal((await reg.summary()).undecided60, 2);
	await assert.rejects(reg.decide('gone.ca', { decision: 'bogus' }), /Decision must be/);
	await assert.rejects(reg.decide('notours.ca', { decision: 'renewing' }), /not registered through/);
	await reg.decide('month.ca', { decision: '', note: '' }); assert.equal((await reg.list({ decision: 'renewing' })).total, 0);
});

test('registrar: alerts fire once per window, skip "let it expire", and reset after a renewal', async () => {
	const { db, reg, sent } = await env();
	await reg.decide('churchwebglobal.com', { decision: 'expire', note: 'test domain' });
	const r1 = await reg.checkAlerts();
	assert.deepEqual(r1.domains.map((d) => [d.domain, d.window]), [['soon.ca', 7], ['month.ca', 30]], 'quarter.ca is outside 60 days; the let-it-expire one is recorded but not reported');
	assert.equal(r1.sent, true); assert.equal(sent.length, 1); assert.deepEqual(sent[0].to, ['chad@x.com', 'wayne@x.com']);
	assert.match(sent[0].subject, /1 within 7 days, 2 to decide/); assert.match(sent[0].text, /WITHIN 7 DAYS\nsoon\.ca — expires in 5 days/); assert.match(sent[0].text, /https:\/\/p\.test\/registrar/); assert.doesNotMatch(sent[0].text, /churchwebglobal\.com/);
	const r2 = await reg.checkAlerts(); assert.equal(r2.found, 0); assert.equal(sent.length, 1, 'nothing fires twice');
	// soon.ca slips into the 1-day window: one more alert, for that window only
	await db.query("update hosted_domains set ascio_expires = $1 where domain = 'soon.ca'", [iso(0.5)]);
	const r3 = await reg.checkAlerts(); assert.deepEqual(r3.domains.map((d) => [d.domain, d.window]), [['soon.ca', 1]]);
	// soon.ca is renewed for a year: its alert history is cleared so next year's windows fire again
	await db.query("update hosted_domains set ascio_expires = $1 where domain = 'soon.ca'", [iso(366)]);
	await reg.checkAlerts(); assert.equal((await db.query("select count(*)::int as n from registrar_alerts where domain = 'soon.ca'"))[0].n, 0);
	await db.query("update hosted_domains set ascio_expires = $1 where domain = 'soon.ca'", [iso(50)]);
	const r4 = await reg.checkAlerts(); assert.deepEqual(r4.domains.map((d) => [d.domain, d.window]), [['soon.ca', 60]]);
	assert.equal((await reg.summary()).last_alert.found, 1);
});

test('registrar: no recipients or no mailer means alerts are recorded but nothing is sent', async () => {
	const { reg, sent } = await env({ alertTo: [] });
	const r = await reg.checkAlerts(); assert.equal(r.found, 3); assert.equal(r.sent, false); assert.equal(sent.length, 0);
});
