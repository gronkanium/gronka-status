# gronka status

status.gronka.dev. A Cloudflare Worker serves the page and stores everything in D1, so the page
stays up when the gronka box does not.

- **The Worker** (`src/worker.js`) checks web.gronka.dev, api.gronka.dev and the cdn itself every
  5 minutes, keeps 90 days of daily uptime, and says so plainly when the box stops reporting.
- **The box** runs `bin/status.js collect` every 2 minutes: bot health, media workers, session
  health and each source's success rate over the last 3 hours. Only counts and states are sent.
- **Incidents** are written with the same script and show up at once:

```
status incident new "what users see" --title "instagram downloads failing" --impact major --affects instagram
status incident update 1 "what changed" --status identified
status incident resolve 1 "what fixed it"
```

`STATUS_URL`, `STATUS_REPORT_TOKEN` and `STATUS_ADMIN_TOKEN` come from the environment. The Worker
reads `REPORT_TOKEN` and `ADMIN_TOKEN` as secrets.

## Run it locally

```
npx wrangler@4 d1 execute gronka-status --local --file schema.sql
printf 'REPORT_TOKEN=dev-report\nADMIN_TOKEN=dev-admin\n' > .dev.vars
npx wrangler@4 dev --local --test-scheduled
curl 'http://127.0.0.1:8787/__scheduled?cron=*/5+*+*+*+*'
STATUS_URL=http://127.0.0.1:8787 STATUS_REPORT_TOKEN=dev-report bun bin/status.js collect
```

## Deploy

```
npx wrangler@4 d1 create gronka-status        # put the id in wrangler.toml
npx wrangler@4 d1 execute gronka-status --remote --file schema.sql
npx wrangler@4 secret put REPORT_TOKEN
npx wrangler@4 secret put ADMIN_TOKEN
npx wrangler@4 deploy
```

Then a systemd user timer on the box runs `bun bin/status.js collect` every 2 minutes.

## License

The code is [MIT](LICENSE). The gronka™ name, logo and penguin (`public/p/`) are trademarks of
gronkanium, artwork all rights reserved: see gronka's
[TRADEMARKS](https://github.com/gronkanium/gronka/blob/master/.github/TRADEMARKS.md).
