# AVELON Wealth (static web + Firebase + Netlify)

Mobile-first HTML/CSS/vanilla JS shell with Firebase Auth + Firestore listeners, PayMongo server hooks on Netlify, TradingView embeds, CoinGecko pricing, referral-only registration, admin console, and a minimal PWA install path.

## Critical security note

If a **Firebase service account private key** or **PayMongo webhook secret** was pasted into a chat, issue, or client bundle: **revoke/rotate those credentials immediately** in Google Cloud + PayMongo, then store replacements only as Netlify environment variables (`FIREBASE_SERVICE_ACCOUNT_JSON`, `PAYMONGO_WEBHOOK_SECRET`, `PAYMONGO_SECRET_KEY`). Never commit secrets to git.

## Local preview (VSCode + Live Server)

The deployable static site lives in `public/`. Open `public/index.html` with Live Server, or set Live Server’s root to the `public` folder so paths match production. Firebase + PayMongo features that call `/.netlify/functions/*` require Netlify Dev or a deployed Netlify site.

### Bottom navigation (single source)

All app shells use `public/js/nav-system.js`, which injects one shared **HOME · MARKETS · FEATURES · ASSETS · PROFILE** bar from `#bottom-nav-slot`:

- **`data-nav-mode="spa"`** (`dashboard.html`): in-page tabs + hash + Firebase prefs.
- **`data-nav-mode="gateway"`** (`login.html`, `register.html`): same tabs on the auth screens; if already signed in, taps jump to `dashboard.html#tab`.
- **`data-nav-mode="external"`** (`admin.html`): taps open the user app at `dashboard.html#tab` (operators return to the main shell).

### Optional subpath (e.g. GitHub Pages project site)

Set on every HTML page: `<meta name="avelon-base" content="/your-repo-name">` (no trailing slash). `public/js/avelon-path.js` rewrites same-origin relative links and redirects. Leave empty for Netlify apex or `www` deploys.

## Deploy (GitHub → Netlify)

Suggested remote: `https://github.com/avelonwealth-web/avelon-web.git`

1. Push this repo to GitHub (root contains `netlify.toml` and `public/`).
2. In Netlify: **New site from Git** → pick the repo → leave base directory empty; `publish = "public"` and `functions = "netlify/functions"` are read from `netlify.toml` (avoid overriding publish to `.` in the UI).
3. Set environment variables from `.env.example`.
4. Deploy Firestore rules (`firestore.rules`) with Firebase CLI or console.

## Bootstrap checklist (first run)

**Operators use `login.html` only** (mobile + password). They are **not** created through `register.html` (referral gate is for members).

1. In **Firebase Authentication → Users → Add user** (Email/Password provider):
   - **Email** (internal / synthetic): `639152444480@phone.avelon-wealth.local`  
     (this is the normalized form of mobile **`09152444480`** — same mapping the app uses).
   - **Password**: `Matt@5494@`  
     _(Rotate this in production after first login; do not reuse defaults publicly.)_
2. Copy the new user’s **UID**. In **Firestore**, create `users/{uid}` with at least:
   - `role: "admin"`
   - `displayName` (e.g. `AVELON Admin`)
   - `email`: `639152444480@phone.avelon-wealth.local` (match Auth)
   - `mobileNumber`: `09152444480`
   - `referralCode`: operator bootstrap code is fixed as `ADMIN001`; end-users get unique 6-char codes at registration
   - `balance`, `totalDeposits`, `vipLevel`, `downlineCount`, etc. as needed
3. Create **`referralLookup/{referralCode}`** with document `{ "uid": "<adminUid>" }` using the same `referralCode` as in step 2 so referrals resolve.

**Login test:** open `login.html`, enter mobile as **`09152444480`**, **`+639152444480`**, or **`9152444480`**, password **`Matt@5494@`** — all normalize to the same account.

**If login fails on Live Server (`127.0.0.1:5500`):** Firebase Console → Authentication → **Settings** → **Authorized domains** → add **`127.0.0.1`** and **`localhost`**. Also confirm **Sign-in method → Email/Password** is **Enabled**.

## © 2022 Avelon Wealth
