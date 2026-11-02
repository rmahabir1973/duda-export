// What the portal assistant can look at and do. "read" tools run at once. "write" tools only ever run after a person presses Approve.
import { STAGES, stageByKey, reqOf, blockedBy, testStage, fixReq, reqsFor, stageSkipped, isSatisfied, kindOf } from '../deploy/checks.mjs';
import { configured, randomPassword } from '../deploy/clients.mjs';
import { healthCheck } from '../deploy/email.mjs';
import { normDomain, DOMAIN_RE } from '../deploy/store.mjs';

const trim = (s, n = 400) => String(s ?? '').slice(0, n);
const MAIL_RE = /^([a-z0-9][a-z0-9._-]{0,63})@((?:[a-z0-9-]+\.)+[a-z]{2,})$/;

export function buildTools({ store, clients, dir, outreach, audit }) {
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
		{ name: 'outreach_stats', kind: 'read', description: 'Prospect email results for the last 30 days (sent, delivered, opened, clicked, bounced, unsubscribed) and today\'s sending allowance.', input_schema: { type: 'object', properties: {} }, run: async () => (outreach ? outreach.stats() : { error: 'Outreach is not set up.' }) },

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
