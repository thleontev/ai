# Security policy

## Credentials

Never commit API keys, OAuth secrets, access keys, browser cookies, `.env` files, OpenCode user profiles, or populated SQLite databases. Use [`.env.example`](.env.example) only as a variable-name reference.

If a credential is exposed, revoke or rotate it at the provider first, then remove it from Git history before publishing.

## Supplier access

Use official supplier APIs under their applicable terms. The public-page integrations are not official APIs and require the supplier's written permission for automated access. Do not bypass CAPTCHAs, rate limits, authentication, or access controls.

## Reporting a vulnerability

Do not publish exploitable details in a public issue. Contact the repository owner privately and include reproduction steps, impact, and the affected version.
