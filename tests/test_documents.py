"""Deterministic, in-memory fixtures. Optional PDF tests never fetch dependencies."""
from __future__ import annotations

import io
import json
import math
import os
import stat
import struct
import subprocess
import sys
import types
import unittest
from unittest import mock
from typing import Iterator
import zipfile
import zlib

from dgc import documents as d

REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
ODF_NS = ('xmlns:office="' + d._O + '" '
          'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" '
          'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" '
          'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"')
PDF_PLATFORM = sys.platform.startswith('linux') or sys.platform in ('win32', 'darwin')
HAS_TEXT = d._available('pypdf') and PDF_PLATFORM
HAS_RENDER = d._available('pypdfium2') and PDF_PLATFORM


def archive(parts: dict[str, str | bytes], *, compression: int = zipfile.ZIP_DEFLATED) -> bytes:
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w', compression=compression) as z:
        for name, value in parts.items():
            info = zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))
            info.compress_type = compression
            z.writestr(info, value)
    return stream.getvalue()


def word(body: str = '<w:p><w:r><w:t>Hello document</w:t></w:r></w:p>') -> bytes:
    return archive({'word/document.xml': f'<w:document xmlns:w="{d._W}"><w:body>{body}</w:body></w:document>'})


def workbook(rows: str = '<row><c t="inlineStr"><is><t>Hello</t></is></c><c><v>42</v></c></row>', *, extra: dict[str, str] | None = None) -> bytes:
    parts = {
        'xl/workbook.xml': f'<workbook xmlns="{d._X}" xmlns:r="{R}"><sheets><sheet name="Budget" sheetId="1" r:id="r1"/></sheets></workbook>',
        'xl/_rels/workbook.xml.rels': f'<Relationships xmlns="{REL}"><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
        'xl/worksheets/sheet1.xml': f'<worksheet xmlns="{d._X}"><sheetData>{rows}</sheetData></worksheet>',
    }
    parts.update(extra or {})
    return archive(parts)


def presentation() -> bytes:
    parts = {
        'ppt/presentation.xml': f'<p:presentation xmlns:p="{d._P}" xmlns:r="{R}"><p:sldIdLst><p:sldId id="999" r:id="r10"/><p:sldId id="998" r:id="r2"/></p:sldIdLst></p:presentation>',
        'ppt/_rels/presentation.xml.rels': f'<Relationships xmlns="{REL}"><Relationship Id="r10" Target="slides/slide10.xml"/><Relationship Id="r2" Target="slides/slide2.xml"/></Relationships>',
    }
    for number, text in [(10, 'First'), (2, 'Second')]:
        parts[f'ppt/slides/slide{number}.xml'] = f'<p:sld xmlns:p="{d._P}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>{text}</a:t></a:r></a:p></p:sld>'
    return archive(parts)


def odf(fmt: str, body: str = '', *, extra: dict[str, str] | None = None) -> bytes:
    mime = next(k for k, v in d._ODF.items() if v == fmt)
    parts: dict[str, str | bytes] = {'mimetype': mime, 'content.xml': f'<office:document-content {ODF_NS}><office:body>{body}</office:body></office:document-content>'}
    parts.update(extra or {})
    return archive(parts)


def pdf(pages: int = 1, text: str = 'Hello PDF', *, compressed: bytes | None = None, box: str = '0 0 612 792') -> bytes:
    # Build a real xref table without importing either optional dependency.
    objects: list[bytes] = [b'<< /Type /Catalog /Pages 2 0 R >>', b'']
    page_ids = list(range(3, 3 + pages))
    stream_id, font_id = 3 + pages, 4 + pages
    objects[1] = f'<< /Type /Pages /Count {pages} /Kids ['.encode() + b' '.join(f'{n} 0 R'.encode() for n in page_ids) + b'] >>'
    for _ in page_ids:
        objects.append(f'<< /Type /Page /Parent 2 0 R /MediaBox [{box}] /Resources << /Font << /F1 {font_id} 0 R >> >> /Contents {stream_id} 0 R >>'.encode())
    stream = f'BT /F1 12 Tf 72 720 Td ({text}) Tj ET'.encode('ascii') if compressed is None else compressed
    filter_text = b'' if compressed is None else b' /Filter /FlateDecode'
    objects.append(b'<< /Length ' + str(len(stream)).encode() + filter_text + b' >>\nstream\n' + stream + b'\nendstream')
    objects.append(b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
    result = bytearray(b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')
    offsets = [0]
    for number, obj in enumerate(objects, 1):
        offsets.append(len(result))
        result.extend(f'{number} 0 obj\n'.encode() + obj + b'\nendobj\n')
    xref = len(result)
    result.extend(f'xref\n0 {len(offsets)}\n0000000000 65535 f \n'.encode())
    for offset in offsets[1:]:
        result.extend(f'{offset:010d} 00000 n \n'.encode())
    result.extend(f'trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode())
    return bytes(result)


def mutate_zip(raw: bytes, central: dict[int, tuple[str, int]] | None = None,
               local: dict[int, tuple[str, int]] | None = None) -> bytes:
    result = bytearray(raw)
    for base, values in [(result.index(b'PK\x01\x02'), central or {}), (0, local or {})]:
        for offset, (fmt, value) in values.items():
            struct.pack_into(fmt, result, base + offset, value)
    return bytes(result)


class FormatTests(unittest.TestCase):
    def test_word_paragraphs_tabs_and_table(self) -> None:
        result = d.extract_text(word('<w:p><w:r><w:t>One</w:t><w:tab/><w:t>Two</w:t><w:br/><w:t>Three &amp; four</w:t></w:r></w:p>'), 'report.docx')
        self.assertEqual(result.text, 'One\tTwo\nThree & four')
        self.assertEqual(result.format, '.docx')
        self.assertFalse(result.truncated)

    def test_xlsx_shared_strings_rich_inline_and_formula_are_literal(self) -> None:
        rows = '<row><c t="s"><v>0</v></c><c t="inlineStr"><is><r><t>rich</t></r><r><t> text</t></r></is></c><c><f>SUM(A1:A3)</f><v>7</v></c></row>'
        raw = workbook(rows, extra={'xl/sharedStrings.xml': f'<sst xmlns="{d._X}"><si><t>Shared</t></si></sst>'})
        result = d.extract_text(raw, 'data.xlsx')
        self.assertEqual(result.text, 'Budget\nShared\trich text\t=SUM(A1:A3) [cached: 7]')
        self.assertEqual(result.summary['sheets'], ['Budget'])

    def test_xlsx_sparse_coordinates_do_not_expand(self) -> None:
        raw = workbook('<row r="1048576"><c r="XFD1048576"><v>9</v></c></row>')
        self.assertEqual(d.extract_text(raw, 'x.xlsx').text, 'Budget\n9')

    def test_pptx_uses_relationship_order(self) -> None:
        result = d.extract_text(presentation(), 'deck.pptx')
        self.assertLess(result.text.index('First'), result.text.index('Second'))
        self.assertEqual(result.summary['slides'], 2)

    def test_odt_paragraph_space_and_tab(self) -> None:
        result = d.extract_text(odf('.odt', '<text:h>Heading</text:h><text:p>A<text:s text:c="2"/>B<text:tab/>C</text:p>'), 'a.odt')
        self.assertEqual(result.text, 'Heading\nA  B\tC')

    def test_ods_values_and_repeated_rows(self) -> None:
        body = '<table:table table:name="Sales"><table:table-row table:number-rows-repeated="2"><table:table-cell office:value="12"/><table:table-cell><text:p>Name</text:p></table:table-cell></table:table-row></table:table>'
        result = d.extract_text(odf('.ods', body), 's.ods')
        self.assertEqual(result.text, 'Sales\n12\tName\n12\tName')
        self.assertEqual(result.summary['rows_read'], 2)

    def test_odp_slides(self) -> None:
        raw = odf('.odp', '<draw:page><text:p>First</text:p></draw:page><draw:page><text:p>Second</text:p></draw:page>')
        result = d.extract_text(raw, 's.odp')
        self.assertEqual(result.text, 'Slide 1\nFirst\nSlide 2\nSecond')
        self.assertEqual(result.summary['slides'], 2)

    def test_csv_delimiter_and_quoted_newline(self) -> None:
        result = d.extract_text(b'a;b\n"one\ntwo";3\n', 's.csv')
        self.assertEqual(result.text, 'a\tb\none\ntwo\t3')

    def test_tsv(self) -> None:
        result = d.extract_text(b'a\tb\n1\t2', 's.tsv')
        self.assertEqual(result.summary['delimiter'], '\t')

    def test_rtf_controls_unicode_and_ignored_payload(self) -> None:
        raw = br'{\rtf1\ansi {\fonttbl{\f0 Secret;}}Hello\par \u233? \'e9 \{ok\}\tab {\pict\bin4 {}ab}end}'
        result = d.extract_text(raw, 's.rtf')
        self.assertEqual(result.text, 'Hello\n\u00e9 \u00e9 {ok}\tend')
        self.assertNotIn('Secret', result.text)

    def test_empty_documents_are_not_errors(self) -> None:
        for filename, raw in [('x.docx', word('')), ('x.xlsx', workbook('')), ('x.odt', odf('.odt')), ('x.ods', odf('.ods')), ('x.odp', odf('.odp')), ('x.csv', b''), ('x.tsv', b''), ('x.rtf', br'{\rtf1}')]:
            with self.subTest(filename=filename):
                self.assertFalse(d.extract_text(raw, filename).truncated)

    def test_output_limit_and_zero(self) -> None:
        raw = word('<w:p><w:r><w:t>1234567890</w:t></w:r></w:p>')
        self.assertEqual(d.extract_text(raw, 'a.docx', max_chars=5).text, '12345')
        self.assertTrue(d.extract_text(raw, 'a.docx', max_chars=5).truncated)
        self.assertEqual(d.extract_text(raw, 'a.docx', max_chars=0).text, '')

    def test_input_and_argument_limits(self) -> None:
        with mock.patch.object(d, 'MAX_INPUT_BYTES', 2), mock.patch.object(d, '_zip_entries') as parser:
            with self.assertRaises(d.DocumentError):
                d.extract_text(b'PKxxx', 'a.docx')
            parser.assert_not_called()
        for bad in (-1, True, 1.5, d.MAX_OUTPUT_CHARS + 1):
            with self.subTest(value=bad), self.assertRaises(ValueError):
                d.extract_text(b'', 'a.csv', max_chars=bad)
        with self.assertRaises(TypeError):
            d.sniff('a.csv', bytearray())  # type: ignore[arg-type]

    def test_known_unsupported_names_format_and_remedy(self) -> None:
        for fmt, (name, remedy) in d.UNSUPPORTED.items():
            with self.subTest(fmt=fmt):
                with self.assertRaises(d.UnsupportedDocument) as caught:
                    d.extract_text(b'', 'file' + fmt)
                self.assertIn(name, str(caught.exception))
                self.assertIn(remedy, str(caught.exception))
                self.assertTrue(str(caught.exception).startswith('error: this'))

    def test_content_wins_over_extension_png_and_docx(self) -> None:
        self.assertEqual(d.sniff('photo.docx', b'\x89PNG\r\n\x1a\nmore'), '.png')
        with self.assertRaisesRegex(d.UnsupportedDocument, 'PNG image'):
            d.extract_text(b'\x89PNG\r\n\x1a\nmore', 'photo.docx')
        self.assertEqual(d.extract_text(word(), 'photo.png').format, '.docx')
        self.assertEqual(d.sniff('opaque.data', word()), '.docx')
        self.assertEqual(d.sniff('not-word.docx', pdf()), '.pdf')

    def test_delimited_content_beats_mislabelled_extension(self) -> None:
        self.assertEqual(d.sniff('table.docx', b'a,b\n1,2\n'), '.csv')
        self.assertEqual(d.extract_text(b'a,b\n1,2\n', 'table.png').format, '.csv')
        self.assertEqual(d.sniff('table.csv', b'a\tb\n1\t2\n'), '.tsv')

    def test_sniff_unknown_and_plain_delimited_text(self) -> None:
        self.assertIsNone(d.sniff('x.bin', b'\x00\xff'))
        self.assertEqual(d.sniff('x.data', b'a,b\n1,2\n'), '.csv')

    def test_missing_pdf_backends_do_not_disable_office(self) -> None:
        with mock.patch.object(d, '_available', return_value=False):
            with self.assertRaisesRegex(d.UnsupportedDocument, 'pypdf'):
                d.extract_text(pdf(), 'a.pdf')
            self.assertEqual(d.render_pdf_pages(pdf()), d.RenderedPDF([], 0, None, 'renderer_unavailable'))
            self.assertIn('Hello', d.extract_text(word(), 'a.docx').text)

    def test_document_parsers_never_extract_to_disk(self) -> None:
        with mock.patch('builtins.open', side_effect=AssertionError('disk access')), \
             mock.patch.object(zipfile.ZipFile, 'extractall', side_effect=AssertionError('disk extraction')):
            for filename, raw in [('a.docx', word()), ('a.xlsx', workbook()), ('a.odt', odf('.odt')), ('a.csv', b'a,b\n')]:
                self.assertIsInstance(d.extract_text(raw, filename), d.ExtractedText)


class ZipSafetyTests(unittest.TestCase):
    def test_zip_bomb_four_gib_declaration_rejected_before_decompression(self) -> None:
        raw = mutate_zip(word(), central={24: ('<I', 0xfffffff0)})
        with mock.patch.object(zlib, 'decompressobj', side_effect=AssertionError('decompressed')), \
             mock.patch.object(zipfile, 'ZipFile', side_effect=AssertionError('allocated directory')):
            with self.assertRaisesRegex(d.DocumentError, 'expanded size'):
                d.extract_text(raw, 'bomb.docx')

    def test_zip_total_declared_size_checked_before_decompression(self) -> None:
        raw = archive({'a': 'a', 'b': 'b'})
        with mock.patch.object(d, 'MAX_ARCHIVE_BYTES', 1), mock.patch.object(zlib, 'decompressobj') as inflate:
            with self.assertRaisesRegex(d.DocumentError, 'expanded size'):
                d.sniff('x.docx', raw)
            inflate.assert_not_called()

    def test_forged_small_zip_size_is_detected_with_bounded_inflate(self) -> None:
        raw = mutate_zip(word('<w:p>' + 'a' * 20000 + '</w:p>'), central={24: ('<I', 10)}, local={22: ('<I', 10)})
        with self.assertRaisesRegex(d.DocumentError, 'exceeds its declared size'):
            d.extract_text(raw, 's.docx')

    def test_zip_traversal_absolute_drive_and_backslash_paths(self) -> None:
        for name in ['../evil', 'a/../evil', '/absolute', 'C:/evil', 'a\\b', './evil']:
            with self.subTest(name=name), self.assertRaisesRegex(d.DocumentError, 'unsafe path'):
                d.sniff('a.docx', archive({name: 'x'}))

    def test_zip_symlink_entry_rejected(self) -> None:
        raw = mutate_zip(word(), central={38: ('<I', (stat.S_IFLNK | 0o777) << 16)})
        with self.assertRaisesRegex(d.DocumentError, 'symlink'):
            d.sniff('a.docx', raw)

    def test_zip_duplicate_entries_rejected(self) -> None:
        data = archive({'abc': 'a', 'def': 'b'}, compression=0).replace(b'def', b'abc')
        with self.assertRaisesRegex(d.DocumentError, 'duplicate'):
            d.sniff('a.zip', data)

    def test_zip_crc_corruption_rejected(self) -> None:
        data = bytearray(word())
        entry = next(iter(d._zip_entries(bytes(data)).values()))
        data[entry.offset] ^= 0xff
        with self.assertRaises(d.DocumentError):
            d.extract_text(bytes(data), 'a.docx')

    def test_zip_directory_count_and_size_limited_before_indexing(self) -> None:
        for offset, fmt, value in [(10, '<H', 65000), (12, '<I', 4_000_000)]:
            data = bytearray(word())
            pos = data.index(b'PK\x05\x06')
            struct.pack_into(fmt, data, pos + offset, value)
            if offset == 10:
                struct.pack_into('<H', data, pos + 8, value)
            with self.subTest(offset=offset), self.assertRaises(d.DocumentError):
                d.sniff('a.docx', bytes(data))

    def test_zip_encrypted_flag_refused(self) -> None:
        raw = mutate_zip(word(), central={8: ('<H', 1)}, local={6: ('<H', 1)})
        with self.assertRaisesRegex(d.DocumentError, 'encrypted'):
            d.extract_text(raw, 'x.docx')

    def test_office_encrypted_ole_container_refused(self) -> None:
        raw = b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1' + 'EncryptedPackage'.encode('utf-16le')
        with self.assertRaisesRegex(d.DocumentError, 'encrypted'):
            d.extract_text(raw, 'secret.docx')

    def test_odf_encryption_manifest_refused_before_content(self) -> None:
        raw = odf('.odt', extra={'META-INF/manifest.xml': '<manifest><encryption-data/></manifest>', 'content.xml': 'unparseable ciphertext'})
        with self.assertRaisesRegex(d.DocumentError, 'encrypted'):
            d.extract_text(raw, 'a.odt')

    def test_conflicting_office_formats_rejected(self) -> None:
        with self.assertRaisesRegex(d.DocumentError, 'conflicting'):
            d.sniff('a.docx', archive({'word/document.xml': '', 'xl/workbook.xml': ''}))

    def test_external_sheet_relationship_not_followed(self) -> None:
        raw = workbook(extra={'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="r1" TargetMode="External" Target="https://example.invalid/private"/></Relationships>'})
        with self.assertRaisesRegex(d.DocumentError, 'external sheet'):
            d.extract_text(raw, 'x.xlsx')


class XMLSafetyTests(unittest.TestCase):
    def check_payload(self, payload: bytes | str) -> None:
        with self.assertRaisesRegex(d.DocumentError, 'entities and DTDs'):
            d.extract_text(archive({'word/document.xml': payload}), 'attack.docx')

    def test_xml_billion_laughs_entities_rejected(self) -> None:
        self.check_payload('<!DOCTYPE a [<!ENTITY a "lol"><!ENTITY b "&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;">]><a>&c;</a>')

    def test_xml_quadratic_entity_expansion_rejected(self) -> None:
        self.check_payload('<!DOCTYPE a [<!ENTITY big "' + 'a' * 1000 + '">]><a>' + '&big;' * 1000 + '</a>')

    def test_xml_external_entity_never_resolved(self) -> None:
        with mock.patch('builtins.open', side_effect=AssertionError('external access')):
            self.check_payload('<!DOCTYPE a [<!ENTITY ext SYSTEM "file:///etc/passwd">]><a>&ext;</a>')

    def test_utf16_dtd_cannot_bypass_entity_guard(self) -> None:
        self.check_payload('<?xml version="1.0" encoding="UTF-16"?><!DOCTYPE a [<!ENTITY x "bad">]><a>&x;</a>'.encode('utf-16'))

    def test_entity_resolution_explicitly_disabled(self) -> None:
        parser = mock.Mock(CurrentByteIndex=0)
        with mock.patch.object(d.expat, 'ParserCreate', return_value=parser):
            d._xml(d._Archive(word()), 'word/document.xml')
        parser.SetParamEntityParsing.assert_called_once_with(d.expat.XML_PARAM_ENTITY_PARSING_NEVER)
        for handler in [parser.EntityDeclHandler, parser.ExternalEntityRefHandler, parser.StartDoctypeDeclHandler]:
            with self.assertRaises(d.DocumentError):
                handler()

    def test_xml_node_budget(self) -> None:
        with mock.patch.object(d, 'MAX_XML_NODES', 5), self.assertRaisesRegex(d.DocumentError, 'structure'):
            d.extract_text(word('<w:p/><w:p/><w:p/><w:p/>'), 'a.docx')

    def test_xml_text_budget(self) -> None:
        with mock.patch.object(d, 'MAX_XML_TEXT', 5), self.assertRaisesRegex(d.DocumentError, 'XML text'):
            d.extract_text(word(), 'a.docx')

    def test_xml_depth_budget(self) -> None:
        with self.assertRaisesRegex(d.DocumentError, 'structure'):
            d.extract_text(word('<x>' * 70 + '</x>' * 70), 'a.docx')

    def test_xml_byte_budget_before_parser_feed(self) -> None:
        parser = mock.Mock(CurrentByteIndex=0)
        with mock.patch.object(d.expat, 'ParserCreate', return_value=parser), mock.patch.object(d, 'MAX_XML_BYTES', 1):
            with self.assertRaisesRegex(d.DocumentError, 'XML bytes'):
                d._xml(d._Archive(word()), 'word/document.xml')
            parser.Parse.assert_not_called()

    def test_wrong_xml_root_rejected(self) -> None:
        with self.assertRaisesRegex(d.DocumentError, 'wrong root'):
            d.extract_text(archive({'word/document.xml': '<notword/>'}), 'x.docx')


class CorruptionTests(unittest.TestCase):
    def test_truncated_docx(self) -> None:
        with self.assertRaises(d.DocumentError):
            d.extract_text(word()[:-5], 'a.docx')

    def test_corrupt_docx_xml(self) -> None:
        with self.assertRaises(d.DocumentError):
            d.extract_text(word('<w:p>'), 'a.docx')

    def test_truncated_xlsx(self) -> None:
        with self.assertRaises(d.DocumentError):
            d.extract_text(workbook()[:-5], 'a.xlsx')

    def test_corrupt_xlsx_xml(self) -> None:
        with self.assertRaises(d.DocumentError):
            d.extract_text(workbook(extra={'xl/worksheets/sheet1.xml': '<worksheet'}), 'a.xlsx')

    def test_truncated_pptx(self) -> None:
        with self.assertRaises(d.DocumentError):
            d.extract_text(presentation()[:-5], 'a.pptx')

    def test_corrupt_pptx_xml(self) -> None:
        with self.assertRaises(d.DocumentError):
            d.extract_text(archive({'ppt/presentation.xml': '<presentation'}), 'a.pptx')

    def test_truncated_odt(self) -> None:
        with self.assertRaises(d.DocumentError):
            d.extract_text(odf('.odt')[:-5], 'a.odt')

    def test_corrupt_odt_xml(self) -> None:
        with self.assertRaises(d.DocumentError):
            d.extract_text(odf('.odt', extra={'content.xml': '<office:'}), 'a.odt')

    def test_truncated_ods(self) -> None:
        with self.assertRaises(d.DocumentError):
            d.extract_text(odf('.ods')[:-5], 'a.ods')

    def test_corrupt_ods_xml(self) -> None:
        with self.assertRaises(d.DocumentError):
            d.extract_text(odf('.ods', extra={'content.xml': '<office:'}), 'a.ods')

    def test_truncated_odp(self) -> None:
        with self.assertRaises(d.DocumentError):
            d.extract_text(odf('.odp')[:-5], 'a.odp')

    def test_corrupt_odp_xml(self) -> None:
        with self.assertRaises(d.DocumentError):
            d.extract_text(odf('.odp', extra={'content.xml': '<office:'}), 'a.odp')

    def test_truncated_csv_quote(self) -> None:
        with self.assertRaises(d.DocumentError):
            d.extract_text(b'a,b\n"unterminated', 'a.csv')

    def test_corrupt_csv_quote(self) -> None:
        with self.assertRaises(d.DocumentError):
            d.extract_text(b'a,b\n"one"garbage,two', 'a.csv')

    def test_truncated_tsv_quote(self) -> None:
        with self.assertRaises(d.DocumentError):
            d.extract_text(b'a\tb\n"unterminated', 'a.tsv')

    def test_corrupt_tsv_binary(self) -> None:
        with self.assertRaises(d.DocumentError):
            d.extract_text(b'a\tb\x00', 'a.tsv')

    def test_truncated_rtf_group(self) -> None:
        with self.assertRaises(d.DocumentError):
            d.extract_text(br'{\rtf1 text', 'a.rtf')

    def test_corrupt_rtf_hex(self) -> None:
        with self.assertRaises(d.DocumentError):
            d.extract_text(br"{\rtf1 \'GG}", 'a.rtf')

    def test_truncated_pdf_envelope_before_backend(self) -> None:
        with mock.patch.object(d, '_pdf_request') as request:
            with self.assertRaises(d.DocumentError):
                d.extract_text(pdf()[:-6], 'a.pdf')
            request.assert_not_called()

    def test_corrupt_pdf_header(self) -> None:
        with self.assertRaises(d.DocumentError):
            d.extract_text(b'not PDF', 'a.pdf')


class LargeAndEncodingTests(unittest.TestCase):
    def test_one_million_row_xlsx_returns_bounded_prefix(self) -> None:
        raw = workbook('<row><c><v>1</v></c></row>' * 1_000_000)
        read_bytes = [0]
        original = d._Archive.chunks
        def tracked(a: d._Archive, name: str) -> Iterator[bytes]:
            for block in original(a, name):
                read_bytes[0] += len(block)
                yield block
        with mock.patch.object(d._Archive, 'chunks', tracked):
            result = d.extract_text(raw, 'million.xlsx')
        self.assertTrue(result.truncated)
        self.assertEqual(result.summary['rows_read'], d.MAX_ROWS)
        self.assertLess(read_bytes[0], 400_000)

    def test_odf_one_million_repeated_rows_clamped_before_expansion(self) -> None:
        body = '<table:table table:name="Data"><table:table-row table:number-rows-repeated="1000000"><table:table-cell office:value="1"/></table:table-row></table:table>'
        result = d.extract_text(odf('.ods', body), 'million.ods')
        self.assertTrue(result.truncated)
        self.assertEqual(result.summary['rows_read'], d.MAX_ROWS)
        self.assertLess(len(result.text), 30_000)

    def test_odf_huge_column_repetition_never_allocated(self) -> None:
        body = '<table:table><table:table-row><table:table-cell table:number-columns-repeated="1000000000" office:value="x"/></table:table-row></table:table>'
        result = d.extract_text(odf('.ods', body), 'wide.ods')
        self.assertTrue(result.truncated)
        self.assertLess(len(result.text), 100)

    def test_csv_rows_are_bounded(self) -> None:
        raw = b'a,b\n' * (d.MAX_ROWS + 100)
        result = d.extract_text(raw, 'a.csv')
        self.assertEqual(result.summary['rows_read'], d.MAX_ROWS)
        self.assertTrue(result.truncated)

    def test_utf16_csv_with_bom(self) -> None:
        result = d.extract_text('name,value\nRen\u00e9,12\n'.encode('utf-16'), 'data.csv')
        self.assertIn('Ren\u00e9', result.text)
        self.assertEqual(result.summary['encoding'], 'utf-16')

    def test_latin1_csv(self) -> None:
        result = d.extract_text(b'name,value\nRen\xe9,12\n', 'data.csv')
        self.assertIn('Ren\u00e9', result.text)
        self.assertEqual(result.summary['encoding'], 'latin-1')

    def test_invalid_utf8_mid_run_replaced(self) -> None:
        raw = b'a,b\n' * 2100 + b'bad\xff,12\n'
        result = d.extract_text(raw, 'data.csv')
        self.assertIn('bad\ufffd', result.text)
        self.assertEqual(result.summary['encoding'], 'utf-8')

    def test_incomplete_utf16_code_unit_replaced(self) -> None:
        raw = 'a,b\nx,y'.encode('utf-16') + b'\x61'
        self.assertIn('\ufffd', d.extract_text(raw, 'data.csv').text)

    def test_csv_formula_kept_literally_never_executed(self) -> None:
        with mock.patch.object(subprocess, 'Popen', side_effect=AssertionError('command executed')):
            result = d.extract_text(b'name,value\ncommand,=cmd|/C calc!A0\n', 'a.csv')
        self.assertIn('=cmd|/C calc!A0', result.text)

    def test_multiline_csv_record_budget(self) -> None:
        with mock.patch.object(d, 'MAX_FIELD_CHARS', 32), self.assertRaisesRegex(d.DocumentError, 'record'):
            d.extract_text(b'"' + b'xxxx\n' * 100 + b'",end', 'a.csv')

    def test_rtf_binary_length_checked_before_skip(self) -> None:
        with self.assertRaisesRegex(d.DocumentError, 'truncated'):
            d.extract_text(br'{\rtf1{\pict\bin999999999 a}}', 'a.rtf')

    def test_rtf_depth_and_control_integer_bounded(self) -> None:
        for raw in [br'{\rtf1' + b'{' * 100, br'{\rtf1\bin9999999999999999999 x}']:
            with self.subTest(raw=raw[:30]), self.assertRaises(d.DocumentError):
                d.extract_text(raw, 'a.rtf')


class PDFIsolationTests(unittest.TestCase):
    def test_unverified_platform_fails_closed_before_subprocess(self) -> None:
        with mock.patch.object(d.sys, 'platform', 'freebsd'), mock.patch.object(d.subprocess, 'Popen') as proc:
            with self.assertRaises(d.UnsupportedDocument):
                d._pdf_request(pdf(), 'text', max_chars=100)
            proc.assert_not_called()

    def test_guard_failure_precedes_document_read_and_optional_import(self) -> None:
        input_stream = mock.Mock()
        output = io.BytesIO()
        with mock.patch.object(d, '_pdf_limits', side_effect=d.DocumentError('error: isolation failed')), \
             mock.patch.object(d.sys, 'stdin', types.SimpleNamespace(buffer=input_stream)), \
             mock.patch.object(d.sys, 'stdout', types.SimpleNamespace(buffer=output)), \
             mock.patch.object(d, '_pdf_text') as backend, \
             mock.patch.object(d.sys, 'stderr', types.SimpleNamespace(buffer=io.BytesIO())):
            d._pdf_worker('text', {'max_chars': 100})
            input_stream.read.assert_not_called()
            backend.assert_not_called()
        self.assertIn(b'isolation failed', output.getvalue())

    @unittest.skipUnless(sys.platform.startswith('linux'), 'Linux resource API')
    def test_linux_memory_cpu_core_and_file_limits_are_hard(self) -> None:
        import resource
        with mock.patch.object(resource, 'setrlimit') as limits:
            d._pdf_limits()
        limits.assert_has_calls([mock.call(resource.RLIMIT_AS, (d.PDF_MEMORY_BYTES, d.PDF_MEMORY_BYTES)),
                                 mock.call(resource.RLIMIT_CPU, (d.PDF_CPU_SECONDS, d.PDF_CPU_SECONDS)),
                                 mock.call(resource.RLIMIT_CORE, (0, 0)), mock.call(resource.RLIMIT_FSIZE, (0, 0))])

    def test_timeout_kills_worker_without_sleep_or_clock_assertions(self) -> None:
        process = mock.Mock(stdin=io.BytesIO(), stdout=io.BytesIO(), stderr=io.BytesIO(), returncode=0)
        process.wait.side_effect = [subprocess.TimeoutExpired('worker', 12), 0]
        with mock.patch.object(d, '_pdf_platform'), mock.patch.object(d, '_DarwinRSS', return_value=None), mock.patch.object(d.subprocess, 'Popen', return_value=process):
            with self.assertRaisesRegex(d.DocumentError, 'resource budget'):
                d._pdf_request(pdf(), 'text', max_chars=10)
        process.wait.assert_any_call(timeout=d.PDF_TIMEOUT_SECONDS)
        process.kill.assert_called_once()

    def test_early_worker_refusal_closes_pipe_without_thread_traceback(self) -> None:
        source = mock.Mock()
        source.write.side_effect = BrokenPipeError
        source.close.side_effect = BrokenPipeError
        header = json.dumps({'error': 'error: isolation failed'}).encode()
        process = mock.Mock(stdin=source, stdout=io.BytesIO(struct.pack('>I', len(header)) + header), stderr=io.BytesIO(), returncode=0)
        with mock.patch.object(d, '_pdf_platform'), mock.patch.object(d, '_DarwinRSS', return_value=None), mock.patch.object(d.subprocess, 'Popen', return_value=process), \
             mock.patch.object(d.threading, 'excepthook') as thread_error:
            with self.assertRaisesRegex(d.DocumentError, 'isolation failed'):
                d._pdf_request(pdf(), 'text', max_chars=10)
            thread_error.assert_not_called()

    def test_worker_reply_is_bounded(self) -> None:
        process = mock.Mock(stdin=io.BytesIO(), stdout=io.BytesIO(b'x' * 100), stderr=io.BytesIO(), returncode=0)
        with mock.patch.object(d, '_pdf_platform'), mock.patch.object(d, '_DarwinRSS', return_value=None), mock.patch.object(d.subprocess, 'Popen', return_value=process), mock.patch.object(d, 'MAX_PDF_REPLY_BYTES', 10):
            with self.assertRaises(d.DocumentError):
                d._pdf_request(pdf(), 'text', max_chars=10)
        process.kill.assert_called_once()

    def test_pixel_area_including_rounding_is_checked_before_render(self) -> None:
        for width, height in [(612, 792), (10000, 1), (1, 10000), (1.1, 1.1), (123.7, 234.9)]:
            for budget in [1, 100, 10000, d.MAX_RENDER_PIXELS]:
                with self.subTest(width=width, height=height, budget=budget):
                    scale = d._render_scale(width, height, budget)
                    self.assertLessEqual(math.ceil(width * scale) * math.ceil(height * scale), budget)
        for width, height in [(float('inf'), 10), (float('nan'), 2), (-1, 2), (0, 1), (1e20, 1)]:
            with self.assertRaises(d.DocumentError):
                d._render_scale(width, height, 100)

    def test_render_parameters_checked_before_backend(self) -> None:
        for opts in [{'max_pages': 21}, {'max_pixels': 0}, {'max_pages': True}, {'max_pixels': 2_000_001}]:
            with self.subTest(opts=opts), self.assertRaises(ValueError):
                d.render_pdf_pages(pdf(), **opts)


@unittest.skipUnless(HAS_TEXT, 'optional pypdf and a supported resource guard are required')
class PDFTextTests(unittest.TestCase):
    def test_pdf_real_text(self) -> None:
        result = d.extract_text(pdf(), 's.pdf')
        self.assertIn('Hello PDF', result.text)
        self.assertEqual(result.summary['pages_declared'], 1)
        self.assertFalse(result.truncated)

    def test_pdf_empty_document(self) -> None:
        result = d.extract_text(pdf(0), 's.pdf')
        self.assertEqual(result.text, '')
        self.assertFalse(result.truncated)

    def test_five_thousand_page_pdf_returns_bounded_prefix(self) -> None:
        result = d.extract_text(pdf(5000), 'large.pdf')
        self.assertEqual(result.summary['pages_declared'], 5000)
        self.assertEqual(result.summary['pages_read'], d.MAX_PDF_PAGES)
        self.assertEqual(result.text.count('Hello PDF'), d.MAX_PDF_PAGES)
        self.assertTrue(result.truncated)

    def test_pdf_output_character_bound(self) -> None:
        result = d.extract_text(pdf(), 's.pdf', max_chars=5)
        self.assertEqual(result.text, 'Hello')
        self.assertTrue(result.truncated)

    def test_pdf_encryption_including_empty_user_password_refused(self) -> None:
        from pypdf import PdfWriter
        for password in ['secret', '']:
            writer = PdfWriter()
            writer.add_blank_page(100, 100)
            writer.encrypt(user_password=password, owner_password='owner')
            data = io.BytesIO()
            writer.write(data)
            with self.subTest(password=password), self.assertRaisesRegex(d.DocumentError, 'encrypted'):
                d.extract_text(data.getvalue(), 's.pdf')

    def test_corrupt_pdf_with_complete_envelope(self) -> None:
        with self.assertRaises(d.DocumentError):
            d.extract_text(b'%PDF-1.4\ngarbage\n%%EOF', 'a.pdf')

    def test_pdf_deflate_bomb_hits_decoder_budget(self) -> None:
        raw = pdf(compressed=zlib.compress(b' ' * 8_000_001))
        with self.assertRaises(d.DocumentError):
            d.extract_text(raw, 'bomb.pdf')

    def test_pdf_cycle_refused(self) -> None:
        raw = pdf().replace(b'/Kids [3 0 R]', b'/Kids [2 0 R]')
        with self.assertRaises(d.DocumentError):
            d.extract_text(raw, 'cycle.pdf')


@unittest.skipUnless(HAS_RENDER, 'optional pypdfium2 and a supported resource guard are required')
class PDFRenderTests(unittest.TestCase):
    def test_pdf_render_png_dimensions_and_page_limit(self) -> None:
        result = d.render_pdf_pages(pdf(3), max_pages=2, max_pixels=10000)
        images = result.images
        self.assertEqual((result.rendered_count, result.declared_total, result.stop_reason), (2, 3, 'page_budget'))
        self.assertEqual(len(images), 2)
        for image in images:
            self.assertTrue(image.startswith(b'\x89PNG\r\n\x1a\n'))
            width, height = struct.unpack_from('>II', image, 16)
            self.assertLessEqual(width * height, 10000)
            self.assertGreater(width * height, 0)
            position = 8
            while position < len(image):
                size = struct.unpack_from('>I', image, position)[0]
                kind = image[position + 4:position + 8]
                data = image[position + 8:position + 8 + size]
                checksum = struct.unpack_from('>I', image, position + 8 + size)[0]
                self.assertEqual(checksum, zlib.crc32(data, zlib.crc32(kind)))
                position += size + 12
            self.assertEqual(position, len(image))

    def test_pdf_renderer_corruption_is_document_error(self) -> None:
        with self.assertRaises(d.DocumentError):
            d.render_pdf_pages(b'%PDF-1.4\ngarbage\n%%EOF')

    def test_renderer_zero_pages(self) -> None:
        self.assertEqual(d.render_pdf_pages(pdf(), max_pages=0), d.RenderedPDF([], 0, 1, 'page_budget'))

    @unittest.skipUnless(HAS_TEXT, 'pypdf needed to generate encrypted fixture')
    def test_renderer_refuses_even_empty_password_encryption(self) -> None:
        from pypdf import PdfWriter
        for password in ['', 'secret']:
            writer = PdfWriter()
            writer.add_blank_page(100, 100)
            writer.encrypt(user_password=password, owner_password='owner')
            data = io.BytesIO()
            writer.write(data)
            with self.subTest(password=password), self.assertRaisesRegex(d.DocumentError, 'encrypted'):
                d.render_pdf_pages(data.getvalue())


class AdditionalBoundaryTests(unittest.TestCase):
    def test_xml_unfinished_attribute_is_bounded_before_large_allocation(self) -> None:
        payload = '<w:document xmlns:w="' + d._W + '" attribute="' + 'x' * 100_000 + '"><w:body/></w:document>'
        with self.assertRaisesRegex(d.DocumentError, 'XML token'):
            d.extract_text(archive({'word/document.xml': payload}), 'x.docx')

    def test_rtf_surrogate_pair_and_unpaired_surrogate(self) -> None:
        pair = d.extract_text(br'{\rtf1\u-10179?\u-8704?}', 'x.rtf')
        self.assertEqual(pair.text, chr(0x1f600))
        single = d.extract_text(br'{\rtf1\u-10179?}', 'x.rtf')
        self.assertEqual(single.text, chr(0xfffd))
        single.text.encode('utf-8')

    def test_stored_zip_archive(self) -> None:
        raw = archive({'word/document.xml': '<w:document xmlns:w="' + d._W + '"><w:body/></w:document>'}, compression=zipfile.ZIP_STORED)
        self.assertEqual(d.extract_text(raw, 'x.docx').text, '')

    def test_streaming_zip_descriptor_validated(self) -> None:
        class Nonseekable(io.BytesIO):
            def seekable(self) -> bool:
                return False
            def seek(self, *args: object) -> int:
                raise io.UnsupportedOperation('not seekable')
        stream = Nonseekable()
        with zipfile.ZipFile(stream, 'w', compression=zipfile.ZIP_DEFLATED) as z:
            z.writestr('word/document.xml', '<w:document xmlns:w="' + d._W + '"><w:body/></w:document>')
        raw = stream.getvalue()
        self.assertEqual(d.extract_text(raw, 'x.docx').text, '')
        corrupt = bytearray(raw)
        corrupt[corrupt.index(b'PK\x07\x08') + 4] ^= 1
        with self.assertRaisesRegex(d.DocumentError, 'descriptor'):
            d.extract_text(bytes(corrupt), 'x.docx')

    def test_xml_selected_content_validation_label(self) -> None:
        full = d.extract_text(word(), 'a.docx')
        prefix = d.extract_text(word(), 'a.docx', max_chars=3)
        self.assertEqual(full.summary['validation'], 'selected content')
        self.assertEqual(prefix.summary['validation'], 'prefix')

    def test_workbook_bad_shared_string_reference(self) -> None:
        with self.assertRaisesRegex(d.DocumentError, 'missing string'):
            d.extract_text(workbook('<row><c t="s"><v>999</v></c></row>'), 'x.xlsx')

    def test_relationship_cannot_escape_archive(self) -> None:
        extra = {'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="r1" Target="../../etc/passwd"/></Relationships>'}
        with self.assertRaisesRegex(d.DocumentError, 'escapes'):
            d.extract_text(workbook(extra=extra), 'x.xlsx')

    def test_csv_process_global_field_limit_is_not_changed(self) -> None:
        import csv
        before = csv.field_size_limit()
        d.extract_text(b'a,b\n1,2', 'x.csv')
        self.assertEqual(csv.field_size_limit(), before)

    def test_sniff_does_not_inflate_ooxml_content(self) -> None:
        with mock.patch.object(zlib, 'decompressobj', side_effect=AssertionError('inflated')):
            self.assertEqual(d.sniff('a.bin', word()), '.docx')

    def test_windows_guard_failure_fails_closed(self) -> None:
        import ctypes
        kernel = mock.Mock()
        kernel.CreateJobObjectW.return_value = 123
        kernel.SetInformationJobObject.return_value = False
        with mock.patch.object(d.sys, 'platform', 'win32'), mock.patch.object(ctypes, 'WinDLL', return_value=kernel, create=True):
            with self.assertRaisesRegex(d.DocumentError, 'isolation'):
                d._pdf_limits()
        kernel.AssignProcessToJobObject.assert_not_called()
        kernel.CloseHandle.assert_called_once_with(123)

    def test_windows_guard_configures_memory_and_cpu_before_assignment(self) -> None:
        import ctypes
        kernel = mock.Mock()
        kernel.CreateJobObjectW.return_value = 123
        kernel.SetInformationJobObject.return_value = True
        kernel.AssignProcessToJobObject.return_value = True
        with mock.patch.object(d.sys, 'platform', 'win32'), mock.patch.object(ctypes, 'WinDLL', return_value=kernel, create=True):
            self.assertEqual(d._pdf_limits(), 123)
        handle, kind, pointer, size = kernel.SetInformationJobObject.call_args.args
        self.assertEqual(handle, 123)
        self.assertEqual(kind, 9)
        self.assertEqual(pointer._obj.Basic.Flags, 0x102)
        self.assertEqual(pointer._obj.Basic.ProcessTime, d.PDF_CPU_SECONDS * 10_000_000)
        self.assertEqual(pointer._obj.ProcessMemory, d.PDF_MEMORY_BYTES)
        calls = kernel.mock_calls
        self.assertLess(next(i for i, c in enumerate(calls) if c[0] == 'SetInformationJobObject'),
                        next(i for i, c in enumerate(calls) if c[0] == 'AssignProcessToJobObject'))

    @unittest.skipUnless(HAS_RENDER, 'optional pypdfium2 and a supported resource guard are required')
    def test_renderer_allocation_guard_precedes_bitmap_creation(self) -> None:
        import pypdfium2 as pdfium
        fake = mock.Mock()
        fake.__len__ = mock.Mock(return_value=1)
        fake.__getitem__ = mock.Mock(return_value=mock.Mock())
        page = fake[0]
        page.get_width.return_value = 100
        page.get_height.return_value = 100
        def malicious_render(**kwargs: object) -> None:
            kwargs['bitmap_maker'](1_000_000, 1_000_000, 2)
        page.render.side_effect = malicious_render
        with mock.patch.object(pdfium, 'PdfDocument', return_value=fake), \
             mock.patch.object(pdfium.raw, 'FPDF_GetSecurityHandlerRevision', return_value=-1), \
             mock.patch.object(pdfium.PdfBitmap, 'new_native') as allocate:
            with self.assertRaisesRegex(d.DocumentError, 'allocation budget'):
                d._pdf_render(pdf(), 1, 10000)
            allocate.assert_not_called()

    @unittest.skipUnless(HAS_TEXT, 'optional pypdf and a supported resource guard are required')
    def test_text_path_does_not_flatten_all_pdf_pages(self) -> None:
        from pypdf import PdfReader
        from pypdf._page import PageObject
        with mock.patch.object(PdfReader, '_flatten', side_effect=AssertionError('flattened')), \
             mock.patch.object(PageObject, 'extract_text', return_value='sample') as extraction:
            result = d._pdf_text(pdf(5000), 200000)
        self.assertEqual(extraction.call_count, d.MAX_PDF_PAGES)
        self.assertTrue(result['truncated'])


def replace_parts(raw: bytes, updates: dict[str, str | bytes]) -> bytes:
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        parts = {name: z.read(name) for name in z.namelist()}
    parts.update(updates)
    return archive(parts)


def word_with_margins() -> bytes:
    body = ('<w:p><w:r><w:t>Body</w:t></w:r></w:p><w:sectPr>'
            '<w:headerReference w:type="default" r:id="h1"/>'
            '<w:footerReference w:type="first" r:id="f1"/></w:sectPr>')
    return archive({
        'word/document.xml': f'<w:document xmlns:w="{d._W}" xmlns:r="{R}"><w:body>{body}</w:body></w:document>',
        'word/_rels/document.xml.rels': f'<Relationships xmlns="{REL}"><Relationship Id="h1" Type="{R}/header" Target="headers/custom.xml"/><Relationship Id="f1" Type="{R}/footer" Target="footer7.xml"/></Relationships>',
        'word/headers/custom.xml': f'<w:hdr xmlns:w="{d._W}"><w:p><w:r><w:t>DOC-123</w:t></w:r></w:p></w:hdr>',
        'word/footer7.xml': f'<w:ftr xmlns:w="{d._W}"><w:p><w:r><w:t>Version 7</w:t></w:r></w:p></w:ftr>',
    })


def presentation_with_notes(text: str = 'Speaker detail') -> bytes:
    return replace_parts(presentation(), {
        'ppt/slides/_rels/slide10.xml.rels': f'<Relationships xmlns="{REL}"><Relationship Id="note" Type="{R}/notesSlide" Target="../notesSlides/custom.xml"/></Relationships>',
        'ppt/notesSlides/custom.xml': f'<p:notes xmlns:p="{d._P}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>{text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>',
    })


class AncillaryOfficeTests(unittest.TestCase):
    def test_docx_headers_and_footers_are_labelled_and_follow_relationships(self) -> None:
        result = d.extract_text(word_with_margins(), 'x.docx')
        self.assertIn('Header (default)\nDOC-123', result.text)
        self.assertIn('Footer (first)\nVersion 7', result.text)
        self.assertEqual(result.summary['headers_read'], 1)
        self.assertEqual(result.summary['footers_read'], 1)
        self.assertEqual(result.summary['paragraphs_read'], 3)

    def test_docx_shared_headers_are_emitted_once(self) -> None:
        raw = word_with_margins()
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            main = z.read('word/document.xml').decode()
        main = main.replace('</w:sectPr>', '<w:headerReference w:type="even" r:id="h1"/></w:sectPr>')
        result = d.extract_text(replace_parts(raw, {'word/document.xml': main}), 'x.docx')
        self.assertEqual(result.text.count('DOC-123'), 1)
        self.assertEqual(result.summary['headers_read'], 1)

    def test_docx_unreferenced_headers_not_opened(self) -> None:
        raw = replace_parts(word(), {'word/header1.xml': '<not even valid XML'})
        self.assertEqual(d.extract_text(raw, 'x.docx').text, 'Hello document')

    def test_docx_missing_external_and_mistyped_header_refused(self) -> None:
        targets = [('header', 'TargetMode="External" Target="file:///private/data"'),
                   ('footer', 'Target="headers/custom.xml"'), ('header', 'Target="missing.xml"')]
        for kind, target in targets:
            rels = f'<Relationships><Relationship Id="h1" Type="{R}/{kind}" {target}/></Relationships>'
            with self.subTest(target=target), self.assertRaises(d.DocumentError):
                d.extract_text(replace_parts(word_with_margins(), {'word/_rels/document.xml.rels': rels}), 'x.docx')

    def test_docx_header_traversal_refused(self) -> None:
        rels = f'<Relationships><Relationship Id="h1" Type="{R}/header" Target="../../outside.xml"/></Relationships>'
        with self.assertRaisesRegex(d.DocumentError, 'escapes'):
            d.extract_text(replace_parts(word_with_margins(), {'word/_rels/document.xml.rels': rels}), 'x.docx')

    def test_docx_header_and_footer_corruption_and_entities_are_refused(self) -> None:
        for part in ['word/headers/custom.xml', 'word/footer7.xml']:
            for value in ['<broken', '<!DOCTYPE x [<!ENTITY x "bad">]><x>&x;</x>']:
                with self.subTest(part=part, value=value), self.assertRaises(d.DocumentError):
                    d.extract_text(replace_parts(word_with_margins(), {part: value}), 'x.docx')

    def test_docx_header_obeys_output_and_shared_xml_budgets(self) -> None:
        result = d.extract_text(word_with_margins(), 'x.docx', max_chars=26)
        self.assertTrue(result.truncated)
        self.assertLessEqual(len(result.text), 26)
        with mock.patch.object(d, 'MAX_XML_TEXT', 10), self.assertRaisesRegex(d.DocumentError, 'XML text'):
            d.extract_text(word_with_margins(), 'x.docx')

    def test_pptx_speaker_notes_belong_to_the_correct_slide(self) -> None:
        result = d.extract_text(presentation_with_notes(), 'x.pptx')
        self.assertIn('Slide 1\nFirst\nNotes\nSpeaker detail', result.text)
        self.assertLess(result.text.index('Speaker detail'), result.text.index('Slide 2'))
        self.assertEqual(result.summary['notes_read'], 1)
        self.assertEqual(result.summary['slides_read'], 2)

    def test_pptx_notes_omit_slide_numbers_but_include_freeform_text(self) -> None:
        raw = presentation_with_notes()
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            notes = z.read('ppt/notesSlides/custom.xml').decode()
        shapes = ''.join(f'<p:sp><p:nvSpPr><p:nvPr><p:ph type="{kind}"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>omit-{kind}</a:t></a:r></a:p></p:txBody></p:sp>' for kind in ['sldNum', 'dt', 'hdr', 'ftr', 'sldImg'])
        shapes += '<p:sp><p:txBody><a:p><a:r><a:t>Freeform text</a:t></a:r></a:p></p:txBody></p:sp>'
        notes = notes.replace('</p:spTree>', shapes + '</p:spTree>')
        result = d.extract_text(replace_parts(raw, {'ppt/notesSlides/custom.xml': notes}), 'x.pptx')
        self.assertNotIn('omit-', result.text)
        self.assertIn('Speaker detail', result.text)
        self.assertIn('Freeform text', result.text)

    def test_pptx_unreferenced_notes_not_opened(self) -> None:
        raw = replace_parts(presentation(), {'ppt/notesSlides/notesSlide1.xml': '<broken'})
        self.assertEqual(d.extract_text(raw, 'x.pptx').summary['notes_read'], 0)

    def test_pptx_external_missing_or_multiple_notes_refused(self) -> None:
        for attrs in ['TargetMode="External" Target="https://example.invalid/notes"', 'Target="../notesSlides/missing.xml"']:
            rels = f'<Relationships><Relationship Id="n" Type="{R}/notesSlide" {attrs}/></Relationships>'
            with self.subTest(attrs=attrs), self.assertRaises(d.DocumentError):
                d.extract_text(replace_parts(presentation(), {'ppt/slides/_rels/slide10.xml.rels': rels}), 'x.pptx')
        rels = '<Relationships>' + ''.join(f'<Relationship Id="n{i}" Type="{R}/notesSlide" Target="../notesSlides/custom.xml"/>' for i in range(2)) + '</Relationships>'
        with self.assertRaisesRegex(d.DocumentError, 'conflicting speaker notes'):
            d.extract_text(replace_parts(presentation_with_notes(), {'ppt/slides/_rels/slide10.xml.rels': rels}), 'x.pptx')

    def test_pptx_notes_corruption_and_entities_refused(self) -> None:
        for value in ['<broken', '<!DOCTYPE x [<!ENTITY x "bad">]><x>&x;</x>']:
            with self.subTest(value=value), self.assertRaises(d.DocumentError):
                d.extract_text(replace_parts(presentation_with_notes(), {'ppt/notesSlides/custom.xml': value}), 'x.pptx')

    def test_pptx_notes_obey_output_and_shared_xml_budgets(self) -> None:
        result = d.extract_text(presentation_with_notes('x' * 100), 'x.pptx', max_chars=32)
        self.assertTrue(result.truncated)
        self.assertLessEqual(len(result.text), 32)
        self.assertIn('Notes', result.text)
        with mock.patch.object(d, 'MAX_XML_TEXT', 8), self.assertRaisesRegex(d.DocumentError, 'XML text'):
            d.extract_text(presentation_with_notes(), 'x.pptx')

    def test_strict_ooxml_gets_specific_refusal_without_accepting_namespaces(self) -> None:
        for part, namespace, tag, filename in [('word/document.xml', 'wordprocessingml/main', 'document', 'x.docx'),
                                              ('xl/workbook.xml', 'spreadsheetml/main', 'workbook', 'x.xlsx'),
                                              ('ppt/presentation.xml', 'presentationml/main', 'presentation', 'x.pptx')]:
            raw = archive({part: f'<{tag} xmlns="{d._STRICT}{namespace}"/>'})
            with self.subTest(filename=filename), self.assertRaisesRegex(d.UnsupportedDocument, 'strict OOXML'):
                d.extract_text(raw, filename)

    def test_strict_secondary_part_or_relationship_is_not_silently_skipped(self) -> None:
        header = f'<hdr xmlns="{d._STRICT}wordprocessingml/main"/>'
        with self.assertRaisesRegex(d.UnsupportedDocument, 'strict OOXML'):
            d.extract_text(replace_parts(word_with_margins(), {'word/headers/custom.xml': header}), 'x.docx')
        rels = f'<Relationships><Relationship Id="n" Type="{d._STRICT}officeDocument/relationships/notesSlide" Target="../notesSlides/custom.xml"/></Relationships>'
        with self.assertRaisesRegex(d.UnsupportedDocument, 'strict OOXML'):
            d.extract_text(replace_parts(presentation_with_notes(), {'ppt/slides/_rels/slide10.xml.rels': rels}), 'x.pptx')


class DarwinWatchdogTests(unittest.TestCase):
    def test_darwin_is_enabled(self) -> None:
        with mock.patch.object(d.sys, 'platform', 'darwin'):
            d._pdf_platform()

    @unittest.skipUnless(sys.platform != 'win32', 'resource module requires a POSIX test host')
    def test_darwin_uses_only_cpu_core_and_file_limits(self) -> None:
        import resource
        with mock.patch.object(d.sys, 'platform', 'darwin'), mock.patch.object(resource, 'setrlimit') as limits:
            d._pdf_limits()
        self.assertEqual(limits.call_args_list, [mock.call(resource.RLIMIT_CPU, (d.PDF_CPU_SECONDS, d.PDF_CPU_SECONDS)),
                                               mock.call(resource.RLIMIT_CORE, (0, 0)), mock.call(resource.RLIMIT_FSIZE, (0, 0))])

    def test_libproc_reads_current_rss_from_exact_public_abi(self) -> None:
        import ctypes
        library = mock.Mock()
        def query(pid: int, flavor: int, arg: int, pointer: object, size: int) -> int:
            self.assertEqual((pid, flavor, arg, size), (321, 4, 0, 96))
            self.assertEqual(type(pointer._obj).resident_size.offset, 8)
            pointer._obj.virtual_size = 999_999_999
            pointer._obj.resident_size = 123_456
            return size
        library.proc_pidinfo.side_effect = query
        with mock.patch.object(ctypes, 'CDLL', return_value=library) as load, mock.patch.object(subprocess, 'Popen', side_effect=AssertionError('helper spawned')):
            self.assertEqual(d._DarwinRSS()(321), 123_456)
        load.assert_called_once_with('/usr/lib/libproc.dylib', use_errno=True)
        self.assertEqual(library.proc_pidinfo.restype, ctypes.c_int)

    def test_libproc_denied_and_short_samples_do_not_reuse_stale_rss(self) -> None:
        import ctypes
        for received in [0, -1, 8, 95]:
            with self.subTest(received=received), mock.patch.object(ctypes, 'CDLL') as load:
                load.return_value.proc_pidinfo.return_value = received
                with self.assertRaises(OSError):
                    d._DarwinRSS()(123)

    def test_watchdog_load_failure_precedes_worker_spawn(self) -> None:
        with mock.patch.object(d.sys, 'platform', 'darwin'), mock.patch.object(d, '_DarwinRSS', side_effect=OSError), mock.patch.object(d.subprocess, 'Popen') as launch:
            with self.assertRaisesRegex(d.DocumentError, 'watchdog could not start'):
                d._pdf_request(pdf(), 'text', max_chars=10)
            launch.assert_not_called()

    def test_rss_is_sampled_repeatedly_without_real_waits(self) -> None:
        process = mock.Mock(pid=123)
        process.poll.return_value = None
        process.wait.side_effect = [subprocess.TimeoutExpired('worker', 0.05), 0]
        sample = mock.Mock(side_effect=[1024, d.PDF_MEMORY_BYTES])
        with mock.patch.object(d.time, 'monotonic', side_effect=[0, 0, 0, 0.05, 0.05]):
            d._wait_pdf_worker(process, sample)
        self.assertEqual(sample.call_args_list, [mock.call(123), mock.call(123)])
        self.assertEqual(process.wait.call_args_list, [mock.call(timeout=d.PDF_RSS_POLL_SECONDS)] * 2)
        process.kill.assert_not_called()

    def test_rss_breach_kills_and_reaps_worker_via_request(self) -> None:
        process = mock.Mock(pid=123, stdin=io.BytesIO(), stdout=io.BytesIO(), stderr=io.BytesIO(), returncode=0)
        process.poll.return_value = None
        with mock.patch.object(d.sys, 'platform', 'darwin'), mock.patch.object(d, '_DarwinRSS', return_value=mock.Mock(return_value=d.PDF_MEMORY_BYTES + 1)), \
             mock.patch.object(d.subprocess, 'Popen', return_value=process), mock.patch.object(d.time, 'monotonic', return_value=0):
            with self.assertRaisesRegex(d.DocumentError, 'resident-memory budget'):
                d._pdf_request(pdf(), 'text', max_chars=10)
        process.kill.assert_called_once()
        process.wait.assert_called_once_with()
        self.assertTrue(process.stdin.closed)
        self.assertTrue(process.stdout.closed)

    def test_unobservable_live_worker_is_killed_and_reaped(self) -> None:
        process = mock.Mock(pid=123, stdin=io.BytesIO(), stdout=io.BytesIO(), stderr=io.BytesIO(), returncode=0)
        process.poll.return_value = None
        with mock.patch.object(d.sys, 'platform', 'darwin'), mock.patch.object(d, '_DarwinRSS', return_value=mock.Mock(side_effect=OSError)), \
             mock.patch.object(d.subprocess, 'Popen', return_value=process), mock.patch.object(d.time, 'monotonic', return_value=0):
            with self.assertRaisesRegex(d.DocumentError, 'could not sample'):
                d._pdf_request(pdf(), 'text', max_chars=10)
        process.kill.assert_called_once()
        process.wait.assert_called_once_with()

    def test_process_exit_between_poll_and_sample_is_normal(self) -> None:
        process = mock.Mock(pid=123)
        process.poll.side_effect = [None, 0]
        with mock.patch.object(d.time, 'monotonic', return_value=0):
            d._wait_pdf_worker(process, mock.Mock(side_effect=OSError))
        process.kill.assert_not_called()
        process.wait.assert_not_called()

    def test_wall_timeout_uses_one_deadline_not_one_timeout_per_sample(self) -> None:
        process = mock.Mock(pid=123, stdin=io.BytesIO(), stdout=io.BytesIO(), stderr=io.BytesIO(), returncode=0)
        process.poll.return_value = None
        process.wait.side_effect = [subprocess.TimeoutExpired('worker', 0.05), 0]
        sample = mock.Mock(return_value=100)
        with mock.patch.object(d.sys, 'platform', 'darwin'), mock.patch.object(d, '_DarwinRSS', return_value=sample), \
             mock.patch.object(d.subprocess, 'Popen', return_value=process), \
             mock.patch.object(d.time, 'monotonic', side_effect=[0, 0, 0, d.PDF_TIMEOUT_SECONDS]):
            with self.assertRaisesRegex(d.DocumentError, 'resource budget'):
                d._pdf_request(pdf(), 'text', max_chars=10)
        process.kill.assert_called_once()
        sample.assert_called_once_with(123)
        self.assertEqual(process.wait.call_args_list, [mock.call(timeout=d.PDF_RSS_POLL_SECONDS), mock.call()])

    def test_last_poll_wait_is_clamped_to_remaining_wall_budget(self) -> None:
        process = mock.Mock(pid=123)
        process.poll.return_value = None
        with mock.patch.object(d.time, 'monotonic', side_effect=[0, 11.99, 11.99]):
            d._wait_pdf_worker(process, mock.Mock(return_value=1))
        self.assertAlmostEqual(process.wait.call_args.kwargs['timeout'], 0.01)

    @unittest.skipUnless(sys.platform == 'darwin', 'native libproc ABI smoke test requires macOS')
    def test_native_libproc_reports_positive_current_rss(self) -> None:
        self.assertGreater(d._DarwinRSS()(os.getpid()), 0)


class RenderMetadataTests(unittest.TestCase):
    def test_missing_renderer_reports_unknown_total_without_worker(self) -> None:
        with mock.patch.object(d, '_available', return_value=False), mock.patch.object(d, '_pdf_request') as worker:
            result = d.render_pdf_pages(pdf())
        self.assertEqual(result, d.RenderedPDF([], 0, None, 'renderer_unavailable'))
        worker.assert_not_called()

    def test_worker_serializes_render_metadata_and_png_lengths(self) -> None:
        output = io.BytesIO()
        rendered = d.RenderedPDF([b'png'], 1, 340, 'page_budget')
        with mock.patch.object(d, '_pdf_limits'), mock.patch.object(d, '_pdf_render', return_value=rendered), \
             mock.patch.object(d.sys, 'stdin', types.SimpleNamespace(buffer=io.BytesIO(pdf()))), \
             mock.patch.object(d.sys, 'stdout', types.SimpleNamespace(buffer=output)):
            d._pdf_worker('render', {'max_pages': 1, 'max_pixels': 100})
        payload = output.getvalue()
        length = struct.unpack_from('>I', payload)[0]
        header = json.loads(payload[4:4 + length])
        self.assertEqual(header, {'lengths': [3], 'rendered_count': 1, 'declared_total': 340, 'stop_reason': 'page_budget'})
        self.assertEqual(payload[4 + length:], b'png')

    def test_parent_rejects_inconsistent_render_metadata(self) -> None:
        valid = {'lengths': [], 'rendered_count': 0, 'declared_total': 1, 'stop_reason': 'page_budget'}
        for updates in [{'rendered_count': True}, {'declared_total': -1}, {'declared_total': None},
                        {'stop_reason': 'document_ended'}, {'rendered_count': 1}, {'lengths': [99999999]}, {'stop_reason': 'unknown'}]:
            header = json.dumps(dict(valid, **updates)).encode()
            process = mock.Mock(stdin=io.BytesIO(), stdout=io.BytesIO(struct.pack('>I', len(header)) + header), stderr=io.BytesIO(), returncode=0)
            with self.subTest(updates=updates), mock.patch.object(d, '_pdf_platform'), mock.patch.object(d, '_DarwinRSS', return_value=None), \
                 mock.patch.object(d.subprocess, 'Popen', return_value=process), self.assertRaisesRegex(d.DocumentError, 'invalid result'):
                d._pdf_request(pdf(), 'render', max_pages=0, max_pixels=1)

    @unittest.skipUnless(HAS_RENDER, 'optional pypdfium2 and worker isolation required')
    def test_render_document_end_wins_when_page_budget_equals_total(self) -> None:
        result = d.render_pdf_pages(pdf(1), max_pages=1, max_pixels=100)
        self.assertEqual((result.rendered_count, result.declared_total, result.stop_reason), (1, 1, 'document_ended'))

    @unittest.skipUnless(HAS_RENDER, 'optional pypdfium2 and worker isolation required')
    def test_render_page_budget_retains_large_total(self) -> None:
        result = d.render_pdf_pages(pdf(340), max_pages=20, max_pixels=100)
        self.assertEqual((len(result.images), result.rendered_count, result.declared_total, result.stop_reason), (20, 20, 340, 'page_budget'))

    @unittest.skipUnless(HAS_RENDER, 'optional pypdfium2 required for controlled in-process fixture')
    def test_aggregate_pixel_budget_stops_before_loading_another_page(self) -> None:
        import pypdfium2 as pdfium
        original = pdfium.PdfDocument.__getitem__
        visited = []
        def get_page(document: object, index: int) -> object:
            visited.append(index)
            return original(document, index)
        with mock.patch.object(d, 'MAX_RENDER_TOTAL_PIXELS', 100), mock.patch.object(pdfium.PdfDocument, '__getitem__', get_page):
            result = d._pdf_render(pdf(4, box='0 0 10 10'), 4, 100)
        self.assertEqual(result.stop_reason, 'aggregate_pixel_budget')
        self.assertEqual((result.rendered_count, result.declared_total), (1, 4))
        self.assertEqual(visited, [0])

    @unittest.skipUnless(HAS_RENDER, 'optional pypdfium2 required for controlled in-process fixture')
    def test_document_end_and_page_budget_take_precedence_over_simultaneous_pixel_budget(self) -> None:
        with mock.patch.object(d, 'MAX_RENDER_TOTAL_PIXELS', 100):
            ended = d._pdf_render(pdf(1, box='0 0 10 10'), 1, 100)
            limited = d._pdf_render(pdf(2, box='0 0 10 10'), 1, 100)
        self.assertEqual(ended.stop_reason, 'document_ended')
        self.assertEqual(limited.stop_reason, 'page_budget')


class WorkerDiagnosticTests(unittest.TestCase):
    def test_resource_setup_valueerror_keeps_stage_type_and_message(self) -> None:
        output, stderr = io.BytesIO(), io.BytesIO()
        error = ValueError('current limit exceeds maximum limit')
        with mock.patch.object(d, '_pdf_limits', side_effect=error), \
             mock.patch.object(d.sys, 'stdout', types.SimpleNamespace(buffer=output)), \
             mock.patch.object(d.sys, 'stderr', types.SimpleNamespace(buffer=stderr)), \
             mock.patch.object(d.sys, 'stdin') as input_stream:
            d._pdf_worker('text', {'max_chars': 100})
        input_stream.buffer.read.assert_not_called()
        diagnostic = stderr.getvalue().decode()
        self.assertIn('resource setup: ValueError: current limit exceeds maximum limit', diagnostic)
        size = struct.unpack_from('>I', output.getvalue())[0]
        error_text = json.loads(output.getvalue()[4:4 + size])['error']
        self.assertIn('resource setup', error_text)
        self.assertNotIn('corrupt', error_text)

    def test_stderr_attached_to_structured_and_missing_and_invalid_reply_errors(self) -> None:
        for header in [{'error': 'error: known refusal'}, {'error': 'error: missing backend', 'unsupported': True}, None, 'invalid-json']:
            if isinstance(header, dict):
                encoded = json.dumps(header).encode()
                output = struct.pack('>I', len(encoded)) + encoded
            else:
                output = b'' if header is None else b'\x00\x00\x00\x01x'
            process = mock.Mock(stdin=io.BytesIO(), stdout=io.BytesIO(output), stderr=io.BytesIO(b'ValueError: kernel refused call'), returncode=0)
            with self.subTest(header=header), mock.patch.object(d, '_pdf_platform'), mock.patch.object(d, '_DarwinRSS', return_value=None), \
                 mock.patch.object(d.subprocess, 'Popen', return_value=process) as launch:
                with self.assertRaises((d.DocumentError, d.UnsupportedDocument)) as caught:
                    d._pdf_request(pdf(), 'text', max_chars=10)
                self.assertIn('worker stderr: ValueError: kernel refused call', str(caught.exception))
                self.assertEqual(launch.call_args.kwargs['stderr'], subprocess.PIPE)
                self.assertTrue(process.stderr.closed)

    def test_nonzero_exit_includes_status_and_stderr(self) -> None:
        process = mock.Mock(stdin=io.BytesIO(), stdout=io.BytesIO(), stderr=io.BytesIO(b'loader: missing shared library'), returncode=23)
        with mock.patch.object(d, '_pdf_platform'), mock.patch.object(d, '_DarwinRSS', return_value=None), mock.patch.object(d.subprocess, 'Popen', return_value=process):
            with self.assertRaises(d.DocumentError) as caught:
                d._pdf_request(pdf(), 'text', max_chars=10)
        self.assertIn('status 23', str(caught.exception))
        self.assertIn('loader: missing shared library', str(caught.exception))

    def test_timeout_waits_for_diagnostic_reader_before_raising(self) -> None:
        process = mock.Mock(stdin=io.BytesIO(), stdout=io.BytesIO(), stderr=io.BytesIO(b'backend: stalled while opening stream'), returncode=0)
        process.wait.side_effect = [subprocess.TimeoutExpired('worker', 12), 0]
        with mock.patch.object(d, '_pdf_platform'), mock.patch.object(d, '_DarwinRSS', return_value=None), mock.patch.object(d.subprocess, 'Popen', return_value=process):
            with self.assertRaises(d.DocumentError) as caught:
                d._pdf_request(pdf(), 'text', max_chars=10)
        self.assertIn('resource budget', str(caught.exception))
        self.assertIn('stalled while opening stream', str(caught.exception))
        self.assertIsInstance(caught.exception.__cause__, subprocess.TimeoutExpired)
        process.kill.assert_called_once()
        self.assertTrue(process.stderr.closed)

    def test_diagnostic_prefix_truncated_but_pipe_drained(self) -> None:
        process = mock.Mock(stdin=io.BytesIO(), stdout=io.BytesIO(), stderr=io.BytesIO(b'prefix ' + b'x' * 100), returncode=1)
        with mock.patch.object(d, 'MAX_PDF_STDERR_BYTES', 16), mock.patch.object(d, '_pdf_platform'), \
             mock.patch.object(d, '_DarwinRSS', return_value=None), mock.patch.object(d.subprocess, 'Popen', return_value=process):
            with self.assertRaises(d.DocumentError) as caught:
                d._pdf_request(pdf(), 'text', max_chars=10)
        self.assertIn('prefix ' + 'x' * 9, str(caught.exception))
        self.assertNotIn('x' * 10, str(caught.exception))
        self.assertIn('[stderr truncated]', str(caught.exception))
        process.kill.assert_not_called()
        self.assertTrue(process.stderr.closed)

    def test_diagnostic_flood_kills_with_bounded_retained_output(self) -> None:
        process = mock.Mock(stdin=io.BytesIO(), stdout=io.BytesIO(), stderr=io.BytesIO(b'x' * 200), returncode=0)
        with mock.patch.object(d, 'MAX_PDF_STDERR_BYTES', 16), mock.patch.object(d, 'MAX_PDF_STDERR_STREAM_BYTES', 100), \
             mock.patch.object(d, '_pdf_platform'), mock.patch.object(d, '_DarwinRSS', return_value=None), \
             mock.patch.object(d.subprocess, 'Popen', return_value=process):
            with self.assertRaisesRegex(d.DocumentError, 'diagnostic output limit') as caught:
                d._pdf_request(pdf(), 'text', max_chars=10)
        self.assertIn('x' * 16, str(caught.exception))
        self.assertNotIn('x' * 17, str(caught.exception))
        process.kill.assert_called_once()
        process.wait.assert_called_once_with(timeout=d.PDF_TIMEOUT_SECONDS)

    def test_stderr_decode_replaces_invalid_bytes_and_neutralizes_controls(self) -> None:
        suffix = d._pdf_stderr_suffix(b'bad\xff\x1b[31m\x00\nnext', False)
        self.assertIn('bad\ufffd?[31m?', suffix)
        self.assertNotIn('\x1b', suffix)
        self.assertNotIn('\x00', suffix)
        self.assertIn('\nnext', suffix)

    def test_successful_reply_is_not_contaminated_by_stderr(self) -> None:
        expected = {'text': 'ok', 'truncated': False, 'summary': {}}
        header = json.dumps(expected).encode()
        process = mock.Mock(stdin=io.BytesIO(), stdout=io.BytesIO(struct.pack('>I', len(header)) + header), stderr=io.BytesIO(b'harmless warning'), returncode=0)
        with mock.patch.object(d, '_pdf_platform'), mock.patch.object(d, '_DarwinRSS', return_value=None), mock.patch.object(d.subprocess, 'Popen', return_value=process):
            self.assertEqual(d._pdf_request(pdf(), 'text', max_chars=10), expected)

    def test_exception_diagnostic_does_not_format_arbitrary_arguments(self) -> None:
        class Unformattable:
            def __str__(self) -> str:
                raise AssertionError('formatted arbitrary argument')
            def __repr__(self) -> str:
                raise AssertionError('formatted arbitrary argument')
        error = ValueError('x' * 100_000, Unformattable(), 10 ** 10000)
        error.__cause__ = OSError(22, 'invalid argument')
        stderr = io.BytesIO()
        with mock.patch.object(d.sys, 'stderr', types.SimpleNamespace(buffer=stderr)):
            d._pdf_worker_diagnostic('resource setup', error)
        self.assertLessEqual(len(stderr.getvalue()), d.MAX_PDF_STDERR_BYTES)
        self.assertIn(b'caused by: OSError: 22; invalid argument', stderr.getvalue())
        self.assertNotIn(b'x' * 513, stderr.getvalue())

    def test_real_worker_setup_failure_diagnostics_cross_process_pipes(self) -> None:
        source = ("import importlib.util, sys; "
                  "spec=importlib.util.spec_from_file_location('fixture_documents',sys.argv[1]); "
                  "module=importlib.util.module_from_spec(spec); sys.modules[spec.name]=module; spec.loader.exec_module(module); "
                  "exec(\"def fail():\\n raise ValueError('current limit exceeds maximum limit')\\n\"); "
                  "module._pdf_limits=fail; module._pdf_worker('text', {'max_chars':10})")
        original = subprocess.Popen
        def launch(command: list[str], **kwargs: object) -> subprocess.Popen[bytes]:
            return original([sys.executable, '-I', '-B', '-c', source, os.path.abspath(d.__file__)], **kwargs)
        with mock.patch.object(d.subprocess, 'Popen', side_effect=launch):
            with self.assertRaises(d.DocumentError) as caught:
                d._pdf_request(pdf(), 'text', max_chars=10)
        self.assertIn('resource setup', str(caught.exception))
        self.assertIn('worker stderr: resource setup: ValueError: current limit exceeds maximum limit', str(caught.exception))

    def test_real_child_stderr_larger_than_retained_prefix_does_not_block(self) -> None:
        source = "import sys; sys.stdin.buffer.read(); sys.stderr.buffer.write(b'native diagnostic: '+b'x'*60000); sys.stderr.flush(); sys.exit(23)"
        original = subprocess.Popen
        def launch(command: list[str], **kwargs: object) -> subprocess.Popen[bytes]:
            return original([sys.executable, '-I', '-B', '-c', source], **kwargs)
        with mock.patch.object(d.subprocess, 'Popen', side_effect=launch):
            with self.assertRaises(d.DocumentError) as caught:
                d._pdf_request(pdf(), 'text', max_chars=10)
        message = str(caught.exception)
        self.assertIn('status 23', message)
        self.assertIn('native diagnostic:', message)
        self.assertIn('[stderr truncated]', message)
        self.assertLess(len(message), d.MAX_PDF_STDERR_BYTES + 300)

    @unittest.skipUnless(sys.platform == 'darwin', 'native resource-limit smoke test requires macOS')
    def test_native_darwin_worker_resource_setup_without_optional_backends(self) -> None:
        source = ("import importlib.util, sys; "
                  "spec=importlib.util.spec_from_file_location('fixture_documents',sys.argv[1]); "
                  "module=importlib.util.module_from_spec(spec); sys.modules[spec.name]=module; spec.loader.exec_module(module); "
                  "module._pdf_text=lambda raw,max_chars: {'text':'kernel accepted limits','truncated':False,'summary':{}}; "
                  "module._pdf_worker('text', {'max_chars':100})")
        original = subprocess.Popen
        def launch(command: list[str], **kwargs: object) -> subprocess.Popen[bytes]:
            return original([sys.executable, '-I', '-B', '-c', source, os.path.abspath(d.__file__)], **kwargs)
        with mock.patch.object(d.subprocess, 'Popen', side_effect=launch):
            result = d._pdf_request(pdf(), 'text', max_chars=100)
        self.assertEqual(result['text'], 'kernel accepted limits')


if __name__ == '__main__':
    unittest.main()
