import test from 'node:test';
import assert from 'node:assert/strict';
import { makeAscio, parseXml, domainRow } from '../deploy/ascio.mjs';

const envelope = (inner) => `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>${inner}</s:Body></s:Envelope>`;
const domainsXml = (infos, total = infos.length) => envelope(`<GetDomainsResponse xmlns="http://www.ascio.com/2013/02/AscioService"><GetDomainsResult xmlns:a="http://www.ascio.com/2013/02" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><a:ResultCode>200</a:ResultCode><a:ResultMessage>OK</a:ResultMessage><a:Errors i:nil="true"/><a:TotalCount>${total}</a:TotalCount><a:DomainInfos>${infos.join('')}</a:DomainInfos></GetDomainsResult></GetDomainsResponse>`);
const info = ({ name, expires = '2027-03-04T00:00:00', ns = ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'], lock = 'Lock', org = 'St. Paul&apos;s &amp; Co' }) => `<a:DomainInfo><a:DomainName>${name}</a:DomainName><a:DomainHandle>H-${name}</a:DomainHandle><a:RegPeriod>1</a:RegPeriod><a:Status>Active</a:Status><a:AuthInfo i:nil="true"/><a:Created>2015-03-04T00:00:00</a:Created><a:Expires>${expires}</a:Expires><a:TransferLock>${lock}</a:TransferLock><a:Owner><a:OrgName>${org}</a:OrgName><a:FirstName>Jane</a:FirstName><a:LastName>Doe</a:LastName><a:Email>j@x.org</a:Email></a:Owner><a:NameServers>${ns.map((h, i) => `<a:NameServer${i + 1}><a:HostName>${h}</a:HostName></a:NameServer${i + 1}>`).join('')}<a:NameServer3 i:nil="true"/></a:NameServers><a:CustomerReference><a:ExternalId>CW-1</a:ExternalId><a:Description>desc</a:Description></a:CustomerReference></a:DomainInfo>`;

test('ascio: parses WCF-style XML (namespaces dropped, nil to null, repeats to arrays, entities decoded)', () => {
	const d = parseXml('<x:R xmlns:x="u"><x:A>1</x:A><x:A>2</x:A><x:B i:nil="true" xmlns:i="w"/><x:C>a &amp; b</x:C><x:D><![CDATA[<raw>]]></x:D><x:E/></x:R>');
	assert.deepEqual(d, { R: { A: ['1', '2'], B: null, C: 'a & b', D: '<raw>', E: '' } });
});

test('ascio: domainRow flattens a DomainInfo (nameservers in order, owner org, customer reference)', () => {
	const r = domainRow(parseXml(info({ name: 'Grace.ca' }).replace(/a:/g, '')).DomainInfo);
	assert.equal(r.domain, 'grace.ca'); assert.equal(r.expires, '2027-03-04T00:00:00'); assert.equal(r.transfer_lock, 'Lock');
	assert.deepEqual(r.nameservers, ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com']); assert.equal(r.owner_org, "St. Paul's & Co"); assert.equal(r.customer_ref, 'CW-1');
});

test('ascio: GetDomains posts a SOAP 1.1 envelope with the security header and walks pages; a bad login and a fault are plain errors', async () => {
	const calls = [];
	const pages = [[info({ name: 'a.org' }), info({ name: 'b.org' })], [info({ name: 'c.org' })]];
	const fetchImpl = async (url, { headers, body }) => {
		calls.push({ url, action: headers.soapaction, body });
		if (/<h:Password>bad<\/h:Password>/.test(body)) return { ok: true, status: 200, text: async () => envelope('<GetDomainsResponse xmlns="http://www.ascio.com/2013/02/AscioService"><GetDomainsResult xmlns:a="http://www.ascio.com/2013/02"><a:ResultCode>401</a:ResultCode><a:ResultMessage>Authorization failed</a:ResultMessage><a:Errors><a:string>Account or password</a:string></a:Errors></GetDomainsResult></GetDomainsResponse>') };
		if (/<a:Tlds>/.test(body)) return { ok: false, status: 500, text: async () => envelope('<s:Fault><faultcode>s:Server</faultcode><faultstring>boom</faultstring></s:Fault>') };
		const page = Number(/<a:PageIndex>(\d+)<\/a:PageIndex>/.exec(body)[1]);
		return { ok: true, status: 200, text: async () => domainsXml(pages[page - 1] || [], 3) };
	};
	const a = makeAscio({ account: 'churchwebapi', password: 'p&w', fetchImpl });
	assert.ok(a.available()); assert.equal(a.endpoint, 'https://aws.ascio.com/v3/AscioService.svc');
	const r = await a.allDomains();
	assert.equal(r.total, 3); assert.deepEqual(r.domains.map((d) => d.domain), ['a.org', 'b.org', 'c.org']);
	assert.equal(calls.length, 2); assert.equal(calls[0].action, 'GetDomains');
	assert.match(calls[0].body, /<h:SecurityHeaderDetails xmlns:h="http:\/\/www\.ascio\.com\/2013\/02"><h:Account>churchwebapi<\/h:Account><h:Password>p&amp;w<\/h:Password>/);
	assert.match(calls[0].body, /<GetDomains xmlns="http:\/\/www\.ascio\.com\/2013\/02\/AscioService"><request [^>]*><a:OrderSort>ObjectNameAsc<\/a:OrderSort><a:PageInfo><a:PageIndex>1<\/a:PageIndex><a:PageSize>1000<\/a:PageSize><\/a:PageInfo><\/request>/);
	await assert.rejects(makeAscio({ account: 'x', password: 'bad', fetchImpl }).ping(), /Authorization failed \(401\).*whitelisted.*Account or password/);
	await assert.rejects(a.getDomains({ tlds: ['com'] }), /Ascio: boom/);
	assert.match(calls.at(-1).body, /<a:Tlds><b:string>com<\/b:string><\/a:Tlds>/);
	await assert.rejects(makeAscio({}).ping(), /not set up/);
	assert.equal(makeAscio({ account: 'x', password: 'y', live: false }).endpoint, 'https://aws.demo.ascio.com/v3/AscioService.svc');
});
