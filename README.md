# Whatsappy

A small Node.js bot for one AI/ML quiz each week in three WhatsApp groups. Hosted on an Android phone with Termux; no paid server is needed.

- **Tuesday 08:00 IST:** the same native single-choice poll in all three groups.
- **Wednesday 08:00 IST:** the saved correct answer and explanation.
- **Every question requires your review and approval.** Gemini can prepare drafts ahead of time.
- Difficulty follows a 12-week curriculum, then revisits topics with increasingly advanced reasoning. Human review checks actual difficulty and correctness.
- SQLite stores questions and separate delivery jobs for each group. Interrupted sends are held for manual reconciliation rather than blindly retried.

**Current status:** locally tested implementation; real Gemini/WhatsApp calls and Realme background operation still need on-device validation. Sending is disabled by default. The Baileys version is pinned to `7.0.0-rc14`, a release candidate, and may need compatibility fixes as WhatsApp changes. This is unofficial WhatsApp automation and can result in account restrictions.

## 1. Install on the Realme

Target: Realme 6, Android 11, 6 GB RAM. No root required. Keep the project inside Termux's private home directory, not shared Android storage. Verify that Termux and Termux:Boot come from compatible sources; see [Termux installation guidance](https://github.com/termux/termux-app).

In Termux:

```sh
pkg install git
cd "$HOME"
git clone https://github.com/AvikSrivastava10/whatsappy.git
cd whatsappy
bash scripts/termux-setup.sh
```

The script installs Node.js and Termux services, installs pinned npm dependencies, runs offline tests, and creates ignored local settings. It does not link WhatsApp or start sending. Node **22.16 or newer**, with `node:sqlite`, is required. SQLite may emit an experimental warning on Node 22; test actual support with `doctor`. Do not copy Windows `node_modules` to the phone.

## 2. Configure locally

Edit `config.json` using a text editor in Termux (install one if needed). Set:

| Setting | Meaning |
| --- | --- |
| `firstTuesday` | First publishing date, `YYYY-MM-DD`; must be a Tuesday |
| `groups` | Three distinct group IDs obtained in step 3 |
| `liveEnabled` | Leave `false` until ready to send |
| `testMode` | `false` for three real groups; `true` permits exactly one private test group |
| `autoGenerate` | Prepare draft questions in the background; never auto-approve |
| `language` | Defaults to English |
| `pollGraceMinutes` | Default 120: polls missed after Tuesday 10:00 IST are skipped |
| `answerGraceMinutes` | Default 1440: answers may catch up until Thursday 08:00 IST |
| `generationLeadDays` | Default 3: prepare upcoming draft from Saturday 08:00 IST |
| `geminiModel` | A currently available Gemini model with a free API tier; no model is silently selected |
| `runtimeDir` | Default `runtime`; keep it private and out of Git |

These retry windows are configurable defaults. Difficulty follows calendar weeks; skipped weeks still advance the curriculum. A late Tuesday poll does **not** shift the fixed Wednesday answer time.

Put your key in the local `.env` file as `GEMINI_API_KEY=...`. Do not paste it into Git or screenshots. Check [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing) and [your API limits](https://ai.google.dev/gemini-api/docs/rate-limits). Keep billing disabled for a free-only setup; the application cannot determine whether your Google account has billing enabled.

```sh
npm run bot -- doctor
```

`config.json`, `.env`, `runtime/`, and `docs/` are excluded from Git. If you choose a different runtime directory, add it to `.gitignore` before using it. Configuration is read at process start: restart the service after edits.

## 3. Link your WhatsApp account

Stop any running service before linking or listing groups:

```sh
sv down whatsappy  # only if the service is already installed/running
npm run bot -- link
```

Scan the QR from your main WhatsApp application's **Linked devices → Link a device** screen. If WhatsApp and Termux are on the same phone, use a pairing code instead:

```sh
npm run bot -- link YOUR_NUMBER_WITH_COUNTRY_CODE
```

Replace the placeholder with digits only, without `+`. In WhatsApp's link-device flow, choose the phone-number linking option when available and enter the displayed code. If that option is unavailable, display the QR securely on another screen. Never share the pairing code or session files. Linking does not send messages.

```sh
npm run bot -- groups
```

Copy exactly the three intended IDs into `config.json`. Group names are shown locally to help selection; the bot sends only to configured IDs. Do not run two copies with the same session. Stop the service before running `groups` again.

## 4. Generate, review, and approve

```sh
npm run bot -- generate 1
npm run bot -- preview 1
```

Read the complete question, all four options, correct answer, and explanation. Verify the facts and that only one option is correct. To revise a draft, put the corrected JSON in a private local file (for example under `runtime/`) and run `import` on that file. The format is shown in `examples/question.json`.

```sh
npm run bot -- import runtime/revised-question.json
npm run bot -- preview 1
npm run bot -- approve 1
```

Importing resets approval. Once scheduled, content is frozen to keep the answer consistent with the poll. For a correction after scheduling, pause the bot and reconcile the release manually; there is deliberately no silent edit of an already published quiz.

For an entirely offline demonstration, import `examples/question.json`, then preview it. Do not approve a demonstration question for real groups unless you intend to publish it.

Automatic generation saves drafts up to three days before the release. A failed automatic generation attempt waits six hours before retrying to limit quota use. **You still need to preview and approve each week.** With no approved question there is no send. There is no external approval reminder yet; use `status` and a personal reminder to review before Tuesday.

## 5. Run and install the background service

First run in the foreground with `liveEnabled=false`:

```sh
npm start
```

Dry-run mode creates eligible local job records and may generate Gemini drafts if configured, but never connects to WhatsApp or sends messages. Ctrl+C stops it. For an offline run, set `autoGenerate=false` as well.

Install [Termux:Boot](https://github.com/termux/termux-boot) from a source compatible with your Termux installation and open it once. Then:

```sh
bash scripts/install-termux-service.sh
```

The installer refuses to overwrite an existing service and leaves the new service disabled. Restart the Termux shell, then:

```sh
termux-wake-lock
sv-enable whatsappy
sv status whatsappy
```

Logs rotate at approximately 1 MB, retaining five old logs:

```sh
tail -n 30 "$PREFIX/var/log/sv/whatsappy/current"
npm run bot -- status
```

In Android/Realme settings, allow Termux background activity and disable battery optimization for it; allow boot activity where available. Test a locked screen overnight, a network interruption, and reboot followed by first unlock. Android may still stop the entire Termux environment; runit cannot recover from that until Termux starts again. Keep reliable network access and power.

**Launch:** after reviewing content, verifying IDs/start date, and testing the device, stop the service, set `liveEnabled=true`, and restart it. Enabling live mode is the point at which scheduled sends become possible. Pause before changing configuration. Production requires exactly three groups.

For a private test, use `testMode=true`, one test-group ID, and a separate `runtimeDir`. The normal Tuesday/Wednesday schedule still applies. Use a separate ignored configuration selected with `WHATSAPPY_CONFIG` when running test commands. Never reuse test jobs as production jobs or delete the delivery database to reset a live release.

## Operations and recovery

```sh
npm run bot -- pause
npm run bot -- resume
npm run bot -- backup
sv down whatsappy
sv-disable whatsappy
```

Pause blocks new sends and generation; an already in-flight send can still finish. `sv-disable` also prevents startup at the next reboot. The wake lock can be released with `termux-wake-unlock` once the service is stopped.

Backups are consistent SQLite snapshots under `runtime/backups`. They do not include account credentials or configuration. Keep any copies private. Restoring an older database can replay jobs: stop the service and reconcile messages sent after the snapshot before resuming.

| Status/error | Action |
| --- | --- |
| No approved draft | Generate/import, preview, approve before the deadline |
| `relink_required` | Stop service, run `link`, then restart; protect existing session files |
| `disconnected_retrying` | Check network; connection retries back off automatically |
| `unknown` job | Inspect the actual group before deciding whether to retry |
| `skipped` job | Deadline passed or the group's poll was skipped; answer is not sent |
| Schedule configuration changed | Do not delete the database; reconcile existing jobs before changing its bound date/groups/windows |
| Service running but stale connection timestamp | Check process logs; status is the last event, not an independent uptime monitor |

For an unknown job, after checking the group:

```sh
npm run bot -- resolve JOB_ID sent CONFIRMED_MESSAGE_ID
npm run bot -- resolve JOB_ID retry
npm run bot -- resolve JOB_ID skip
```

Choose **one** action. Retrying can duplicate a message if it was already sent. The remote send and local database update cannot be one atomic transaction; exactly-once delivery is not guaranteed. `sent` means the adapter returned a message reference, not that every member received or read it. An answer is eligible only after the same group's poll is confirmed sent.

## Updating and testing

```sh
sv down whatsappy
git pull --ff-only
npm ci --omit=dev
npm test
npm run bot -- doctor
sv up whatsappy
```

Offline tests cover timezone calculations, persistence/restart, concurrent claims, malformed Gemini output, quota backoff, immutable approved releases, and partial/uncertain delivery. They do not establish Android uptime or real API compatibility. The dependencies and lockfile are pinned; review updates before applying them to the phone.

Learning/planning notes remain local in `docs/` and are intentionally not published. Operational instructions are in this README so a fresh phone checkout is usable.
