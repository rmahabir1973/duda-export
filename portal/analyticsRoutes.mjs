import express from 'express';
import { RANGES } from './analytics.mjs';

/** The dashboard includes billing figures, so it is for admins only. Everything is read-only. */
export function analyticsRouter({ need, analytics }) {
	const r = express.Router();
	r.use(need);
	r.use((req, res, next) => (req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Only an admin can see analytics.' })));
	r.get('/', async (req, res) => { try { res.json({ ranges: RANGES, ...(await analytics.report(req.query.days, { refresh: req.query.refresh === '1' })) }); } catch (e) { res.status(500).json({ error: e.message }); } });
	return r;
}
