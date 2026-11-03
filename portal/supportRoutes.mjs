import express from 'express';

/** The Support tab. Staff and admins can read the queue and handle tickets; only an admin can change the mode, the knowledge or the limits. */
export function supportRouter({ need, support }) {
	const r = express.Router();
	r.use(need);
	const admin = (req, res, next) => (req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Only an admin can change the support settings.' }));
	const id = (req) => { const n = Number(req.params.id); if (!Number.isSafeInteger(n) || n <= 0) throw new Error('Bad ticket number.'); return n; };
	const wrap = (fn, code = 400) => async (req, res) => { try { res.json(await fn(req)); } catch (e) { res.status(code).json({ error: e.message }); } };
	const by = (req) => req.user?.email || 'unknown';
	r.get('/status', wrap(() => support.status()));
	r.get('/tickets', wrap((req) => support.list({ state: req.query.state, category: req.query.category, q: req.query.q, limit: req.query.limit, offset: req.query.offset })));
	r.get('/tickets/:id', wrap(async (req) => { const t = await support.get(id(req)); if (!t) throw new Error('No such ticket.'); return t; }));
	r.get('/log', wrap((req) => support.log(req.query.limit)));
	r.post('/run', wrap((req) => support.run({ by: by(req) }), 409));
	r.post('/tickets/:id/reply', wrap((req) => support.send(id(req), req.body?.text, by(req))));
	r.post('/tickets/:id/close', wrap((req) => support.close(id(req), by(req))));
	r.post('/tickets/:id/escalate', wrap((req) => support.escalate(id(req), by(req))));
	r.post('/tickets/:id/not-spam', wrap((req) => support.notSpam(id(req), by(req))));
	r.post('/tickets/:id/retriage', wrap((req) => support.retriage(id(req))));
	r.put('/settings', admin, wrap((req) => support.saveSettings(req.body || {}, by(req))));
	return r;
}
