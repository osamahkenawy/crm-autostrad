# Autostrad helpdesk: what we need from infrastructure to go live

Prepared 2026-10-27. The app is the customer-service helpdesk inside the Autostrad CRM (what it does: [HELPDESK.md](HELPDESK.md)).
It reads the shared mailbox `helpdesk@autostrad.com` from Microsoft 365, turns every email into a case, and drafts a reply that a person approves.
This page lists what infrastructure, the Microsoft 365 admin, security and the integration owners must provide or decide.
Everything works today on a built-in demo mailbox; nothing below needs a code change unless it says **dev**.

## 1. At a glance

| # | We need | From | Blocks go-live? |
|---|---|---|---|
| 1 | Microsoft Entra app registration with mail permissions, **restricted to the helpdesk mailbox** (section 2) | M365 admin | Yes |
| 2 | Shared-mailbox setting so replies sent from Outlook are copied to its Sent Items (section 2.6) | Exchange admin | Yes |
| 3 | One Linux server or VM, Node.js 22, 1 vCPU, 2 GB RAM, 10 GB **local** disk (section 3) | Infrastructure | Yes |
| 4 | An HTTPS address for staff, with a reverse proxy in front of the app (section 3.3) | Infrastructure, network | Yes |
| 5 | Secrets kept safely: Graph client secret, token secret, optional AI key (section 4) | Infrastructure, security | Yes |
| 6 | Outbound HTTPS to Microsoft, and to Anthropic only if the AI is on (section 5) | Network | Yes |
| 7 | Daily backup of the database file (section 6) | Infrastructure | Before real data |
| 8 | **Read-only API access** to contract, customer and invoice data in Orion Fleet and the CNR Portal, plus their API documentation (section 7, [CUSTOMER_API.md](CUSTOMER_API.md)) | Integration owners | Yes for useful cases |
| 9 | Decisions: AI on or off, retention period, sign-in method, hosting location (section 10) | Security, legal | Before the pilot |
| 10 | Monitoring and alerts (section 9) | Infrastructure | Before the pilot ends |

**Order of work:** 1 and 2 (they have lead time), 3 to 6 in parallel, then a test run on a test mailbox, then the pilot (section 11).

## 2. Microsoft 365 (steps for the M365 and Exchange admins)

The app reads the mailbox through Microsoft Graph with an **app-only (client credentials)** sign-in. There is no add-in and nobody signs in to the mailbox.

1. **Mailbox.** Confirm `helpdesk@autostrad.com` exists. A shared mailbox is fine.
2. **App registration.** Entra admin center, App registrations, New registration. Name "Autostrad Helpdesk", supported account type "this organizational directory only", no redirect URI.
3. **Permissions.** API permissions, Microsoft Graph, **Application permissions** (not delegated), then **Grant admin consent**:

   | Permission | Why | Needed |
   |---|---|---|
   | `Mail.ReadWrite` | read Inbox and Sent Items, add categories and a follow-up flag, save reply drafts | Required |
   | `MailboxSettings.ReadWrite` | create the coloured category labels in the mailbox | Optional (without it labels have no colour) |
   | `Mail.Send` | send an approved reply from the helpdesk | **Do not grant at launch.** Only if the business later switches to "send after approval" |

4. **Client secret.** Certificates and secrets, new client secret, 12 months. Copy the **value** straight into the secret store (it is shown once). Put a renewal reminder in a calendar 30 days before expiry: when it expires the helpdesk stops reading mail. (Certificate sign-in is not implemented, see section 12.)
5. **Restrict the app to this one mailbox. Mandatory.** `Mail.ReadWrite` as an application permission otherwise reaches **every mailbox in the tenant**. In Exchange Online PowerShell:

   ```powershell
   # a mail-enabled security group that contains only the helpdesk mailbox (or use an existing one)
   New-DistributionGroup -Name "Autostrad Helpdesk App Scope" -Type Security -Members helpdesk@autostrad.com
   New-ApplicationAccessPolicy -AppId <APPLICATION_CLIENT_ID> -PolicyScopeGroupId <that group's email address> `
       -AccessRight RestrictAccess -Description "Autostrad Helpdesk: helpdesk mailbox only"
   # check: the first must say Granted, the second Denied (a policy can take up to an hour to apply)
   Test-ApplicationAccessPolicy -Identity helpdesk@autostrad.com -AppId <APPLICATION_CLIENT_ID>
   Test-ApplicationAccessPolicy -Identity someone.else@autostrad.com -AppId <APPLICATION_CLIENT_ID>
   ```

   If the tenant already uses **RBAC for Applications in Exchange Online**, use a management scope for this mailbox instead. The result must be the same: the app reaches this mailbox and no other.
6. **Sent Items copy.** Replies that staff send from Outlook (Send As or Send on behalf) must land in the shared mailbox's Sent Items, otherwise the helpdesk cannot see them:

   ```powershell
   Set-Mailbox helpdesk@autostrad.com -MessageCopyForSentAsEnabled $true -MessageCopyForSendOnBehalfEnabled $true
   ```
7. **Conditional Access.** If a policy restricts workload identities by location, allow the app's service principal from the server's outbound IP (section 5).

**What the app does to the mailbox:** reads the Inbox and Sent Items every 2 minutes (only what is new, using Graph delta queries, about 1,500 small requests a day); adds categories (`CH: ...`, `Priority: ...`, `Status: ...`, `Dept: ...`, `Owner: ...`, the case number) and a follow-up flag with the due date to customer emails; saves approved replies in the **Drafts** folder for a person to send from Outlook. It never deletes or moves mail, and it never sends mail unless `Mail.Send` is granted **and** an administrator switches the sending mode.

**Send back to the development team (secure channel, never email or chat):** Tenant ID, Application (client) ID, the client secret value, and the mailbox address. The Tenant and Client IDs are not secret; the secret value is.

## 3. Server and runtime

| Item | Requirement |
|---|---|
| OS | Linux x64 or arm64 (macOS and Windows also work) |
| Node.js | **22 LTS** (minimum 20.12). Built and tested on 22.18 |
| Size | 1 vCPU, 2 GB RAM (the API uses about 50 to 150 MB), 10 GB disk |
| Disk | **Local disk only** for the database (SQLite in WAL mode does not work on NFS or SMB shares) |
| Instances | **Exactly one.** The scheduler runs inside the process and the database is a single file. Do not run replicas or a second copy |
| Native module | `better-sqlite3` is compiled on install: run `npm ci` **on the target machine** (build tools needed) and never copy `node_modules` from another OS |
| Clock | UTC with NTP. Times are stored in UTC and shown in Gulf time (UTC+4) in the app |
| Persistence | The database file `server/data/autostrad.db` plus `-wal` and `-shm` beside it (path can be changed with `ARC_DB_PATH`) |
| Logs | stdout and stderr only. Look for lines starting `[helpdesk]` |

### 3.1 Install and run

```bash
cd /srv/autostrad-crm
npm --prefix server ci && npm --prefix web ci
npm --prefix web run build                    # produces web/dist (the web app, static files)
cp server/.env.example server/.env           # or inject the variables from your secret store (section 4)
node server/scripts/create-admin.mjs ops@autostrad.com "Full Name"   # first IT (super admin) account, asks for the password
NODE_ENV=production node server/src/index.js                         # the API and the background scheduler
```

* **Never run `npm run seed` on a live database.** It wipes every table. It refuses to run when `NODE_ENV=production` unless forced.
* The demo accounts (the shared demo password in the README) exist only after the seed and must never exist in production. A new database has no users until `create-admin` is run: it creates the first **IT (super admin)** account. Further accounts, with their role, are created by IT in the app (Team and roles).
* On first start the app creates its tables and loads the starter keyword list, reply wording and routing rules. No other setup is needed.

### 3.2 Process manager (systemd example)

```ini
[Unit]
Description=Autostrad CRM and helpdesk
After=network-online.target
[Service]
User=autostrad
WorkingDirectory=/srv/autostrad-crm/server
Environment=NODE_ENV=production
EnvironmentFile=/etc/autostrad-crm.env        # secrets, mode 600, owned by root
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
```

### 3.3 Reverse proxy (nginx example)

The web app is static files with client-side routes; the API is under `/api`. Serve both from one HTTPS address so no cross-origin calls are needed.

```nginx
server {
  listen 443 ssl;
  server_name helpdesk.<your-domain>;                 # ssl_certificate and ssl_certificate_key as usual
  root /srv/autostrad-crm/web/dist;
  location /api/ { proxy_pass http://127.0.0.1:4000; proxy_set_header Host $host; proxy_set_header X-Forwarded-For $remote_addr; proxy_read_timeout 120s; }
  location / { try_files $uri /index.html; }         # every other path is a screen of the web app
  # recommended: limit_req on /api/auth/login (the app has no sign-in rate limit of its own, section 8)
}
```

Set `API_HOST=127.0.0.1` so the API port is not reachable from the network, only through the proxy.

## 4. Configuration and secrets

Set as environment variables (they win) or in `server/.env` (copy of `server/.env.example`, mode 600, never in git). Prefer your secret manager.

| Variable | Required | Meaning |
|---|---|---|
| `NODE_ENV` | **Yes**: `production` | Turns on the safeguards (refuses a weak `JWT_SECRET`, refuses the demo seed, no cross-origin calls) |
| `JWT_SECRET` | **Yes** | At least 32 random characters (`openssl rand -hex 32`). Signs every sign-in. The server refuses to start in production without it. Changing it signs everyone out |
| `API_PORT`, `API_HOST` | Recommended | Default port 4000. Use `API_HOST=127.0.0.1` behind a proxy on the same machine |
| `ARC_DB_PATH` | Optional | Where the database file lives |
| `HELPDESK_PROVIDER` | **Yes**: `graph` | Reads the real mailbox. Without it the app uses the built-in demo mailbox |
| `HELPDESK_MAILBOX` | **Yes** | `helpdesk@autostrad.com` |
| `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET` | **Yes** | From section 2. The secret exists **only** here: never in the database, the app or logs |
| `HELPDESK_SEND_MODE` | Recommended: `draft_only` | `draft_only` saves approved replies in the Outlook Drafts folder. `send_after_approval` sends them (needs `Mail.Send`; only after business sign-off) |
| `ANTHROPIC_API_KEY` | Optional | Switches the AI layer on (section 10, decision 1). A spend limit can be set in the Anthropic console |
| `HELPDESK_LLM_MODE` | Optional | `always` (default), `fallback` (only when unsure), `off` |
| `HELPDESK_ACCOUNT_SOURCE` | Optional | `api` uses the customer systems (section 7), `crm` the CRM's own demo records. Unset: the configuration file decides |
| `CUSTOMER_SYSTEMS_CONFIG` | Optional | Path of the customer-systems configuration (default `server/config/customer-systems.json`). It holds **no secrets** |
| `ORION_BASE_URL`, `ORION_API_KEY`, `CNR_BASE_URL`, `CNR_API_KEY` | When the systems are connected | The addresses and **read-only** credentials of the customer systems. The names are examples: the configuration file names whichever variables it uses. The secrets exist **only** here |
| `CORS_ORIGIN` | Leave empty behind the proxy | Production then allows no cross-origin calls |
| `HELPDESK_SCHEDULER` | Maintenance only | `off` stops the mailbox reading and background jobs |

## 5. Network

| Direction | To or from | Port | Why | Needed |
|---|---|---|---|---|
| Inbound | staff network or VPN to the reverse proxy | 443 | the web app | Yes |
| Outbound | `login.microsoftonline.com` | 443 | sign in as the app | Yes |
| Outbound | `graph.microsoft.com` | 443 | read and tag mail, save drafts | Yes |
| Outbound | `api.anthropic.com` | 443 | the AI layer | Only if the AI is on |
| Outbound | the Orion Fleet and CNR Portal API hosts (addresses from the integration owners) | 443 | read contracts, customers and invoices | Once connected (section 7) |
| Local | proxy to `127.0.0.1:4000` | n/a | API | Yes |

* **No inbound connection from Microsoft is needed.** The app polls; it does not use webhooks.
* A **static outbound IP** is needed only if Conditional Access restricts the app by location.
* **Staff browsers** load the Figtree font from `fonts.googleapis.com` and `fonts.gstatic.com`. If those are blocked the app still works with a fallback font; hosting the font on the server is a small **dev** task if you prefer.
* **An outbound proxy is not supported out of the box.** If egress must go through one, tell us before go-live (section 12).

## 6. Data: storage, backup, privacy

* **Size:** about 10 KB per case, so under 100 MB a year at the volume in the scope (it counts 6,837 cases). The demo database with 150 cases and all the CRM demo data is 2 MB.
* **Backup (mandatory before real data):** every night, plus a restore test. Copying the file while the app runs can corrupt the copy; use the SQLite online backup:

  ```bash
  sqlite3 /srv/autostrad-crm/server/data/autostrad.db ".backup '/backup/autostrad-$(date +%F).db'"
  ```

  Keep 30 days. To restore: stop the app, replace the file, delete `-wal` and `-shm`, start the app.
* **What is stored:** emails (customer name, address, phone if written, free text), cases, drafts, notes, the audit log, staff accounts (bcrypt password hashes). **Card numbers (valid ones), Emirates IDs, IBANs and CVVs are masked in the subject and body before anything is stored or sent to the AI.** Attachments are not downloaded.
* **At rest:** the database is not encrypted by the app. Use encrypted storage (disk or volume encryption).
* **Retention:** there is no automatic purge. A retention period must be decided (section 10, decision 2); a purge job is a **dev** task.
* **The AI (optional):** with it on, the **masked** text of each customer email is sent to Anthropic, which processes it **outside the UAE**. Legal and compliance must approve this (UAE personal data protection law) or the AI stays off. With it off, nothing leaves the company except the Microsoft 365 traffic, and the helpdesk still works: keyword rules and a learned model run on the server.
* **Audit log:** every action by the AI, the system and staff is recorded in the database. It is append-only by design, not tamper-proof. Export to a SIEM is a **dev** task if required.

## 7. Contract, customer and invoice data (Orion Fleet and the CNR Portal)

Each new email is matched to the customer, the contract and the invoices, by the sender's address and the contract number in the email. Until the real systems are connected this
reads the CRM's own tables (demo data); cases are still classified, prioritised, routed and drafted, but with demo facts. **For real use it must come from the real systems.**

**The connector is built and tested** against a stand-in API (`npm run dev:live` shows it working). It needs no code change to be pointed at the real systems: a JSON file maps their
field names (no secrets in it) and two or more lines in `server/.env` hold the addresses and keys. The full guide, with the checklist to hand to the API owners, is
**[CUSTOMER_API.md](CUSTOMER_API.md)**. In short:

| We need | From |
|---|---|
| A **read-only service credential** per system (API key, bearer token, user name and password, or OAuth client credentials). It must not be able to change anything | Integration owners |
| The **API addresses** (HTTPS) and **documentation**: how to find a customer by e-mail address, read a contract by number, list its invoices, fines, deposit and card hold; one real sample answer for each, including "not found" | Integration owners |
| A **sandbox** or test records (a customer with a deposit, a card hold, invoices; one with two addresses) | Integration owners |
| Expected **limits** (requests per minute, response time) and the status words each system uses | Integration owners |
| **Outbound HTTPS** from the helpdesk server to those hosts (section 5) | Network |
| The credentials placed in `server/.env` (section 4), never in chat, the database or the configuration file | Infrastructure |

What it asks of the systems: one to six small read-only GETs per customer email (the scope counts about 20 to 60 emails a day), answers remembered for 5 minutes, at most 4 requests at a time per system,
an 8-second timeout, one retry on a temporary failure, a pause of 60 seconds after five failures in a row. It sends only the sender's address and the contract number, never the email text.

If a system is down, emails are still turned into cases and completed automatically when it answers again (12 tries over about four hours; visible on **Helpdesk setup, Customer data**).
Replies quote deposit, card-hold and invoice figures only when the sender's address is the customer on the contract, because a contract number typed in an email proves nothing about who sent it.

**dev, once we have the API documentation and a sandbox:** a working session of a few hours to fill in the field names and run the checks in the setup page against the real answers. Only an API
that needs something unusual (mutual TLS, signed requests, a join of two answers) needs code (a few days).

## 8. Security checklist

| Item | Status |
|---|---|
| HTTPS at the proxy | **Needed** from infrastructure |
| `JWT_SECRET` strong and set | **Enforced** in production |
| Demo accounts and demo data | Not present on a new database; the seed refuses to run in production |
| Passwords | bcrypt, minimum 8 characters, **no lockout and no rate limit**: add `limit_req` on `/api/auth/login` at the proxy |
| Cross-origin calls | None in production unless `CORS_ORIGIN` is set |
| Roles | **Five roles (IT super admin, admin, operations, customer service, finance), enforced on the server for the whole CRM and the helpdesk** on every request. The role is read from the database each time, so a change or a disabled account applies at once. The system always keeps one active IT account. The rules are in `server/src/roles.js` and shown in the app (Team and roles, "Who can do what?") |
| Sign-in method | Local accounts. Single sign-on with Entra ID is not built (decision 3) |
| Sign-in token | Kept in the browser, valid 12 hours |
| Dependencies | Lock files are committed: use `npm ci`; run `npm audit` in your pipeline |
| Mail access scope | **Must be restricted** to one mailbox (section 2.5) |
| Customer-system access | **Read-only** credentials only; kept in `server/.env`; never logged or shown. Redirects are not followed, answers are size-limited, and everything put into an address is percent-encoded |
| Account details in replies | A drafted reply quotes deposit, card-hold and invoice figures **only when the sender is the customer on the contract** (address match) or staff confirmed them; otherwise they are left out |

## 9. Monitoring

* **Process:** `GET /api/health` returns `{"ok":true,"service":"autostrad-crm"}` with no sign-in. Alert if it fails.
* **Mailbox reading:** the time of the last **successful** read is in the app (Helpdesk setup, Mailbox) and in the database. A failed attempt does not update it, so alert if it is older than 15 minutes:

  ```bash
  sqlite3 /srv/autostrad-crm/server/data/autostrad.db "select value from hd_state where key='last_sync_ok_at'"
  ```

* **Customer systems:** Helpdesk setup, Customer data shows each system's calls, failures, last good answer and whether it is paused. Cases waiting for a system to answer:

  ```bash
  sqlite3 /srv/autostrad-crm/server/data/autostrad.db "select count(*) from hd_case_accounts where next_try_at is not null"
  ```

  A number that keeps growing means a system is down or its key expired.
* **Logs:** alert on `[helpdesk] mailbox sync failed`, `[helpdesk] AI call failed` and `[helpdesk] account lookup failed`.
* **Calendar alerts:** Graph client secret expiry (30 days before), backup success, disk space.
* Not built: a Prometheus endpoint and push alerts (section 12).

## 10. Decisions needed

1. **AI on or off?** Off is safe and works (about 84% right on a test of 68 made-up emails, with the uncertain ones sent to a person). On adds accuracy on messy emails and costs a few dollars a month at 20 emails a day, but customer email text (masked) goes to Anthropic outside the UAE. Owner: legal and security.
2. **Retention:** how long are emails and cases kept? Owner: legal.
3. **Sign-in:** local accounts now, or Entra ID single sign-on (a dev task)? Owner: security.
4. **Hosting:** where, and does data residency require the UAE? Owner: infrastructure.
5. **Customer-system access:** read-only credentials and API documentation for Orion Fleet and the CNR Portal (section 7; the live lookup is built, nothing to decide but who provides them). Owner: integration owners.
6. **Who owns the helpdesk** day to day (wording approval, contract-number format, response times)? Owner: Customer Happiness.

## 11. Go-live plan

1. **Test (infra plus us).** Everything above on a **test mailbox** first. In the app: Helpdesk setup, Mailbox, "Test the Outlook connection" must be green on every step. Send five test emails (English and Arabic): cases appear, categories and flags appear in Outlook, approved replies land in Drafts.
2. **Pilot.** Production mailbox, `draft_only`, scope phase 1 (the five most common request types). Staff keep working in Outlook; about two weeks.
3. **Measure.** Import at least 200 real emails that staff have already classified (AI lab, Test set, Import CSV). **Proposed targets (to agree with the business):** at least 90% right among emails not sent to "To check", at least 60% of emails going straight through, replies approved without edits at least 70% of the time.
4. **Sending.** Only after sign-off: grant `Mail.Send` as a separate change and switch the mode. Sensitive financial replies always need a finance, admin or IT approver.

## 12. Not built yet (our backlog, not infrastructure's)

Entra ID single sign-on; certificate sign-in for Graph (secret only today); outbound proxy support; Prometheus metrics and alerts; running more than one instance (would need PostgreSQL and an external scheduler); reading attachments; trying the connector on the real Orion and CNR answers (section 7); Graph change notifications for instant mail instead of the 2-minute poll; retention purge; sign-in rate limit and lockout; WhatsApp and phone-call channels (the dashboard shows hand-typed counts for them).

We can supply a Dockerfile, a systemd unit or a deployment script for the target you choose.

## 13. Hand-back checklist

- [ ] App registration done, admin consent granted, mailbox restriction tested (two `Test-ApplicationAccessPolicy` results)
- [ ] Sent Items copy enabled on the mailbox
- [ ] Tenant ID, Client ID, client secret value and mailbox address sent to us through the secret store
- [ ] Server ready, proxy and HTTPS address ready, outbound access to the hosts in section 5
- [ ] `NODE_ENV`, `JWT_SECRET`, `API_HOST` and the Graph variables set; the first administrator created
- [ ] Read-only credentials and API documentation for Orion Fleet and the CNR Portal received; their keys in `server/.env`; outbound access to their hosts
- [ ] Helpdesk setup, Customer data: no problems listed, and "Try a lookup" with a real customer returns the right contract and invoices
- [ ] Nightly backup running and one restore tested
- [ ] Health check and last-read alert configured
- [ ] Answers to the six decisions in section 10
