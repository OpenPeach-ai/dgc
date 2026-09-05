---
title: Privacy
description: What DGC stores locally, what reaches a chosen provider, and what the website processes.
effective_date: 2026-09-05
---

# Privacy

This notice covers the DGC command-line tool and editor extension, the vibedgc.com website, and the release-note subscription form served from that site.

## DGC on your machine

DGC stores configuration, owner-restricted credentials, sessions, plans, goals, checkpoints, and related local state under its user data directory. The editor keeps credentials it manages in VS Code SecretStorage. Project instructions and project-scoped skills may also live in the repository you open. This data is used to operate the agent, resume work, and support local recovery.

DGC does not send product-usage telemetry. An interactive CLI launch may make a small request to `vibedgc.com/version.json` to learn whether a newer release exists. A successful check is cached for a day; after a failed request, a later interactive launch may retry. The request sends the ordinary network metadata needed for HTTP and a `dgc-update-check` user-agent; it does not include prompts, source code, session content, tool arguments, or credentials. One-shot `dgc -p` runs skip this check. The self-hosted editor VSIX separately checks `vibedgc.com/vscode/version.json` at most once a day by default with a `dgc-vscode` user-agent. Marketplace and Open VSX builds skip that request, and `dgc.checkForUpdates` can disable it.

The coding loop sends context only to services you choose to use. A model endpoint receives the prompts, selected project context, and tool results needed for the conversation. A local endpoint can keep that traffic on infrastructure you control; a cloud API or subscription provider processes it under that provider’s terms. Optional web search, fetched pages, MCP servers, and other configured integrations receive the requests or tool arguments you direct to them. A configured language server receives workspace metadata and the full text of documents queried through code intelligence.

Training export is initiated by you and writes to a path you choose. DGC removes reasoning traces and provider continuation data, then deep-scrubs configured secrets and high-confidence credential patterns before writing portable JSONL. DGC does not upload that export.

## The website

The site is delivered through Cloudflare. Cloudflare necessarily processes request information such as IP address, user agent, requested path, timestamps, and security signals to serve and protect the site. Where Cloudflare Web Analytics is enabled, it provides aggregate page-view information without an advertising profile.

The site may also record a small first-party event—for example, a page view; that an install command was copied; a marketplace, benchmark-trace, or getting-started link was selected; that the getting-started documentation was reached; a product capture was played; a release-subscription request was submitted; a subscription was confirmed; or a download was requested. The server stores the event name, site hostname, page path, and a coarse class such as desktop, mobile, bot, or DGC update checker. It does not store prompts, repository contents, form text, a full user-agent string, or a cross-site identifier in that event dataset. These events use no advertising cookie, are not recorded when the request or browser reports `DNT: 1` or Global Privacy Control, and Cloudflare Analytics Engine retains them for three months.

## Forms and email

The website does not accept commercial enquiries or commercial-license requests.

The release-notes form stores the address, its SHA-256 lookup hash, a private confirmation token and hash, a separate private removal token and hash, source, times, delivery state, provider message identifier, and a random delivery idempotency key before asking Resend to send both links. The confirmation link opens a review page and does not subscribe you until you explicitly press Confirm. The removal link also opens a review page and can cancel a pending request or remove a confirmed address. An unconfirmed request becomes unusable after 48 hours and its row is eligible for subsequent cleanup. After confirmation, the address and its SHA-256 lookup hash, the confirmation-token hash, the removal token and its hash, and confirmation/update times remain on the release list until you use the removal link.

Release-subscription submissions are used only to manage the requested subscription, prevent abuse, and keep the records described above. Abuse controls store keyed pseudonyms derived from an IP address or submitted email, never the raw value in the counter itself. Counters and cooldowns stop authorizing decisions after their short fixed windows and are removed by subsequent site cleanup. D1 has no automatic row TTL, so physical deletion follows cleanup traffic rather than an exact wall-clock deadline; deleted rows may also remain in Cloudflare backups for its backup window. Form data is not sold and is not used to train a model. Do not put API keys, source code, health data, payment-card details, or other secrets in a form. Release subscribers can use the removal link in their release email.

## Choices and changes

You control the model and integrations DGC connects to, whether to create a training export, and whether to submit a form. Browser Do Not Track disables optional first-party interaction events. Network-level blocking may also prevent website analytics or the version check without stopping an already installed DGC from working with a reachable local model.

This notice may change when the product or website data flows change. Material changes will be reflected by a new effective date.
