import express from 'express';
import { customerRows, customersCsv, CATEGORIES } from './whmcs.mjs';

/** Billing data is for admins only. Everything here reads from our own copy; only /sync talks to WHMCS, and it can only read. */
export function whmcsRouter({ need, whmcs, audit }) {
	const r = express.Router();
	r.use(need);
	r.use((req, res, next) => (req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Only an admin can see billing data.' })));
	r.get('/status', async (req, res) => res.json(await whmcs.status()));
	r.get('/summary', async (req, res) => res.json({ summary: await whmcs.summary(), labels: CATEGORIES }));
	r.get('/customers', async (req, res) => {
		const s = await whmcs.summary(); const rows = customerRows(s, { category: req.query.category, q: req.query.q, any: req.query.any === '1', sort: req.query.sort, dir: req.query.dir });
		const lim = Math.min(500, Math.max(1, +req.query.limit || 100)), off = Math.max(0, +req.query.offset || 0);
		res.json({ total: rows.length, rows: rows.slice(off, off + lim) });
	});
	r.get('/export.csv', async (req, res) => {
		const rows = customerRows(await whmcs.summary(), { category: req.query.category, any: req.query.any === '1', sort: req.query.sort, dir: req.query.dir });
		await audit?.write({ user: req.user, action: 'whmcs.export', status: 200, detail: { category: req.query.category || 'all', rows: rows.length }, ip: req.ip || '' });
		res.type('text/csv').set('content-disposition', 'attachment; filename="whmcs-customers.csv"').send(customersCsv(rows));
	});
	r.post('/sync', async (req, res) => {
		try { const st = await whmcs.status(); if (!st.configured) throw new Error('WHMCS is not set up on this server (WHMCS_URL, WHMCS_API_IDENTIFIER, WHMCS_API_SECRET).'); if (st.running) throw new Error('A sync is already running.'); res.json(await whmcs.sync()); } catch (e) { res.status(409).json({ error: e.message }); }
	});
	r.post('/gateway-map', async (req, res) => {
		try { res.json({ summary: await whmcs.setGatewayMap(String(req.body?.module || ''), String(req.body?.category || '')) }); } catch (e) { res.status(400).json({ error: e.message }); }
	});
	return r;
}
