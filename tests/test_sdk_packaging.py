"""dgc-sdk packaging, release workflow, version surfaces, docs coverage and public typing."""
from __future__ import annotations

import hashlib
import importlib.util
import inspect
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INSTALLED = os.environ.get("DGC_SDK_TEST_INSTALLED") == "1"
if not INSTALLED:
    sys.path[:0] = [str(ROOT / "sdk" / "python"), str(ROOT)]

import dgc_sdk  # noqa: E402
from dgc_sdk import _version  # noqa: E402

try:
    import tomllib
except ModuleNotFoundError:  # Python 3.10: these checks run on the newer CI interpreters
    tomllib = None  # type: ignore[assignment]

SDK_VERSION = _version.__version__
KEY_FINGERPRINT = "beab49d20fdb70382fdc60098d10988dd45e7ab25a1e930f4e4879de068808a0"


def _load(relative: str, name: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


def _cli_version() -> str:
    text = (ROOT / "dgc" / "__init__.py").read_text(encoding="utf-8")
    return re.search(r'^__version__ = "([^"]+)"', text, re.M).group(1)


def _toml(path: Path) -> dict:
    if tomllib is None:
        raise unittest.SkipTest("tomllib needs Python 3.11+")
    return tomllib.loads(path.read_text(encoding="utf-8"))


# CI's SDK job sets this so a missing PyYAML or mypy fails instead of skipping.
REQUIRE_TOOLS = os.environ.get("DGC_REQUIRE_RELEASE_TOOLS") == "1"


def _yaml(path: Path):
    try:
        import yaml
    except ImportError:
        if REQUIRE_TOOLS:
            raise
        raise unittest.SkipTest("PyYAML is not installed (pip install -r sdk/scripts/requirements-release.txt)")
    return yaml.safe_load(path.read_text(encoding="utf-8"))


class VersionSurfaceTests(unittest.TestCase):
    def test_every_version_surface_names_this_sdk_and_its_cli(self):
        cli = _cli_version()
        pyproject = _toml(ROOT / "sdk/python/pyproject.toml")
        package = json.loads((ROOT / "sdk/typescript/package.json").read_text(encoding="utf-8"))
        types_ts = (ROOT / "sdk/typescript/src/types.ts").read_text(encoding="utf-8")
        self.assertEqual(pyproject["project"]["version"], SDK_VERSION)
        self.assertEqual(package["version"], SDK_VERSION)
        self.assertIn(f'export const VERSION = "{SDK_VERSION}";', types_ts)
        self.assertEqual(_version.REQUIRES_CLI, cli, "the SDK pairs with the CLI released beside it")
        self.assertIn(f'export const REQUIRES_CLI = "{cli}";', types_ts)
        self.assertEqual(pyproject["project"]["urls"]["Release"],
                         f"https://github.com/OpenPeach-ai/dgc/releases/tag/sdk-v{SDK_VERSION}")
        for url in (pyproject["project"]["urls"]["Documentation"], pyproject["project"]["urls"]["Changelog"]):
            self.assertIn(f"/blob/sdk-v{SDK_VERSION}/", url, "docs links pin the released tag")
        texts = {
            "sdk/README.md": (ROOT / "sdk/README.md").read_text(encoding="utf-8"),
            "sdk/python/README.md": (ROOT / "sdk/python/README.md").read_text(encoding="utf-8"),
            "sdk/typescript/README.md": (ROOT / "sdk/typescript/README.md").read_text(encoding="utf-8"),
            "docs/SDK.md": (ROOT / "docs/SDK.md").read_text(encoding="utf-8"),
            "dgc/docs.py": (ROOT / "dgc/docs.py").read_text(encoding="utf-8"),
            "dgc_sdk/__init__.py": inspect.getdoc(dgc_sdk) or "",
        }
        for name, text in texts.items():
            self.assertIn(SDK_VERSION, text, f"{name} does not name SDK {SDK_VERSION}")
            self.assertIn(cli, text, f"{name} does not name CLI {cli}")
            for stale in ("Not published", "not on PyPI", "Until the index has this release",
                          "Frozen **0.5.2**", "Frozen 0.5.2", "Frozen cut: **0.5.2**"):
                self.assertNotIn(stale, text, f"{name} still says {stale!r}")
        compat = (ROOT / "sdk/COMPATIBILITY.md").read_text(encoding="utf-8")
        first_row = next(line for line in compat.splitlines() if line.startswith("| **"))
        self.assertIn(f"**{SDK_VERSION}**", first_row)
        self.assertIn(f"**{cli}**", first_row)
        self.assertIn("**≥ 22**", first_row)
        self.assertEqual(package["engines"]["node"], ">=22", "docs and package.json agree on Node")
        changelog = (ROOT / "sdk/CHANGELOG.md").read_text(encoding="utf-8")
        self.assertRegex(changelog, rf"(?m)^## {re.escape(SDK_VERSION)}\b")

    def test_user_facing_sdk_text_never_says_ai(self):
        paths = [ROOT / "docs/SDK.md", ROOT / "sdk/README.md", ROOT / "sdk/python/README.md",
                 ROOT / "sdk/typescript/README.md", ROOT / "sdk/COMPATIBILITY.md",
                 ROOT / "sdk/CHANGELOG.md", ROOT / "examples/sdk/README.md"]
        paths += sorted((ROOT / "examples/sdk").glob("*.py"))
        for path in paths:
            self.assertIsNone(re.search(r"\bAI\b", path.read_text(encoding="utf-8")), path)


class PackageMetadataTests(unittest.TestCase):
    def test_license_ships_with_both_packages(self):
        root_license = (ROOT / "LICENSE").read_bytes()
        for copy in ("sdk/python/LICENSE", "sdk/typescript/LICENSE"):
            self.assertEqual((ROOT / copy).read_bytes(), root_license, f"{copy} drifted from LICENSE")
        project = _toml(ROOT / "sdk/python/pyproject.toml")["project"]
        self.assertEqual(project["license"], "Apache-2.0")
        self.assertEqual(project["license-files"], ["LICENSE"])
        self.assertFalse([c for c in project["classifiers"] if c.startswith("License ::")],
                         "PEP 639: the license expression replaces license classifiers")
        self.assertIn("Operating System :: POSIX :: Linux", project["classifiers"])
        self.assertIn("Typing :: Typed", project["classifiers"])
        package = json.loads((ROOT / "sdk/typescript/package.json").read_text(encoding="utf-8"))
        self.assertEqual(package["files"], ["dist", "README.md", "LICENSE"])

    def test_check_dist_accepts_good_artifacts_and_names_each_defect(self):
        check_dist = _load("sdk/scripts/check_dist.py", "dgc_sdk_check_dist")
        with tempfile.TemporaryDirectory() as tmp:
            dist = Path(tmp)
            _fake_wheel(dist, SDK_VERSION, license=True)
            _fake_sdist(dist, SDK_VERSION, license=True)
            _fake_npm(dist, SDK_VERSION, main="./dist/index.js")
            self.assertEqual(check_dist.check(dist), [])
        with tempfile.TemporaryDirectory() as tmp:
            dist = Path(tmp)
            _fake_wheel(dist, SDK_VERSION, license=False)
            _fake_sdist(dist, SDK_VERSION, license=False)
            _fake_npm(dist, SDK_VERSION, main="./src/index.ts")
            errors = "\n".join(check_dist.check(dist))
            self.assertIn("licenses/LICENSE is missing", errors)
            self.assertIn(f"dgc_sdk-{SDK_VERSION}/LICENSE is missing", errors)
            self.assertIn("is not a packaged dist file", errors)


class ReleaseManifestTests(unittest.TestCase):
    def test_release_sums_cover_every_installable_artifact_and_the_sbom(self):
        make_sbom = _load("sdk/scripts/make_sbom.py", "dgc_sdk_make_sbom_release")
        with tempfile.TemporaryDirectory() as tmp:
            dist = Path(tmp)
            _fake_wheel(dist, SDK_VERSION, license=True)
            _fake_sdist(dist, SDK_VERSION, license=True)
            _fake_npm(dist, SDK_VERSION, main="./dist/index.js")
            old = os.environ.get("SOURCE_DATE_EPOCH")
            os.environ["SOURCE_DATE_EPOCH"] = "1789700000"
            try:
                make_sbom.write_release_manifest(dist)
            finally:
                if old is None:
                    os.environ.pop("SOURCE_DATE_EPOCH")
                else:
                    os.environ["SOURCE_DATE_EPOCH"] = old
            sums = {}
            for line in (dist / "SHA256SUMS").read_text(encoding="utf-8").splitlines():
                digest, name = line.split("  ")
                sums[name] = digest
            names = {f"dgc_sdk-{SDK_VERSION}-py3-none-any.whl", f"dgc_sdk-{SDK_VERSION}.tar.gz",
                     f"vibedgc-sdk-{SDK_VERSION}.tgz", f"dgc-sdk-{SDK_VERSION}.cdx.json"}
            self.assertEqual(set(sums), names)
            for name, digest in sums.items():
                self.assertEqual(hashlib.sha256((dist / name).read_bytes()).hexdigest(), digest)
            bom = json.loads((dist / f"dgc-sdk-{SDK_VERSION}.cdx.json").read_text(encoding="utf-8"))
            self.assertEqual(bom["metadata"]["timestamp"], "2026-09-18T02:53:20Z")
            self.assertEqual(bom["metadata"]["component"]["purl"], f"pkg:pypi/dgc-sdk@{SDK_VERSION}")
            purls = sorted(row["purl"] for row in bom["components"])
            self.assertEqual(purls, sorted([
                f"pkg:npm/%40vibedgc/sdk@{SDK_VERSION}",
                f"pkg:pypi/dgc-sdk@{SDK_VERSION}?file_name=dgc_sdk-{SDK_VERSION}-py3-none-any.whl",
                f"pkg:pypi/dgc-sdk@{SDK_VERSION}?file_name=dgc_sdk-{SDK_VERSION}.tar.gz",
            ]))

    def test_checkout_manifest_never_mints_a_replacement_key(self):
        make_sbom = _load("sdk/scripts/make_sbom.py", "dgc_sdk_make_sbom_keys")
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "sbom"
            out.mkdir()
            shutil.copyfile(ROOT / "sdk/sbom/sdk.pub", out / "sdk.pub")
            make_sbom.OUT = out
            make_sbom.COMMITTED_PUB = out / "sdk.pub"
            make_sbom.SIGNING = Path(tmp) / ".signing"
            with self.assertRaises(SystemExit) as caught:
                make_sbom.write_sbom()
            self.assertIn("sdk/.signing/sdk.key is missing", str(caught.exception))
            self.assertFalse((Path(tmp) / ".signing").exists())

    def test_committed_public_key_is_the_documented_one(self):
        if shutil.which("openssl") is None:
            self.skipTest("openssl is not installed")
        der = subprocess.run(["openssl", "pkey", "-pubin", "-in", str(ROOT / "sdk/sbom/sdk.pub"),
                              "-outform", "DER"], check=True, capture_output=True).stdout
        self.assertEqual(hashlib.sha256(der).hexdigest(), KEY_FINGERPRINT)
        self.assertIn(KEY_FINGERPRINT, (ROOT / "docs/SDK.md").read_text(encoding="utf-8"))


class WorkflowTests(unittest.TestCase):
    def test_every_action_is_pinned_to_a_commit(self):
        for path in sorted((ROOT / ".github/workflows").glob("*.yml")):
            for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                match = re.search(r"uses:\s*(\S+)", line)
                if not match or match.group(1).startswith("./"):
                    continue
                self.assertRegex(match.group(1), r"^[\w.-]+/[\w./-]+@[0-9a-f]{40}$",
                                 f"{path.name}:{number} is not SHA-pinned")
                self.assertRegex(line, r"# v\d", f"{path.name}:{number} lacks its version comment")

    def test_release_tools_are_pinned(self):
        lines = [line.split("#")[0].strip() for line in
                 (ROOT / "sdk/scripts/requirements-release.txt").read_text(encoding="utf-8").splitlines()]
        for requirement in filter(None, lines):
            self.assertRegex(requirement, r"^[A-Za-z0-9_.-]+==[\w.]+$")
        for path in sorted((ROOT / ".github/workflows").glob("*.yml")):
            text = path.read_text(encoding="utf-8")
            self.assertNotRegex(text, r"pip install (?:-U )?build\b", f"{path.name} installs build unpinned")
            self.assertNotRegex(text, r"pip install [^\n]*\btwine\b(?!==)", f"{path.name} installs twine unpinned")

    def test_publish_builds_only_from_the_tag_and_publishes_one_set_of_bytes(self):
        flow = _yaml(ROOT / ".github/workflows/publish-dgc-sdk.yml")
        triggers = flow.get("on", flow.get(True))
        self.assertEqual(triggers["push"], {"tags": ["sdk-v*"]})
        self.assertTrue(triggers["workflow_dispatch"]["inputs"]["tag"]["required"])
        self.assertEqual(flow["permissions"], {})
        build, pypi, release = (flow["jobs"][name] for name in ("build", "pypi", "release"))
        self.assertEqual(build["permissions"], {"contents": "read"}, "the build job holds no OIDC token")
        checkout = next(step for step in build["steps"] if "actions/checkout@" in step.get("uses", ""))
        self.assertTrue(checkout["with"]["ref"].startswith("refs/tags/"))
        build_text = json.dumps(build)
        for needed in ("merge-base --is-ancestor", "make_sbom.py --verify", "check_dist.py",
                       "tests/sdk_installed.py", "tests/test_dgc_sdk*.py", "mypy --strict",
                       "test_dgc_sdk_ts_package.mjs", "make_sbom.py --dist"):
            self.assertIn(needed, build_text)
        self.assertEqual(pypi["environment"], "pypi")
        self.assertEqual(pypi["permissions"], {"id-token": "write"})
        publish = next(step for step in pypi["steps"] if "gh-action-pypi-publish@" in step.get("uses", ""))
        self.assertTrue(publish["with"]["attestations"])
        self.assertNotIn("password", publish["with"], "trusted publishing needs no token")
        self.assertNotIn("skip-existing", publish["with"])
        self.assertEqual(release["needs"], ["build", "pypi"])
        release_text = json.dumps(release)
        self.assertIn("attest-build-provenance@", release_text)
        self.assertIn("--latest=false", release_text)
        self.assertIn("--verify-tag", release_text)
        text = (ROOT / ".github/workflows/publish-dgc-sdk.yml").read_text(encoding="utf-8")
        self.assertNotRegex(text, r"secrets\.(?!GITHUB_TOKEN)", "no secret the repository does not have")

    def test_ci_tests_the_built_sdk_like_a_user_installs_it(self):
        flow = _yaml(ROOT / ".github/workflows/ci.yml")
        text = json.dumps(flow["jobs"]["sdk"])
        for needed in ("python -m build sdk/python", "check_dist.py", "pip install --no-deps .",
                       "tests/sdk_installed.py", "tests/test_dgc_sdk*.py", "tests/test_sdk_*.py",
                       "mypy --strict", "tests/test_dgc_sdk_ts.mjs",
                       "tests/test_dgc_sdk_ts_package.mjs"):
            self.assertIn(needed, text)
        self.assertNotIn("pip install -e", text)
        self.assertNotIn("--no-deps -e", text)


PUBLIC_DUNDERS = {"__init__", "__enter__", "__exit__", "__aenter__", "__aexit__", "__iter__",
                  "__aiter__", "__anext__"}


def _public_callables():
    for name in dgc_sdk.__all__:
        value = getattr(dgc_sdk, name)
        if inspect.isclass(value):
            if hasattr(value, "__dataclass_fields__"):
                continue
            for attr, member in vars(value).items():
                if attr.startswith("_") and attr not in PUBLIC_DUNDERS:
                    continue
                if isinstance(member, property):
                    yield f"{name}.{attr}", member.fget
                elif inspect.isfunction(member):
                    yield f"{name}.{attr}", member
        elif inspect.isfunction(value):
            yield name, value


class PublicApiTests(unittest.TestCase):
    def test_every_public_signature_is_annotated(self):
        missing = []
        for qualname, function in _public_callables():
            signature = inspect.signature(function)
            for parameter in signature.parameters.values():
                if parameter.name in ("self", "cls"):
                    continue
                if parameter.annotation is inspect.Parameter.empty:
                    missing.append(f"{qualname}({parameter.name})")
            # mypy (and PEP 484) treat an __init__ with annotated parameters as returning None.
            annotated_init = qualname.endswith(".__init__") and any(
                parameter.annotation is not inspect.Parameter.empty
                for parameter in signature.parameters.values())
            if signature.return_annotation is inspect.Signature.empty and not annotated_init:
                missing.append(f"{qualname} -> ?")
        self.assertEqual(missing, [], "unannotated public API")

    def test_docs_reference_every_public_name(self):
        text = (ROOT / "docs/SDK.md").read_text(encoding="utf-8")
        absent = [name for name in dgc_sdk.__all__ if f"`{name}" not in text]
        absent += [qualname for qualname, _function in _public_callables()
                   if qualname.split(".")[-1] not in PUBLIC_DUNDERS
                   and f"{qualname.split('.')[-1]}(" not in text
                   and f"`{qualname.split('.')[-1]}`" not in text]
        self.assertEqual(absent, [], "docs/SDK.md does not document these")

    def test_public_api_passes_mypy_strict(self):
        try:
            import mypy.api
        except ImportError:
            if REQUIRE_TOOLS:
                raise
            self.skipTest("mypy is not installed (pip install -r sdk/scripts/requirements-release.txt)")
        env_path = os.environ.get("MYPYPATH")
        if not INSTALLED:
            os.environ["MYPYPATH"] = str(ROOT / "sdk" / "python")
        try:
            out, err, status = mypy.api.run([
                "--strict", "--no-incremental", "--follow-imports=silent",
                str(ROOT / "tests/sdk_typing/public_api.py")])
        finally:
            if env_path is None:
                os.environ.pop("MYPYPATH", None)
            else:
                os.environ["MYPYPATH"] = env_path
        self.assertEqual(status, 0, out + err)


def _fake_wheel(dist: Path, version: str, *, license: bool) -> None:
    info = f"dgc_sdk-{version}.dist-info"
    with zipfile.ZipFile(dist / f"dgc_sdk-{version}-py3-none-any.whl", "w") as wheel:
        wheel.writestr("dgc_sdk/__init__.py", "")
        wheel.writestr("dgc_sdk/py.typed", "")
        wheel.writestr("dgc_sdk/_version.py", f'__version__ = "{version}"\n')
        meta = f"Metadata-Version: 2.4\nName: dgc-sdk\nVersion: {version}\nLicense-Expression: Apache-2.0\n"
        if license:
            meta += "License-File: LICENSE\n"
            wheel.writestr(f"{info}/licenses/LICENSE", (ROOT / "LICENSE").read_bytes())
        wheel.writestr(f"{info}/METADATA", meta)


def _add(tar: tarfile.TarFile, name: str, data: bytes) -> None:
    member = tarfile.TarInfo(name)
    member.size = len(data)
    tar.addfile(member, io.BytesIO(data))


def _fake_sdist(dist: Path, version: str, *, license: bool) -> None:
    prefix = f"dgc_sdk-{version}/"
    with tarfile.open(dist / f"dgc_sdk-{version}.tar.gz", "w:gz") as sdist:
        _add(sdist, prefix + "PKG-INFO", f"Metadata-Version: 2.4\nName: dgc-sdk\nVersion: {version}\n".encode())
        if license:
            _add(sdist, prefix + "LICENSE", (ROOT / "LICENSE").read_bytes())


def _fake_npm(dist: Path, version: str, *, main: str) -> None:
    manifest = {"name": "@vibedgc/sdk", "version": version, "main": main,
                "exports": {".": {"import": main, "types": main.replace(".js", ".d.ts")}}}
    with tarfile.open(dist / f"vibedgc-sdk-{version}.tgz", "w:gz") as tgz:
        _add(tgz, "package/package.json", json.dumps(manifest).encode())
        for name in ("dist/index.js", "dist/index.d.ts", "dist/mcp-bridge.mjs", "README.md"):
            _add(tgz, "package/" + name, b"x")
        _add(tgz, "package/LICENSE", (ROOT / "LICENSE").read_bytes())


if __name__ == "__main__":
    unittest.main()
