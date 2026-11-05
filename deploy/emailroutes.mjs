import express from 'express';
import { configured } from './clients.mjs';
import { parseInput, createMailboxes, listMailboxes, enablePostmark, healthCheck, sendTest } from './email.mjs';
import { normDomain, DOMAIN_RE } from './store.mjs';

export function createEmailRouter({ need, clients, log = () => {}, record = () => {}, history = () => ({}) }) {
	const r = express.Router();
	r.use(need);
	const busy = new Map(); // domain -> what is running
	const ctxFor = () => ({ c: clients, configured: configured(clients.cfg), memo: {}, facts: null, secret: null });
	const run = (name, handler) => async (req, res) => {
		const b = req.body || {};
		let key = ''; try { key = normDomain(b.domain); } catch { /* handled below */ }
		if (!DOMAIN_RE.test(key)) return res.status(400).json({ error: 'Enter the church\'s domain, for example britanniaunited.ca.' });
		if (busy.has(key)) return res.status(409).json({ error: 'Something is already running for this domain. Try again in a moment.' });
		busy.set(key, name);
		// The work carries on if the person leaves the page: the result is kept against the customer and the page shows it when they come back.
		try { const items = await handler(b, key); log(`email ${name} ${key}`); try { if (!b.dry) record(key, name, items, req.by || ''); } catch { /* the result is still shown */ } res.json({ domain: key, items }); }
		catch (e) { try { record(key, name, [{ id: 'error', label: 'Stopped', state: 'error', detail: e.message }], req.by || ''); } catch { /* ignore */ } res.status(e.status || 400).json({ error: e.message }); }
		finally { busy.delete(key); }
	};

	r.get('/state', (req, res) => { let d = ''; try { d = normDomain(req.query.domain); } catch { /* none */ } res.json({ domain: d, running: busy.get(d) || '', history: DOMAIN_RE.test(d) ? history(d) : {} }); });
	r.get('/config', (req, res) => res.json({ configured: configured(clients.cfg), mailHost: clients.cfg.mailHost, smartermailUrl: clients.cfg.smartermailUrl, domainPath: clients.cfg.smartermailDomainPath }));
	r.post('/create', run('create', async (b) => { const input = parseInput(b); if (!b.dry && b.confirm !== true) throw new Error('Confirm first.'); return createMailboxes(ctxFor(), input, { dry: !!b.dry }); }));
	r.post('/postmark', run('postmark', async (b, d) => { if (!b.dry && b.confirm !== true) throw new Error('Confirm first.'); return enablePostmark(ctxFor(), d, { dry: !!b.dry }); }));
	r.post('/mailboxes', run('mailboxes', (b, d) => listMailboxes(ctxFor(), d)));
	r.post('/health', run('health', (b, d) => healthCheck(ctxFor(), d)));
	r.post('/test', run('test', async (b, d) => { if (b.confirm !== true) throw new Error('Confirm first.'); return sendTest(ctxFor(), d, b.to); }));
	return r;
}
