# VisaDesk runbook

Step-by-step operations for someone who is not a full-time developer. Everything runs on **free tiers of Vercel (Hobby) and GitHub**, with Turso (database) and Vercel Blob (files) added from inside Vercel, and Resend for email. Security background is in [`SECURITY.md`](SECURITY.md).

You need: a GitHub account with access to the repository, a Vercel account (sign in with GitHub), a Resend account, and Node.js 20 on your laptop for the one-off commands.

---

## 1. First deployment

### 1.1 Import the repository into Vercel
1. Go to <https://vercel.com/new>, choose **Import Git Repository**, pick the VisaDesk repo.
2. Framework preset: **Next.js** (detected). Leave the build command empty: `package.json` has a `vercel-build` script that runs migrations, the seed, then `next build`.
3. Do **not** deploy yet. Click **Environment Variables** first (section 1.4), or let the first build fail and redeploy after setting them.

### 1.2 Create the database (Turso, via the Vercel Marketplace)
1. In the Vercel project: **Storage → Create Database → Turso (Marketplace)**. Pick the free plan.
2. Choose the location **closest to the function region**. The functions run in `fra1` (Frankfurt, set in `vercel.json`), so pick **Frankfurt / AWS eu-central-1** if offered (otherwise the nearest European location). Function and database in the same region matter far more than distance to Kampala, because each page makes several database round trips.
3. Connect it to the project for **Production** (and Preview if you want). Vercel adds the connection variables. VisaDesk reads **`DATABASE_URL`** (the `libsql://…` URL) and **`DATABASE_AUTH_TOKEN`**. If the integration created differently named variables (for example `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`), add `DATABASE_URL` and `DATABASE_AUTH_TOKEN` with the same values.

### 1.3 Create the file store (Vercel Blob)
1. **Storage → Create → Blob**. Region: **Frankfurt (fra1)** if offered. Connect it to the project.
2. Vercel adds `BLOB_READ_WRITE_TOKEN`. Files are always stored encrypted by the app; the store must still be **private** (VisaDesk uploads with `access: 'private'`).

### 1.4 Environment variables (Project → Settings → Environment Variables, Production)

Generate each secret on your laptop with:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

| Variable | Value |
|---|---|
| `APP_NAME`, `NEXT_PUBLIC_APP_NAME` | `VisaDesk` |
| `APP_URL` | Your production URL, e.g. `https://visadesk.vercel.app` (no trailing slash) |
| `DATABASE_URL`, `DATABASE_AUTH_TOKEN` | From step 1.2 |
| `BLOB_READ_WRITE_TOKEN` | From step 1.3 |
| `SESSION_SECRET` | A generated secret |
| `FILE_ENCRYPTION_KEY` | A generated secret (**exactly** the command above: 32 bytes, base64). **Save it in the password manager. Losing it means losing every stored document.** |
| `FILE_ENCRYPTION_KEY_ID` | `k1` |
| `CRON_SECRET` | A generated secret (Vercel Cron sends it automatically) |
| `RESEND_API_KEY` | From section 1.5 |
| `EMAIL_FROM` | e.g. `VisaDesk <visadesk@your-verified-domain>` |
| `RESEND_WEBHOOK_SECRET` | From section 1.5 (`whsec_…`) |
| `ALLOWED_EMAIL_DOMAINS` | `cavendish.ac.ug` |
| `DEFAULT_TIMEZONE` | `Africa/Kampala` |
| `EMAIL_DAILY_CAP` | `80` (Resend free = 100/day including sign-in codes) |

Then **Deployments → Redeploy**. The build applies migrations and seeds rule set v1 and the reason templates. Production never creates the dev test users.

### 1.5 Email (Resend)
1. Create an account at <https://resend.com>. Free plan.
2. **Domains → Add domain**: add a domain or subdomain the university controls (e.g. `visadesk.cavendish.ac.ug`) and add the DNS records Resend shows (ask university IT). Until the domain is verified, Resend only sends to your own address.
3. **API Keys → Create** (sending access) → `RESEND_API_KEY`.
4. **Webhooks → Add endpoint**: URL `https://<your-app>/api/webhooks/resend`, events `email.bounced`, `email.complained`, `email.delivered`. Copy the signing secret → `RESEND_WEBHOOK_SECRET`. Bounced students then show as "unreachable" in the staff UI (`profiles.email_status = 'bounced'`); a later successful delivery clears it.

### 1.6 First admin
Production has no users. On your laptop, in the repository folder (after `npm ci`):
```bash
DATABASE_URL="libsql://…" DATABASE_AUTH_TOKEN="…" \
  npx tsx --conditions=react-server scripts/bootstrap-admin.ts --email dos.admin@cavendish.ac.ug --name "Full Name"
```
(On Windows PowerShell set the variables first: `$env:DATABASE_URL="…"; $env:DATABASE_AUTH_TOKEN="…"`.)
Sign in at `/login` with that email, then invite the other staff from **Admin → Staff**. Delete the token from your shell history afterwards.

### 1.7 Verify the scheduled jobs
1. **Project → Settings → Cron Jobs** should list `/api/cron/daily-runway` (03:00 UTC = 06:00 Kampala) and `/api/cron/retention-sweep` (03:30 UTC).
2. Click **Run** next to each (or wait a day), then open **Logs** and look for a JSON line with `"job":"daily-runway"` and `"complete":true`.
3. In the app, **Admin → Retention → Recent job runs** shows each run with its counts.
4. Manual call from a terminal: `curl -H "Authorization: Bearer $CRON_SECRET" https://<app>/api/cron/daily-runway`. Without the header it must return 401.

### 1.8 GitHub settings
Repository → **Settings → Secrets and variables → Actions**:
- Secrets: `DATABASE_URL`, `DATABASE_AUTH_TOKEN`, `BACKUP_PASSPHRASE` (a long random passphrase, stored in the password manager), `CRON_SECRET`.
- Variables: `APP_URL` (enables the health/email-retry workflow). Optional `RUN_E2E=true` once Playwright tests exist.

Workflows: **CI** (typecheck, lint, tests on every push/PR), **Nightly DB backup** (01:15 UTC), **Health check and email retry** (every 6 hours).

---

## 2. Everyday checks (weekly, 5 minutes)
- **Admin → Audit log**: the banner must say *Chain verified*.
- **Admin → Retention**: recent job runs are `done`; the dry run looks sensible.
- **GitHub → Actions**: the backup ran each night (green). Download is not needed.
- Vercel → Usage: nothing close to a limit (section 6).

---

## 3. Backups and restore

### What is backed up
Every night `.github/workflows/backup.yml` dumps the whole Turso database to SQL (`scripts/backup.ts`, libSQL client only), gzips it, encrypts it with `openssl enc -aes-256-cbc -pbkdf2 -iter 200000` and `BACKUP_PASSPHRASE`, checks that it decrypts, and stores it as a workflow **artifact for 30 days**. Run it any time from **Actions → Nightly DB backup → Run workflow**.

Not included: the encrypted files in Vercel Blob (documents, packets, receipts). They are on durable storage but have no second copy on the free plan. A packet can be regenerated; a lost student document must be re-uploaded by the student.

### Restore (or restore drill)
1. **Actions → Nightly DB backup →** pick a run → download the artifact (a zip containing `visadesk-<date>.sql.gz.enc` and a `.sha256`).
2. Decrypt and unpack:
   ```bash
   sha256sum -c visadesk-<date>.sha256
   BACKUP_PASSPHRASE='…' openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
     -in visadesk-<date>.sql.gz.enc -out backup.sql.gz -pass env:BACKUP_PASSPHRASE
   gunzip backup.sql.gz
   ```
3. Restore into an **empty** database. For a drill use a local file:
   ```bash
   DATABASE_URL=file:./data/restore-drill.db npx tsx scripts/restore.ts --in backup.sql
   DATABASE_URL=file:./data/restore-drill.db npx tsx --conditions=react-server scripts/verify-audit.ts
   ```
   The second command must print `"ok":true`. For a real recovery, create a **new** Turso database (Vercel → Storage), restore into its URL/token, then point `DATABASE_URL`/`DATABASE_AUTH_TOKEN` in Vercel at it and redeploy. `restore.ts` refuses a non-empty target unless you pass `--force`.
4. Delete `backup.sql` and the drill database when done.

### Quarterly restore drill log
| Date | Backup used | Rows restored | Audit chain | Who |
|---|---|---|---|---|
| | | | | |

---

## 4. Rotating keys
Follow SECURITY.md §5 "Key rotation procedure". Short version for the file key: add the old key to `FILE_ENCRYPTION_PREVIOUS_KEYS`, set the new key and `FILE_ENCRYPTION_KEY_ID=k2`, redeploy, run `scripts/rotate-file-key.ts`, then remove the old key.

---

## 5. Troubleshooting
| Symptom | Check |
|---|---|
| Students do not get emails | Resend dashboard → Logs; domain verified? `EMAIL_DAILY_CAP` reached (cron log shows `"capped":true`)? Failed rows retry with backoff (immediately, 15 min, 2 h, 12 h; 5 attempts max). |
| Cron did not run | Hobby crons fire once a day, at some point within the scheduled hour. Check Settings → Cron Jobs and Logs. `CRON_SECRET` set? |
| Daily job stopped half-way | It saves a cursor and re-invokes itself (`?hop=N`, up to 8 times). If interrupted anyway, the next day's run (or a manual call) finishes it; nothing is sent twice. |
| "Missing required production env" | One of `SESSION_SECRET`, `FILE_ENCRYPTION_KEY`, `CRON_SECRET` is missing in Vercel. |
| Audit banner red | Follow the breach procedure (SECURITY.md §8). |

---

## 6. Free-tier limits (check the providers' pricing pages; numbers change)
| Service | Limit that matters | What VisaDesk does |
|---|---|---|
| **Vercel Hobby** | Non-commercial use only; cron jobs run **at most once a day** with hour-level precision; function duration 60 s (300 s with Fluid compute); functions run in one region; 4.5 MB request body | Jobs are chunked with a 40 s budget and self-continue; uploads are ≤ 3 MB JPGs; region `fra1` |
| **Vercel Blob (Hobby)** | **1 GB storage, 2,000 uploads and 10,000 uncached reads per month; when exceeded, Blob is blocked for 30 days** | Images capped at 3 MB, CDN-cached reads, retention deletes files 90 days after closing. That is only about 85 new applications a month and 60–115 held at once: see [`PERFORMANCE.md`](PERFORMANCE.md) §5.2 and decide on Pro or the listed mitigations **before** the first intake. Check Usage weekly |
| **Turso free** | Storage, monthly row reads/writes caps; free databases can be archived after long inactivity on some plans | The health workflow touches the DB every 6 h; daily job reads all students once |
| **Resend free** | **100 emails/day**, 3,000/month, one domain | Cron sends at most `EMAIL_DAILY_CAP` (80) per 24 h; the rest wait for the next run. Reminder bursts (many students hitting 30 days on the same day) are spread over days. Upgrade if the cohort is large. Sign-in codes are **not** counted by the cap: stagger invitations at semester start ([`PERFORMANCE.md`](PERFORMANCE.md) §5.3) |
| **GitHub Actions** | Private repos: 2,000 min/month and **500 MB artifact + package storage** on the Free plan. Public repos: free minutes, but scheduled workflows are disabled after 60 days without repo activity | Backups are a few MB each × 30 days. A full `npm ci` per backup costs ~1–2 min/night (~60 min/month); health pings ~120 min/month. Keep the repo **private** |

Regions: Vercel Hobby lets you pick one function region. Closest to Uganda are `cpt1` (Cape Town), `bom1` (Mumbai) and the European regions (`fra1`, `cdg1`, `lhr1`, `dub1`, `arn1`). We use **`fra1`** because Turso and Blob offer Frankfurt, keeping function ↔ database latency in single-digit milliseconds; Kampala ↔ Frankfurt is roughly 150–200 ms either way. Change `regions` in `vercel.json` only together with the database location.
