# quickfastpdf.com

The Quick Fast PDF website, built with [Astro](https://astro.build) as a plain static site.

- `src/site.ts`: email, download links, feedback endpoint, founder details
  (the founder card on the contact page appears once `FOUNDER.name` is filled in).
- `src/pages/index.astro`: home (hero, speed, features, screenshots, download).
- `src/pages/contact.astro`: contact details and the "Request a feature" form, which posts to
  the same feedback function as the app (`feedback-api/`), emailing pdf@usframefactory.com.
- `public/img`: screenshots of the app, taken with a made-up sample drawing set.

The download buttons always point at the latest GitHub release, so the site doesn't need a
redeploy for new app versions.

```sh
cd site
npm install
npm run dev      # http://localhost:4321
npm run build    # static files in dist/
```

## Deploy on Vercel

1. Vercel → Add New → Project → import this repo. Root Directory: `site` (framework is detected
   as Astro). Deploy.
2. Project → Settings → Domains → add `quickfastpdf.com` (and `www.quickfastpdf.com`, redirecting
   to it). Vercel shows the DNS records to add at the domain registrar.
