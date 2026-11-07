// Ascio, the domain registrar most church domains are registered through. Ascio Web Service v3 is SOAP 1.1 (document/literal), so this is a
// small hand-rolled client over fetch: build the envelope, post it, read the XML back. No library, no WSDL at run time.
// Access is by portal account + password in a SOAP header, and Ascio only answers from whitelisted IPs (Account Settings → Whitelisting).
// Live: https://aws.ascio.com/v3/AscioService.svc   OTE/test: https://aws.demo.ascio.com/v3/AscioService.svc
const NS_SVC = 'http://www.ascio.com/2013/02/AscioService', NS_DATA = 'http://www.ascio.com/2013/02';
const xmlEsc = (s) => String(s ?? '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
const xmlUnesc = (s) => String(s ?? '').replace(/&(lt|gt|amp|apos|quot|#x[0-9a-f]+|#\d+);/gi, (m, e) => { const k = e.toLowerCase(); if (k[0] === '#') return String.fromCodePoint(k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10)); return { lt: '<', gt: '>', amp: '&', apos: "'", quot: '"' }[k]; });

/** Serialise a plain object to XML elements in the data namespace. Arrays of strings become <a:string> items (WCF's ArrayOfstring). Element order follows the object, and the WSDL order matters to WCF, so callers list fields in schema order. */
function toXml(obj, prefix = 'a') {
	let out = '';
	for (const [k, v] of Object.entries(obj)) {
		if (v === undefined || v === null || v === '') continue;
		if (Array.isArray(v)) out += `<${prefix}:${k}>${v.map((x) => `<b:string>${xmlEsc(x)}</b:string>`).join('')}</${prefix}:${k}>`;
		else if (typeof v === 'object') out += `<${prefix}:${k}>${toXml(v, prefix)}</${prefix}:${k}>`;
		else out += `<${prefix}:${k}>${xmlEsc(v)}</${prefix}:${k}>`;
	}
	return out;
}

/** A small XML reader: elements become objects keyed by local name (namespaces dropped), repeated children become arrays, leaves become strings, xsi:nil becomes null. Good enough for Ascio's responses, which are plain WCF data contracts without mixed content. */
export function parseXml(xml) {
	const s = String(xml).replace(/<\?xml[^>]*\?>/g, '').replace(/<!--[\s\S]*?-->/g, '');
	let i = 0;
	const local = (name) => name.replace(/^[^:]*:/, '');
	function node() {
		// at '<'
		const m = /^<([^\s/>]+)([^>]*?)(\/?)>/.exec(s.slice(i)); if (!m) throw new Error('Ascio: bad XML near ' + s.slice(i, i + 40));
		i += m[0].length;
		const name = local(m[1]), nil = /nil="true"/.test(m[2]);
		if (m[3] === '/') return [name, nil ? null : ''];
		const children = {}; let text = '', any = false;
		for (;;) {
			const lt = s.indexOf('<', i); if (lt < 0) throw new Error('Ascio: unterminated <' + name + '>');
			text += s.slice(i, lt); i = lt;
			if (s.startsWith('</', i)) { i = s.indexOf('>', i) + 1; break; }
			if (s.startsWith('<![CDATA[', i)) { const e = s.indexOf(']]>', i); text += s.slice(i + 9, e); i = e + 3; continue; }
			const [cn, cv] = node(); any = true;
			if (cn in children) children[cn] = [].concat(children[cn], [cv]); else children[cn] = cv;
		}
		return [name, any ? children : (nil ? null : xmlUnesc(text.trim()))];
	}
	while (i < s.length && s[i] !== '<') i++;
	const [name, value] = node();
	return { [name]: value };
}
const arr = (v) => (v === undefined || v === null || v === '' ? [] : Array.isArray(v) ? v : [v]);
const dig = (o, ...path) => path.reduce((x, k) => (x && typeof x === 'object' ? x[k] : undefined), o);

/** Flatten one DomainInfo into what the portal keeps. */
export function domainRow(d) {
	const ns = d.NameServers && typeof d.NameServers === 'object' ? Object.keys(d.NameServers).sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, ''))).map((k) => dig(d.NameServers, k, 'HostName')).filter((h) => h && typeof h === 'string').map((h) => h.toLowerCase().replace(/\.$/, '')) : [];
	const owner = d.Owner && typeof d.Owner === 'object' ? d.Owner : {};
	const ref = d.CustomerReference && typeof d.CustomerReference === 'object' ? d.CustomerReference : {};
	const str = (v) => (typeof v === 'string' ? v : '');
	return {
		domain: str(d.DomainName).toLowerCase(), handle: str(d.DomainHandle), status: str(d.Status), created: str(d.Created) || null, expires: str(d.Expires) || null,
		transfer_lock: str(d.TransferLock), nameservers: ns, owner_org: str(owner.OrgName), owner_name: [str(owner.FirstName), str(owner.LastName)].filter(Boolean).join(' '), owner_email: str(owner.Email),
		customer_ref: str(ref.ExternalId) || str(ref.Description), renew_period: Number(d.RenewPeriod) || 0,
	};
}

export function makeAscio({ account = '', password = '', live = true, url = '', fetchImpl = globalThis.fetch, timeout = 60000 } = {}) {
	const endpoint = url || (live ? 'https://aws.ascio.com/v3/AscioService.svc' : 'https://aws.demo.ascio.com/v3/AscioService.svc');
	const available = () => !!(account && password);
	async function call(op, request) {
		if (!available()) throw new Error('Ascio is not set up (ASCIO_ACCOUNT and ASCIO_PASSWORD).');
		const body = `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Header><h:SecurityHeaderDetails xmlns:h="${NS_DATA}"><h:Account>${xmlEsc(account)}</h:Account><h:Password>${xmlEsc(password)}</h:Password></h:SecurityHeaderDetails></s:Header><s:Body><${op} xmlns="${NS_SVC}"><request xmlns:a="${NS_DATA}" xmlns:b="http://schemas.microsoft.com/2003/10/Serialization/Arrays">${toXml(request)}</request></${op}></s:Body></s:Envelope>`;
		const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeout);
		let r, text;
		try { r = await fetchImpl(endpoint, { method: 'POST', headers: { 'content-type': 'text/xml; charset=utf-8', soapaction: op }, body, signal: ctl.signal }); text = await r.text(); }
		catch (e) { throw new Error('Ascio: ' + (e.name === 'AbortError' ? 'timed out' : e.message)); }
		finally { clearTimeout(t); }
		let doc; try { doc = parseXml(text); } catch { doc = null; }
		const fault = dig(doc, 'Envelope', 'Body', 'Fault');
		if (fault) { const reason = dig(fault, 'faultstring') || dig(fault, 'Reason', 'Text') || 'SOAP fault'; throw new Error('Ascio: ' + (typeof reason === 'string' ? reason : JSON.stringify(reason)).slice(0, 300)); }
		if (!r.ok || !doc) throw new Error(`Ascio: HTTP ${r.status}${r.status === 403 || r.status === 0 ? ' (is this server\'s IP whitelisted in the Ascio portal?)' : ''}: ${String(text).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)}`);
		const result = dig(doc, 'Envelope', 'Body', op + 'Response', op + 'Result');
		if (!result || typeof result !== 'object') throw new Error('Ascio: unexpected reply to ' + op);
		const code = Number(result.ResultCode);
		if (code !== 200 && code !== 1) { const errs = arr(dig(result, 'Errors', 'string')).join('; '); throw new Error(`Ascio ${op}: ${result.ResultMessage || 'error'} (${code})${code === 401 ? ' — wrong ASCIO_ACCOUNT/ASCIO_PASSWORD, or this IP is not whitelisted' : ''}${errs ? ': ' + errs : ''}`); }
		return result;
	}
	const self = {
		available, endpoint,
		/** One page of GetDomains. Filters are optional and in WSDL order. */
		async getDomains({ names, tlds, status, expireFrom, expireTo, nameServer, pageIndex = 1, pageSize = 1000, sort = 'ObjectNameAsc' } = {}) {
			const r = await call('GetDomains', { ObjectNames: names, Tlds: tlds, Status: status, ExpireFromDate: expireFrom, ExpireToDate: expireTo, NameServerHostName: nameServer, OrderSort: sort, PageInfo: { PageIndex: pageIndex, PageSize: pageSize } });
			return { total: Number(r.TotalCount) || 0, domains: arr(dig(r, 'DomainInfos', 'DomainInfo')).filter((d) => d && typeof d === 'object').map(domainRow) };
		},
		/** Every domain on the account, walking the pages (Ascio caps a page at 1000). */
		async allDomains(opts = {}) {
			const out = []; let total = 0;
			for (let page = 1; page <= 50; page++) {
				const r = await self.getDomains({ ...opts, pageIndex: page, pageSize: 1000 }); total = r.total; out.push(...r.domains);
				if (!r.domains.length || out.length >= total) break;
			}
			return { total, domains: out };
		},
		async getDomain(handle) { const r = await call('GetDomain', { Handle: handle }); return r.DomainInfo && typeof r.DomainInfo === 'object' ? domainRow(r.DomainInfo) : null; },
		/** Cheapest possible "does it work" check: one domain, one page. */
		async ping() { const r = await self.getDomains({ pageSize: 1 }); return { ok: true, total: r.total, endpoint }; },
	};
	return self;
}
