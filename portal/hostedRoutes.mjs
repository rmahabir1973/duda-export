import express from 'express';

export function hostedRouter({ need, hosted, store }) {
	const r = express.Router();
	r.use(need);
	r.get('/status', async (req, res) => res.json({ ...(await hosted.status()), counts: await hosted.counts() }));
	r.get('/list', async (req, res) => res.json(await hosted.list({ q: req.query.q, gap: req.query.gap, limit: req.query.limit, offset: req.query.offset })));
	r.get('/lookup', async (req, res) => { try { res.json(await hosted.lookup(req.query.domain, store)); } catch (e) { res.status(400).json({ error: e.message }); } });
	r.get('/board-candidates', async (req, res) => res.json(await hosted.boardCandidates(store)));
	r.post('/board-import', async (req, res) => {
		try { const slugs = Array.isArray(req.body?.slugs) ? req.body.slugs.map(String).slice(0, 100) : []; if (!slugs.length) throw new Error('Choose at least one site.'); res.json(await hosted.boardImport(store, slugs, req.user?.email || '')); } catch (e) { res.status(400).json({ error: e.message }); }
	});
	r.post('/sync', async (req, res) => {
		try { const st = await hosted.status(); if (st.running) throw new Error('A sync is already running.'); hosted.sync().catch((e) => console.error('sync failed:', e.message)); res.json({ started: true }); } catch (e) { res.status(409).json({ error: e.message }); }
	});
	return r;
}
