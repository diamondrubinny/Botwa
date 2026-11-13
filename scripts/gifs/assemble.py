"""Turns the frames from frames.cjs into looping GIFs with one shared palette per animation (no colour flicker)."""
import json, os, sys
from PIL import Image

src, dst = sys.argv[1], sys.argv[2]
os.makedirs(dst, exist_ok=True)
manifest = json.load(open(os.path.join(src, 'manifest.json'), encoding='utf-8'))
for key in manifest:
    files = sorted(f for f in os.listdir(os.path.join(src, key)) if f.endswith('.png'))
    frames = [Image.open(os.path.join(src, key, f)).convert('RGB') for f in files]
    # one palette from all frames together
    w, h = frames[0].size
    sheet = Image.new('RGB', (w, h * len(frames)))
    for i, fr in enumerate(frames): sheet.paste(fr, (0, i * h))
    pal = sheet.quantize(colors=128, method=Image.Quantize.MEDIANCUT)
    out = [fr.quantize(palette=pal, dither=Image.Dither.NONE) for fr in frames]
    path = os.path.join(dst, f'{key}.gif')
    out[0].save(path, save_all=True, append_images=out[1:], duration=80, loop=0, optimize=True, disposal=1)
    print(f'{key}.gif {os.path.getsize(path) // 1024} KB')
json.dump(manifest, open(os.path.join(dst, 'manifest.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
