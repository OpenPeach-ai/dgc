---
title: Privacy
description: What DGC stores locally, what reaches a chosen provider, and what the website processes.
effective_date: 2026-09-05
---

# Privacy

This notice covers the DGC command-line tool and editor extension and the vibedgc.com website.

## DGC on your machine

DGC stores configuration, owner-restricted credentials, sessions, plans, goals, checkpoints, and related local state under its user data directory. The editor keeps credentials it manages in VS Code SecretStorage. Project instructions and project-scoped skills may also live in the repository you open. This data is used to operate the agent, resume work, and support local recovery.

DGC does not send product-usage telemetry. An interactive CLI launch may make a small request to `vibedgc.com/version.json` to learn whether a newer release exists. A successful check is cached for a day; after a failed request, a later interactive launch may retry. The request sends the ordinary network metadata needed for HTTP and a `dgc-update-check` user-agent; it does not include prompts, source code, session content, tool arguments, or credentials. One-shot `dgc -p` runs skip this check. The self-hosted editor VSIX separately checks `vibedgc.com/vscode/version.json` at most once a day by default with a `dgc-vscode` user-agent. Marketplace and Open VSX builds skip that request, and `dgc.checkForUpdates` can disable it.

The coding loop sends context only to services you choose to use. A model endpoint receives the prompts, selected project context, and tool results needed for the conversation. A local endpoint can keep that traffic on infrastructure you control; a cloud API or subscription provider processes it under that provider’s terms. Optional web search, fetched pages, MCP servers, and other configured integrations receive the requests or tool arguments you direct to them. A configured language server receives workspace metadata and the full text of documents queried through code intelligence.

Training export is initiated by you and writes to a path you choose. DGC removes reasoning traces and provider continuation data, then deep-scrubs configured secrets and high-confidence credential patterns before writing portable JSONL. DGC does not upload that export.

## The website

The site is delivered through Cloudflare. Cloudflare necessarily processes request information such as IP address, user agent, requested path, timestamps, and security signals to serve and protect the site. Where Cloudflare Web Analytics is enabled, it provides aggregate page-view information without an advertising profile.

The website does not expose a custom first-party analytics or interaction-event endpoint, and it does not maintain its own page-view or interaction-event dataset. Cloudflare Web Analytics, where enabled, is the website-usage analytics described here.

## Forms and email

The website does not operate contact, commercial-enquiry, commercial-license, or release-note subscription forms. Product changes and security reports use the public contribution and private vulnerability-reporting paths linked elsewhere on the site.

## Choices and changes

You control the model and integrations DGC connects to and whether to create a training export. Network-level blocking may prevent website analytics or the version check without stopping an already installed DGC from working with a reachable local model.

This notice may change when the product or website data flows change. Material changes will be reflected by a new effective date.
