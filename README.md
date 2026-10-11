# Cellar Price Watch (v9, all on Vercel)

One Vercel project now serves both the app and its API. No Railway.

```
index.html          the app (unchanged features, now calls /api on the same site)
api/prices.js       POST: supermarket prices read from Trolley.co.uk product pages
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

3. **No API keys needed.** Prices are read straight from Trolley product pages.
   (`APIFY_TOKEN` is no longer used and can be deleted.)

4. **Redeploy** so the new variables take effect: Deployments → ⋯ on the latest → Redeploy.

5. **Check** `https://wine-app-front-end.vercel.app/api/health`. You want:
   `"status":"ok"` and `"storage":"blob"`.
   `"storage":"memory"` means no storage is connected; prices still work
   but history won't be kept.

6. Open the app. The header should read **v9**. Tap Check prices.

## How prices work

Trolley.co.uk's robots.txt allows product pages but asks bots not to use its search, so
the app never searches. Each wine is linked to its Trolley product page once: the card
shows "Find on Trolley", you pick the right bottle in your browser, Share → Copy, paste,
Save. The link is kept on the server and on your phone. From then on, Check prices reads
those product pages (3 at a time, at most once a day per wine) and pulls out each shop's
price and offer. If a wine is out of stock everywhere, Trolley's suggested listings are
offered as a one-tap swap.

## Running costs

- £0. Vercel Hobby (functions + Blob storage) covers it, and no scraping service is used.

## Notes

- Price history is kept permanently (about a year of checks per wine), so the
  "Lowest seen yet / Higher than usual" badges build up from your own checks.
  Changing a wine's Trolley link starts its history afresh.
- Your wine list itself lives in your phone's browser storage; Trolley links are also
  saved on the server, so they come back if you check from another device.
