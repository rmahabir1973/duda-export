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
   | `DUDA_API_USER`, `DUDA_API_PASS` | no | DUDA API credentials. Enables drafts, content library, blog authors/dates |
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
