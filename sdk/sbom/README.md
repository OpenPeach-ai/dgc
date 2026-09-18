# SDK checkout manifest

`SHA256SUMS` lists the SHA-256 of every SDK source file (Python package, TypeScript sources and
build inputs, READMEs, compatibility notes) with paths relative to the repository root.
`cyclonedx.json` is the same list as a CycloneDX 1.5 SBOM (`pkg:pypi/dgc-sdk@<version>`).
`SHA256SUMS.sig` is an OpenSSL SHA-256 signature of `SHA256SUMS` by the maintainer key whose
public half is committed here as `sdk.pub` (SHA-256 of the DER key
`beab49d20fdb70382fdc60098d10988dd45e7ab25a1e930f4e4879de068808a0`).

```bash
openssl dgst -sha256 -verify sdk/sbom/sdk.pub -signature sdk/sbom/SHA256SUMS.sig sdk/sbom/SHA256SUMS
sha256sum -c sdk/sbom/SHA256SUMS
make -C sdk verify          # the same checks, plus set equality with the tree
```

Regenerate after every SDK source change, with the private key in `sdk/.signing/` (never committed):

```bash
make -C sdk sbom
```

The publish workflow refuses a tag whose tree does not match this manifest. This manifest describes a
checkout. The installable artifacts are covered separately: the workflow writes a release SBOM
and `SHA256SUMS` over the wheel, sdist and npm tarball, and attests them with GitHub artifact
attestations and PyPI's PEP 740 provenance (see `docs/SDK.md`, "Verifying a release").
