# DGC SDK changelog

## 0.5.3 — 2026-09-18

Pairs with CLI 0.41.6 over editor protocol v14.

### Packaging and release

- PyPI and the GitHub release now carry the same bytes. `publish-dgc-sdk.yml` builds only from
  the `sdk-vX.Y.Z` tag, runs the SDK suites against the built wheel, publishes through PyPI
  Trusted Publishing with PEP 740 attestations, and attaches the same wheel and sdist, the npm
  tarball, a CycloneDX SBOM and `SHA256SUMS` to the GitHub release with GitHub artifact
  attestations. SDK releases no longer take the Latest badge from the CLI.
- The wheel and sdist include the Apache-2.0 `LICENSE` (PEP 639 metadata), and the classifiers name
  the proven platform (Linux) and `Typing :: Typed`.
- The Node package `@vibedgc/sdk` is compiled to JavaScript with type declarations, so
  `npm install <tarball>` works; it needs Node 22 or newer.
- The maintainer public key for the checkout manifest is committed as `sdk/sbom/sdk.pub`; SBOMs use
  `pkg:pypi` package URLs.
- CI builds the wheel and runs the SDK suites against it in a clean, non-editable install, runs
  the TypeScript suites, and type-checks the public API with `mypy --strict`. Every GitHub Action
  is pinned to a commit.

### Examples and docs

- Every example runs from a pip install: model and endpoint come from `--model`/`--base-url` or
  `DGC_MODEL`/`DGC_BASE_URL`, state goes to a new temporary directory, and output says what
  happened. `ci_edit.py` writes a patch that `git apply` accepts, new files included.
- `workbench.py` binds 127.0.0.1, requires a per-run token, accepts only JSON from its own page
  and host, matches approvals to the pending request, and no longer names a LAN address.
- The README quickstart runs as written and is tested.
- `docs/SDK.md` is a full guide and API reference: every public name, the events, the defaults,
  the security model and how to verify a release.
