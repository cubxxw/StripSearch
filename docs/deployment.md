# Hosted Web alpha

The public homepage and authenticated workspace are one Express application. Deploy one Node process behind Nginx HTTPS on a Linux host, with persistent SQLite. Vercel is optional for a future separate marketing site; do not put the current SQLite database or in-process jobs in a stateless function.

This deployment does not complete the research-controller, CLI, MCP or benchmark milestones. Exa availability is distinct from research quality. The existing homepage is the released website; unmerged design prototypes are not a production application.

## Runtime contract

- Node 22.23.2, locked npm dependencies; build from an exact Git revision using the root `Dockerfile`.
- `deploy/compose.yml` uses Linux host networking so the non-root process still listens only at `127.0.0.1:4392`. Nginx is the public endpoint; do not expose this port through the firewall.
- `/var/lib/stripsearch` holds SQLite and the generated `auth-secret`, outside release images. Keep it private and persistent. The runtime container is read-only except this directory and a bounded temporary filesystem.
- Hosted mode accepts exactly one configured HTTPS origin and uses Secure, HttpOnly session cookies. Nginx must overwrite forwarded IP/host/protocol headers, preserve the actual browser Origin, and disable response buffering for SSE.
- Registration is an operator-controlled bootstrap operation. An email allowlist is **not email ownership verification**. Before making the site public, create the owner's account through a loopback-only connection, then empty `STRIPSEARCH_SIGNUP_EMAILS` and restart. Existing accounts can log in; email delivery, verification and password recovery are not configured.
- Provider keys stay in `/etc/stripsearch/runtime.env` (`0600`, root-owned), never in Git, image layers, browser output, health responses or deployment receipts. Exa is optional; do not reuse an unrelated GitHub account token.

## First deployment

1. Point a hostname at the server. Preserve existing sites, firewall rules and certificate renewal. Add a hostname-specific HTTP ACME challenge location at `/var/www/acme`, obtain its trusted certificate, then render `deploy/nginx.conf.template` with that hostname. Run `nginx -t` before reload. Never replace the server's whole Nginx configuration.
2. Create `/etc/stripsearch/runtime.env` with the following server-only settings. Add optional `EXA_API_KEY` using the authorized secret manager, without logging its value.

   ```dotenv
   NODE_ENV=production
   PORT=4392
   STRIPSEARCH_HOST=127.0.0.1
   STRIPSEARCH_DEPLOYMENT=hosted
   STRIPSEARCH_PUBLIC_ORIGIN=https://YOUR_HOSTNAME
   STRIPSEARCH_DATA_DIR=/var/lib/stripsearch
   STRIPSEARCH_SIGNUP_EMAILS=
   ```

3. Transfer only `git archive <full-commit-sha>` into `/opt/stripsearch/releases/<full-commit-sha>`, then run `bash deploy/release.sh <full-commit-sha>` there as root. It builds the image, snapshots existing data, deploys it, checks container health and the served revision, and enables the backup timer. Bootstrap an owner privately before enabling the public HTTPS virtual host.
4. Verify the public HTTPS homepage and assets, `/api/health`, `/release.json`, authentication, Origin rejection, research/SSE, source revision/export and logout. Restart this project's container and prove a saved account/report survives. Repeat release verification after merging so the deployed SHA equals `origin/main`.

The release script rolls back the image if startup or served-revision verification fails. It does not reverse schema changes. Review future migrations for rollback compatibility before deployment. Keep the previous source/image and pre-upgrade backup until acceptance passes.

## Backup and recovery

`stripsearch-backup.timer` takes a consistent SQLite online backup daily, checks integrity, and includes the file-based auth secret. Only this application's completed snapshots older than 14 days are pruned. Backups are under `/var/backups/stripsearch`; they protect against application mistakes, not host loss. Configure off-host copies separately before making durability guarantees.

Run `systemctl start stripsearch-backup.service` and inspect its result. To restore, stop only the `stripsearch` Compose project, preserve the current data directory for rollback, copy a verified snapshot's database and auth secret into a clean data directory, set owner `1000:1000` and private permissions, then restart and verify login/report readback. Never copy a live SQLite database with plain `cp` or restore over leftover WAL files. Preserve separately supplied auth secrets if `BETTER_AUTH_SECRET` was used.

Certificate renewal belongs to the host. Confirm the timer covers this hostname and reloads Nginx after renewal; do not create competing Certbot jobs sharing the same certificate store.

## Official configuration sources

- [Better Auth options](https://better-auth.com/docs/reference/options) and [cookie policy](https://better-auth.com/docs/concepts/cookies): fixed base URL, trusted origins and secure sessions.
- [Nginx proxy headers](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_set_header) and [response buffering](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_buffering): overwritten proxy metadata and immediate SSE delivery.
- [Docker host networking](https://docs.docker.com/engine/network/drivers/host/): Linux loopback topology.
- [SQLite online backup](https://www.sqlite.org/backup.html): consistent backup while the application runs.
