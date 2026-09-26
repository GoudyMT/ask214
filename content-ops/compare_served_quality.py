"""
Build before/after image comparisons for the served source documents.

The fidelity gate proves the TEXT LAYER is byte-identical, which is what keeps citations resolving. It
proves nothing about how the pages LOOK, and the derivation only alters images - so comparing the images
directly answers the quality question more precisely than rendering whole pages would.

Two rules here are not stylistic, they are what makes the output trustworthy:

  - BOTH sides are composited onto WHITE before display. A PDF viewer draws transparency over a white
    page; flattening either side to black shows something no reader will ever see, and misrepresents the
    original as badly as it misrepresents the copy.
  - Images are paired by their position in the document, never by size rank. Ranking each file
    independently pairs whichever image happens to be largest in each, which can be two entirely
    different pictures.

Run: python content-ops/compare_served_quality.py [output_dir]
"""

import glob
import os
import re
import sys

import pypdf
from PIL import Image

SOURCES_PATH = 'content/sources.yaml'
SERVED_DIR = 'static/docs'
# First the heaviest re-encodes by capture-to-served size ratio, where text drawn inside an image is most
# likely to lose legibility; then the largest documents, which carry the most of the corpus. Largest is not
# heaviest - a small file can be re-encoded far harder than a big one.
TARGETS = [
    'tap_va_womens_health',
    'tap_other_than_honorable',
    'tap_va_reserve_natl_guard',
    'tap_va_education_benefits',
    'tap_va_benefits_guide',
    'tap_dol_efct',
    'tap_managing_education',
]
IMAGES_PER_DOC = 2
STRIP_HEIGHT = 620


def capture_for(source_id):
    """Find a source's capture path in the registry."""
    text = open(SOURCES_PATH, encoding='utf-8').read()
    current = None
    for line in text.splitlines():
        head = re.match(r'- source_id:\s*(\S+)', line)
        if head:
            current = head.group(1)
        captured = re.match(r'\s+captured_path:\s*(\S+)', line)
        if captured and current == source_id:
            return captured.group(1)
    return None


def images_by_position(path):
    """
    Map (page_index, slot) -> PIL image.

    Position is the pairing key because the re-encode does not preserve XObject names, and pairing by
    size rank would compare different pictures.
    """
    reader = pypdf.PdfReader(path)
    found = {}
    for page_index, page in enumerate(reader.pages):
        try:
            images = page.images
        except Exception:
            continue
        slot = 0
        for img in images:
            try:
                pil = img.image
            except Exception:
                continue
            if pil is not None:
                found[(page_index, slot)] = pil
                slot += 1
    return found


def on_white(img):
    """Render an image the way a viewer draws it: transparency over a white page, never over black."""
    if img.mode in ('RGBA', 'LA', 'PA', 'P'):
        rgba = img.convert('RGBA')
        flattened = Image.new('RGB', rgba.size, (255, 255, 255))
        flattened.paste(rgba, mask=rgba.getchannel('A'))
        return flattened
    return img.convert('RGB')


def strip(before, after, out_path):
    """Compose a capture-versus-served pair into one image, both scaled to a common height."""
    def fit(img):
        ratio = STRIP_HEIGHT / img.height
        return img.resize((max(1, int(img.width * ratio)), STRIP_HEIGHT), Image.LANCZOS)

    left = fit(on_white(before))
    right = fit(on_white(after))
    gap = 16
    canvas = Image.new('RGB', (left.width + gap + right.width, STRIP_HEIGHT), (230, 230, 230))
    canvas.paste(left, (0, 0))
    canvas.paste(right, (left.width + gap, 0))
    canvas.save(out_path, 'PNG')


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else '.'
    os.makedirs(out_dir, exist_ok=True)

    print('=' * 60)
    print('SERVED DOCUMENT QUALITY (left = capture, right = served)')
    print('=' * 60)

    written = []
    for source_id in TARGETS:
        capture = capture_for(source_id)
        served = glob.glob(os.path.join(SERVED_DIR, f'{source_id}.*.pdf'))
        if not capture or not os.path.exists(capture) or not served:
            print(f'    {source_id}: skipped (capture or served file missing)')
            continue

        before = images_by_position(capture)
        after = images_by_position(served[0])
        shared = [key for key in before if key in after]
        shared.sort(key=lambda key: -(before[key].size[0] * before[key].size[1]))
        if not shared:
            print(f'    {source_id}: no comparable images')
            continue

        for index, key in enumerate(shared[:IMAGES_PER_DOC]):
            out_path = os.path.join(out_dir, f'quality-{source_id}-{index + 1}.png')
            strip(before[key], after[key], out_path)
            print(
                f'    {source_id} p{key[0] + 1}: {before[key].size} {before[key].mode}'
                f' -> {after[key].size} {after[key].mode}'
            )
            written.append(out_path)

    print()
    for path in written:
        print(path)
    return 0


if __name__ == '__main__':
    sys.exit(main())
