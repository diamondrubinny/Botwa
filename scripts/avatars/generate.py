import os, sys
out = sys.argv[1]
SK = ['#f7d3b5', '#e8b48f', '#c98e64', '#a86b45', '#7a4a2e', '#5a3622']        # six skin tones
HAIR = ['#2b1d16', '#5a3a22', '#1c1c1c', '#8a5a2b', '#3b2a20', '#111111']
BG = ['#ede9fe', '#dbf1ff', '#dcfce7', '#ffe8d6', '#fff4cc', '#ffe1ec']

def person(i, hat, vest, skin, hair, bg, acc):
    s = f'<rect width="256" height="256" fill="{bg}"/>'
    # body with a hi-vis vest and reflective stripes
    s += f'<path d="M36 256c4-54 40-82 92-82s88 28 92 82z" fill="#3d4a66"/>'
    s += f'<path d="M62 256c2-40 20-66 46-74l20 30 20-30c26 8 44 34 46 74z" fill="{vest}"/>'
    s += '<path d="M66 228h44M146 228h44" stroke="#eef2f7" stroke-width="9" stroke-linecap="round"/>'
    s += f'<rect x="112" y="160" width="32" height="26" rx="10" fill="{skin}"/>'
    # head
    s += f'<circle cx="80" cy="124" r="11" fill="{skin}"/><circle cx="176" cy="124" r="11" fill="{skin}"/>'
    s += f'<circle cx="128" cy="122" r="50" fill="{skin}"/>'
    s += f'<path d="M80 112c2 16 6 22 10 26M176 112c-2 16-6 22-10 26" stroke="{hair}" stroke-width="10" stroke-linecap="round" fill="none"/>'
    # face
    if acc != 'goggles':
        s += '<circle cx="110" cy="124" r="6" fill="#1f2433"/><circle cx="146" cy="124" r="6" fill="#1f2433"/>'
    if acc != 'mask':
        s += '<path d="M112 146q16 12 32 0" stroke="#1f2433" stroke-width="5" stroke-linecap="round" fill="none"/>'
    s += f'<circle cx="98" cy="140" r="7" fill="#ff8f8f" opacity=".35"/><circle cx="158" cy="140" r="7" fill="#ff8f8f" opacity=".35"/>'
    # accessories
    if acc == 'glasses':
        s += '<g fill="none" stroke="#1f2433" stroke-width="4"><circle cx="110" cy="124" r="13"/><circle cx="146" cy="124" r="13"/><path d="M123 124h10"/></g>'
    if acc == 'goggles':
        s += '<rect x="86" y="108" width="84" height="32" rx="14" fill="#bfe6ff" stroke="#2b3550" stroke-width="5"/><path d="M78 122h8M170 122h8" stroke="#2b3550" stroke-width="6"/><path d="M98 116l12 14M140 116l12 14" stroke="#ffffff" stroke-width="4" opacity=".8"/>'
    if acc == 'mask':
        s += '<path d="M100 140q28-12 56 0v14q-28 18-56 0z" fill="#e9edf3" stroke="#8a93a8" stroke-width="3"/><circle cx="114" cy="152" r="7" fill="#8a93a8"/><circle cx="142" cy="152" r="7" fill="#8a93a8"/>'
    # hard hat
    s += f'<path d="M74 110a54 54 0 0 1 108 0z" fill="{hat}"/>'
    s += f'<rect x="62" y="104" width="132" height="14" rx="7" fill="{hat}"/>'
    s += '<path d="M128 58v46" stroke="#000" stroke-opacity=".14" stroke-width="10" stroke-linecap="round"/>'
    s += '<path d="M90 84q10-18 26-24" stroke="#fff" stroke-opacity=".45" stroke-width="7" stroke-linecap="round" fill="none"/>'
    if acc == 'muffs':
        s += f'<path d="M72 118q0-70 56-70t56 70" fill="none" stroke="#2b3550" stroke-width="6"/><rect x="62" y="104" width="26" height="40" rx="12" fill="#e5484d"/><rect x="168" y="104" width="26" height="40" rx="12" fill="#e5484d"/>'
    return s

def icon(kind, bg):
    s = f'<rect width="256" height="256" fill="{bg}"/>'
    if kind == 'extinguisher':
        s += '<rect x="96" y="80" width="64" height="136" rx="22" fill="#e5484d"/><rect x="96" y="150" width="64" height="26" fill="#fff" opacity=".9"/><rect x="114" y="56" width="28" height="28" rx="6" fill="#2b3550"/><path d="M142 66h34l14 18" stroke="#2b3550" stroke-width="8" fill="none" stroke-linecap="round"/><path d="M112 100q-4 30 0 44" stroke="#fff" stroke-opacity=".4" stroke-width="7" stroke-linecap="round"/>'
    if kind == 'firstaid':
        s += '<rect x="58" y="86" width="140" height="104" rx="18" fill="#ffffff" stroke="#e5484d" stroke-width="8"/><rect x="106" y="66" width="44" height="24" rx="8" fill="none" stroke="#e5484d" stroke-width="8"/><path d="M128 110v56M100 138h56" stroke="#e5484d" stroke-width="18" stroke-linecap="round"/>'
    if kind == 'helmet':
        s += '<path d="M62 150a66 66 0 0 1 132 0z" fill="#f5b400"/><rect x="46" y="144" width="164" height="22" rx="11" fill="#f5b400"/><path d="M128 86v58" stroke="#000" stroke-opacity=".15" stroke-width="14" stroke-linecap="round"/><path d="M84 118q12-22 32-30" stroke="#fff" stroke-opacity=".5" stroke-width="8" stroke-linecap="round" fill="none"/>'
    if kind == 'glasses':
        s += '<path d="M48 112h160" stroke="#2b3550" stroke-width="8" stroke-linecap="round"/><path d="M58 112h62v28q0 26-31 26t-31-26zM136 112h62v28q0 26-31 26t-31-26z" fill="#9fd8ff" stroke="#2b3550" stroke-width="8" stroke-linejoin="round"/><path d="M72 124l18 22M150 124l18 22" stroke="#fff" stroke-width="6" stroke-linecap="round" opacity=".8"/>'
    if kind == 'muffs':
        s += '<path d="M74 150q0-90 54-90t54 90" fill="none" stroke="#2b3550" stroke-width="14" stroke-linecap="round"/><rect x="50" y="128" width="50" height="72" rx="22" fill="#e5484d"/><rect x="156" y="128" width="50" height="72" rx="22" fill="#e5484d"/><rect x="64" y="142" width="22" height="44" rx="10" fill="#fff" opacity=".35"/>'
    if kind == 'glove':
        s += '<path d="M92 210v-62l-16-30q-6-12 4-16t16 8l10 18V78q0-12 11-12t11 12v44V66q0-12 11-12t11 12v56V76q0-12 11-12t11 12v62q0 22-8 38v34z" fill="#f5b400" stroke="#8a5a00" stroke-width="5" stroke-linejoin="round"/><rect x="88" y="196" width="80" height="26" rx="8" fill="#2b3550"/>'
    if kind == 'cone':
        s += '<path d="M128 46l50 156H78z" fill="#ff7a1a"/><path d="M104 120h48l8 26H96z" fill="#fff"/><path d="M114 84h28l6 20h-40z" fill="#fff"/><rect x="58" y="196" width="140" height="18" rx="6" fill="#2b3550"/>'
    if kind == 'warning':
        s += '<path d="M128 50l86 148H42z" fill="#ffd23f" stroke="#1f2433" stroke-width="10" stroke-linejoin="round"/><path d="M128 102v50" stroke="#1f2433" stroke-width="16" stroke-linecap="round"/><circle cx="128" cy="176" r="10" fill="#1f2433"/>'
    if kind == 'shield':
        s += '<path d="M128 40l74 26v52c0 52-34 86-74 100-40-14-74-48-74-100V66z" fill="#6a3de8"/><path d="M96 128l22 22 42-46" stroke="#fff" stroke-width="16" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'
    if kind == 'ladder':
        s += '<path d="M94 40l-18 176M162 40l18 176" stroke="#c27a2c" stroke-width="14" stroke-linecap="round"/><path d="M92 74h70M88 110h80M84 146h88M80 182h96" stroke="#c27a2c" stroke-width="11" stroke-linecap="round"/>'
    if kind == 'flask':
        s += '<path d="M108 46h40M114 46v58l-46 86q-8 18 12 18h96q20 0 12-18l-46-86V46" fill="#ffffff" stroke="#2b3550" stroke-width="9" stroke-linejoin="round"/><path d="M84 160l-8 16q-6 14 8 14h88q14 0 8-14l-8-16z" fill="#12b76a"/><circle cx="116" cy="172" r="6" fill="#fff" opacity=".7"/><circle cx="138" cy="164" r="4" fill="#fff" opacity=".7"/>'
    if kind == 'boot':
        s += '<path d="M90 50h56v96l46 22q22 10 22 34v14H62v-44q0-14 10-22l18-14z" fill="#3d4a66"/><path d="M146 146l46 22q22 10 22 34v14h-68z" fill="#f5b400"/><rect x="62" y="200" width="152" height="16" fill="#1f2433"/><path d="M96 74h40M96 96h40M96 118h40" stroke="#fff" stroke-opacity=".5" stroke-width="7" stroke-linecap="round"/>'
    return s

people = [
    ('#f5b400', '#ff7a1a', 0, 0, 0, None), ('#ffffff', '#c6f432', 1, 1, 1, 'glasses'), ('#ff7a1a', '#f5d000', 2, 2, 2, None),
    ('#3b82f6', '#ff7a1a', 3, 3, 3, 'muffs'), ('#12b76a', '#f5d000', 4, 4, 4, None), ('#e5484d', '#c6f432', 5, 5, 5, 'glasses'),
    ('#ffffff', '#ff7a1a', 4, 0, 0, 'mask'), ('#f5b400', '#c6f432', 2, 1, 1, 'goggles'), ('#3b82f6', '#f5d000', 0, 5, 2, None),
    ('#ff7a1a', '#c6f432', 5, 3, 3, 'muffs'), ('#12b76a', '#ff7a1a', 1, 2, 4, 'goggles'), ('#e5484d', '#f5d000', 3, 4, 5, 'mask'),
]
n = 1
for hat, vest, sk, hr, bg, acc in people:
    svg = f'<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">{person(n, hat, vest, SK[sk], HAIR[hr], BG[bg], acc)}</svg>'
    open(os.path.join(out, f'p{n:02d}.svg'), 'w').write(svg); n += 1
for k, kind in enumerate(['extinguisher', 'firstaid', 'helmet', 'glasses', 'muffs', 'glove', 'cone', 'warning', 'shield', 'ladder', 'flask', 'boot']):
    svg = f'<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">{icon(kind, BG[k % 6])}</svg>'
    open(os.path.join(out, f'p{n:02d}.svg'), 'w').write(svg); n += 1
print(n - 1)
