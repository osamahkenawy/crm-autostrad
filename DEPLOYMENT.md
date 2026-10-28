# Moving the project and deploying it to a server

This is the one file to follow when you (1) work on the project from **another laptop**, or (2) put it on a **server**. Every command is meant to be copied as it is. Where something is yours to choose, it is written in capitals or as `crm.example.com`.

| I want to... | Read |
|---|---|
| Run the project on another laptop | [Part 2](#part-2-another-laptop) |
| Get the code onto the server and keep it up to date with `git pull` | [Part 3](#part-3-getting-the-code-onto-the-server-and-keeping-it-current) |
| Set a new server up from nothing | [Parts 4 to 6](#part-4-prepare-the-server) |
| Ship a new version | [Part 7](#part-7-updating-rolling-back-backups) |
| Something is broken | [Part 8](#part-8-running-it-day-to-day) (troubleshooting table) |

Other documents: [README.md](README.md) (what the app is and how to run it locally) · [INFRA_REQUIREMENTS.md](INFRA_REQUIREMENTS.md) (what infrastructure, Microsoft 365 and security must provide) · [HELPDESK.md](HELPDESK.md) · [CUSTOMER_API.md](CUSTOMER_API.md) (connecting Orion Fleet and the CNR Portal).

---

## Part 1. What you are deploying

```
browser ──https──▶ nginx ──┬─ /            static web app   (web/dist, built from web/)
                           └─ /api/...  ──▶ Node API on 127.0.0.1:4000  (server/)  ──▶ SQLite file  server/data/autostrad.db
                                              └─ also runs the background jobs: reads the Outlook mailbox every 2 minutes,
                                                 reminders, escalations, daily and weekly reports
```

* **One Node process, one database file.** Run exactly **one** copy: the scheduler lives inside the API and the database is a single SQLite file on **local disk** (not a network share).
* **No external database, no Docker needed.** Node 22, nginx and a way to get HTTPS certificates.
* **Secrets are never in git.** They live in `server/.env` on each machine (mode 600). The repository holds only `server/.env.example`, a template.
* **The database is not in git either.** A new server starts empty (no users). The demo data (`npm run seed`) is for laptops only and refuses to run when `NODE_ENV=production`.
* The web app calls `/api/...` on its own address, so the web app and the API must be served from the **same https address** (the nginx file in `deploy/` does that).

What is in the repository for deployment:

```
DEPLOYMENT.md                       this file
deploy/deploy.sh                    update the server: backup, pull, install, build, restart, health check (also rolls back)
deploy/autostrad-crm.service        systemd unit (keeps the API running, restarts it after a crash or a reboot)
deploy/nginx-autostrad-crm.conf     nginx site: web app, /api proxy, login rate limit, https, caching
server/scripts/backup-db.mjs        consistent database snapshot while the app runs (npm --prefix server run backup)
server/scripts/create-admin.mjs     creates the first IT (super admin) account on an empty database
server/.env.example                 every setting, with comments
.nvmrc                              the Node version (22) for nvm users
```

---

## Part 2. Another laptop

Use this to continue development on a second machine. (To deploy a server, go to Part 3.)

### 2.1 Install once

| You need | macOS | Ubuntu / Debian | Windows |
|---|---|---|---|
| **Git** | `xcode-select --install` (also gives you the build tools below) | `sudo apt install git` | install WSL2 (Ubuntu) first, then follow the Ubuntu column inside it |
| **Node 22** | `brew install node@22` or install [nvm](https://github.com/nvm-sh/nvm) | NodeSource (section 4.2) or nvm | inside WSL2 |
| **Build tools** (the `better-sqlite3` module is compiled on install when no ready-made binary exists) | included with the Xcode tools | `sudo apt install build-essential python3` | inside WSL2 |

Node must be **20.12 or newer** (22 recommended): `node -v`. Plain Windows (no WSL) is not supported by the npm scripts.

### 2.2 Get the code and run it

```bash
git clone https://github.com/osamahkenawy/crm-autostrad.git
cd crm-autostrad
nvm use              # only if you use nvm: reads .nvmrc and switches to Node 22
npm run setup        # installs the server and the web app, then creates the demo database (first time only, about 2 minutes)
npm run dev          # API http://localhost:4000, web app http://localhost:5173
```

Open **http://localhost:5173** and sign in with a demo account. All demo accounts share the password `autostrad123`; for example `it@autostrad.ae` (IT, can do everything) or `noor@autostrad.ae` (customer service). The full list and what each role may do is in the README.

Other commands worth knowing:

```bash
npm run dev:live                  # the same plus a stand-in for the customer systems (Orion Fleet, CNR Portal): see CUSTOMER_API.md
npm run seed                      # DESTRUCTIVE: wipes and recreates the demo data (laptops only)
npm --prefix server test          # the server's automatic checks (about 200, 20 seconds)
npm --prefix web run build        # build the web app into web/dist
```

### 2.3 What does NOT come with `git clone` (and how to carry it over)

| Not in git | Why | What to do on the new laptop |
|---|---|---|
| `server/.env` (keys, Microsoft 365 secret, AI key) | secrets | Not needed for development: without it the helpdesk uses its built-in demo mailbox. If you need it, copy it through a password manager or `scp`, **never** through git or chat |
| The database `server/data/*.db` | data, and binary | `npm run setup` creates fresh demo data. To bring the exact data from the old laptop: `npm --prefix server run backup` there, copy the snapshot file, then on the new laptop stop the app and copy it over `server/data/autostrad.db` |
| `node_modules/` | rebuilt per machine (native module) | created by `npm run setup`. Never copy it between machines or operating systems |
| Your Claude Code conversation and memory | they live on the old laptop | the project documents (README, HELPDESK, CUSTOMER_API, INFRA_REQUIREMENTS, this file) carry the context. Start a new session in the project folder and ask it to read them |

### 2.4 Working with git from either laptop

```bash
git pull                              # get the latest before you start
git status                            # what you changed
git add -A && git commit -m "what and why"
git push                              # share it (the first push after cloning needs no extra flags)
git log --oneline -10                 # recent history
```

Two laptops, one repository: always `git pull` before you start and `git push` when you stop, so they do not drift apart. If `git pull` says there is a conflict, do not panic: `git status` lists the files; open each, keep what is right, then `git add` them and `git commit`.

If the app fails with a message like *"was compiled against a different Node.js version"* or *"not a valid mach-o file"* after switching machines or Node versions: `npm --prefix server rebuild better-sqlite3` (or delete `node_modules` and run `npm run setup` again).

---

## Part 3. Getting the code onto the server and keeping it current

On the server the code lives in `/srv/autostrad-crm` and belongs to a dedicated user called `autostrad` (created in Part 4). Everything below is run as that user (`sudo -iu autostrad`) unless it says `sudo`.

### 3.1 Choose how the server reaches GitHub

**A. The repository is private (recommended: it is client code).** Give the server a read-only *deploy key*:

```bash
sudo -iu autostrad
ssh-keygen -t ed25519 -C "autostrad-crm-server" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub                      # copy this whole line
```

On GitHub: the repository, **Settings, Deploy keys, Add deploy key**, paste it, leave "Allow write access" **off**. Then back on the server:

```bash
ssh -T git@github.com                          # type "yes" the first time; it should greet the repository by name
git clone git@github.com:osamahkenawy/crm-autostrad.git /srv/autostrad-crm
```

**B. The repository is public.** No key needed:

```bash
git clone https://github.com/osamahkenawy/crm-autostrad.git /srv/autostrad-crm
```

(`/srv/autostrad-crm` must exist and belong to `autostrad`, see 4.3. Anyone can read a public repository, including the infrastructure notes in this folder: make it private for a client project.)

### 3.2 Pulling updates later

The normal way is the script, which also backs up, installs, builds, restarts and checks:

```bash
cd /srv/autostrad-crm
./deploy/deploy.sh                 # latest main
./deploy/deploy.sh v1.0.1          # a tagged release (also how you roll back)
```

By hand, if you ever need to: `git pull --ff-only origin main`, then `npm --prefix server ci --omit=dev`, `npm --prefix web ci`, `npm --prefix web run build`, `sudo systemctl restart autostrad-crm`. Details in Part 7.

Rules that keep it painless: **never edit files on the server** (the script refuses to run if tracked files changed); change the code on a laptop, `git push`, then run `deploy.sh` on the server. Server-only settings go in `server/.env`, which git ignores.

---

## Part 4. Prepare the server

Tested target: **Ubuntu 22.04 or 24.04 LTS**, 1 vCPU, 2 GB RAM, 10 GB disk (the API itself uses 50 to 150 MB; the web build needs the memory once, at deploy time). Any VM works: Azure, AWS, DigitalOcean, Hetzner, or a machine in the company's data centre (see INFRA_REQUIREMENTS section 10 for the data-residency question). You need a DNS name (for example `crm.example.com`) pointing at the server's IP.

### 4.1 Base system

```bash
sudo apt update && sudo apt -y upgrade
sudo apt -y install git curl ca-certificates build-essential python3 nginx ufw sqlite3 certbot
sudo timedatectl set-timezone UTC && sudo timedatectl set-ntp true     # times are stored in UTC and shown in Gulf time by the app
```

### 4.2 Node 22

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt -y install nodejs
node -v          # v22.x
```

(The systemd file expects Node at `/usr/bin/node`, which is where this package puts it. If you use nvm instead, change `ExecStart` to the full path from `which node`.)

### 4.3 The app user and folder

```bash
sudo adduser --system --group --home /home/autostrad --shell /bin/bash autostrad
sudo mkdir -p /srv/autostrad-crm && sudo chown autostrad:autostrad /srv/autostrad-crm
```

Let that user restart the service without a password (used by `deploy.sh`):

```bash
echo 'autostrad ALL=(root) NOPASSWD: /usr/bin/systemctl restart autostrad-crm, /usr/bin/systemctl status autostrad-crm' | sudo tee /etc/sudoers.d/autostrad-crm
sudo chmod 440 /etc/sudoers.d/autostrad-crm && sudo visudo -c
```

### 4.4 Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'          # ports 80 and 443
sudo ufw enable
sudo ufw status
```

The API's own port (4000) is **not** opened: it listens on 127.0.0.1 only and nginx is the only way in.

Now do Part 3.1 to clone the code into `/srv/autostrad-crm`, then continue here.

---

## Part 5. Configure and start

### 5.1 Install and build (as the `autostrad` user)

```bash
sudo -iu autostrad
cd /srv/autostrad-crm
npm --prefix server ci --omit=dev        # compiles better-sqlite3 for this machine if needed
npm --prefix web ci
npm --prefix web run build               # creates web/dist (the web app, static files)
```

### 5.2 The settings file `server/.env`

```bash
cd /srv/autostrad-crm/server
cp .env.example .env
chmod 600 .env
openssl rand -hex 32                     # prints a random secret: use it for JWT_SECRET below
nano .env
```

The minimum for a first deployment (everything else in the template stays commented out):

```ini
NODE_ENV=production
JWT_SECRET=<the 64 characters printed above>   # signs every sign-in; the server refuses to start in production without a strong one
API_HOST=127.0.0.1                              # only nginx can reach the API
API_PORT=4000
```

Add the rest when you are ready (each is explained in `.env.example` and in INFRA_REQUIREMENTS section 4):

```ini
# Outlook mailbox (after the Microsoft Entra setup in INFRA_REQUIREMENTS section 2; until then the helpdesk runs on its built-in demo mailbox)
HELPDESK_PROVIDER=graph
HELPDESK_MAILBOX=helpdesk@autostrad.com
GRAPH_TENANT_ID=...
GRAPH_CLIENT_ID=...
GRAPH_CLIENT_SECRET=...
HELPDESK_SEND_MODE=draft_only                   # replies are saved in Outlook Drafts, a person presses Send (start here)

# The contract, customer and invoice systems (CUSTOMER_API.md) and the optional AI
HELPDESK_ACCOUNT_SOURCE=api
ORION_BASE_URL=...   ORION_API_KEY=...   CNR_BASE_URL=...   CNR_API_KEY=...
ANTHROPIC_API_KEY=...
```

After you change `.env`, restart: `sudo systemctl restart autostrad-crm`. **Do not** put secrets in chat, tickets or git.

### 5.3 The first administrator

The new database has no users. Create the first IT (super admin) account **as the `autostrad` user** (so the database file belongs to it):

```bash
cd /srv/autostrad-crm
node server/scripts/create-admin.mjs ops@autostrad.com "Full Name" it     # asks for the password twice, hidden
```

Further people are created inside the app by that account (**Team and roles**). Never run `npm run seed` here.

### 5.4 Start the API with systemd (as your normal sudo user, not `autostrad`)

```bash
exit                                      # leave the autostrad shell
sudo cp /srv/autostrad-crm/deploy/autostrad-crm.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now autostrad-crm
systemctl status autostrad-crm            # active (running)
curl http://127.0.0.1:4000/api/health     # {"ok":true,"service":"autostrad-crm"}
```

If it does not start: `journalctl -u autostrad-crm -n 50 --no-pager` (the usual causes are in the table in Part 8).

---

## Part 6. HTTPS and nginx

Make sure the DNS name points to this server and ports 80 and 443 are open.

**Step 1. Get a certificate.** The default nginx site serves `/var/www/html` on port 80, which is all Let's Encrypt needs:

```bash
sudo certbot certonly --webroot -w /var/www/html -d crm.example.com -m you@example.com --agree-tos --no-eff-email --deploy-hook "systemctl reload nginx"
```

Renewal is automatic (the certbot package installs a timer). Check with `sudo certbot renew --dry-run`.

**Step 2. Install the site.** Replace `crm.example.com` with your name:

```bash
sudo cp /srv/autostrad-crm/deploy/nginx-autostrad-crm.conf /etc/nginx/sites-available/autostrad-crm
sudo sed -i 's/crm.example.com/YOUR.DOMAIN/g' /etc/nginx/sites-available/autostrad-crm
sudo ln -s /etc/nginx/sites-available/autostrad-crm /etc/nginx/sites-enabled/autostrad-crm
sudo nginx -t && sudo systemctl reload nginx
```

**Step 3. Check.** Open `https://YOUR.DOMAIN` and sign in with the account from 5.3. The page should show the Autostrad sign-in; after signing in, the dashboard.

The nginx file also limits the sign-in endpoint to 10 attempts a minute per address, serves the built files with long caching, and adds basic security headers. Once HTTPS is working for good, you can remove the `#` in front of `Strict-Transport-Security`.

---

## Part 7. Updating, rolling back, backups

### 7.1 A normal update

On a laptop: change the code, then `git add -A && git commit -m "..." && git push`. On the server:

```bash
sudo -iu autostrad
cd /srv/autostrad-crm && ./deploy/deploy.sh
```

The script, in order: refuses if tracked files on the server were edited, fetches, pulls (fast-forward only), shows what changed, **backs up the database**, installs, builds the web app, restarts the service, and waits up to 30 seconds for `/api/health`. If the app does not come back it tells you how to roll back. The app creates any new tables or columns itself when it starts; there is no separate migration step.

For releases you can name, tag them: `git tag -a v1.0.0 -m "First release" && git push --tags`, then `./deploy/deploy.sh v1.0.0`.

### 7.2 Rolling back

```bash
./deploy/deploy.sh PREVIOUS_TAG_OR_COMMIT     # the script prints the commit it came from; it is also in `git log --oneline`
```

Newer code only ever *adds* tables and columns, so the older code runs on the newer database. Restore the database only if data was damaged (7.4).

### 7.3 Backups

A snapshot is a single file and is checked for corruption. Run it by hand or from cron:

```bash
npm --prefix server run backup            # writes server/data/backups/autostrad-YYYY-MM-DD-HHMM.db, keeps 30 days (BACKUP_KEEP_DAYS)
```

Every night at 02:15 (as the `autostrad` user, `crontab -e`):

```cron
15 2 * * * cd /srv/autostrad-crm && /usr/bin/npm --prefix server run --silent backup >> /srv/autostrad-crm/server/data/backup.log 2>&1
```

A backup on the same disk does not survive the disk. **Copy `server/data/backups/` to somewhere else** every night (another server with `rsync`, or a cloud storage bucket) and keep a copy off the machine.

### 7.4 Restoring

```bash
sudo systemctl stop autostrad-crm
cp /srv/autostrad-crm/server/data/backups/autostrad-2026-10-28-0215.db /srv/autostrad-crm/server/data/autostrad.db
rm -f /srv/autostrad-crm/server/data/autostrad.db-wal /srv/autostrad-crm/server/data/autostrad.db-shm
sudo systemctl start autostrad-crm
```

Test a restore once, on a spare machine, before you need it. The same steps move the database to a **new server**: take a snapshot, `scp` it over, restore as above, and copy `server/.env` (through a safe channel).

---

## Part 8. Running it day to day

### 8.1 Commands you will use

```bash
systemctl status autostrad-crm                    # is it running
sudo systemctl restart autostrad-crm              # restart (after changing server/.env, for example)
journalctl -u autostrad-crm -f                    # follow the log; lines starting [helpdesk] are the helpdesk
journalctl -u autostrad-crm --since "1 hour ago" | grep -i "failed"
curl -s http://127.0.0.1:4000/api/health          # {"ok":true,...} when the API is up
sudo nginx -t && sudo systemctl reload nginx      # after editing the nginx file
df -h /srv                                        # disk space
```

### 8.2 What to watch

* `/api/health` answers, and an alert if it does not.
* The last successful mailbox read is under 15 minutes old: `sqlite3 /srv/autostrad-crm/server/data/autostrad.db "select value from hd_state where key='last_sync_ok_at'"` (also shown in the app: Helpdesk, Setup).
* Cases waiting for a customer system to answer: `select count(*) from hd_case_accounts where next_try_at is not null` (a number that keeps growing means a system is down or a key expired).
* Disk space, the nightly backup, the Microsoft client-secret expiry date (a calendar reminder 30 days before), and certificate renewal (`sudo certbot renew --dry-run`).

More in INFRA_REQUIREMENTS section 9. First-time Microsoft 365 steps are in section 2 of the same file.

### 8.3 Troubleshooting

| You see | Likely cause | Fix |
|---|---|---|
| `Refusing to start in production: set JWT_SECRET...` in the log | no secret, or one shorter than 32 characters | set `JWT_SECRET` in `server/.env` (`openssl rand -hex 32`), restart |
| `502 Bad Gateway` in the browser | the API is not running | `systemctl status autostrad-crm`, `journalctl -u autostrad-crm -n 80` |
| Blank page, or 404 when you reload `/helpdesk/cases` | the web app is not built, or `try_files` is missing | `npm --prefix web run build`; use the nginx file from `deploy/` |
| Everybody is signed out after a restart | `JWT_SECRET` changed | keep it constant; a change signs everyone out once |
| `SQLITE_READONLY` / `unable to open database file` | the data folder belongs to another user (for example you ran `create-admin` with `sudo`) | `sudo chown -R autostrad:autostrad /srv/autostrad-crm/server/data`, restart |
| `was compiled against a different Node.js version` / `not a valid ELF` | `node_modules` came from another machine or Node version | `npm --prefix server rebuild better-sqlite3` (or `npm --prefix server ci` on the server) |
| `EADDRINUSE :4000` | a second copy is running | `ss -ltnp \| grep 4000`; there must be exactly one |
| `npm ci` fails: "package.json and package-lock.json are not in sync" | a dependency was changed without updating the lock file | on the laptop run `npm install`, commit the changed `package-lock.json`, push |
| `deploy.sh` stops: "There are local changes to tracked files" | someone edited a file on the server | `git status`, then `git checkout -- FILE` to discard, or move the change to a laptop |
| The helpdesk says "Not connected" | the Microsoft 365 setup or secret | Helpdesk, Setup, "Test the Outlook connection" (it says which step fails); INFRA_REQUIREMENTS section 2 |
| Times are an hour or hours off | the server clock or time zone | `timedatectl`; keep UTC with NTP on |
| `certbot` cannot validate | DNS not pointing here yet, or port 80 closed | `dig +short YOUR.DOMAIN`, check `ufw status` and the cloud firewall |
| Browser console shows CORS errors | the web app and the API are on different addresses | serve both from one address (the nginx file does), or list the web address in `CORS_ORIGIN` |

---

## Part 9. Checklist

**Laptop**
- [ ] `git clone`, `npm run setup`, `npm run dev`, sign in at http://localhost:5173
- [ ] `npm --prefix server test` passes

**Server, once**
- [ ] Ubuntu 22.04/24.04, UTC with NTP, packages installed (4.1), Node 22 (4.2)
- [ ] User `autostrad`, `/srv/autostrad-crm`, sudoers line, firewall (4.3, 4.4)
- [ ] Code cloned (3.1): private repository with a read-only deploy key
- [ ] `npm ci` for server and web, web built (5.1)
- [ ] `server/.env` with `NODE_ENV`, `JWT_SECRET`, `API_HOST=127.0.0.1` (5.2), mode 600
- [ ] First IT account created as `autostrad` (5.3)
- [ ] systemd service enabled and healthy (5.4)
- [ ] Certificate and nginx site (Part 6), `https://YOUR.DOMAIN` works
- [ ] Nightly backup in cron **and** a copy kept off the machine (7.3); one restore tested (7.4)

**Before real customers**
- [ ] Microsoft 365 connected and tested on a **test mailbox** first (INFRA_REQUIREMENTS sections 2 and 11); replies stay in `draft_only` until the team trusts them
- [ ] Reply wording approved by Customer Happiness; contract-number format confirmed
- [ ] The decisions in INFRA_REQUIREMENTS section 10 answered (AI on or off, retention, sign-in method, hosting location)
- [ ] Orion Fleet and CNR Portal connected (CUSTOMER_API.md) or knowingly left on the CRM's own demo records

---

## Appendix. What is deliberately not automated

* **Server provisioning** is written as steps (Part 4), not as a script that runs as root: it is a one-time job and you should see each step.
* **Docker** is not used. If your infrastructure team prefers containers, the app is a plain Node 22 process with one data folder (`server/data`) and one settings file (`server/.env`), so a Dockerfile is a small job: ask for it.
* **Several servers or a load balancer** are not supported: one process, one SQLite file (see Part 1).
