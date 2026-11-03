# duda-export-web

A password-protected web page that runs the **duda-export** tool for you: type a church's live domain, watch the
progress log, download the ZIP package. Built to run on Railway at `duda.churchwebglobal.com`.

```
browser (or an agent with the API token)  ->  this app (Express)  ->  duda-export (headless Chromium)  ->  ZIP
```

## Deploy on Railway

1. Put this folder in a **private** GitHub repo (e.g. `rmahabir1973/duda-export-web`).
2. Railway -> your new project -> **New -> GitHub Repo** -> pick it. Railway finds the `Dockerfile` and builds it
   (the first build takes a few minutes: it installs Chromium).
3. Service -> **Variables**:

   | Variable | Required | What |
   |---|---|---|
   | `APP_PASSWORD` | yes | The login password, 10+ characters (e.g. `openssl rand -base64 18`) |
   | `API_TOKEN` | no | 24+ characters. Lets scripts/agents call the API with `Authorization: Bearer ...` |
   | `DUDA_MCP_TOKEN` | no | Your DUDA MCP token (Duda account settings). Enables drafts, content library, blog authors/dates. Preferred |
| `DUDA_MCP_URL` | no | DUDA MCP endpoint; defaults to `https://mcp.duda.co/mcp` |
| `DUDA_API_USER`, `DUDA_API_PASS` | no | Alternative to the MCP token: DUDA REST API credentials (only if you have them) |
   | `ALLOWED_DOMAINS` | no | Comma list (e.g. `churchwebglobal.com,erindaleunited.church`) to restrict what can be exported |
   | `MAX_CONCURRENT_JOBS` | no | Default 1. Each job uses about 1 GB RAM while Chromium runs |
   | `RETENTION_HOURS` | no | Default 48. ZIPs and logs are deleted after this |
   | `MAX_PAGES_CAP` | no | Default 500 (upper limit for the "max pages" box) |
   | `JOB_TIMEOUT_MIN` | no | Default 45 |

   Do **not** set `PORT` (Railway sets it).
4. Service -> **Settings -> Deploy -> Healthcheck Path**: `/healthz`.
5. Service -> **Settings -> Networking -> Custom Domain**: `duda.churchwebglobal.com`. Railway shows the record(s) to
   add. In Cloudflare (DNS for churchwebglobal.com) add that CNAME (and the TXT verification record if Railway shows one).
   Leave it **DNS only (grey cloud)** until Railway shows the certificate as issued; you can turn the proxy on afterwards
   with SSL mode "Full (strict)".
6. Give the service at least **1-2 GB memory** (Chromium). Open the URL, sign in, run a small test with *Max pages = 3*.

Storage is the container's temp disk (`/tmp`), so exports disappear on a redeploy. That is intentional: they are
cheap to regenerate. For persistence add a Railway Volume mounted at `/data`, set `DATA_DIR=/data` and
`RAILWAY_RUN_UID=0`.

## Using it

* **Browser:** sign in, enter the church's live domain (`www.example.org`), optionally tick *Use the DUDA API*,
  press *Start export*. A full church site takes 4-8 minutes. Download the ZIP when the badge says *done*.
* **Agents/scripts** (needs `API_TOKEN`):
  ```
  curl -X POST https://duda.churchwebglobal.com/api/jobs \
    -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" \
    -d '{"domain":"www.example.org","useApi":true}'
  curl -H "Authorization: Bearer $API_TOKEN" https://duda.churchwebglobal.com/api/jobs/<id>          # status + log
  curl -H "Authorization: Bearer $API_TOKEN" -o export.zip https://duda.churchwebglobal.com/api/jobs/<id>/download
  ```
  Other endpoints: `GET /api/jobs`, `POST /api/jobs/<id>/cancel`, `DELETE /api/jobs/<id>`, `GET /healthz`.

## Security notes

* One shared password; sessions are signed, HttpOnly, SameSite=Lax cookies (12 h). 5 wrong passwords lock that IP for 10 minutes.
  Writes from the browser also require a custom header and a same-site Origin (CSRF).
* The server fetches websites on your behalf, so it only accepts real domain names that resolve to **public** addresses
  (no IPs, localhost, private/link-local ranges) and can be restricted further with `ALLOWED_DOMAINS`.
  Known limit: a hostile site could change its DNS after the check (DNS rebinding) or redirect the browser to an
  internal address. The password gate and an `ALLOWED_DOMAINS` list are the mitigation; keep this internal.
* DUDA credentials stay in Railway variables and are passed only to the exporter process, never to the browser.
* Keep the GitHub repo private. Rotate `APP_PASSWORD` by changing the variable (all sessions stay valid until they expire unless you also change `SESSION_SECRET`).

## Run locally

```
npm install && npx playwright install chromium
APP_PASSWORD='a-long-password' node server.mjs        # http://localhost:3000
```
(Set `CHROMIUM_PATH` to use an existing Chrome/Chromium.)

## Tested / not tested

Tested locally: login and lockout, bearer token, CSRF refusal, rejection of private/internal/malformed domains, a real
export of the live Erindale site through the browser UI (progress log, summary, ZIP download), cancel, delete, sign out.
**Not tested:** the Docker image build and the Railway deployment itself (no Docker or Railway access from where this was built).
If the first Railway build fails, send the build log.

## Non-DUDA sites and prospect previews

The exporter also works on **any other church website** (WordPress, Wix, Squarespace, Weebly, GoDaddy, hand-built). *Website type* defaults to automatic detection. Generic mode detects the main content of each page, drops menus, sidebars, footers and cookie banners, removes blocks repeated on most pages (logged in `data/boilerplate-removed.md`), and also finds pages from the home page menu when there is no sitemap.

**Preview only** exports the home page plus up to 6 key pages (about, worship/times, visit/contact, ministries, staff), skips documents, and adds preview prompts to `assistant-prompts.md`. The package also contains:
- `site-brief.md`: service times, address lines, schema.org data, phone and email found.
- `data/brand.json` and a "Brand colours" section: dominant colours of the logo and the site's CSS, with a suggested primary and accent colour to use as custom colours in the Design gallery.

Content belongs to the church: keep previews password-protected and noindex, and do not reuse photos of identifiable people.

## Batch of prospects

The "Batch of prospects" card takes up to 40 churches at a time, one per line: `Church name, website` (or just the website; rows pasted from a spreadsheet work). They run one after another using the same settings as a single export, with "Preview only" ticked by default (home + key pages, no documents), which is the right size for outreach previews. Each ZIP downloads under the church's name, and "Download the list as a spreadsheet" gives a CSV of every export with status, page and image counts and anything flagged to check. `MAX_QUEUE` (default 40) caps how many jobs can wait at once.

## Deploy a church

Each customer is a **project**. The Deploy page opens on a **board**: one column per phase (Domain setup → Preview site → Review & approval → Switch domain → Go live → Email → Handover → Done), one card per customer showing progress and the next task. Add a customer when they sign up; open the card for their project page, which has a tab per phase with that phase's tasks.

**Hostinger is driven through its API** (`HOSTINGER_API_KEY`): create the preview site, install WordPress, add the church's real domain to the site (parked domain) and issue the certificate. Plugins are copied from the template site over SSH. Optional: `WP_ADMIN_EMAIL` (WordPress admin email when the customer has no contact email yet).

Open **Deploy a church** (top right of the Exporter). Add a church (name, optional current website, plan). The page shows eight stages. Each stage is a short list of plain questions, checked live:

- ✔ **yes**: nothing to do.
- ✖ **no** with a button: one click fixes it (for example "Add the DNS record", "Connect it", "Add it to Cloudflare").
- ✖ **no** with "How to do this by hand": the few things a person must do (create the site in hPanel, the church switching nameservers, the Oxygen licence, mailboxes). Tick **Done** where it asks, or press Re-check: where the app can look, it detects the change itself.
- Items wait ("…") until the item they depend on is done, so the order is always safe.

**Check everything** looks at all eight stages without changing anything. **Fix everything that can be fixed** in a stage runs the safe fixes in order and stops at the first problem. Switching a church's email (MX) is never part of that: it has its own button and its own confirmation.

| # | Stage | Questions it answers |
|---|-------|----------------------|
| 1 | Preview site | Created on Hostinger? Preview address in DNS? AI Assistant plugin active and connected to our gateway? Address, name and preview mode right? Oxygen licensed? |
| 2 | Where is the church today? | Read-only: where DNS, the website and email are now; SPF health |
| 3 | Approval and payment | Approved, plan, paid, registrar contact (tick-boxes) |
| 4 | Move the domain's DNS | In our Cloudflare? Records copied? Nameservers switched? Website pointing at Hostinger? |
| 5 | Go live | Domain shows the new site? SSL valid? WordPress address real? Preview mode off? www, robots, sitemap fine? |
| 6 | Email accounts (Email plan) | Mailboxes created? Old mail moved? Email now going to our server? |
| 7 | Sending email (Postmark) | Domain in Postmark? Records in Cloudflare? One SPF + DMARC? Verified? Website sending through Postmark? |
| 8 | Hand over | Church login? Staff view on? AI Assistant switched on? Welcome email, Stripe, backups, monitoring |

## Email setup page

Open **Email setup** (top of the screen). Four steps, in this order:
1. **Create the church's email**: enter the domain, the addresses (just the part before the @) and one default password. It adds the domain on our SmarterMail server and creates each mailbox. *Preview* shows exactly what it will do first. Passwords are never saved or shown again.
2. **Send outgoing email through Postmark**: adds the domain at Postmark, puts DKIM, Return-Path, one merged SPF and DMARC in Cloudflare, and asks Postmark to verify. The domain must already be in our Cloudflare (Deploy page, Domain setup).
3. **Check that everything is set up**: an MX-toolbox-style read-only check (MX, mail server address, reverse DNS, ports 587/993, certificate, SPF, DKIM, DMARC, autodiscover).
4. **Send a test email** through Postmark.

SmarterMail variables: `SMARTERMAIL_URL`, `SMARTERMAIL_ADMIN_USER`, `SMARTERMAIL_ADMIN_PASSWORD`. Optional: `SMARTERMAIL_DOMAIN_PATH` (default `C:\SmarterMail\Domains\{domain}`: check it against an existing domain) and `SMARTERMAIL_DOMAIN_ADMIN` (default `postmaster`). Not yet tested against the live mail server.

### Environment variables (set as Railway variables, never in chat)

`GATEWAY_ADMIN_KEY`, `GATEWAY_URL`, `DEFAULT_DAILY_TOKENS`, `DEFAULT_DAILY_IMAGES` · `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_PREVIEW_ZONE_ID`, `PREVIEW_DOMAIN`, `HOSTINGER_IP`, `TEMPLATE_SLUG` · `POSTMARK_ACCOUNT_TOKEN`, `POSTMARK_SERVER_TOKEN` · `SSH_HOST`, `SSH_PORT`, `SSH_USER`, `SSH_PRIVATE_KEY` (use `\n` for line breaks), `SSH_PASSPHRASE`, `SITE_ROOT` (default `$HOME/domains/{host}/public_html`), `WP_CLI` · `DUDA_IPS`, `DUDA_HOSTS`, `OUR_MX_HOSTS`, `MAIL_HOST`, `DMARC_RUA`, `DNS_SERVERS` · `SMARTERMAIL_API_READY`.

Cloudflare token permissions: Zone:Create (account), Zone:Read, DNS:Edit for all zones. The top of the page shows which services are configured.

### Safety rules built in
- Checking never changes anything. A fix only runs when someone presses its button, and only if that item currently checks "no".
- The site folder is found automatically (Hostinger puts subdomains in different places).
- DNS records are only added or changed. A conflicting record is flagged for a person to remove.
- One SPF record per domain (existing ones are merged, never duplicated).
- MX is never changed until mailboxes exist and old mail is moved.
- Secrets (gateway keys, Postmark token, temporary passwords) are masked in output and not stored. Temporary passwords are shown once.
- Every value placed in a shell command is quoted. One action at a time per church. Every action is logged on the church's page.

### Not yet tested against the real services
Cloudflare, Postmark, SSH/WP-CLI on Hostinger and the gateway mint call are tested only against fakes (`npm test`). Do a first run on a throwaway church. Not yet automated: creating the subdomain/clone in hPanel, adding the domain in hPanel, and the SmarterMail domain/mailboxes (needs your server's `/Documentation/api`).

## ChurchWeb Portal (v7.0)

The app is now a team portal: sign-in accounts, a shared activity log, the United Church of Canada directory, and the existing deploy and email tools, all behind one login.

### Railway variables
| Variable | What it does |
|---|---|
| `DATABASE_URL` (or `NEON_DATABASE_URL`) | Neon connection string. Tables are created automatically. Without it the portal falls back to the old single password and the new tabs show a "needs the database" page. |
| `PORTAL_ENC_KEY` | Long random value that encrypts everyone's two-step secrets. Set it once and never change it. |
| `SESSION_SECRET` | Long random value for sessions. |
| `APP_PASSWORD` | Bootstrap password. The first sign-in with it creates the first admin; after that it only matters for the legacy fallback. |
| `DATA_DIR=/data` | Re-add once the entrypoint-fix build is live. |
| `REQUIRE_2FA` | Leave unset. `0` turns the two-step requirement off (emergency only). |
| `RESET_2FA_FOR` | Emergency: an email whose two-step setup is cleared on next start. Remove it afterwards. |
| `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` | Optional. When both are set, every request must carry a valid Cloudflare Access token. Strongly recommended. |

### Accounts and security
- Each person has their own login. Two-step codes (authenticator app) are mandatory, with 8 single-use recovery codes.
- Passwords: 12+ characters, scrypt-hashed. 5 wrong tries locks the account for 15 minutes. Sessions are stored hashed in the database, expire after 12 hours idle (7 days max), and use Secure/HttpOnly/SameSite=Strict cookies.
- Admins create accounts (a one-time temporary password is shown once) and can reset passwords and two-step. The last admin cannot be removed. Only admins can delete a customer's hosted site.
- The activity log is shared by everyone, records who did what and when, and never stores passwords or keys.

### Renaming to portal.churchwebglobal.com
Railway: Settings, Networking, add custom domain `portal.churchwebglobal.com`, then add the CNAME and verification TXT it shows in Cloudflare (DNS only until Railway verifies). Keep the old domain until the new one works.

### Directory
Directory tab: import the exported CSV once under "Manage data". Customers are matched by website or email domain against the customer-domain list.

## v7.1: customer types, prospect email (Loops), and the portal assistant

### Customer types
Every customer is either a **New site** (a prospect: stages start with Prospect and agreement) or **From DUDA** (adds "Move the content from DUDA" after the preview, and "retire the DUDA site / cancel DUDA" at handover). Pick the type when adding a customer; it can be changed under Customer details. Older customers count as New site. On the Directory, **＋ Prospect** adds a church to the board with its email and notes filled in.

### Prospect email through Loops
Set in Railway: `LOOPS_API_KEY`, `LOOPS_WEBHOOK_SECRET` (below), and optionally `LOOPS_OUTREACH_EVENT` (default `prospect_outreach`) and `OUTREACH_DAILY_CAP` (default 25, hard maximum 200).

One-time setup in Loops:
1. Add contact properties `churchName`, `city`, `province` (Settings, Contact properties). Add event properties `churchName` and `city` if you want them in the email.
2. Create a **Loop** that starts on the event `prospect_outreach` and sends the intro email. Use the Loops unsubscribe link and put the company name and address in the footer.
3. Settings, Webhooks: endpoint `https://portal.churchwebglobal.com/webhooks/loops`, tick the email and contact events (delivered, opened, clicked, bounced, unsubscribed, spam reported), and copy the signing secret (`whsec_...`) into `LOOPS_WEBHOOK_SECRET`.

Sending: Directory, filter, "Email these churches", Preview, type the exact number, Send. Customers, bounced/unsubscribed/complaint addresses, anyone emailed in the last 60 days (same campaign) and duplicate addresses are always skipped. Loops reports back through the webhook, which fills the stats and the do-not-contact list. The webhook path is the only unauthenticated one: it is exempt from Cloudflare Access and accepts only requests signed by Loops (checked on the raw body, 5 minute window).

### The portal assistant
A chat panel on every page (needs `GATEWAY_ADMIN_KEY`, which it uses to get its own gateway token for the site id `portal`, or `ANTHROPIC_API_KEY` to call Anthropic directly; `PORTAL_AI_MODEL` overrides the model). It can read customers, run checks, check email DNS, search the directory and see outreach results. It can **propose** changes (fix one task, change a mailbox password, set outreach status, add a prospect); each shows an Approve card and nothing runs until a person approves it. New passwords are generated server-side and shown once to the person, never to the AI. Every approved or declined change is in the Activity log. Mailbox passwords are changed through the SmarterMail API and confirmed by signing in with the new password; if SmarterMail does not accept the API call the assistant says so and nothing changes.

### WHMCS: how customers pay (v7.5)
The **WHMCS** tab (admins only) is a read-only copy of WHMCS, built to answer "how many customers pay by cheque?" before deciding on a move to Stripe. It lists, for active services, customers and annual recurring amounts by payment kind (card, cheque or mail-in, bank transfer, other), plus paid invoices, unpaid and overdue invoices and the average days to pay over the last 12 months. It also lists each customer with a CSV download. The portal guesses each WHMCS gateway's kind from its name; change a wrong guess in the gateway table and the numbers update at once. Free and one-time services do not decide how a customer "pays".

It can only read: the client refuses every WHMCS action except `GetClients`, `GetClientsProducts`, `GetInvoices` and `GetPaymentMethods`, sends the API login only in the request body over https, and keeps the last good copy if a sync fails. Annual amounts are shown per currency and are never added across currencies; the currency comes from each customer's latest invoice.

Set in Railway: `WHMCS_URL` (for example `https://my.churchwebglobal.com`), `WHMCS_API_IDENTIFIER`, `WHMCS_API_SECRET`. If WHMCS restricts the API by IP, add the portal's outbound IP in WHMCS (Settings > Security > API IP Access Restriction) or set `WHMCS_ACCESS_KEY` to the `$api_access_key` from WHMCS's `configuration.php`. In WHMCS, create the API credential with an API Role that allows only the four actions above. Optional: `WHMCS_SYNC_HOURS` (default 12, `0` turns the automatic sync off). Exports and syncs appear in the Activity log.

### Domains we host (sync)
The **Domains** tab lists every domain found in Cloudflare (the churches account), DUDA (published sites' custom domains), SmarterMail (email domains) and Hostinger (sites and parked domains), and shows the gaps (for example "in DUDA, not in Cloudflare"). It syncs on start (after 45 seconds) and every 6 hours (`HOSTED_SYNC_HOURS`, `0` turns it off), or press Sync now. Each source reports its own result; one failing never wipes the others. Everything found (except our own domains, `OWN_DOMAINS`, default `churchwebglobal.com,churchwebsupport.com`) becomes a customer domain, so the Directory's customer marks and the assistant's `lookup_domain` answer "do we host this church?" from real data.

Needs in Railway: `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` (the churches account), `DUDA_MCP_TOKEN` (the same token the exporter uses; `DUDA_API_USER/PASS` alone are not enough for the list), `SMARTERMAIL_*`, `HOSTINGER_API_KEY`. SmarterMail's domain-list call differs between versions; if the sync reports it could not list domains, the error says which calls were tried.

### Where the data lives
Everything that matters is in Neon: accounts, sessions, the activity log, the directory, outreach, hosted domains, and (since v7.2) **the Customers board**, saved as one record in the `kv` table on every change. The data folder (`DATA_DIR`) now only holds export job files (large ZIPs), which are disposable. On first start after upgrading, the board is copied from the old file into Neon if Neon has none yet; after that Neon is the source of truth and a redeploy cannot lose customers. To recover customers from before this change, set `DATA_DIR=/data` (the Railway volume) for one deploy so the old `deploy/churches.json` is found and copied in.

### Rebuilding the Customers board from Hostinger
If customers are missing from the board (for example after a redeploy wiped the old file), open **Domains**: any site on Hostinger named `slug.churchwebglobal.com` that is not on the board is listed, with the real domain parked on it and a guess at the type (from DUDA if that domain is also a DUDA site). Tick them and press "Add". Then open each customer and press "Check everything" to bring its tasks up to date.

### Changing PORTAL_ENC_KEY without locking anyone out
Two-step secrets are encrypted with `PORTAL_ENC_KEY` (or, when that is not set, `SESSION_SECRET`). The portal now also tries `SESSION_SECRET` and any keys listed in `PORTAL_ENC_KEY_OLD` (comma separated) when it opens a secret, and on a successful sign-in it re-saves the secret under the current key. So adding `PORTAL_ENC_KEY` later, or rotating it, does not break existing sign-ins: put the previous key in `PORTAL_ENC_KEY_OLD` until everyone has signed in once. Recovery codes never depend on the key.
