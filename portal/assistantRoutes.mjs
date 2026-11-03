import express from 'express';
import { PAGES } from './assistantGuide.mjs';

export function assistantRouter({ need, assistant }) {
	const r = express.Router();
	r.use(need);
	const pageOf = (b) => { const p = String(b?.page || '').replace(/\/$/, ''); return PAGES[p] ? p : ''; }; // only our own screens are accepted
	const fail = (res, e) => res.status(400).json({ error: e.message });
	r.get('/status', (req, res) => res.json({ configured: assistant.configured() }));
	r.post('/chat', async (req, res) => { try { res.json(await assistant.chat(req.user, req.body?.messages, { page: pageOf(req.body) })); } catch (e) { fail(res, e); } });
	r.post('/resolve', async (req, res) => { try { res.json(await assistant.resolve(req.user, { groupId: String(req.body?.groupId || ''), decisions: req.body?.decisions || {}, messages: req.body?.messages, page: pageOf(req.body) })); } catch (e) { fail(res, e); } });
	return r;
}
