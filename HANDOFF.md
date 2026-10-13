# HANDOFF — Article Platform + recipe sites

> **للعربية (لخالد):** أعطِ هذا الملف لـ Claude في الحساب الجديد في أول رسالة، بعد ربط GitHub بالحساب
> (المستودعان أدناه). يحتوي كل ما يحتاجه لمواصلة العمل من حيث توقفنا.

You are continuing work for **Khaled** on his content-automation system. Read this whole file before doing anything.

## How Khaled works (important)
- Reply in **Arabic when he writes Arabic**, English otherwise. Short replies, **one step at a time**, answer only what was asked.
- **Propose / validate before implementing** anything non-trivial; implement right away when he says "نعم" / "نفذ".
- He deploys himself on **Dokploy** (VPS at Contabo, sites behind **Cloudflare**). You push to GitHub; he redeploys.
- Content rules: **halal only** (no alcohol, no pork; "wine vinegar" is fine). Site: light theme, dark only via toggle.
- He tests in production and sends screenshots; read them carefully (often full-page PNG/JPG — crop to read).

## Repositories (GitHub account `garrettedward748-cmyk`)
1. **`dailyfoodpins-generator`** — the "Article Platform": Node 22 + TypeScript, Fastify web UI, `node:sqlite`, vitest.
   - `services/imagegen/` — Python image/video service: headless Chrome + a Chrome extension driving **Google Flow** (images + reels/videos). Has its own Dockerfile; the extension is packed at build time.
   - `PLATFORM-GUIDE.md` — user guide in Arabic, kept up to date with every feature.
2. **`dailyfoodpins`** — the recipe **website** (plain PHP 8 + MariaDB, Docker). The same code runs every site:
   dailyfoodpins.com, arbmom.com, cookingarab.com, sparkjab.com (new). `NEW-SITE.md` explains a new site.

Commit messages end with a `Co-Authored-By` line. Run `npx tsc --noEmit -p .` and `npx vitest run` (867 tests, all green) before pushing the platform; `php -l` for the site.

## Architecture in one breath
Platform picks a keyword → writes the recipe with LLMs (Ollama-compatible endpoint, prompts in `prompts/*.txt`, editable in Setup → Prompts) → generates images in Flow (imagegen) → publishes to the site through the site's API (`/api/*`, token auth) → distributes through **Buffer** (Pinterest pin, Facebook post, Instagram post) → makes a **reel** in Flow and schedules it (Facebook, Pinterest video pin, Instagram) via Buffer.
Every pipeline step is checkpointed in `run_steps` (resume reuses completed steps). Migrations: `src/db/migrations.ts` (latest **029-channel-profiles**).

## Main areas of the platform UI (top nav)
Home · **Content** (Articles, Keywords, Research, Blog, Reels — with an "All sites / site" filter) · **Channels** (Sites, **Accounts**) · **Search Console** · **Taxonomy** · Activity · Setup.

## Recent work (newest first) — all pushed; Khaled may not have deployed everything yet
- **Social-only accounts**: a site added with a blank Domain is stored under a handle from its name (no dot = social only, `core/social-only.ts`). Runs write the recipe and images but skip the article (`skipArticleStep`, recorded as `post-article`), and every post goes out without a link. Its media is served by the platform at public `/media/*` (`integrations/media-store.ts`, `SocialOnlySiteApi` via `siteApiFor`), needs Setup → General → `public_url`, re-encoded JPEG 85, deleted after `media_keep_days` (7) by an hourly cleanup. Writing a real domain later turns it into a normal site.
- **Channels → Accounts** (migration 029): per site, several accounts per network (Pinterest 1/2/…, Facebook, Instagram) in `channel_profiles`; each has channel name, boards (Pinterest), its own Buffer tokens (`buffer_accounts.profile_id`). Articles go to a site's accounts **in turn** (`pickProfile` by `turn`), a run keeps its accounts (`runs.profiles_json`, `runProfile`) for resume and its reel. UI: one site at a time, each network a collapsible card with a real status line (`channelStates` in server.ts). Facebook pages (niche → page, posts/reels, auto-publish) and Instagram link setting live inside their cards. Future networks (e.g. **YouTube Shorts via Buffer**) must follow the same structure.
- **Reels**: one-shot Flow videos are re-encoded (`normalizeForSocial`, 1080×1920/30fps, no C2PA box) before Buffer — fixed "Facebook was unable to process the media" and green/purple glitches. "Send again" on published reels. CTA read from a text file (apostrophe bug).
- **imagegen**: ported upstream flowkit fixes for `PUBLIC_ERROR_UNUSUAL_ACTIVITY`: extension 0.5.0 with `hijack_bypass.js`, MZZa6b (ingredients reel) request in the current UI shape. After that, reels generated again.
- **Retry the Pinterest pin** button on a published run whose Pinterest steps failed.
- **Facebook post** shows the Pinterest graphic whole on 4:5 with blurred sides.
- **Taxonomy** section: fills empty category/cuisine/tag fields (prompt `taxonomy-fill`) + Flow pictures for categories/cuisines; tags only from 3 recipes; site noindexes tags < 3 recipes and categories/cuisines with no text.
- **Site speed** (arbmom mobile 58 → 87): thumbnails `/image/s/{w}/...` (cached under `storage/thumbs` or `.w{w}` beside the original), inline CSS, non-blocking Google Fonts, AdSense/GA delayed to first interaction (Admin → Ads switch).
- **Search Console** (phase 1): service-account key, daily fetch, opportunities → Keywords / Blog. Downloadable Arabic setup guide was delivered.
- Earlier: Instagram, pin designs, research topics, queue check, recipe tools box (Amazon), noindex switches, AI legal pages, blog, process reels, auto-retry, etc. (see git log and PLATFORM-GUIDE.md).

## Open / postponed (do not start without Khaled)
- **Search Console phase 2**: improve existing pages / rewrite weak titles — needs a site endpoint `/api/recipe/update`.
- **Home-IP option for Flow** (route the imagegen Chrome through a home device via Tailscale + proxy, with a Server/Home/Auto switch) — postponed by Khaled.
- **Amazon Associates** — postponed (account was locked for verification).
- **YouTube** as a network — Khaled will ask; build it like the other networks in Accounts.
- Verify after deploy: reels publish cleanly to Facebook; Accounts migration moved existing settings to "account 1"; sparkjab.com storage volume must be unique (it was sharing cookingarab's Docker volume — told Khaled to rename it `sparkjab-storage`).

## Useful facts
- Flow / Google can return `UNUSUAL_ACTIVITY`; accounts rotate (`services/imagegen/agent/accounts.py`). Upstream reference: `github.com/crisng95/flowkit` (public).
- Buffer free plan: 10 queued posts per channel; tokens rotate on "queue full".
- Site admin password reset: `docker exec -it <site-container> php /var/www/html/tools/create-admin.php admin 'NewPass12chars+' admin` (the container with PHP, not the DB one).
