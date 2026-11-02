// HTTP side of outreach: signed-in routes under /api/outreach, and the public (signature-checked) Loops webhook.
import express from 'express';
import { verifyLoopsWebhook } from './loops.mjs';

const FILTER_KEYS = ['q', 'province', 'listing', 'council', 'charge', 'hasWebsite', 'status'];
const pickFilters = (f) => Object.fromEntries(FILTER_KEYS.filter((k) => f && typeof f[k] === 'string' && f[k]).map((k) => [k, f[k].slice(0, 120)]));

export function outreachRouter({ need, outreach, loops, webhookSecret = '' }) {
	const r = express.Router();
	r.use(need);
	r.get('/status', async (req, res) => {
		const out = { configured: loops.available(), event: outreach.eventName, cap: outreach.cap, windowDays: outreach.windowDays, webhookConfigured: !!webhookSecret };
		if (req.query.ping === '1' && loops.available()) out.ping = await loops.ping();
		res.json(out);
	});
	r.get('/stats', async (req, res) => res.json(await outreach.stats()));
	r.get('/suppressed', async (req, res) => res.json(await outreach.suppressed()));
	r.post('/preview', async (req, res) => {
		try { res.json(await outreach.preview(pickFilters(req.body?.filters), String(req.body?.campaign || ''))); } catch (e) { res.status(400).json({ error: e.message }); }
	});
	r.post('/send', async (req, res) => {
		try {
			const out = await outreach.send({ filters: pickFilters(req.body?.filters), campaign: String(req.body?.campaign || ''), expect: req.body?.expect, user: req.user });
			out.done.catch((e) => console.error('outreach run failed:', e.message));
			res.json({ started: out.started });
		} catch (e) { res.status(400).json({ error: e.message }); }
	});
	r.post('/suppress', async (req, res) => { try { await outreach.suppress(req.body?.email, 'added by ' + (req.user?.email || 'staff')); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); } });
	return r;
}

/** Mount BEFORE express.json(): the signature is over the raw body. */
export function loopsWebhook({ outreach, secret }) {
	return [express.raw({ type: '*/*', limit: '200kb' }), async (req, res) => {
		if (!secret) return res.status(503).json({ error: 'Webhook secret is not set.' });
		const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
		const ok = verifyLoopsWebhook({ secret, id: req.get('webhook-id'), timestamp: req.get('webhook-timestamp'), signature: req.get('webhook-signature'), rawBody: raw });
		if (!ok) return res.status(401).json({ error: 'Bad signature.' });
		let payload; try { payload = JSON.parse(raw); } catch { return res.status(400).json({ error: 'Not JSON.' }); }
		try { res.json({ ok: true, ...(await outreach.handleEvent(req.get('webhook-id'), payload)) }); } catch (e) { console.error('loops webhook failed:', e.message); res.status(500).json({ error: 'Failed.' }); }
	}];
}
