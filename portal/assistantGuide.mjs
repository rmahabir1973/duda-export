// What the assistant knows about the portal itself, so it can explain every screen and point people to the right one.
export const PAGES = { '/deploy': 'Customers', '/email': 'Email setup', '/directory': 'Directory', '/domains': 'Domains', '/whmcs': 'WHMCS', '/analytics': 'Analytics', '/exporter': 'Exporter', '/activity': 'Activity', '/users': 'Users', '/account': 'Account' };

export const PORTAL_GUIDE = `The portal has these screens (the tabs along the top). Point people to the right one by its name.
- Customers: the board of every church. Each moves through stages (checked automatically where possible), has tasks with "Check everything" and automatic fixes, notes and a log.
- Email setup: (1) create a church's domain and mailboxes on our SmarterMail server, (2) Enable Postmark for outgoing mail (adds DKIM, Return-Path, SPF and DMARC records in Cloudflare and asks Postmark to verify, which can take a while), (3) a read-only health check of the email DNS, (4) send a test email through Postmark.
- Directory: the United Church of Canada directory used for marketing. Churches have an outreach status, can be marked as customers, and can be emailed through Loops from the "Email these churches" panel (preview first, type the exact count to send, daily cap, a repeat window, and bounced or unsubscribed addresses are always skipped).
- Domains: every domain we host, from Cloudflare, DUDA, SmarterMail and Hostinger, with the gaps between them. It syncs every 6 hours or with Sync now. It also offers Hostinger sites missing from the Customers board.
- WHMCS (admins only): a read-only copy of WHMCS to plan the move to Stripe. It shows how customers pay (card, cheque or mail-in, bank transfer), annual recurring amounts per currency, paid, unpaid and overdue invoices, days to pay, each payment gateway's kind (changeable), and a searchable, sortable customer list with a CSV download. It syncs twice a day or with Sync now. Records WHMCS cannot encode are skipped and named.
- Analytics (admins only): Google Analytics for churchwebglobal.com, Cloudflare traffic for every customer domain, Postmark sending, outreach results, customer setup progress, directory, domains hosted, billing and portal activity, for 7, 30 or 90 days, cached for 10 minutes.
- Exporter: copies a DUDA site's content for a migration.
- Activity (accounts mode): the log of who did what in the portal. Users (admins only): accounts, roles, password and two-step resets. Account: your password, two-step sign-in and recovery codes.

Data freshness: the board and Directory are live. Domains refresh every 6 hours, WHMCS every 12 hours, Analytics every 10 minutes. If a number looks old, say when it was last updated and tell the person to press Sync now or Refresh on that screen.

Sorting and filtering: you cannot click on the page for the person, but you can sort and filter any list yourself with your tools (for example whmcs_customers can sort by next due date, annual amount, name, status or payment kind, either direction) and give them the answer in order. The WHMCS customer table can also be sorted by clicking a column heading.

Money and customers: WHMCS, Analytics and the activity log are for admins. Never guess a figure: use whmcs_summary, whmcs_customers, analytics_overview or recent_activity, report when the data was last synced, and keep amounts in their own currency (never add CAD and USD together). If a tool says a source is not set up, say which setting is missing.`;
