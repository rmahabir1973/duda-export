import express from 'express';
import { configured } from './clients.mjs';
import { parseInput, createMailboxes, enablePostmark, healthCheck, sendTest } from './email.mjs';
import { normDomain, DOMAIN_RE } from './store.mjs';

export function createEmailRouter({ need, clients, log = () => {} }) {
	const r = express.Router();
	r.use(need);
	const busy = new Set();
	const ctxFor = () => ({ c: clients, configured: configured(clients.cfg), memo: {}, facts: null, secret: null });
	const run = (name, handler) => async (req, res) => {
		const b = req.body || {};
		let key = ''; try { key = normDomain(b.domain); } catch { /* handled below */ }
		if (!DOMAIN_RE.test(key)) return res.status(400).json({ error: 'Enter the church\'s domain, for example britanniaunited.ca.' });
		if (busy.has(key)) return res.status(409).json({ error: 'Something is already running for this domain. Try again in a moment.' });
		busy.add(key);
		try { const items = await handler(b, key); log(`email ${name} ${key}`); res.json({ domain: key, items }); }
		catch (e) { res.status(e.status || 400).json({ error: e.message }); }
		finally { busy.delete(key); }
	};

	r.get('/config', (req, res) => res.json({ configured: configured(clients.cfg), mailHost: clients.cfg.mailHost, smartermailUrl: clients.cfg.smartermailUrl, domainPath: clients.cfg.smartermailDomainPath }));
	r.post('/create', run('create', async (b) => { const input = parseInput(b); if (!b.dry && b.confirm !== true) throw new Error('Confirm first.'); return createMailboxes(ctxFor(), input, { dry: !!b.dry }); }));
	r.post('/postmark', run('postmark', async (b, d) => { if (!b.dry && b.confirm !== true) throw new Error('Confirm first.'); return enablePostmark(ctxFor(), d, { dry: !!b.dry }); }));
	r.post('/health', run('health', (b, d) => healthCheck(ctxFor(), d)));
	r.post('/test', run('test', async (b, d) => { if (b.confirm !== true) throw new Error('Confirm first.'); return sendTest(ctxFor(), d, b.to); }));
	return r;
}
