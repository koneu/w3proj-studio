"""Camp icons of a real map: what ticking "Show Creep Camp Icon" changes on the editor's minimap.

    python3 -I read-camp-icons-real.py <shot without icons.png> <shot with icons.png>

Both are --shot-screen pictures of the same map (the minimap box (10,75)-(152,200) of the 1600x1000 display). Prints
one JSON line: the blobs of changed pixels (centre x, y and size) outside the grey creep dots, which are drawn in both
pictures when the creeps' dots are on; the icons are the changes. Compare with predict-camp-icons.mjs."""
import json
import sys
from PIL import Image

BOX = (10, 75, 152, 200)


def blobs(a_path, b_path):
    a = Image.open(a_path).convert("RGB").load()
    b = Image.open(b_path).convert("RGB").load()
    changed = {(x, y) for y in range(BOX[1], BOX[3]) for x in range(BOX[0], BOX[2])
               if sum(abs(a[x, y][i] - b[x, y][i]) for i in range(3)) > 60}
    seen, out = set(), []
    for p in sorted(changed):
        if p in seen:
            continue
        st, pts = [p], []
        seen.add(p)
        while st:
            x, y = st.pop()
            pts.append((x, y))
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    n = (x + dx, y + dy)
                    if n in changed and n not in seen:
                        seen.add(n)
                        st.append(n)
        out.append({"x": sum(q[0] for q in pts) / len(pts), "y": sum(q[1] for q in pts) / len(pts), "n": len(pts)})
    return out


if __name__ == "__main__":
    print(json.dumps(blobs(sys.argv[1], sys.argv[2])))
