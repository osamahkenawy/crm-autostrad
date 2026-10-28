# Customer systems: contract, customer and invoice data for the helpdesk

For the people who own **Orion Fleet**, the **CNR Portal** (or whichever systems hold the real contracts, customers and invoices), and for whoever
configures the connection. The helpdesk itself is described in [HELPDESK.md](HELPDESK.md); what infrastructure must provide is in
[INFRA_REQUIREMENTS.md](INFRA_REQUIREMENTS.md).

**Status:** **the CNR Portal now answers every question except deposit and card hold**, from the Fleet database, through a read-only API
built into the portal (`/api/crm/v1`, described in the CNR repository's `CRM_API.md`). It was tested end to end against UAT data. The ready
configuration is `server/config/customer-systems.cnr.json`: see [Connecting the CNR Portal](#connecting-the-cnr-portal) below. The
stand-in API (`server/scripts/mock-customer-api.mjs`, `npm run dev:live`) is still there for trying the screens without a connection.

### Connecting the CNR Portal

Three lines in `server/.env`, then restart:

```dotenv
CUSTOMER_SYSTEMS_CONFIG=config/customer-systems.cnr.json
CNR_BASE_URL=https://payment-portal.enguae.com/api/crm/v1
CNR_API_KEY=<one of the keys in the portal's CRM_API_KEYS>
```

What to know about its answers:

* Customers are `P<code>` (the primary customer: the billed account, often a company) or `H<code>` (the hirer: the driver). A contract
  belongs to its primary customer when it has one, else to its hirer. So a driver writing about a company car is **not confirmed** until staff
  confirm them, and a person who is both account holder and hirer gets the note "2 customers share the address".
* Contract numbers are `MRA-6022600031`. A bare number works too (the open contract, then the newest), and emails are read for `RAC`, `MRA`,
  `LES` and `LTO` numbers.
* Invoices say **paid** only when the portal itself took the payment. Every other invoice is **unconfirmed**: shown, never counted as owed, no balance.
* The CRM server must resolve the portal's name to 10.4.2.200 and be allowed through its firewall on 443.

---

## 1. What it does

```
customer email ──▶ who wrote (address) + which contract (number in the email, if any)
                              │
        ┌─────────────────────┼──────────────────────────────┐
        ▼                     ▼                              ▼
  the customer          the contract                    the invoices, fines,
  (by address)          (by number, or the sender's      deposit and card hold
                         current rental if none given)
        └─────────────────────┬──────────────────────────────┘
                              ▼
        one account kept with the case ──▶ the case screen, the "what to look at" hints and the drafted reply use the same facts
```

* **Every new email is looked up by itself**, about one second later, by the sender's address and the contract number in the email. Nobody presses a button.
* The answers are **stored with the case** (so screens are instant and a reply uses exactly what staff saw). They are asked again when staff press **Refresh**,
  when a person changes the contract number, and before a reply is drafted if they are older than 10 minutes.
* **If a system is down the email is still turned into a case**, marked "customer details not available yet", and completed automatically when the system answers
  (retries after 1, 2, 4, 8, 15 minutes, then every 30 minutes, 12 tries).
* **Spam and automatic replies are never looked up.**
* Until the real systems are connected the helpdesk reads the CRM's own demo records (`HELPDESK_ACCOUNT_SOURCE` and the file below decide which).

## 2. The questions it asks

Each question is one **read-only GET** (a POST is possible if an API requires it). Only the first two are needed to start; every other question that is not configured is simply skipped.

| Question | Asked with | Needed to show | Used for |
|---|---|---|---|
| `customer_by_email` | the sender's address | the customer: name, tier, segment, phone | greeting, priority (Gold, Platinum, corporate), **is the sender the customer** |
| `contract` | the contract number from the email | the contract: status, dates, vehicle, branch, value, payment status, **and whose it is** | the case screen, the hints, the reply |
| `customer_by_id` | the customer id on the contract | the customer's record when the contract only carries an id | showing who a contract belongs to |
| `contracts_by_customer` | the customer id (or address) | the sender's recent contracts | guessing the contract when the email names none; "other contracts" shortlist |
| `invoices` | the contract number (or the customer id) | invoices: number, total, VAT, status, dates, amount still to pay | "invoice matches the amount", unpaid and overdue hints, invoice replies |
| `fines` | the contract number | fines and Salik: reference, type, amount, fee, status | dispute hints |
| `financials` | the contract number | security deposit and card hold: amount, status, dates, last four digits | deposit and pre-authorization replies |

**Minimum useful set:** `customer_by_email` + `contract` + `invoices`.

### What each answer must contain

The field **names are yours**: the configuration file says which is which (section 5). What matters is that the *information* is there.

| Record | Must have | Nice to have |
|---|---|---|
| **Customer** | an id or the address, and a name | other addresses on file, phone, tier (Standard, Silver, Gold, Platinum), segment (individual or corporate), status |
| **Contract** | its number | status (on rent, returned, booked, cancelled), start and end time, total, payment status, product, vehicle make, model and plate, pick-up branch and emirate, a link to it in the portal, **the customer's id or address** |
| **Invoice** | its number | total, VAT, status (paid, sent, overdue, draft, cancelled), issue date, due date, **amount still to pay**, which contract it belongs to, a link to the PDF |
| **Fine** | reference | type (traffic fine, Salik), amount, admin fee, status (recovered, unrecovered, disputed), date |
| **Deposit** | amount | status (held, refund pending, refunded), refund due date |
| **Card hold** | amount | status (active, release requested, released), release date, last four card digits |

> **An answer is only used when it proves it is about what was asked.** A system that ignores a filter answers with somebody else's records, so the helpdesk
> uses a question's answer only when (a) the identifier is part of the address path, as in `/customers/{customer_id}/contracts` or `/contracts/{contract_no}/fines`, or
> (b) every record says what it belongs to: `contract_no` on invoices, fines and the deposit record, `customer_id` or `customer_email` on a contract list,
> `email` or `emails` on the customer lookup (required), or (c) the lookup says `"scoped": true`, which means the system's owner confirms the answer is limited to what
> was asked. Records without proof are **dropped and a warning says so** on the setup page (Try a lookup).
>
> **Why "the customer's id or address" on the contract matters:** it is how the helpdesk tells *the customer asking about their own rental* from *someone who typed a
> contract number from a letter*. Without it every sender who quotes a contract is treated as unconfirmed and staff must confirm them by hand (section 6).

## 3. What the API owners need to provide

A checklist to hand over. Anything the system cannot do, say so: usually a small mapping or a different question solves it.

1. **Read-only service access** for the helpdesk: an API key, a bearer token, a user name and password, or an OAuth client (client credentials). One credential per system. It must **not** be able to change anything.
2. **Base address** of each API (HTTPS), reachable from the helpdesk server (INFRA_REQUIREMENTS, section 5: the outbound allow-list).
3. **For each question in section 2**: the address and parameters, and one **real answer** (JSON), including a record that is *not found* and one with *missing* values. Redact personal data in the samples if you wish.
4. A **sandbox** or test data, with a few customers whose contracts have invoices, a deposit and a card hold, and one customer with two addresses.
5. The **exact filters**: can the customer be found by e-mail address (case-insensitive, and by any address on file)? Can a contract be read by its number as customers write it ("AST-123456" or "123456")?
6. **Status vocabularies** (the words for contract, invoice, fine, deposit and card-hold status) and **time zone** of dates without a zone.
7. **Limits:** requests per minute allowed, expected response time (the helpdesk gives up after 8 seconds), page size, whether lists are paged.
8. **Money:** amounts in AED? Decimal or minor units (fils)? VAT included in the total?
9. **A contact** for when a lookup fails.

**What it asks of your systems:** one to six small GETs per customer email (about 20 to 60 emails a day in the scope), answers cached for 5 minutes, at most 4 requests at a time per system, retried once on a temporary failure. It never sends the email text, only the sender's address and the contract number.

## 4. Try it before the real systems exist

The repository contains a stand-in for the systems, filled from the CRM's demo records, with deliberately different field names (camelCase, nested objects, upper-case statuses,
dd/mm/yyyy dates, money as text) so the mapping has real work to do.

```bash
npm run dev:live     # from the project folder: the stand-in systems (port 4010) + the app with the connector on
```

Then open **Helpdesk ▸ Setup ▸ Customer data**, run **Try a lookup** with `mariam.99@gmail.com` and `AST-100174`, and send a sample email (Cases ▸ Sample emails) to see
the live panel on a case. `npm run dev` goes back to the CRM's own records. The stand-in's rules are in `server/scripts/mock-customer-api.mjs`, the matching configuration
is `server/config/customer-systems.example.json`, and the settings `dev:live` starts the app with are in `server/config/dev-live.env`.

## 5. The configuration file

`server/config/customer-systems.json` (or the path in `CUSTOMER_SYSTEMS_CONFIG`). **It contains no secrets:** keys and addresses are *named* here and live in `server/.env`.
The file is re-read when it changes (no restart). Every mistake is explained in plain words on **Helpdesk ▸ Setup ▸ Customer data**.

```jsonc
{
  "enabled": true,                 // false = use the CRM's own records
  "fallback_to_crm": false,        // true = if the systems know nothing, show the CRM record (keep false with real data)
  "freshness_minutes": 10,         // ask again before drafting when the stored facts are older than this
  "utc_offset_hours": 4,           // Gulf time: dates without a zone are read as local time here
  "sources": {                     // the systems
    "orion": {
      "label": "Orion Fleet",
      "base_url_env": "ORION_BASE_URL",                                    // or "base_url": "https://..."
      "auth": { "type": "api_key", "header": "X-Api-Key", "key_env": "ORION_API_KEY" },
      "timeout_ms": 8000, "cache_seconds": 300, "max_concurrent": 4
    }
  },
  "lookups": {                     // the questions (names are fixed, section 2)
    "contract": {
      "source": "orion",
      "path": "/contracts/{contract_no}",       // {email}  {contract_no}  {customer_id}   {contract_no|digits}  {email?}
      "query": { },                              // e.g. { "email": "{email}" }
      "result": "data",                          // where the record(s) are in the answer ("" = the whole answer)
      "map": {                                   // which field of the answer is which fact
        "contract_no": "contractNumber",
        "status": { "path": "state", "map": { "ON_RENT": "active", "RETURNED": "completed" } },
        "start_at": { "path": "pickup.at", "type": "datetime" },
        "total_amount": { "path": "grandTotal", "type": "money" },
        "customer_id": "customerId",
        "vehicle_name": { "template": "{vehicle.make} {vehicle.model}" }
      }
    }
  }
}
```

### Signing in (`auth.type`)

| Type | Fields | Sent as |
|---|---|---|
| `none` | | nothing (only for a trusted internal network) |
| `api_key` | `key_env`, `header` (default `X-Api-Key`) or `query`, optional `prefix` | the key in a header, or in the address (it is masked in everything shown) |
| `bearer` | `token_env` | `Authorization: Bearer ...` |
| `basic` | `user_env`, `password_env` | `Authorization: Basic ...` |
| `oauth2_client_credentials` | `token_url` (or `token_url_env`), `client_id_env`, `client_secret_env`, optional `scope`, `audience`, `send_credentials` (`body` or `basic`) | a token fetched when needed, reused until it expires, renewed once if refused |

Mutual TLS (client certificates) and signed requests are not built; ask if a system needs them.

### Placeholders

`{email}` the sender's address (lower-case) · `{contract_no}` the number as written or as the system gave it · `{customer_id}` the id found by an earlier question.
Filters: `{contract_no|digits}` keeps only the digits ("AST-100123" becomes "100123"), `|lower`, `|upper`; `|odata` doubles apostrophes for a `'quoted'` value in a `$filter`, `|quote`
escapes a value that sits inside "quotes" in a JSON or GraphQL text. A value that a filter reduces to nothing counts as missing. Everything is **percent-encoded** into the address, so a hostile value cannot
add a path or a query. `{name?}` marks a value that may be missing (the question is still asked); every other placeholder is **required**: if it is not known the question is skipped.
Every question must use at least one required placeholder, so it can never ask for everybody's records.

### What the file may and may not contain

* **Addresses** must be `https`, and must not contain a user name or password (put those in `auth`). Plain `http` is refused unless the source says `"allow_http": true` (a trusted internal network) or it is `localhost` outside production. The same goes for an address read from `server/.env` and for an OAuth sign-in address.
* `"scoped": true` on a lookup (see section 2) means the owner of the system confirms its answer is limited to what was asked, so records need no proof of their own. Leave it out unless you have checked the system really filters.
* **A file that is edited into a broken state** does not change what the helpdesk does: the last good version keeps working and the setup page lists the problems. A file that was never valid makes every lookup say so; it never falls back to the CRM's demo records.
* A key with a curly quote or dash from copy and paste is reported as such.

### Reading a field (`map`)

A field is **a path**, **a list of paths** (first one with a value wins) or **an object**:

```
"name": "customer.fullName"                                  a path:  a.b[0].c   (a.0.c)   a.items[*].sku   (every item)   a.items.-1.id  (the last)
"name": ["fullName", "companyName"]                          fallbacks
"name": { "template": "{first} {last}" }                     compose from several fields
"status": { "path": "state", "map": { "ON_RENT": "active" } }   translate values (not case-sensitive); "unmapped": "null" drops the others
"total": { "path": "amount.gross", "type": "money" }         "1,234.50", "AED 1 234", 1250 all become 1234.5 / 1250
"total": { "path": "amount_fils", "type": "money", "scale": 0.01 }
"due":   { "path": "dueOn", "type": "date" }                 -> 2026-10-06 (the Gulf calendar day);  "datetime" -> UTC time
"emails": { "path": "otherEmails", "type": "list" }
"x":     { "path": "p", "default": "n/a" }
```

Types: `string` (default) · `number` · `money` · `int` · `bool` · `date` · `datetime` · `email` · `lower` · `upper` · `list`.
Dates understand ISO (with or without zone), `dd/mm/yyyy` (`"date_order": "mdy"` flips it), epoch seconds or milliseconds, the .NET `/Date(...)/` form and written months (`1 October 2026`, `01-Oct-2026`); impossible dates and times are refused. A date without a zone is read as Gulf time.
Numbers may carry a currency word (`AED`, `Dhs`, `$`) and use either `1,234.50` or `1.234,50`; `5-` and `(5)` are negative; anything else next to the digits (`1e3`, `AST-100123`) is not a number.
Text is cleaned (control and direction-changing characters removed, 2,000 characters at most). Links are only kept when they are `http(s)` addresses.

### The fields each question can fill

| Question | Fields |
|---|---|
| `customer_by_email`, `customer_by_id` | `id` `name` `email` `emails` `phone` `tier` `segment` `status` `company` `language` `url` |
| `contract`, `contracts_by_customer` | `contract_no` `id` `status` `product_line` `start_at` `end_at` `total_amount` `payment_status` `currency` `url` `customer_id` `customer_email` `customer_name` `customer_phone` `customer_tier` `customer_segment` `vehicle_name` `vehicle_plate` `branch_name` `branch_emirate` |
| `invoices` | `number` `id` `total` `vat` `status` `issue_date` `due_date` `balance` `currency` `contract_no` `url` |
| `fines` | `reference` `id` `type` `amount` `admin_fee` `status` `issued_at` `contract_no` |
| `financials` | `deposit_amount` `deposit_status` `deposit_refund_due` `preauth_amount` `preauth_status` `preauth_released_at` `card_last4` |

Statuses are understood in the usual words without any mapping (`ON_RENT`, `Returned`, `UNPAID`, `Partially Paid`, `past due` and so on); anything else is kept as written and shown as plain words.
An invoice that is sent, has something left to pay and is past its due date is shown as **overdue** even if the system only says "open". Totals of what is owed count **invoices only**, never drafts.
An invoice status the helpdesk does not know (such as "unconfirmed") is shown as written and says nothing about what is owed: without a mapped `balance` it has none.

### Setting it up

1. Copy `server/config/customer-systems.example.json` over `customer-systems.json`. Change the paths, parameters and field names to match the real API. Set `"enabled": true`.
2. Put the addresses and keys in `server/.env` (`ORION_BASE_URL`, `ORION_API_KEY`, ... the names you chose) and restart the server.
3. **Helpdesk ▸ Setup ▸ Customer data** lists what is still missing and any mistakes in the file.
4. Use **Try a lookup** with a real address and contract number. IT can tick *Show what each system answered* to see the untouched answers and the field names. Each step shows the address asked, the HTTP status and the time.
5. When the panel matches the system, leave it on. `HELPDESK_ACCOUNT_SOURCE=crm` (or `api`) in `server/.env` overrides the file in an emergency.

## 6. Who is writing: why replies sometimes leave figures out

Anyone can type a contract number into an email, and the sender's address can be forged. Looking up the contract is safe for staff to read; **quoting its deposit, card hold or
invoice in a reply is not safe unless the sender is the customer**. So the helpdesk decides, for every case:

| Verdict | When | What changes |
|---|---|---|
| **Sender is the customer** | the address (or another address on file) belongs to the customer on the contract, or the contract was found from the sender's own records | nothing: replies quote the figures |
| **Not the customer on this contract** | a contract number was found, but nothing shows the sender is its customer (a colleague, a company mailbox, a stranger) | a red warning on the case; the drafted reply **leaves out deposit, card-hold, invoice and card figures**; staff press **Confirm sender** after checking (the reply is written again). The confirmation is for that sender and that contract only |
| **Nothing matched** | no customer and no contract found | nothing to quote |

The contract answer needs the customer's id or address for this (section 2). The decision never blocks reading or answering: it only protects what a reply may say. When the sender is not confirmed, the reply
leaves out deposit, card-hold, invoice, card, **vehicle and branch** details.

**Where a reply goes.** Always to the customer's address on the case: never to whoever wrote last on the thread, and never to a `Reply-To`. If somebody else joins the thread, the history says so. If staff change the
customer's address on a case, a reply written for the old address has to be written again. The sender check uses the `From` address, which Microsoft 365 screens for forgery but which is not proof: that is why a doubtful sender
is confirmed by a person. A stranger who quotes a contract number does not borrow the customer's name, tier or priority.

A contract is **only guessed** when the email names none (then it is the sender's running rental, or one that ended within 60 days, never a cancelled or future one). If the email names a number the
system does not know, nothing is guessed: the case says so and lists the sender's own contracts with a **Use this one** button.

## 7. How it behaves when things go wrong

| Situation | What happens |
|---|---|
| A system is slow | gives up after `timeout_ms` (8 s), for the whole email at most 15 s; the case opens without it |
| A system is down or throttling | one retry after a short pause (it honours `Retry-After`); after 5 failures in a row the system is **paused for 60 s** so every email does not wait, then one request is let through to test it |
| Part of the answer is missing | the rest is shown, marked "some details are missing", and tried again automatically |
| The same customer writes three times | one call: answers are remembered for 5 minutes ("not found" for 1 minute). **Refresh** always asks again |
| A refresh fails | the details already on the case are **kept** and marked with the time; they are never replaced by nothing |
| The key is wrong or expired | "refused our credentials (401)" on the setup page, retried later; nothing else breaks. A refusal for one record (403) does not pause the system |
| An answer stalls half way | counted as the system not answering (after the timeout) |
| A record cannot be shown to belong to the customer or the contract | it is dropped with a warning (section 2), never shown or quoted |
| The configuration file is edited into a broken state | the last good version keeps working; the setup page lists the problems |
| A lot of different answers are remembered | the cache has a memory budget (24 MB) and drops the oldest |
| The API ignores a filter and answers with everybody | the answer is **not used** unless it provably is about the sender or the contract asked for, and a warning says what to check |
| An address in an answer points somewhere else | redirects are never followed; links in answers are shown only if they are `http(s)` |
| The answer is huge or not JSON | refused (2 MB limit, configurable) with a clear message |

Secrets are read from `server/.env` when a request is made, are never stored in the database and never appear in logs, errors, the status page or the audit trail.
What is stored with a case: the customer's name, address and phone, the contract and invoice facts, and where they came from. Retention follows the case (INFRA_REQUIREMENTS, section 6).

## 8. Troubleshooting

| You see | Likely cause | Fix |
|---|---|---|
| "Still missing on the server: ORION_API_KEY" | the line is not in `server/.env`, or the server was not restarted | add it, restart |
| "refused our credentials (401)" | wrong or expired key; the key may not read this resource | issue a new read-only key |
| "The contract lookup answered, but not with contract X" | the address or query does not limit the answer to one contract, or `contract_no` is not mapped | fix `path` / `query`, map `contract_no` |
| "The customer lookup answered with N customers, none with the address..." | the e-mail filter is ignored, or `email` / `emails` is not mapped | fix `query`, map `email` |
| Contract found but "The sender is not the customer" for the real customer | the contract answer has no customer id or address, or they differ in format from the customer lookup | map `customer_id` (and `id` in the customer lookup) or `customer_email` |
| Dates are a day off | the system sends local time without a zone, or `utc_offset_hours` is wrong | set `utc_offset_hours`; use `type: "date"` |
| Amounts are 100 times too big | the system sends fils | `"scale": 0.01` |
| "Nothing found" for a contract that exists | `404` for a wrong address looks the same as "not found" | open the step in **Try a lookup** and check the address shown |
| A status shows as plain words like "on hold" | an unknown status, shown as written | add it under `map` to a known one (`active`, `completed`, `held`, ...) |
| "did not answer with JSON" | wrong base address (a login page or a proxy answered) | fix the address |
| "could not be shown to belong to this customer / contract, so they were not used" | the system ignored its filter, or the records do not say what they belong to | map `contract_no` (invoices, fines, deposit) or `customer_id` / `customer_email` (contract lists); or put the identifier in the path; or `"scoped": true` once checked |
| "The base address must not contain a user name or password" | credentials were put in the address | move them to `auth` |

## 9. Limits and what is not built

* Lists are read from the **first page** only; ask for a sensible `limit` in `query`. Invoices are capped at 25 per contract, fines at 25, other contracts at 10.
* One question may need several systems (contract in Orion, invoices in the CNR Portal): that works. One question that needs **two calls** of the same system, a join of two answers, or calculated values is not expressible in the file: it needs a small adapter in `server/src/helpdesk/systems/` (we will write it once the API is known).
* Mutual TLS, request signing, a proxy for outbound calls and push updates (webhooks) are not built.
* Invoice PDFs are linked (`url`) but not attached to replies.
* **Not yet run against the real systems.** The first connection will need a session with their sample answers to adjust field names.

## 10. Files

```
server/config/customer-systems.json            the configuration (off by default)          customer-systems.example.json   a worked example
server/config/customer-systems.cnr.json        the real connection: the CNR Portal's CRM API (section "Connecting the CNR Portal")
server/scripts/mock-customer-api.mjs           the stand-in systems                         npm run dev:live (settings: config/dev-live.env)
server/src/helpdesk/systems/
  config.js     reads and checks the file               client.js     the HTTP client (sign-in, timeouts, retries, pause, cache)
  mapping.js    the field language                      resolver.js   email -> customer, contract, invoices, and who is writing
  account.js    keeps the account with the case         actions.js    confirm the sender, retry after an outage      status.js   the setup page's numbers
server/test/helpdesk.systems.test.js           the connector, 54 checks        helpdesk.systems.api.test.js   through the real server, 7 checks
server/test/helpdesk.systems.review.test.js    33 checks, one per finding of an independent security review
API:  GET /api/helpdesk/systems   POST /api/helpdesk/systems/test   POST /api/helpdesk/cases/:id/account/refresh | verify
```
