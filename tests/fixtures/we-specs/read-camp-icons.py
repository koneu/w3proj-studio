"""Reads camp icons off a --shot-screen of the World Editor with "Show Creep Camp Icon" ticked (see docs/testing/doodads-and-units.md, Camps).

    python3 -I read-camp-icons.py <shot.png> <camps-X.layout.json>

The layout (written by make-camps.mjs) lists the creeps' positions by case. The minimap of the 1600x1000 display shows
the map at 0.0164 px per unit, its centre at (82, 126) in the screenshot; a green blob is a camp icon, on the creep
nearest to it. Prints, per case, the indices of the creeps that carry an icon (one JSON line)."""
import json
import sys
from PIL import Image

CX, CY, SCALE = 10 + 72, 75 + 51, 0.0164


def blobs(path):
    im = Image.open(path).convert("RGB")
    px = im.load()
    box = (10, 75, 152, 200)
    seen, out = set(), []
    is_green = lambda c: c[1] > c[0] + 40 and c[1] > c[2] + 40
    for y in range(box[1], box[3]):
        for x in range(box[0], box[2]):
            if (x, y) in seen or not is_green(px[x, y]):
                continue
            st, pts = [(x, y)], []
            seen.add((x, y))
            while st:
                a, b = st.pop()
                pts.append((a, b))
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        n = (a + dx, b + dy)
                        if box[0] <= n[0] < box[2] and box[1] <= n[1] < box[3] and n not in seen and is_green(px[n]):
                            seen.add(n)
                            st.append(n)
            out.append((sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts), len(pts)))
    return out


def main():
    shot, layout = sys.argv[1:3]
    cases = json.load(open(layout))
    found = [b for b in blobs(shot) if b[2] >= 2]
    result = [[] for _ in cases]
    unmatched = []
    for bx, by, n in found:
        best = None
        for ci, creeps in enumerate(cases):
            for ki, (x, y) in enumerate(creeps):
                d = ((CX + x * SCALE - bx) ** 2 + (CY - y * SCALE - by) ** 2) ** 0.5
                if best is None or d < best[0]:
                    best = (d, ci, ki)
        if best and best[0] <= 3.5:
            result[best[1]].append(best[2]) if best[2] not in result[best[1]] else None
        else:
            unmatched.append((round(bx, 1), round(by, 1), n))
    print(json.dumps({"icons": [sorted(r) for r in result], "unmatched": unmatched}))


main()
