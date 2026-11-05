// Customers: a prospect that has said yes. This keeps their choices (who manages DNS, whether email is with us) and works out the DNS plan.
import express from 'express';
import { planCounts } from './dnsplan.mjs';

const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const cleanDomain = (v) => String(v || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '').replace(/\.$/, '');

export function createCustomers({ store, ctxFor, engine, now = Date.now }) {
	const view = (c) => {
		const cu = c.customer, cfg = ctxFor().c.cfg;
		return { id: c.id, name: c.name, domain: c.domain, dns: cu.dns, email: !!cu.email, contactEmail: c.contactEmail || '', since: cu.at, by: cu.by || '', previewUrl: c.prospect ? `https://${c.slug}.${cfg.previewDomain}` : '', live: !!c.stages?.golive?.done };
	};
	const list = () => store.list().filter((c) => c.customer).map(view);

	/** Turn a ready prospect into a customer. The choices can be changed later until the site is live. */
	function convert(id, o = {}, by = '') {
		const ch = store.get(id); if (!ch?.prospect) throw new Error('Prospect not found.');
		if (ch.customer) throw new Error('This church is already a customer.');
		if (ch.run?.state !== 'done') throw new Error('The preview must be ready first.');
		return save(id, o, by, true);
	}
	function save(id, o, by, first = false) {
		const domain = cleanDomain(o.domain);
		if (!DOMAIN_RE.test(domain)) throw new Error('That does not look like a website address (for example britanniaunited.ca).');
		if (o.dns !== 'ours' && o.dns !== 'theirs') throw new Error('Choose who will manage the DNS.');
		const email = o.email === true || o.email === 'true';
		const contact = String(o.contactEmail || '').trim();
		if (contact && !EMAIL_RE.test(contact)) throw new Error('That contact email does not look right.');
		for (const c of store.list()) if (c.id !== id && c.customer && c.domain === domain) throw new Error(`${domain} already belongs to ${c.name}.`);
		store.update(id, (c) => {
			if (c.stages?.golive?.done && c.domain !== domain) throw new Error('This site is live. Its domain can\'t be changed here.');
			c.domain = domain; c.plan = email ? 'email' : 'website'; if (contact) c.contactEmail = contact;
			c.customer = { ...(c.customer || {}), at: c.customer?.at || now(), by: c.customer?.by || by, dns: o.dns, email };
			if (c.prospect) c.prospect.kept = true; // a customer's preview is never cleared away by the 30-day timer
		});
		store.log(id, by, first ? `Made a customer: ${domain}, DNS ${o.dns === 'ours' ? 'managed by us' : 'managed by the church'}, email ${email ? 'with us' : 'not with us'}` : `Customer choices changed: DNS ${o.dns === 'ours' ? 'by us' : 'by the church'}, email ${email ? 'with us' : 'not with us'}`);
		return view(store.get(id));
	}
	function revert(id, by = '') {
		const ch = store.get(id); if (!ch?.customer) throw new Error('Not a customer.');
		if (ch.stages?.golive?.done) throw new Error('This site is live, so it can\'t go back to being a prospect.');
		store.update(id, (c) => { delete c.customer; });
		store.log(id, by, 'Moved back to Prospects');
		return { ok: true };
	}
	async function plan(id) {
		const ch = store.get(id); if (!ch?.customer) throw new Error('Not a customer.');
		const p = await engine.customerPlan(ctxFor(), ch);
		return { ...p, counts: planCounts(p.lines), dns: ch.customer.dns, email: !!ch.customer.email };
	}

	function router({ need }) {
		const r = express.Router(); r.use(need);
		const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { res.status(e.status || 400).json({ error: e.message }); } };
		r.get('/', (req, res) => res.json(list()));
		r.post('/:id/convert', wrap(async (req, res) => res.status(201).json(convert(req.params.id, req.body || {}, req.by))));
		r.post('/:id/settings', wrap(async (req, res) => { if (!store.get(req.params.id)?.customer) throw new Error('Not a customer.'); res.json(save(req.params.id, req.body || {}, req.by)); }));
		r.post('/:id/revert', wrap(async (req, res) => res.json(revert(req.params.id, req.by))));
		r.get('/:id/plan', wrap(async (req, res) => res.json(await plan(req.params.id))));
		return r;
	}
	return { convert, save, revert, plan, list, view, router };
}
