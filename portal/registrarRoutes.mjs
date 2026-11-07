import express from 'express';

export function registrarRouter({ need, registrar, audit = null }) {
	const r = express.Router();
	r.use(need);
	r.get('/summary', async (req, res) => { try { res.json(await registrar.summary()); } catch (e) { res.status(500).json({ error: e.message }); } });
	r.get('/list', async (req, res) => { try { res.json(await registrar.list({ q: req.query.q, window: req.query.window, decision: req.query.decision ?? 'any', limit: req.query.limit, offset: req.query.offset })); } catch (e) { res.status(400).json({ error: e.message }); } });
	r.post('/decide', async (req, res) => {
		try {
			const out = await registrar.decide(req.body?.domain, { decision: req.body?.decision ?? '', note: req.body?.note ?? '' }, req.user?.email || '');
			await audit?.write({ user: req.user, action: 'registrar.decide', target: out.domain, status: 200, detail: { decision: out.decision, note: out.note }, ip: req.ip || '' });
			res.json(out);
		} catch (e) { res.status(400).json({ error: e.message }); }
	});
	r.post('/alerts/check', async (req, res) => { try { res.json(await registrar.checkAlerts({ send: req.body?.send !== false })); } catch (e) { res.status(500).json({ error: e.message }); } });
	return r;
}
