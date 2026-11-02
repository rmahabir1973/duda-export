// SmarterMail REST API (documented at <mail server>/Documentation/api). Only the calls we use:
//   POST api/v1/auth/authenticate-user        {username, password}       -> {accessToken, refreshToken}
//   POST api/v1/settings/sysadmin/domain-put  {domainData, ...}          (system administrators)
//   POST api/v1/settings/domain/user-put      {userData: {...}}          (domain administrators)
const timeout = 20000;
const msg = (r) => {
	const d = r.data;
	if (typeof d === 'string') return d.slice(0, 200);
	return (d && (d.message || d.error?.message || d.error)) || r.error || 'HTTP ' + r.status;
};

export function makeSmarterMail(cfg, { fetch: f = globalThis.fetch } = {}) {
	const base = cfg.smartermailUrl || '';
	const call = async (path, { token, body, method = 'POST' } = {}) => {
		const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeout);
		try {
			const r = await f(`${base}/${path}`, { method, headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
			const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
			return { ok: r.ok, status: r.status, data };
		} catch (e) { return { ok: false, status: 0, data: null, error: e.name === 'AbortError' ? 'timed out' : e.message }; } finally { clearTimeout(t); }
	};
	const self = {
		available: () => !!(base && cfg.smartermailUser && cfg.smartermailPassword),
		/** Returns an access token (valid 15 minutes). */
		async login(username, password) {
			const r = await call('api/v1/auth/authenticate-user', { body: { username, password } });
			if (!r.ok || !r.data?.accessToken) throw new Error('SmarterMail login failed: ' + msg(r) + (r.status === 0 ? ` (cannot reach ${base})` : ''));
			return r.data.accessToken;
		},
		sysLogin: () => self.login(cfg.smartermailUser, cfg.smartermailPassword),
		domainPath: (domain) => cfg.smartermailDomainPath.replace('{domain}', domain),
		/** Creates the domain and its first administrator. {exists:true} if it is already there. */
		async addDomain(token, { domain, adminUsername, adminPassword }) {
			const body = { domainData: { name: domain, path: self.domainPath(domain), hostname: cfg.mailHost, isSplitDomain: false }, domainLocation: 'Local', domainLocationAddress: '', deliverLocallyForExternalDomain: false, adminUsername, adminPassword };
			const r = await call('api/v1/settings/sysadmin/domain-put', { token, body });
			if (r.ok && r.data?.success !== false) return { ok: true };
			if (/exist|already|duplicate/i.test(msg(r))) return { ok: true, exists: true };
			return { ok: false, error: msg(r), status: r.status };
		},
		/** Sets an existing user's password. The caller must check it worked (sign in with the new password): SmarterMail versions differ in what they accept. */
		async setPassword(token, { domain, userName, password }) {
			let last = '';
			for (const userData of [{ userName, password, domain }, { userName: `${userName}@${domain}`, password, domain }]) {
				const r = await call('api/v1/settings/domain/user-put', { token, body: { userData } });
				if (r.ok && r.data?.success !== false) return { ok: true };
				last = msg(r);
			}
			return { ok: false, error: last };
		},
		async addUser(token, { domain, userName, password, fullName }) {
			const body = { userData: { userName, password, fullName: fullName || userName, domain } };
			const r = await call('api/v1/settings/domain/user-put', { token, body });
			if (r.ok && r.data?.success !== false) return { ok: true };
			if (/exist|already|duplicate|in use/i.test(msg(r))) return { ok: true, exists: true };
			return { ok: false, error: msg(r), status: r.status };
		},
	};
	return self;
}
