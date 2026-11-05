// What the portal will put in DNS for a customer, worked out without changing anything. Pure: give it facts, get a list of lines back.
import { mergeSpf } from './dnscheck.mjs';
const lc = (s) => String(s || '').toLowerCase().replace(/\.$/, '');

export const CANONICAL_DMARC = 'v=DMARC1; p=quarantine; pct=100';
/** The old brand's reporting mailbox and SPF include. Nothing new should point at them. */
const LEGACY = /churchwebsupport\.com/i;

/**
 * domain: the church's real domain. existing: records already in our Cloudflare zone for it (empty when the zone isn't there yet).
 * inventory: the church's current public DNS (used to copy their records when our zone is still empty).
 * Each line: { type, name, content, priority?, proxy, action, was?, note? }. action: create, keep, copy, replace or later.
 *
 * Email with us (the standard set, the same for every church):
 *   A mail -> mail server, MX @ -> mail.<domain> (10), CNAME autodiscover and autoconfig -> mail.<domain>,
 *   TXT SPF "v=spf1 ip4:<mail server> ~all", TXT _dmarc "v=DMARC1; p=quarantine; pct=100", and the DKIM record SmarterMail generates.
 * Email not with us: their mail records are left exactly as they are (a strict DMARC on someone else's mail could send it to spam).
 * The website and www are proxied (switched on after the certificate is issued); mail records never are.
 */
export function buildDnsPlan({ domain, hostingerIp, email = false, mailIp = '', existing = [], inventory = [], dmarc = CANONICAL_DMARC }) {
	const d = lc(domain), www = 'www.' + d, mail = 'mail.' + d;
	const src = existing.length ? existing : inventory;
	const at = (list, type, name) => list.filter((r) => r.type === type && lc(r.name) === lc(name));
	const lines = [], handled = new Set();
	const mark = (r) => handled.add(`${r.type}|${lc(r.name)}|${lc(r.content)}`);
	const want = (type, name, content, extra = {}) => {
		const have = at(existing, type, name).some((r) => lc(r.content) === lc(content));
		const hit = at(existing, type, name).find((r) => lc(r.content) === lc(content));
		lines.push({ type, name, content, proxy: false, action: have ? 'keep' : 'create', ...(hit ? { id: hit.id } : {}), ...extra });
	};
	const replaceOld = (type, name, content) => { for (const r of at(src, type, name)) { if (lc(r.content) !== lc(content)) lines.push({ type: r.type, name: r.name, content: r.content, proxy: false, action: 'replace', was: r.content, id: r.id, removable: !!r.id, note: 'The old record is not copied: the new one takes its place.' }); mark(r); } };

	// the website
	if (hostingerIp) {
		want('A', d, hostingerIp, { proxy: true });
		replaceOld('A', d, hostingerIp); replaceOld('AAAA', d, '');
		want('CNAME', www, d, { proxy: true });
		replaceOld('A', www, ''); replaceOld('AAAA', www, ''); replaceOld('CNAME', www, d);
	}
	// email hosted with us: the standard set
	if (email) {
		if (mailIp) { want('A', mail, mailIp); replaceOld('A', mail, mailIp); }
		for (const n of ['autodiscover', 'autoconfig']) { want('CNAME', `${n}.${d}`, mail); replaceOld('CNAME', `${n}.${d}`, mail); replaceOld('A', `${n}.${d}`, ''); }
		const mxHave = at(existing, 'MX', d).some((r) => lc(r.content) === mail), mxToday = at(src, 'MX', d).some((r) => lc(r.content) === mail);
		lines.push({ type: 'MX', name: d, content: mail, priority: 10, proxy: false, action: mxHave ? 'keep' : mxToday ? 'copy' : 'create', note: '' });
		for (const r of at(src, 'MX', d)) { mark(r); if (lc(r.content) !== mail) lines.push({ type: 'MX', name: d, content: r.content, priority: r.priority, proxy: false, action: existing.length ? 'keep' : 'copy', id: r.id, removable: !!existing.length, note: 'An old mail route.' }); }
		// SPF: keep what else they send from, drop the old brand's include, add our mail server
		const oldSpf = at(src, 'TXT', d).filter((r) => /^"?v=spf1/i.test(r.content));
		const spf = mergeSpf(oldSpf.map((r) => r.content.replace(/^"|"$/g, '').split(/\s+/).filter((t) => !LEGACY.test(t)).join(' ')), { ip4: mailIp ? [mailIp] : [] });
		const spfHave = at(existing, 'TXT', d).some((r) => r.content.replace(/^"|"$/g, '') === spf.record);
		oldSpf.forEach(mark);
		lines.push({ type: 'TXT', name: d, content: spf.record, proxy: false, action: spfHave ? 'keep' : oldSpf.length ? 'replace' : 'create', was: oldSpf.length && !spfHave ? oldSpf[0].content : undefined, id: oldSpf.length && !spfHave ? oldSpf[0].id : undefined, note: spf.tooManyLookups ? 'Too many SPF lookups: needs a person to tidy.' : '' });
		// DMARC: the standard one, unless the church already has its own that reports somewhere of theirs. The old brand's report address is dropped (nobody reads it).
		const dm = at(src, 'TXT', '_dmarc.' + d), own = dm.find((r) => !LEGACY.test(r.content));
		dm.forEach(mark);
		if (own) lines.push({ type: 'TXT', name: '_dmarc.' + d, content: own.content, proxy: false, action: existing.length ? 'keep' : 'copy', note: 'Their own DMARC policy is kept.' });
		else lines.push({ type: 'TXT', name: '_dmarc.' + d, content: dmarc, proxy: false, action: at(existing, 'TXT', '_dmarc.' + d).some((r) => r.content.replace(/^"|"$/g, '') === dmarc) ? 'keep' : dm.length ? 'replace' : 'create', was: dm[0]?.content, id: dm[0]?.id, note: dm.length ? 'Replaces the old policy that mailed reports to the old brand\'s postmaster box.' : '' });
		// DKIM: SmarterMail makes the key once the domain exists, so it can only be added then
		lines.push({ type: 'TXT', name: `<selector>._domainkey.${d}`, content: 'The key SmarterMail generates for this domain', proxy: false, action: 'later', note: 'Added once SmarterMail has made the key (Email setup).' });
	}
	// everything else they have today is copied as it is (only while our zone is still empty)
	if (!existing.length) for (const r of inventory) if (!handled.has(`${r.type}|${lc(r.name)}|${lc(r.content)}`)) lines.push({ type: r.type, name: r.name, content: r.content, priority: r.priority, proxy: false, action: 'copy' });
	// records already in our zone that are not part of the standard set: show them, and let a person remove the ones that don't belong
	if (existing.length) {
		const known = new Set(lines.map((l) => `${l.type}|${lc(l.name)}|${lc(l.content)}`));
		for (const r of existing) {
			if (['NS', 'SOA', 'CAA'].includes(r.type) || known.has(`${r.type}|${lc(r.name)}|${lc(r.content)}`) || handled.has(`${r.type}|${lc(r.name)}|${lc(r.content)}`)) continue;
			lines.push({ type: r.type, name: r.name, content: r.content, priority: r.priority, proxy: false, action: 'keep', id: r.id, removable: true, note: 'Not part of the standard set.' });
		}
	}
	return lines;
}

/**
 * Turn the plan into the changes to make in Cloudflare. A new record that replaces a wrong one at the same name is an update in place (so nothing is ever deleted);
 * a stray record that nothing replaces is left for a person. 'later' lines and records still only in the church's current DNS are not written here.
 */
export function planOps(lines) {
	const key = (l) => `${l.type}|${lc(l.name)}`, olds = new Map(), ops = [], flagged = [];
	for (const l of lines) if (l.action === 'replace' && l.id && l.content === l.was) { l.removable = true; const k = key(l); olds.set(k, [...(olds.get(k) || []), l]); }
	for (const l of lines) {
		const wanted = l.action === 'create' || l.action === 'copy' || (l.action === 'replace' && l.content !== l.was);
		if (!wanted) continue;
		const body = { type: l.type, name: l.name, content: l.content, ...(l.priority != null ? { priority: l.priority } : {}) };
		const old = (olds.get(key(l)) || []).shift();
		const id = l.id || old?.id;
		ops.push(id ? { op: 'update', id, ...body } : { op: 'create', ...body });
	}
	for (const rest of olds.values()) for (const r of rest) flagged.push(`${r.type} ${r.name} → ${r.content}: remove by hand in Cloudflare (it would send people to the old place)`);
	return { ops, flagged };
}

export const planCounts = (lines) => lines.reduce((o, l) => { o[l.action] = (o[l.action] || 0) + 1; return o; }, {});
