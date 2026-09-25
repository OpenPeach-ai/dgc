"""Bounded, pinned plugin sources. No executable package code is run while browsing."""
from __future__ import annotations

import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import tarfile
import tempfile
from urllib.parse import quote, urlsplit
from urllib.request import Request, urlopen

MAX_JSON = 1024 * 1024
MAX_ARCHIVE = 32 * 1024 * 1024
MAX_TREE = 64 * 1024 * 1024
MAX_FILE = 8 * 1024 * 1024
MAX_FILES = 4000
NAME = re.compile(r'[a-z0-9][a-z0-9-]{0,63}\Z')


class SourceError(ValueError):
    pass


def read_json(path: Path, limit=MAX_JSON):
    with path.open('rb') as stream:
        raw = stream.read(limit + 1)
    if len(raw) > limit:
        raise SourceError(f'{path.name} exceeds the metadata size limit')
    try:
        return json.loads(raw)
    except (ValueError, RecursionError) as exc:
        raise SourceError(f'{path.name} is not valid JSON') from exc


def write_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='.pending-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(value, stream, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def contained(root: Path, relative: str) -> Path:
    if not isinstance(relative, str) or '\\' in relative or '\x00' in relative:
        raise SourceError('Invalid package path')
    pure = PurePosixPath(relative)
    if pure.is_absolute() or '..' in pure.parts:
        raise SourceError('Package paths must stay inside their source')
    result = root / relative
    try:
        result.resolve().relative_to(root.resolve())
    except ValueError as exc:
        raise SourceError('Package path escapes its source') from exc
    return result


def tree_files(root: Path):
    """Preflight before copying; never follow links or silently truncate resources."""
    root = root.resolve()
    files, size = [], 0
    for parent, dirs, names in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in {'.git', 'node_modules', '__pycache__'})
        for name in dirs + names:
            p = Path(parent) / name
            info = p.lstat()
            if stat.S_ISLNK(info.st_mode):
                raise SourceError('Plugin packages cannot contain symbolic links')
            if not stat.S_ISDIR(info.st_mode) and not stat.S_ISREG(info.st_mode):
                raise SourceError('Plugin packages can contain only regular files and directories')
            if stat.S_ISREG(info.st_mode):
                size += info.st_size
                files.append((p, p.relative_to(root)))
                if info.st_size > MAX_FILE or size > MAX_TREE or len(files) > MAX_FILES:
                    raise SourceError('Plugin package exceeds the file or aggregate size limit')
    return files


def copy_tree(root: Path, dest: Path):
    files = tree_files(root)
    dest.mkdir(parents=True, exist_ok=True)
    actual = 0
    for src, relative in files:
        target = dest / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        # Recheck at the read boundary, including a local source changed since preflight.
        fd = os.open(src, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
        with os.fdopen(fd, 'rb') as inp:
            if not stat.S_ISREG(os.fstat(inp.fileno()).st_mode):
                raise SourceError('Package file changed during installation')
            raw = inp.read(MAX_FILE + 1)
        actual += len(raw)
        if len(raw) > MAX_FILE or actual > MAX_TREE:
            raise SourceError('Package file changed during installation')
        target.write_bytes(raw)


def _download(url: str, limit: int) -> bytes:
    req = Request(url, headers={'User-Agent': 'DGC-plugin-directory', 'Accept': 'application/vnd.github+json'})
    try:
        with urlopen(req, timeout=25) as response:
            length = response.headers.get('Content-Length')
            if length and int(length) > limit:
                raise SourceError('Source download exceeds the size limit')
            raw = response.read(limit + 1)
        if len(raw) > limit:
            raise SourceError('Source download exceeds the size limit')
        return raw
    except (OSError, ValueError) as exc:
        raise SourceError('Could not fetch the public GitHub source: ' + str(exc)[:180]) from exc


def github_parts(source: str):
    source = source.strip()
    if re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', source):
        source = 'https://github.com/' + source
    parsed = urlsplit(source)
    if (parsed.scheme != 'https' or parsed.hostname not in {'github.com', 'www.github.com'}
            or parsed.username or parsed.password or parsed.query or parsed.fragment):
        raise SourceError('Use a public GitHub HTTPS URL, owner/repository, or a local marketplace folder')
    parts = parsed.path.strip('/').split('/')
    if len(parts) < 2 or any(not re.fullmatch(r'[A-Za-z0-9_.-]{1,100}', x) or x in {'.','..'} for x in parts[:2]):
        raise SourceError('Invalid GitHub repository')
    owner, repo = parts[0], parts[1].removesuffix('.git')
    ref, path = 'HEAD', ''
    if len(parts) > 2:
        if parts[2] not in {'tree', 'blob'} or len(parts) < 4:
            raise SourceError('Use a repository URL or a link to its plugin folder')
        ref = parts[3]
        path = '/'.join(parts[4:])
        if parts[2] == 'blob':
            path = str(PurePosixPath(path).parent)
        contained(Path('/source'), path)
    return owner, repo, ref, path


def extract_archive(raw: bytes, dest: Path, subpath=""):
    wanted = PurePosixPath(subpath).parts if subpath else ()
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(raw)) as gz:
            unpacked = gz.read(MAX_TREE + 1)
        if len(unpacked) > MAX_TREE:
            raise SourceError('Expanded source archive exceeds the size limit')
        with tarfile.open(fileobj=io.BytesIO(unpacked), mode='r:') as tar:
            members, size, seen = [], 0, set()
            for count, member in enumerate(tar):
                if count >= 100000: raise SourceError("Source archive has too many entries to scan")
                if len(members) >= MAX_FILES:
                    raise SourceError('Source archive has too many entries')
                parts = PurePosixPath(member.name).parts
                if not parts or member.name.startswith('/') or '..' in parts or '\\' in member.name:
                    raise SourceError('Unsafe path in source archive')
                root_license = len(parts)==2 and parts[1] in {'LICENSE','LICENSE.md','LICENSE.txt'}
                if wanted and not root_license and tuple(parts[1:1+len(wanted)]) != wanted:
                    continue
                if not member.isdir() and not member.isfile():
                    raise SourceError('Source archive contains links or special files')
                relative = '/'.join(parts[1:])
                if not relative:
                    continue
                if relative in seen:
                    raise SourceError('Duplicate path in source archive')
                seen.add(relative)
                size += member.size
                if member.size > MAX_FILE or size > MAX_TREE:
                    raise SourceError('Source files exceed the size limit')
                members.append((member, relative))
            dest.mkdir(parents=True, exist_ok=True)
            for member, relative in members:
                target = contained(dest, relative)
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with tar.extractfile(member) as stream:
                        target.write_bytes(stream.read(member.size + 1))
    except (tarfile.TarError, EOFError, OSError) as exc:
        raise SourceError('Source archive is incomplete or invalid') from exc


def snapshot_github(home: Path, source: str, pin='', subpath='') -> tuple[Path, str, str]:
    owner, repo, ref, path = github_parts(source)
    path = subpath or path
    contained(Path('/source'), path)
    sha = pin or ref
    if not re.fullmatch(r'[0-9a-f]{40}', sha):
        data = json.loads(_download(f'https://api.github.com/repos/{owner}/{repo}/commits/{quote(sha, safe="")}', MAX_JSON))
        sha = data.get('sha', '')
    if not re.fullmatch(r'[0-9a-f]{40}', sha):
        raise SourceError('GitHub did not return a full commit pin')
    digest = hashlib.sha256(f'{owner.lower()}/{repo.lower()}@{sha}:{path}'.encode()).hexdigest()
    cache = home / 'sources' / digest
    if not (cache / '.dgc-source-complete').is_file():
        cache.parent.mkdir(parents=True, exist_ok=True)
        stage = Path(tempfile.mkdtemp(prefix='.fetch-', dir=cache.parent))
        try:
            raw = _download(f'https://codeload.github.com/{owner}/{repo}/tar.gz/{sha}', MAX_ARCHIVE)
            extract_archive(raw, stage, path)
            (stage / '.dgc-source-complete').write_text(sha)
            if cache.exists():
                shutil.rmtree(cache)
            stage.rename(cache)
        finally:
            if stage.exists():
                shutil.rmtree(stage)
    return contained(cache, path), sha, f'https://github.com/{owner}/{repo}'


def snapshot_local(home: Path, source: Path) -> tuple[Path, str]:
    """Freeze a mutable authored package before showing executable contents for review."""
    base = home / 'reviewed-sources'
    base.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix='.review-', dir=base))
    try:
        copy_tree(source, stage)
        digest = hashlib.sha256()
        for file, relpath in sorted(tree_files(stage), key=lambda pair: str(pair[1])):
            relative = str(relpath).encode('utf-8')
            data = file.read_bytes()
            digest.update(len(relative).to_bytes(8, 'big')); digest.update(relative)
            digest.update(len(data).to_bytes(8, 'big')); digest.update(data)
        pin = digest.hexdigest()
        dest = base / pin
        if not dest.exists(): stage.rename(dest)
        return dest, pin
    finally:
        if stage.exists(): shutil.rmtree(stage)
