// Clients for the services the deployment steps talk to. Every network call goes through injectable functions
// so the steps can be tested with fakes. Nothing here prints or stores a secret.
import dns from 'node:dns/promises';
import tls from 'node:tls';
import net from 'node:net';
import { makeSmarterMail } from './smartermail.mjs';
import crypto from 'node:crypto';

/** Quote one value for a POSIX shell, so a church name can never become a command. */
export const shq = (v) => "'" + String(v).replace(/'/g, "'\\''") + "'";
export const randomPassword = (n = 16) => {
	const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
	let out = '';
	for (const b of crypto.randomBytes(n)) out += chars[b % chars.length];
	return out + '!7'; // satisfies common complexity rules
};

/** Turn any service error body (string, {message}, {error:{message}}, Cloudflare errors[]) into plain text. */
export function errText(r, hint) {
	const d = r?.data; let m = '';
	if (typeof d === 'string') m = d.slice(0, 200);
	else if (d) m = (typeof d.error === 'string' ? d.error : d.error?.message) || d.Message || d.message || (Array.isArray(d.errors) && d.errors.map((e) => e.message).join('; ')) || '';
	if (!m) m = r?.error || 'HTTP ' + (r?.status ?? '?');
	return hint ? `${m} (${hint})` : m;
}

/** Pasted secrets often carry quotes, spaces, a newline or a "Bearer " prefix: strip them. */
const clean = (v) => String(v || '').trim().replace(/^["']+|["']+$/g, '').replace(/^Bearer\s+/i, '').trim();
export function configFromEnv(env = process.env) {
	const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
	return {
		gatewayUrl: (env.GATEWAY_URL || 'https://ai.churchwebglobal.com').replace(/\/$/, ''),
		gatewayAdminKey: clean(env.GATEWAY_ADMIN_KEY),
		defaultTokenCap: Number(env.DEFAULT_DAILY_TOKENS || 0),
		defaultImageCap: Number(env.DEFAULT_DAILY_IMAGES || 0),
		cloudflareBase: (env.CLOUDFLARE_API_BASE || 'https://api.cloudflare.com/client/v4').replace(/\/$/, ''),
		cloudflareToken: clean(env.CLOUDFLARE_API_TOKEN),
		cloudflareAccountId: clean(env.CLOUDFLARE_ACCOUNT_ID),
		previewZoneId: clean(env.CLOUDFLARE_PREVIEW_ZONE_ID),
		previewDomain: env.PREVIEW_DOMAIN || 'churchwebglobal.com',
		hostingerIp: env.HOSTINGER_IP || '',
		templateSlug: env.TEMPLATE_SLUG || 'build2',
		postmarkBase: (env.POSTMARK_API_BASE || 'https://api.postmarkapp.com').replace(/\/$/, ''),
		postmarkAccountToken: clean(env.POSTMARK_ACCOUNT_TOKEN),
		postmarkServerToken: clean(env.POSTMARK_SERVER_TOKEN),
		dudaHosts: list(env.DUDA_HOSTS).length ? list(env.DUDA_HOSTS) : undefined,
		dudaIps: list(env.DUDA_IPS),
		ourMxHosts: list(env.OUR_MX_HOSTS || 'mail.churchwebglobal.com'),
		mailHost: env.MAIL_HOST || 'mail.churchwebglobal.com',
		dmarcRua: env.DMARC_RUA || '',
		dnsServers: list(env.DNS_SERVERS).length ? list(env.DNS_SERVERS) : ['1.1.1.1', '8.8.8.8'],
		sshHost: env.SSH_HOST || env.HOSTINGER_SSH_HOST || env.HOSTINGER_IP || '', sshPort: Number(env.SSH_PORT || env.HOSTINGER_PORT || 22), sshUser: env.SSH_USER || env.HOSTINGER_USERNAME || '', sshPassword: env.SSH_PASSWORD || env.HOSTINGER_PASSWORD || '',
		sshKey: (env.SSH_PRIVATE_KEY || '').replace(/\\n/g, '\n'), sshPassphrase: env.SSH_PASSPHRASE || '',
		siteRoot: env.SITE_ROOT || '$HOME/domains/{host}/public_html',
		wpCli: env.WP_CLI || 'wp',
		wpAdminEmail: clean(env.WP_ADMIN_EMAIL), hostingerApiBase: (env.HOSTINGER_API_BASE || 'https://developers.hostinger.com').replace(/\/$/, ''), hostingerApiKey: clean(env.HOSTINGER_API_KEY),
		smartermailUrl: (() => { const u = clean(env.SMARTERMAIL_URL); return u ? (/^https?:\/\//i.test(u) ? u : 'https://' + u).replace(/\/$/, '') : ''; })(),
		smartermailUser: clean(env.SMARTERMAIL_ADMIN_USER), smartermailPassword: String(env.SMARTERMAIL_ADMIN_PASSWORD || '').trim(),
		smartermailDomainPath: env.SMARTERMAIL_DOMAIN_PATH || 'C:\\SmarterMail\\Domains\\{domain}', smartermailDomainAdmin: env.SMARTERMAIL_DOMAIN_ADMIN || 'postmaster',
	};
}

export const configured = (cfg) => ({
	gateway: !!cfg.gatewayAdminKey,
	cloudflare: !!(cfg.cloudflareToken && cfg.cloudflareAccountId),
	previewDns: !!(cfg.cloudflareToken && cfg.previewZoneId && cfg.hostingerIp),
	postmark: !!cfg.postmarkAccountToken,
	smtp: !!cfg.postmarkServerToken,
	ssh: !!(cfg.sshHost && cfg.sshUser && (cfg.sshKey || cfg.sshPassword)),
	smartermail: !!(cfg.smartermailUrl && cfg.smartermailUser && cfg.smartermailPassword),
	hostingerIp: !!cfg.hostingerIp,
	hostingerApi: !!cfg.hostingerApiKey,
});

async function req(fetchFn, url, { method = 'GET', headers = {}, body, timeout = 20000 } = {}) {
	const ctl = new AbortController();
	const t = setTimeout(() => ctl.abort(), timeout);
	try {
		const r = await fetchFn(url, { method, headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
		const text = await r.text();
		let data; try { data = JSON.parse(text); } catch { data = text; }
		return { ok: r.ok, status: r.status, data };
	} catch (e) {
		return { ok: false, status: 0, data: null, error: e.name === 'AbortError' ? 'timed out' : e.message };
	} finally { clearTimeout(t); }
}

export function makeClients(cfg, deps = {}) {
	const f = deps.fetch || globalThis.fetch;

	const gwErr = (r) => errText(r, r.status === 404 ? 'the live gateway does not have the new admin endpoints yet: deploy cwai-gateway.zip' : r.status === 401 ? 'wrong GATEWAY_ADMIN_KEY' : r.status === 0 ? 'cannot reach ' + cfg.gatewayUrl : '');
	const gateway = {
		available: () => !!cfg.gatewayAdminKey,
		async mint(site) {
			const r = await req(f, `${cfg.gatewayUrl}/v1/admin/mint`, { method: 'POST', headers: { 'x-admin-key': cfg.gatewayAdminKey }, body: { site } });
			if (!r.ok) throw new Error('Gateway: ' + gwErr(r));
			return r.data; // {site, token, revoked}
		},
		async site(site) {
			const r = await req(f, `${cfg.gatewayUrl}/v1/admin/site?site=${encodeURIComponent(site)}`, { headers: { 'x-admin-key': cfg.gatewayAdminKey } });
			if (!r.ok) throw new Error('Gateway: ' + gwErr(r));
			return r.data;
		},
		async setCap(site, tokens, images) {
			const r = await req(f, `${cfg.gatewayUrl}/v1/admin/cap`, { method: 'PUT', headers: { 'x-admin-key': cfg.gatewayAdminKey }, body: { site, tokens, images } });
			if (!r.ok) throw new Error('Gateway: ' + gwErr(r));
			return r.data;
		},
		async revoke(site, revoked = true) {
			const r = await req(f, `${cfg.gatewayUrl}/v1/admin/revoke`, { method: 'PUT', headers: { 'x-admin-key': cfg.gatewayAdminKey }, body: { site, revoked } });
			if (!r.ok) throw new Error('Gateway: ' + gwErr(r));
			return r.data;
		},
		/** Does this token work? Uses the same call the plugin makes. */
		async tokenWorks(token) {
			const r = await req(f, `${cfg.gatewayUrl}/v1/usage`, { headers: { 'x-api-key': token } });
			return r.ok;
		},
	};

	const cfH = () => ({ authorization: 'Bearer ' + cfg.cloudflareToken });
	const cfCall = async (method, path, body) => {
		const r = await req(f, cfg.cloudflareBase + path, { method, headers: cfH(), body });
		if (!r.ok || r.data?.success === false) {
			const auth = r.status === 401 || r.status === 403 || (r.data?.errors || []).some((e) => [9109, 10000].includes(e.code));
			throw new Error('Cloudflare: ' + errText(r, auth ? 'the API token cannot access this zone or account: create ONE token that includes both Cloudflare accounts, with Zone Edit, DNS Edit and Zone Read' : ''));
		}
		return r.data;
	};
	const cloudflare = {
		available: () => !!(cfg.cloudflareToken && cfg.cloudflareAccountId),
		async zoneByName(name) {
			const d = await cfCall('GET', `/zones?name=${encodeURIComponent(name)}&account.id=${encodeURIComponent(cfg.cloudflareAccountId)}`);
			return d.result?.[0] || null;
		},
		async createZone(name) {
			const d = await cfCall('POST', '/zones', { name, account: { id: cfg.cloudflareAccountId }, type: 'full' });
			return d.result;
		},
		async zone(id) { return (await cfCall('GET', `/zones/${id}`)).result; },
		async activationCheck(id) { try { await cfCall('PUT', `/zones/${id}/activation_check`); return true; } catch { return false; } },
		async records(zoneId) {
			const out = [];
			for (let page = 1; page < 20; page++) {
				const d = await cfCall('GET', `/zones/${zoneId}/dns_records?per_page=100&page=${page}`);
				out.push(...(d.result || []));
				if (!d.result_info || page >= d.result_info.total_pages) break;
			}
			return out;
		},
		async createRecord(zoneId, rec) { return (await cfCall('POST', `/zones/${zoneId}/dns_records`, { ttl: 1, proxied: false, ...rec })).result; },
		async updateRecord(zoneId, id, rec) { return (await cfCall('PUT', `/zones/${zoneId}/dns_records/${id}`, { ttl: 1, proxied: false, ...rec })).result; },
	};

	const pmH = () => ({ 'x-postmark-account-token': cfg.postmarkAccountToken });
	const pmCall = async (method, path, body) => {
		const r = await req(f, cfg.postmarkBase + path, { method, headers: pmH(), body });
		if (!r.ok) throw new Error('Postmark: ' + errText(r, r.status === 401 ? 'check POSTMARK_ACCOUNT_TOKEN: it must be the Account token, not a Server token' : ''));
		return r.data;
	};
	const postmark = {
		available: () => !!cfg.postmarkAccountToken,
		async domains() { return (await pmCall('GET', '/domains?count=500&offset=0')).Domains || []; },
		async domainByName(name) { return (await postmark.domains()).find((d) => d.Name.toLowerCase() === name.toLowerCase()) || null; },
		async domain(id) { return pmCall('GET', `/domains/${id}`); },
		async createDomain(name) { return pmCall('POST', '/domains', { Name: name, ReturnPathDomain: 'pm-bounces.' + name }); },
		async verifyDkim(id) { return pmCall('PUT', `/domains/${id}/verifydkim`); },
		async verifyReturnPath(id) { return pmCall('PUT', `/domains/${id}/verifyreturnpath`); },
		async verifySpf(id) { return pmCall('PUT', `/domains/${id}/verifyspf`); },
		/** Send one message with the Server token (the From address must be on a verified Postmark domain). */
		async sendEmail(msg) {
			const r = await req(f, cfg.postmarkBase + '/email', { method: 'POST', headers: { 'x-postmark-server-token': cfg.postmarkServerToken }, body: msg });
			if (!r.ok) throw new Error('Postmark: ' + errText(r));
			return r.data;
		},
	};

	// DNS lookups go to public resolvers, not the container's cache.
	const resolver = deps.resolver || (() => { const r = new dns.Resolver(); r.setServers(cfg.dnsServers); return r; })();
	const soft = async (p) => { try { return await p; } catch (e) { if (['ENODATA', 'ENOTFOUND', 'ENOENT', 'NXDOMAIN'].includes(e.code)) return []; throw e; } };
	const dnsClient = deps.dns || {
		ns: (d) => soft(resolver.resolveNs(d)), a: (d) => soft(resolver.resolve4(d)), aaaa: (d) => soft(resolver.resolve6(d)),
		cname: (d) => soft(resolver.resolveCname(d)), mx: (d) => soft(resolver.resolveMx(d)), txt: (d) => soft(resolver.resolveTxt(d)), ptr: (ip) => soft(resolver.reverse(ip)),
	};

	const http = deps.http || {
		async get(url, { maxBytes = 300000 } = {}) {
			const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
			try {
				const r = await f(url, { redirect: 'manual', signal: ctl.signal, headers: { 'user-agent': 'ChurchWebOps/1.0' } });
				const text = (await r.text()).slice(0, maxBytes);
				return { status: r.status, headers: Object.fromEntries(r.headers), location: r.headers.get('location') || '', text };
			} catch (e) { return { status: 0, headers: {}, location: '', text: '', error: e.cause?.code || e.message }; } finally { clearTimeout(t); }
		},
	};
	const tlsInfo = deps.tls || ((host) => new Promise((resolve) => {
		const s = tls.connect({ host, port: 443, servername: host, timeout: 10000 }, () => {
			const c = s.getPeerCertificate(); const res = { authorized: s.authorized, error: s.authorizationError || '', validTo: c?.valid_to || '', subject: c?.subject?.CN || '' };
			s.end(); resolve(res);
		});
		s.on('error', (e) => resolve({ authorized: false, error: e.code || e.message }));
		s.on('timeout', () => { s.destroy(); resolve({ authorized: false, error: 'timed out' }); });
	}));

	// Run commands on the Hostinger account over SSH (ssh2 is loaded only when it is used).
	const ssh = deps.ssh || {
		available: () => !!(cfg.sshHost && cfg.sshUser && (cfg.sshKey || cfg.sshPassword)),
		async exec(cmd, { timeout = 120000 } = {}) {
			const { Client } = await import('ssh2');
			return new Promise((resolve, reject) => {
				const c = new Client(); let out = '', err = '';
				const timer = setTimeout(() => { c.end(); reject(new Error('SSH command timed out')); }, timeout);
				c.on('ready', () => c.exec(cmd, (e, stream) => {
					if (e) { clearTimeout(timer); c.end(); return reject(e); }
					stream.on('data', (d) => (out += d)).stderr.on('data', (d) => (err += d));
					stream.on('close', (code) => { clearTimeout(timer); c.end(); resolve({ code, out, err }); });
				})).on('error', (e) => { clearTimeout(timer); reject(e); })
					.connect({ host: cfg.sshHost, port: cfg.sshPort, username: cfg.sshUser, ...(cfg.sshKey ? { privateKey: cfg.sshKey, passphrase: cfg.sshPassphrase || undefined } : { password: cfg.sshPassword }), readyTimeout: 15000 });
			});
		},
	};

	/** Can we open a TCP connection to host:port? (Used by the email health check.) */
	const probe = deps.probe || ((host, port) => new Promise((resolve) => {
		const s = net.connect({ host, port, timeout: 6000 });
		s.on('connect', () => { s.destroy(); resolve({ open: true }); });
		s.on('timeout', () => { s.destroy(); resolve({ open: false, error: 'timed out' }); });
		s.on('error', (e) => resolve({ open: false, error: e.code || e.message }));
	}));

	/** Hostinger's hosting API (https://developers.hostinger.com). */
	const hostinger = {
		available: () => !!cfg.hostingerApiKey,
		async get(path) { return req(f, cfg.hostingerApiBase + path, { headers: { authorization: 'Bearer ' + cfg.hostingerApiKey } }); },
		async call(method, path, body) {
			const r = await req(f, cfg.hostingerApiBase + path, { method, headers: { authorization: 'Bearer ' + cfg.hostingerApiKey }, body });
			if (!r.ok) throw new Error('Hostinger: ' + errText(r, r.status === 401 || r.status === 403 ? 'check HOSTINGER_API_KEY and its permissions' : ''));
			return r.data;
		},
		async websites() { const r = await hostinger.get('/api/hosting/v1/websites?per_page=100'); if (!r.ok) throw new Error('Hostinger: ' + errText(r)); return Array.isArray(r.data) ? r.data : r.data?.data || []; },
		/** The hosting account these sites live on (username and order id), read from an existing site. */
		async account() { const w = (await hostinger.websites())[0]; if (!w?.username || !w?.order_id) throw new Error('Hostinger: couldn\'t read the account username and order id from the website list.'); return { username: w.username, order_id: w.order_id }; },
		createWebsite: (domain, order_id) => hostinger.call('POST', '/api/hosting/v1/websites', { domain, order_id }),
		installWordPress: (username, b) => hostinger.call('POST', `/api/hosting/v1/accounts/${encodeURIComponent(username)}/wordpress/installations`, b),
		addParkedDomain: (username, site, parked) => hostinger.call('POST', `/api/hosting/v1/accounts/${encodeURIComponent(username)}/websites/${encodeURIComponent(site)}/parked-domains`, { parked_domain: parked }),
		parkedDomains: async (username, site) => { const r = await hostinger.get(`/api/hosting/v1/accounts/${encodeURIComponent(username)}/websites/${encodeURIComponent(site)}/parked-domains`); if (!r.ok) throw new Error('Hostinger: ' + errText(r)); return Array.isArray(r.data) ? r.data : r.data?.data || []; },
		installSsl: (username, domain) => hostinger.call('POST', `/api/hosting/v1/accounts/${encodeURIComponent(username)}/websites/${encodeURIComponent(domain)}/ssl/setup`),
		deleteWebsite: (domain) => hostinger.call('DELETE', `/api/hosting/v1/websites/${encodeURIComponent(domain)}`),
	};
	const smartermail = makeSmarterMail(cfg, { fetch: f });
	return { cfg, gateway, cloudflare, postmark, dns: dnsClient, http, tls: tlsInfo, ssh, probe, smartermail, hostinger };
}
