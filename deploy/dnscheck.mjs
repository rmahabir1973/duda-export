// Pure helpers: read DNS facts, classify them, and plan record changes. No network access in this file.

const lc = (s) => String(s || '').toLowerCase().replace(/\.$/, '');
const has = (list, re) => (list || []).some((x) => re.test(lc(x)));

export const CF_NS_RE = /\.ns\.cloudflare\.com$/;

/** Turn raw lookups into a plain-English picture of where a church's website, DNS and email live today. */
export function classifyDns(f, o = {}) {
	const dudaHosts = (o.dudaHosts || ['multiscreensite.com', 'dudaone.com', 'duda.co']).map(lc);
	const dudaIps = o.dudaIps || [];
	const hostingerIp = o.hostingerIp || '';
	const ourMx = (o.ourMxHosts || []).map(lc);
	const out = { dnsHost: 'unknown', web: 'none', email: 'none', spf: 'none', blockers: [], notes: [], warnings: [] };

	// DNS host (who answers for the domain)
	const ns = (f.ns || []).map(lc);
	const zoneNs = (o.zone && o.zone.name_servers ? o.zone.name_servers : []).map(lc);
	if (!ns.length) out.dnsHost = 'unknown';
	else if (zoneNs.length && ns.every((n) => zoneNs.includes(n))) out.dnsHost = 'ours';
	else if (ns.every((n) => CF_NS_RE.test(n))) out.dnsHost = o.zone ? 'cloudflare-pending' : 'cloudflare-other';
	else if (has(ns, /multiscreensite\.com$|dudaone\.com$/)) out.dnsHost = 'duda';
	else out.dnsHost = 'other';

	// Website
	const apexA = f.a || [];
	const wwwCname = (f.wwwCname || []).map(lc);
	const cnameDuda = wwwCname.some((c) => dudaHosts.some((h) => c === h || c.endsWith('.' + h)));
	const aDuda = apexA.some((ip) => dudaIps.includes(ip));
	if (cnameDuda || aDuda) out.web = 'duda';
	else if (hostingerIp && (apexA.includes(hostingerIp) || (f.wwwA || []).includes(hostingerIp))) out.web = 'ours';
	else if (apexA.length || wwwCname.length || (f.wwwA || []).length) out.web = 'other';
	if (out.web === 'other' && !dudaIps.length) out.notes.push('No Duda IP list is configured (DUDA_IPS), so a Duda-hosted site that uses A records would show as "other".');

	// Email
	const mx = (f.mx || []).map((m) => lc(m.exchange || m));
	if (mx.length) {
		if (mx.some((m) => ourMx.includes(m))) out.email = 'ours';
		else if (has(mx, /aspmx\.l\.google\.com$|googlemail\.com$/)) out.email = 'google';
		else if (has(mx, /mail\.protection\.outlook\.com$/)) out.email = 'microsoft';
		else out.email = 'other';
	}
	const spf = (f.txt || []).map((t) => (Array.isArray(t) ? t.join('') : t)).filter((t) => /^v=spf1\b/i.test(t));
	out.spf = spf.length === 0 ? 'none' : spf.length === 1 ? 'one' : 'duplicate';
	if (out.spf === 'duplicate') out.warnings.push('There is more than one SPF record. Mail providers treat that as an error, so the records must be merged into one.');

	// What this means
	if (out.dnsHost === 'ours') out.notes.push('The DNS already lives in our Cloudflare. Changes can be made directly.');
	if (out.dnsHost === 'cloudflare-other') out.blockers.push({ level: 'warn', text: 'The domain is on someone else\'s Cloudflare account. We cannot create the zone until they move or give us access.' });
	if (out.dnsHost === 'duda') out.blockers.push({ level: 'warn', text: 'DNS is hosted by Duda. The nameservers must be changed to ours at the registrar.' });
	if (out.dnsHost === 'other' || out.dnsHost === 'cloudflare-pending') out.blockers.push({ level: 'info', text: 'The customer (or whoever holds the registrar login) has to change the nameservers to ours. Stage 4 shows the exact pair to give them and detects the change.' });
	if (out.web === 'duda') out.notes.push('The live site is on Duda. Pointing the domain at the new site takes it off Duda, so only do it after the customer approves.');
	if (['google', 'microsoft', 'other'].includes(out.email)) out.blockers.push({ level: 'warn', text: 'The domain already receives email at ' + out.email + '. Do NOT change the MX records until the mailboxes are created and old mail is moved, or the church loses email.' });
	if (out.email === 'none') out.notes.push('No email is set up on this domain, so there is nothing to protect when we add ours.');
	return out;
}

/** Records needed so the apex and www point at the new web server. Never deletes; flags what would need to. */
export function planWebRecords({ domain, ip, existing = [], proxied = false }) {
	const plan = [];
	const find = (type, name) => existing.filter((r) => r.type === type && lc(r.name) === lc(name));
	const want = [{ type: 'A', name: domain, content: ip }, { type: 'CNAME', name: 'www.' + domain, content: domain }];
	for (const w of want) {
		const same = find(w.type, w.name);
		if (same.some((r) => lc(r.content) === lc(w.content))) { plan.push({ action: 'keep', ...w, note: 'already correct' }); continue; }
		if (same.length) plan.push({ action: 'update', id: same[0].id, ...w, proxied, was: same[0].content });
		else plan.push({ action: 'create', ...w, proxied });
	}
	// Records that conflict with the ones above and would have to be removed by a person.
	const conflicts = [
		...find('AAAA', domain), ...find('AAAA', 'www.' + domain),
		...find('A', 'www.' + domain), ...find('CNAME', domain),
	].map((r) => ({ action: 'needs-approval-delete', id: r.id, type: r.type, name: r.name, content: r.content, note: 'Conflicts with the new records. Not removed automatically.' }));
	return [...plan, ...conflicts];
}

/** One SPF record that covers every sender. Keeps what is already there, adds what is missing, never duplicates. */
export function mergeSpf(existing, { includes = [], hosts = [], ip4 = [] } = {}) {
	const list = (Array.isArray(existing) ? existing : [existing]).filter(Boolean).map((t) => (Array.isArray(t) ? t.join('') : t)).filter((t) => /^v=spf1\b/i.test(t));
	const terms = [];
	let all = '~all';
	for (const rec of list) {
		for (const tok of rec.trim().split(/\s+/).slice(1)) {
			if (/^[-~+?]?all$/i.test(tok)) { all = tok.toLowerCase(); continue; }
			if (/^redirect=/i.test(tok)) { terms.push(tok); continue; }
			if (!terms.some((t) => t.toLowerCase() === tok.toLowerCase())) terms.push(tok);
		}
	}
	const add = (tok) => { if (!terms.some((t) => t.toLowerCase() === tok.toLowerCase())) terms.push(tok); };
	includes.forEach((i) => add('include:' + i));
	hosts.forEach((h) => add('a:' + h));
	ip4.forEach((i) => add('ip4:' + i));
	const rec = ['v=spf1', ...terms, all].join(' ');
	const lookups = terms.filter((t) => /^(include:|a:|mx|a$|ptr|exists:|redirect=)/i.test(t)).length;
	return { record: rec, changed: list.length !== 1 || list[0].trim().replace(/\s+/g, ' ') !== rec, lookups, tooManyLookups: lookups > 10, merged: list.length > 1 };
}

/** DNS records Postmark asks for, turned into a plan against what already exists. */
export function planPostmarkRecords({ domain, pm, existing = [] }) {
	const wants = [];
	const dkimHost = pm.DKIMHost || pm.DKIMPendingHost;
	const dkimVal = pm.DKIMTextValue || pm.DKIMPendingTextValue;
	if (dkimHost && dkimVal) wants.push({ type: 'TXT', name: dkimHost.includes(domain) ? dkimHost : `${dkimHost}.${domain}`, content: dkimVal });
	if (pm.ReturnPathDomain && pm.ReturnPathDomainCNAMEValue) wants.push({ type: 'CNAME', name: pm.ReturnPathDomain, content: pm.ReturnPathDomainCNAMEValue });
	return wants.map((w) => {
		const same = existing.filter((r) => r.type === w.type && lc(r.name) === lc(w.name));
		const norm = (v) => String(v).replace(/^"|"$/g, '');
		if (same.some((r) => norm(r.content) === norm(w.content))) return { action: 'keep', ...w, note: 'already there' };
		if (same.length) return { action: 'update', id: same[0].id, ...w, was: same[0].content };
		return { action: 'create', ...w };
	});
}

/** Mail records for our own SmarterMail server. MX is only touched when explicitly asked (cutover). */
export function planMailRecords({ domain, mailHost, existing = [], cutoverMx = false, spf, dmarcRua }) {
	const plan = [];
	const same = (type, name) => existing.filter((r) => r.type === type && lc(r.name) === lc(name));
	if (cutoverMx) {
		const mx = same('MX', domain);
		if (mx.some((r) => lc(r.content) === lc(mailHost))) plan.push({ action: 'keep', type: 'MX', name: domain, content: mailHost, priority: 10 });
		else plan.push({ action: 'create', type: 'MX', name: domain, content: mailHost, priority: 10 });
		if (mx.some((r) => lc(r.content) !== lc(mailHost))) plan.push({ action: 'needs-approval-delete', note: 'Old MX records must be removed by a person, after the mailboxes are ready.', type: 'MX', name: domain, content: mx.map((r) => r.content).join(', ') });
	}
	if (spf) {
		const rec = same('TXT', domain).filter((r) => /^"?v=spf1/i.test(r.content));
		const val = spf.record;
		if (rec.length === 1 && rec[0].content.replace(/^"|"$/g, '') === val) plan.push({ action: 'keep', type: 'TXT', name: domain, content: val });
		else if (rec.length >= 1) plan.push({ action: 'update', id: rec[0].id, type: 'TXT', name: domain, content: val, was: rec[0].content, note: rec.length > 1 ? 'Merges ' + rec.length + ' SPF records into one; the extra ones need removing by a person.' : undefined });
		else plan.push({ action: 'create', type: 'TXT', name: domain, content: val });
		for (const extra of rec.slice(1)) plan.push({ action: 'needs-approval-delete', id: extra.id, type: 'TXT', name: domain, content: extra.content, note: 'Duplicate SPF record.' });
	}
	if (dmarcRua && !same('TXT', '_dmarc.' + domain).length) plan.push({ action: 'create', type: 'TXT', name: '_dmarc.' + domain, content: `v=DMARC1; p=none; rua=mailto:${dmarcRua}` });
	return plan;
}
