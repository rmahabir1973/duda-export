// Customers: a prospect that has said yes. This keeps their choices (who manages DNS, whether email is with us) and works out the DNS plan.
import express from 'express';
import { planCounts } from './dnsplan.mjs';

const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const cleanDomain = (v) => String(v || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '').replace(/\.$/, '');

export function createCustomers({ store, ctxFor, engine, pview = () => ({}), refreshCost = async () => {}, startFull = () => { throw new Error('Not available.'); }, send = null, from = 'support@churchwebglobal.com', now = Date.now }) {
	const view = (c) => {
		const cu = c.customer, cfg = ctxFor().c.cfg, p = c.prospect ? pview(c) : {};
		return { id: c.id, name: c.name, domain: c.domain, dns: cu.dns, email: !!cu.email, contactEmail: c.contactEmail || '', since: cu.at, by: cu.by || '', previewUrl: c.prospect ? `https://${c.slug}.${cfg.previewDomain}` : '', live: !!c.stages?.golive?.done, mode: p.mode || 'preview', runState: p.runState || '', headline: p.headline || '', canFull: !!p.canFull, cost: p.cost || null, history: (c.log || []).slice(-40).reverse(), emailSetup: c.emailSetup || {}, goliveAt: c.stages?.golive?.at || 0, goliveItems: c.customer?.golive?.items || null, dnsSetupAt: cu.dnsSetupAt || 0, nsEmailAt: cu.nsEmailAt || 0, nsEmailTo: cu.nsEmailTo || '' };
	};
	const list = () => { const out = store.list().filter((c) => c.customer); for (const c of out) refreshCost(c.id).catch(() => {}); return out.map(view); };

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

	async function setup(id, by = '') {
		const ch = store.get(id); if (!ch?.customer) throw new Error('Not a customer.');
		if (ch.customer.dns !== 'ours') throw new Error('This church manages its own DNS.');
		const r = await engine.customerDnsSetup(ctxFor(), ch);
		store.update(id, (c) => { c.customer.dnsSetupAt = now(); c.customer.nameservers = r.nameservers; });
		store.log(id, by, `DNS set up in Cloudflare${r.created ? ' (domain added)' : ''}: ${r.done.length} records written${r.errors.length ? `, ${r.errors.length} failed` : ''}`);
		return r;
	}
	/** The editable nameserver-change email for the church. Includes the "send us your current DNS" request and a DNSSEC warning. */
	async function nsEmail(id) {
		const ch = store.get(id); if (!ch?.customer) throw new Error('Not a customer.');
		const ns = ch.customer.nameservers || [];
		if (!ns.length) throw new Error('Set up DNS in Cloudflare first, so we know which nameservers to give them.');
		const d = ch.domain;
		const body = `Hello,

We're getting ${ch.name} ready to launch the new website on ${d}. To switch it on, the domain's nameservers need to be changed at the company where ${d} is registered (for example GoDaddy, Namecheap, Telus or Shaw).

1. Before changing anything, please send us a screenshot or a "Print to PDF" of the full list of DNS records for ${d} (your registrar or web host has a DNS or "Manage DNS" page). We copy your records over for you, and this is a safety check so that nothing is missed.

2. Then replace the existing nameservers with these two:

   ${ns.join('\n   ')}

3. If your registrar shows a setting called DNSSEC, please turn it off before you change the nameservers. Leaving it on can make the website and email stop working.

The change normally takes effect within an hour or two, but it can take up to 48 hours. Your website and email keep working during the switch.

If you would rather not do this yourself, just reply and tell us who looks after your domain and we'll write to them directly.

Thank you,
ChurchWeb Support`;
		return { to: ch.contactEmail || '', subject: `Action needed: switching ${d} to your new website`, body, nameservers: ns, from };
	}
	async function nsEmailSend(id, o = {}, by = '') {
		const ch = store.get(id); if (!ch?.customer) throw new Error('Not a customer.');
		if (!send) throw new Error('Email sending (Postmark) isn\'t set up on this server.');
		const to = String(o.to || '').trim(), subject = String(o.subject || '').trim(), body = String(o.body || '').trim();
		if (!EMAIL_RE.test(to)) throw new Error('Enter the email address to send this to.');
		if (!subject || body.length < 20) throw new Error('The email needs a subject and some text.');
		await send({ From: from, To: to, ReplyTo: from, Subject: subject, TextBody: body, MessageStream: 'outbound' });
		store.update(id, (c) => { c.customer.nsEmailAt = now(); c.customer.nsEmailTo = to; });
		store.log(id, by, `Nameserver email sent to ${to}`);
		return { ok: true, at: now(), to };
	}
	/** Keep the preview site and build every page. */
	async function full(id, by = '') {
		const ch = store.get(id); if (!ch?.customer) throw new Error('Not a customer.');
		startFull(id); store.log(id, by, 'Full site build started from Customers'); return view(store.get(id));
	}
	/** One pass of moving the preview site onto the real domain. Run it again until everything is green. */
	async function golive(id, by = '') {
		const ch = store.get(id); if (!ch?.customer) throw new Error('Not a customer.');
		if (ch.run?.state !== 'done') throw new Error('The site build must be finished first.');
		const r = await engine.customerGolive(ctxFor(), ch);
		store.update(id, (c) => { const st = (c.stages.golive ||= {}); st.results = r.results; st.at = now(); st.done = r.live; c.customer.golive = { items: r.items, at: now() }; });
		store.log(id, by, r.live ? `Live on ${ch.domain}` : `Go-live pass: ${r.items.filter((i) => i.state === 'ok').length} of ${r.items.length} checks fine`);
		return r;
	}
	async function dnsDelete(id, recordId, by = '') {
		const ch = store.get(id); if (!ch?.customer) throw new Error('Not a customer.');
		const r = await engine.customerDnsDelete(ctxFor(), ch, String(recordId || ''));
		store.log(id, by, `DNS record removed: ${r.removed}`); return r;
	}
	async function test(id) {
		const ch = store.get(id); if (!ch?.customer) throw new Error('Not a customer.');
		return engine.customerTest(ctxFor(), ch);
	}

	function router({ need }) {
		const r = express.Router(); r.use(need);
		const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { res.status(e.status || 400).json({ error: e.message }); } };
		r.get('/', (req, res) => res.json(list()));
		r.post('/:id/convert', wrap(async (req, res) => res.status(201).json(convert(req.params.id, req.body || {}, req.by))));
		r.post('/:id/settings', wrap(async (req, res) => { if (!store.get(req.params.id)?.customer) throw new Error('Not a customer.'); res.json(save(req.params.id, req.body || {}, req.by)); }));
		r.post('/:id/revert', wrap(async (req, res) => res.json(revert(req.params.id, req.by))));
		r.get('/:id/plan', wrap(async (req, res) => res.json(await plan(req.params.id))));
		r.post('/:id/dns/setup', wrap(async (req, res) => res.json(await setup(req.params.id, req.by))));
		r.get('/:id/ns-email', wrap(async (req, res) => res.json(await nsEmail(req.params.id))));
		r.post('/:id/ns-email/send', wrap(async (req, res) => res.json(await nsEmailSend(req.params.id, req.body || {}, req.by))));
		r.post('/:id/full', wrap(async (req, res) => res.json(await full(req.params.id, req.by))));
		r.post('/:id/golive', wrap(async (req, res) => res.json(await golive(req.params.id, req.by))));
		r.post('/:id/dns/delete', wrap(async (req, res) => res.json(await dnsDelete(req.params.id, (req.body || {}).recordId, req.by))));
		r.get('/:id/test', wrap(async (req, res) => res.json(await test(req.params.id))));
		return r;
	}
	return { dnsDelete, full, golive, setup, nsEmail, nsEmailSend, test, convert, save, revert, plan, list, view, router };
}
