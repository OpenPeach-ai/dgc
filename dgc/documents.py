"""Local, bounded document extraction. See NOTES.md for limits and PDF isolation.

The input is already in memory; callers must also bound their file/network reads.
No document is written to disk. Parsing a prefix does not validate its unread tail.
"""
from __future__ import annotations

import codecs
import csv
import importlib.util
import io
import json
import math
import os
import re
import stat
import struct
import subprocess
import sys
import threading
import time
import zipfile
import zlib
from dataclasses import dataclass, field
from pathlib import PurePosixPath
from typing import Any, Callable, Iterator, Literal
from xml.parsers import expat

SUPPORTED: dict[str, str] = {
    '.docx': 'Word document', '.xlsx': 'Excel workbook', '.pptx': 'PowerPoint presentation',
    '.odt': 'OpenDocument text', '.ods': 'OpenDocument spreadsheet',
    '.odp': 'OpenDocument presentation', '.csv': 'CSV table', '.tsv': 'TSV table',
    '.rtf': 'RTF document', '.pdf': 'PDF document',
}
UNSUPPORTED: dict[str, tuple[str, str]] = {
    '.sketch': ('Sketch design file', 'export it as PDF or PNG'),
    '.fig': ('Figma design file', 'export it as PDF or PNG'),
    '.doc': ('legacy Word document', 'save it as an unencrypted .docx file'),
    '.xls': ('legacy Excel workbook', 'save it as an unencrypted .xlsx file'),
    '.ppt': ('legacy PowerPoint presentation', 'save it as an unencrypted .pptx file'),
    '.png': ('PNG image', 'use the image attachment path'),
    '.jpg': ('JPEG image', 'use the image attachment path'),
    '.gif': ('GIF image', 'use the image attachment path'),
    '.webp': ('WebP image', 'use the image attachment path'),
    '.zip': ('ZIP archive', 'open it locally and select a supported document'),
    '.epub': ('EPUB book', 'export it as PDF or plain text'),
    '.pages': ('Apple Pages document', 'export it as .docx or PDF'),
    '.numbers': ('Apple Numbers workbook', 'export it as .xlsx or CSV'),
    '.key': ('Apple Keynote presentation', 'export it as .pptx or PDF'),
    '.ole': ('legacy or encrypted Office container', 'save an unencrypted .docx, .xlsx or .pptx file'),
}

MAX_INPUT_BYTES = 32 * 1024 * 1024
MAX_OUTPUT_CHARS = 1_000_000
MAX_ZIP_ENTRIES = 2048
MAX_CENTRAL_BYTES = 2 * 1024 * 1024
MAX_ENTRY_BYTES = 128 * 1024 * 1024
MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
MAX_XML_BYTES = 16 * 1024 * 1024
MAX_XML_NODES = 200_000
MAX_XML_TEXT = 4_000_000
MAX_XML_DEPTH = 64
MAX_ROWS = 10_000
MAX_CELLS = 50_000
MAX_COLUMNS = 256
MAX_SHEETS = 128
MAX_SLIDES = 200
MAX_SHARED_STRINGS = 20_000
MAX_FIELD_CHARS = 65_536
MAX_PDF_PAGES = 100
MAX_RENDER_PAGES = 20
MAX_RENDER_PIXELS = 2_000_000
MAX_RENDER_TOTAL_PIXELS = 20_000_000
MAX_PDF_REPLY_BYTES = 64 * 1024 * 1024
MAX_PDF_STDERR_BYTES = 8 * 1024
MAX_PDF_STDERR_STREAM_BYTES = 64 * 1024
PDF_MEMORY_BYTES = 512 * 1024 * 1024
PDF_CPU_SECONDS = 8
PDF_TIMEOUT_SECONDS = 12
PDF_RSS_POLL_SECONDS = 0.05
_CHUNK = 4096
_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
_X = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
_P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
_STRICT = 'http://purl.oclc.org/ooxml/'
_O = 'urn:oasis:names:tc:opendocument:xmlns:office:1.0'
_ODF = {
    b'application/vnd.oasis.opendocument.text': '.odt',
    b'application/vnd.oasis.opendocument.spreadsheet': '.ods',
    b'application/vnd.oasis.opendocument.presentation': '.odp',
}


class DocumentError(Exception):
    """Corrupt, encrypted, unsafe, or over-budget document; safe to show to a user."""


class UnsupportedDocument(Exception):
    """Unsupported format, missing optional backend, or unavailable PDF isolation."""


@dataclass(frozen=True)
class ExtractedText:
    text: str
    format: str
    truncated: bool
    summary: dict[str, Any] = field(default_factory=dict)


RenderStopReason = Literal['document_ended', 'page_budget', 'aggregate_pixel_budget', 'renderer_unavailable']


@dataclass(frozen=True)
class RenderedPDF:
    images: list[bytes]
    rendered_count: int
    declared_total: int | None
    stop_reason: RenderStopReason


class _PrefixComplete(Exception):
    pass


def _error(message: str) -> DocumentError:
    return DocumentError('error: ' + message)


def _check_raw(raw: bytes) -> None:
    if not isinstance(raw, bytes):
        raise TypeError('raw must be bytes')
    if len(raw) > MAX_INPUT_BYTES:
        raise _error('document exceeds the 32 MiB input limit; split it into smaller files')


def _integer(value: int, name: str, minimum: int, maximum: int) -> None:
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(f'{name} must be an integer between {minimum} and {maximum}')


def _local(tag: str) -> str:
    return tag.rsplit('}', 1)[-1]


def _attr(attrs: dict[str, str], name: str, default: str = '') -> str:
    return next((v for k, v in attrs.items() if _local(k) == name), default)


def _number(value: str, maximum: int, label: str, *, zero: bool = False) -> int:
    if not value.isascii() or not value.isdecimal() or len(value) > 10:
        raise _error(f'invalid {label}; export a fresh copy')
    result = int(value)
    if result < (0 if zero else 1) or result > maximum:
        raise _error(f'{label} exceeds its safety limit; split or re-export the document')
    return result


class _Text:
    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.length = 0
        self.parts: list[str] = []
        self.truncated = False

    def add(self, value: str) -> None:
        available = self.limit - self.length
        piece = value[:available]
        if piece:
            self.parts.append(piece)
            self.length += len(piece)
        if len(value) > available:
            self.stop()

    def stop(self) -> None:
        self.truncated = True
        raise _PrefixComplete

    def result(self, fmt: str, summary: dict[str, Any]) -> ExtractedText:
        summary['complete'] = not self.truncated
        summary['validation'] = 'prefix' if self.truncated else 'selected content'
        return ExtractedText(''.join(self.parts).strip('\n'), fmt, self.truncated, summary)


@dataclass(frozen=True)
class _Entry:
    name: str
    size: int
    compressed: int
    offset: int
    method: int
    crc: int


def _zip_entries(raw: bytes) -> dict[str, _Entry]:
    # Walk fixed-size central records before constructing any decompressor.
    end = raw.rfind(b'PK\x05\x06', max(0, len(raw) - 65557))
    if end < 0 or end + 22 > len(raw):
        raise _error('ZIP document is truncated; obtain a complete copy')
    _, disk, cd_disk, disk_n, count, cd_size, cd_start, comment = struct.unpack_from('<4s4H2IH', raw, end)
    if end + 22 + comment != len(raw) or disk or cd_disk or disk_n != count:
        raise _error('invalid or split ZIP document; export a fresh single-file copy')
    if count == 65535 or cd_size == 0xffffffff or cd_start == 0xffffffff:
        raise _error('ZIP64 documents are outside the safety limits; export a smaller copy')
    if count > MAX_ZIP_ENTRIES or cd_size > MAX_CENTRAL_BYTES:
        raise _error('ZIP directory exceeds the safety limit; split the document')
    if cd_start + cd_size != end:
        raise _error('ZIP directory is corrupt; export a fresh copy')
    entries: dict[str, _Entry] = {}
    spans: list[tuple[int, int]] = []
    total = 0
    pos = cd_start
    for _ in range(count):
        if pos + 46 > end or raw[pos:pos + 4] != b'PK\x01\x02':
            raise _error('ZIP directory is corrupt; export a fresh copy')
        fields = struct.unpack_from('<4s6H3I5H2I', raw, pos)
        flags, method = fields[3:5]
        crc, compressed, size = fields[7:10]
        name_n, extra_n, comment_n, entry_disk = fields[10:14]
        external, local_offset = fields[15:17]
        next_pos = pos + 46 + name_n + extra_n + comment_n
        if next_pos > end or not 0 < name_n <= 1024:
            raise _error('ZIP entry metadata is invalid; export a fresh copy')
        total += size
        if size > MAX_ENTRY_BYTES or total > MAX_ARCHIVE_BYTES:
            raise _error('ZIP expanded size exceeds the safety limit; split the document')
        if compressed > len(raw) or entry_disk or local_offset == 0xffffffff:
            raise _error('ZIP entry bounds are invalid; export a fresh copy')
        if flags & (1 | 64 | 8192):
            raise _error('document is encrypted; save an unencrypted copy')
        if method not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
            raise _error('ZIP compression method is unsupported; export using deflate')
        encoded = raw[pos + 46:pos + 46 + name_n]
        try:
            name = encoded.decode('utf-8' if flags & 2048 else 'cp437')
        except UnicodeError as exc:
            raise _error('ZIP entry name is invalid; export a fresh copy') from exc
        if '\x00' in name or '\\' in name or name.startswith('/') or ':' in name or any(p in ('.', '..') for p in name.split('/')):
            raise _error('ZIP contains an unsafe path; obtain a trusted export')
        mode = (external >> 16) & 0xffff
        if stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR):
            raise _error('ZIP contains a symlink or special file; obtain a trusted export')
        if name in entries:
            raise _error('ZIP contains duplicate entries; export a fresh copy')
        if local_offset + 30 > cd_start or raw[local_offset:local_offset + 4] != b'PK\x03\x04':
            raise _error('ZIP local header is corrupt; export a fresh copy')
        local = struct.unpack_from('<4s5H3I2H', raw, local_offset)
        lf, lm, lc, lcompressed, lsize, ln, le = local[2], local[3], local[6], local[7], local[8], local[9], local[10]
        data_start = local_offset + 30 + ln + le
        if lf != flags or lm != method or raw[local_offset + 30:local_offset + 30 + ln] != encoded:
            raise _error('ZIP headers disagree; export a fresh copy')
        if not flags & 8 and (lc, lcompressed, lsize) != (crc, compressed, size):
            raise _error('ZIP sizes disagree; export a fresh copy')
        if flags & 8 and (lsize not in (0, size) or lcompressed not in (0, compressed)):
            raise _error('ZIP descriptor sizes disagree; export a fresh copy')
        if data_start + compressed > cd_start or (method == 0 and compressed != size):
            raise _error('ZIP data bounds are invalid; export a fresh copy')
        span_end = data_start + compressed
        if flags & 8:
            descriptor = span_end
            if raw[descriptor:descriptor + 4] == b'PK\x07\x08':
                descriptor += 4
            if descriptor + 12 > cd_start or struct.unpack_from('<3I', raw, descriptor) != (crc, compressed, size):
                raise _error('ZIP data descriptor is corrupt; export a fresh copy')
            span_end = descriptor + 12
        entries[name] = _Entry(name, size, compressed, data_start, method, crc)
        spans.append((local_offset, span_end))
        pos = next_pos
    if pos != end:
        raise _error('ZIP directory length is invalid; export a fresh copy')
    spans.sort()
    if any(a[1] > b[0] for a, b in zip(spans, spans[1:])):
        raise _error('ZIP entries overlap; export a fresh copy')
    return entries


class _Archive:
    def __init__(self, raw: bytes) -> None:
        self.raw = raw
        self.entries = _zip_entries(raw)
        self.xml_bytes = 0
        self.nodes = 0
        self.text = 0

    def chunks(self, name: str) -> Iterator[bytes]:
        entry = self.entries.get(name)
        if entry is None:
            raise _error('document is missing a required part; export a fresh copy')
        source = memoryview(self.raw)[entry.offset:entry.offset + entry.compressed]
        expanded = checksum = 0
        decoder = zlib.decompressobj(-15) if entry.method == 8 else None
        pending = b''
        offset = 0
        try:
            while offset < len(source) or pending:
                if not pending:
                    pending = source[offset:offset + _CHUNK].tobytes()
                    offset += len(pending)
                if decoder:
                    block = decoder.decompress(pending, _CHUNK)
                    pending = decoder.unconsumed_tail
                    if decoder.unused_data:
                        raise _error('ZIP stream contains trailing data; export a fresh copy')
                else:
                    block, pending = pending, b''
                expanded += len(block)
                if expanded > entry.size or expanded > MAX_ENTRY_BYTES:
                    raise _error('ZIP expanded data exceeds its declared size; obtain a trusted export')
                checksum = zlib.crc32(block, checksum)
                if block:
                    yield block
            if (decoder and not decoder.eof) or expanded != entry.size or checksum != entry.crc:
                raise _error('ZIP data is truncated or corrupt; obtain a complete copy')
        except zlib.error as exc:
            raise _error('ZIP compressed data is corrupt; export a fresh copy') from exc

    def small(self, name: str, limit: int) -> bytes:
        if self.entries[name].size > limit:
            raise _error('document metadata exceeds the safety limit; export a simpler copy')
        return b''.join(self.chunks(name))


def _xml(archive: _Archive, name: str, root: str | None = None,
         start: Callable[[str, dict[str, str]], None] | None = None,
         end: Callable[[str], None] | None = None,
         text: Callable[[str], None] | None = None) -> None:
    parser = expat.ParserCreate(namespace_separator='}')
    parser.SetParamEntityParsing(expat.XML_PARAM_ENTITY_PARSING_NEVER)
    depth = 0
    first = True

    def forbidden(*args: Any) -> None:
        raise _error('XML entities and DTDs are forbidden; export a document without them')

    def namespace(prefix: str | None, uri: str | None) -> None:
        if uri and uri.startswith((_STRICT, 'https://purl.oclc.org/ooxml/')):
            raise UnsupportedDocument('error: strict OOXML documents are not supported yet; save as standard Office Open XML or export as PDF')

    def opening(tag: str, attrs: dict[str, str]) -> None:
        nonlocal depth, first
        if first and root and tag != root:
            raise _error('document XML has the wrong root; export a fresh copy')
        first = False
        depth += 1
        archive.nodes += 1
        if depth > MAX_XML_DEPTH or archive.nodes > MAX_XML_NODES or len(attrs) > 128:
            raise _error('XML structure exceeds the safety limit; split the document')
        if start:
            start(tag, attrs)

    def closing(tag: str) -> None:
        nonlocal depth
        if end:
            end(tag)
        depth -= 1

    def characters(value: str) -> None:
        archive.text += len(value)
        if archive.text > MAX_XML_TEXT:
            raise _error('XML text exceeds the safety limit; split the document')
        if text:
            text(value)

    parser.StartDoctypeDeclHandler = forbidden
    parser.EntityDeclHandler = forbidden
    parser.ExternalEntityRefHandler = forbidden
    parser.StartNamespaceDeclHandler = namespace
    parser.StartElementHandler = opening
    parser.EndElementHandler = closing
    parser.CharacterDataHandler = characters
    fed = 0
    try:
        for block in archive.chunks(name):
            # Bound unfinished tokens too: old Expat builds re-scan long tokens.
            if fed + len(block) - parser.CurrentByteIndex > MAX_FIELD_CHARS:
                raise _error('XML token exceeds the safety limit; shorten the element or attribute')
            fed += len(block)
            archive.xml_bytes += len(block)
            if archive.xml_bytes > MAX_XML_BYTES:
                raise _error('XML bytes exceed the parsing budget; split the document')
            parser.Parse(block, False)
        parser.Parse(b'', True)
    except expat.ExpatError as exc:
        raise _error('document XML is truncated or corrupt; export a fresh copy') from exc


def _archive_format(a: _Archive, extension: str) -> str:
    markers = [fmt for part, fmt in [('word/document.xml', '.docx'), ('xl/workbook.xml', '.xlsx'),
                                     ('ppt/presentation.xml', '.pptx')] if part in a.entries]
    if 'mimetype' in a.entries:
        mime = a.small('mimetype', 256).strip()
        if mime in _ODF:
            markers.append(_ODF[mime])
        elif mime == b'application/epub+zip':
            return '.epub'
    if len(markers) > 1:
        raise _error('document contains conflicting formats; obtain a trusted export')
    if markers:
        return markers[0]
    if 'document.json' in a.entries and 'meta.json' in a.entries:
        return '.sketch'
    if extension in ('.pages', '.numbers', '.key', '.sketch'):
        return extension
    return '.zip'


def _identify(filename: str, raw: bytes) -> tuple[str | None, _Archive | None]:
    _check_raw(raw)
    if not isinstance(filename, str):
        raise TypeError('filename must be str')
    extension = PurePosixPath(filename.replace('\\', '/')).suffix.lower()
    if raw.startswith(b'%PDF-'):
        return '.pdf', None
    if raw.startswith(b'\x89PNG\r\n\x1a\n'):
        return '.png', None
    if raw.startswith(b'\xff\xd8\xff'):
        return '.jpg', None
    if raw.startswith((b'GIF87a', b'GIF89a')):
        return '.gif', None
    if raw.startswith(b'RIFF') and raw[8:12] == b'WEBP':
        return '.webp', None
    if raw.startswith(b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1'):
        if extension in ('.docx', '.xlsx', '.pptx') or 'EncryptedPackage'.encode('utf-16le') in raw:
            raise _error('Office document is encrypted or wrapped in a legacy container; save an unencrypted modern Office copy')
        return (extension if extension in ('.doc', '.xls', '.ppt') else '.ole'), None
    if raw.startswith(b'PK'):
        archive = _Archive(raw)
        return _archive_format(archive, extension), archive
    if raw.lstrip(b' \r\n\t').startswith(b'{\\rtf'):
        return '.rtf', None
    sample, _ = _decode_sample(raw)
    if '\x00' not in sample and len(sample.splitlines()) >= 2:
        try:
            dialect = csv.Sniffer().sniff(sample, delimiters=',\t;|')
            return ('.tsv' if dialect.delimiter == '\t' else '.csv'), None
        except csv.Error:
            pass
    if extension in SUPPORTED or extension in UNSUPPORTED:
        return extension, None
    return None, None


def sniff(filename: str, raw: bytes) -> str | None:
    """Return a dotted format key, including known refusals, or None.

    Recognizable hostile/malformed containers raise DocumentError during sniffing.
    """
    return _identify(filename, raw)[0]


def _unsupported(fmt: str | None) -> UnsupportedDocument:
    name, remedy = UNSUPPORTED.get(fmt or '', ('unrecognized document format', 'export it as PDF, .docx, CSV or plain text'))
    return UnsupportedDocument(f'error: this is a {name}; {remedy}')


def _word_part(a: _Archive, out: _Text, summary: dict[str, Any], part: str, root: str,
               references: list[tuple[str, str, str]] | None = None) -> None:
    capture = 0

    def start(tag: str, attrs: dict[str, str]) -> None:
        nonlocal capture
        local = _local(tag)
        if references is not None and tag in (_W + '}headerReference', _W + '}footerReference'):
            if len(references) >= MAX_ZIP_ENTRIES:
                raise _error('too many header/footer references; split the document')
            kind = 'header' if local == 'headerReference' else 'footer'
            variant = attrs.get(_W + '}type', 'default')
            if variant not in ('default', 'first', 'even'):
                raise _error('invalid header/footer variant; export a fresh copy')
            references.append((kind, attrs.get(_R + '}id', ''), variant))
        if local == 't':
            capture += 1
        elif local == 'tab':
            out.add('\t')
        elif local in ('br', 'cr'):
            out.add('\n')

    def end(tag: str) -> None:
        nonlocal capture
        local = _local(tag)
        if local == 't':
            capture -= 1
        elif local == 'p':
            out.add('\n')
            summary['paragraphs_read'] = summary.get('paragraphs_read', 0) + 1
        elif local == 'tc':
            out.add('\t')
        elif local == 'tr':
            out.add('\n')

    _xml(a, part, _W + '}' + root, start, end, lambda s: out.add(s) if capture else None)


def _word(a: _Archive, out: _Text, summary: dict[str, Any]) -> None:
    references: list[tuple[str, str, str]] = []
    summary.update(headers_read=0, footers_read=0)
    _word_part(a, out, summary, 'word/document.xml', 'document', references)
    if not references:
        return
    relationships = _relationships(a, 'word/document.xml')
    seen: set[tuple[str, str]] = set()
    for kind, key, variant in references:
        rel = relationships.get(key)
        if rel is None or not rel.target or rel.kind != _R + '/' + kind:
            raise _error('document has a missing, external or mistyped header/footer relationship; export a self-contained copy')
        identity = (kind, rel.target)
        if identity in seen:
            continue
        seen.add(identity)
        out.add(f'\n{kind.capitalize()} ({variant})\n')
        _word_part(a, out, summary, rel.target, 'hdr' if kind == 'header' else 'ftr')
        summary[kind + 's_read'] += 1


@dataclass(frozen=True)
class _Relationship:
    target: str
    kind: str


def _relationships(a: _Archive, part: str) -> dict[str, _Relationship]:
    path = PurePosixPath(part)
    rel_name = str(path.parent / '_rels' / (path.name + '.rels'))
    result: dict[str, _Relationship] = {}
    if rel_name not in a.entries:
        return result

    def start(tag: str, attrs: dict[str, str]) -> None:
        if _local(tag) != 'Relationship':
            return
        key = attrs.get('Id', '')
        target = attrs.get('Target', '')
        kind = attrs.get('Type', '')
        if kind.startswith((_STRICT, 'https://purl.oclc.org/ooxml/')):
            raise UnsupportedDocument('error: strict OOXML relationships are not supported yet; save as standard Office Open XML or export as PDF')
        if key in result:
            raise _error('duplicate document relationship; export a fresh copy')
        if attrs.get('TargetMode') == 'External':
            result[key] = _Relationship('', kind)
            return
        if not target or '\\' in target or ':' in target or '\x00' in target:
            raise _error('unsafe document relationship; export a fresh copy')
        # OOXML uses legitimate ../ links. Resolve only within the in-memory archive.
        parts: list[str] = [] if target.startswith('/') else list(path.parent.parts)
        for p in target.split('/'):
            if p == '..':
                if not parts:
                    raise _error('document relationship escapes its archive; obtain a trusted export')
                parts.pop()
            elif p not in ('', '.'):
                parts.append(p)
        result[key] = _Relationship('/'.join(parts), kind)

    _xml(a, rel_name, start=start)
    return result


def _slide_text(a: _Archive, part: str, root: str, out: _Text, *, notes: bool = False) -> None:
    capture = False
    skip_shape = False

    def start(tag: str, attrs: dict[str, str]) -> None:
        nonlocal capture, skip_shape
        local = _local(tag)
        if notes and tag == _P + '}sp':
            skip_shape = False
        elif notes and tag == _P + '}ph' and attrs.get('type') in ('hdr', 'ftr', 'dt', 'sldNum', 'sldImg'):
            skip_shape = True
        if local == 't':
            capture = True
        elif local == 'br' and not skip_shape:
            out.add('\n')

    def end(tag: str) -> None:
        nonlocal capture, skip_shape
        if _local(tag) == 't':
            capture = False
        elif _local(tag) == 'p' and not skip_shape:
            out.add('\n')
        if notes and tag == _P + '}sp':
            skip_shape = False

    _xml(a, part, _P + '}' + root, start, end, lambda s: out.add(s) if capture and not skip_shape else None)


def _presentation(a: _Archive, out: _Text, summary: dict[str, Any]) -> None:
    ids: list[str] = []
    # sldId has both numeric id and r:id; use the relationship namespace.
    def collect(tag: str, attrs: dict[str, str]) -> None:
        if _local(tag) == 'sldId':
            ids.append(attrs.get(_R + '}id', ''))
    _xml(a, 'ppt/presentation.xml', _P + '}presentation', start=collect)
    relationships = _relationships(a, 'ppt/presentation.xml')
    summary.update(slides=len(ids), slides_read=0, notes_read=0)
    for index, key in enumerate(ids):
        if index >= MAX_SLIDES:
            out.stop()
        rel = relationships.get(key)
        if rel is None or not rel.target:
            raise _error('presentation has a missing or external slide; export a self-contained copy')
        part = rel.target
        out.add(f'Slide {index + 1}\n')
        _slide_text(a, part, 'sld', out)
        notes = [rel for rel in _relationships(a, part).values() if rel.kind == _R + '/notesSlide']
        if len(notes) > 1:
            raise _error('slide has conflicting speaker notes; export a fresh copy')
        if notes:
            if not notes[0].target:
                raise _error('slide has external speaker notes; export a self-contained copy')
            out.add('Notes\n')
            _slide_text(a, notes[0].target, 'notes', out, notes=True)
            summary['notes_read'] += 1
        summary['slides_read'] = index + 1
        out.add('\n')


def _spreadsheet(a: _Archive, out: _Text, summary: dict[str, Any]) -> None:
    sheets: list[tuple[str, str]] = []
    def collect(tag: str, attrs: dict[str, str]) -> None:
        if _local(tag) == 'sheet':
            if len(sheets) >= MAX_SHEETS:
                raise _error('workbook has too many sheets; split it into smaller workbooks')
            sheets.append((attrs.get('name', 'Sheet'), next((v for k, v in attrs.items() if k.endswith('}id')), '')))
    _xml(a, 'xl/workbook.xml', _X + '}workbook', start=collect)
    summary['sheets'] = [name for name, _ in sheets]
    summary['rows_read'] = 0
    relationships = _relationships(a, 'xl/workbook.xml')
    strings: list[str] = []
    if 'xl/sharedStrings.xml' in a.entries:
        item: list[str] = []
        capture = False
        item_size = 0
        def start_string(tag: str, attrs: dict[str, str]) -> None:
            nonlocal capture, item_size
            if _local(tag) == 'si':
                if len(strings) >= MAX_SHARED_STRINGS:
                    raise _error('shared string table exceeds the safety limit; export as CSV')
                item.clear()
                item_size = 0
            elif _local(tag) == 't':
                capture = True
        def text_string(value: str) -> None:
            nonlocal item_size
            if capture:
                item_size += len(value)
                if item_size > MAX_FIELD_CHARS:
                    raise _error('spreadsheet cell exceeds the safety limit; shorten it')
                item.append(value)
        def end_string(tag: str) -> None:
            nonlocal capture
            if _local(tag) == 't':
                capture = False
            elif _local(tag) == 'si':
                strings.append(''.join(item))
        _xml(a, 'xl/sharedStrings.xml', _X + '}sst', start_string, end_string, text_string)
    cells = 0
    for name, key in sheets:
        rel = relationships.get(key)
        if rel is None or not rel.target:
            raise _error('workbook has a missing or external sheet; export a self-contained copy')
        part = rel.target
        out.add(name + '\n')
        row: list[str] = []
        value: list[str] = []
        formula: list[str] = []
        capture = ''
        kind = ''
        field_size = 0
        def start(tag: str, attrs: dict[str, str]) -> None:
            nonlocal capture, kind, cells, field_size
            local = _local(tag)
            if local == 'row':
                if summary['rows_read'] >= MAX_ROWS:
                    out.stop()
                row.clear()
            elif local == 'c':
                if cells >= MAX_CELLS or len(row) >= MAX_COLUMNS:
                    out.stop()
                cells += 1
                value.clear()
                formula.clear()
                field_size = 0
                kind = attrs.get('t', '')
            elif local in ('v', 't', 'f'):
                capture = local
        def text(value_part: str) -> None:
            nonlocal field_size
            if capture:
                field_size += len(value_part)
                if field_size > MAX_FIELD_CHARS:
                    raise _error('spreadsheet cell exceeds the safety limit; shorten it')
                (formula if capture == 'f' else value).append(value_part)
        def end(tag: str) -> None:
            nonlocal capture
            local = _local(tag)
            if local in ('v', 't', 'f'):
                capture = ''
            elif local == 'c':
                cell = ''.join(value)
                if kind == 's':
                    index = _number(cell, MAX_SHARED_STRINGS, 'shared string index', zero=True)
                    if index >= len(strings):
                        raise _error('spreadsheet references a missing string; export a fresh copy')
                    cell = strings[index]
                if formula:
                    cell = '=' + ''.join(formula) + (f' [cached: {cell}]' if cell else '')
                row.append(cell)
            elif local == 'row':
                out.add('\t'.join(row) + '\n')
                summary['rows_read'] += 1
        _xml(a, part, _X + '}worksheet', start, end, text)


def _odf(a: _Archive, fmt: str, out: _Text, summary: dict[str, Any]) -> None:
    if 'META-INF/manifest.xml' in a.entries:
        def manifest(tag: str, attrs: dict[str, str]) -> None:
            if _local(tag) == 'encryption-data':
                raise _error('OpenDocument file is encrypted; save an unencrypted copy')
        _xml(a, 'META-INF/manifest.xml', start=manifest)
    paragraph = 0
    row: list[str] = []
    cell: list[str] = []
    cell_size = 0
    cells = 0
    repeat_row = repeat_cell = 1
    fallback = ''
    summary.update({'sheets': [], 'rows_read': 0} if fmt == '.ods' else {'slides_read': 0} if fmt == '.odp' else {})

    def emit(value: str) -> None:
        nonlocal cell_size
        if fmt == '.ods':
            cell_size += len(value)
            if cell_size > MAX_FIELD_CHARS:
                raise _error('spreadsheet cell exceeds the safety limit; shorten it')
            cell.append(value)
        else:
            out.add(value)

    def start(tag: str, attrs: dict[str, str]) -> None:
        nonlocal paragraph, repeat_row, repeat_cell, fallback, cell_size
        local = _local(tag)
        if fmt == '.ods':
            if local == 'table':
                if len(summary['sheets']) >= MAX_SHEETS:
                    out.stop()
                name = _attr(attrs, 'name', 'Sheet')
                summary['sheets'].append(name)
                out.add(name + '\n')
            elif local == 'table-row':
                if summary['rows_read'] >= MAX_ROWS:
                    out.stop()
                row.clear()
                repeat_row = _number(_attr(attrs, 'number-rows-repeated', '1'), 2_147_483_647, 'row repetition')
            elif local in ('table-cell', 'covered-table-cell'):
                cell.clear()
                cell_size = 0
                fallback = _attr(attrs, 'string-value', _attr(attrs, 'value', _attr(attrs, 'date-value', _attr(attrs, 'boolean-value'))))
                repeat_cell = _number(_attr(attrs, 'number-columns-repeated', '1'), 2_147_483_647, 'column repetition')
        if fmt == '.odp' and local == 'page':
            if summary['slides_read'] >= MAX_SLIDES:
                out.stop()
            summary['slides_read'] += 1
            out.add(f"Slide {summary['slides_read']}\n")
        if local in ('p', 'h'):
            paragraph += 1
        elif local == 's' and paragraph:
            n = _number(_attr(attrs, 'c', '1'), MAX_FIELD_CHARS, 'space repetition')
            emit(' ' * n)
        elif local == 'tab' and paragraph:
            emit('\t')
        elif local == 'line-break' and paragraph:
            emit('\n')

    def end(tag: str) -> None:
        nonlocal paragraph, cells
        local = _local(tag)
        if local in ('p', 'h'):
            paragraph -= 1
            emit('\n')
        if fmt == '.ods':
            if local in ('table-cell', 'covered-table-cell'):
                room = min(MAX_COLUMNS - len(row), MAX_CELLS - cells)
                if repeat_cell > room:
                    out.stop()
                value = ''.join(cell).strip('\n') or fallback
                row.extend([value] * repeat_cell)
                cells += repeat_cell
            elif local == 'table-row':
                allowed = min(repeat_row, MAX_ROWS - summary['rows_read'])
                line = '\t'.join(row) + '\n'
                for _ in range(allowed):
                    out.add(line)
                    summary['rows_read'] += 1
                if allowed < repeat_row:
                    out.stop()

    _xml(a, 'content.xml', _O + '}document-content', start, end, lambda s: emit(s) if paragraph else None)
    if fmt == '.odp':
        summary['slides'] = summary['slides_read']


def _decode_sample(raw: bytes) -> tuple[str, str]:
    if raw.startswith((b'\xff\xfe', b'\xfe\xff')):
        encoding = 'utf-16'
    elif raw.startswith(b'\xef\xbb\xbf'):
        encoding = 'utf-8-sig'
    else:
        encoding = 'utf-8'
        try:
            codecs.getincrementaldecoder('utf-8')('strict').decode(raw[:8192], final=False)
        except UnicodeError:
            encoding = 'latin-1'
    return raw[:8192].decode(encoding, errors='replace'), encoding


def _csv(raw: bytes, fmt: str, out: _Text, summary: dict[str, Any]) -> None:
    sample, encoding = _decode_sample(raw)
    if '\x00' in sample:
        raise _error('table contains binary data; export it as CSV text')
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=',\t;|')
        delimiter = dialect.delimiter
    except csv.Error:
        delimiter = '\t' if fmt == '.tsv' else ','
    summary.update(encoding=encoding, delimiter=delimiter, rows_read=0)
    decoder = codecs.getincrementaldecoder(encoding)(errors='replace')
    record_chars = 0
    def lines() -> Iterator[str]:
        nonlocal record_chars
        pending = ''
        for offset in range(0, len(raw) + _CHUNK, _CHUNK):
            block = decoder.decode(raw[offset:offset + _CHUNK], final=offset >= len(raw))
            pending += block
            while '\n' in pending:
                line, pending = pending.split('\n', 1)
                line += '\n'
                record_chars += len(line)
                if record_chars > MAX_FIELD_CHARS or '\x00' in line:
                    raise _error('CSV record is too long or contains binary data; export smaller text records')
                yield line
            if len(pending) + record_chars > MAX_FIELD_CHARS:
                raise _error('CSV record exceeds the safety limit; shorten the record')
        if pending:
            record_chars += len(pending)
            if record_chars > MAX_FIELD_CHARS or '\x00' in pending:
                raise _error('CSV record is too long or contains binary data; export smaller text records')
            yield pending
    reader = csv.reader(lines(), delimiter=delimiter, strict=True)
    try:
        for row in reader:
            record_chars = 0
            if summary['rows_read'] >= MAX_ROWS or len(row) > MAX_COLUMNS:
                out.stop()
            out.add('\t'.join(row) + '\n')
            summary['rows_read'] += 1
    except csv.Error as exc:
        raise _error('CSV quoting is corrupt or a field exceeds the safety limit; export a fresh copy') from exc


def _rtf(raw: bytes, out: _Text, summary: dict[str, Any]) -> None:
    data = raw.lstrip(b' \r\n\t')
    if not data.startswith(b'{\\rtf1'):
        raise _error('RTF header is corrupt; export a fresh copy')
    stack: list[tuple[bool, int, str]] = []
    skip = False
    uc = 1
    encoding = 'cp1252'
    fallback = 0
    position = 0
    tokens = 0
    ignored = {'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'objdata',
               'header', 'footer', 'filetbl', 'listtable', 'listoverridetable', 'fldinst', 'datastore', 'themedata'}
    def emit(value: str) -> None:
        nonlocal fallback
        if fallback:
            fallback -= 1
        elif not skip:
            out.add(value)
    while position < len(data):
        tokens += 1
        if tokens > MAX_XML_NODES:
            out.stop()
        value = data[position]
        position += 1
        if value == 123:
            if len(stack) >= MAX_XML_DEPTH:
                raise _error('RTF nesting exceeds the safety limit; export a simpler copy')
            stack.append((skip, uc, encoding))
        elif value == 125:
            if not stack:
                raise _error('RTF groups are corrupt; export a fresh copy')
            skip, uc, encoding = stack.pop()
            if not stack and data[position:].strip():
                raise _error('RTF contains trailing data; export a fresh copy')
        elif value == 92:
            if position >= len(data):
                raise _error('RTF control is truncated; obtain a complete copy')
            char = data[position]
            position += 1
            if char in (92, 123, 125):
                emit(chr(char))
            elif char == 42:
                skip = True
            elif char == 39:
                token = data[position:position + 2]
                if len(token) != 2 or not re.fullmatch(b'[0-9a-fA-F]{2}', token):
                    raise _error('RTF escape is corrupt; export a fresh copy')
                emit(bytes([int(token, 16)]).decode(encoding, 'replace'))
                position += 2
            elif 65 <= char <= 90 or 97 <= char <= 122:
                begin = position - 1
                while position < len(data) and (65 <= data[position] <= 90 or 97 <= data[position] <= 122):
                    position += 1
                    if position - begin > 32:
                        raise _error('RTF control word is too long; export a fresh copy')
                word = data[begin:position].decode('ascii')
                begin = position
                if position < len(data) and data[position] == 45:
                    position += 1
                while position < len(data) and 48 <= data[position] <= 57:
                    position += 1
                    if position - begin > 11:
                        raise _error('RTF control number exceeds the safety limit; export a fresh copy')
                token = data[begin:position]
                if token == b'-':
                    raise _error('RTF control number is corrupt; export a fresh copy')
                number = int(token) if token else None
                if position < len(data) and data[position] == 32:
                    position += 1
                if word in ignored:
                    skip = True
                elif word == 'bin':
                    if number is None or number < 0 or number > len(data) - position:
                        raise _error('RTF binary payload is truncated; obtain a complete copy')
                    position += number
                elif word == 'uc':
                    if number is None or not 0 <= number <= 16:
                        raise _error('RTF Unicode fallback is invalid; export a fresh copy')
                    uc = number
                elif word == 'u':
                    if number is None or not -32768 <= number <= 65535:
                        raise _error('RTF Unicode value is invalid; export a fresh copy')
                    fallback = 0
                    emit(chr(number & 0xffff))
                    fallback = uc
                elif word == 'ansicpg':
                    encodings = {1252: 'cp1252', 1251: 'cp1251', 10000: 'mac_roman', 65001: 'utf-8'}
                    encoding = encodings.get(number, 'cp1252')
                elif word in ('par', 'line'):
                    emit('\n')
                elif word == 'tab':
                    emit('\t')
                elif word in ('emdash', 'endash', 'bullet'):
                    emit({'emdash': '\u2014', 'endash': '\u2013', 'bullet': '\u2022'}[word])
            elif char == 126:
                emit('\u00a0')
            elif char == 95:
                emit('\u2011')
        elif value not in (10, 13):
            if not stack:
                if chr(value).isspace():
                    continue
                raise _error('RTF content is outside its root group; export a fresh copy')
            emit(bytes([value]).decode(encoding, 'replace'))
    if stack:
        raise _error('RTF groups are truncated; obtain a complete copy')


def extract_text(raw: bytes, filename: str, *, max_chars: int = 200_000) -> ExtractedText:
    """Extract a bounded prefix. See ExtractedText.summary['complete'] and NOTES.md."""
    _integer(max_chars, 'max_chars', 0, MAX_OUTPUT_CHARS)
    fmt, archive = _identify(filename, raw)
    if fmt not in SUPPORTED:
        raise _unsupported(fmt)
    if fmt == '.pdf':
        _pdf_envelope(raw)
        if not _available('pypdf'):
            raise UnsupportedDocument('error: PDF text extraction needs pypdf; install it locally or export as text')
        result = _pdf_request(raw, 'text', max_chars=max_chars)
        return ExtractedText(result['text'], '.pdf', result['truncated'], result['summary'])
    out = _Text(max_chars)
    summary: dict[str, Any] = {}
    try:
        if fmt in ('.docx', '.pptx', '.xlsx', '.odt', '.ods', '.odp'):
            if archive is None:
                raise _error('Office document is not a valid ZIP/XML file; obtain an unencrypted complete copy')
            if fmt == '.docx':
                _word(archive, out, summary)
            elif fmt == '.xlsx':
                _spreadsheet(archive, out, summary)
            elif fmt == '.pptx':
                _presentation(archive, out, summary)
            else:
                _odf(archive, fmt, out, summary)
        elif fmt in ('.csv', '.tsv'):
            _csv(raw, fmt, out, summary)
        else:
            _rtf(raw, out, summary)
    except _PrefixComplete:
        pass
    result = out.result(fmt, summary)
    if fmt == '.rtf':
        text = result.text.encode('utf-16', 'surrogatepass').decode('utf-16', 'replace')
        return ExtractedText(text, fmt, result.truncated, result.summary)
    return result


def _available(name: str) -> bool:
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def _pdf_envelope(raw: bytes) -> None:
    _check_raw(raw)
    if not raw.startswith(b'%PDF-') or not raw.rstrip().endswith(b'%%EOF'):
        raise _error('PDF is truncated or has an invalid header; obtain a complete copy')


def _pdf_platform() -> None:
    if not (sys.platform.startswith('linux') or sys.platform in ('win32', 'darwin')):
        raise UnsupportedDocument('error: PDF isolation is unavailable on this operating system; use a verified memory-limited worker or export as text')


def _pdf_limits() -> Any:
    _pdf_platform()
    if sys.platform.startswith('linux'):
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (PDF_MEMORY_BYTES, PDF_MEMORY_BYTES))
        resource.setrlimit(resource.RLIMIT_CPU, (PDF_CPU_SECONDS, PDF_CPU_SECONDS))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
        return None
    if sys.platform == 'darwin':
        import resource
        # Finite DATA limits are rejected on verified macOS kernels. The
        # parent's RSS watchdog is the only memory control on this platform.
        resource.setrlimit(resource.RLIMIT_CPU, (PDF_CPU_SECONDS, PDF_CPU_SECONDS))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
        return None
    import ctypes
    from ctypes import wintypes
    class Basic(ctypes.Structure):
        _fields_ = [('ProcessTime', ctypes.c_int64), ('JobTime', ctypes.c_int64),
                    ('Flags', wintypes.DWORD), ('MinWS', ctypes.c_size_t), ('MaxWS', ctypes.c_size_t),
                    ('Active', wintypes.DWORD), ('Affinity', ctypes.c_size_t),
                    ('Priority', wintypes.DWORD), ('Scheduling', wintypes.DWORD)]
    class Counters(ctypes.Structure):
        _fields_ = [(n, ctypes.c_uint64) for n in ('ReadOps', 'WriteOps', 'OtherOps', 'ReadBytes', 'WriteBytes', 'OtherBytes')]
    class Extended(ctypes.Structure):
        _fields_ = [('Basic', Basic), ('IO', Counters), ('ProcessMemory', ctypes.c_size_t),
                    ('JobMemory', ctypes.c_size_t), ('PeakProcess', ctypes.c_size_t), ('PeakJob', ctypes.c_size_t)]
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel.SetInformationJobObject.restype = wintypes.BOOL
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.CreateJobObjectW(None, None)
    limits = Extended()
    limits.Basic.Flags = 0x100 | 0x2  # PROCESS_MEMORY and PROCESS_TIME; no advisory RSS limit.
    limits.Basic.ProcessTime = PDF_CPU_SECONDS * 10_000_000
    limits.ProcessMemory = PDF_MEMORY_BYTES
    if not handle or not kernel.SetInformationJobObject(handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)) or not kernel.AssignProcessToJobObject(handle, kernel.GetCurrentProcess()):
        if handle:
            kernel.CloseHandle(handle)
        raise _error('PDF resource isolation could not be established; export as text')
    return handle


class _DarwinRSS:
    """Current child RSS via libproc; no process-listing helper or task port."""

    def __init__(self) -> None:
        import ctypes

        class TaskInfo(ctypes.Structure):
            # Public proc_taskinfo ABI: six uint64 fields, then twelve int32.
            _fields_ = [(name, ctypes.c_uint64) for name in (
                'virtual_size', 'resident_size', 'total_user', 'total_system', 'threads_user', 'threads_system'
            )] + [(name, ctypes.c_int32) for name in (
                'policy', 'faults', 'pageins', 'cow_faults', 'messages_sent', 'messages_received',
                'syscalls_mach', 'syscalls_unix', 'csw', 'threadnum', 'numrunning', 'priority'
            )]

        # An absolute system-library path avoids find_library's possible helpers.
        self._library = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
        self._query = self._library.proc_pidinfo
        self._query.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
        self._query.restype = ctypes.c_int
        self._info = TaskInfo()

    def __call__(self, pid: int) -> int:
        import ctypes
        size = ctypes.sizeof(self._info)
        received = self._query(pid, 4, 0, ctypes.byref(self._info), size)  # PROC_PIDTASKINFO
        if received != size:
            raise OSError(ctypes.get_errno(), 'could not sample child RSS')
        return int(self._info.resident_size)


def _wait_pdf_worker(process: subprocess.Popen[bytes], rss: Callable[[int], int] | None) -> None:
    if rss is None:
        process.wait(timeout=PDF_TIMEOUT_SECONDS)
        return
    deadline = time.monotonic() + PDF_TIMEOUT_SECONDS
    while process.poll() is None:
        if time.monotonic() >= deadline:
            raise subprocess.TimeoutExpired(process.args, PDF_TIMEOUT_SECONDS)
        try:
            resident = rss(process.pid)
        except OSError as exc:
            # The process may exit between poll() and proc_pidinfo(). A live
            # worker without observable RSS must not continue unmonitored.
            if process.poll() is not None:
                return
            raise _error('PDF memory watchdog could not sample the worker; check sandbox process-info permissions') from exc
        if resident > PDF_MEMORY_BYTES:
            raise _error('PDF worker exceeded the resident-memory budget; split or simplify the PDF')
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise subprocess.TimeoutExpired(process.args, PDF_TIMEOUT_SECONDS)
        try:
            process.wait(timeout=min(PDF_RSS_POLL_SECONDS, remaining))
            return
        except subprocess.TimeoutExpired:
            continue


def _pdf_stderr_suffix(raw: bytes | bytearray, truncated: bool) -> str:
    if not raw and not truncated:
        return ''
    text = raw.decode('utf-8', 'replace')
    # Diagnostics are untrusted text; retain readable lines without terminal
    # escapes or invisible directional/control characters.
    text = ''.join(c if c.isprintable() or c in '\n\t' else '?' for c in text)
    return '\nworker stderr: ' + text.rstrip() + ('\n[stderr truncated]' if truncated else '')


def _pdf_request(raw: bytes, operation: str, **options: int) -> dict[str, Any]:
    _pdf_platform()
    try:
        rss = _DarwinRSS() if sys.platform == 'darwin' else None
    except (OSError, AttributeError) as exc:
        raise _error('PDF memory watchdog could not start; check the macOS system library and sandbox permissions') from exc
    command = [sys.executable, '-I', '-B', os.path.abspath(__file__), '--document-pdf-worker', operation,
               json.dumps(options, separators=(',', ':'))]
    try:
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except OSError as exc:
        raise _error('PDF worker could not start; check the local Python installation') from exc
    chunks: list[bytes] = []
    stderr = bytearray()
    stderr_truncated = False
    faults: list[str] = []
    assert process.stdin is not None and process.stdout is not None and process.stderr is not None

    def send() -> None:
        try:
            process.stdin.write(raw)
        except (OSError, ValueError):
            pass  # A rejected document or a failed guard can close stdin early.
        finally:
            try:
                process.stdin.close()
            except (OSError, ValueError):
                pass

    def receive() -> None:
        total = 0
        try:
            while True:
                block = process.stdout.read(_CHUNK)
                if not block:
                    break
                total += len(block)
                if total > MAX_PDF_REPLY_BYTES:
                    faults.append('reply')
                    process.kill()
                    break
                chunks.append(block)
        except (OSError, ValueError):
            faults.append('pipe')
        finally:
            process.stdout.close()

    def receive_stderr() -> None:
        nonlocal stderr_truncated
        total = 0
        try:
            while True:
                block = process.stderr.read(_CHUNK)
                if not block:
                    break
                total += len(block)
                room = MAX_PDF_STDERR_BYTES - len(stderr)
                stderr.extend(block[:room])
                stderr_truncated = total > MAX_PDF_STDERR_BYTES
                # Continue draining after the retained prefix fills, so errors
                # cannot deadlock the child. Also bound a diagnostic flood.
                if total > MAX_PDF_STDERR_STREAM_BYTES:
                    faults.append('stderr_limit')
                    process.kill()
                    break
        except (OSError, ValueError):
            faults.append('stderr_pipe')
        finally:
            process.stderr.close()

    writer = threading.Thread(target=send, daemon=True)
    reader = threading.Thread(target=receive, daemon=True)
    diagnostic_reader = threading.Thread(target=receive_stderr, daemon=True)
    writer.start()
    reader.start()
    diagnostic_reader.start()
    failure: DocumentError | None = None
    try:
        _wait_pdf_worker(process, rss)
    except subprocess.TimeoutExpired as exc:
        process.kill()
        process.wait()
        failure = _error('PDF processing exceeded its resource budget; split or simplify the PDF')
        failure.__cause__ = exc
    except DocumentError as exc:
        process.kill()
        process.wait()
        failure = exc
    finally:
        writer.join()
        reader.join()
        diagnostic_reader.join()
    suffix = _pdf_stderr_suffix(stderr, stderr_truncated)
    if failure is not None:
        failure.args = (str(failure) + suffix,)
        raise failure
    if 'stderr_limit' in faults:
        raise _error('PDF worker exceeded its diagnostic output limit; check worker diagnostics' + suffix)
    if process.returncode != 0:
        raise _error(f'PDF worker exited with status {process.returncode}; check worker diagnostics and the local runtime' + suffix)
    if faults:
        raise _error('PDF worker exceeded its output budget or a worker pipe failed; check worker diagnostics' + suffix)
    payload = b''.join(chunks)
    if len(payload) < 4:
        raise _error('PDF worker returned no result; check worker diagnostics and the local runtime' + suffix)
    header_size = struct.unpack_from('>I', payload)[0]
    if header_size > 8 * MAX_OUTPUT_CHARS or header_size + 4 > len(payload):
        raise _error('PDF worker returned an invalid result; check worker diagnostics and the local runtime' + suffix)
    try:
        result = json.loads(payload[4:4 + header_size])
        if 'error' in result:
            exception = UnsupportedDocument if result.get('unsupported') else DocumentError
            raise exception(result['error'] + suffix)
        if operation == 'render':
            images = []
            offset = 4 + header_size
            lengths = result['lengths']
            count = result['rendered_count']
            total = result['declared_total']
            reason = result['stop_reason']
            if (not isinstance(lengths, list) or type(count) is not int or type(total) is not int
                    or not 0 <= count <= options['max_pages'] or not count <= total <= 10_000_000
                    or len(lengths) != count):
                raise ValueError('invalid render counts')
            if reason == 'document_ended':
                valid_stop = count == total
            elif reason == 'page_budget':
                valid_stop = count < total and count == options['max_pages']
            elif reason == 'aggregate_pixel_budget':
                valid_stop = count < min(total, options['max_pages'])
            else:
                valid_stop = False
            if not valid_stop:
                raise ValueError('inconsistent render stop reason')
            for size in lengths:
                if type(size) is not int or size < 0 or size > len(payload) - offset:
                    raise ValueError('invalid image size')
                images.append(payload[offset:offset + size])
                offset += size
            if offset != len(payload):
                raise ValueError('extra output')
            result['images'] = images
        return result
    except (ValueError, KeyError, TypeError) as exc:
        raise _error('PDF worker returned an invalid result; check worker diagnostics and the local runtime' + suffix) from exc


def _pdf_text(raw: bytes, max_chars: int) -> dict[str, Any]:
    """Quieten pypdf for the duration of this call, and only pypdf.

    This used to be ``logging.disable(logging.CRITICAL)`` with nothing to undo it. That call is
    process-wide and permanent: once DGC had read a single PDF, every logger in the process was
    silent for the rest of the run -- DGC's own warnings included. A suite run caught it because
    dgc.reasoning stopped being able to log its R1/R2 downgrade at all.
    """
    import logging
    quieted = [logging.getLogger(name) for name in ("pypdf", "pypdf.generic", "pypdf._reader")]
    levels = [logger.level for logger in quieted]
    for logger in quieted:
        logger.setLevel(logging.CRITICAL)
    try:
        return _pdf_text_quiet(raw, max_chars)
    finally:
        for logger, level in zip(quieted, levels):
            logger.setLevel(level)


def _pdf_text_quiet(raw: bytes, max_chars: int) -> dict[str, Any]:
    try:
        from pypdf import PdfReader, PageObject, apply_configuration
        from pypdf.generic import NameObject
    except ImportError as exc:
        raise UnsupportedDocument('error: PDF text extraction needs pypdf 6.19 or later; install the measured version') from exc
    # These decoder limits apply before decompression; the process limit covers the
    # parser's other allocations. Disable the optional external JBIG2 executable.
    with apply_configuration(maximum_declared_stream_length=MAX_INPUT_BYTES,
                             array_based_stream_maximum_output_length=8_000_000,
                             zlib_maximum_output_length=8_000_000,
                             lzw_maximum_output_length=8_000_000,
                             run_length_maximum_output_length=8_000_000,
                             jbig2_maximum_output_length=8_000_000,
                             image_maximum_buffer_size=8_000_000,
                             page_tree_maximum_entries=2048, page_tree_maximum_depth=64,
                             xform_maximum_invocations_per_extraction=128,
                             jbig2dec_binary=None):
        reader = PdfReader(io.BytesIO(raw), strict=True)
        if reader.is_encrypted:
            raise _error('PDF is encrypted; save an unencrypted copy')
        root = reader.root_object['/Pages']
        declared = root.get('/Count')
        if not isinstance(declared, int) or not 0 <= declared <= 10_000_000:
            raise _error('PDF page count is invalid; export a fresh copy')
        out = _Text(max_chars)
        summary: dict[str, Any] = {'pages_declared': int(declared), 'pages_read': 0}
        visited: set[tuple[int, int] | int] = set()
        nodes = 0
        def walk(ref: Any, inherited: dict[str, Any], depth: int) -> Iterator[Any]:
            nonlocal nodes
            nodes += 1
            if nodes > 2048 or depth > 64:
                raise _error('PDF page tree exceeds the safety limit; export a simpler PDF')
            identity = (ref.idnum, ref.generation) if hasattr(ref, 'idnum') else id(ref)
            if identity in visited:
                raise _error('PDF page tree contains a cycle or duplicate; export a fresh copy')
            visited.add(identity)
            obj = ref.get_object()
            inherited = dict(inherited)
            for key in ('/Resources', '/MediaBox', '/CropBox', '/Rotate'):
                if key in obj:
                    inherited[key] = obj[key]
            if obj.get('/Type') == '/Pages':
                kids = obj.get('/Kids')
                if not isinstance(kids, list):
                    raise _error('PDF page tree is corrupt; export a fresh copy')
                for kid in kids:
                    yield from walk(kid, inherited, depth + 1)
            elif obj.get('/Type') == '/Page':
                page = PageObject(reader)
                page.update(obj)
                for key, value in inherited.items():
                    if key not in page:
                        page[NameObject(key)] = value
                yield page
            else:
                raise _error('PDF page tree contains an invalid node; export a fresh copy')
        try:
            for page in walk(root, {}, 0):
                if summary['pages_read'] >= MAX_PDF_PAGES:
                    out.stop()
                out.add(page.extract_text() or '')
                out.add('\n')
                summary['pages_read'] += 1
            if summary['pages_read'] != declared:
                raise _error('PDF page count disagrees with its page tree; export a fresh copy')
        except _PrefixComplete:
            pass
        result = out.result('.pdf', summary)
        return {'text': result.text, 'truncated': result.truncated, 'summary': result.summary}


def _render_scale(width: float, height: float, pixels: int) -> float:
    if not math.isfinite(width) or not math.isfinite(height) or width <= 0 or height <= 0 or max(width, height) > 10_000_000:
        raise _error('PDF page dimensions are invalid or excessive; export a normal-size PDF')
    # Separate dimension caps also bound scanline overhead for very thin pages.
    scale = min(2.0, 8192 / width, 8192 / height, pixels / width, pixels / height, math.sqrt(pixels / width / height))
    for _ in range(64):
        if math.ceil(width * scale) * math.ceil(height * scale) <= pixels:
            return scale
        scale *= 0.95
    raise _error('PDF page aspect ratio exceeds the rendering budget; export a normal-size PDF')


def _png(width: int, height: int, stride: int, buffer: Any) -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(data, zlib.crc32(kind)))
    compressor = zlib.compressobj()
    parts = []
    view = memoryview(buffer).cast('B')
    for y in range(height):
        parts.append(compressor.compress(b'\0' + view[y * stride:y * stride + width * 3].tobytes()))
    parts.append(compressor.flush())
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>2I5B', width, height, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', b''.join(parts)) + chunk(b'IEND', b''))


def _pdf_render(raw: bytes, max_pages: int, max_pixels: int) -> RenderedPDF:
    try:
        import pypdfium2 as pdfium
        from pypdfium2 import raw as api
    except (ImportError, OSError) as exc:
        raise UnsupportedDocument('error: PDF renderer could not load; install the matching pypdfium2 wheel') from exc
    try:
        document = pdfium.PdfDocument(raw)
    except pdfium.PdfiumError as exc:
        raise _error('PDF is encrypted or corrupt; save an unencrypted complete copy') from exc
    images: list[bytes] = []
    total_pixels = total_bytes = 0
    try:
        if api.FPDF_GetSecurityHandlerRevision(document) != -1:
            raise _error('PDF is encrypted; save an unencrypted copy')
        declared_total = len(document)
        if not 0 <= declared_total <= 10_000_000:
            raise _error('PDF page count is invalid; export a fresh copy')
        for index in range(min(declared_total, max_pages)):
            remaining = MAX_RENDER_TOTAL_PIXELS - total_pixels
            if remaining <= 0:
                break
            page = document[index]
            try:
                scale = _render_scale(page.get_width(), page.get_height(), min(max_pixels, remaining))
                def bitmap_maker(width: int, height: int, format: int, **kwargs: Any) -> Any:
                    if width <= 0 or height <= 0 or width * height > min(max_pixels, remaining) or max(width, height) > 8192:
                        raise _error('PDF bitmap exceeds its allocation budget; reduce the page size')
                    return pdfium.PdfBitmap.new_native(width, height, format, **kwargs)
                bitmap = page.render(scale=scale, may_draw_forms=False, draw_annots=False,
                                     force_bitmap_format=api.FPDFBitmap_BGR, rev_byteorder=True,
                                     limit_image_cache=True, bitmap_maker=bitmap_maker)
                try:
                    data = _png(bitmap.width, bitmap.height, bitmap.stride, bitmap.buffer)
                    total_pixels += bitmap.width * bitmap.height
                    total_bytes += len(data)
                    if total_bytes > MAX_PDF_REPLY_BYTES - 4096:
                        raise _error('rendered PDF exceeds the output budget; render fewer pages')
                    images.append(data)
                finally:
                    bitmap.close()
            finally:
                page.close()
    finally:
        document.close()
    reason: RenderStopReason = ('document_ended' if len(images) == declared_total else
                                'page_budget' if len(images) == max_pages else 'aggregate_pixel_budget')
    return RenderedPDF(images, len(images), declared_total, reason)


def render_pdf_pages(raw: bytes, *, max_pages: int = 20, max_pixels: int = 2_000_000) -> RenderedPDF:
    """Return a bounded PNG prefix. max_pixels is per page; aggregate cap is 20M.

    A missing renderer gives an empty result with declared_total=None and reason
    renderer_unavailable. Zero page budget still opens the PDF to report its total.
    Darwin uses a polled RSS watchdog, not a hard allocation ceiling.
    """
    _integer(max_pages, 'max_pages', 0, MAX_RENDER_PAGES)
    _integer(max_pixels, 'max_pixels', 1, MAX_RENDER_PIXELS)
    _pdf_envelope(raw)
    if not _available('pypdfium2'):
        return RenderedPDF([], 0, None, 'renderer_unavailable')
    result = _pdf_request(raw, 'render', max_pages=max_pages, max_pixels=max_pixels)
    return RenderedPDF(result['images'], result['rendered_count'], result['declared_total'], result['stop_reason'])


def _pdf_worker_diagnostic(stage: str, exc: BaseException) -> None:
    # Avoid str(exc)/repr(arbitrary_object): a library exception can contain
    # large document-derived arguments. Preserve a bounded cause chain instead.
    lines: list[str] = []
    current: BaseException | None = exc
    for _ in range(3):
        if current is None:
            break
        arguments: list[str] = []
        for arg in current.args[:3]:
            if isinstance(arg, str):
                value = arg[:512]
            elif isinstance(arg, bytes):
                value = arg[:512].decode('utf-8', 'replace')
            elif arg is None or type(arg) is bool or (type(arg) is int and arg.bit_length() <= 64):
                value = str(arg)
            else:
                value = '<' + type(arg).__name__[:80] + '>'
            arguments.append(value)
        lines.append(type(current).__name__[:80] + ': ' + '; '.join(arguments))
        current = current.__cause__
    text = stage + ': ' + '\ncaused by: '.join(lines) + '\n'
    payload = text.encode('utf-8', 'replace')
    if len(payload) > MAX_PDF_STDERR_BYTES:
        marker = b'\n[exception detail truncated]\n'
        payload = payload[:MAX_PDF_STDERR_BYTES - len(marker)] + marker
    try:
        sys.stderr.buffer.write(payload)
        sys.stderr.buffer.flush()
    except (OSError, ValueError):
        pass  # A broken diagnostic pipe must not replace the original error.


def _pdf_worker(operation: str, options: dict[str, int]) -> None:
    images: list[bytes] = []
    stage = 'resource setup'
    try:
        guard = _pdf_limits()  # Retain the Windows job handle for the worker lifetime.
        stage = 'input validation'
        raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        _pdf_envelope(raw)
        if operation == 'text':
            stage = 'text extraction'
            result = _pdf_text(raw, **options)
        elif operation == 'render':
            stage = 'page rendering'
            rendered = _pdf_render(raw, **options)
            images = rendered.images
            result = {'lengths': [len(image) for image in images], 'rendered_count': rendered.rendered_count,
                      'declared_total': rendered.declared_total, 'stop_reason': rendered.stop_reason}
        else:
            raise _error('unknown PDF worker operation; check the integration')
    except (DocumentError, UnsupportedDocument) as exc:
        _pdf_worker_diagnostic(stage, exc)
        result = {'error': str(exc), 'unsupported': isinstance(exc, UnsupportedDocument)}
    except Exception as exc:
        _pdf_worker_diagnostic(stage, exc)
        remedy = ('check worker diagnostics and the local runtime' if stage == 'resource setup' else
                  'check worker diagnostics or re-export a simpler, unencrypted PDF')
        result = {'error': f'error: PDF worker failed during {stage}; {remedy}'}
    header = json.dumps(result, ensure_ascii=True, separators=(',', ':')).encode('ascii')
    if len(header) + sum(map(len, images)) + 4 > MAX_PDF_REPLY_BYTES:
        raise _error('PDF output exceeds the safety limit; reduce the requested output')
    sys.stdout.buffer.write(struct.pack('>I', len(header)))
    sys.stdout.buffer.write(header)
    for image in images:
        sys.stdout.buffer.write(image)
    sys.stdout.buffer.flush()


if __name__ == '__main__' and len(sys.argv) == 4 and sys.argv[1] == '--document-pdf-worker':
    _pdf_worker(sys.argv[2], json.loads(sys.argv[3]))
