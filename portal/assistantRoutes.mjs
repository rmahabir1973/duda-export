import express from 'express';

export function assistantRouter({ need, assistant }) {
	const r = express.Router();
	r.use(need);
	const fail = (res, e) => res.status(400).json({ error: e.message });
	r.get('/status', (req, res) => res.json({ configured: assistant.configured() }));
	r.post('/chat', async (req, res) => { try { res.json(await assistant.chat(req.user, req.body?.messages)); } catch (e) { fail(res, e); } });
	r.post('/resolve', async (req, res) => { try { res.json(await assistant.resolve(req.user, { groupId: String(req.body?.groupId || ''), decisions: req.body?.decisions || {}, messages: req.body?.messages })); } catch (e) { fail(res, e); } });
	return r;
}
