// The email setup flow: 1) domain + mailboxes on SmarterMail, 2) Postmark for outbound mail, 3) health check, 4) test email.
// Nothing here stores or logs a password.
import { DOMAIN_RE, normDomain } from './store.mjs';
import { STAGES, reqOf, fixReq, depMet, isSatisfied } from './checks.mjs';

const item = (id, label, state, detail = '') => ({ id, label, state, detail });
const LOCAL_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const mask = (text, secrets) => secrets.filter(Boolean).reduce((t, s) => String(t).split(s).join('••••'), String(text));

/** Parse and validate what was typed into the form. Throws a plain-English Error. */
export function parseInput({ domain, addresses, password }, { needPassword = true } = {}) {
	const d = normDomain(domain);
	if (!DOMAIN_RE.test(d)) throw new Error('Enter the church\'s domain, for example britanniaunited.ca.');
	const list = [...new Set(String(Array.isArray(addresses) ? addresses.join('\n') : addresses || '').split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean).map((x) => {
		if (x.includes('@')) { const [l, dom] = x.split('@'); if (dom !== d) throw new Error(`"${x}" isn't on ${d}.`); return l; }
		return x;
	}))];
	for (const l of list) if (!LOCAL_RE.test(l)) throw new Error(`"${l}" isn't a valid mailbox name (letters, numbers, dots, dashes).`);
	if (list.length > 25) throw new Error('At most 25 mailboxes at a time.');
	if (needPassword) {
		if (!list.length) throw new Error('Enter at least one email address to create.');
		const p = String(password || '');
		if (p.length < 12) throw new Error('The default password must be at least 12 characters.');
		if (!/[a-z]/.test(p) || !/[A-Z]/.test(p) || !/\d/.test(p) || !/[^A-Za-z0-9]/.test(p)) throw new Error('The default password needs a capital letter, a small letter, a number and a symbol.');
		if (list.some((l) => p.toLowerCase().includes(l))) throw new Error('The default password must not contain a mailbox name.');
	}
	return { domain: d, names: list, password: String(password || '') };
}

/** Step 1: the domain and the mailboxes on our SmarterMail server. With dry=true it only says what it would do. */
export async function createMailboxes(ctx, input, { dry = false } = {}) {
	const sm = ctx.c.smartermail, cfg = ctx.c.cfg, out = [], secrets = [input.password];
	if (!sm.available()) return [item('sm', 'SmarterMail isn\'t connected to this server', 'no', 'Set SMARTERMAIL_URL, SMARTERMAIL_ADMIN_USER and SMARTERMAIL_ADMIN_PASSWORD in Railway.')];
	const adminUser = cfg.smartermailDomainAdmin;
	if (dry) {
		out.push(item('domain', `Create the domain ${input.domain} on ${cfg.smartermailUrl}`, 'info', `Folder: ${sm.domainPath(input.domain)}\nFirst administrator: ${adminUser}@${input.domain}`));
		for (const n of input.names) out.push(item('box:' + n, `Create ${n}@${input.domain}`, 'info', 'With the default password you entered.'));
		return out;
	}
	let sys;
	try { sys = await sm.sysLogin(); } catch (e) { return [item('login', 'Couldn\'t sign in to SmarterMail', 'error', mask(e.message, secrets))]; }
	const d = await sm.addDomain(sys, { domain: input.domain, adminUsername: adminUser, adminPassword: input.password });
	if (!d.ok) {
		const hint = /path|folder|director/i.test(d.error || '') ? ' The folder SmarterMail stores domains in may be different on your server: set SMARTERMAIL_DOMAIN_PATH in Railway (for example D:\\Mail\\Domains\\{domain}).' : '';
		return [item('domain', `Couldn't create ${input.domain}`, 'error', mask(d.error, secrets) + hint)];
	}
	out.push(item('domain', d.exists ? `${input.domain} already exists on the mail server` : `Created ${input.domain} on the mail server`, 'ok', d.exists ? 'Mailboxes will be added to it.' : `Administrator: ${adminUser}@${input.domain} (same default password)`));
	let domainToken = null;
	for (const n of input.names) {
		let r = await sm.addUser(sys, { domain: input.domain, userName: n, password: input.password });
		if (!r.ok && [401, 403].includes(r.status)) { // some servers only let a domain administrator add users
			try { domainToken ||= await sm.login(`${adminUser}@${input.domain}`, input.password); r = await sm.addUser(domainToken, { domain: input.domain, userName: n, password: input.password }); }
			catch (e) { r = { ok: false, error: e.message }; }
		}
		out.push(r.ok ? item('box:' + n, `${n}@${input.domain}`, 'ok', r.exists ? 'Already existed (password not changed).' : 'Created.') : item('box:' + n, `${n}@${input.domain}`, 'error', mask(r.error, secrets)));
	}
	return out;
}

/** Step 2: Postmark for outbound mail: the domain at Postmark, its DNS records, SPF + DMARC, and verification. */
export async function enablePostmark(ctx, domain, { dry = false } = {}) {
	const stage = STAGES.find((s) => s.key === 'sending');
	const ch = { slug: '', domain, plan: 'email', name: domain, stages: {}, mailboxes: [] };
	const out = [], results = {};
	for (const id of ['pm', 'pmdns', 'auth', 'verified']) {
		const q = reqOf(stage, id);
		if ((q.deps || []).some((d) => !depMet(results[d]?.state))) { out.push(item(id, q.label, 'blocked', 'Waiting for the item before it.')); results[id] = { state: 'blocked' }; continue; }
		let r; try { r = await q.test.call(q, ctx, ch); } catch (e) { r = { state: 'error', detail: e.message }; }
		if (r.state === 'no' && q.fix) {
			if (dry) { out.push(item(id, q.label, 'info', `Would: ${q.fixLabel || 'fix it'}.\n${r.detail || ''}`)); results[id] = { state: 'ok' }; continue; }
			const f = await fixReq(ctx, ch, stage, q, r);
			if (f.ok) { ctx.memo = {}; try { r = await q.test.call(q, ctx, ch); } catch (e) { r = { state: 'error', detail: e.message }; } r.detail = [f.detail, r.detail].filter(Boolean).join('\n'); }
			else r = { state: 'error', detail: f.detail || f.howTo || 'Couldn\'t fix it.' };
		}
		results[id] = r; out.push(item(id, q.label, r.state, r.detail || ''));
	}
	return out;
}

/** Step 3: an "MX toolbox" style look at the domain's mail DNS and the server. Read-only. */
export async function healthCheck(ctx, domain) {
	const { dns, tls, probe, cfg } = ctx.c, host = cfg.mailHost, out = [];
	const txt = async (n) => (await dns.txt(n)).map((t) => (Array.isArray(t) ? t.join('') : t));
	const mx = (await dns.mx(domain)).sort((a, b) => a.priority - b.priority).map((m) => String(m.exchange).toLowerCase().replace(/\.$/, ''));
	out.push(!mx.length ? item('mx', 'MX records (where email is delivered)', 'no', 'None. Nobody can send email to this domain.') : mx.some((h) => (cfg.ourMxHosts || [host]).includes(h) || h === 'mail.' + domain) ? item('mx', 'MX records point at our mail server', 'ok', mx.join(', ')) : item('mx', 'MX records point somewhere else', 'warn', mx.join(', ') + `\nOurs is mail.${domain}. Fine if the church still uses another provider for now.`));
	const ips = await dns.a(host);
	out.push(ips.length ? item('mxhost', `${host} resolves`, 'ok', ips.join(', ')) : item('mxhost', `${host} doesn't resolve`, 'no', 'The mail server name has no address in DNS.'));
	for (const ip of ips.slice(0, 1)) { const ptr = (await dns.ptr(ip).catch(() => [])).map((x) => x.toLowerCase().replace(/\.$/, '')); out.push(ptr.includes(host) ? item('ptr', 'Reverse DNS matches the mail server name', 'ok', ptr.join(', ')) : item('ptr', 'Reverse DNS doesn\'t match', ptr.length ? 'warn' : 'info', (ptr.join(', ') || 'No reverse record') + '\nSet at the hosting provider of the mail server. Receivers like Gmail check it for outgoing mail.')); }
	for (const [port, name] of [[587, 'Sending (SMTP submission)'], [993, 'Reading mail (IMAP over SSL)']]) { const p = await probe(host, port); out.push(p.open ? item('p' + port, `${name}: port ${port} open`, 'ok') : item('p' + port, `${name}: port ${port} didn't answer`, 'warn', (p.error || '') + '\nIf you know the port is open, this server may be blocked from reaching it.')); }
	const cert = await tls(host); out.push(cert.authorized ? item('cert', 'Mail server certificate is valid', 'ok', 'Until ' + cert.validTo) : item('cert', 'Mail server certificate problem', 'warn', cert.error || ''));
	const spf = (await txt(domain)).filter((t) => /^v=spf1\b/i.test(t));
	if (!spf.length) out.push(item('spf', 'SPF record', 'no', 'None. Mail from this domain is more likely to land in spam.'));
	else if (spf.length > 1) out.push(item('spf', 'SPF record', 'no', `${spf.length} SPF records. There must be exactly one.`));
	else out.push(/include:spf\.mtasv\.net/.test(spf[0]) ? item('spf', 'SPF includes Postmark', 'ok', spf[0]) : item('spf', 'SPF doesn\'t include Postmark', 'warn', spf[0] + '\nRun "Enable Postmark" to add it.'));
	const dmarc = (await txt('_dmarc.' + domain)).filter((t) => /^v=DMARC1/i.test(t));
	out.push(dmarc.length ? item('dmarc', 'DMARC record', 'ok', dmarc[0]) : item('dmarc', 'DMARC record', 'warn', 'None. Recommended: Gmail and Yahoo expect one from domains that send email.'));
	if (ctx.c.postmark.available()) {
		try { const d = await ctx.c.postmark.domainByName(domain); if (!d) out.push(item('pm', 'Postmark domain', 'warn', 'Not set up in Postmark yet.')); else { const x = await ctx.c.postmark.domain(d.ID); out.push(item('dkim', 'Postmark DKIM (signs outgoing mail)', x.DKIMVerified ? 'ok' : 'no', x.DKIMVerified ? 'Verified.' : 'Not verified yet. DNS can take a few minutes after the records are added.'), item('rp', 'Postmark Return-Path (bounces)', x.ReturnPathDomainVerified ? 'ok' : 'no', x.ReturnPathDomainVerified ? 'Verified.' : 'Not verified yet.')); } }
		catch (e) { out.push(item('pm', 'Postmark', 'error', e.message)); }
	}
	for (const [n, label] of [['autodiscover', 'Autodiscover (Outlook setup)'], ['autoconfig', 'Autoconfig (Thunderbird setup)']]) { const c = await dns.cname(`${n}.${domain}`); const a = c.length ? c : await dns.a(`${n}.${domain}`); out.push(a.length ? item(n, label, 'ok', a.join(', ')) : item(n, label, 'info', 'Not set. Optional: email apps then need manual server settings.')); }
	return out;
}

/** Step 4: send one real test message through Postmark. */
export async function sendTest(ctx, domain, to) {
	if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(to || ''))) throw new Error('Enter an email address to send the test to.');
	if (!ctx.c.cfg.postmarkServerToken) throw new Error('POSTMARK_SERVER_TOKEN isn\'t set on this server.');
	const r = await ctx.c.postmark.sendEmail({ From: `test@${domain}`, To: to, Subject: `Test email from ${domain}`, TextBody: `This is a test sent through Postmark for ${domain}. If you can read it, outgoing email for the domain is working.\nCheck that it arrived in the inbox, not in spam.`, MessageStream: 'outbound' });
	return [item('send', `Test email sent to ${to}`, 'ok', `Postmark accepted it (id ${r.MessageID || 'n/a'}). Check the inbox and the spam folder.`)];
}
export const stateOk = isSatisfied;
