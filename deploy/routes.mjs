// Express router for the deployment pipeline. Mounted at /api/deploy behind the Ops app's sign-in.
import express from 'express';
import { STAGES, stageByKey, blockedBy } from './stages.mjs';
import { configured } from './clients.mjs';

const LABELS = { website: 'Website', email: 'Website + Email' };

export function createDeployRouter({ need, store, clients }) {
	const r = express.Router();
	r.use(need);
	const busy = new Set(); // one action at a time per church
	const view = (c) => {
		const o = JSON.parse(JSON.stringify(c));
		o.stageStates = {};
		for (const s of STAGES) {
			const st = o.stages[s.key] || {};
			o.stageStates[s.key] = { done: !!st.done, manual: st.manual || {}, last: st.last || null, blockedBy: blockedBy(o, s) };
		}
		return o;
	};
	const meta = () => STAGES.map((s) => ({
		key: s.key, n: s.n, title: s.title, blurb: s.blurb, needs: s.needs, onlyPlan: s.onlyPlan || null,
		manual: s.manual.map((m) => ({ id: m.id })), 
	}));
	const manualLabels = (c, cfg) => Object.fromEntries(STAGES.map((s) => [s.key, s.manual.map((m) => ({ id: m.id, label: m.label(c, cfg, c.facts?.[s.key]) }))]));

	r.get('/config', (req, res) => {
		const cfg = clients.cfg;
		res.json({ configured: configured(cfg), plans: LABELS, stages: meta(), previewDomain: cfg.previewDomain, templateSlug: cfg.templateSlug });
	});

	r.get('/churches', (req, res) => res.json(store.list().map((c) => ({ id: c.id, name: c.name, domain: c.domain, plan: c.plan, created: c.created, stages: Object.fromEntries(STAGES.map((s) => [s.key, !!c.stages[s.key]?.done])) }))));

	r.post('/churches', (req, res) => {
		try { res.json(view(store.create(req.body || {}, req.by))); } catch (e) { res.status(400).json({ error: e.message }); }
	});

	r.get('/churches/:id', (req, res) => {
		const c = store.get(req.params.id);
		if (!c) return res.status(404).json({ error: 'Church not found' });
		res.json({ ...view(c), manualLabels: manualLabels(c, clients.cfg) });
	});

	r.patch('/churches/:id', (req, res) => {
		try {
			const b = req.body || {};
			const c = store.update(req.params.id, (c) => {
				if (b.name !== undefined) { const n = String(b.name).trim().slice(0, 80); if (!n) throw new Error('Enter the church name.'); c.name = n; }
				if (b.domain !== undefined) {
					const d = String(b.domain).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '');
					if (d && !/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(d)) throw new Error('That does not look like a website address (for example britanniaunited.ca).');
					c.domain = d;
				}
				if (b.plan !== undefined) c.plan = b.plan === 'email' ? 'email' : 'website';
				if (b.contactEmail !== undefined) c.contactEmail = String(b.contactEmail).trim().slice(0, 120);
				if (b.notes !== undefined) c.notes = String(b.notes).slice(0, 2000);
				if (b.mailboxes !== undefined) c.mailboxes = [...new Set(String(Array.isArray(b.mailboxes) ? b.mailboxes.join(',') : b.mailboxes).split(/[\s,;]+/).map((x) => x.toLowerCase().replace(/[^a-z0-9._-]/g, '')).filter(Boolean))].slice(0, 10);
			});
			store.log(req.params.id, req.by, 'Details changed');
			res.json(view(c));
		} catch (e) { res.status(400).json({ error: e.message }); }
	});

	r.delete('/churches/:id', (req, res) => {
		if (req.body?.confirm !== req.params.id) return res.status(400).json({ error: 'Type the short name to confirm.' });
		store.remove(req.params.id); res.json({ ok: true });
	});

	r.put('/churches/:id/stages/:key/manual', (req, res) => {
		const s = stageByKey(req.params.key), { id, value } = req.body || {};
		if (!s || !s.manual.some((m) => m.id === id)) return res.status(400).json({ error: 'Unknown step.' });
		try {
			const c = store.update(req.params.id, (c) => {
				const st = (c.stages[s.key] ||= {}); (st.manual ||= {})[id] = !!value;
				if (s.key === 'approval') st.done = STAGES[2].manual.every((m) => st.manual[m.id]) && !!c.domain;
			});
			store.log(req.params.id, req.by, `${s.title}: "${id}" ${value ? 'ticked' : 'unticked'}`);
			res.json(view(c));
		} catch (e) { res.status(404).json({ error: e.message }); }
	});

	/** action: check | dry | run | test */
	r.post('/churches/:id/stages/:key/:action', async (req, res) => {
		const { id, key, action } = req.params;
		const s = stageByKey(key);
		if (!s || !['check', 'dry', 'run', 'test'].includes(action)) return res.status(400).json({ error: 'Unknown stage or action.' });
		const ch = store.get(id);
		if (!ch) return res.status(404).json({ error: 'Church not found' });
		const b = req.body || {};
		const writes = action === 'run';
		if (writes) {
			if (b.confirm !== true) return res.status(400).json({ error: 'Confirm first.' });
			const blocked = blockedBy(ch, s);
			if (blocked.length) return res.status(409).json({ error: 'Not ready: ' + blocked.map((x) => x === 'plan' ? 'this stage is only for the Website + Email plan' : 'finish "' + stageByKey(x).title + '" first').join('; ') });
		}
		if (busy.has(id)) return res.status(409).json({ error: 'Another action is running for this church. Try again in a moment.' });
		busy.add(id);
		const ctx = { c: clients, facts: null, secret: null };
		try {
			const opts = { dry: action === 'dry', cutoverMx: !!b.cutoverMx, testTo: typeof b.testTo === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.testTo) ? b.testTo : '', email: b.email, name: b.name };
			let result;
			if (action === 'check') result = await s.check(ctx, ch);
			else if (action === 'test') result = await s.test(ctx, ch, opts);
			else result = await s.run(ctx, ch, opts);
			const at = Date.now();
			store.update(id, (c) => {
				const st = (c.stages[key] ||= {});
				st.last = { at, action, ok: result.ok, items: result.items.map((i) => (i.secret ? { id: i.id, label: i.label, status: i.status, detail: '(shown once, not saved)' } : { ...i })) };
				if (action === 'check' || action === 'test') st.done = key === 'approval' ? st.done : result.ok;
				if (ctx.facts) c.facts[key] = { ...(c.facts[key] || {}), ...ctx.facts };
			});
			store.log(id, req.by, `${s.title}: ${action} → ${result.ok ? 'ok' : 'needs attention'}`, result.ok ? 'info' : 'warn');
			// secrets (temporary passwords) are returned once and never stored
			res.json({ ...result, at, action, secret: ctx.secret || undefined, church: view(store.get(id)) });
		} catch (e) {
			store.log(id, req.by, `${s.title}: ${action} failed: ${e.message}`, 'error');
			res.status(500).json({ error: e.message });
		} finally { busy.delete(id); }
	});

	/** Switch the church's AI Assistant off (or back on) at the gateway. */
	r.post('/churches/:id/gateway', async (req, res) => {
		const ch = store.get(req.params.id);
		if (!ch) return res.status(404).json({ error: 'Church not found' });
		if (!clients.gateway.available()) return res.status(400).json({ error: 'Gateway is not configured on this server.' });
		try {
			const off = req.body?.off !== false;
			await clients.gateway.revoke(ch.slug, off);
			store.log(ch.id, req.by, off ? 'AI Assistant switched OFF at the gateway' : 'AI Assistant switched back ON', 'warn');
			res.json({ ok: true, off });
		} catch (e) { res.status(500).json({ error: e.message }); }
	});

	return r;
}
