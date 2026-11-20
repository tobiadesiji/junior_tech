# Junior Tech Academy — v0.2.0

A private family learning app for a beginner aged around 10, with a 24-week IT,
coding, automation and virtual robotics programme. Updated with tutor and administrator workspaces and Junior AI Tutor. Continued from the uploaded
`NanoOfficialRefactoring` Replit starter on 19 November 2026.

## What is working

- 24 complete weekly lessons, each with two 30–40 minute sessions, six exercises,
  objectives, a stretch challenge, output, assessment, teaching notes and a quiz.
- Six modules: digital foundations, Scratch, Python, simulated automation, virtual
  robotics and a final invention. Physical robotics hardware is not required.
- Real parent accounts and separate parent-created student usernames/passphrases.
  Students do not need email addresses or personal AI accounts.
- Server-persisted checklists and knowledge checks; quiz answers are verified on
  the server and are omitted from curriculum responses.
- Private project descriptions, reflections, HTTPS links and file attachments.
  Scratch, Python and MakeCode run separately; the app stores their exported work.
- Parent feedback, five-part rubric, revision history and automatic unlocking of
  the next week after approval. Parents can manually open later weeks too.
- Multiple student profiles per parent; students see only their own saved work.
- Passphrase reset for students, activity history and a family export including
  attachments. No public child profiles, advertising or analytics. Junior AI Tutor is opt-in per student.
- A responsive interface with layouts for desktop and mobile. A live visual
  browser review remains outstanding; see VALIDATION.md.

## Run on your computer

Install **Node.js 24.14 or later in the Node 24 series** from the official Node.js
site. This app has zero third-party runtime dependencies. You do not need pnpm,
Replit, a package registry, Postgres, an AI API key, or an `npm install` step.

Open a terminal in this folder.

macOS/Linux:

```bash
ALLOW_REGISTRATION=true npm start
```

Windows PowerShell:

```powershell
$env:ALLOW_REGISTRATION="true"
npm start
```

Open **http://localhost:3000** exactly. Select **Create a parent account**, register,
then go to **Family & access** to add a student. The initial data directory is empty:
there are no demo users, default passwords or prefilled learning records.

After creating the parent account, stop the process and restart with registration
closed. Existing parent and student sign-in continues to work:

```bash
npm start
```

In PowerShell, remove the setting first:

```powershell
Remove-Item Env:ALLOW_REGISTRATION
npm start
```

The app binds to 127.0.0.1 by default. Data is kept in `data/academy.sqlite` and
survives app restarts. Do not run the server from a temporary extraction folder
that you intend to delete.

## Use the programme

1. Parent: create a student using a nickname, unique username and a passphrase of
   at least 12 characters. Agree on a study plan.
2. Sign out. Student: choose **Student** on the sign-in screen and use those details.
   On a shared computer, signing out switches between the separate roles. For
   simultaneous use, use different devices or separate browser profiles.
3. Student: complete both sessions, tick six steps and pass the knowledge check.
   Add a description and reflection, optionally attaching a file or HTTPS link.
4. Parent: sign in and open the submitted week. Review the work, score all five
   skills, and give specific feedback. Approve to unlock the next week or request
   an improvement so the student can submit a new version.

Scores: 0 = not shown yet; 1 = with help; 2 = mostly independent; 3 = confident and
able to explain. A bonus challenge is optional. The app tracks completed work,
submissions and feedback; it does not monitor the child’s screen, browser history
or time spent inside external tools.

Files: PNG, JPG, PDF, TXT, PY, SB3 and HEX, up to 10 MB each and 100 MB per student.
Files are downloaded as attachments and are not executed or embedded in the app.
Basic image/PDF/ZIP signatures are checked; uploads are not malware-scanned.
Project links are never fetched by the server. External links may have their own
sharing settings: keeping a submission private here does not change the external
provider’s permissions.

## Docker / a Proxmox VM or container

Dockerfile and Compose are included for deployment. The Compose volume now explicitly uses ezra-training-data to match your existing docker-run deployment. The app has **not** been
deployed to your homelab or any public host by this delivery. The container image
was not built in this environment; verify it on the chosen host.

Put an HTTPS reverse proxy on the intended host in front of the application.
Set the following environment values, replacing the example origin with your
chosen real domain. Do not include a trailing slash or subpath.

```bash
export APP_ORIGIN=https://academy.example.com
export ALLOW_REGISTRATION=false
docker compose up -d --build
```

The provided Compose file binds host port 3080 to the host’s loopback interface by default (EZRA_BIND_IP and EZRA_PORT can change it), for a
reverse proxy that can reach that interface. If Nginx Proxy Manager is in a
separate container, attach both to a private Docker network and proxy to the
academy service on port 3000 instead; configure that network on your host. Do not
assume a different container can use the host’s 127.0.0.1 address.

Create the initial parent account locally before deploying, or briefly enable
`ALLOW_REGISTRATION=true` during your controlled setup, create the parent account,
then set it to false and recreate the container. Registration is closed by default.
Make sure your database volume persists and contains the account you created.

Production requires an HTTPS `APP_ORIGIN`. It enables Secure cookies, HSTS, origin
checks and session-bound CSRF tokens. Keep the browser-facing origin exactly equal
to APP_ORIGIN. HTTPS termination belongs to your reverse proxy. The server does
not trust arbitrary forwarded client IP headers; rate limits are per connection
IP, which may be shared by users behind a proxy.

Environment reference:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Listening port |
| `HOST` | `127.0.0.1` | Listen interface; Docker image uses `0.0.0.0` |
| `APP_ORIGIN` | `http://localhost:3000` | Exact browser origin; HTTPS required in production |
| `NODE_ENV` | unset | Set to `production` behind HTTPS |
| `ALLOW_REGISTRATION` | `false` | Allow new parent accounts during controlled setup |
| `ADMIN_EMAIL` | unset | Exact email of an existing parent account that administers tutors |
| `OPENAI_API_KEY` | unset | Existing server-held API key; never add it to source files |
| `OPENAI_MODEL` | `gpt-6.1-terra` | Compatible Responses API model |
| `OPENAI_ZDR_CONFIRMED` | `false` | Operator attestation after actual project ZDR is active |
| `AI_DAILY_REQUEST_LIMIT` | `200` | Total help request limit per UTC day |
| `DB_PATH` | `./data/academy.sqlite` | Persistent SQLite database path |

## Back up and restore

`npm run backup` creates a consistent SQLite snapshot in the current folder,
including accounts, learning records and attachment bytes. It can run while the
app is running. To choose a path:

```bash
node backup.mjs /secure-backups/academy.sqlite
```

For the Docker deployment:

```bash
docker compose exec academy node backup.mjs /app/data/backup.sqlite
docker compose cp academy:/app/data/backup.sqlite ./academy-backup.sqlite
```

To restore, stop the application, preserve the current database and its WAL/SHM
sidecar files, then put a backup snapshot at the configured DB_PATH in a clean
data directory with the correct owner and permissions. Start the application
again and check the family dashboard. Do not restore by copying over a live
database. Database backups include credentials and active sessions: keep them
private and restrict access to the host and backup location.

The family JSON export is a readable copy of profile data and attached files
(base64); a JSON import workflow is not implemented. Use the SQLite backup for
restoration. Downloaded files and database storage are not encrypted by this app;
use your host’s disk and backup protection.

## Tutor dashboard and Junior AI Tutor

See **UPGRADE.md** for the exact update procedure for your existing Docker server
at https://learning.createdtocreate.uk. New database tables are added automatically;
existing parent and student accounts, files and learning records are retained.

| Account | Access |
| --- | --- |
| Parent | Their own students; profiles, credentials, study plan, reviews, tutor assignments, AI permissions and full retained history export |
| Student | Their own lessons, submissions, feedback and parent-enabled AI help |
| Tutor | Only parent-assigned students; progress, private projects and downloads, rubric review, teaching notes and AI conversations |
| Academy administrator | An existing parent account selected through ADMIN_EMAIL; tutor account creation, pause/reactivation and passphrase reset; overall counts |

The administrator does not automatically receive other families’ private student
records. A parent grants tutor access by entering an existing tutor’s exact email
under **Tutors & AI controls**. Revocation takes effect on the next request. Pausing
or resetting a tutor invalidates their existing sessions. Tutors choose **Tutor**
on the sign-in screen and use administrator-created access; there is no public
staff registration and no default administrator password.

Junior AI Tutor provides explanations, small hints, smaller steps and extra
practice. Parent controls default to off and permit 1–50 help requests per day
(default 20). An academy-wide limit defaults to 200 requests per UTC day and can
be set with AI_DAILY_REQUEST_LIMIT. These are request caps, not monetary caps.
Failed provider requests count towards the allowance. AI never marks work,
changes scores or unlocks lessons.

The integration calls OpenAI’s Responses API from the server using the existing
OPENAI_API_KEY environment variable. The default model is gpt-6.1-terra with low
reasoning effort; OPENAI_MODEL may override it with a compatible model. No key is
included in this package, browser code, API responses or logs. Guided mode sends
only the authored lesson and a fixed help prompt: no student identifier, profile,
project file, free text or previous transcript. Generated responses are moderated
before being shown. The model has no tools or code execution access.

Typed questions require BOTH parent opt-in AND OPENAI_ZDR_CONFIRMED=true. This
flag is an operator confirmation: it does not configure or obtain Zero Data
Retention. Before enabling it, verify that the actual OpenAI organization/project
used by your key has approved ZDR in effect. The under-13 guidance requires ZDR
before processing children’s personal data; store:false alone is not ZDR. The
packaged upgrade leaves typed questions disabled. Guided mode works without
sending child personal data to OpenAI. For typed mode, inputs and outputs are
moderated, a hashed internal identifier is sent for safety monitoring, and a
limited recent lesson conversation is sent for context. Typed questions can
contain personal information, which is why they remain gated.

Conversations and safety check-in markers are stored locally for up to 30 days,
with cleanup on use and every minute while the server runs. Parents and assigned
tutors can view them; no automated notification is sent. UI previews show recent
messages, and opening the AI page fetches the full retained history for that week.
Parent exports include all retained messages. Database backups may keep older
messages: manage their retention separately. The system prompt and moderation
reduce risk but do not guarantee answer accuracy or replace adult oversight.

## Current boundaries

- The app has not been upgraded on your server by generating this package. Run
  the provided upgrade procedure and complete the deployment acceptance checks.
- No live OpenAI request, Docker build or browser end-to-end/visual review was
  possible in this environment. Provider tests use a fake transport and no real
  student data. Your existing API key was not accessed here.
- No email delivery, verification, parent self-service password recovery, MFA,
  account deletion UI or file removal UI. Keep the parent passphrase safely.
- One parent login owns a family. Assigned tutors can help across families;
  inviting another guardian to share the same family is still not implemented.
- No screen monitoring, automatic code marking, public student portfolios or
  integration that reads progress from external Scratch/MakeCode tools.

Official API references consulted on 19 November 2026:

- Under-18 guidance: https://developers.openai.com/api/docs/guides/safety-checks/under-18-api-guidance
- Data controls: https://developers.openai.com/api/docs/guides/your-data
- Responses API: https://developers.openai.com/api/reference/resources/responses/methods/create
- Moderation: https://developers.openai.com/api/docs/guides/moderation
- Model: https://developers.openai.com/api/docs/models/gpt-6.1-terra

## Continue development

`server.mjs` implements the HTTP API, sessions and SQLite persistence.
`learning-support.mjs` adds staff roles, assignments and AI permissions/history.
`junior-ai.mjs` implements the OpenAI transport, teaching prompt and moderation.
`curriculum.mjs` contains the teaching programme and server-side quiz keys.
`public/app.js` and `public/styles.css` implement the interface. Static HTML stays
free of personal data; the browser loads an authorised view after sign-in.
The Node built-in test runner exercises the application with temporary databases:

```bash
npm test
```

Official learning tools linked from the programme (checked 19 November 2026):

- Scratch editor: https://scratch.mit.edu/projects/editor/
- Microsoft MakeCode for micro:bit: https://makecode.microbit.org/
- Python downloads: https://www.python.org/downloads/
- Node 24 SQLite reference: https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html

Teaching text was written for this project; it is not copied course material from
the linked providers. A parent handles software installation and any external
account or sharing decisions.
