import express from 'express';

export function hostedRouter({ need, hosted, store }) {
	const r = express.Router();
	r.use(need);
	r.get('/status', async (req, res) => res.json({ ...(await hosted.status()), counts: await hosted.counts() }));
	r.get('/list', async (req, res) => res.json(await hosted.list({ q: req.query.q, gap: req.query.gap, limit: req.query.limit, offset: req.query.offset })));
	r.get('/ascio-test', async (req, res) => { try { const a = hosted.ascio; if (!a?.available()) throw new Error('Ascio is not set up (ASCIO_ACCOUNT, ASCIO_PASSWORD).'); res.json(await a.ping()); } catch (e) { res.status(502).json({ error: e.message }); } });
	r.get('/expiring', async (req, res) => res.json(await hosted.expiring({ days: req.query.days, limit: req.query.limit })));
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
