# Cellar Price Watch (v9, all on Vercel)

One Vercel project now serves both the app and its API. No Railway.

```
index.html          the app (unchanged features, now calls /api on the same site)
api/prices.js       POST: supermarket prices via Apify (studio-amba~trolley-scraper)
api/wine-list.js    GET:  this month's picks from Luke Flunder's list
api/health.js       GET:  setup check
api/test.js         GET:  troubleshooting, ?link=<Trolley product link or code>
lib/                shared code (matching, price context, storage, list parser)
```

## Deploy

1. **Replace the files in the GitHub repo your Vercel app deploys from.**
   Upload `index.html`, `api/`, `lib/`, `package.json`, `vercel.json` to the repo root
   (GitHub: Add file → Upload files, drag them in, Commit). Keep it in the **same**
   Vercel project, so the address stays the same and your saved wines carry over.

2. **Storage (done).** A private Vercel Blob store, `cellar-price-watch`, is connected
   to the project and provides `BLOB_READ_WRITE_TOKEN`. (Upstash Redis also works if you
   ever prefer it: the code uses whichever is connected, Blob first.)

3. **Add your Apify token.** Vercel → Settings → Environment Variables →
   `APIFY_TOKEN` = your token from Apify (Settings → API & Integrations).
   Paste it there only, not in chat.

4. **Redeploy** so the new variables take effect: Deployments → ⋯ on the latest → Redeploy.

5. **Check** `https://wine-app-front-end.vercel.app/api/health`. You want:
   `{"status":"ok","apifyTokenSet":true,"storage":"blob"}`.
   `"storage":"memory"` means no storage is connected; prices still work
   but history won't be kept.

6. Open the app. The header should read **v9**. Tap Check prices.

## How prices work

Trolley.co.uk's robots.txt asks bots not to use its search, so the app doesn't search.
Each wine is linked to its Trolley product page once: the card shows "Find on Trolley",
you pick the right bottle in your browser, Share → Copy, paste, Save. The link is kept
on the server and on your phone. From then on, Check prices runs one batched scraper
job over all your linked wines.

## Running costs

- Vercel Hobby (functions + Blob storage): £0 at this usage.
- Apify: about $1.20 per 1,000 product checks, so roughly 0.1p per wine per check.
  20 wines checked weekly is around 10 cents a month, well inside Apify's free $5 monthly credit.
  Prices are reused for 24 hours, so tapping Check prices repeatedly costs nothing extra.

## Notes

- Price history is kept permanently (about a year of checks per wine), so the
  "Lowest seen yet / Higher than usual" badges build up from your own checks.
  Changing a wine's Trolley link starts its history afresh.
- Your wine list itself lives in your phone's browser storage; Trolley links are also
  saved on the server, so they come back if you check from another device.
