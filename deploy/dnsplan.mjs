// What the portal will put in DNS for a customer, worked out without changing anything. Pure: give it facts, get a list of lines back.
import { mergeSpf } from './dnscheck.mjs';
const lc = (s) => String(s || '').toLowerCase().replace(/\.$/, '');

/**
 * domain: the church's real domain. existing: records already in our Cloudflare zone for it (empty when the zone isn't there yet).
 * inventory: the church's current public DNS (used to copy their records when our zone is still empty).
 * Each line: { type, name, content, priority?, proxy, action, was?, note? }. action: create, keep, copy, replace or later.
 * The website and www are proxied (switched on after the certificate is issued); mail records never are.
 */
export function buildDnsPlan({ domain, hostingerIp, email = false, mailIp = '', autodiscover = '', autoconfig = '', existing = [], inventory = [], dmarcRua = '' }) {
	const d = lc(domain), www = 'www.' + d, mail = 'mail.' + d;
	const src = existing.length ? existing : inventory;
	const at = (list, type, name) => list.filter((r) => r.type === type && lc(r.name) === lc(name));
	const lines = [], handled = new Set();
	const mark = (r) => handled.add(`${r.type}|${lc(r.name)}|${lc(r.content)}`);
	const want = (type, name, content, extra = {}) => {
		const have = at(existing, type, name).some((r) => lc(r.content) === lc(content));
		lines.push({ type, name, content, proxy: false, action: have ? 'keep' : 'create', ...extra });
	};
	const replaceOld = (type, name, content) => { for (const r of at(src, type, name)) if (lc(r.content) !== lc(content)) { lines.push({ type: r.type, name: r.name, content: r.content, proxy: false, action: 'replace', was: r.content, note: 'The old record is not copied: the new one takes its place.' }); mark(r); } else mark(r); };

	// the website
	if (hostingerIp) {
		want('A', d, hostingerIp, { proxy: true });
		replaceOld('A', d, hostingerIp); replaceOld('AAAA', d, '');
		want('CNAME', www, d, { proxy: true });
		replaceOld('A', www, ''); replaceOld('AAAA', www, ''); replaceOld('CNAME', www, d);
	}
	// email hosted with us: the mail server's name, the setup helpers, and the MX (which only switches once the mailboxes are ready)
	if (email) {
		if (mailIp) { want('A', mail, mailIp); replaceOld('A', mail, mailIp); }
		if (autodiscover) { want('CNAME', 'autodiscover.' + d, autodiscover); replaceOld('CNAME', 'autodiscover.' + d, autodiscover); }
		if (autoconfig) { want('CNAME', 'autoconfig.' + d, autoconfig); replaceOld('CNAME', 'autoconfig.' + d, autoconfig); }
		const mxHave = at(existing, 'MX', d).some((r) => lc(r.content) === mail);
		lines.push({ type: 'MX', name: d, content: mail, priority: 10, proxy: false, action: mxHave ? 'keep' : 'later', note: mxHave ? '' : 'Switched on once the mailboxes are ready, so no mail is lost.' });
		for (const r of at(src, 'MX', d)) if (lc(r.content) !== mail) { mark(r); lines.push({ type: 'MX', name: d, content: r.content, priority: r.priority, proxy: false, action: 'copy', note: 'Kept until the email switch, then removed by a person.' }); } else mark(r);
	}
	// sending authentication: one SPF record that covers everyone, and DMARC
	const oldSpf = at(src, 'TXT', d).filter((r) => /^"?v=spf1/i.test(r.content));
	const spf = mergeSpf(oldSpf.map((r) => r.content.replace(/^"|"$/g, '')), { includes: ['spf.mtasv.net'], hosts: email ? [mail] : [] });
	const spfHave = at(existing, 'TXT', d).some((r) => r.content.replace(/^"|"$/g, '') === spf.record);
	oldSpf.forEach(mark);
	lines.push({ type: 'TXT', name: d, content: spf.record, proxy: false, action: spfHave ? 'keep' : oldSpf.length ? 'replace' : 'create', was: oldSpf.length && !spfHave ? oldSpf[0].content : undefined, note: spf.tooManyLookups ? 'Too many SPF lookups: needs a person to tidy.' : 'One SPF record that includes Postmark' + (email ? ' and our mail server.' : '.') });
	const dm = at(src, 'TXT', '_dmarc.' + d);
	if (dm.length) { dm.forEach(mark); lines.push({ type: 'TXT', name: '_dmarc.' + d, content: dm[0].content, proxy: false, action: existing.length ? 'keep' : 'copy' }); }
	else if (dmarcRua) lines.push({ type: 'TXT', name: '_dmarc.' + d, content: `v=DMARC1; p=none; rua=mailto:${dmarcRua}`, proxy: false, action: 'create' });
	// everything else they have today is copied as it is (only while our zone is still empty)
	if (!existing.length) for (const r of inventory) if (!handled.has(`${r.type}|${lc(r.name)}|${lc(r.content)}`)) lines.push({ type: r.type, name: r.name, content: r.content, priority: r.priority, proxy: false, action: 'copy' });
	return lines;
}

export const planCounts = (lines) => lines.reduce((o, l) => { o[l.action] = (o[l.action] || 0) + 1; return o; }, {});
