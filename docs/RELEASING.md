# Releasing DGC

Production releases are projections of reviewed Git commits. They are never assembled from an
uncommitted working tree and `main` is never force-pushed.

The CLI/core and editor extension intentionally have independent version streams. Core metadata is
derived from `dgc.__version__` and projected into the core release/site manifest; editor metadata is
derived from `editors/vscode/package.json` and must agree with its package lock and editor manifest.
The two channel versions do not need to be numerically equal.

1. Make the version and release notes changes in a pull request. Ensure required CI and CodeQL checks
   are green, metadata agrees across the CLI, extension, site and package, and the branch is clean.
2. Run `scripts/preflight.sh` locally. For a core release, create an annotated `vX.Y.Z` tag at the
   reviewed commit and push the tag.
3. The release workflow reruns all gates, builds the Python distribution and a deterministic
   `dgc.tar.gz` from that exact commit, generates a CycloneDX SBOM from the committed Python/npm
   lockfiles, creates a provenance attestation, and attaches the artifacts to the GitHub release.
4. Download or use the verified `dist/release` output, run `scripts/promote-release.sh`, review the
   resulting site artifact/checksum/manifest changes, commit them, then run `scripts/deploy-site.sh`
   with `CLOUDFLARE_API_TOKEN` set.
5. Build the editor with `scripts/release-extension.sh`. It creates separate registry and self-hosted
   VSIX files. After reviewing the hashes, rerun with `--publish` and explicit `VSCE_PAT`, `OVSX_PAT`,
   and `CLOUDFLARE_API_TOKEN` environment variables.

After promotion, verify the site checksum, installer, `version.json`, Marketplace and Open VSX version,
GitHub tag SHA, and a clean install in a temporary home. If promotion fails, do not rebuild: fix the
channel and promote the same bytes. Roll back by redeploying the prior committed site artifacts; do
not move or rewrite an existing release tag.
