// Shared top bar: logo, tabs, who is signed in. Built right away so the page doesn't jump, then filled in once we know who you are.
(() => {
	const bar = document.getElementById('topbar');
	if (!bar) return;
	const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'duda-export' };
	// Five main tabs. Customers and Support each have a second row for the pages that belong under them.
	const GROUPS = [
		{ label: 'Prospects', pages: [['/prospects', 'Prospects']] },
		{ label: 'Customers', pages: [['/customers', 'Customers'], ['/email', 'Email setup']] },
		{ label: 'Directory', lvl: 'acct', pages: [['/directory', 'Directory']] },
		{ label: 'Users', lvl: 'admin', pages: [['/users', 'Users']] },
		{ label: 'Support', lvl: 'acct', pages: [['/support', 'Support'], ['/registrar', 'Registrar', 'acct'], ['/domains', 'Domains', 'acct'], ['/analytics', 'Analytics', 'admin'], ['/whmcs', 'WHMCS', 'admin'], ['/activity', 'Activity', 'acct']] },
	];
	const here = location.pathname.replace(/\/$/, '') || '/';
	const groupHere = GROUPS.find((g) => g.pages.some((p) => p[0] === here));
	let role = null; // null until we know who is signed in: show only the tabs that need no account
	const allowed = (lvl) => !lvl || (role !== null && (lvl === 'acct' || role === 'admin'));
	const tab = (g) => `<a class="tab-top${g === groupHere ? ' on' : ''}" href="${g.pages[0][0]}">${g.label}</a>`;
	const sub = document.createElement('nav'); sub.className = 'subtabs'; sub.hidden = true; bar.after(sub);
	const paint = () => {
		bar.querySelector('.tabs-top').innerHTML = GROUPS.filter((g) => allowed(g.lvl)).map(tab).join('');
		const pages = groupHere ? groupHere.pages.filter((p) => allowed(p[2])) : [];
		sub.hidden = pages.length < 2;
		sub.innerHTML = pages.map(([href, label]) => `<a class="${here === href ? 'on' : ''}" href="${href}">${label}</a>`).join('');
	};
	bar.className = 'topbar';
	bar.innerHTML = `<a class="brand" href="/prospects"><img src="/assets/logo.png" alt="ChurchWeb Global"></a><nav class="tabs-top"></nav><div class="who"><span id="whoami"></span><button id="logout" type="button">Sign out</button></div>`;
	paint();
	document.getElementById('logout').addEventListener('click', async () => { await fetch('/logout', { method: 'POST', headers: H }); location.href = '/'; });
	fetch('/api/me', { headers: H }).then((r) => (r.ok ? r.json() : null)).then((me) => {
		if (!me || !me.user) return;
		if (me.mode === 'accounts') { role = me.user.role; paint(); document.getElementById('whoami').innerHTML = `<a href="/account">${(me.user.name || me.user.email).replace(/[<>&"]/g, '')}</a>`; }
		if (me.user.mustChange && here !== '/account') location.href = '/account';
		window.PORTAL_ME = me;
		if (me.mode === 'accounts' && !me.user.mustChange) { const sc = document.createElement('script'); sc.src = '/assets/assistant.js'; document.body.appendChild(sc); }
		if (me.mode === 'accounts') fetch('/api/registrar/summary', { headers: H }).then((r) => (r.ok ? r.json() : null)).then((s) => {
			if (!s || !s.d30) return;
			const dot = (el) => { if (el && !el.querySelector('.navdot')) el.insertAdjacentHTML('beforeend', ` <span class="navdot" title="${s.d30} domain renewal${s.d30 === 1 ? '' : 's'} due within 30 days">${s.d30}</span>`); };
			dot([...bar.querySelectorAll('.tab-top')].find((a) => a.textContent.trim() === 'Support')); dot([...sub.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/registrar'));
		}).catch(() => {});
	}).catch(() => {});
})();
