# Using this report tool when the VPS is down

This is a backup plan. Use it ONLY when the report site says something like
"Cannot reach worker" — meaning the Advin server is down or unreachable.

You do NOT need to touch any code, and you will NOT break anything. This
does not change where the site normally points — it's a temporary,
one-browser-session-only override.

## Step 1 — Start the local worker on your PC

Double-click `start-local-worker.bat` in this project's `worker` folder.

A small black window will open and stay open — leave it open the whole
time you're using the report tool. Closing it stops the local fallback.

You'll know it worked if the window shows a line like:
`kingdomland worker listening on :3003`

If double-clicking doesn't work, open Command Prompt, then type:

```
cd "C:\Users\tubay\Downloads\DevWorks\Kingdomland\kingdomland-daily-report\worker"
node server.js
```

and press Enter. Leave that window open too.

## Step 2 — Point the report site at your PC instead of the VPS

1. Open the report site in your browser like normal.
2. On the sign-in screen, find the **"Worker URL"** field.
3. Clear whatever is in it and type:

   `http://localhost:3003`

4. Sign in like normal (same team password as always).
5. Generate the daily report like normal.

That's it — it'll now run on your own PC instead of the VPS, only for
this browser tab/session.

## Step 3 — Going back to normal

Once the VPS is working again:

1. Just clear the "Worker URL" field back to empty (or refresh the page
   and don't type anything in it) — it'll automatically use the normal
   VPS address again.
2. You can close the black local-worker window on your PC whenever
   you're done — it's not needed once you're back on the VPS.

Nothing was changed anywhere else. The real "Worker URL" the site
normally uses is still set to the VPS in `frontend/config.js` — this
whole process never touches that file.

## Heads up

- Your PC needs to stay awake and that black window needs to stay open
  the whole time you're using the local fallback. If your laptop sleeps
  or you close the window, the local fallback stops working (just
  double-click `start-local-worker.bat` again to restart it).
- This is meant for short-term use while the VPS is down — not a
  permanent replacement for it.

Last set up: 2026-09-08, during a VPS migration/networking outage on
the Advin server (Kansas City move).
