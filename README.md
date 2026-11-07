# DoH Circular Portal (Node.js)

## Run it from GitHub (Windows PC)

Needs Node.js 20 or newer (https://nodejs.org) and Microsoft Word (for the PDF files).

1.  and open the folder.
2. Double-click **setup.bat** – it creates  from  and installs the packages.
3. Double-click **start-portal.bat** – the portal opens at http://localhost:8080.
4. On first start, create the administrator (only possible on that PC itself) and set up two-factor sign-in.
5. Optional: **install-startup.bat** starts it automatically when Windows starts.

Facility data, master templates, passwords and keys are not in the repository – each PC keeps its own
(, , ).


A small web portal that checks the Department of Health – Abu Dhabi circulars every night. When it finds
new circulars, it:

* adds them to your existing **Legal Register** workbook;
* fills in the DoH compliance columns (Compliance, Responsible Person, Target Date, Reporting Frequency,
  Reporting Authority);
* e-mails a real-time alert and/or a daily summary.

It is one Node.js process with five dependencies, no database server and no build step.

```
setup.bat            one-time: npm install + register check
start-portal.bat     run the portal in a window → http://localhost:8080
install-startup.bat  start it hidden at every Windows log-on (no admin rights needed)
```

## Security: sign-in, two-factor authentication, roles

* Every page, API call, download and export requires signing in: **username + password + a 6-digit code** from an
  authenticator app (Google / Microsoft Authenticator, TOTP RFC 6238) or a code e-mailed to the user.
* Passwords are stored only as **BCrypt** hashes (cost 12). Sessions are HttpOnly, SameSite=Strict cookies (12 h).
* **5 wrong attempts lock an account for 15 minutes** (an admin can unlock); sign-in attempts are also rate-limited.
* Roles: **Admin** (users, shared settings, add/remove facilities), **Manager** (register, documents, monitoring,
  exports for their facilities), **Viewer** (read-only + exports). Users can be limited to specific facilities.
* **First start:** open http://localhost:8080 *on the portal PC* – it asks to create the administrator account and
  then shows a QR code to scan. New users get a temporary password, choose their own at first sign-in and link their
  authenticator. Users are managed under **Settings → Users & security**; everyone can change their password under
  **Settings → My account**.
* Accounts are in `data/users.json` (hashes and 2FA keys) – keep that file private and include it in backups.

## Policy documents (Policies tab)

The first step for a facility: its policy set is prepared from the master templates, then linked to the Legal Register.

1. **Master policies** (administrator, once): upload the standard policies as Word files (.docx; .doc is converted by
   Word). Each is recognised from its content: policy number (PO01…PO33), standard (ADHICS) and the facility it was
   written for. Then **Lock as master baseline**: the baseline facility (e.g. MY HEALTH MEDICAL CENTER / MHMC, its
   contact e-mail and phone) is recorded and every file is fingerprinted. While locked, templates cannot be replaced
   or removed, and a template changed on disk is refused. Templates are never modified; each facility gets its own
   filled copy. **Prepare policies for a new facility** creates the facility (and its Legal Register) from one form.
   For any facility other than the baseline, every baseline reference – name, code (whole word), contact e-mail
   (incl. mailto links) and phone – is replaced, and each generated policy is re-checked: anything left is reported.
2. **Details** (once per facility, applied to every policy): Issued on, Reviewed on, Prepared by, Approved by.
   *Due for Revision on* = one year after *Reviewed on*. The facility name comes from the facility. Policy ID =
   `<code> / ADHICS - PO<nn>`. Version 1.0, except PO03, PO18, PO19 and PO25 (2.0) – changeable per policy, with
   the description of changes. Upload the **logo** (default: the facility logo), **signature** and **stamp**
   (separately or as one file; images or a PDF) – each is cropped and its background made transparent.
3. **Generate**: every template is filled – the labelled Document Control cells, the template facility's name in the
   text, headers and footers, the logo picture, the version-history table, and the signature + stamp under it (the
   template's old ones are removed). The RESTRICTED / داخلي badge and all other content and layout are kept. Files
   are saved in `facilities/<code>/policies/Word` and `/PDF` (PDF by Microsoft Word, print-ready) and can be
   downloaded one by one or as ZIP.
4. **Link to Legal Register**: the facility name, approver and author of the generated PO01 are written to the
   register's Document Control (backup first), then the Legal Register opens.

**Versions and editing of the masters**
* PO03, PO18, PO19 and PO25 hold two masters: **v1.0** (the original MY HEALTH MEDICAL CENTER file) and **v2.0** (the
  updated policy, e.g. the AL ATAA & AL RAHMA files with the documented changes). The **1.0 | 2.0** switch per policy
  picks the master used for generation; *View* shows a master as a document (PDF made by Word).
* A master may come from any facility: its own name spellings, code, contact e-mail / phone and people are detected
  and replaced, like the baseline's.
* **Edit** (administrator): change the wording of any paragraph, add a clause (e.g. a DoH requirement) after any
  paragraph, or delete one – tables, headers, logo and badge are not touched. **Save & lock** keeps the previous file
  in `data/policy-templates/_history`, makes the edited master the source of every later generation and locks the
  set again. For bigger changes: *Word file* → download, edit in Word, upload (stored as that version's master).

**Layout and checks of every generated policy**
* Logo: centred in the page header (fitted inside the master's logo box, never stretched).
* Signature + stamp: inside the *Approval Signature* cell of the latest version row – always on the concluding page.
  When that would push the end of the table onto a new page, the policy is made again with them smaller and side by
  side (automatic), so no blank or signature-only page is ever added.
* Pictures are cropped, freed of their background and reduced to print size (logo 1000 px, signature 800 px, stamp
  700 px): a full 33-policy pack is about 15 MB of PDF and a ~25 MB ZIP (Word + PDF).
* Versions: each policy can hold a v1.0 and a v2.0 master side by side (upload the other version while unlocked; the
  set locks again by itself). The version chosen per policy picks the master and the version-history rows.
* Validation before export (per policy): every labelled value read back from the generated document, nothing of the
  master facility left, DoH contacts unchanged, PDF made, last page not empty, file size reasonable.

## Facility documents: details and logo

* Details are read from the document's **content**, never its file name: labelled fields (Policy ID, Approved by,
  Prepared by, Group / Facility name, Issued on …), and otherwise the facility name that the text mentions most.
* **Logo:** the most logo-like picture is chosen (wide footer banners and whole scanned pages lose to a real logo; for a
  scanned page the logo block at the top is found). It is then cropped to the logo with a small margin, specks are
  dropped and the plain background (including the inside of letters) is made transparent
  (`scripts/logo-clean.ps1`, Windows imaging on this PC). Always check the preview before applying.

## Multiple facilities

One portal serves every facility. The template, layout, automation and compliance rules are identical for all;
only the facility-specific data differs.

| What | Where | Per facility? |
|---|---|---|
| Facility title, facility code, date of release, approver, author(s) | Settings → This facility → A. Document Control | yes |
| Centre name, responsible persons, e-mail recipients, monitoring scope | Settings → This facility → Centre / branch | yes |
| Master Excel register: upload, link a path, or create from another facility's template | Settings → This facility → Master Excel data source, or **+ Add facility** | yes |
| Master-table entries (names, dates, responsible, compliance) | Legal Register tab | yes |
| Schedule, e-mail server, DoH rules, portal password | Settings → All facilities | shared |

**Fixed in every deployment** (enforced by the server; not editable): the LEGAL REGISTER branding and section titles,
"A. Document Control" and its field labels, the `<code> / LGL REGISTER` number format, Version No. 1.0, the
RESTRICTED / داخلي classification, the six federal laws/decrees (recognised by name), the IT Department entry and the
two compliance statuses. When a facility's document control is saved, these are written into its workbook too.

* `facilities.json` lists the facilities. On first start it is created from the single-facility `config.json`;
  MHMC keeps its existing folders. New facilities keep their data, reports, backups and uploaded register in
  `facilities/<code>/`.
* Every workbook is validated before use: the three sheets, the circular columns and all six fixed laws must be
  present. Standard elements that differ are listed and corrected on save.
* **Create from template** copies another facility's workbook. It keeps the DoH circular history (column G
  re-assigned to the new responsible person; IT Department rows unchanged), resets the facility entries' dates, and
  writes the new header. The source workbook is only read.
* Nightly, the DoH list is fetched **once** and applied to each facility's register in turn. A locked register at one
  facility does not stop the others. E-mail subjects carry the facility code.
* CLI: `node cli.js facilities`, `node cli.js run --all`, `node cli.js run --facility br2`.

## How it works

1. **Nightly at 02:00 (Asia/Dubai)**, the portal reads the official DoH circulars data source. This is the
   same JSON endpoint the DoH Circulars page uses. It pages through every year and category (about 1,740
   circulars).
2. It compares each circular with the register by number, title and link, not by "highest number".
   `US-06-2019` and `US/6/2019` are treated as the same. If a number is already in the register with a
   different title, the circular is held for manual check.
3. For each new circular it downloads the PDF, reads the text, and decides the values for columns F–J
   (see below).
4. It updates the workbook safely:
   * checks that the file isn't open in Excel, retrying up to 5 times one minute apart;
   * takes a backup in `backups/`;
   * patches **only** the Circular sheet's XML, so logos, styles, the other sheets and every existing row
     and hyperlink stay byte-for-byte identical;
   * validates the result, then swaps it in.

   New rows copy the formatting of the row above. Circular No. and Name are both linked to the DoH PDF.
5. It records a history entry and an HTML report, and sends e-mail if configured.
6. **Catch-up:** if the PC was off at 02:00, a run starts 2 minutes after the portal next starts.
7. **Safety limit:** more than 25 new circulars in one run are held until you approve them on the
   Overview tab.

## Compliance metadata rules (columns F–J)

The rules are derived from how your team filled the existing 1,366 rows:

| Column | Historical pattern |
|---|---|
| F | "Fully Complaince" 1,161 times, "Not Applicable" 205 times (spelling kept so Excel filters still work) |
| G | always " Dr. Mohamed Aboelkhair" |
| H, I | "Immediate" for recalls; "_" when nothing applies |
| J | always "DOH" |

The rules are adapted to your profile as a **medical centre with pharmacy** and to your role as the
**3rd-party IT service provider**. They are checked in this order:

| # | Situation | F Compliance | G Responsible | H Target date | I Frequency |
|---|---|---|---|---|---|
| 1 | Service you don't provide (home care, ambulance, hospitals/surgery, IVF, transplant, mortuary, insurers/TPA only…) | Not Applicable | branch responsible person | _ | _ |
| 2 | IT / information-system obligation (ADHICS, Malaffi, cloud, backup, platforms, data submission…) | Fully Complaince | **IT Department (3rd-Party IT Service Provider)**, fixed | deadline from the PDF, else _ | from the PDF, else _ |
| 3 | Product recall / safety alert | Fully Complaince | branch responsible person | Immediate | _ |
| 4 | Everything else | Fully Complaince | branch responsible person | deadline from the PDF, else _ | from the PDF, else _ |

Only two compliance statuses exist: **Fully Compliant** (written as the register's own spelling "Fully Complaince" on the
Circular sheet, so existing Excel filters keep working) and **Not Applicable**. Any other value is rejected, and the
nightly run corrects rows that still hold a retired status such as "Under Review" (column F only).

The **responsible person** is set per centre/branch in Settings (with a list of names offered in the drop-downs). The
**IT Department** entry is fixed in the code and identical for every centre.

J is always "DOH".

* **Deadlines** are read from phrases such as "no later than 31 December 2026" or "effective from
  1 January 2027", and written as real Excel dates.
* **Frequency** is taken only from sentences about reporting or submitting, e.g. "submit … quarterly"
  becomes "3 Months".
* Any value can be overridden: open the circular on the **DoH Circulars** tab, change the values and click
  *Save to Legal Register*. That writes to the same Excel row (after a backup) and records who reviewed it.
* All keyword lists, labels and names are editable on the **Settings** tab.

> "Fully Complaince" for case 4 follows your register's practice and your instruction. It is an
> automatic entry, not evidence of compliance. Every automatic decision shows its reason in the
> portal, and anything can be overridden there.

## Legal Register tab (master table and document control)

* **A. Document Control:** facility title, document number, date of release, approver, author(s), version and
  classification. They are shown in the portal header and on every exported report and e-mail. *Save* also writes
  them to the DOCUMENT CONTROLLER sheet (only cells that differ).
* **Master table** (LEGAL REGISTER sheet):
  * entries **1–9** (DOH, ADDED, ADHICS, Malaffi, MCC, waste, Tadweer, ICA, Jawda): issued / expiry / due date,
    responsible person and compliance are editable. Expired dates are shown in red, and dates within 30 days in amber.
  * **Malaffi** is a one-time (lifetime) connection certificate: it never gets an expiry or due date (they stay
    "______" in Excel, shown as "∞ Lifetime" in the portal) and it counts as valid once it has an issue date.
  * entries **10–15** (federal laws and decrees) are **fixed**. The portal shows them read-only and the server
    refuses any change to them.
* *Export / Print* opens a printable page with the document-control header and the master table (save it as PDF from there).

## Portal

A navy top bar (facility logo and switcher, four tabs, a **Light / Dark** switch, user menu with sign-out). Light theme by default.

* **Home** (everything on one screen, each section with a one-line explanation):
  * facility card: logo, title, document control (number, release date, approver, author, version) and RESTRICTED badge;
  * overall compliance status in one sentence, with a score ring and *Upload documents*;
  * six key numbers (Total / Valid / Expiring soon / Expired / No dates yet / DoH circulars); click one to see those entries;
  * *Needs your attention* list with *Update* buttons, and quick actions (upload, Excel, PDF, add entry);
  * every licence, certificate and contract with issued / expiry dates and a "time left" bar;
  * DoH circulars: last check, next check, e-mail alerts, *Check DoH now / Check only / Check all facilities*;
    last check result and live activity;
  * all facilities with their register health.
* **Legal Register:** document control line, status filters, the master table, upload and *More* menu (Excel, PDF,
  print view, import from a policy document).
* **DoH Circulars:** every processed circular with its F–J values and the reason for each. Click a row to review or
  override.
* **Settings:** this facility, schedule & e-mail, users & security, my account, check history and the activity log.

The portal listens on `127.0.0.1:8080` only, so it isn't visible on the network. To open it from other
PCs, set `server.host` to `0.0.0.0` in `config.json` **and** set a portal password in Settings.

## E-mail

1. In Settings, enter the SMTP server, username and recipients. For Office 365 that's
   `smtp.office365.com`, port 587, SSL off (it uses STARTTLS).
2. Save, then click *Send test e-mail*.

The password is stored in `data/secrets.json` (never in `config.json`), or you can set the
`DOH_PORTAL_SMTP_PASSWORD` environment variable instead.

Three kinds of e-mail can be sent:
* **Real-time:** right after a nightly run that added or completed circulars.
* **Daily summary:** at 07:30, covering the last 24 hours.
* **Failure alert:** when the DoH site is unreachable or the register stayed locked.

## Command line

```
node --use-system-ca cli.js check           check only, no changes
node --use-system-ca cli.js run [--force]   update now (--force = approve beyond the safety limit)
node --use-system-ca cli.js summary         send the daily summary now
node --use-system-ca cli.js register-info   read-only summary of the register
npm test                                    acceptance tests on a copy of the register
```

## Files

```
server.js         web server + API + scheduler        src/monitor.js   one monitoring run
src/doh.js        DoH data endpoint + downloads        src/rules.js     F–J rules, PDF text, deadlines
src/normalize.js  matching / duplicate detection       src/xlsx.js      safe Excel read + patch + validate
src/mailer.js     e-mail                               src/store.js     JSON history (data/db.json)
public/           portal (HTML/CSS/JS)                 test/            mock DoH site + acceptance tests
config.json       all settings                         scripts/         start-up task install/uninstall
```

Working folders, created automatically: `data/`, `reports/`, `backups/` (last 60 kept), `downloads/`
(circular PDFs by year) and `logs/`.

## Tests

`npm test` copies the register to the temp folder (the original is only read and is hash-checked) and
runs it against a local replica of the DoH site. It checks:
* detection, including across capped pages;
* appending new circulars and completing blank F–J (columns A–E untouched);
* every rule case;
* re-runs add no duplicates;
* a reviewer override changes exactly one row;
* a locked workbook (Windows sharing lock and Excel `~$` file) is reported and left alone;
* a website outage is reported and nothing is written;
* the safety limit holds a large batch;
* **Microsoft Excel opens the result without repair**.

Result: **10/10 passed**.
