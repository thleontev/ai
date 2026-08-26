# Security policy

## Sensitive data

Never open an issue containing API keys, browser cookies, user profiles, raw responses, reports with personal data, or local filesystem paths that expose another person's data. These files are intentionally excluded by `.gitignore`.

## Reporting a vulnerability

Do not publish a security-sensitive report in a public issue. Contact the repository maintainer privately with a minimal reproduction, affected component and version, impact, and a safe way to reproduce the problem. Wait for acknowledgement before public disclosure.

## Scope

The project contains local stdio MCP servers. It does not expose an HTTP service. OAuth/API credentials remain the responsibility of the deploying user and must be supplied through their local environment.
