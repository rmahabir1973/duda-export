import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { pgliteDb, migrate } from '../portal/db.mjs';
import { createSupportContext } from '../portal/supportContext.mjs';

test('support context: describes the WHMCS account, open invoices, board stage and every linked domain in plain text', async () => {
	const db = pgliteDb(new PGlite()); await migrate(db);
	await db.query("insert into kv (key, value) values ('whmcs_snapshot', $1)", [JSON.stringify({ at: '2026-11-07T10:00:00Z', clients: [{ id: 7, name: 'Jane Doe', company: 'Grace United Church', email: 'office@graceunited.ca', status: 'Active' }], services: [{ id: 1, clientid: 7, domain: 'www.graceunited.ca', product: 'Website + Email', status: 'Active', cycle: 'Annually', amount: 948, next: '2027-02-01', module: 'Cheque' }], invoices: [{ id: 501, clientid: 7, status: 'Unpaid', total: 948, cur: 'CAD', date: '2026-10-01', due: '2026-10-15', module: 'Cheque' }, { id: 480, clientid: 7, status: 'Paid', total: 948, cur: 'CAD', date: '2025-10-01', paid: '2025-10-20' }] })]);
	await db.query("insert into hosted_domains (domain, in_cloudflare, in_duda, duda_site, in_smartermail, in_ascio, ascio_expires, ascio_status, ascio_lock) values ('graceunited.ca', true, true, 'abc123', true, true, '2027-03-04T00:00:00Z', 'Active', 'Lock')");
	const store = { list: () => [{ id: 'grace', name: 'Grace United Church', domain: 'graceunited.ca', kind: 'migration', stages: { preview: { done: true }, approval: { done: true } }, prospect: { siteReadyAt: 1 } }] };
	const ctx = createSupportContext({ db, store, now: () => Date.parse('2026-11-07T12:00:00Z') });
	const text = await ctx({ sender: 'treasurer@graceunited.ca', client_id: 7 });
	assert.match(text, /WHMCS client #7: Grace United Church \(Jane Doe\), account email office@graceunited\.ca, status Active/);
	assert.match(text, /Service: Website \+ Email for www\.graceunited\.ca, Active, Annually 948\.00, next due 2027-02-01, pays by Cheque/);
	assert.match(text, /Invoice #501: Unpaid, 948\.00 CAD, dated 2026-10-01, due 2026-10-15 \(OVERDUE\), Cheque/);
	assert.match(text, /Last paid invoice #480: 948\.00 CAD on 2025-10-20/);
	assert.match(text, /Customers board: "Grace United Church" \(DUDA migration\), done stages: preview, approval \(preview site ready\)/);
	assert.match(text, /Domain graceunited\.ca: DNS in our Cloudflare; website on DUDA \(site abc123\); email hosted with us \(SmarterMail\); registered through us \(Ascio\), renews 2027-03-04, Active, transfer lock/);
	// a stranger from a free-mail address: nothing but the honest answer
	const none = await ctx({ sender: 'someone@gmail.com', client_id: 0 });
	assert.equal(none, 'Not a WHMCS client (no account matches this email).');
	// a non-client writing from a church domain we host: the domain facts still come through
	const partial = await ctx({ sender: 'volunteer@graceunited.ca', client_id: 0 });
	assert.match(partial, /^Not a WHMCS client/); assert.match(partial, /Domain graceunited\.ca: DNS in our Cloudflare/);
});
