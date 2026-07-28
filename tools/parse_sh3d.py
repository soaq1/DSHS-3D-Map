# -*- coding: utf-8 -*-
"""
Sweet Home 3D (.sh3d) -> rooms.json / check.png

.sh3d 는 ZIP 이며 그 안의 Home.xml 만 사용한다.
room 에는 name 속성이 없으므로 label 의 (x, y) 가 어느 room 폴리곤 안에
들어가는지 점-다각형 판정으로 이름을 붙인다.

★ 층·동 구성은 plan.config.json 에서 읽는다. 새 층이나 새 동을 추가할 때
  이 파일을 고칠 필요가 없다.

실행: py -3 parse_sh3d.py
출력: rooms.json, check.png
"""

import glob
import json
import os
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from collections import defaultdict

from shapely.geometry import Point, Polygon

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Polygon as MplPolygon, Patch

HERE = os.path.dirname(os.path.abspath(__file__))       # tools/
ROOT = os.path.dirname(HERE)                            # 프로젝트 루트
DATA = os.path.join(ROOT, "data")                       # 도면 원본 + rooms.json
CONFIG_PATH = os.path.join(HERE, "plan.config.json")

TYPE_COLORS = {  # check.png 전용 (뷰어 색과 무관)
    "normal": "#cfe3f7",
    "circulation": "#ffe1b3",
    "service": "#d9f2d0",
    "hall": "#e2e2ea",
}

_warnings = []


def warn(msg):
    _warnings.append(msg)
    print("  [경고] " + msg)


def die(msg):
    raise SystemExit("중단: " + msg)


# ---------------------------------------------------------------- 설정
def load_config():
    if not os.path.exists(CONFIG_PATH):
        die("plan.config.json 이 없습니다. 층·동 구성을 담는 필수 파일입니다.")
    with open(CONFIG_PATH, encoding="utf-8") as f:
        cfg = json.load(f)
    # '_' 로 시작하는 키는 전부 주석이다
    return {k: v for k, v in cfg.items() if not k.startswith("_")}


def find_source(cfg):
    if cfg.get("source"):
        p = os.path.join(DATA, cfg["source"])
        if not os.path.exists(p):
            die("설정의 source 파일을 찾을 수 없습니다 -> data/" + cfg["source"])
        return p
    cands = sorted(glob.glob(os.path.join(DATA, "*.sh3d")))
    if not cands:
        die("data/ 에서 .sh3d 파일을 찾지 못했습니다.")
    if len(cands) > 1:
        warn("`.sh3d` 가 여러 개입니다. 첫 번째를 씁니다 -> "
             + os.path.basename(cands[0])
             + "  (plan.config.json 의 source 로 지정하세요)")
    return cands[0]


def load_home_xml(sh3d_path):
    """.sh3d(ZIP) 안의 Home.xml 만 읽는다. 압축 해제 없음."""
    with zipfile.ZipFile(sh3d_path) as z:
        return ET.fromstring(z.read("Home.xml"))


def clean_text(s):
    """label 텍스트: '\\n' -> 공백, 연속 공백 1칸, strip."""
    if s is None:
        return ""
    return re.sub(r"\s+", " ", s.replace("\n", " ")).strip()


# ---------------------------------------------------------------- 층
def build_level_map(root, cfg):
    """Sweet Home 3D level id -> 층 번호.

    지금 도면에는 <level> 이 없다. 그 경우 전부 1층으로 본다.
    나중에 한 파일 안에 층을 나눠 그리면 자동으로 인식된다.
    """
    levels = root.findall(".//level")
    if not levels:
        print("층 정보: <level> 없음 -> 전부 1층으로 처리")
        return {}, [1]

    named = cfg.get("levels") or {}

    # 표고 순으로 정렬해야 '낮은 층부터 1, 2, 3' 규칙이 맞는다
    def elevation(el):
        try:
            return float(el.get("elevation", 0))
        except (TypeError, ValueError):
            return 0.0

    ordered = sorted(levels, key=elevation)

    mapping = {}
    for i, el in enumerate(ordered):
        name = el.get("name", "") or ""
        if name in named:                       # 1) 설정에 명시
            floor, how = named[name], "설정"
        else:
            m = re.search(r"(-?\d+)", name)     # 2) 이름 속 숫자
            if m:
                floor, how = int(m.group(1)), "이름"
            else:                               # 3) 표고 순서
                floor, how = i + 1, "표고순"
        mapping[el.get("id")] = floor
        print("층 정보: '%s' (표고 %.0f) -> %d층  [%s]"
              % (name or "(이름없음)", elevation(el), floor, how))

    floors = sorted(set(mapping.values()))
    if len(floors) != len(set(mapping.values())):
        warn("층 번호가 중복됩니다. plan.config.json 의 levels 로 명시하세요.")
    return mapping, floors


def report_offsets(rooms_by_floor, floors, offsets):
    """설정된 오프셋과, bbox 최소 모서리 기준 자동 추정값을 함께 보여준다.
    새 층을 그렸을 때 여기 출력된 값을 config 에 옮겨 적으면 된다."""
    if len(floors) < 2:
        return
    base_floor = min(floors)

    def bbox(f):
        xs = [x for _, _, pts in rooms_by_floor[f] for x, _ in pts]
        ys = [y for _, _, pts in rooms_by_floor[f] for _, y in pts]
        return min(xs), min(ys), max(xs), max(ys)

    bx, by, _, _ = bbox(base_floor)
    print("층 정렬 (오프셋 적용 후 bbox 최소 모서리 기준):")
    for f in floors:
        mnx, mny, mxx, mxy = bbox(f)
        drift = (mnx - bx, mny - by)
        mark = "" if max(abs(drift[0]), abs(drift[1])) < 1.0 else "  <- 어긋남?"
        print("  %d층  설정 오프셋 (%+.0f, %+.0f)   정렬 후 좌상단 편차 (%+.0f, %+.0f)%s"
              % (f, offsets.get(f, (0, 0))[0], offsets.get(f, (0, 0))[1],
                 drift[0], drift[1], mark))
        if f not in offsets:
            warn("%d층 오프셋이 설정에 없습니다. 추정값 (%+.0f, %+.0f) 를 "
                 "plan.config.json 의 floorOffsets 에 적어두세요."
                 % (f, offsets.get(f, (0, 0))[0] - drift[0],
                    offsets.get(f, (0, 0))[1] - drift[1]))


def floor_of(elem, level_map):
    if not level_map:
        return 1
    lid = elem.get("level")
    if lid is None:
        return min(level_map.values())
    if lid not in level_map:
        warn("알 수 없는 level 참조: " + str(lid))
        return min(level_map.values())
    return level_map[lid]


# ---------------------------------------------------------------- 분류
def classify_building(cx, cz, name, floor, cfg):
    """설정의 범위 규칙으로 동을 정한다. overrides 가 최우선."""
    ov = cfg.get("overrides") or {}
    for key in ("%dF:%s" % (floor, name), name):
        if key in ov:
            return ov[key]

    def inside(rng, v):
        if rng is None:
            return True
        lo, hi = rng
        if lo is not None and v < lo:
            return False
        if hi is not None and v >= hi:
            return False
        return True

    for b in cfg.get("buildings", []):
        if inside(b.get("z"), cz) and inside(b.get("x"), cx):
            return b["name"]
    return "미분류"


def classify_type(name, cfg):
    for type_name, words in (cfg.get("types") or {}).items():
        if any(w in name for w in words):
            return type_name
    return "normal"


def is_shaft(name, cfg):
    """층을 관통하는 공간(계단실·엘리베이터)인가. 뷰어가 기둥 하나로 그린다."""
    return any(w in name for w in (cfg.get("shaftWords") or []))


# ---------------------------------------------------------------- 본체
def main():
    cfg = load_config()
    sh3d_path = find_source(cfg)
    print("입력 파일: " + os.path.basename(sh3d_path))

    root = load_home_xml(sh3d_path)
    level_map, _ = build_level_map(root, cfg)

    # --- room 폴리곤 ---------------------------------------------------
    room_elems = root.findall(".//room")
    label_elems = root.findall(".//label")
    print("room %d개, label %d개 발견" % (len(room_elems), len(label_elems)))

    # 층 오프셋: 이 도면은 층이 수직으로 겹쳐 있지 않고 캔버스 네 곳에 따로
    # 그려져 있다. 층을 쌓으려면 각 층을 1층 좌표계로 옮겨야 한다.
    offsets = {int(k): tuple(v) for k, v in (cfg.get("floorOffsets") or {}).items()}

    def off(floor):
        return offsets.get(floor, (0.0, 0.0))

    rooms_by_floor = defaultdict(list)   # floor -> [(id, Polygon, pts)]
    for r in room_elems:
        f = floor_of(r, level_map)
        dx, dy = off(f)
        pts = [(float(p.get("x")) + dx, float(p.get("y")) + dy)
               for p in r.findall("point")]
        if len(pts) < 3:
            die("꼭짓점이 3개 미만인 room 이 있습니다 -> " + str(r.get("id")))
        rooms_by_floor[f].append((r.get("id"), Polygon(pts), pts))

    labels_by_floor = defaultdict(list)  # floor -> [(id, name, x, y)]
    for l in label_elems:
        name = clean_text(l.findtext("text"))
        if not name:
            die("텍스트가 빈 label 이 있습니다 -> " + str(l.get("id")))
        f = floor_of(l, level_map)
        dx, dy = off(f)
        labels_by_floor[f].append(
            (l.get("id"), name, float(l.get("x")) + dx, float(l.get("y")) + dy)
        )

    floors = sorted(rooms_by_floor.keys())
    report_offsets(rooms_by_floor, floors, offsets)

    # --- 점-다각형 매칭 (★ 반드시 층 안에서만) ---------------------------
    # 층이 쌓이면 2층 방과 1층 방의 폴리곤이 평면상 겹친다. 층을 나누지 않고
    # 매칭하면 2층 라벨이 1층 방에 붙는다.
    # 두 가지 실패를 다르게 다룬다:
    #  - 방에 라벨이 없다  -> 이름을 지을 수 없다. unnamedRoom 설정에 따라 중단/경고.
    #  - 라벨에 방이 없다  -> 아직 방을 안 그렸거나 가구 주석이다. 경고만 하고 넘어간다.
    #    (3·4층이 작업 중이라 이걸로 막으면 전체 파이프라인이 멈춘다)
    matched = {}   # floor -> { room_index: label_index }
    errors = []
    orphan_total = 0
    unnamed_total = 0

    for floor in floors:
        polys = rooms_by_floor[floor]
        labels = labels_by_floor.get(floor, [])
        room_to_labels = defaultdict(list)
        orphans = []

        for li, (_, name, lx, ly) in enumerate(labels):
            pt = Point(lx, ly)
            hits = [ri for ri, (_, poly, _) in enumerate(polys) if poly.contains(pt)]
            if len(hits) == 0:
                orphans.append(name)
            elif len(hits) > 1:
                errors.append("%d층: 라벨 '%s' 이(가) 방 %d개에 동시에 속합니다."
                              % (floor, name, len(hits)))
            for ri in hits:
                room_to_labels[ri].append(li)

        unnamed = []
        duplicated = set()   # 같은 글자 라벨이 겹쳐 있는 방
        for ri in range(len(polys)):
            hits = room_to_labels.get(ri, [])
            if len(hits) == 0:
                unnamed.append(ri)
            elif len(hits) > 1:
                names = [labels[i][1] for i in hits]
                # 글자가 다르면 어느 쪽이 방 이름인지 알 수 없다 -> 중단.
                # 글자가 같으면 같은 라벨을 두 번 찍은 것이라 뜻이 갈리지 않는다.
                if len(set(names)) == 1:
                    duplicated.add(ri)
                    warn("%d층: '%s' 라벨이 한 방에 %d개 겹쳐 있습니다 "
                         "(도면에서 하나만 남기세요). 이름은 그대로 씁니다."
                         % (floor, names[0], len(names)))
                else:
                    errors.append("%d층: room %s 안에 라벨이 %d개입니다: %s"
                                  % (floor, polys[ri][0][:13], len(hits),
                                     ", ".join(names)))

        if orphans:
            orphan_total += len(orphans)
            warn("%d층: 방이 없는 라벨 %d개 (아직 안 그린 방이거나 주석) -> %s"
                 % (floor, len(orphans), ", ".join(orphans)))

        if unnamed:
            unnamed_total += len(unnamed)
            detail = ", ".join(
                "중심(%.0f, %.0f) %.1f㎡" % (polys[ri][1].centroid.x,
                                             polys[ri][1].centroid.y,
                                             polys[ri][1].area / 1e4)
                for ri in unnamed)
            if (cfg.get("unnamedRoom") or "warn") == "error":
                errors.append("%d층: 라벨 없는 방 %d개 -> %s"
                              % (floor, len(unnamed), detail))
            else:
                warn("%d층: 라벨 없는 방 %d개 -> %s  ('이름없음' 으로 둡니다)"
                     % (floor, len(unnamed), detail))

        matched[floor] = {ri: v[0] for ri, v in room_to_labels.items()
                          if len(v) == 1 or ri in duplicated}

    if errors:
        print("\n=== 매칭 실패 ===")
        for e in errors:
            print("  - " + e)
        die("위 문제를 도면에서 고치거나 plan.config.json 을 조정하세요.")

    total_rooms = sum(len(v) for v in rooms_by_floor.values())
    named = sum(len(v) for v in matched.values())
    print("라벨-방 매칭: %d개 층에서 방 %d개 중 %d개 이름 붙임 "
          "(라벨만 있고 방 없음 %d개, 방만 있고 라벨 없음 %d개)"
          % (len(floors), total_rooms, named, orphan_total, unnamed_total))

    # --- bounding box / 중심 (★ 전 층 공통) -----------------------------
    # 층마다 따로 중심을 잡으면 층끼리 어긋나 쌓인다.
    xs = [x for f in floors for _, _, pts in rooms_by_floor[f] for x, _ in pts]
    ys = [y for f in floors for _, _, pts in rooms_by_floor[f] for _, y in pts]
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
    cx0 = (minx + maxx) / 2.0
    cy0 = (miny + maxy) / 2.0
    print("원본 bbox: x %.1f~%.1f / y %.1f~%.1f   중심 (%.1f, %.1f)"
          % (minx, maxx, miny, maxy, cx0, cy0))

    # --- 방 레코드 조립 ---------------------------------------------------
    rooms = []
    used_ids = defaultdict(int)

    unnamed_seq = 0
    for floor in floors:
        polys = rooms_by_floor[floor]
        labels = labels_by_floor[floor]
        for ri, (rid, poly, pts) in enumerate(polys):
            if ri in matched[floor]:
                name = labels[matched[floor][ri]][1]
            else:
                unnamed_seq += 1
                name = "이름없음-%d" % unnamed_seq
            c = poly.centroid
            building = classify_building(c.x, c.y, name, floor, cfg)
            rtype = classify_type(name, cfg)

            base_id = "%s-%dF-%s" % (building, floor, name)
            used_ids[base_id] += 1
            room_id = base_id if used_ids[base_id] == 1 else "%s-%d" % (
                base_id, used_ids[base_id])

            record = {
                "id": room_id,
                "name": name,
                "building": building,
                "floor": floor,
                "type": rtype,
                "area": round(poly.area / 10000.0, 1),
                # y 부호는 그대로 둔다 (뷰어에서 처리). 중심만 이동.
                "polygon": [[round(x - cx0, 2), round(y - cy0, 2)] for x, y in pts],
                "_poly": poly,   # 검증용, 출력 전에 제거
            }
            # 참인 방에만 넣는다. 대부분의 방에 false 를 달면 json 만 커진다.
            if is_shaft(name, cfg):
                record["shaft"] = True
            rooms.append(record)

    bxs = [p[0] for r in rooms for p in r["polygon"]]
    bzs = [p[1] for r in rooms for p in r["polygon"]]

    # 실제로 등장한 동만, 설정 순서대로 (뷰어가 색과 순서를 여기서 읽는다)
    present = {r["building"] for r in rooms}
    buildings_meta = [
        {"name": b["name"], "color": b.get("color", "#22d3ee")}
        for b in cfg.get("buildings", []) if b["name"] in present
    ]
    for extra in sorted(present - {b["name"] for b in buildings_meta}):
        warn("설정에 없는 동이 생겼습니다: '%s'. plan.config.json 의 buildings 에 "
             "추가하세요." % extra)
        buildings_meta.append({"name": extra, "color": "#94a3b8"})

    out = {
        "meta": {
            "source": os.path.basename(sh3d_path),
            "unit": cfg.get("unit", "cm"),
            "wallHeight": cfg.get("wallHeight", 250),
            "floorHeight": cfg.get("floorHeight", 400),
            "floors": floors,
            "buildings": buildings_meta,
            # 종류별 색 덮어쓰기. 뷰어가 동 색보다 우선해서 읽는다.
            "typeColors": cfg.get("typeColors") or {},
            "center": [round(cx0, 2), round(cy0, 2)],
            "bounds": {
                "x": [round(min(bxs), 2), round(max(bxs), 2)],
                "z": [round(min(bzs), 2), round(max(bzs), 2)],
            },
        },
        "rooms": [{k: v for k, v in r.items() if k != "_poly"} for r in rooms],
    }

    json_path = os.path.join(DATA, "rooms.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print("저장: " + json_path)

    validate(rooms, floors, cfg)
    print("4) 도면 이미지 저장: " + draw(rooms, floors))

    print("\n=== 방 목록 ===")
    for floor in floors:
        for b in buildings_meta:
            names = [r["name"] for r in rooms
                     if r["floor"] == floor and r["building"] == b["name"]]
            if names:
                print("[%d층 %s] %d개: %s" % (floor, b["name"], len(names),
                                              ", ".join(names)))

    if _warnings:
        print("\n경고 %d건이 있습니다. 위 내용을 확인하세요." % len(_warnings))
    else:
        print("\n모든 검증 통과.")


# ---------------------------------------------------------------- 검증
def validate(rooms, floors, cfg):
    print("\n=== 검증 ===")
    tol = cfg.get("tolerance", {})
    area_tol = tol.get("areaM2", 10)
    overlap_limit = tol.get("overlapM2", 0.5)
    expect = cfg.get("expect", {})

    for floor in floors:
        fr = [r for r in rooms if r["floor"] == floor]
        exp = expect.get(str(floor))
        total_area = sum(r["_poly"].area for r in fr) / 10000.0

        by_b = defaultdict(int)
        for r in fr:
            by_b[r["building"]] += 1
        breakdown = " / ".join("%s %d" % (k, by_b[k]) for k in sorted(by_b))

        if exp is None:
            # 기댓값이 없는 새 층은 막지 않는다. 숫자를 보고 설정에 적어 넣으면 된다.
            print("%d층: 방 %d개 (%s), 총 면적 %.1f m²  [기댓값 없음 — 확인 후 "
                  "plan.config.json 의 expect 에 적어두세요]"
                  % (floor, len(fr), breakdown, total_area))
        else:
            ok = True
            if exp.get("rooms") is not None and len(fr) != exp["rooms"]:
                warn("%d층 방 개수 %d개 (기대 %d개)" % (floor, len(fr), exp["rooms"]))
                ok = False
            if exp.get("areaM2") is not None and abs(total_area - exp["areaM2"]) > area_tol:
                warn("%d층 총 면적 %.1f m² (기대 %.0f ±%.0f)"
                     % (floor, total_area, exp["areaM2"], area_tol))
                ok = False
            for b, n in (exp.get("byBuilding") or {}).items():
                if by_b.get(b, 0) != n:
                    warn("%d층 %s 방 개수 %d개 (기대 %d개)"
                         % (floor, b, by_b.get(b, 0), n))
                    ok = False
            print("%d층: 방 %d개 (%s), 총 면적 %.1f m²  %s"
                  % (floor, len(fr), breakdown, total_area, "OK" if ok else "<- 기대와 다름"))

    invalid = [r["id"] for r in rooms if not r["_poly"].is_valid]
    if invalid:
        warn("폴리곤이 유효하지 않은 방 %d개: %s" % (len(invalid), ", ".join(invalid)))
    else:
        print("폴리곤 유효성: %d개 전부 True" % len(rooms))

    # 겹침은 같은 층 안에서만 본다. 층이 다르면 겹치는 게 정상이다.
    overlaps = []
    for floor in floors:
        fr = [r for r in rooms if r["floor"] == floor]
        for i in range(len(fr)):
            pi = fr[i]["_poly"]
            if not pi.is_valid:
                pi = pi.buffer(0)
            for j in range(i + 1, len(fr)):
                pj = fr[j]["_poly"]
                if not pj.is_valid:
                    pj = pj.buffer(0)
                if not pi.intersects(pj):
                    continue
                a = pi.intersection(pj).area / 10000.0
                if a > overlap_limit:
                    overlaps.append((fr[i]["id"], fr[j]["id"], a))
    if overlaps:
        warn("교차 면적 %.1f m² 초과인 방 쌍 %d개:" % (overlap_limit, len(overlaps)))
        for a, b, ar in sorted(overlaps, key=lambda t: -t[2])[:10]:
            print("       %s <-> %s : %.2f m²" % (a, b, ar))
    else:
        print("같은 층 방 겹침: %.1f m² 초과 0쌍 OK" % overlap_limit)


# ---------------------------------------------------------------- 그림
def pick_korean_font():
    from matplotlib import font_manager
    installed = {f.name for f in font_manager.fontManager.ttflist}
    for cand in ("Malgun Gothic", "NanumGothic", "Nanum Gothic", "AppleGothic",
                 "Gulim", "Batang", "Noto Sans KR", "Noto Sans CJK KR"):
        if cand in installed:
            return cand
    return None


def draw(rooms, floors):
    font = pick_korean_font()
    if font:
        plt.rcParams["font.family"] = font
    else:
        print("  [알림] 한글 폰트를 찾지 못해 이름이 깨질 수 있습니다.")
    plt.rcParams["axes.unicode_minus"] = False

    n = len(floors)
    fig, axes = plt.subplots(1, n, figsize=(20 * n, 14), squeeze=False)

    xs = [p[0] for r in rooms for p in r["polygon"]]
    zs = [p[1] for r in rooms for p in r["polygon"]]
    pad = 200

    for ax, floor in zip(axes[0], floors):
        for r in rooms:
            if r["floor"] != floor:
                continue
            ax.add_patch(MplPolygon(
                r["polygon"], closed=True,
                facecolor=TYPE_COLORS.get(r["type"], "#dddddd"),
                edgecolor="#333333", linewidth=1.0))
            cpt = Polygon(r["polygon"]).representative_point()
            ax.text(cpt.x, cpt.y, "%s\n%.1f㎡" % (r["name"], r["area"]),
                    ha="center", va="center", fontsize=7, color="#111111")

        ax.set_xlim(min(xs) - pad, max(xs) + pad)
        ax.set_ylim(min(zs) - pad, max(zs) + pad)
        ax.invert_yaxis()   # 평면도처럼 보이게 (SH3D 는 y 가 아래로 증가)
        ax.set_aspect("equal")
        ax.set_xlabel("x (cm)")
        ax.set_ylabel("y (cm, 아래로 증가)")
        ax.set_title("%d층 — 방 %d개"
                     % (floor, sum(1 for r in rooms if r["floor"] == floor)))

    axes[0][-1].legend(
        handles=[Patch(facecolor=v, edgecolor="#333333", label=k)
                 for k, v in TYPE_COLORS.items()],
        loc="upper right")

    fig.tight_layout()
    png_path = os.path.join(HERE, "check.png")
    fig.savefig(png_path, dpi=130)
    plt.close(fig)
    return png_path


if __name__ == "__main__":
    try:
        # stderr 도 같이 해야 die() 의 한글 메시지가 안 깨진다
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass
    main()
