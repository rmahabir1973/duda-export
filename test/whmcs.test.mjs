import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { pgliteDb, migrate } from '../portal/db.mjs';
import { makeWhmcsClient, readSnapshot, summarize, customerRows, customersCsv, guessCategory, createWhmcs } from '../portal/whmcs.mjs';
import { whmcsRouter } from '../portal/whmcsRoutes.mjs';

const fresh = async () => { const db = pgliteDb(new PGlite()); await migrate(db); return db; };
const NOW = new Date('2026-11-02T12:00:00Z');
const SECRET = 'sekrit-value-123';

// A pretend WHMCS: same shapes as the real JSON API, pages of 2 so paging is exercised.
const DATA = {
	paymentmethods: [{ module: 'stripe', displayname: 'Credit Card' }, { module: 'mailin', displayname: 'Cheque' }, { module: 'banktransfer', displayname: 'Bank Transfer' }],
	clients: [{ id: 1, firstname: 'Ann', lastname: 'One', companyname: 'Alpha United', email: 'a@alpha.ca', status: 'Active' }, { id: 2, firstname: '=cmd', lastname: 'Two', companyname: 'Beta United', email: 'b@beta.ca', status: 'Active' }, { id: 3, firstname: 'Cy', lastname: 'Three', companyname: 'Gamma United', email: 'c@gamma.ca', status: 'Active' }, { id: 4, firstname: 'Di', lastname: 'Four', companyname: 'Delta', email: 'd@d.ca', status: 'Closed' }],
	products: [
		{ id: 10, clientid: 1, name: 'Hosting', status: 'Active', billingcycle: 'Annually', recurringamount: '600.00', paymentmethod: 'stripe', nextduedate: '2027-01-10' },
		{ id: 11, clientid: 2, name: 'Hosting', status: 'Active', billingcycle: 'Annually', recurringamount: '600.00', paymentmethod: 'mailin', nextduedate: '2026-12-01' },
		{ id: 12, clientid: 3, name: 'Hosting', status: 'Active', billingcycle: 'Monthly', recurringamount: '50.00', paymentmethod: 'mailin', nextduedate: '2026-11-15' },
		{ id: 13, clientid: 3, name: 'Email', status: 'Active', billingcycle: 'Monthly', recurringamount: '10.00', paymentmethod: 'stripe', nextduedate: '2026-11-15' },
		{ id: 14, clientid: 3, name: 'Domain', status: 'Active', billingcycle: 'Monthly', recurringamount: '5.00', paymentmethod: 'mailin', nextduedate: '2026-11-20' },
		{ id: 15, clientid: 4, name: 'Hosting', status: 'Terminated', billingcycle: 'Annually', recurringamount: '600.00', paymentmethod: 'stripe' },
		{ id: 16, clientid: 1, name: 'Extra', status: 'Active', billingcycle: 'One Time', recurringamount: '0.00', paymentmethod: '' },
	],
	invoices: [
		{ id: 100, userid: 1, status: 'Paid', paymentmethod: 'stripe', total: '600.00', currencycode: 'CAD', date: '2026-01-10', duedate: '2026-01-10', datepaid: '2026-01-10 10:00:00' },
		{ id: 101, userid: 2, status: 'Paid', paymentmethod: 'mailin', total: '600.00', currencycode: 'USD', date: '2025-12-01', duedate: '2025-12-01', datepaid: '2025-12-31 09:00:00' },
		{ id: 102, userid: 3, status: 'Paid', paymentmethod: 'mailin', total: '50.00', currencycode: 'CAD', date: '2026-09-15', duedate: '2026-09-15', datepaid: '2026-09-25 09:00:00' },
		{ id: 103, userid: 3, status: 'Unpaid', paymentmethod: 'mailin', total: '50.00', currencycode: 'CAD', date: '2026-10-15', duedate: '2026-10-15', datepaid: '0000-00-00 00:00:00' },
		{ id: 104, userid: 1, status: 'Paid', paymentmethod: 'stripe', total: '600.00', currencycode: 'CAD', date: '2023-01-10', duedate: '2023-01-10', datepaid: '2023-01-10 10:00:00' },
	],
};
const page = (arr, p) => arr.slice(+p.get('limitstart'), +p.get('limitstart') + 2); // WHMCS pages are tiny here on purpose
const fakeFetch = (log = [], data = DATA) => async (url, o) => {
	const p = new URLSearchParams(o.body); log.push({ url, action: p.get('action'), body: String(o.body) });
	const ok = (x) => ({ ok: true, status: 200, text: async () => JSON.stringify({ result: 'success', ...x }) });
	if (p.get('identifier') !== 'id1' || p.get('secret') !== SECRET) return ok({ result: 'error', message: 'Authentication Failed' });
	switch (p.get('action')) {
		case 'GetPaymentMethods': return ok({ paymentmethods: { paymentmethod: data.paymentmethods } });
		case 'GetClients': return ok({ totalresults: data.clients.length, clients: { client: page(data.clients, p) } });
		case 'GetClientsProducts': return ok({ totalresults: data.products.length, products: { product: page(data.products, p) } });
		case 'GetInvoices': return ok({ totalresults: data.invoices.length, invoices: { invoice: page(data.invoices, p) } });
		default: return ok({ result: 'error', message: 'Invalid Action' });
	}
};
const client = (log, extra = {}) => makeWhmcsClient({ url: 'https://my.example.ca/', identifier: 'id1', secret: SECRET, fetchImpl: fakeFetch(log), ...extra });

test('WHMCS client: only read actions are allowed, the secret stays in the body, and plain http is refused', async () => {
	const log = [], w = client(log);
	for (const bad of ['AddClient', 'UpdateClientProduct', 'DeleteClient', 'AddInvoicePayment', 'ModuleTerminate', 'GetClientsDetails']) await assert.rejects(() => w.call(bad), /only reads/);
	assert.equal(log.length, 0, 'nothing was sent for a blocked action');
	await w.call('GetPaymentMethods');
	assert.equal(log[0].url, 'https://my.example.ca/includes/api.php'); assert.ok(!log[0].url.includes(SECRET), 'the secret is never in the URL'); assert.ok(log[0].body.includes('responsetype=json'));
	await assert.rejects(() => makeWhmcsClient({ url: 'http://my.example.ca', identifier: 'id1', secret: SECRET, fetchImpl: fakeFetch() }).call('GetClients'), /https/);
	assert.equal(makeWhmcsClient({}).available(), false);
	await assert.rejects(() => makeWhmcsClient({ url: 'https://my.example.ca', identifier: 'id1', secret: 'wrong', fetchImpl: fakeFetch() }).call('GetClients'), (e) => /identifier or secret/.test(e.message) && !e.message.includes('wrong'));
});

test('WHMCS client: reads every page, sends the access key only when set, and explains an IP refusal', async () => {
	const log = [], w = client(log, { accessKey: 'AK1' });
	const all = await w.all('GetInvoices', 'invoices', 'invoice');
	assert.equal(all.length, 5); assert.equal(log.filter((l) => l.action === 'GetInvoices').length, 3, 'three pages of two');
	assert.ok(log[0].body.includes('accesskey=AK1'));
	const ipw = makeWhmcsClient({ url: 'https://x.ca', identifier: 'a', secret: 'b', fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ result: 'error', message: 'Invalid IP 1.2.3.4' }) }) });
	await assert.rejects(() => ipw.call('GetClients'), /API IP Access Restriction/);
	const html = makeWhmcsClient({ url: 'https://x.ca', identifier: 'a', secret: 'b', fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html>' }) });
	await assert.rejects(() => html.call('GetClients'), /did not answer with JSON/);
});

test('payment kind guess: cheque and mail-in are found by name, cards are not mistaken for them', () => {
	for (const [m, n, k] of [['mailin', 'Cheque', 'cheque'], ['mailin', 'Mail In Payment', 'cheque'], ['check', '', 'cheque'], ['stripe', 'Credit Card', 'card'], ['stripe_checkout', 'Stripe Checkout', 'card'], ['paypal', 'PayPal', 'card'], ['banktransfer', 'Bank Transfer', 'bank'], ['interac', 'Interac e-Transfer', 'bank'], ['acme', 'Acme', 'other'], ['', '', 'none']]) assert.equal(guessCategory(m, n), k, `${m} / ${n}`);
});

test('summary: counts customers by how they pay, annualises, uses invoice currency, and measures days to pay', async () => {
	const snap = await readSnapshot(client([]), { now: NOW }), s = summarize(snap, {}, { now: NOW });
	assert.equal(s.totals.activeClients, 3, 'closed customers and terminated services are left out'); assert.equal(s.totals.activeServices, 6); assert.equal(s.totals.mixedClients, 1, 'customer 3 uses cheque and card');
	const c = Object.fromEntries(s.categories.map((x) => [x.category, x]));
	assert.equal(c.cheque.clients, 2, 'customer 2 and customer 3 (two of three services by cheque) mainly pay by cheque'); assert.equal(c.card.clients, 1); assert.equal(c.cheque.anyClients, 2); assert.equal(c.card.anyClients, 2, 'customer 3 also has a card service');
	assert.equal(c.cheque.services, 3); assert.equal(c.none.services, 1, 'the free service with no gateway is counted as a service'); assert.equal(c.none.clients, 0, 'but it does not make its customer a "no payment method" customer');
	assert.deepEqual(c.cheque.annual, { USD: 600, CAD: 660 }, 'annual recurring is per currency, never added across currencies: 600 USD; (50+5)*12 CAD');
	assert.deepEqual(c.card.annual, { CAD: 720 });
	assert.equal(c.cheque.paid12m, 2); assert.equal(c.card.paid12m, 1, 'a 2023 invoice is outside the last 12 months');
	assert.equal(c.cheque.avgDaysToPay, 20, '(30 + 10) / 2'); assert.equal(c.card.avgDaysToPay, 0);
	assert.equal(c.cheque.unpaid, 1); assert.equal(c.cheque.overdue, 1);
	assert.equal(s.gateways.find((g) => g.module === 'mailin').category, 'cheque');
});

test('summary: an override changes the numbers straight away, and the list can be filtered and exported safely', async () => {
	const snap = await readSnapshot(client([]), { now: NOW });
	const s = summarize(snap, { banktransfer: 'cheque', mailin: 'bank' }, { now: NOW }), c = Object.fromEntries(s.categories.map((x) => [x.category, x]));
	assert.equal(c.cheque.services, 0); assert.equal(c.bank.services, 3, 'the admin said the "mailin" gateway is really a bank transfer');
	const base = summarize(snap, {}, { now: NOW });
	assert.deepEqual(customerRows(base, { category: 'cheque' }).map((r) => r.company), ['Beta United', 'Gamma United']);
	assert.deepEqual(customerRows(base, { category: 'card', any: true }).map((r) => r.company), ['Alpha United', 'Gamma United']);
	assert.deepEqual(customerRows(base, { q: 'alpha' }).map((r) => r.company), ['Alpha United']);
	const csv = customersCsv(customerRows(base, { category: 'cheque' })); assert.ok(csv.startsWith('WHMCS client ID,'));
	assert.ok(csv.includes("'=cmd"), 'a name starting with = cannot become a spreadsheet formula');
});

test('stored sync: a good sync is saved, a failing one is reported and keeps the last good copy, unknown gateways are refused', async () => {
	const db = await fresh(); let broken = false;
	const flaky = async (url, o) => (broken ? { ok: true, status: 200, text: async () => JSON.stringify({ result: 'error', message: 'Invalid IP 9.9.9.9' }) } : fakeFetch()(url, o));
	const w = createWhmcs({ db, whmcs: makeWhmcsClient({ url: 'https://my.example.ca', identifier: 'id1', secret: SECRET, fetchImpl: flaky }), log: () => {} });
	assert.equal(await w.summary(), null, 'nothing before the first sync');
	const ok = await w.sync(); assert.equal(ok.ok, true); assert.equal(ok.clients, 4);
	assert.equal((await w.summary()).totals.activeClients, 3);
	broken = true; const bad = await w.sync(); assert.equal(bad.ok, false); assert.match(bad.error, /IP/);
	assert.equal((await w.summary()).totals.activeClients, 3, 'the last good copy is kept'); assert.equal((await w.status()).last.ok, false);
	await assert.rejects(() => w.setGatewayMap('nope', 'cheque'), /not in the last sync/);
	await assert.rejects(() => w.setGatewayMap('mailin', 'banana'), /Unknown/);
	const after = await w.setGatewayMap('mailin', 'bank'); assert.equal(after.categories.find((c) => c.category === 'bank').services, 3);
	const reset = await w.setGatewayMap('mailin', 'auto'); assert.equal(reset.categories.find((c) => c.category === 'cheque').services, 3);
});

test('routes: admins only, staff and the API token are refused, and the export is audited', async () => {
	const db = await fresh(), audits = [];
	const w = createWhmcs({ db, whmcs: makeWhmcsClient({ url: 'https://my.example.ca', identifier: 'id1', secret: SECRET, fetchImpl: fakeFetch() }), log: () => {} });
	let user = { email: 'ryan@x.ca', role: 'admin' };
	const app = express(); app.use(express.json()); app.use((req, res, next) => { req.user = user; next(); });
	app.use('/api/whmcs', whmcsRouter({ need: (req, res, next) => next(), whmcs: w, audit: { write: async (e) => audits.push(e) } }));
	const srv = app.listen(0), base = `http://127.0.0.1:${srv.address().port}/api/whmcs`;
	try {
		const get = (p) => fetch(base + p), post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) });
		assert.equal((await post('/sync')).status, 200); assert.equal((await (await get('/summary')).json()).summary.totals.activeClients, 3);
		assert.equal((await (await get('/customers?category=cheque&limit=1')).json()).total, 2);
		const csv = await get('/export.csv?category=cheque'); assert.equal(csv.status, 200); assert.match(csv.headers.get('content-type'), /csv/); assert.equal(audits.at(-1).action, 'whmcs.export'); assert.equal(audits.at(-1).detail.rows, 2);
		assert.equal((await post('/gateway-map', { module: 'nope', category: 'cheque' })).status, 400);
		for (const u of [{ email: 'chad@x.ca', role: 'staff' }, { email: 'api-token', role: 'staff' }, undefined]) { user = u; for (const r of [get('/summary'), get('/export.csv'), post('/sync')]) assert.equal((await r).status, 403); }
	} finally { srv.close(); }
});

test('sync with no credentials says what to set instead of failing quietly', async () => {
	const db = await fresh(), w = createWhmcs({ db, whmcs: makeWhmcsClient({}), log: () => {} });
	assert.equal((await w.status()).configured, false); const r = await w.sync(); assert.equal(r.ok, false); assert.match(r.error, /WHMCS_URL/);
});

test('a record WHMCS cannot encode (Malformed UTF-8) is skipped and named, and everything else is still read', async () => {
	const rows = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, firstname: 'C' + (i + 1), lastname: '', companyname: '', email: '', status: 'Active' })), BAD = new Set([2, 5]); // the 3rd and 6th customers have broken text
	let calls = 0;
	const f = async (url, o) => {
		const p = new URLSearchParams(o.body), start = +p.get('limitstart'), size = +p.get('limitnum'), ok = (x) => ({ ok: true, status: 200, text: async () => JSON.stringify({ result: 'success', ...x }) }); calls++;
		if (p.get('action') !== 'GetClients') return ok(p.get('action') === 'GetPaymentMethods' ? { paymentmethods: { paymentmethod: [] } } : { totalresults: 0, products: { product: [] }, invoices: { invoice: [] } });
		if ([...BAD].some((i) => i >= start && i < start + size)) return { ok: true, status: 200, text: async () => JSON.stringify({ result: 'error', message: 'Error generating JSON encoded response: Malformed UTF-8 characters, possibly incorrectly encoded' }) };
		return ok({ totalresults: rows.length, clients: { client: rows.slice(start, start + size) } });
	};
	const w = makeWhmcsClient({ url: 'https://my.example.ca', identifier: 'id1', secret: SECRET, fetchImpl: f });
	const snap = await readSnapshot(w, { now: NOW });
	assert.deepEqual(snap.clients.map((c) => c.id), [1, 2, 4, 5, 7], 'the 3rd and 6th customers are left out, all others are kept');
	assert.deepEqual(snap.skipped.map((x) => [x.what, x.afterId]), [['customer', 2], ['customer', 5]], 'each skipped record is described by the ID before it');
	assert.deepEqual(snap.skipped.map((x) => [x.afterId, x.beforeId, x.count]), [[2, 4, 1], [5, 7, 1]], 'each gap names the IDs on both sides');
	assert.ok(calls < 60, 'found by halving the page, not by asking one record at a time');
	// any other WHMCS error still stops the sync
	const other = makeWhmcsClient({ url: 'https://my.example.ca', identifier: 'id1', secret: SECRET, fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ result: 'error', message: 'Access Denied' }) }) });
	await assert.rejects(() => other.all('GetClients', 'clients', 'client'), /missing a permission/);
	// and the stored result tells the person
	const db = await fresh(), st = createWhmcs({ db, whmcs: w, log: () => {} }), res = await st.sync();
	assert.equal(res.ok, true); assert.equal(res.skipped.length, 2); assert.equal((await st.status()).last.skipped[0].afterId, 2);
});

test('skipped records next to each other are grouped with a count', async () => {
	const { groupSkips } = await import('../portal/whmcs.mjs');
	const g = groupSkips([{ what: 'service', offset: 14, afterId: 14 }, { what: 'service', offset: 15, afterId: 14 }, { what: 'service', offset: 16, afterId: 14 }, { what: 'service', offset: 30, afterId: 20 }, { what: 'customer', offset: 0, afterId: null }], { service: [{ id: 14 }, { id: 18 }, { id: 20 }, { id: 22 }], customer: [{ id: 3 }] });
	assert.deepEqual(g, [{ what: 'service', afterId: 14, beforeId: 18, count: 3 }, { what: 'service', afterId: 20, beforeId: 22, count: 1 }, { what: 'customer', afterId: null, beforeId: 3, count: 1 }]);
});
