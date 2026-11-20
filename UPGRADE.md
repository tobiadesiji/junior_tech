# Update your existing Docker deployment to v0.2.0

Target: `tadesiji@Tobi-Ubuntu-002:~/Apps/ezra`, container `ezra-training`, domain
https://learning.createdtocreate.uk, forwarding to 192.168.1.139:3080.

## 1. Upload the new source

Extract the updated ZIP and copy the contents of its NanoOfficialRefactoring
folder directly into `~/Apps/ezra`, replacing the application source files.
Keep your existing server-held key file and any local backups. There are no
database files or real API credentials in this download. Preserve the named
Docker data volume: the supplied script discovers and reuses it.

## 2. Run the upgrade

Use the path of an existing Docker-compatible environment file containing your
authorised OPENAI_API_KEY. Pass the path only; never paste the key in chat or add
it to application source files. Docker reads the file on the host; it is not
copied into the image.

```bash
cd ~/Apps/ezra
bash upgrade.sh /absolute/path/to/your/existing-key.env
```

Replace the example path with the real path on your Ubuntu server. If your key
exists only as an environment variable or in another secret manager, supply it
through your normal secure deployment mechanism instead of this env-file script.
Do not invent an env-file location or place the key in the ZIP.

The script asks for **the email you already used to create your parent account**.
That account gains the Academy admin menu; it keeps its family and password. The
script checks that the account exists before making a container change.

The script then:

1. Creates a consistent database backup and copies it to a private `backups/`
   folder on your host.
2. Builds `ezra-training:0.2.0` and checks that the selected env file provides a key
   without displaying its value. This confirms presence, not API validity/billing.
3. Stops and retains the previous container under a dated name, then starts the
   new container using the same data volume and HTTPS APP_ORIGIN.
4. Checks the local application health endpoint; on startup failure it restores
   the old container. A healthy app does not prove a successful external AI call.
5. Closes new parent registration and keeps typed AI questions disabled.

Existing accounts, project files, progress and sessions are kept. The new tables
for tutors and AI support are created automatically. The previously stopped
container remains available for rollback; the script does not remove it or any
data volume. Docker and shell execution of this script still need verification on
your actual host; the current development environment could not build containers.

## 3. Set up your tutor and AI access

1. Open https://learning.createdtocreate.uk and refresh. Sign in with your
   existing parent account; open **Academy admin**.
2. Create a tutor account. The tutor uses the **Tutor** sign-in tab. There is no
   automatic email delivery: share their credentials through your usual secure
   process. You can use a separate tutor login for yourself if you want to test
   the same access a teacher receives.
3. As the parent, open **Tutors & AI controls**. For each intended student, enter
   the tutor’s exact email to grant access. This explicitly shares that student’s
   progress, private projects/downloads and AI conversations. An administrator
   cannot simply claim access to another family’s students.
4. Enable Junior AI Tutor for the student and choose a daily allowance.
5. Sign in as the student, open an unlocked lesson or **Junior AI Tutor**, and
   choose a guided help button. Verify that a real response arrives and is visible
   in the parent/tutor conversation view. This is the first live API test; none
   was made using your key during development.
6. Complete a project and review it from the assigned tutor account. Check that
   approval unlocks the next week. Test revoking the tutor’s access as parent.

Keep the reverse-proxy target at `http://192.168.1.139:3080` and access the app
through the HTTPS domain so the Origin header and Secure session cookie match.

## Typed AI questions

The guided tutor is functional without a free-text box. It sends static curriculum
content and one fixed prompt; student personal data, projects and previous
conversations stay on your server.

OpenAI’s under-18 guidance says that processing personal data of children under
13 requires Zero Data Retention in its API. Actual project approval/configuration
is required: a Docker flag or store:false does not enable that service-side
control. After verifying that the key’s actual organization/project has ZDR
active, you can recreate the container with OPENAI_ZDR_CONFIRMED=true and let the
parent opt a student into typed questions. Do not set it merely to unlock the UI.
No child needs a ChatGPT account.

Sources:

- https://developers.openai.com/api/docs/guides/safety-checks/under-18-api-guidance
- https://developers.openai.com/api/docs/guides/your-data

## Check the running version

```bash
docker exec ezra-training node -e "fetch('http://127.0.0.1:3000/api/healthz').then(r=>r.json()).then(console.log)"
docker logs --tail 60 ezra-training
```

The health response should include version `0.2.0`. Logs never intentionally print
the API key. Do not share environment-file contents or full Docker configuration
inspection output when troubleshooting.

## Manual rollback

If functional testing fails after the upgrade, use the previous container name
printed by the script. Stop and remove only the new container, rename the old one
back to ezra-training, and start it. Keep the same named volume. The new schema
adds tables without changing the original account/progress/project tables, so the
old application remains compatible. The private pre-upgrade snapshot is also
available under `backups/`; do not copy it over a live database.
