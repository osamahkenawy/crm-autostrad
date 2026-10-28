# Customer-service helpdesk

An AI-assisted helpdesk for the support mailbox (`helpdesk@autostrad.com`), built into the Autostrad CRM. It follows the
*Customer Service AI Automation* scope: every customer email becomes a **case** that is classified, matched to its contract,
prioritised, routed to a team and given a **drafted reply that a person approves**. Nothing is ever sent without a person.

```
Outlook shared mailbox ──(read every 2 min)──▶ pipeline ──▶ case ──▶ drafted reply ──▶ a person approves ──▶ Outlook Drafts / sent
                                                  │
        read email · find the customer, contract & invoices (customer systems) · classify · extract details · set priority · pick team and owner · set due time
                                                  │
                      reminders after 48 h and 96 h · auto-close after 7 quiet days · escalation when late · daily and weekly reports
```

**Going live:** what infrastructure, Microsoft 365 and security must provide is in [INFRA_REQUIREMENTS.md](INFRA_REQUIREMENTS.md).

Try it now, with no Outlook and no API key: open **Customer service ▸ Cases**, press **Sample emails**, pick one and press Send.

---

## 1. What a person sees

| Screen | What it is for |
|---|---|
| **Helpdesk** (dashboard) | Open, overdue, replies to approve, waiting, to check, closed. Open cases by age (0-2, 3-7, 8+ days), overdue by owner, priority mix, new cases by category (daily, weekly, monthly), top 5 issues, where requests come from, AI performance (classified with confidence, drafts approved without edits, classifications changed by staff), response times. Tiles and bars open the matching cases. Refreshes every 15 minutes. |
| **Cases** | Work queues with live counts: Active, Needs action, Replies to approve, Waiting for customer, Overdue, To check, Mine, Closed, All. Filters, search, export. A **live badge** shows that the mailbox is being read automatically, and a toast announces new cases. |
| **A case** | The conversation; the drafted reply (edit, approve, write again, discard, **approve then next case**); **What to look at** (facts from the customer records: an amount that matches a fine or invoice, unpaid invoices, a deposit refund that is overdue, a card hold still active, repeat contacts, legal wording); how the AI read the email with the controls to correct it; internal notes; **Customer and contract** (who the customer is, the contract, vehicle, deposit and card hold, invoices, fines, the sender's other contracts, where the facts came from and how fresh they are, whether the sender really is the customer, and Refresh); **cases like this one and how we answered**; related cases; and the full audit trail. |
| **Reports** | Daily summary (07:00 Gulf time) and weekly summary (Mondays). Copy the text into an email or print. |
| **AI lab** (admin, IT) | Try an email; measure accuracy on labelled emails; see what staff corrected and teach the system a phrase; retrain. |
| **Helpdesk setup** (admin, IT; the mailbox, AI and sending switches IT only) | Getting-started checklist, mailbox status and connection test, safety switches, AI, **Customer data** (where contract, customer and invoice facts come from, per-system health, a test lookup), approved reply wording, keywords, routing and timing, hand-entered WhatsApp and call counts, audit log. |

## 2. How it decides: one engine, three layers

1. **Keyword rules.** About 650 English and Arabic phrases, each with a strength. Explains itself: it shows which phrases matched.
2. **Learned model.** A small text model trained on Autostrad's own wording: the keyword phrases, labelled sample emails and, above all, **cases staff corrected or confirmed**. It recognises phrasing the keyword list never contained, tolerates typos and Arabic dialect, and **retrains by itself** when staff correct a case, change a keyword or add a test email. Runs locally, no outside service, no cost.
3. **Claude (optional).** With `ANTHROPIC_API_KEY` set it reads each email (card numbers, IDs and bank details are removed first), confirms or corrects the classification, extracts details, writes a one-line summary and can polish reply wording. It can never invent a contract number or an amount (checked against the email text), it is told to ignore instructions hidden in emails, and when it fails the other two layers carry on.

The result carries a **confidence**. Below the threshold (default 60%) the case goes to **To check** for a person. Details are pulled from the text (contract number, amount, card digits, fine reference, place, name), the contract and customer are found in the CRM, and the priority (Critical, High, Average, Low) is scored with the reasons shown, so staff can see why and challenge it.

### How good is it? (honest numbers)

Measured in the AI lab on **68 made-up emails the model was never trained on**, written by a separate model that never saw the keyword list (English, Arabic, dialects, typos, forwards; labels assigned from the request-type descriptions):

| | Right |
|---|---|
| Keyword rules alone | 66% (45 of 68) |
| **Rules plus learned model (the default)** | **87% (59 of 68)** |
| Rules, model and Claude | not measured: needs an API key |

With the default 60% threshold, **about 8 in 10 emails go straight through, and about 94% of those are right** (51 of 54); the rest go to the **To check** queue for a person. The errors it makes are mostly one-line or ambiguous emails ("Re: Your invoice") and emails that touch two topics, which is exactly where the optional Claude layer helps.

How the figure moved, for the record: first run 65% (rules) and 81% (smart). Afterwards a handful of generic spam and automatic-reply phrases were added to the keyword list and a second set of 85 independent emails (used to check the confidence scores) was added to the training samples. The 68 were never trained on, but one spam phrase was added after seeing a miss there, so treat the figure as slightly optimistic. Later, an independent review of the AI lab found a weighting bug in the learned model's letter-group features (it made the model weak against typos); fixing it moved the smart engine from 84% (57 of 68) to 87% (59 of 68), and with 30% of the words in each email damaged by typos from 52 to 55 right (of 68) to 54 to 59. The fix was measured on those same 68, so this figure is slightly optimistic too.

These are made-up emails, not Autostrad's. **Import real emails that staff have already classified** (AI lab ▸ Test set ▸ Import CSV; by default half measure the model and half teach it, because emails it learns from cannot also measure it fairly) to get the real figure; the same screen shows where it is wrong and lets staff teach it. The model improves as staff correct cases.

## 3. Roles and approvals (enforced on the server)

Five roles (the full table is in the app under **Team and roles, "Who can do what?"** and in `server/src/roles.js`):

| Role | In the helpdesk |
|---|---|
| **IT (super admin)** | Everything, including the **mailbox, AI and sending switches** and the connection test |
| **Admin** | Sees and works everything; approves sensitive replies; changes reply wording, keywords, routing, timing; uses the AI lab. **Cannot** change the mailbox, AI or sending switches |
| **Operations** | Sees and works cases (replies, closing, notes). Cannot approve sensitive replies or open setup |
| **Customer service** | The same as operations in the helpdesk: sees and works cases. Lands on the helpdesk |
| **Finance** | Sees and works cases and **approves replies to sensitive financial requests** |

* Every reply is a **draft**. A person reads, edits if needed, and approves. Placeholders such as `[[statement]]` block approval until filled in.
* Replies to **sensitive financial requests** (disputed charges, refunds, deposits, card or bank changes) can only be approved by a **finance, admin or IT** user.
* The AI can never send. With the default setting an approved reply is **saved in the Outlook Drafts folder** and a person presses Send in Outlook. "Send from the helpdesk" is a switch **only IT** can turn on.
* Reply wording (templates) must be **approved by an admin or IT user**; changing the words takes the approval away until it is approved again. The bundled wording is a **sample**.
* Everything is written to an **audit log** (what the AI did, what staff changed, drafts, approvals, overrides, closures, settings).

## 4. Connect the real Outlook mailbox

Needs someone who administers Autostrad's Microsoft 365. The app **reads the shared mailbox with Microsoft Graph** (no add-in to install):

1. Entra admin center ▸ **App registrations** ▸ new registration "Autostrad Helpdesk".
2. **API permissions** ▸ Microsoft Graph ▸ *Application* permissions: `Mail.ReadWrite` (read, tag, draft), `Mail.Send` (only if replies are to be sent from here), optionally `MailboxSettings.ReadWrite` (coloured category labels). **Grant admin consent.**
3. **Certificates and secrets** ▸ new client secret ▸ copy the *value*.
4. Limit the app to the helpdesk mailbox only (Exchange Online application access policy, or the newer RBAC for Applications scope).
5. Copy `server/.env.example` to `server/.env` and fill in `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`, `HELPDESK_MAILBOX`, and uncomment `HELPDESK_PROVIDER=graph`. Restart the server. **The secret lives only in that file, never in the app or the database.**
6. Helpdesk setup ▸ Mailbox ▸ **Test the Outlook connection** walks through sign-in, Inbox, Sent Items and a message, and says which step fails and how to fix it.

From then on mail arrives by itself: the Inbox and Sent Items are read every 2 minutes with Graph delta queries (only what is new). Each customer email is tagged in Outlook with its category, priority, status, team, owner and case number, and flagged with the due date. Replies staff write in Outlook are matched to the case by the case number or the conversation. **This connector has been tested against a mock of the Graph API, not against Autostrad's tenant: try it on a test mailbox first.**

## 4b. Customer, contract and invoice data

Each new email is looked up by the sender's address and the contract number in it: the **customer**, the **contract** (vehicle, dates, branch, payment status), its **invoices, fines, deposit and card hold**, and the sender's other contracts. The answers are kept with the case, so the screen, the hints and the drafted reply use the same facts.
Guide for the system owners and for whoever configures it: **[CUSTOMER_API.md](CUSTOMER_API.md)**.

* **Two sources.** The CRM's own records (demo) until the real systems are connected; then the customer systems (Orion Fleet, the CNR Portal) through a JSON file that maps their field names. No code change, no secret in the file.
  `npm run dev:live` runs a stand-in for those systems so every screen can be tried now.
* **Nothing is lost when a system is down.** The case opens, says customer details are not available yet, and is completed automatically (12 tries over about four hours). Refreshing never replaces good details with nothing.
* **Who is writing matters.** A contract number typed in an email proves nothing, so when the sender is not the customer on the contract the case shows a red warning and the drafted reply **leaves out deposit, card-hold and invoice figures** until staff press **Confirm sender**.
* **An answer is only used when it proves it is about the sender or the contract asked for** (an API that ignores a filter answers with somebody else's records), and **a reply always goes to the customer's address on the case**, never to whoever wrote last.
* **A contract is only guessed when the email names none** (the sender's running or just-finished rental). A number the systems do not know is never replaced by a guess: the case says so and offers the sender's own contracts.
* Setup: **Helpdesk setup ▸ Customer data** (status, problems in the file, missing keys, each system's health, and **Try a lookup** that shows every step; IT can also see each system's untouched answer).
* Not run against the real systems yet: that needs their API documentation and a sandbox.

## 5. Optional AI

Add `ANTHROPIC_API_KEY=` to `server/.env` (and restart). `HELPDESK_LLM_MODE` is `always` (default), `fallback` (only when the rules are unsure) or `off`. The model defaults to `claude-opus-5-5` (`HELPDESK_LLM_MODEL` changes it). At about 20 emails a day the cost is a few dollars a month.

## 6. Settings and timings (Helpdesk setup ▸ Routing and timing)

| Setting | Default |
|---|---|
| Time to answer: Critical / High / Average / Low | 4 h / 24 h / 48 h / 72 h (the clock pauses while waiting for the customer) |
| Customer reminders | after 48 h and 96 h (as drafts) |
| Close with no response | 7 days after the last reminder |
| Escalation | owner when late, team lead 12 h later, management 24 h later |
| "To check" below | 60% confidence |
| Mailbox read every | 2 minutes |
| Daily / weekly summary | 07:00 Gulf time / Mondays |

## 7. Demo data

`npm run seed` (destructive, deterministic) creates about 150 cases over 45 days that went through the real pipeline (answered, chased, closed, escalated, a few corrections), deposit and card-hold records for the contracts, routing rules, labelled test emails, reply wording, and 14 accounts with support teams. WhatsApp and call counts are **demo figures** (those channels are not connected).

## 8. Files

```
server/src/helpdesk/
  pipeline.js      email → case (thread matching, extraction, classify, priority, route, draft, Outlook tags)
  classify.js · dictionary.js · learner.js · llm.js · extract.js · priority.js     the engine
  insights.js      "what to look at" from the CRM        templates*.js · drafts.js   reply wording and drafts
  followups.js     reminders, auto-close, escalation     metrics.js · reports.js     dashboard and summaries
  mail/graph.js    Microsoft Graph connector              mail/demo.js · diagnose.js  demo mailbox, connection test
  systems/         the customer-systems connector: config.js (the file and its checks) · client.js (HTTP: sign-in, timeouts, retries, pause, cache)
                   mapping.js (the field language) · resolver.js (email to customer, contract, invoices, who is writing) · account.js (kept with the case)
                   actions.js (confirm sender, retry after an outage) · status.js (setup page)       config: server/config/customer-systems*.json
  routes.js · lab.js · scheduler.js · seed.js · schema.js · settings.js · testset*.js
server/test/       node:test (about 200 checks): NLP, the API end to end on a throw-away database, the customer-systems connector (mapping, configuration, HTTP safety, resolver,
                   pipeline, HTTP routes), a mock Microsoft Graph server (sign-in, delta sync,
                   paging, throttling, tagging, drafts, sending) and a mock Anthropic server (request shape, redaction, invented facts)   run: npm --prefix server test
web/src/helpdesk/  Dashboard · Cases · CaseDrawer · Reports · Lab · Setup · Samples · Readiness · config · shared
```

## 9. Assumptions and limits

* **Not an Outlook add-in.** It is a web app that reads the mailbox through Graph. Staff can still work in Outlook; their replies are picked up.
* **Contract, customer and invoice data** comes from the CRM's own tables (demo) until the real systems are connected (section 4b). The connector is built and tested on a stand-in API; it has **not** been run against Orion Fleet or the CNR Portal, whose API documentation is still to come. Invoices are linked, not attached to replies.
* **WhatsApp and phone calls are not connected.** They need their own data source; the dashboard shows hand-entered counts, labelled as such.
* **Reply wording is sample text**, pre-approved so the demo works. Autostrad must replace and approve its own (and have the Arabic reviewed). The *Impact* value of each request type is a sensible assumption to confirm.
* The default contract-number format is `AST-123456`: confirm it (Routing and timing) against real emails.
* Attachments are not read; the case says an email has attachments and links to Outlook.
* Mail is polled every 2 minutes rather than pushed (no public webhook endpoint needed).
* Roles are enforced on the server for the whole CRM, not only the helpdesk (section 3).

## 10. API (all under `/api/helpdesk`, sign-in required)

```
GET  summary · dashboard?days= · meta · readiness · audit?case_id=&action=&q=
GET  cases?tab=&priority=&category=&sub_key=&department=&owner_id=&aging=&q=&sort=&dir=&limit=&offset=   cases/counts   cases/:id
PATCH cases/:id            POST cases/:id/status | close | reopen | escalate | drafts | notes
PATCH drafts/:id           POST drafts/:id/approve | discard          (sensitive replies need finance, admin or IT)
GET  reports  reports/:id  POST reports/generate
GET  mailbox   POST mailbox/sync | mailbox/test | mailbox/demo/emails | mailbox/demo/reply
POST cases/:id/account/refresh | account/verify                       (ask the customer systems again; confirm the sender)
GET  systems   POST systems/test                                     (admin and IT: connection status; a test lookup, raw answers for IT only)
GET  samples   POST samples/send                                     (demo mailbox)
CRUD templates · keywords · routing · channels                       (admin and IT write)
GET/PUT settings (admin and IT; the mailbox, AI and sending switches IT only)
POST lab/classify · lab/run · lab/tests · lab/tests/import · lab/tests/reset · lab/model/retrain   GET lab/tests · lab/runs · lab/model · lab/feedback
```
