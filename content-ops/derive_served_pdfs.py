"""
Produce candidate served copies of the PDF source documents.

A served copy re-hosts a government document, and the captures embed raster images whose rights nothing in
the document clears: some name a commercial stock licensor in their own metadata, and most carry no rights
marking at all. So a candidate keeps the text layer byte-identical and keeps a raster image only when the
image's OWN metadata states Public Domain - its XMP metadata stream, or the EXIF / XMP / IPTC segments
inside its JPEG bytes. Every other raster image is replaced by a single light-grey pixel, or a mid-grey one
where the page draws light text on top of it. Vector drawing is untouched. The images that stay are downsampled and re-encoded as JPEG, which also keeps the two captures
over the platform's 25 MiB per-file cap servable.

A candidate also drops embedded files, the actions a viewer runs by itself (the document's open action and
every additional-actions entry), annotations that attach a file or play media, and links that open another
file or a program. Links within the document and to web addresses stay.

Page thumbnails are dropped. Every picture-shaped stream left in the document is classified, not only the ones a
page draws, so an image reachable only through an annotation appearance or a mask is covered too. Every object
no longer reachable from the document root is removed, before the images are classified and again after the
edits, so a thumbnail, a dropped embedded file or a replaced image's old mask does not ride along in the file.

This tool does not decide anything. It writes each candidate plus a record beside it
(`<source_id>.json`: the capture hash it came from, the derivation version, the Public Domain images each
page draws, the pages where a removed image was drawn mid grey, how many images were removed, and the JPEG
quality and pixel limit the kept ones were re-encoded with). The kept images and the mid-grey pages reach the
committed manifest, so a recapture that changes either shows in its pull request as pages to look at. `content-ops/serve-pdfs.mjs` independently verifies each
candidate against its capture with the same PDF reader the app uses and refuses one whose record does not
match the registry; `content-ops/verify-served-pdfs.mjs` counts the images every published page paints
against the record. The fidelity check reported here is advisory, so a bug in this script cannot ship a
document whose text layer moved.

Python owns this step because its PDF libraries expose in-place image replacement and Node's do not. The
decision and the verification stay in TypeScript, so this tool cannot ship anything on its own.

Run: python content-ops/derive_served_pdfs.py [source_id]
"""

import json
import os
import re
import sys

import pypdf
from PIL import Image
from pypdf._page import ImageFile
from pypdf._xobj_image_helpers import _xobj_to_image
from pypdf.generic import (
    ArrayObject,
    ContentStream,
    DecodedStreamObject,
    DictionaryObject,
    IndirectObject,
    NameObject,
    NumberObject,
    StreamObject,
)

# Step 0: Configuration
SOURCES_PATH = 'content/sources.yaml'
OUTPUT_DIR = 'content-ops/derived'
# Must equal DERIVATION_VERSION in content-ops/served-pdf-io.mjs. The publisher rejects a candidate whose
# record names another version, so a candidate made by older rules cannot publish under a new name.
DERIVATION_VERSION = '4'
# Quality of the re-encoded images. Lower shrinks more and blurs photographs sooner; the text layer is
# never touched at any setting, so this trades file size against how the page LOOKS, not against whether
# the highlight resolves.
JPEG_QUALITY = 70
# Images above this pixel count are downsampled first. Roughly 150 DPI across a letter page, which is the
# point where further resolution stops being visible on screen.
MAX_PIXELS = 1400 * 1400
# The only rights statement that keeps an image: an entry of its XMP rights field (dc:rights) reading exactly
# "Public Domain". The phrase anywhere else - a caption, a keyword, "not in the public domain" - keeps nothing.
RIGHTS_FIELD = re.compile(rb'<dc:rights\b[^>]*>(.*?)</dc:rights>', re.IGNORECASE | re.DOTALL)
RIGHTS_ENTRY = re.compile(rb'<rdf:li\b[^>]*>(.*?)</rdf:li>', re.IGNORECASE | re.DOTALL)
# Stock-photo licensors. Metadata that names one anywhere is never kept, whatever its rights field says: the
# captures carry photos licensed from these, and a licence does not become Public Domain by a second field.
STOCK_LICENSORS = re.compile(
    rb'getty|istock|adobe ?stock|stock\.adobe|shutterstock|rawpixel|monkeybusiness|alamy|dreamstime|123rf'
    rb'|depositphotos',
    re.IGNORECASE,
)
# JPEG segments that carry metadata: APP1 holds EXIF and XMP, APP13 holds the Photoshop block with IPTC.
METADATA_SEGMENTS = (0xE1, 0xED)
# The replacement for a removed image: one RGB pixel, drawn over the removed image's area. Light grey
# (#e9ecef), so the gap reads as "a picture was here" rather than as a blank or broken page.
BLANK_PIXEL = b'\xe9\xec\xef'
# The replacement where text on the removed image would not read on light grey - text set for a dark photo.
# Mid grey (#767676) is the lightest grey white text reads on at the 4.5:1 contrast bar; black text on it reads
# at 4.6:1.
MID_GREY_PIXEL = b'\x76\x76\x76'
# The two greys as RGB from 0 to 1, for working out what shows behind the text.
LIGHT_GREY = tuple(byte / 255 for byte in BLANK_PIXEL)
MID_GREY = tuple(byte / 255 for byte in MID_GREY_PIXEL)
# The contrast text needs against what shows behind it (WCAG 2 AA, normal-size text).
CONTRAST_BAR = 4.5
# Text render modes that draw nothing on screen: invisible, and clipping only.
INVISIBLE_RENDER_MODES = (3, 7)
# Path-painting operators that fill the path, so what they draw covers what was drawn before.
FILLING = (b'f', b'F', b'f*', b'B', b'B*', b'b', b'b*')
# The blend mode a drawing starts in: what is painted replaces what is under it.
NORMAL = '/Normal'
# The blend mode that multiplies what is painted into what is under it, so what is under it still shows.
MULTIPLY = '/Multiply'
# Annotation flags under which a viewer does not draw an annotation on screen (Invisible, Hidden, NoView).
NOT_DRAWN_FLAGS = 1 | 2 | 32
# Annotations a served copy never carries: each attaches a file or plays media.
DROPPED_ANNOTATIONS = {'/FileAttachment', '/Screen', '/RichMedia', '/Movie', '/Sound', '/3D'}
# Actions a served copy never carries: each opens another file or starts a program. They run on a click, so
# drop_active_content leaves them; the two in the captures point at a path on a designer's own computer.
DROPPED_ACTIONS = {'/GoToR', '/GoToE', '/Launch'}


def pdf_sources(sources_path):
    """
    Read the registry and return every PDF source with its captured file and recorded capture hash.

    Args:
        sources_path: Path to the sources-of-truth registry.

    Returns:
        A list of (source_id, captured_path, content_hash) tuples, largest capture first so the slowest work
        is visible at the start of a run rather than at the end.
    """
    text = open(sources_path, encoding='utf-8').read()
    current = None
    hashes = {}
    found = []
    for line in text.splitlines():
        head = re.match(r'- source_id:\s*(\S+)', line)
        if head:
            current = head.group(1)
        recorded = re.match(r'\s+content_hash:\s*(\S+)', line)
        if recorded and current:
            hashes[current] = recorded.group(1)
        captured = re.match(r'\s+captured_path:\s*(\S+)', line)
        if captured and current and captured.group(1).endswith('.pdf'):
            found.append((current, captured.group(1)))
    rows = [(source_id, path, hashes.get(source_id)) for source_id, path in found]
    rows.sort(key=lambda row: -os.path.getsize(row[1]) if os.path.exists(row[1]) else 0)
    return rows


def page_texts(path):
    """
    Extract the text of every page, for the advisory fidelity comparison.

    Args:
        path: Path to a PDF.

    Returns:
        A list of per-page strings.
    """
    reader = pypdf.PdfReader(path)
    return [(page.extract_text() or '') for page in reader.pages]


def filter_names(stream):
    """The names of a stream's filters, in the order they apply."""
    value = stream.get('/Filter')
    if value is None:
        return []
    value = value.get_object()
    if isinstance(value, ArrayObject):
        return [str(item.get_object()) for item in value]
    return [str(value)]


def jpeg_metadata(data):
    """
    Collect the metadata segments of a JPEG file: every APP1 and APP13 segment before the image data.

    Args:
        data: The bytes of a JPEG file.

    Returns:
        The segments' contents concatenated, or b'' when the bytes are not a JPEG file.
    """
    found = b''
    if data[:2] != b'\xff\xd8':
        return found
    index = 2
    while index + 4 <= len(data) and data[index] == 0xFF:
        marker = data[index + 1]
        if marker == 0xFF:
            index += 1
            continue
        if marker == 0x01 or 0xD0 <= marker <= 0xD8:
            index += 2
            continue
        # Start of scan and end of image: the metadata segments all come before the entropy-coded data.
        if marker in (0xDA, 0xD9):
            break
        length = (data[index + 2] << 8) | data[index + 3]
        if marker in METADATA_SEGMENTS:
            found += data[index + 4:index + 2 + length]
        index += 2 + length
    return found


def states_public_domain(metadata):
    """
    Whether an image's metadata states Public Domain.

    Args:
        metadata: The image's metadata bytes: its XMP stream and its JPEG metadata segments, concatenated.

    Returns:
        True when an entry of the rights field reads Public Domain and no stock licensor is named.
    """
    if STOCK_LICENSORS.search(metadata):
        return False
    for field in RIGHTS_FIELD.findall(metadata):
        for entry in RIGHTS_ENTRY.findall(field):
            if entry.strip().lower() == b'public domain':
                return True
    return False


# Metadata the keep rule must judge correctly before it may judge a real image: (metadata, expected).
KEEP_RULE_CASES = (
    (b'<dc:rights><rdf:Alt><rdf:li xml:lang="x-default">Public Domain</rdf:li></rdf:Alt></dc:rights>', True),
    (b'<dc:rights><rdf:Alt><rdf:li xml:lang="x-default">  public domain </rdf:li></rdf:Alt></dc:rights>', True),
    (b'<dc:rights><rdf:Alt><rdf:li xml:lang="x-default">Not in the public domain</rdf:li></rdf:Alt></dc:rights>',
     False),
    (b'<dc:subject><rdf:Bag><rdf:li>public domain</rdf:li></rdf:Bag></dc:subject>', False),
    (b'<dc:description><rdf:Alt><rdf:li>A public domain photo</rdf:li></rdf:Alt></dc:description>', False),
    (b'<dc:rights><rdf:Alt><rdf:li xml:lang="x-default">Public Domain</rdf:li></rdf:Alt></dc:rights>'
     b'<photoshop:Credit>Getty Images/iStockphoto</photoshop:Credit>', False),
    (b'<dc:rights><rdf:Alt><rdf:li xml:lang="x-default">Public Domain</rdf:li></rdf:Alt></dc:rights>'
     b'<xmpRights:WebStatement>https://stock.adobe.com/license-terms</xmpRights:WebStatement>', False),
    (b'', False),
)


def check_keep_rule():
    """
    Refuse to run when the keep rule misjudges any known case.

    A rule that keeps one wrong image re-hosts a stock photograph, and nothing downstream can tell: the served
    copy carries no metadata for a kept image. So the rule proves itself on every run, before it judges a real
    image.

    Raises:
        ValueError: When a case is misjudged.
    """
    wrong = [metadata for metadata, expected in KEEP_RULE_CASES if states_public_domain(metadata) != expected]
    if wrong:
        raise ValueError(f'keep rule misjudges {len(wrong)} known case(s)')


def grey_rule_cases():
    """
    Drawings the grey rule must judge correctly before it may judge a real page: (operations, resolver,
    expected darkened images). Each drawing places image 1 over the square from (10, 20) to (110, 70).
    """
    image = ([], b'q'), ([100, 0, 0, 50, 10, 20], b'cm'), ([NameObject('/Im0')], b'Do'), ([], b'Q')
    resolver = {'/Im0': ('image', 1)}
    white_inside = ([], b'BT'), ([1, 1, 1], b'rg'), ([1, 0, 0, 1, 20, 30], b'Tm'), (['x'], b'Tj'), ([], b'ET')
    form = [([], b'BT'), ([1], b'g'), ([20, 30], b'Td'), (['x'], b'Tj'), ([], b'ET')]
    with_form = dict(resolver, **{'/Fm0': ('form', 2, form, [1, 0, 0, 1, 0, 0], {})})
    return (
        ([*image, *white_inside], resolver, {1}),
        ([*white_inside, *image], resolver, set()),
        ([*image, ([], b'BT'), ([0, 0, 0], b'rg'), ([1, 0, 0, 1, 20, 30], b'Tm'), (['x'], b'Tj'), ([], b'ET')],
         resolver, set()),
        ([*image, ([], b'BT'), ([1, 1, 1], b'rg'), ([1, 0, 0, 1, 200, 30], b'Tm'), (['x'], b'Tj'), ([], b'ET')],
         resolver, set()),
        ([*image, ([3], b'Tr'), *white_inside], resolver, set()),
        ([*image, ([NameObject('/Fm0')], b'Do')], with_form, {1}),
        ([*image, ([], b'q'), ([1, 1, 1], b'rg'), ([], b'Q'), ([], b'BT'), ([1, 0, 0, 1, 20, 30], b'Tm'),
          (['x'], b'Tj'), ([], b'ET')], resolver, set()),
        ([*image, ([], b'BT'), ([0, 0, 0, 0], b'k'), ([20, 30], b'Td'), (['x'], b'Tj'), ([], b'ET')], resolver,
         {1}),
        ([*image, ([], b'BT'), ([0, 0, 0, 1], b'k'), ([20, 30], b'Td'), (['x'], b'Tj'), ([], b'ET')], resolver,
         set()),
        # The image drawn through a clip that shows only its left part: text right of the clip is not on it.
        ([([], b'q'), ([10, 20], b'm'), ([50, 20], b'l'), ([50, 70], b'l'), ([10, 70], b'l'), ([], b'h'),
          ([], b'W'), ([], b'n'), *image, ([], b'Q'), *white_inside[:2], ([1, 0, 0, 1, 80, 30], b'Tm'),
          *white_inside[3:]], resolver, set()),
        ([([], b'q'), ([10, 20, 40, 50], b're'), ([], b'W'), ([], b'n'), *image, ([], b'Q'), *white_inside],
         resolver, {1}),
        # A band filled over the image where the text starts: the text is on the band, not on the image.
        ([*image, ([0, 0.3, 0.3], b'rg'), ([15, 25, 30, 20], b're'), ([], b'f'), *white_inside], resolver, set()),
        ([*image, ([0, 0.3, 0.3], b'rg'), ([60, 25, 30, 20], b're'), ([], b'f'), *white_inside], resolver, {1}),
        # A see-through panel over the image does not hold the text: the image still shows through it.
        ([*image, ([], b'q'), ([NameObject('/GS0')], b'gs'), ([0.5, 0.6, 0.7], b'rg'), ([15, 25, 30, 20], b're'),
          ([], b'f'), ([], b'Q'), *white_inside], dict(resolver, **{'gs:/GS0': {'ca': 0.6}}), {1}),
        # The same panel as a transparency group drawn see-through: inside, its fill is opaque, but the group
        # as a whole is laid down at the outer opacity, so the image still shows through.
        ([*image, ([], b'q'), ([NameObject('/GS1')], b'gs'), ([NameObject('/Fm1')], b'Do'), ([], b'Q'),
          *white_inside],
         dict(resolver, **{'gs:/GS1': {'ca': 0.35}, '/Fm1': (
             'form', 3, [([NameObject('/GS0')], b'gs'), ([15, 25, 30, 20], b're'), ([], b'f')],
             [1, 0, 0, 1, 0, 0], {'gs:/GS0': {'ca': 1.0}}, None, True)}), {1}),
        # A nearly opaque dark band: white text already reads on it over light grey, so nothing changes.
        ([*image, ([], b'q'), ([NameObject('/GS2')], b'gs'), ([0, 0.3, 0.3], b'rg'), ([15, 25, 30, 20], b're'),
          ([], b'f'), ([], b'Q'), *white_inside], dict(resolver, **{'gs:/GS2': {'ca': 0.9}}), set()),
        # An opaque white panel multiplied over the image leaves the image showing unchanged: the text is still
        # on the removed image, so it needs the mid grey.
        ([*image, ([], b'q'), ([NameObject('/GS3')], b'gs'), ([1, 1, 1], b'rg'), ([15, 25, 30, 20], b're'),
          ([], b'f'), ([], b'Q'), *white_inside], dict(resolver, **{'gs:/GS3': {'ca': 1.0, 'bm': '/Multiply'}}),
         {1}),
        # Mid-grey text reads poorly on light grey but worse on mid grey: the image stays light.
        ([*image, ([], b'BT'), ([0.5], b'g'), ([20, 30], b'Td'), (['x'], b'Tj'), ([], b'ET')], resolver, set()),
        # A second image drawn over the first where the text starts: the text is on the second.
        ([*image, ([], b'q'), ([100, 0, 0, 50, 10, 20], b'cm'), ([NameObject('/Im1')], b'Do'), ([], b'Q'),
          *white_inside], dict(resolver, **{'/Im1': ('image', 2)}), {2}),
        # A group laid down multiplied: the opaque white it fills inside multiplies into the image, which still
        # shows - so the text is still on the removed image.
        ([*image, ([], b'q'), ([NameObject('/GS4')], b'gs'), ([NameObject('/Fm2')], b'Do'), ([], b'Q'),
          *white_inside], dict(resolver, **{'gs:/GS4': {'ca': 1.0, 'bm': '/Multiply'}, '/Fm2': (
              'form', 4, [([1, 1, 1], b'rg'), ([15, 25, 30, 20], b're'), ([], b'f')], [1, 0, 0, 1, 0, 0], {}, None,
              True)}), {1}),
    )


def names_resolver(names):
    """A resolver over a plain dict, for the known drawings: a drawn name as is, a graphics state as 'gs:<name>'."""
    return lambda name, kind='xobject': names.get(str(name) if kind == 'xobject' else f'gs:{name}')


def check_grey_rule():
    """
    Refuse to run when the grey rule misjudges any known drawing.

    Raises:
        ValueError: When a drawing is misjudged.
    """
    wrong = [
        expected
        for operations, resolver, expected in grey_rule_cases()
        if under_light_text(draw_events(operations, names_resolver(resolver))) != expected
    ]
    if wrong:
        raise ValueError(f'grey rule misjudges {len(wrong)} known drawing(s)')


def is_public_domain(image):
    """
    Whether an image's own metadata states Public Domain.

    Only the image's XMP metadata stream and the metadata segments inside its JPEG bytes count. A caption on
    the page, the document's metadata or the image's appearance do not: a stock photograph stripped of its
    metadata looks like a government one. Metadata that cannot be read counts as no statement.

    Args:
        image: An image XObject stream.

    Returns:
        True when the statement is present.
    """
    found = b''
    metadata = image.get('/Metadata')
    if metadata is not None:
        try:
            found += metadata.get_object().get_data()
        except Exception:
            pass
    filters = filter_names(image)
    if filters and filters[-1] == '/DCTDecode':
        try:
            found += jpeg_metadata(image.get_data())
        except Exception:
            pass
    return states_public_domain(found)


def multiply(a, b):
    """The product of two PDF matrices [a b c d e f]: `a` applied first, then `b`."""
    return [
        a[0] * b[0] + a[1] * b[2],
        a[0] * b[1] + a[1] * b[3],
        a[2] * b[0] + a[3] * b[2],
        a[2] * b[1] + a[3] * b[3],
        a[4] * b[0] + a[5] * b[2] + b[4],
        a[4] * b[1] + a[5] * b[3] + b[5],
    ]


def rgb(fill):
    """
    A fill colour given as 1 (grey), 3 (RGB) or 4 (CMYK) components, as RGB from 0 to 1.

    Returns:
        A (red, green, blue) tuple, or None when the colour is not one of those forms.
    """
    if fill is None:
        return None
    if len(fill) == 1:
        return (fill[0],) * 3
    if len(fill) == 3:
        return tuple(fill)
    if len(fill) == 4:
        cyan, magenta, yellow, black = fill
        return ((1 - cyan) * (1 - black), (1 - magenta) * (1 - black), (1 - yellow) * (1 - black))
    return None


def relative_luminance(colour):
    """The relative luminance of an RGB colour, from 0 (black) to 1 (white)."""
    linear = [c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4 for c in colour]
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]


def luminance(fill):
    """The relative luminance of a fill colour, or None when the colour cannot be read (see rgb)."""
    colour = rgb(fill)
    return None if colour is None else relative_luminance(colour)


def transform(x, y, matrix):
    """A point mapped through a PDF matrix."""
    return (x * matrix[0] + y * matrix[2] + matrix[4], x * matrix[1] + y * matrix[3] + matrix[5])


def inside(point, polygon):
    """Whether a point lies inside a polygon (ray casting; a point on an edge may fall either way)."""
    x, y = point
    within = False
    for (x1, y1), (x2, y2) in zip(polygon, polygon[1:] + polygon[:1]):
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
            within = not within
    return within


def draw_events(operations, resolve, ctm=None, fill=(0.0,), render=0, clips=(), events=None, forms=(),
                alpha=1.0, scale=1.0, blend=NORMAL, group_blend=NORMAL):
    """
    The images a drawing places, the shapes it fills and the visible text runs it shows, in drawing order.

    Follows the graphics state a content stream keeps - its transform, fill colour, opacity and blend mode, text
    render mode and clip paths, saved and restored with q / Q - and the forms it draws, each inside its own
    matrix and clipped to its own box. A form that is a transparency group starts opaque inside and is laid down
    as a whole at the opacity and blend mode around it, so what it fills takes that opacity and, where its own
    blend is normal, that blend. A text run is placed at its starting point, which is where the text matrix
    stands when the run is shown. A clip path is kept as the polygon of its points; a curve contributes its
    control points, which bound it.

    Args:
        operations: The drawing's (operands, operator) pairs.
        resolve: Maps a drawn name to ('image', object number), ('form', object number, operations, matrix,
            resolver for the form's own names, box or None, whether it is a transparency group) or None; called
            with kind 'gs', maps a graphics state's name to {'ca': fill opacity, 'bm': blend mode}, either
            None when the state does not set it, or None for an unknown state.
        ctm, fill, render, clips, events, forms, alpha, scale, blend, group_blend: The state a form inherits
            from the drawing around it; scale and group_blend are the opacity and blend the enclosing groups
            are laid down with.

    Returns:
        A list of ('image', object number, (x0, y0, x1, y1), clips), ('fill', polygons, clips, opacity, RGB
        colour or None, blend mode) and ('text', (x, y), luminance or None), where clips holds one list of
        polygons per clip in effect.
    """
    ctm = ctm or [1, 0, 0, 1, 0, 0]
    events = [] if events is None else events
    saved = []
    text = line = [1, 0, 0, 1, 0, 0]
    leading = 0.0
    path = []
    clipping = False
    for operands, operator in operations:
        numbers = [float(value) for value in operands if isinstance(value, (int, float))]
        if operator == b'q':
            saved.append((ctm, fill, render, leading, clips, alpha, blend))
        elif operator == b'Q' and saved:
            ctm, fill, render, leading, clips, alpha, blend = saved.pop()
        elif operator == b'gs' and operands:
            state = resolve(operands[0], 'gs') or {}
            if state.get('ca') is not None:
                alpha = float(state['ca'])
            if state.get('bm') is not None:
                blend = str(state['bm'])
        elif operator == b'm' and len(numbers) == 2:
            path.append([transform(numbers[0], numbers[1], ctm)])
        elif operator in (b'l', b'c', b'v', b'y') and numbers and path:
            path[-1].extend(transform(x, y, ctm) for x, y in zip(numbers[::2], numbers[1::2]))
        elif operator == b're' and len(numbers) == 4:
            x, y, width, height = numbers
            path.append([transform(px, py, ctm) for px, py in
                         ((x, y), (x + width, y), (x + width, y + height), (x, y + height))])
        elif operator in (b'W', b'W*'):
            clipping = True
        elif operator in (b'n', b'f', b'F', b'f*', b'S', b's', b'B', b'B*', b'b', b'b*'):
            if operator in FILLING and path:
                events.append(('fill', [polygon for polygon in path if len(polygon) > 2], clips, alpha * scale,
                               rgb(fill), blend if blend != NORMAL else group_blend))
            if clipping and path:
                clips = clips + ([polygon for polygon in path if len(polygon) > 2],)
            path = []
            clipping = False
        elif operator == b'cm' and len(numbers) == 6:
            ctm = multiply(numbers, ctm)
        elif operator in (b'g', b'rg', b'k'):
            fill = tuple(numbers)
        elif operator in (b'sc', b'scn'):
            # A pattern fill names its pattern; only plain colour components can be judged.
            fill = tuple(numbers) if len(numbers) == len(operands) else None
        elif operator == b'cs':
            fill = (0.0,)
        elif operator == b'Tr' and numbers:
            render = int(numbers[0])
        elif operator == b'TL' and numbers:
            leading = numbers[0]
        elif operator == b'BT':
            text = line = [1, 0, 0, 1, 0, 0]
        elif operator == b'Tm' and len(numbers) == 6:
            text = line = numbers
        elif operator in (b'Td', b'TD') and len(numbers) == 2:
            if operator == b'TD':
                leading = -numbers[1]
            text = line = multiply([1, 0, 0, 1, numbers[0], numbers[1]], line)
        elif operator in (b'T*', b"'", b'"'):
            text = line = multiply([1, 0, 0, 1, 0, -leading], line)
        if operator in (b'Tj', b'TJ', b"'", b'"') and render not in INVISIBLE_RENDER_MODES:
            placed = multiply(text, ctm)
            events.append(('text', (placed[4], placed[5]), luminance(fill)))
        elif operator == b'Do' and operands:
            target = resolve(operands[0])
            if target is None:
                continue
            if target[0] == 'image':
                corners = [transform(x, y, ctm) for x, y in ((0, 0), (1, 0), (0, 1), (1, 1))]
                xs, ys = [c[0] for c in corners], [c[1] for c in corners]
                events.append(('image', target[1], (min(xs), min(ys), max(xs), max(ys)), clips))
            elif target[0] == 'form' and target[1] not in forms:
                own = target[4]
                own_resolve = own if callable(own) else names_resolver(own)
                inner = multiply([float(value) for value in target[3]], ctm)
                inner_clips = clips
                box = target[5] if len(target) > 5 else None
                if box is not None and len(box) == 4:
                    x0, y0, x1, y1 = (float(value) for value in box)
                    inner_clips = clips + ([[transform(x, y, inner) for x, y in
                                             ((x0, y0), (x1, y0), (x1, y1), (x0, y1))]],)
                if len(target) > 6 and target[6]:
                    draw_events(target[2], own_resolve, inner, fill, render, inner_clips, events,
                                forms + (target[1],), 1.0, scale * alpha, NORMAL,
                                blend if blend != NORMAL else group_blend)
                else:
                    draw_events(target[2], own_resolve, inner, fill, render, inner_clips, events,
                                forms + (target[1],), alpha, scale, blend, group_blend)
    return events


def under_light_text(events):
    """
    The removed images that must be mid grey for the text on them to read.

    A visible text run that starts inside the part of an image that shows - its box, within every clip in effect
    when it was drawn - and is drawn after it, sits on whatever shows at that point: the image, with any
    see-through shapes filled over it in between laid on top. When that background, with the image drawn light
    grey, leaves the text below CONTRAST_BAR, and mid grey reads better, the image is drawn mid grey. Text on
    something opaque drawn over the image does not depend on the image at all.

    Args:
        events: What draw_events returns.

    Returns:
        The object numbers of those images.
    """
    darkened = set()
    for index, event in enumerate(events):
        if event[0] != 'image' or event[1] in darkened:
            continue
        for later_index in range(index + 1, len(events)):
            later = events[later_index]
            if later[0] != 'text' or later[2] is None or not covers(event, later[1]):
                continue
            on_light = shows_behind(events, index, later_index, later[1], LIGHT_GREY)
            if on_light is None:
                continue
            on_mid = shows_behind(events, index, later_index, later[1], MID_GREY)
            light, mid = (contrast(later[2], relative_luminance(colour)) for colour in (on_light, on_mid))
            if light < CONTRAST_BAR and mid > light:
                darkened.add(event[1])
                break
    return darkened


def shows_behind(events, start, end, point, grey):
    """
    The colour that shows at a point once the removed image at events[start] is drawn in `grey` and every
    shape filled over the point before events[end] is laid on top.

    Returns:
        An RGB colour, or None when an image, an opaque shape or a colour that cannot be read covers the point -
        then what shows there does not depend on the removed image.
    """
    colour = grey
    for event in events[start + 1:end]:
        if not covers(event, point):
            continue
        if event[0] != 'fill':
            return None
        _, _, _, opacity, fill_colour, blend = event
        if fill_colour is None or (opacity >= 1 and blend != MULTIPLY):
            return None
        colour = mix(colour, fill_colour, opacity, blend)
    return colour


def mix(backdrop, colour, opacity, blend):
    """A colour laid over a backdrop at an opacity, in the multiply blend mode or, for any other, the normal one."""
    top = tuple(b * c for b, c in zip(backdrop, colour)) if blend == MULTIPLY else colour
    return tuple(opacity * t + (1 - opacity) * b for t, b in zip(top, backdrop))


def contrast(first, second):
    """The contrast ratio of two relative luminances, as WCAG defines it."""
    return (max(first, second) + 0.05) / (min(first, second) + 0.05)


def covers(event, point):
    """Whether a drawn image or a filled shape covers a point, within the clips in effect when it was drawn."""
    if event[0] == 'image':
        x0, y0, x1, y1 = event[2]
        shape, clips = x0 <= point[0] <= x1 and y0 <= point[1] <= y1, event[3]
    elif event[0] == 'fill':
        shape, clips = any(inside(point, polygon) for polygon in event[1]), event[2]
    else:
        return False
    return shape and all(any(inside(point, polygon) for polygon in clip) for clip in clips)


def image_ids(writer):
    """
    The object numbers of every picture-shaped stream in the writer, reachable from a page or not.

    A stream with a width and a height is a raster picture whatever its subtype says: a page thumbnail carries
    no /Subtype at all, and still shows the page's photographs in miniature.
    """
    found = []
    for idnum, obj in enumerate(writer._objects, start=1):
        if isinstance(obj, StreamObject) and '/Width' in obj and '/Height' in obj:
            found.append(idnum)
    return found


def drop_thumbnails(writer):
    """
    Remove every page's thumbnail.

    A thumbnail is a small picture of the whole page, photographs included. Viewers draw their own, and the app
    draws none, so nothing is lost. The thumbnails become unreachable and are swept by drop_unreachable.

    Args:
        writer: The PdfWriter to edit.

    Returns:
        The number of thumbnails removed.
    """
    removed = 0
    for page in writer.pages:
        if '/Thumb' in page:
            del page['/Thumb']
            removed += 1
    return removed


def reencode_image(writer, idnum):
    """
    Downsample one image and re-encode it as JPEG in place.

    JPEG cannot carry an alpha channel, and a bare convert() fills transparency with BLACK, which turns every
    drop shadow and cut-out logo into a solid block. So an image whose alpha is not fully opaque is composited
    onto WHITE, the colour of the page it was drawn on; one whose alpha is fully opaque converts directly. The
    replacement object carries no mask, so the image's old mask is no longer referenced.

    Args:
        writer: The PdfWriter holding the image.
        idnum: The image's object number.

    Returns:
        A (width, height, composited) tuple for the re-encoded image.
    """
    pil = _xobj_to_image(writer._objects[idnum - 1])[2]
    width, height = pil.size
    if width * height > MAX_PIXELS:
        scale = (MAX_PIXELS / (width * height)) ** 0.5
        pil = pil.resize((max(1, int(width * scale)), max(1, int(height * scale))), Image.LANCZOS)
    composited = False
    if pil.mode in ('RGBA', 'LA', 'PA', 'P'):
        with_alpha = pil.convert('RGBA')
        if with_alpha.getchannel('A').getextrema()[0] < 255:
            flattened = Image.new('RGB', with_alpha.size, (255, 255, 255))
            flattened.paste(with_alpha, mask=with_alpha.getchannel('A'))
            pil = flattened
            composited = True
        else:
            pil = with_alpha.convert('RGB')
    elif pil.mode != 'L':
        pil = pil.convert('RGB')
    ImageFile(indirect_reference=IndirectObject(idnum, 0, writer)).replace(pil, quality=JPEG_QUALITY)
    replaced = writer._objects[idnum - 1]
    return int(replaced['/Width']), int(replaced['/Height']), composited


def blank_image(writer, idnum):
    """
    Replace one image with a single light-grey pixel.

    The replacement is built from nothing rather than edited, so no key of the removed image survives: not
    its filter or decode parameters, not its /SMask or /Mask (each is an image in its own right - a stock
    photo's silhouette is still the photo), not its metadata.

    Args:
        writer: The PdfWriter holding the image.
        idnum: The image's object number.
    """
    blank = DecodedStreamObject()
    blank.set_data(BLANK_PIXEL)
    blank.update({
        NameObject('/Type'): NameObject('/XObject'),
        NameObject('/Subtype'): NameObject('/Image'),
        NameObject('/Width'): NumberObject(1),
        NameObject('/Height'): NumberObject(1),
        NameObject('/ColorSpace'): NameObject('/DeviceRGB'),
        NameObject('/BitsPerComponent'): NumberObject(8),
    })
    blank.indirect_reference = IndirectObject(idnum, 0, writer)
    writer._objects[idnum - 1] = blank


def is_blank(obj):
    """Whether an image object is the single pixel blank_image writes, light or mid grey."""
    return (
        set(obj.keys()) <= {'/Type', '/Subtype', '/Width', '/Height', '/ColorSpace', '/BitsPerComponent',
                            '/Length'}
        and obj.get('/Width') == 1
        and obj.get('/Height') == 1
        and obj.get('/ColorSpace') == '/DeviceRGB'
        and obj.get('/BitsPerComponent') == 8
        and obj.get_data() in (BLANK_PIXEL, MID_GREY_PIXEL)
    )


def page_resolver(writer, resources):
    """
    Resolve the names a page or form draws, for draw_events.

    Args:
        writer: The PdfWriter.
        resources: The resources the drawing names its images and forms in.

    Returns:
        A function from a drawn name to ('image', object number), ('form', ...) or None.
    """
    resources = resources.get_object() if resources is not None else DictionaryObject()
    xobjects = resources.get('/XObject')
    xobjects = xobjects.get_object() if xobjects is not None else DictionaryObject()
    states = resources.get('/ExtGState')
    states = states.get_object() if states is not None else DictionaryObject()

    def resolve(name, kind='xobject'):
        if kind == 'gs':
            state = states.get(name)
            if state is None:
                return None
            state = state.get_object()
            opacity, mode = state.get('/ca'), state.get('/BM')
            if isinstance(mode, ArrayObject):
                mode = mode[0] if len(mode) else None
            return {'ca': float(opacity) if opacity is not None else None,
                    'bm': str(mode) if mode is not None else None}
        ref = xobjects.get(name)
        if not isinstance(ref, IndirectObject):
            return None
        obj = ref.get_object()
        if isinstance(obj, StreamObject) and '/Width' in obj and '/Height' in obj:
            return ('image', ref.idnum)
        if obj.get('/Subtype') == '/Form':
            own = obj.get('/Resources')
            return ('form', ref.idnum, ContentStream(obj, writer).operations, obj.get('/Matrix', [1, 0, 0, 1, 0, 0]),
                    page_resolver(writer, own if own is not None else resources), obj.get('/BBox'),
                    obj.get('/Group') is not None)
        return None

    return resolve


def darken_under_light_text(writer, removed):
    """
    Draw a removed image mid grey instead of light grey where a page draws light text on top of its area.

    An image drawn on several pages takes mid grey everywhere once any page draws light text over it.

    Args:
        writer: The PdfWriter, after the removed images are blanked.
        removed: Object numbers of the removed images.

    Returns:
        A dict of page number (as a string) to the removed images darkened there.
    """
    pages = {}
    darkened = set()
    for number, page in enumerate(writer.pages, start=1):
        contents = page.get('/Contents')
        if contents is None:
            continue
        events = draw_events(ContentStream(contents.get_object(), writer).operations,
                             page_resolver(writer, page.get('/Resources')))
        here = under_light_text(events) & removed
        if here:
            pages[str(number)] = sorted(here)
            darkened |= here
    for idnum in darkened:
        writer._objects[idnum - 1].set_data(MID_GREY_PIXEL)
    return pages


def is_reencoded(writer, idnum):
    """Whether an image object is a JPEG as reencode_image writes it: one DCT filter, no mask."""
    obj = writer._objects[idnum - 1]
    return (
        isinstance(obj, StreamObject)
        and filter_names(obj) == ['/DCTDecode']
        and '/SMask' not in obj
        and '/Mask' not in obj
    )


def drop_active_content(writer):
    """
    Remove embedded files and the actions a viewer runs without a click.

    Drops the name tree of embedded files, the document's open action, and the additional-actions entry of
    every object that has one (the document, pages, annotations and form fields). Link annotations and
    their actions stay. The removed objects become unreachable and are swept by drop_unreachable.

    Args:
        writer: The PdfWriter to edit.

    Returns:
        The number of entries removed.
    """
    removed = 0
    root = writer.root_object
    names = root.get('/Names')
    if names is not None and '/EmbeddedFiles' in names.get_object():
        del names.get_object()['/EmbeddedFiles']
        removed += 1
    if '/OpenAction' in root:
        del root['/OpenAction']
        removed += 1
    for obj in writer._objects:
        if isinstance(obj, DictionaryObject) and '/AA' in obj:
            del obj['/AA']
            removed += 1
    return removed


def drop_file_links(writer):
    """
    Remove annotations that attach a file or play media, links that open another file or a program, and every
    embedded file.

    A form field keeps its place and loses only such an action, so the form's field list stays whole. Nothing
    here is drawn: the app draws a page's content, not its annotations. The removed objects become unreachable
    and are swept by drop_unreachable.

    Args:
        writer: The PdfWriter to edit.

    Returns:
        The number of annotations, actions and embedded files removed.
    """
    removed = 0
    for page in writer.pages:
        annotations = page.get('/Annots')
        if annotations is None:
            continue
        kept = ArrayObject()
        for ref in annotations.get_object():
            annotation = ref.get_object()
            action = annotation.get('/A')
            opens_elsewhere = action is not None and action.get_object().get('/S') in DROPPED_ACTIONS
            if annotation.get('/Subtype') in DROPPED_ANNOTATIONS or (
                opens_elsewhere and annotation.get('/Subtype') != '/Widget'
            ):
                removed += 1
                continue
            if opens_elsewhere:
                del annotation['/A']
                removed += 1
            kept.append(ref)
        page[NameObject('/Annots')] = kept
    for obj in writer._objects:
        if isinstance(obj, DictionaryObject) and '/EF' in obj:
            del obj['/EF']
            removed += 1
    return removed


def drop_unreachable(writer):
    """
    Remove every object not reachable from the document root, the document info or the file identifier.

    Replacing an object or deleting the entry that pointed at it leaves the old object in the writer, and
    the writer writes every object it holds. Without this, a dropped embedded file or a replaced image's old
    mask would still ship in the file, unreferenced.

    Args:
        writer: The PdfWriter to sweep.

    Returns:
        The number of objects removed.
    """
    reachable = set()
    pending = [writer.root_object.indirect_reference]
    if writer._info is not None:
        pending.append(writer._info.indirect_reference)
    if writer._ID is not None:
        pending.append(writer._ID)
    while pending:
        item = pending.pop()
        if isinstance(item, IndirectObject):
            if item.pdf is not writer:
                raise ValueError('reference into another document')
            if item.idnum in reachable:
                continue
            reachable.add(item.idnum)
            pending.append(writer._objects[item.idnum - 1])
        elif isinstance(item, DictionaryObject):
            pending.extend(dict.values(item))
        elif isinstance(item, ArrayObject):
            pending.extend(list.__iter__(item))
    removed = 0
    for index, obj in enumerate(writer._objects):
        if obj is not None and index + 1 not in reachable:
            writer._objects[index] = None
            removed += 1
    return removed


def count_kept_paints(writer, kept):
    """
    Count, per page, the paints of kept images larger than one pixel.

    This is the count the verifier makes from the published file with the app's own PDF reader, so it
    walks what that reader draws for a page: the page's content, every form it draws, the soft-mask groups
    its graphics states apply, and the normal appearance of each annotation shown on screen. Each paint
    counts, so an image drawn twice counts twice, on either side.

    Args:
        writer: The PdfWriter after every edit.
        kept: Object numbers of the kept images larger than one pixel.

    Returns:
        A dict of page number (as a string) to paint count, holding only pages that paint a kept image.
    """
    per_page = {}
    for number, page in enumerate(writer.pages, start=1):
        painted = paints_in(writer, page.get('/Contents'), page.get('/Resources'), kept, ())
        for annotation in (page.get('/Annots') or ArrayObject()).get_object():
            annotation = annotation.get_object()
            if int(annotation.get('/F', 0)) & NOT_DRAWN_FLAGS:
                continue
            appearance = appearance_stream(annotation)
            if appearance is not None:
                painted += paints_in(writer, appearance, appearance.get('/Resources'), kept, ())
        if painted:
            per_page[str(number)] = painted
    return per_page


def appearance_stream(annotation):
    """The normal appearance an annotation shows, choosing its current state when it has several."""
    appearances = annotation.get('/AP')
    if appearances is None:
        return None
    normal = appearances.get_object().get('/N')
    if normal is None:
        return None
    normal = normal.get_object()
    if isinstance(normal, StreamObject):
        return normal
    state = annotation.get('/AS')
    if state is None or state not in normal:
        return None
    return normal[state]


def paints_in(writer, contents, resources, kept, forms):
    """
    Count kept-image paints in one content stream, following the forms and soft masks it draws.

    Args:
        writer: The PdfWriter.
        contents: A content stream, an array of them, or a reference to either.
        resources: The resources the stream names its images, forms and graphics states in.
        kept: Object numbers of the kept images larger than one pixel.
        forms: Object numbers of the forms being drawn around this stream, to stop a form drawing itself.

    Returns:
        The number of paints.
    """
    if contents is None:
        return 0
    resources = resources.get_object() if resources is not None else DictionaryObject()
    xobjects = resources.get('/XObject')
    xobjects = xobjects.get_object() if xobjects is not None else DictionaryObject()
    states = resources.get('/ExtGState')
    states = states.get_object() if states is not None else DictionaryObject()
    count = 0
    for operands, operator in ContentStream(contents.get_object(), writer).operations:
        if operator == b'INLINE IMAGE':
            # An inline image lives inside the content stream and has no metadata to state its rights, and
            # removing one means rewriting the stream the text layer lives in. None exists in the captures;
            # one appearing fails the document rather than shipping it.
            raise ValueError('inline image')
        if operator == b'Do':
            count += paints_of(writer, xobjects.get(operands[0]), resources, kept, forms)
        elif operator == b'gs':
            state = states.get(operands[0])
            mask = state.get_object().get('/SMask') if state is not None else None
            mask = mask.get_object() if mask is not None else None
            if isinstance(mask, DictionaryObject) and mask.get('/G') is not None:
                count += paints_of(writer, mask.get('/G'), resources, kept, forms)
    return count


def paints_of(writer, ref, resources, kept, forms):
    """Count kept-image paints for one drawn XObject: the image itself, or everything a form draws."""
    if not isinstance(ref, IndirectObject):
        return 0
    obj = ref.get_object()
    if obj.get('/Subtype') == '/Image':
        return 1 if ref.idnum in kept else 0
    if obj.get('/Subtype') == '/Form':
        if ref.idnum in forms:
            raise ValueError('form draws itself')
        own = obj.get('/Resources')
        return paints_in(writer, ref, own if own is not None else resources, kept, forms + (ref.idnum,))
    return 0


def derive(src, dst):
    """
    Write the candidate for one capture.

    Args:
        src: Path to the capture.
        dst: Path to write the candidate to.

    Returns:
        A dict with the images kept, removed and composited, the Public Domain images that could not be
        re-encoded (and were removed instead), the active-content entries and unreachable objects dropped,
        and the kept paints per page.
    """
    writer = pypdf.PdfWriter(clone_from=src)
    active = drop_active_content(writer)
    file_links = drop_file_links(writer)
    thumbnails = drop_thumbnails(writer)
    # Swept now, so the removed thumbnails and anything else no page can reach leave before the count of
    # removed pictures is taken; the second sweep below takes what the replacements orphan.
    drop_unreachable(writer)

    # Classify every image before changing any: re-encoding decodes an image together with its mask, so the
    # masks must still be intact when the kept images are processed.
    images = image_ids(writer)
    public = [idnum for idnum in images if is_public_domain(writer._objects[idnum - 1])]
    encoded = set()
    kept = set()
    composited = 0
    unencodable = 0
    for idnum in public:
        try:
            width, height, flattened = reencode_image(writer, idnum)
        except Exception:
            # A kept image that cannot be decoded cannot be shown as JPEG either, and its original bytes may
            # be an encoding the app cannot draw. It is removed like any other, never kept as it was.
            unencodable += 1
            continue
        encoded.add(idnum)
        composited += flattened
        if width * height > 1:
            kept.add(idnum)
    blanked = set()
    for idnum in images:
        if idnum not in encoded:
            blank_image(writer, idnum)
            blanked.add(idnum)
    removed = len(blanked)
    darkened = darken_under_light_text(writer, blanked)

    for page in writer.pages:
        page.compress_content_streams()
    swept = drop_unreachable(writer)

    # The post-condition the whole step exists for: every image left in the file is either one this run
    # re-encoded from a Public Domain original or the single pixel that replaces a removed one.
    for idnum in image_ids(writer):
        if not (idnum in encoded and is_reencoded(writer, idnum)) and not is_blank(writer._objects[idnum - 1]):
            raise ValueError('image neither kept nor removed')

    kept_per_page = count_kept_paints(writer, kept)
    # Identical objects are written once. Merging renumbers them, so it comes after everything that reads an
    # object by its number. It keeps a file whose capture packed its objects compactly from growing as much.
    writer.compress_identical_objects(remove_identicals=True, remove_orphans=True)
    with open(dst, 'wb') as handle:
        writer.write(handle)
    return {
        'kept': len(kept),
        'removed': removed,
        'composited': composited,
        'unencodable': unencodable,
        'active': active,
        'fileLinks': file_links,
        'thumbnails': thumbnails,
        'darkened': darkened,
        'swept': swept,
        'keptPerPage': kept_per_page,
    }


def remove_candidate(source_id):
    """Delete any candidate and record for a source, so a failed run leaves nothing to publish."""
    for extension in ('.pdf', '.json'):
        path = os.path.join(OUTPUT_DIR, f'{source_id}{extension}')
        if os.path.exists(path):
            os.remove(path)


def main():
    print('=' * 60)
    print('DERIVE SERVED DOCUMENTS (candidates only)')
    print('=' * 60)

    # Step 1: Find the captures, once the keep rule has proven itself
    print('\n[1/3] Checking the keep rule and reading the source registry...')
    try:
        check_keep_rule()
        check_grey_rule()
    except ValueError as exc:
        print(f'    {exc} - nothing derived')
        return 1
    print(f'    Keep rule judges all {len(KEEP_RULE_CASES)} known cases correctly; grey rule all '
          f'{len(grey_rule_cases())} known drawings')
    captures = pdf_sources(SOURCES_PATH)
    only = sys.argv[1] if len(sys.argv) > 1 else None
    if only:
        captures = [c for c in captures if c[0] == only]
    missing = [sid for sid, path, _hash in captures if not os.path.exists(path)]
    if missing:
        print(f'    Captures absent for {len(missing)} source(s): {", ".join(missing)}')
        print('    Run `pnpm ingest` first.')
        return 1
    unhashed = [sid for sid, _path, content_hash in captures if not content_hash]
    if unhashed:
        print(f'    No content_hash recorded for: {", ".join(unhashed)}')
        return 1
    print(f'    Found {len(captures)} PDF captures')

    # Step 2: Derive a candidate for each
    print(f'\n[2/3] Removing images not marked Public Domain, re-encoding the rest '
          f'(quality {JPEG_QUALITY}, max {MAX_PIXELS:,} px)...')
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    rows = []
    for index, (source_id, capture_path, content_hash) in enumerate(captures, 1):
        before = os.path.getsize(capture_path)
        destination = os.path.join(OUTPUT_DIR, f'{source_id}.pdf')
        print(f'    [{index}/{len(captures)}] {source_id} ({before / 1e6:.1f} MB)...', flush=True)
        # A stale candidate from an earlier run must not survive a failure of this one.
        remove_candidate(source_id)
        try:
            original_text = page_texts(capture_path)
            result = derive(capture_path, destination)
            record = {
                'captureHash': content_hash,
                'darkenedPages': sorted(int(page) for page in result['darkened']),
                'derivationVersion': DERIVATION_VERSION,
                'jpegQuality': JPEG_QUALITY,
                'keptPerPage': result['keptPerPage'],
                'maxPixels': MAX_PIXELS,
                'removed': result['removed'],
            }
            with open(os.path.join(OUTPUT_DIR, f'{source_id}.json'), 'w', encoding='utf-8') as handle:
                json.dump(record, handle, indent=1, sort_keys=True)
                handle.write('\n')
            after = os.path.getsize(destination)
            candidate_text = page_texts(destination)
            identical = len(original_text) == len(candidate_text) and all(
                a == b for a, b in zip(original_text, candidate_text)
            )
            rows.append((source_id, before, after, identical, result))
        except Exception as exc:
            remove_candidate(source_id)
            print(f'        FAILED: {type(exc).__name__}: {exc}')
            rows.append((source_id, before, None, False, None))

    # Step 3: Report
    print('\n[3/3] Summary (advisory - serve-pdfs.mjs verifies independently)')
    print('=' * 60)
    print('%-30s %6s %5s %5s %6s %6s' % ('source_id', 'MB', 'MB', 'text', 'kept', 'gone'))
    print('-' * 60)
    for source_id, before, after, identical, result in rows:
        if result is None:
            print('%-30s %6.1f  FAILED - no candidate written' % (source_id, before / 1e6))
            continue
        print('%-30s %6.1f %5.1f %5s %6d %6d' % (
            source_id, before / 1e6, after / 1e6, 'same' if identical else 'MOVED', result['kept'],
            result['removed']))
        notes = []
        if result['unencodable']:
            notes.append(f'{result["unencodable"]} Public Domain image(s) could not be re-encoded and were removed')
        if result['composited']:
            notes.append(f'{result["composited"]} kept image(s) composited onto white')
        if result['active']:
            notes.append(f'{result["active"]} embedded-file / automatic-action entr(ies) dropped')
        if result['fileLinks']:
            notes.append(f'{result["fileLinks"]} attachment / media / other-file link(s) dropped')
        if result['thumbnails']:
            notes.append(f'{result["thumbnails"]} page thumbnail(s) dropped')
        if result['darkened']:
            darkened = result['darkened']
            notes.append(f'mid grey under light text on {len(darkened)} page(s): '
                         + ', '.join(f'p{page} {images}' for page, images in darkened.items()))
        for note in notes:
            print(f'        {note}')
    print('-' * 60)
    failed = sum(1 for row in rows if row[4] is None)
    moved = sum(1 for row in rows if row[4] is not None and not row[3])
    print(f'    candidates written to {OUTPUT_DIR}/')
    print(f'    failed (no candidate): {failed}')
    print(f'    text layer moved on {moved} file(s) - those will be rejected downstream')
    print('\n    Next: pnpm serve:pdfs')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
