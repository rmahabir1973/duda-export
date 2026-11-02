// Express router for the deployment checklist. Mounted at /api/deploy behind the Ops app's sign-in.
import express from 'express';
import { STAGES, stageByKey, reqOf, blockedBy, testStage, fixReq, isSatisfied, depMet } from './checks.mjs';
import { configured } from './clients.mjs';

const LABELS = { website: 'Website', email: 'Website + Email' };

export function createDeployRouter({ need, store, clients }) {
	const r = express.Router();
	r.use(need);
	const busy = new Set(); // one action at a time per church
	const cfgFlags = () => configured(clients.cfg);
	const ctxFor = () => ({ c: clients, configured: cfgFlags(), memo: {}, facts: null, secret: null });

	const stageDone = (stage, results) => stage.reqs.every((q) => isSatisfied(results?.[q.id]?.state));
	const view = (c) => {
		const o = JSON.parse(JSON.stringify(c));
		o.stageStates = {}; o.guide = {};
		for (const s of STAGES) {
			const st = o.stages[s.key] || {};
			o.stageStates[s.key] = { done: !!st.done, results: st.results || null, at: st.at || null, blockedBy: blockedBy(o, s) };
			o.guide[s.key] = Object.fromEntries(s.reqs.map((q) => [q.id, typeof q.howTo === 'function' ? q.howTo(o, clients.cfg) : q.howTo || '']));
		}
		return o;
	};
	const meta = () => STAGES.map((s) => ({
		key: s.key, n: s.n, title: s.title, blurb: s.blurb, needs: s.needs, onlyPlan: s.onlyPlan || null,
		reqs: s.reqs.map((q) => ({ id: q.id, label: q.label, manual: !!q.manual, canFix: !!q.fix, fixLabel: q.fixLabel || '', services: q.services || [], deps: q.deps || [], confirm: q.confirm || '' })),
	}));
	const save = (id, stage, results, ctx, by, note) => store.update(id, (c) => {
		const st = (c.stages[stage.key] ||= {});
		st.results = results; st.at = Date.now(); st.done = stageDone(stage, results);
		if (ctx.facts) c.facts[stage.key] = { ...(c.facts[stage.key] || {}), ...ctx.facts };
	});

	r.get('/config', (req, res) => res.json({ configured: cfgFlags(), plans: LABELS, stages: meta(), previewDomain: clients.cfg.previewDomain, templateSlug: clients.cfg.templateSlug }));

	r.get('/churches', (req, res) => res.json(store.list().map((c) => ({ id: c.id, name: c.name, domain: c.domain, plan: c.plan, created: c.created, stages: Object.fromEntries(STAGES.map((s) => [s.key, !!c.stages[s.key]?.done])) }))));

	r.post('/churches', (req, res) => {
		try { res.json(view(store.create(req.body || {}, req.by))); } catch (e) { res.status(400).json({ error: e.message }); }
	});

	r.get('/churches/:id', (req, res) => {
		const c = store.get(req.params.id);
		if (!c) return res.status(404).json({ error: 'Church not found' });
		res.json(view(c));
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

	/** Tick or untick a "by hand" requirement. */
	r.put('/churches/:id/stages/:key/manual', (req, res) => {
		const s = stageByKey(req.params.key), { id, value } = req.body || {};
		const q = s && reqOf(s, id);
		if (!q || !q.manual) return res.status(400).json({ error: 'Unknown item.' });
		try {
			const c = store.update(req.params.id, (c) => {
				const st = (c.stages[s.key] ||= {}); (st.manual ||= {})[id] = !!value;
				st.results = { ...(st.results || {}), [id]: { state: value ? 'ok' : 'no', detail: value ? 'Ticked.' : '' } };
				st.done = stageDone(s, st.results);
			});
			store.log(req.params.id, req.by, `${s.title}: "${q.label}" ${value ? 'ticked' : 'unticked'}`);
			res.json(view(c));
		} catch (e) { res.status(404).json({ error: e.message }); }
	});

	/** Look at everything in a stage (read-only). */
	r.post('/churches/:id/stages/:key/check', async (req, res) => {
		const { id, key } = req.params, s = stageByKey(key), ch = store.get(id);
		if (!s) return res.status(400).json({ error: 'Unknown stage.' });
		if (!ch) return res.status(404).json({ error: 'Church not found' });
		if (busy.has(id)) return res.status(409).json({ error: 'Another action is running for this church. Try again in a moment.' });
		busy.add(id);
		try {
			const ctx = ctxFor(), results = await testStage(ctx, ch, s);
			const c = save(id, s, results, ctx, req.by);
			res.json({ church: view(c) });
		} catch (e) { res.status(500).json({ error: e.message }); } finally { busy.delete(id); }
	});

	/** Fix one requirement, or body.req === "all" for everything in the stage that can be fixed safely. */
	r.post('/churches/:id/stages/:key/fix', async (req, res) => {
		const { id, key } = req.params, s = stageByKey(key), ch = store.get(id), b = req.body || {};
		if (!s) return res.status(400).json({ error: 'Unknown stage.' });
		if (!ch) return res.status(404).json({ error: 'Church not found' });
		if (b.confirm !== true) return res.status(400).json({ error: 'Confirm first.' });
		const blocked = blockedBy(ch, s);
		if (blocked.length) return res.status(409).json({ error: 'Not ready: ' + blocked.map((x) => (x === 'plan' ? 'this stage is only for the Website + Email plan' : 'finish "' + stageByKey(x).title + '" first')).join('; ') });
		if (busy.has(id)) return res.status(409).json({ error: 'Another action is running for this church. Try again in a moment.' });
		busy.add(id);
		const ctx = ctxFor(), fixed = [];
		try {
			let results = await testStage(ctx, ch, s);
			const targets = b.req === 'all' ? s.reqs.filter((q) => q.fix && !q.confirm) : [reqOf(s, b.req)].filter(Boolean);
			if (!targets.length) return res.status(400).json({ error: 'Nothing to fix.' });
			for (const q of targets) {
				const cur = results[q.id];
				if (cur?.state === 'blocked') { if (b.req !== 'all') fixed.push({ id: q.id, ok: false, detail: 'Waiting for an earlier item.' }); continue; }
				if (!['no', 'error', 'unknown'].includes(cur?.state)) { if (b.req !== 'all') fixed.push({ id: q.id, ok: true, detail: 'Already done.' }); continue; }
				if ((q.deps || []).some((d) => !depMet(results[d]?.state))) { fixed.push({ id: q.id, ok: false, detail: 'Waiting for an earlier item.' }); continue; }
				if (b.testTo) ctx.testTo = b.testTo;
				const out = await fixReq(ctx, ch, s, q, cur);
				fixed.push({ id: q.id, ok: !!out.ok, detail: out.detail || '', howTo: out.howTo || '', unavailable: out.unavailable || undefined });
				store.log(id, req.by, `${s.title}: ${q.label} → ${out.ok ? 'fixed' : 'could not fix'}`, out.ok ? 'info' : 'warn');
				if (out.ok) { ctx.memo = {}; results = await testStage(ctx, store.get(id), s); } else if (b.req === 'all') break;
			}
			const c = save(id, s, results, ctx, req.by);
			res.json({ fixed, secret: ctx.secret || undefined, church: view(c) });
		} catch (e) {
			store.log(id, req.by, `${s.title}: fix failed: ${e.message}`, 'error');
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
