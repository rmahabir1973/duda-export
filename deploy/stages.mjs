// The deployment stages. Each stage has a Check (reads only), a Run (does the work; dry-run first), and a Test.
// Anything not automated yet is a manual tick-box, so staff can already work through the whole process.
import { classifyDns, planWebRecords, mergeSpf, planPostmarkRecords, planMailRecords } from './dnscheck.mjs';
import { shq, randomPassword } from './clients.mjs';

const item = (id, label, status, detail = '', secret = false) => (secret ? { id, label, status, detail, secret: true } : { id, label, status, detail });
const sum = (items) => ({ ok: !items.some((i) => ['fail', 'error'].includes(i.status)), items });
const tempHost = (ch, cfg) => `${ch.slug}.${cfg.previewDomain}`;
const sitePath = (cfg, host) => cfg.siteRoot.replace('{host}', host);
const mask = (cmd, secrets) => secrets.reduce((s, x) => (x ? s.split(x).join('••••••') : s), cmd);

/** A WP-CLI command line that runs inside one site's folder. */
const wpIn = (cfg, host, args) => `cd ${sitePath(cfg, host)} && ${cfg.wpCli} ${args}`;

async function runSsh(ctx, cmds, { dry, secrets = [] }) {
	const items = [];
	const ssh = ctx.c.ssh;
	for (const [id, label, cmd] of cmds) {
		const shown = mask(cmd, secrets);
		if (dry) { items.push(item(id, label, 'planned', shown)); continue; }
		if (!ssh.available()) { items.push(item(id, label, 'manual', 'SSH is not set up on this server. Run this on the Hostinger SSH session:\n' + shown)); continue; }
		try {
			const r = await ssh.exec(cmd);
			items.push(item(id, label, r.code === 0 ? 'done' : 'error', mask((r.out + '\n' + r.err).trim().slice(-400), secrets)));
		} catch (e) { items.push(item(id, label, 'error', e.message)); }
	}
	return items;
}

async function cfRecordsApply(ctx, zoneId, plan, dry) {
	const items = [];
	for (const p of plan) {
		const text = `${p.type} ${p.name} → ${p.content}${p.priority ? ' (priority ' + p.priority + ')' : ''}${p.was ? ' (was ' + p.was + ')' : ''}`;
		if (p.action === 'keep') { items.push(item('rec', text, 'pass', 'already correct')); continue; }
		if (p.action === 'needs-approval-delete') { items.push(item('rec', `${p.type} ${p.name} → ${p.content}`, 'warn', p.note || 'Conflicts. A person must remove this one by hand in Cloudflare.')); continue; }
		if (dry) { items.push(item('rec', text, 'planned', p.action === 'create' ? 'will be added' : 'will be changed')); continue; }
		try {
			const body = { type: p.type, name: p.name, content: p.content, proxied: !!p.proxied, ...(p.priority ? { priority: p.priority } : {}) };
			if (p.action === 'create') await ctx.c.cloudflare.createRecord(zoneId, body); else await ctx.c.cloudflare.updateRecord(zoneId, p.id, body);
			items.push(item('rec', text, 'done', p.action === 'create' ? 'added' : 'changed'));
		} catch (e) { items.push(item('rec', text, 'error', e.message)); }
	}
	return items;
}

async function dnsFacts(ctx, domain) {
	const d = ctx.c.dns;
	const [ns, a, aaaa, wwwA, wwwCname, mx, txt] = await Promise.all([d.ns(domain), d.a(domain), d.aaaa(domain), d.a('www.' + domain), d.cname('www.' + domain), d.mx(domain), d.txt(domain)]);
	return { ns, a, aaaa, wwwA, wwwCname, mx, txt };
}
const zoneOf = async (ctx, domain) => (ctx.c.cloudflare.available() ? ctx.c.cloudflare.zoneByName(domain) : null);

export const STAGES = [
	/* ------------------------------------------------------------------ 1 */
	{
		key: 'preview', n: 1, title: 'Create the preview site', needs: [],
		blurb: 'A copy of the template at {slug}.churchwebglobal.com with its AI Assistant key, the church name and preview mode on.',
		manual: [{ id: 'clone', label: (ch, cfg) => `In hPanel, create the subdomain ${tempHost(ch, cfg)} and copy the template site (${cfg.templateSlug}.${cfg.previewDomain}) into it.` }],
		async check(ctx, ch) {
			const cfg = ctx.c.cfg, host = tempHost(ch, cfg), items = [];
			const a = await ctx.c.dns.a(host);
			items.push(!a.length ? item('dns', `${host} does not resolve yet`, ctx.c.cfg.hostingerIp ? 'fail' : 'warn', 'Run this stage to add the DNS record, or add it in Cloudflare.')
				: cfg.hostingerIp && !a.includes(cfg.hostingerIp) ? item('dns', `${host} resolves to ${a.join(', ')}`, 'warn', `Expected ${cfg.hostingerIp}. Fine if it is proxied through Cloudflare.`) : item('dns', `${host} resolves`, 'pass', a.join(', ')));
			const r = await ctx.c.http.get(`https://${host}/`);
			if (!r.status) items.push(item('http', 'The preview site does not answer', 'fail', r.error || 'no response'));
			else {
				items.push(r.status === 200 ? item('http', 'The preview site loads', 'pass', 'HTTP 200') : item('http', `The preview site answered HTTP ${r.status}`, 'warn', r.location ? 'Redirects to ' + r.location : ''));
				const noindex = /noindex/i.test(r.headers['x-robots-tag'] || '') || /<meta[^>]+name=["']robots["'][^>]*noindex/i.test(r.text);
				items.push(noindex ? item('preview', 'Preview mode is on (not indexed by search engines)', 'pass') : item('preview', 'Preview mode looks OFF: search engines could index this copy', 'fail', 'Run this stage, or turn it on at AI Assistant → Go live.'));
				items.push(r.text.toLowerCase().includes(ch.name.toLowerCase()) ? item('name', 'The church name appears on the page', 'pass') : item('name', 'The church name does not appear on the home page yet', 'warn', 'Expected until the Assistant has built the site.'));
				items.push(/wp-content\/plugins\/churchweb-ai-assistant|cwai/i.test(r.text) ? item('plugin', 'The AI Assistant plugin is loaded', 'pass') : item('plugin', 'Could not see the AI Assistant on the page', 'info', 'It only shows to signed-in staff, so this can be normal.'));
			}
			if (ctx.c.gateway.available()) {
				try {
					const m = await ctx.c.gateway.mint(ch.slug);
					items.push(m.revoked ? item('token', 'The gateway has this site switched OFF', 'fail') : (await ctx.c.gateway.tokenWorks(m.token)) ? item('token', 'The AI Assistant key is valid at the gateway', 'pass') : item('token', 'The gateway does not accept the key', 'fail'));
				} catch (e) { items.push(item('token', 'Could not reach the gateway', 'error', e.message)); }
			} else items.push(item('token', 'Gateway is not configured on this server', 'info', 'Set GATEWAY_ADMIN_KEY.'));
			return sum(items);
		},
		async run(ctx, ch, { dry }) {
			const cfg = ctx.c.cfg, host = tempHost(ch, cfg), items = [];
			// 1. DNS for the preview address
			if (ctx.c.cloudflare.available() && cfg.previewZoneId && cfg.hostingerIp) {
				try {
					const recs = (await ctx.c.cloudflare.records(cfg.previewZoneId));
					const plan = planWebRecords({ domain: host, ip: cfg.hostingerIp, existing: recs.map((r) => ({ id: r.id, type: r.type, name: r.name, content: r.content })) }).filter((p) => p.type === 'A');
					items.push(...(await cfRecordsApply(ctx, cfg.previewZoneId, plan, dry)));
				} catch (e) { items.push(item('dns', 'Preview DNS record', 'error', e.message)); }
			} else items.push(item('dns', 'Preview DNS record', 'manual', `Add an A record for ${host} (or rely on a wildcard record). Needs CLOUDFLARE_PREVIEW_ZONE_ID and HOSTINGER_IP to be automatic.`));
			// 2. token and limits
			let token = '';
			if (ctx.c.gateway.available()) {
				try {
					token = (await ctx.c.gateway.mint(ch.slug)).token;
					items.push(item('token', 'AI Assistant key for this site', dry ? 'planned' : 'done', dry ? 'will be created at the gateway' : 'created (it is written to the site next, never shown)'));
					if (!dry && (cfg.defaultTokenCap || cfg.defaultImageCap)) { await ctx.c.gateway.setCap(ch.slug, cfg.defaultTokenCap, cfg.defaultImageCap); items.push(item('cap', 'Daily usage limit', 'done', `${cfg.defaultTokenCap || 'no'} tokens, ${cfg.defaultImageCap || 'no'} images a day`)); }
				} catch (e) { items.push(item('token', 'AI Assistant key for this site', 'error', e.message)); }
			} else items.push(item('token', 'AI Assistant key for this site', 'manual', 'Set GATEWAY_ADMIN_KEY so the key can be created and written automatically.'));
			// 3. configure the site
			const tplHost = `${cfg.templateSlug}.${cfg.previewDomain}`;
			const label = `Preview of the proposed new website for ${ch.name}. This is not the live site.`;
			const php = `CWAI_Golive::apply('preview_on', ['label' => ${JSON.stringify(label)}]);`;
			const cmds = [
				['exists', 'Site files are in place', `test -f ${sitePath(cfg, host)}/wp-config.php`],
				['key', 'Write the AI Assistant key into wp-config', wpIn(cfg, host, `config set CWAI_API_KEY ${shq(token || '<key>')} --type=constant`)],
				['base', 'Point the Assistant at the gateway', wpIn(cfg, host, `config set CWAI_API_BASE_URL ${shq(cfg.gatewayUrl)} --type=constant`)],
				['address', `Change the site address from ${tplHost} to ${host}`, wpIn(cfg, host, `search-replace ${shq(tplHost)} ${shq(host)} --all-tables --precise --recurse-objects --skip-columns=guid`)],
				['title', 'Set the site title', wpIn(cfg, host, `option update blogname ${shq(ch.name)}`)],
				['preview', 'Turn preview mode on', wpIn(cfg, host, `eval ${shq(php)}`)],
				['flush', 'Clear caches', wpIn(cfg, host, 'cache flush')],
			];
			items.push(...(await runSsh(ctx, cmds, { dry, secrets: [token] })));
			return sum(items);
		},
		async test(ctx, ch) { return this.check(ctx, ch); },
	},

	/* ------------------------------------------------------------------ 2 */
	{
		key: 'dnscheck', n: 2, title: 'Check the church\'s current DNS', needs: [], manual: [],
		blurb: 'Read-only. Where is the domain\'s DNS hosted, where does the website point (Duda?), and where does email go today?',
		async check(ctx, ch) {
			if (!ch.domain) return sum([item('domain', 'Enter the church\'s website address first', 'fail', 'Use "Edit details" above.')]);
			const items = [];
			let facts;
			try { facts = await dnsFacts(ctx, ch.domain); } catch (e) { return sum([item('lookup', 'DNS lookup failed', 'error', e.message)]); }
			let zone = null;
			try { zone = await zoneOf(ctx, ch.domain); } catch (e) { items.push(item('cf', 'Could not ask Cloudflare', 'warn', e.message)); }
			const cls = classifyDns(facts, { zone, hostingerIp: ctx.c.cfg.hostingerIp, dudaHosts: ctx.c.cfg.dudaHosts, dudaIps: ctx.c.cfg.dudaIps, ourMxHosts: ctx.c.cfg.ourMxHosts });
			const words = { ours: 'in OUR Cloudflare', 'cloudflare-pending': 'on Cloudflare (zone created, nameservers not changed yet)', 'cloudflare-other': 'on someone else\'s Cloudflare', duda: 'at Duda', other: 'at the registrar or another host', unknown: 'unknown' };
			items.push(item('dns', 'DNS is hosted ' + words[cls.dnsHost], cls.dnsHost === 'ours' ? 'pass' : 'info', (facts.ns || []).join(', ')));
			items.push(item('web', { duda: 'The website currently points at Duda', ours: 'The website already points at our Hostinger server', other: 'The website points somewhere else', none: 'No website address is set' }[cls.web], cls.web === 'duda' ? 'warn' : 'info', `Apex ${(facts.a || []).join(', ') || 'none'}; www ${(facts.wwwCname || []).join(', ') || (facts.wwwA || []).join(', ') || 'none'}`));
			items.push(item('email', { ours: 'Email is already on our server', google: 'Email is on Google Workspace', microsoft: 'Email is on Microsoft 365', other: 'Email is on another provider', none: 'No email set up on this domain' }[cls.email], ['google', 'microsoft', 'other'].includes(cls.email) ? 'warn' : 'info', (facts.mx || []).map((m) => m.exchange || m).join(', ')));
			items.push(item('spf', { none: 'No SPF record', one: 'One SPF record', duplicate: 'More than one SPF record (a problem)' }[cls.spf], cls.spf === 'duplicate' ? 'warn' : 'info'));
			for (const b of cls.blockers) items.push(item('blocker', b.text, b.level === 'warn' ? 'warn' : 'info'));
			for (const w of cls.warnings) items.push(item('warning', w, 'warn'));
			for (const n of cls.notes) items.push(item('note', n, 'info'));
			ctx.facts = { dns: { ...cls, at: Date.now(), nameserversOurs: zone?.name_servers || [] } };
			return sum(items);
		},
		async run(ctx, ch) { return this.check(ctx, ch); },
		async test(ctx, ch) { return this.check(ctx, ch); },
	},

	/* ------------------------------------------------------------------ 3 */
	{
		key: 'approval', n: 3, title: 'Client approval and payment', needs: [],
		blurb: 'The gate. Nothing that changes the church\'s live domain happens until these are ticked.',
		manual: [
			{ id: 'approved', label: () => 'The church has seen the preview and approved it.' },
			{ id: 'plan', label: (ch) => `Plan confirmed: ${ch.plan === 'email' ? 'Website + Email' : 'Website'}.` },
			{ id: 'paid', label: () => 'Payment received (subscription active in Stripe).' },
			{ id: 'registrar', label: () => 'We know who holds the domain registrar login and how they will give us access or change nameservers.' },
		],
		async check(ctx, ch) {
			const m = ch.stages.approval?.manual || {};
			const items = [item('domain', ch.domain ? `Domain: ${ch.domain}` : 'No domain entered yet', ch.domain ? 'pass' : 'fail')];
			for (const s of STAGES[2].manual) items.push(item(s.id, s.label(ch), m[s.id] ? 'pass' : 'fail'));
			return sum(items);
		},
		async run(ctx, ch) { return { ok: true, items: [item('info', 'Nothing to run here. Tick the boxes as each thing happens.', 'info')] }; },
		async test(ctx, ch) { return this.check(ctx, ch); },
	},

	/* ------------------------------------------------------------------ 4 */
	{
		key: 'dns', n: 4, title: 'Move the domain\'s DNS and point it at the new site', needs: ['approval'],
		blurb: 'Create the zone in our Cloudflare, copy the existing records, get the nameservers changed, then point the website at Hostinger. Records are only ever added or changed, never deleted.',
		manual: [{ id: 'ns', label: (ch, cfg, facts) => `The church changes their nameservers${facts?.nameservers?.length ? ' to ' + facts.nameservers.join(' and ') : ''} at their registrar (skip if the DNS is already ours).` }],
		async check(ctx, ch) { return this.run(ctx, ch, { dry: true, readOnly: true }); },
		async run(ctx, ch, { dry, readOnly }) {
			const cfg = ctx.c.cfg, d = ch.domain, items = [];
			if (!d) return sum([item('domain', 'Enter the church\'s website address first', 'fail')]);
			if (!ctx.c.cloudflare.available()) return sum([item('cf', 'Cloudflare is not configured on this server', 'manual', 'Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, or do this stage by hand in Cloudflare.')]);
			if (!cfg.hostingerIp) return sum([item('ip', 'HOSTINGER_IP is not set', 'fail', 'It is the IP of the Hostinger website (Hosting → Plan details).')]);
			let zone = await ctx.c.cloudflare.zoneByName(d);
			const justCreated = !zone;
			// a. the zone
			if (!zone) {
				if (dry) items.push(item('zone', `Create ${d} in our Cloudflare`, 'planned'));
				else { zone = await ctx.c.cloudflare.createZone(d); items.push(item('zone', `Created ${d} in our Cloudflare`, 'done', 'Nameservers: ' + zone.name_servers.join(', '))); }
			} else items.push(item('zone', `${d} is in our Cloudflare`, 'pass', `status ${zone.status}`));
			const nameservers = zone?.name_servers || [];
			ctx.facts = { nameservers };
			// b. copy existing records into a brand-new zone
			let existing = [];
			if (zone && !justCreated) existing = (await ctx.c.cloudflare.records(zone.id)).map((r) => ({ id: r.id, type: r.type, name: r.name, content: r.content, priority: r.priority }));
			if (justCreated || (zone && existing.length === 0)) {
				const inv = await inventory(ctx, d);
				items.push(item('inv', 'Copy the existing DNS records so nothing breaks', dry ? 'planned' : 'info', `${inv.length} record(s) found by looking up common names. This is a best effort: ask the church for a zone file or screenshot of their DNS to be sure nothing is missing (subdomains, verification records).`));
				if (zone) items.push(...(await cfRecordsApply(ctx, zone.id, inv.map((r) => ({ action: 'create', ...r })), dry)));
			}
			// c. nameservers
			if (zone && nameservers.length) {
				const pub = (await ctx.c.dns.ns(d)).map((x) => x.toLowerCase().replace(/\.$/, ''));
				const ok = pub.length && pub.every((n) => nameservers.map((x) => x.toLowerCase()).includes(n));
				items.push(ok ? item('ns', 'The nameservers have been changed to ours', 'pass', pub.join(', ')) : item('ns', 'Waiting for the nameserver change', 'warn', `Ask the church to set the nameservers to: ${nameservers.join(' and ')}. Right now: ${pub.join(', ') || 'none'}.`));
				if (ok && !dry && zone.status !== 'active') await ctx.c.cloudflare.activationCheck(zone.id);
				if (ok && zone.status !== 'active' && dry) items.push(item('zonestatus', `Cloudflare shows the zone as "${zone.status}"`, 'info', 'It turns active shortly after the nameservers change.'));
				ctx.facts.nsOk = !!ok;
				// d. website records: only when the zone is ours and live
				if (ok || !justCreated) {
					const act = zone.status === 'active';
					if (!act && !dry) items.push(item('web', 'Website records', 'warn', 'The zone is not active yet. Run again in a few minutes.'));
					else if (zone && existing.length) {
						const plan = planWebRecords({ domain: d, ip: cfg.hostingerIp, existing });
						const duda = (await ctx.c.dns.cname('www.' + d)).some((c) => /multiscreensite|dudaone/i.test(c));
						if (duda || (cfg.dudaIps || []).some((ip) => existing.some((r) => r.content === ip))) items.push(item('duda', 'This changes the live website away from Duda', 'warn', 'Only continue once the church has approved and the new site is ready.'));
						items.push(...(await cfRecordsApply(ctx, zone.id, plan, dry || readOnly || !act)));
					}
				}
			}
			return sum(items);
		},
		async test(ctx, ch) {
			const d = ch.domain, items = [];
			const a = await ctx.c.dns.a(d);
			items.push(a.includes(ctx.c.cfg.hostingerIp) ? item('apex', `${d} points at the new server`, 'pass', a.join(', ')) : item('apex', `${d} does not point at the new server yet`, 'fail', a.join(', ') || 'no address'));
			const w = await ctx.c.dns.cname('www.' + d); const wa = await ctx.c.dns.a('www.' + d);
			items.push(w.some((x) => x.replace(/\.$/, '') === d) || wa.includes(ctx.c.cfg.hostingerIp) ? item('www', `www.${d} is set`, 'pass') : item('www', `www.${d} is not set`, 'fail'));
			return sum(items);
		},
	},

	/* ------------------------------------------------------------------ 5 */
	{
		key: 'golive', n: 5, title: 'Move the preview onto the real domain', needs: ['dns'],
		blurb: 'Add the domain to Hostinger, issue SSL, change the site address, turn preview mode off, and check the live site.',
		manual: [
			{ id: 'hostinger', label: (ch) => `In hPanel, add ${ch.domain || 'the domain'} to the site and set it as primary.` },
			{ id: 'ssl', label: () => 'In hPanel, make sure the SSL certificate is issued and active.' },
		],
		async check(ctx, ch) {
			const d = ch.domain, items = [];
			const r = await ctx.c.http.get(`https://${d}/`);
			if (!r.status) return sum([item('http', `https://${d} does not answer`, 'fail', r.error || '')]);
			items.push(r.status === 200 ? item('http', 'The live address loads', 'pass') : item('http', `The live address answered HTTP ${r.status}`, [301, 302, 308].includes(r.status) ? 'warn' : 'fail', r.location ? 'Redirects to ' + r.location : ''));
			const cert = await ctx.c.tls(d);
			items.push(cert.authorized ? item('ssl', 'SSL certificate is valid', 'pass', cert.validTo) : item('ssl', 'SSL certificate problem', 'fail', cert.error));
			const noindex = /noindex/i.test(r.headers['x-robots-tag'] || '') || /<meta[^>]+name=["']robots["'][^>]*noindex/i.test(r.text);
			items.push(noindex ? item('preview', 'Preview mode is still ON (search engines are told to ignore the site)', 'fail') : item('preview', 'Preview mode is off', 'pass'));
			items.push(/Preview of the proposed new website/i.test(r.text) ? item('banner', 'The preview banner is still showing', 'fail') : item('banner', 'No preview banner', 'pass'));
			items.push(r.text.toLowerCase().includes(ch.name.toLowerCase()) ? item('name', 'The church name appears on the home page', 'pass') : item('name', 'The church name is not on the home page', 'warn'));
			const www = await ctx.c.http.get(`https://www.${d}/`);
			items.push(www.status && (www.status === 200 || [301, 308].includes(www.status)) ? item('www', 'www address works', 'pass', www.location ? '→ ' + www.location : '') : item('www', 'www address does not work', 'warn'));
			const rb = await ctx.c.http.get(`https://${d}/robots.txt`);
			items.push(/^\s*Disallow:\s*\/\s*$/im.test(rb.text || '') ? item('robots', 'robots.txt blocks the whole site', 'fail') : item('robots', 'robots.txt allows search engines', 'pass'));
			const sm = await ctx.c.http.get(`https://${d}/sitemap_index.xml`);
			items.push(sm.status === 200 ? item('sitemap', 'Sitemap is published', 'pass') : item('sitemap', 'No sitemap found at /sitemap_index.xml', 'warn', 'Rank Math publishes it once the site is live and search engines are allowed.'));
			return sum(items);
		},
		async run(ctx, ch, { dry }) {
			const cfg = ctx.c.cfg, d = ch.domain, host = tempHost(ch, cfg);
			if (!d) return sum([item('domain', 'Enter the church\'s website address first', 'fail')]);
			const php = "CWAI_Golive::apply('launch');";
			const cmds = [
				['exists', 'Site files are in place', `test -f ${sitePath(cfg, host)}/wp-config.php`],
				['address', `Change every address from ${host} to ${d}`, wpIn(cfg, host, `search-replace ${shq(host)} ${shq(d)} --all-tables --precise --recurse-objects --skip-columns=guid`)],
				['home', 'Set the WordPress address', wpIn(cfg, host, `option update home ${shq('https://' + d)}`)],
				['siteurl', 'Set the site address', wpIn(cfg, host, `option update siteurl ${shq('https://' + d)}`)],
				['launch', 'Turn preview mode off and allow search engines', wpIn(cfg, host, `eval ${shq(php)}`)],
				['flush', 'Clear caches and refresh links', wpIn(cfg, host, 'rewrite flush && ' + cfg.wpCli + ' cache flush')],
			];
			const items = await runSsh(ctx, cmds, { dry });
			items.unshift(item('note', 'Before this runs: the domain must be added in hPanel (tick the boxes below) so the site answers on it.', 'info'));
			return sum(items);
		},
		async test(ctx, ch) { return this.check(ctx, ch); },
	},

	/* ------------------------------------------------------------------ 6 */
	{
		key: 'mailboxes', n: 6, title: 'Create the church\'s email accounts', needs: ['approval'], onlyPlan: 'email',
		blurb: 'Only for the Website + Email plan. Adds the domain and mailboxes on our mail server with temporary passwords. The MX records change last, after the mailboxes are ready and old mail is moved.',
		manual: [
			{ id: 'domain', label: (ch, cfg) => `Add ${ch.domain || 'the domain'} to SmarterMail (${cfg.mailHost}).` },
			{ id: 'boxes', label: () => 'Create the mailboxes with the temporary passwords shown by Run, and require a change at first login.' },
			{ id: 'moved', label: () => 'Old email is moved over (imapsync or the church forwards it), or the church has no email to move.' },
			{ id: 'mx', label: () => 'Change the MX records to our mail server (use Run → "Switch MX" below).' },
		],
		async check(ctx, ch) {
			if (ch.plan !== 'email') return sum([item('plan', 'This church is on the Website plan: no email accounts needed', 'info')]);
			const items = [], mx = await ctx.c.dns.mx(ch.domain || '');
			const hosts = mx.map((m) => (m.exchange || m).toLowerCase().replace(/\.$/, ''));
			items.push(hosts.some((h) => ctx.c.cfg.ourMxHosts.includes(h)) ? item('mx', 'MX records point at our mail server', 'pass', hosts.join(', ')) : item('mx', 'MX records do not point at our mail server yet', hosts.length ? 'warn' : 'info', hosts.join(', ') || 'none'));
			items.push(item('boxes', `${(ch.mailboxes || []).length} mailbox name(s) planned`, (ch.mailboxes || []).length ? 'pass' : 'warn', (ch.mailboxes || []).join(', ')));
			items.push(item('api', ctx.c.cfg.smartermailReady ? 'SmarterMail automation is switched on' : 'SmarterMail is done by hand for now', 'info', 'Needs your server\'s API documentation (/Documentation/api) to switch on.'));
			return sum(items);
		},
		async run(ctx, ch, { dry, cutoverMx }) {
			if (ch.plan !== 'email') return this.check(ctx, ch);
			const items = [];
			const names = (ch.mailboxes || []).length ? ch.mailboxes : ['info'];
			if (cutoverMx) {
				const m = ch.stages.mailboxes?.manual || {};
				if (!m.boxes || !m.moved) return sum([item('gate', 'Not yet: tick "mailboxes created" and "old email moved" first', 'fail', 'Changing MX before that would lose the church\'s email.')]);
				const zone = await zoneOf(ctx, ch.domain);
				if (!zone) return sum([item('zone', 'The domain is not in our Cloudflare yet', 'fail')]);
				const existing = (await ctx.c.cloudflare.records(zone.id)).map((r) => ({ id: r.id, type: r.type, name: r.name, content: r.content, priority: r.priority }));
				items.push(...(await cfRecordsApply(ctx, zone.id, planMailRecords({ domain: ch.domain, mailHost: ctx.c.cfg.mailHost, existing, cutoverMx: true }), dry)));
				return sum(items);
			}
			// temporary passwords: shown once in this response, never saved
			const boxes = names.map((n) => ({ address: `${n}@${ch.domain}`, password: randomPassword(14) }));
			ctx.secret = { boxes };
			items.push(item('boxes', 'Create these mailboxes on the mail server (copy the passwords now: they are not saved)', 'manual', boxes.map((b) => `${b.address}   ${b.password}`).join('\n'), true));
			items.push(item('how', 'Set "must change password at next login" on each one', 'info'));
			return sum(items);
		},
		async test(ctx, ch) { return this.check(ctx, ch); },
	},

	/* ------------------------------------------------------------------ 7 */
	{
		key: 'sending', n: 7, title: 'Set up sending through Postmark', needs: ['dns'],
		blurb: 'Authorise the church\'s domain at Postmark, add the DKIM, Return-Path and one combined SPF record in Cloudflare, and point the website\'s outgoing mail at Postmark.',
		manual: [],
		async check(ctx, ch) { return this.run(ctx, ch, { dry: true, readOnly: true }); },
		async run(ctx, ch, { dry, readOnly, testTo }) {
			const cfg = ctx.c.cfg, d = ch.domain, items = [];
			if (!d) return sum([item('domain', 'Enter the church\'s website address first', 'fail')]);
			if (!ctx.c.postmark.available()) return sum([item('pm', 'Postmark is not configured on this server', 'manual', 'Set POSTMARK_ACCOUNT_TOKEN (the Account API token), or do this by hand.')]);
			let dom = await ctx.c.postmark.domainByName(d);
			if (!dom) {
				if (dry) items.push(item('pm', `Add ${d} to Postmark`, 'planned'));
				else { dom = await ctx.c.postmark.createDomain(d); dom = await ctx.c.postmark.domain(dom.ID); items.push(item('pm', `Added ${d} to Postmark`, 'done')); }
			} else { dom = await ctx.c.postmark.domain(dom.ID); items.push(item('pm', `${d} is in Postmark`, 'pass')); }
			const zone = await zoneOf(ctx, d);
			if (!zone) { items.push(item('zone', 'The domain is not in our Cloudflare yet, so the records cannot be added', 'fail', 'Finish stage 4 first.')); return sum(items); }
			const existing = (await ctx.c.cloudflare.records(zone.id)).map((r) => ({ id: r.id, type: r.type, name: r.name, content: r.content }));
			const write = !(dry || readOnly);
			if (dom) items.push(...(await cfRecordsApply(ctx, zone.id, planPostmarkRecords({ domain: d, pm: dom, existing }), !write)));
			// one SPF for everyone
			const spfRecs = existing.filter((r) => r.type === 'TXT' && /^"?v=spf1/i.test(r.content)).map((r) => r.content.replace(/^"|"$/g, ''));
			const spf = mergeSpf(spfRecs, { includes: ['spf.mtasv.net'], hosts: ch.plan === 'email' ? [cfg.mailHost] : [] });
			if (spf.tooManyLookups) items.push(item('spflimit', 'The SPF record would use more than 10 lookups, which breaks it', 'warn', spf.record));
			items.push(...(await cfRecordsApply(ctx, zone.id, planMailRecords({ domain: d, mailHost: cfg.mailHost, existing, spf, dmarcRua: cfg.dmarcRua }), !write)));
			// verification
			if (write && dom) {
				for (const [id, label, fn] of [['dkim', 'DKIM', () => ctx.c.postmark.verifyDkim(dom.ID)], ['rp', 'Return-Path', () => ctx.c.postmark.verifyReturnPath(dom.ID)], ['spfv', 'SPF', () => ctx.c.postmark.verifySpf(dom.ID)]]) {
					try { const v = await fn(); const okf = v.DKIMVerified ?? v.ReturnPathDomainVerified ?? v.SPFVerified; items.push(item(id, `Postmark ${label} check`, okf ? 'pass' : 'warn', okf ? 'verified' : 'not verified yet (DNS can take a few minutes)')); } catch (e) { items.push(item(id, `Postmark ${label} check`, 'error', e.message)); }
				}
			} else if (dom) {
				items.push(item('dkimv', 'DKIM verified at Postmark', dom.DKIMVerified ? 'pass' : 'warn'));
				items.push(item('rpv', 'Return-Path verified at Postmark', dom.ReturnPathDomainVerified ? 'pass' : 'warn'));
				items.push(item('spfv', 'SPF verified at Postmark', dom.SPFVerified ? 'pass' : 'warn'));
			}
			// the website's outgoing mail
			if (!readOnly) {
				const host = tempHost(ch, cfg);
				const root = ch.stages.golive?.last?.ok ? d : host;
				const tok = cfg.postmarkServerToken;
				const cmds = [
					['smtp1', 'Send the site\'s mail through Postmark: host', wpIn(cfg, root, `config set WPMS_ON true --raw --type=constant`)],
					['smtp2', 'mailer', wpIn(cfg, root, `config set WPMS_MAILER smtp --type=constant`)],
					['smtp3', 'server', wpIn(cfg, root, `config set WPMS_SMTP_HOST smtp.postmarkapp.com --type=constant`)],
					['smtp4', 'port and encryption', wpIn(cfg, root, `config set WPMS_SMTP_PORT 587 --raw --type=constant && ${cfg.wpCli} config set WPMS_SSL tls --type=constant && ${cfg.wpCli} config set WPMS_SMTP_AUTH true --raw --type=constant`)],
					['smtp5', 'login (the Postmark server token)', wpIn(cfg, root, `config set WPMS_SMTP_USER ${shq(tok || '<server token>')} --type=constant && ${cfg.wpCli} config set WPMS_SMTP_PASS ${shq(tok || '<server token>')} --type=constant`)],
					['smtp6', 'sender address', wpIn(cfg, root, `config set WPMS_MAIL_FROM ${shq('info@' + d)} --type=constant`)],
				];
				items.push(...(await runSsh(ctx, cmds, { dry, secrets: [tok] })));
				if (testTo && write) {
					const r = await runSsh(ctx, [['test', `Send a test email to ${testTo}`, wpIn(cfg, root, `eval ${shq(`var_dump(wp_mail(${JSON.stringify(testTo)}, 'ChurchWeb test', 'If you can read this, the site can send email.'));`)}`)]], { dry: false });
					items.push(...r);
				}
			}
			return sum(items);
		},
		async test(ctx, ch, opts = {}) { return this.run(ctx, ch, { dry: true, readOnly: true, ...opts }); },
	},

	/* ------------------------------------------------------------------ 8 */
	{
		key: 'handover', n: 8, title: 'Hand the site over', needs: ['golive'],
		blurb: 'Create the church\'s staff login (an Editor with the simplified staff view), send the welcome, and confirm everything is recorded.',
		manual: [
			{ id: 'welcome', label: () => 'Welcome email sent to the church contact (login, how to use the Assistant, support address).' },
			{ id: 'stripe', label: () => 'The subscription is recorded in Stripe with the church name and domain.' },
			{ id: 'backups', label: () => 'Hostinger\'s nightly backup includes this site (hPanel → Backups).' },
			{ id: 'monitor', label: () => 'The site is added to uptime monitoring.' },
		],
		async check(ctx, ch) {
			const items = [], r = await ctx.c.http.get(`https://${ch.domain}/wp-login.php`);
			items.push(r.status === 200 ? item('login', 'The login page works', 'pass') : item('login', 'The login page does not load', 'fail', 'HTTP ' + r.status));
			if (ctx.c.gateway.available()) { try { const s = await ctx.c.gateway.site(ch.slug); items.push(s.revoked ? item('gw', 'The AI Assistant is switched off for this site', 'fail') : item('gw', 'The AI Assistant is active', 'pass', s.caps ? `daily limit: ${s.caps.tokens || 'none'} tokens` : '')); } catch (e) { items.push(item('gw', 'Gateway', 'error', e.message)); } }
			const m = ch.stages.handover?.manual || {};
			for (const s of STAGES[7].manual) items.push(item(s.id, s.label(ch), m[s.id] ? 'pass' : 'warn'));
			return sum(items);
		},
		async run(ctx, ch, { dry, email, name }) {
			const cfg = ctx.c.cfg, d = ch.domain, items = [];
			const em = String(email || ch.contactEmail || '').trim();
			if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return sum([item('email', 'Enter the church contact\'s email address first', 'fail')]);
			const login = (name || ch.slug + '-admin').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 40) || ch.slug + '-admin';
			const pw = randomPassword(16);
			ctx.secret = { login, password: pw, email: em };
			const php = "update_option('cwai_sv', array_merge(CWAI_StaffView::defaults(), ['enabled' => true]));";
			const cmds = [
				['user', `Create the staff login "${login}" (Editor)`, wpIn(cfg, d, `user create ${shq(login)} ${shq(em)} --role=editor --user_pass=${shq(dry ? '<password>' : pw)} --send-email=0 --porcelain`)],
				['staffview', 'Turn on the simplified staff view', wpIn(cfg, d, `eval ${shq(php)}`)],
			];
			items.push(...(await runSsh(ctx, cmds, { dry, secrets: [pw] })));
			if (!dry) items.push(item('pw', 'Temporary password (copy it now: it is not saved)', 'manual', `${login}   ${pw}`, true));
			return sum(items);
		},
		async test(ctx, ch) { return this.check(ctx, ch); },
	},
];

/** Best-effort copy of a domain's current records, from public lookups of the usual names. */
async function inventory(ctx, d) {
	const recs = [];
	const d_ = ctx.c.dns;
	const names = ['', 'www', 'mail', 'webmail', 'autodiscover', 'autoconfig', 'smtp', 'imap', 'pop', 'ftp'];
	for (const n of names) {
		const fq = n ? `${n}.${d}` : d;
		const cn = await d_.cname(fq);
		if (cn.length) { recs.push({ type: 'CNAME', name: fq, content: cn[0].replace(/\.$/, '') }); continue; }
		for (const ip of await d_.a(fq)) recs.push({ type: 'A', name: fq, content: ip });
		for (const ip of await d_.aaaa(fq)) recs.push({ type: 'AAAA', name: fq, content: ip });
	}
	for (const m of await d_.mx(d)) recs.push({ type: 'MX', name: d, content: String(m.exchange).replace(/\.$/, ''), priority: m.priority });
	for (const t of await d_.txt(d)) recs.push({ type: 'TXT', name: d, content: Array.isArray(t) ? t.join('') : t });
	for (const t of await d_.txt('_dmarc.' + d)) recs.push({ type: 'TXT', name: '_dmarc.' + d, content: Array.isArray(t) ? t.join('') : t });
	return recs;
}

export const stageByKey = (k) => STAGES.find((s) => s.key === k);
export function blockedBy(ch, stage) {
	const out = [];
	for (const need of stage.needs) {
		const s = ch.stages[need];
		const m = s?.manual || {};
		const done = need === 'approval' ? STAGES[2].manual.every((x) => m[x.id]) && !!ch.domain : s?.done;
		if (!done) out.push(need);
	}
	if (stage.onlyPlan && ch.plan !== stage.onlyPlan) out.push('plan');
	return out;
}
