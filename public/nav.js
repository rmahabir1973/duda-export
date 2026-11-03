// Shared top bar: logo, tabs, who is signed in. Built right away so the page doesn't jump, then filled in once we know who you are.
(() => {
	const bar = document.getElementById('topbar');
	if (!bar) return;
	const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'duda-export' };
	const TABS = [['/deploy', 'Customers'], ['/email', 'Email setup'], ['/directory', 'Directory', 'acct'], ['/domains', 'Domains', 'acct'], ['/whmcs', 'WHMCS', 'admin'], ['/exporter', 'Exporter'], ['/activity', 'Activity', 'acct'], ['/users', 'Users', 'admin']];
	const here = location.pathname.replace(/\/$/, '') || '/';
	const tab = ([href, label]) => `<a class="tab-top${here === href ? ' on' : ''}" href="${href}">${label}</a>`;
	bar.className = 'topbar';
	bar.innerHTML = `<a class="brand" href="/deploy"><img src="/assets/logo.png" alt="ChurchWeb Global"></a><nav class="tabs-top">${TABS.filter((t) => !t[2]).map(tab).join('')}</nav><div class="who"><span id="whoami"></span><button id="logout" type="button">Sign out</button></div>`;
	document.getElementById('logout').addEventListener('click', async () => { await fetch('/logout', { method: 'POST', headers: H }); location.href = '/'; });
	fetch('/api/me', { headers: H }).then((r) => (r.ok ? r.json() : null)).then((me) => {
		if (!me || !me.user) return;
		const nav = bar.querySelector('.tabs-top');
		if (me.mode === 'accounts') { nav.innerHTML = TABS.filter((t) => t[2] !== 'admin' || me.user.role === 'admin').map(tab).join(''); document.getElementById('whoami').innerHTML = `<a href="/account">${(me.user.name || me.user.email).replace(/[<>&"]/g, '')}</a>`; }
		if (me.user.mustChange && here !== '/account') location.href = '/account';
		window.PORTAL_ME = me;
		if (me.mode === 'accounts' && !me.user.mustChange) { const sc = document.createElement('script'); sc.src = '/assets/assistant.js'; document.body.appendChild(sc); }
	}).catch(() => {});
})();
