# Validation — 19 November 2026

Version 0.2.0, verified with Node.js v24.22.3. `npm test` passes **39 tests**.

The automated tests cover curriculum completeness, anonymous responses without
private data or answer keys, origin checks, real hashed passwords and separate
sessions, CSRF enforcement, parent-only controls, family isolation, sibling
isolation, locked weeks, server-checked quizzes, attachment types and ownership,
submission prerequisites, revision history, parent feedback and automatic unlock,
private data export, persistence across server restart, student session revocation,
logout, oversized requests, inaccessible server/database files, rendering every
lesson for both account roles, and escaping user-entered text.

JavaScript syntax checks pass for server and client. The backup command was run
against a local SQLite database; the generated snapshot passes SQLite's
`PRAGMA integrity_check`.

Additional v0.2.0 coverage includes an existing v0.1 database upgraded in place,
administrator privilege isolation, tutor creation/sign-in and session revocation,
parent-only assignments, review access limited to assigned students, immediate
assignment revocation, consent defaults, locked-week enforcement, guided payloads
without student identity/work/answer keys, free-text blocking without ZDR,
moderation fail-closed behaviour, safe provider errors, transcript scoping and
retention, persistent quotas, academy-wide caps, staff/AI view rendering and
escaped AI output. API tests use a **mock OpenAI transport**: no real key or paid
request was used. Typed-mode request shape is tested with synthetic lesson text.
These tests are not a red-team evaluation of a live model’s behaviour.

`bash -n upgrade.sh` passes. The supplied upgrade script makes a pre-upgrade
snapshot, reuses the existing named volume, preserves the previous container and
rolls back on failed startup health checks. Its Docker commands could not be run
here and must be checked on the Ubuntu host.

The cloud browser could not connect to the local preview server. There is **no
claim of a completed browser end-to-end test or visual/mobile review**. The view
tests render HTML with synthetic data and do not replace real browser testing.
Docker is unavailable in this environment, so the included image and Compose
configuration have not been built or launched here.

Before live use, perform this small-host acceptance run in a real browser:

1. Start with an empty persistent volume and create a parent account.
2. Create a student, sign out and sign in as that student.
3. Complete week 1, pass the quiz and attach a safe practice file to a submission.
4. Sign in as parent, download that file, give feedback and request an improvement.
5. Resubmit as student, approve as parent and confirm week 2 unlocks.
6. Restart the application and verify the work remains available.
7. Check the same workflow at a narrow mobile viewport and using the keyboard.
8. Back up the database and restore it into a separate test directory; check the
   same accounts and attachments there.

No real family accounts or learning records are included in the delivery.
