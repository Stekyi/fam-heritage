# Family Heritage Tree

A family heritage archive and community platform, hosted on Netlify with Neon PostgreSQL.

## What it does

| Area | Who | What |
| --- | --- | --- |
| **Family Tree** | Everyone | Person-centred tree: search by name, AKA or alias; ancestors, descendants, siblings, spouses; zoom; horizontal scrolling for crowded generations. Person cards show photo, AKA, dates, age/lifespan, birth place and occupation. |
| **Family History** | Everyone | The Asankran clan history, public comments (moderated) and family stories. |
| **Network** | Everyone to view, token holders to act | Find relatives by profession, location, gender and age range. Business Ideas with an "I'm Interested" flow; contact details are visible only to the idea owner. |
| **Analysis** | Everyone | Statistics from recorded data only: living/deceased, gender, current age vs age at death, births/deaths by decade, generations, occupations, birthplaces. |
| **Contribute** | Token holders | "My Family Profile": link a token to yourself (or join through an invitation), publish an About page, write stories, suggest new relatives and corrections. |
| **Admin** | Administrator | Moderate comments and tree suggestions, manage tokens (create, disable, unlink), remove stories and ideas. |

Anyone with a valid 5-digit contributor token can edit **any** person's descriptive details (name, AKA, gender, dates, birth place, occupation, location, photo). Saving is immediate, with a toast and no second confirmation. Editing never touches relationships.

## Permission model

All authorisation is enforced in the Netlify Functions, never in the browser.

| Capability | Public | Token | Token linked to a person | Admin |
| --- | :-: | :-: | :-: | :-: |
| Browse tree, search, history, analysis, network, stories, ideas | yes | yes | yes | yes |
| Comment (moderated) | yes | yes | yes | yes |
| Edit any person's details and photo | | yes | yes | |
| Link / unlink own token | | yes | yes | |
| Write own profile, stories; post ideas; express interest | | | yes | |
| Suggest new people / relationships (needs approval) | | yes | yes | |
| Approve suggestions and comments, manage tokens, remove content | | | | yes |

Tokens are stored as an HMAC (`TOKEN_PEPPER`; the app refuses to run without `TOKEN_PEPPER` or `ADMIN_SECRET`). New tokens are 8 characters (a letter first, no look-alike characters); legacy 5-digit tokens still work but are much easier to guess, so prefer the 8-character kind.

Brute-force protection (all in Postgres, so it holds across serverless instances): each attempt is recorded before it is checked, failed attempts stay counted, and valid use is never throttled. Limits per 10 minutes: 20 failed tokens per IP, 500 failed tokens sitewide (token checks then pause for everyone, but the administrator is unaffected), 10 failed admin attempts per IP and 100 sitewide. Only the platform-set `x-nf-client-connection-ip` header is trusted. The admin secret is sent only in the `x-admin-secret` header, compared in constant time, and never embedded in the page. Admin -> Security shows recent failures.

Living people are protected in public views: their exact birth date and where they live now are only returned to valid contributor tokens (the public sees the birth year only). Bulk endpoints are limited per IP (tree 60, search 300, network and analysis 120 per 10 minutes), and the data endpoints accept GET only.

Every edit to a person stores the old and new values; Admin -> Edit history shows them and can restore the previous values (a restore is recorded too). Photos: the last four are kept per person so a removed photo can be restored.

There is **no public export** of any kind (no JSON/CSV/Excel/GEDCOM/database dump endpoint, and no static data files are served). The read APIs used by the app refuse to be opened as a page (`Sec-Fetch-Dest: document`), but they necessarily return data to the app itself, so a determined scraper could still read what the tree shows.

## Invitations, alerts, corrections, backup

- **Invitations** (Admin -> Invitations): create a single-use link, optionally for a specific person. The recipient opens it, confirms who they are and gets their own 8-character token automatically (shown once, saved in their browser). Codes are 16 characters, stored only as a keyed hash, expire after 7 to 30 days, and can be revoked.
- **Email alerts and weekly digest**: the administrator is emailed about new comments, new tree suggestions and people joining, capped at 20 alerts per hour. Every Monday at 13:00 UTC a digest summarises what is waiting, the week's activity, upcoming birthdays and remembrance days, and failed sign-ins. Needs `RESEND_API_KEY` and `ADMIN_EMAIL`; without them nothing is sent and nothing breaks.
- **Corrections**: any contributor can suggest removing a wrong family link (with a reason) or adding a missing one from a person's profile. The administrator sees a plain-language description, approves or rejects, and a removed link is kept in the audit log. Links that would make someone their own ancestor are refused.
- **Birthdays and remembrance** (Network -> Birthdays): remembrance days of the deceased are public; birthdays of living relatives are shown only to contributors.
- **Backup** (Admin -> Backup): download everything as JSON (tokens only as hashes, no photos) or the tree as GEDCOM 5.5.1 for Gramps, Ancestry and similar. Photos stay in the database; make sure Neon point-in-time recovery is enabled for your project.
## Environment variables (Netlify)

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Neon connection string |
| `ADMIN_SECRET` | Long random administrator secret |
| `TOKEN_PEPPER` | Another long random secret used to hash contributor tokens |
| `RESEND_API_KEY` | Optional. Enables email alerts and the weekly digest |
| `ADMIN_EMAIL` | Optional. Where alerts and the digest are sent |
| `MAIL_FROM` | Optional. Sender, e.g. `Family Heritage <alerts@your-domain>` (the Resend default only reaches the account owner) |
| `SITE_URL` | Optional. Used for links in emails (defaults to Netlify's `URL`) |

Do not change `TOKEN_PEPPER` after tokens have been issued; it would invalidate every token.

## Database

Schema `001` (original) plus additive migration `002_heritage_platform` (see `netlify/functions/_schema.mjs`):

- `people` gains `birth_date`, `death_date`, `birth_place`, `occupation`, `location`, `living_status`, `updated_by`; gender may now be `M`, `F`, `O` or `U`.
- Migration `003_hardening`: `people.kind` (person / placeholder / place; unknown ancestors and the sacred rock are left out of Analysis), `person_revisions` (edit history), `images.token_id` (cover ownership).
- New tables: `images` (profile and cover images stored in Postgres, so they persist across deployments), `token_person_links`, `profiles`, `stories`, `business_ideas`, `business_interests`, plus indexes on names, aliases, occupation, birth place, location, ideas and comments.
- Nothing is dropped or rewritten. Relationships are not touched.

The migration is applied automatically (once, under an advisory lock) the first time a function runs after deploy. To apply it explicitly:

```
DATABASE_URL="..." npm run migrate
```

> **Do not re-run `npm run seed` on a live database.** The seed rebuilds every person, which would delete profiles, stories, links and edits. It now refuses to run when contributor content exists unless you pass `--force`.

## Deploying

1. Merge to the branch Netlify deploys. Build command empty, publish `public`, functions `netlify/functions` (already in `netlify.toml`).
2. Confirm `DATABASE_URL`, `ADMIN_SECRET`, `TOKEN_PEPPER` are set.
3. Open the site once (or run `npm run migrate`) so the migration is applied.
4. Admin → Contributor tokens → generate tokens and give them out privately.

## Development and tests

```
npm install
npm test                      # API integration, security and unit tests (in-memory Postgres)
node tests/dev-server.mjs     # local QA server on :8899 (tokens 11111 and 22222, admin secret test-admin-secret)
```

`tests/fixtures/family.json` is a snapshot of the validated tree. The integration tests assert the validated relationships (Nana Mansa's five children, Yaa Brefaa's children, Maame Ansaba under Helena Baidoo, Isaac Obiri-Yeboah's daughters) before and after editing.

## Data-merging principle

Explicit family-confirmed identity mappings take precedence over the original HTML naming. For the Mansa branch, Excel is authoritative for the root-side names and dates. Other ambiguous identities are not automatically collapsed merely because two people have similar names; those can be handled through the moderation workflow.

**User-confirmed merge:** Excel `Ama Buah (Nana Mansa)` is the same person as HTML `Mansa`; Excel `Abena Gyampraa` is the same person as HTML `Maa Abena`. `Kwaku Buafo (Opayin Kankyea)` is recorded as Ama Buah's spouse/partner.

## Source-file note

The uploaded HTML contains a Family Echo copyright/license notice. This project does **not** copy the Family Echo application code or interface. It uses the family data as the source material and provides a new application implementation.
