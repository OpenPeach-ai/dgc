# SDK SBOM (local, unpublished)

Regenerate after every SDK source change, then sign last:

```bash
make -C sdk sbom          # writes cyclonedx.json + SHA256SUMS, signs, verifies
make -C sdk verify        # set-equality vs tree, no __pycache__, version, signature
```

- `cyclonedx.json` — CycloneDX 1.5. `metadata.component.version` and `components[]` library `dgc-sdk@<version>` both carry the SDK version from `_version.py`. File rows are source only (no `__pycache__` / `.pyc`).
- `SHA256SUMS` — same hashes, paths relative to the repo root
- `SHA256SUMS.sig` — OpenSSL SHA-256 signature of **this** SHA256SUMS (produced last)

The signing key is **local** (`sdk/.signing/`, gitignored). This is provenance for a checkout, not a public release. Do not publish packages.

```bash
openssl dgst -sha256 -verify sdk/.signing/sdk.pub \
  -signature sdk/sbom/SHA256SUMS.sig sdk/sbom/SHA256SUMS
```
