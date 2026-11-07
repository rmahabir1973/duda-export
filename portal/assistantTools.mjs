// What the portal assistant can look at and do. "read" tools run at once. "write" tools only ever run after a person presses Approve.
import { STAGES, stageByKey, reqOf, blockedBy, testStage, fixReq, reqsFor, stageSkipped, isSatisfied, kindOf } from '../deploy/checks.mjs';
import { configured, randomPassword } from '../deploy/clients.mjs';
import { healthCheck } from '../deploy/email.mjs';
import { normDomain, DOMAIN_RE } from '../deploy/store.mjs';
import { customerRows, CATEGORIES, SORT_KEYS } from './whmcs.mjs';
import { RANGES } from './analytics.mjs';

const trim = (s, n = 400) => String(s ?? '').slice(0, n);
const MAIL_RE = /^([a-z0-9][a-z0-9._-]{0,63})@((?:[a-z0-9-]+\.)+[a-z]{2,})$/;

/** Shrinks a report for the model: a long per-day list becomes its total and busiest day, long lists are cut. */
export function compactForModel(v, depth = 0) {
	if (Array.isArray(v)) return v.slice(0, 20).map((x) => compactForModel(x, depth + 1));
	if (!v || typeof v !== 'object') return v;
	const out = {};
	for (const [k, x] of Object.entries(v)) {
		if (k === 'daily' && Array.isArray(x)) { const keys = x[0] ? Object.keys(x[0]).filter((q) => typeof x[0][q] === 'number') : []; out.daily_summary = { days: x.length, from: x[0]?.d, to: x.at(-1)?.d, ...Object.fromEntries(keys.map((q) => [q, { total: Math.round(x.reduce((a, r) => a + r[q], 0) * 100) / 100, busiest_day: x.reduce((m, r) => (r[q] > m[q] ? r : m), x[0]).d }])) }; }
		else out[k] = compactForModel(x, depth + 1);
	}
	return out;
}

export function buildTools({ store, clients, dir, outreach, audit, hosted, whmcs, analytics, getSupport = () => null }) {
	const ctxFor = () => ({ c: clients, configured: configured(clients.cfg), memo: {}, facts: null, secret: null });
	const need = (id) => { const c = store.get(id); if (!c) throw new Error(`No customer with id "${id}". Use list_customers to see the ids.`); return c; };
	const stageSummary = (ch, s, results) => ({ stage: s.key, title: s.title, tasks: reqsFor(s, ch).map((q) => ({ id: q.id, task: q.label, state: results?.[q.id]?.state || 'not checked', detail: trim(results?.[q.id]?.detail, 240) })) });

	const tools = [
		{
			name: 'process_help', kind: 'read',
			description: 'Explains how the ChurchWeb process works. With no stage, lists every stage (and which customer type it applies to). With a stage key, lists its tasks and how each is done by hand.',
			input_schema: { type: 'object', properties: { stage: { type: 'string', description: 'A stage key such as dnscheck, cloudflare, preview, approval, dns, golive, mailboxes, sending, handover, sales, migrate.' } } },
			run: async ({ stage }) => {
				if (!stage) return STAGES.map((s) => ({ key: s.key, title: s.title, only: s.onlyKind ? (s.onlyKind === 'new' ? 'new sites' : 'DUDA migrations') : s.onlyPlan ? 'Website + Email plan' : 'all', blurb: s.blurb }));
				const s = stageByKey(stage); if (!s) throw new Error('Unknown stage key.');
				return { key: s.key, title: s.title, blurb: s.blurb, needs: s.needs, tasks: s.reqs.map((q) => ({ id: q.id, task: q.label, automatic_fix: !!q.fix, by_hand: typeof q.howTo === 'string' ? q.howTo : q.manual ? '' : undefined })) };
			},
		},
		{
			name: 'list_customers', kind: 'read',
			description: 'Lists every customer on the Customers board with their type (new site or DUDA migration), plan, domain and which stages are finished.',
			input_schema: { type: 'object', properties: {} },
			run: async () => store.list().map((c) => ({ id: c.id, name: c.name, domain: c.domain, type: kindOf(c), plan: c.plan, stages_done: STAGES.filter((s) => c.stages[s.key]?.done).map((s) => s.key) })),
		},
		{
			name: 'get_customer', kind: 'read',
			description: 'Shows one customer in full: details, notes, and the last known result of every task in every stage that applies to them. Results are as of the last check; use run_check for fresh ones.',
			input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
			run: async ({ id }) => { const c = need(id); return { id: c.id, name: c.name, domain: c.domain, type: kindOf(c), plan: c.plan, contact: c.contactEmail, notes: trim(c.notes, 600), mailboxes: c.mailboxes, stages: STAGES.filter((s) => !stageSkipped(s, c)).map((s) => stageSummary(c, s, c.stages[s.key]?.results)) }; },
		},
		{
			name: 'run_check', kind: 'read',
			description: 'Looks at the real state of one stage for a customer right now (read-only: it changes nothing) and returns each task as ok, no, blocked, etc.',
			input_schema: { type: 'object', properties: { id: { type: 'string' }, stage: { type: 'string' } }, required: ['id', 'stage'] },
			run: async ({ id, stage }) => { const c = need(id), s = stageByKey(stage); if (!s) throw new Error('Unknown stage key.'); if (stageSkipped(s, c)) return { skipped: 'This stage does not apply to this customer.' }; return stageSummary(c, s, await testStage(ctxFor(), c, s)); },
		},
		{
			name: 'check_email_dns', kind: 'read',
			description: 'Checks a domain\'s email setup (MX, SPF, DKIM, DMARC, Postmark) from public DNS. Read-only.',
			input_schema: { type: 'object', properties: { domain: { type: 'string' } }, required: ['domain'] },
			run: async ({ domain }) => { const d = normDomain(domain); if (!DOMAIN_RE.test(d)) throw new Error('That is not a domain name.'); return (await healthCheck(ctxFor(), d)).map((i) => ({ check: i.label, state: i.state, detail: trim(i.detail, 300) })); },
		},
		{
			name: 'directory_search', kind: 'read',
			description: 'Searches the United Church of Canada directory (for marketing). Returns up to 15 listings.',
			input_schema: { type: 'object', properties: { q: { type: 'string' }, province: { type: 'string', description: 'Two-letter code such as ON' }, status: { type: 'string', description: 'Outreach status: new, to contact, contacted, replied, not interested, do not contact, customer' }, customer: { type: 'string', enum: ['yes', 'no'] }, has_email: { type: 'boolean' } } },
			run: async (i) => { const r = await dir.list({ q: i.q, province: i.province, status: i.status, customer: i.customer, hasEmail: !!i.has_email, limit: 15 }); return { total_matching: r.total, rows: r.rows.map((x) => ({ id: x.id, name: x.name, city: x.city, province: x.province, email: x.email, website: x.website, customer: x.is_customer, outreach_status: x.outreach_status })) }; },
		},
		...(hosted ? [
			{
				name: 'lookup_domain', kind: 'read',
				description: 'THE way to answer "do we host / is X a customer": looks one domain up in what we host (Cloudflare, DUDA, SmarterMail email, Hostinger) and whether it is registered through our Ascio account (expiry date, status, transfer lock, nameservers), on the Customers board, and in the United Church directory. Also says how fresh the data is and which sources failed, so say so when a source is missing instead of guessing.',
				input_schema: { type: 'object', properties: { domain: { type: 'string', description: 'e.g. erindaleunited.church' } }, required: ['domain'] },
				run: async ({ domain }) => { const [r, st] = [await hosted.lookup(domain, store), await hosted.status()]; return { ...r, sources_last_sync: Object.fromEntries(Object.entries(st.sources).map(([k, v]) => [k, v.ok ? `ok ${v.at}` : `FAILED: ${v.error}`])), sources_never_run: Object.keys(st.configured).filter((k) => !st.sources[k]), sources_not_configured: Object.keys(st.configured).filter((k) => !st.configured[k]) }; },
			},
			{
				name: 'list_hosted_domains', kind: 'read',
				description: 'Lists domains we host, optionally filtered. gap: cloudflare, duda, smartermail, hostinger, ascio (registered through us), expiring (renewal due within 60 days, soonest first), expired, ascio-not-cloudflare, cloudflare-not-ascio, ascio-ns-elsewhere, duda-not-cloudflare, cloudflare-not-duda, mail-not-cloudflare, no-mail. Returns at most 40.',
				input_schema: { type: 'object', properties: { q: { type: 'string' }, gap: { type: 'string' } } },
				run: async ({ q, gap }) => { const r = await hosted.list({ q, gap, limit: 40 }); return { total_matching: r.total, counts: await hosted.counts(), domains: r.rows.map((x) => ({ domain: x.domain, cloudflare: x.in_cloudflare, duda: x.in_duda, email: x.in_smartermail, hostinger: x.in_hostinger, registered_with_us: x.in_ascio, ...(x.in_ascio ? { expires: x.ascio_expires, registrar_status: x.ascio_status, transfer_lock: x.ascio_lock, nameservers: x.ascio_ns } : {}) })) }; },
			},
			{
				name: 'domains_expiring', kind: 'read',
				description: 'Domains registered through our Ascio account whose renewal is due within N days (default 60), soonest first, our own domains included. Use for "what expires this month", "any renewals due", "is X about to expire".',
				input_schema: { type: 'object', properties: { days: { type: 'integer', description: 'Look-ahead window in days, 1-365. Default 60.' } } },
				run: async ({ days }) => { const rows = await hosted.expiring({ days: Math.min(365, Math.max(1, +days || 60)), limit: 100 }); const st = await hosted.status(); return { window_days: Math.min(365, Math.max(1, +days || 60)), count: rows.length, ascio_last_sync: st.sources.ascio ? (st.sources.ascio.ok ? st.sources.ascio.at : 'FAILED: ' + st.sources.ascio.error) : (st.configured.ascio ? 'never run' : 'Ascio is not set up'), domains: rows.map((r) => ({ domain: r.domain, expires: r.ascio_expires, status: r.ascio_status, transfer_lock: r.ascio_lock, dns_in_cloudflare: r.in_cloudflare, site_on_duda: r.in_duda, site_on_hostinger: r.in_hostinger })) }; },
			},
		] : []),
		{ name: 'outreach_stats', kind: 'read', description: 'Prospect email results for the last 30 days (sent, delivered, opened, clicked, bounced, unsubscribed) and today\'s sending allowance.', input_schema: { type: 'object', properties: {} }, run: async () => (outreach ? outreach.stats() : { error: 'Outreach is not set up.' }) },

		...(whmcs ? [
			{
				name: 'whmcs_summary', kind: 'read', admin: true,
				description: 'ADMIN ONLY. How customers pay in WHMCS (a read-only copy): customers and services by payment kind (card, cheque/mail-in, bank transfer, other), annual recurring per currency, paid/unpaid/overdue invoices, average days to pay, and the gateways. Says when WHMCS was last synced.',
				input_schema: { type: 'object', properties: {} },
				run: async () => { const s = await whmcs.summary(); if (!s) return { error: 'WHMCS has not been synced yet. Open the WHMCS screen and press Sync now (it needs WHMCS_URL, WHMCS_API_ID and WHMCS_API_SECRET in Railway).' }; const st = await whmcs.status(); return { synced_at: s.at, last_sync: st.last, totals: s.totals, by_payment_kind: s.categories.map((c) => ({ kind: c.label, customers_mainly: c.clients, customers_any_service: c.anyClients, active_services: c.services, annual_recurring: c.annual, paid_invoices_last_12_months: c.paid12m, average_days_to_pay: c.avgDaysToPay, unpaid_invoices: c.unpaid, overdue_invoices: c.overdue })), gateways: s.gateways.map((g) => ({ name: g.name, kind: CATEGORIES[g.category], active_services: g.services, customers: g.clients })) }; },
			},
			{
				name: 'whmcs_customers', kind: 'read', admin: true,
				description: 'ADMIN ONLY. Lists WHMCS customers (active services only), filtered and SORTED. Use this for any "list/sort/who pays by X/next due" question. sort: name, email, status, services, kind (payment kind), annual (annual recurring; amounts in different currencies are compared as plain numbers), next (next due date; blanks last). dir: asc or desc. Returns at most 50 per call; use offset to continue.',
				input_schema: { type: 'object', properties: { category: { type: 'string', enum: Object.keys(CATEGORIES), description: 'Payment kind: card, cheque, bank, other, none' }, any_service: { type: 'boolean', description: 'true: customers with ANY service of that kind; false: customers who mainly pay that way' }, q: { type: 'string', description: 'Search name, company or email' }, sort: { type: 'string', enum: SORT_KEYS }, dir: { type: 'string', enum: ['asc', 'desc'] }, limit: { type: 'integer' }, offset: { type: 'integer' } } },
				run: async (i) => { const sm = await whmcs.summary(); if (!sm) return { error: 'WHMCS has not been synced yet. Open the WHMCS screen and press Sync now.' }; const rows = customerRows(sm, { category: i.category, any: !!i.any_service, q: i.q, sort: i.sort || 'name', dir: i.dir || 'asc' }), lim = Math.min(50, Math.max(1, +i.limit || 25)), off = Math.max(0, +i.offset || 0); return { synced_at: sm.at, total_matching: rows.length, showing: `${Math.min(off + 1, rows.length)}-${Math.min(off + lim, rows.length)}`, sorted_by: `${i.sort || 'name'} ${i.dir || 'asc'}`, customers: rows.slice(off, off + lim).map((r) => ({ customer: r.company || r.name, contact: r.company ? r.name : '', email: r.email, status: r.status, active_services: r.services, pays_mainly_by: CATEGORIES[r.primary], other_kinds: r.categories.filter((c) => c !== r.primary).map((c) => CATEGORIES[c]), annual_recurring: r.annual, next_due: r.next })) }; },
			},
		] : []),
		...(analytics ? [{
			name: 'analytics_overview', kind: 'read', admin: true,
			description: 'ADMIN ONLY. The numbers behind the Analytics screen. source: ga4 (churchwebglobal.com website visitors, pages, sources, countries), cloudflare (traffic to every customer domain), postmark (email sending), outreach (prospect emails), directory, activity (portal actions), pipeline (customers by setup stage), footprint (domains hosted), billing (WHMCS summary). days: 7, 30 or 90. Daily series are summarised. A source that is not set up says which setting is missing: pass that on.',
			input_schema: { type: 'object', properties: { source: { type: 'string', enum: ['ga4', 'cloudflare', 'postmark', 'outreach', 'directory', 'activity', 'pipeline', 'footprint', 'billing'] }, days: { type: 'integer', enum: RANGES } }, required: ['source'] },
			run: async ({ source, days }) => { const r = await analytics.report(days || 30), x = r.sources[source]; if (!x) throw new Error('Unknown source.'); if (!x.ok) return { source, error: x.error, not_set_up: !!x.notSetUp }; return { source, days: r.days, as_of: x.at, ...(x.stale ? { warning: 'The latest refresh failed; these are the last good numbers: ' + x.staleError } : {}), data: compactForModel(x.data) }; },
		}] : []),
		{
			name: 'support_queue', kind: 'read',
			description: 'The support tickets the assistant has sorted (from WHMCS), most urgent first: category, priority (1 urgent to 4 low), a one-line summary, why a person is needed, and the state (escalated, triaged, replied, spam_closed, digested...). state: open (default), escalated, replied, spam_closed, digested, all. Returns at most 25. You cannot reply to or close tickets from chat: point the person to the Support screen.',
			input_schema: { type: 'object', properties: { state: { type: 'string' }, category: { type: 'string' }, q: { type: 'string' } } },
			run: async (i) => { const sp = getSupport(); if (!sp) return { error: 'Support is not set up on this server.' }; const [r, st] = [await sp.list({ state: i.state || 'open', category: i.category, q: i.q, limit: 25 }), await sp.status()]; return { mode: st.settings.mode, last_run: st.last && { at: st.last.at, ok: st.last.ok, errors: st.last.errors }, counts: st.counts, total_matching: r.total, tickets: r.rows.map((t) => ({ ticket: t.tid || t.id, subject: String(t.subject).slice(0, 100), from: t.sender, category: t.category, priority: t.priority, state: t.state, summary: t.summary, needs_person_because: t.reason, has_draft: !!t.draft })) }; },
		},
		{
			name: 'recent_activity', kind: 'read', admin: true,
			description: 'ADMIN ONLY. The most recent actions in the portal (who did what, when, and whether it worked), newest first. Optionally filter by a person\'s email or a word in the action or target. Returns at most 30.',
			input_schema: { type: 'object', properties: { user: { type: 'string', description: 'Exact email address' }, q: { type: 'string' }, limit: { type: 'integer' } } },
			run: async ({ user, q, limit }) => { const r = await audit.list({ user, q, limit: Math.min(30, Math.max(1, +limit || 15)) }); return { total_matching: r.total, actions: r.rows.map((x) => ({ at: x.at, who: x.user_email, action: x.action, target: x.target, result: x.status && x.status >= 400 ? 'failed' : 'ok' })) }; },
		},

		/* ---------------- changes: only after a person approves */
		{
			name: 'fix_task', kind: 'write',
			description: 'Runs the automatic fix for ONE task of a customer (for example adding DNS records, creating the preview site, connecting Postmark). Only works on tasks that currently fail. Use run_check first so you know the task id.',
			input_schema: { type: 'object', properties: { id: { type: 'string' }, stage: { type: 'string' }, task: { type: 'string' } }, required: ['id', 'stage', 'task'] },
			summary: (i) => { const c = store.get(i.id), s = stageByKey(i.stage), q = s && reqOf(s, i.task); return `Fix "${q ? q.label : i.task}" for ${c ? c.name : i.id} (${s ? s.title : i.stage}). This makes a real change.`; },
			run: async ({ id, stage, task }, who) => {
				const c = need(id), s = stageByKey(stage), q = s && reqOf(s, task);
				if (!q) throw new Error('Unknown stage or task.');
				const blocked = blockedBy(c, s); if (blocked.length) throw new Error('Not ready: ' + blocked.join(', ') + ' must be finished first.');
				const ctx = ctxFor(); let results = await testStage(ctx, c, s); const cur = results[task];
				if (!['no', 'error', 'unknown'].includes(cur?.state)) return { forModel: `Nothing to fix: this task is "${cur?.state || 'unchecked'}".` };
				const out = await fixReq(ctx, c, s, q, cur);
				store.log(c.id, who, `Assistant: ${s.title}: ${q.label} → ${out.ok ? 'fixed' : 'could not fix'}`, out.ok ? 'info' : 'warn');
				if (out.ok) results = await testStage({ ...ctxFor() }, store.get(id), s);
				store.update(id, (x) => { const st = (x.stages[s.key] ||= {}); st.results = results; st.at = Date.now(); st.done = reqsFor(s, x).every((r) => isSatisfied(results?.[r.id]?.state)); });
				const display = ctx.secret ? [{ title: 'Shown once. Copy it now.', lines: Object.entries(ctx.secret).filter(([k]) => k !== 'boxes').map(([k, v]) => `${k}: ${v}`).concat((ctx.secret.boxes || []).map((b) => `${b.address}   ${b.password}`)) }] : [];
				return { ok: !!out.ok, forModel: `${out.ok ? 'Fixed.' : 'Could not fix.'} ${trim(out.detail || out.howTo, 500)}${display.length ? ' (A login was created; the person can see it, you cannot.)' : ''}`, display };
			},
		},
		{
			name: 'set_mailbox_password', kind: 'write',
			description: 'Changes the password of one email account on our SmarterMail server to a new random strong password. The person sees the new password once; you never do. Do not ask the user to type a password into the chat.',
			input_schema: { type: 'object', properties: { address: { type: 'string', description: 'Full address, e.g. office@britanniaunited.ca' } }, required: ['address'] },
			summary: (i) => `Change the SmarterMail password for ${i.address} to a new random one. Their current password stops working.`,
			run: async ({ address }) => {
				const m = MAIL_RE.exec(String(address || '').trim().toLowerCase()); if (!m) throw new Error('That is not an email address.');
				const [, user, domain] = m, sm = clients.smartermail;
				if (!sm.available()) throw new Error('SmarterMail is not connected to this server.');
				const pw = randomPassword(16), sys = await sm.sysLogin();
				const r = await sm.setPassword(sys, { domain, userName: user, password: pw });
				let verified = false; try { await sm.login(`${user}@${domain}`, pw); verified = true; } catch { /* not changed */ }
				if (!verified) return { ok: false, forModel: `SmarterMail did not accept the password change through its API (${trim(r.error || 'the new password does not work', 200)}). The password is unchanged. It can be changed by hand in SmarterMail: Domain Settings, Users, ${user}, Change Password.` };
				return { ok: true, forModel: `Password changed and confirmed by signing in. The new password was shown to the person (not to you).`, display: [{ title: `New password for ${user}@${domain} (shown once)`, lines: [pw] }] };
			},
		},
		{
			name: 'set_outreach_status', kind: 'write',
			description: 'Sets the outreach status of one directory listing (by id from directory_search).',
			input_schema: { type: 'object', properties: { id: { type: 'integer' }, status: { type: 'string', enum: ['new', 'to contact', 'contacted', 'replied', 'not interested', 'do not contact', 'customer'] } }, required: ['id', 'status'] },
			summary: (i) => `Set outreach status of directory listing #${i.id} to "${i.status}".`,
			run: async ({ id, status }) => { const r = await dir.setOutreach(Number(id), { status }); return { ok: true, forModel: `Set ${r.name} to ${r.outreach_status}.` }; },
		},
		{
			name: 'add_prospect', kind: 'write',
			description: 'Adds a directory listing to the Customers board as a new prospect (type "new site").',
			input_schema: { type: 'object', properties: { id: { type: 'integer', description: 'Directory listing id' } }, required: ['id'] },
			summary: (i) => `Add directory listing #${i.id} to the Customers board as a new prospect.`,
			run: async ({ id }, who) => {
				const hit = (await dir._byId(Number(id))); if (!hit) throw new Error('No such directory listing.');
				let c; try { c = store.create({ name: hit.name, domain: hit.website || '', kind: 'new', contactEmail: hit.email || '', notes: `From the United Church directory: ${[hit.city, hit.province].filter(Boolean).join(', ')}` }, who); }
				catch (e) { c = store.create({ name: hit.name, domain: '', kind: 'new', contactEmail: hit.email || '', notes: `From the United Church directory: ${[hit.city, hit.province].filter(Boolean).join(', ')}` }, who); }
				await dir.setOutreach(Number(id), { status: 'to contact' });
				return { ok: true, forModel: `Added "${c.name}" to the board (id ${c.id}).` };
			},
		},
	];
	return tools;
}
