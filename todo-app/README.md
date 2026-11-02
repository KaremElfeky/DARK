# مهامي ✍️

A simple to-do app (PWA) that works on the iPad, phones, and computers.

- **Type** your tasks. If you write the time in the sentence ("اتصل بماما بكرة ٥م"), the app picks it up and sets the date for you.
- **Write with the Apple Pencil** on a lined notebook page. Each line becomes a task, and you review the text before it's added.
- **Overdue tasks**: for each one you can mark it done, postpone it (an hour, tomorrow, next week, or any time you pick), or delete it. You can also postpone or delete all of them at once.
- **Notifications** a day before and an hour before every task. You can also add one at the task time itself.
- Works **offline**, has a dark mode, and lets you export tasks to the calendar or take a backup.

## Running it

```bash
cd todo-app
npm install
npm start          # http://localhost:8080
npm test           # parser tests + full push server test
```

## Deploying for free on Vercel

1. On [vercel.com](https://vercel.com): **Add New → Project** → choose the `DARK` repository.
   - Set **Root Directory** = `todo-app`, choose the `todo-app` branch, and leave Framework set to `Other`.
2. Under **Environment Variables**, add `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT`.
3. After the deploy: **Storage → Marketplace → Upstash (Redis)** → Create → Connect to the project.
   - This adds `KV_REST_API_URL` / `KV_REST_API_TOKEN` automatically. Then run **Redeploy**.
4. On [cron-job.org](https://cron-job.org), create a job that calls `https://your-site.vercel.app/api/tick` **every minute**.
   - This is what sends notifications (and emails) on time.
5. **Email reminders (optional):** add these env vars, then Redeploy:
   - `SMTP_USER` = the Gmail address that sends the mail, `SMTP_PASS` = a Gmail **App password**
     (Google Account → Security → 2-Step Verification → App passwords).
   - `ALERT_EMAILS` = the addresses allowed to receive reminders (comma-separated; defaults to `SMTP_USER`).
   - `APP_URL` = your site's URL (used for the button in the email).
   - Then in the app: Settings → «تنبيه على الإيميل» → type your email → «ابعت إيميل تجربة».

## Deploying on a regular server (Render / Docker / VPS)

The app has to be deployed **over HTTPS** with `server.js` running all the time:

1. Generate the keys once: `npx web-push generate-vapid-keys`
2. On any Node host (Render, Railway, Fly, a VPS, or Docker using the included `Dockerfile`), set:
   - `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`
   - `VAPID_SUBJECT=mailto:your-email@domain.com`
   - `DATA_DIR` → a path on a **persistent disk** (subscriptions and reminders are stored there)
3. If your host's free tier sleeps: set up a free job on [cron-job.org](https://cron-job.org) that calls `https://your-site/api/tick` every minute. It wakes the server up and sends any due notifications.

> If you want the website on a separate host (GitHub Pages, for example), put the server's URL in `public/js/config.js`.

### On the iPad / iPhone
Notifications on iOS only work after the app is installed: open the site in Safari → **Share** → **Add to Home Screen** → open the app from the icon → turn on notifications. This needs iPadOS 16.4 or later.

## How it works

| Part | File |
|---|---|
| UI and logic | `public/js/app.js` |
| Date parsing (Egyptian Arabic and English) | `public/js/dates.js` |
| Pencil handwriting + line detection + recognition | `public/js/ink.js` |
| Notifications (push + local fallback) | `public/js/notify.js`, `public/sw.js` |
| Server: hosting + push sending + scheduling | `server.js` |

- **Handwriting recognition** uses Google's handwriting engine (the one behind Google Input Tools), which supports Arabic and English. It needs an internet connection, and your writing stays saved if the connection drops. The server also acts as a backup proxy for it.
- **Tasks are saved on the device and on the server** (Upstash Redis on Vercel, `DATA_DIR/db.json` with `server.js`).
  Every device has a **sync code** in Settings → «بياناتك». Type the same code on another device to get the same tasks there.
  The server sends the reminders (push + email) from these saved tasks, so they arrive even when the app is closed.
- Reminders: a day before, an hour before, and **at the task time** (all on by default; change them in Settings).
  A reminder isn't sent if the task was added after that reminder's time (e.g. a task due in 20 minutes only gets the "at the time" one).
- If the server isn't available, notifications only work while the app is open. Calendar export (`.ics` with both reminders) is a backup that always works.
