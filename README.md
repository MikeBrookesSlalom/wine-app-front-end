# Cellar Price Watch (v8, all on Vercel)

One Vercel project now serves both the app and its API. No Railway.

```
index.html          the app (unchanged features, now calls /api on the same site)
api/prices.js       POST: live supermarket prices via Apify/Trolley
api/wine-list.js    GET:  this month's picks from Luke Flunder's list
api/health.js       GET:  setup check
api/test.js         GET:  troubleshooting, ?wine=Name (&debug=1)
lib/                shared code (matching, price context, storage, list parser)
```

## Deploy

1. **Replace the files in the GitHub repo your Vercel app deploys from.**
   Upload `index.html`, `api/`, `lib/`, `package.json`, `vercel.json` to the repo root
   (GitHub: Add file → Upload files, drag them in, Commit). Keep it in the **same**
   Vercel project, so the address stays the same and your saved wines carry over.

2. **Add the free database.** Vercel → your project → Storage → Create database →
   Upstash for Redis → Free plan → connect it to this project (all environments).
   This adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically.

3. **Add your Apify token.** Vercel → Settings → Environment Variables →
   `APIFY_TOKEN` = your token from Apify (Settings → API & Integrations).
   Paste it there only, not in chat.

4. **Redeploy** so the new variables take effect: Deployments → ⋯ on the latest → Redeploy.

5. **Check** `https://wine-app-front-end.vercel.app/api/health`. You want:
   `{"status":"ok","apifyTokenSet":true,"storage":"upstash"}`.
   `"storage":"memory"` means the database isn't connected yet; prices still work
   but history won't be kept.

6. Open the app. The header should read **v8**. Tap Check prices.

## Running costs

- Vercel Hobby and Upstash free plan: £0 at this usage.
- Apify (Trolley scraper): roughly 6p the first time a wine is added (one search),
  then about half a penny per wine per price check. Prices are reused for 24 hours,
  so tapping Check prices repeatedly costs nothing extra.

## Notes

- Price history is now kept permanently (about a year of checks per wine), so the
  "Lowest seen yet / Higher than usual" badges build up from your own checks.
- Wines Trolley doesn't list are remembered as "not found" for a week, so they
  aren't searched (and paid for) on every check.
- Your wine list itself still lives in your phone's browser storage, not on the server.
