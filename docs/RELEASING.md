# Releasing DGC

Production releases are projections of reviewed Git commits. They are never assembled from an
uncommitted working tree and `main` is never force-pushed.

The CLI/core and editor extension intentionally have independent version streams. Core metadata is
derived from `dgc.__version__` and projected into the core release/site manifest; editor metadata is
derived from `editors/vscode/package.json` and must agree with its package lock and editor manifest.
The two channel versions do not need to be numerically equal.

## Marketplace proof snapshot

The scheduled `Site metrics snapshot` workflow is deliberately read-only: it preserves a validated
candidate as the `dgc-site-metrics-<run-id>-<run-attempt>` artifact, but it cannot silently change
the public claim in Git. Before a site release, select the newest successful scheduled or manually
dispatched run on public `main`, download that exact artifact, and promote it through the merge
validator:

```bash
RUN_ID=$(gh run list --workflow site-metrics.yml --branch main --status success --limit 30 \
  --json databaseId,event \
  --jq '[.[] | select(.event == "schedule" or .event == "workflow_dispatch")][0].databaseId')
test -n "$RUN_ID"
RUN_ATTEMPT=$(gh api "repos/{owner}/{repo}/actions/runs/$RUN_ID" --jq .run_attempt)
test -n "$RUN_ATTEMPT"
METRICS_STAGE=$(mktemp -d)
gh run download "$RUN_ID" --name "dgc-site-metrics-$RUN_ID-$RUN_ATTEMPT" --dir "$METRICS_STAGE"
METRICS_JSON="$METRICS_STAGE/site-src/data/site-metrics.json"
test -f "$METRICS_JSON"
python3 scripts/site-measurement.py promote-marketplace \
  --input "$METRICS_JSON" --max-age-hours 48
python3 scripts/build-site.py
python3 scripts/site-measurement.py check-marketplace --max-age-hours 48
python3 scripts/build-site.py --check
git diff -- site-src/data/site-metrics.json site/index.html
```

The promotion refuses stale candidates, count regressions, conflicting observations, and history
rewinds. Review and commit the snapshot plus its generated site projection together. If the selected
artifact is already older than 48 hours, dispatch the workflow again instead of weakening the gate.

1. Make version and release-note changes in a pull request. Never reuse a published CLI or extension
   version. Ensure required CI and CodeQL checks are green and the source branch is clean. Commit the
   reviewed release sources as commit A and create annotated tag `vX.Y.Z` at A.
2. At A, run `scripts/preflight.sh`, `scripts/build-release.sh`, and (when applicable)
   `scripts/release-extension.sh --build`. Stage the extension first with
   `scripts/release-extension.sh --stage-site` (that phase requires the still-clean A tree), then
   run `scripts/promote-release.sh`. Update the site manifests, rerun the strict site gate, and
   commit only paths below `site/` as commit B. The committed projection includes `dgc.tar.gz`, the
   alias and versioned self-hosted VSIX files, their checksums, and their manifests; these release
   bytes are intentionally tracked so a fresh B checkout is independently reviewable and deployable.
   No non-site path—including source, workflow, root `install.sh`, or release scripts—may change
   between A and B. A staged `site/install.sh` remains part of the site projection and must equal the
   reviewed root installer from A.
   Pre-publication CI may waive only the not-yet-public source tag; it still requires every tracked
   artifact and reproduces the runtime archive from the source commit recorded in its manifest.
3. From clean B, run `scripts/github-release.sh vX.Y.Z`. It verifies the local tag/artifact/source
   binding and all preflight gates, then atomically pushes B to public `main` and the A tag. No
   observer can see a manifest pointing at an unreachable source commit. The tag workflow is the
   sole GitHub Release creator. It reruns all gates, builds the Python distribution and
   deterministic runtime-only `dgc.tar.gz`, generates a CycloneDX SBOM whose components exactly
   match the archive's `requirements.lock`, and attaches that SBOM and provenance. Because that lock
   records the installed closure but not dependency edges, the SBOM leaves the optional relationship
   graph unknown rather than mislabeling transitive packages as direct. The editor VSIX is a separate
   artifact: its npm build/development graph must never be mixed into the core runtime SBOM. The
   release gate deliberately accepts only the deterministic fields emitted by DGC's generator—even
   though CycloneDX supports optional extensions—and size-bounds and credential-scans every sidecar.
   The installer archive must never include maintainer scripts, internal tests, benchmark material,
   CI configuration, website source, or internal documentation.
4. The local promotion binding deliberately permits an unpublished tagged source commit; deployment
   and tagged-release gates additionally require that source on public `origin/main`. Deployment is a
   separate final action: `DGC_ENV_FILE=/path/to/private.env scripts/deploy-site.sh`. The script
   requires a clean `main` exactly equal to `origin/main`, validates an exact allowlisted staging
   directory, verifies the production D1/Analytics bindings and Pages secrets, applies the reviewed
   D1 migration, and only then deploys.
5. The editor has four deliberately separate phases:

   - `scripts/release-extension.sh --build` creates and verifies registry and self-hosted VSIX files
     bound to the current commit.
   - `scripts/release-extension.sh --stage-site` copies only the verified self-hosted VSIX into the
     site projection; review and commit it separately.
   - `VSCE_PAT=... scripts/release-extension.sh --publish-marketplace` publishes only Marketplace.
   - `OVSX_PAT=... scripts/release-extension.sh --publish-open-vsx` publishes only Open VSX.

   There is intentionally no combined `--publish` mode and no extension phase deploys the website.

After promotion, verify the site checksum, installer, `version.json`, Marketplace and Open VSX
versions, GitHub tag SHA, form delivery/opt-in, and a clean install in a temporary home. If promotion
fails, do not rebuild: fix the channel and promote the same bytes. Roll back by redeploying prior
committed site artifacts; never move or rewrite an existing release tag.
