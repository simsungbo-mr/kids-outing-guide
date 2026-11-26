#!/usr/bin/env python3
"""
전국 5살 아이 나들이·공연·축제·신상 가이드 — 일일 자동 동기화 스크립트
- KOPIS(공연예술통합전산망) OpenAPI에서 전국 아동 공연(kidstate=Y)을 자동 수집합니다.
- 기존 큐레이션된 나들이·박물관·축제·신상 데이터(id가 'kopis_'로 시작하지 않는 항목)는 그대로 보존합니다.
- 외부 패키지 없이 Python 3 표준 라이브러리만 사용합니다.
"""

import concurrent.futures
import datetime
import json
import os
import re
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

PLACES_JSON_PATH = os.path.join("data", "places.json")
KOPIS_API_KEY = os.environ.get("KOPIS_API_KEY", "").strip()
KOPIS_LIST_URL = "https://www.kopis.or.kr/openApi/restful/pblprfr"
KOPIS_DETAIL_URL = "https://www.kopis.or.kr/openApi/restful/pblprfr/{mt20id}"

REGION_MAP = [
    ("서울", "서울"),
    ("경기", "경기"),
    ("인천", "인천"),
    ("강원", "강원"),
    ("대전", "충청·세종·대전"),
    ("세종", "충청·세종·대전"),
    ("충청", "충청·세종·대전"),
    ("충남", "충청·세종·대전"),
    ("충북", "충청·세종·대전"),
    ("부산", "경상·부산·대구"),
    ("대구", "경상·부산·대구"),
    ("울산", "경상·부산·대구"),
    ("경상", "경상·부산·대구"),
    ("경남", "경상·부산·대구"),
    ("경북", "경상·부산·대구"),
    ("광주", "전라·광주"),
    ("전라", "전라·광주"),
    ("전북", "전라·광주"),
    ("전남", "전라·광주"),
    ("제주", "제주"),
]


def fetch_xml(url: str, timeout: int = 15):
    req = urllib.request.Request(url, headers={"User-Agent": "KidsOutingGuide/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
        return ET.fromstring(raw)
    except Exception:
        # Retry over http if https fails on KOPIS
        if url.startswith("https://"):
            http_url = "http://" + url[len("https://"):]
            req2 = urllib.request.Request(http_url, headers={"User-Agent": "KidsOutingGuide/1.0"})
            with urllib.request.urlopen(req2, timeout=timeout) as resp:
                raw = resp.read()
            return ET.fromstring(raw)
        raise


def get_text(elem, tag: str, default: str = "") -> str:
    node = elem.find(tag)
    if node is not None and node.text:
        return node.text.strip()
    return default


def map_region(area_str: str):
    for prefix, mapped in REGION_MAP:
        if prefix in area_str:
            return mapped
    return "서울"


def parse_min_price(price_str: str) -> int:
    if not price_str:
        return 0
    if "전석무료" in price_str or "무료" in price_str:
        nums = [int(n.replace(",", "")) for n in re.findall(r"(\d{1,3}(?:,\d{3})+|\d{4,6})\s*원", price_str)]
        return 0 if not nums else min(nums)
    nums = [int(n.replace(",", "")) for n in re.findall(r"(\d{1,3}(?:,\d{3})+|\d{4,6})\s*원", price_str)]
    return min(nums) if nums else 20000


def classify_price_tier(price_min: int) -> str:
    if price_min == 0:
        return "무료"
    if price_min <= 10000:
        return "1만원 이하"
    if price_min <= 30000:
        return "1~3만원"
    if price_min <= 50000:
        return "3~5만원"
    return "5만원 이상"


def classify_value_grade(price_min: int) -> str:
    if price_min <= 20000:
        return "S"
    if price_min <= 40000:
        return "A"
    return "B"


def parse_age_info(age_str: str):
    s = age_str or "전체 관람가"
    suitable_for_5 = True
    groups = []

    if "전체" in s:
        return ["영아 (0~2세)", "유아 (3~5세)", "어린이 (6~9세)"], True

    m_month = re.search(r"(\d+)\s*개월", s)
    m_year = re.search(r"(\d+)\s*세", s)

    min_age = 0
    if m_month:
        min_age = int(m_month.group(1)) / 12.0
    elif m_year:
        min_age = int(m_year.group(1))
    elif "초등" in s:
        min_age = 7

    if min_age <= 2:
        groups.append("영아 (0~2세)")
    if min_age <= 5:
        groups.append("유아 (3~5세)")
    else:
        suitable_for_5 = False
    if min_age <= 9:
        groups.append("어린이 (6~9세)")
    if min_age >= 7 or "초등" in s:
        groups.append("초등 이상 (10세+)")

    if not groups:
        groups = ["유아 (3~5세)", "어린이 (6~9세)"]
    return groups, suitable_for_5


def extract_subregion(area_str: str, venue: str) -> str:
    # Try to clean area name like '서울특별시', '경기도'
    cleaned = re.sub(r"(특별시|광역시|특별자치시|특별자치도|도)$", "", area_str).strip()
    m = re.search(r"\[([^\]]+)\]", venue)
    if m:
        return f"{cleaned} {m.group(1)}".strip()
    return cleaned or "전국"


def fetch_kopis_show_ids(api_key: str, days_ahead: int = 60, max_shows: int = 250):
    today = datetime.date.today()
    seen = {}

    # KOPIS allows max 31 days per request; split into 30-day windows
    offset = 0
    while offset < days_ahead and len(seen) < max_shows:
        st = today + datetime.timedelta(days=offset)
        ed = today + datetime.timedelta(days=min(offset + 29, days_ahead))
        st_str = st.strftime("%Y%m%d")
        ed_str = ed.strftime("%Y%m%d")

        for cpage in range(1, 5):
            params = urllib.parse.urlencode({
                "service": api_key,
                "stdate": st_str,
                "eddate": ed_str,
                "cpage": cpage,
                "rows": 100,
                "kidstate": "Y",
            })
            url = f"{KOPIS_LIST_URL}?{params}"
            try:
                root = fetch_xml(url)
            except Exception as exc:
                print(f"[WARN] List fetch failed ({st_str}~{ed_str} p{cpage}): {exc}", file=sys.stderr)
                break

            dbs = root.findall("db")
            if not dbs:
                break

            for db in dbs:
                mt20id = get_text(db, "mt20id")
                prfstate = get_text(db, "prfstate")
                if not mt20id or prfstate == "공연완료":
                    continue
                if mt20id not in seen:
                    seen[mt20id] = {
                        "mt20id": mt20id,
                        "prfnm": get_text(db, "prfnm"),
                        "prfpdfrom": get_text(db, "prfpdfrom"),
                        "prfpdto": get_text(db, "prfpdto"),
                        "fcltynm": get_text(db, "fcltynm"),
                        "poster": get_text(db, "poster"),
                        "area": get_text(db, "area"),
                        "genrenm": get_text(db, "genrenm"),
                        "prfstate": prfstate,
                    }
                    if len(seen) >= max_shows:
                        break
            if len(dbs) < 100 or len(seen) >= max_shows:
                break
        offset += 30

    return list(seen.values())


def enrich_kopis_show(api_key: str, base: dict, today_str: str):
    mt20id = base["mt20id"]
    url = f"{KOPIS_DETAIL_URL.format(mt20id=mt20id)}?service={urllib.parse.quote(api_key)}"
    price_str = ""
    age_str = "전체 관람가"
    runtime = ""
    dtguidance = ""
    booking_url = f"https://kopis.or.kr/por/db/pblprfr/pblprfrView.do?mt20Id={mt20id}"

    try:
        root = fetch_xml(url, timeout=12)
        db = root.find("db")
        if db is not None:
            price_str = get_text(db, "pcseguidance")
            age_str = get_text(db, "prfage") or age_str
            runtime = get_text(db, "prfruntime")
            dtguidance = get_text(db, "dtguidance")
            rel = db.find("./relates/relate/relateurl")
            if rel is not None and rel.text and rel.text.strip().startswith("http"):
                booking_url = rel.text.strip()
    except Exception:
        pass

    price_min = parse_min_price(price_str)
    price_tier = classify_price_tier(price_min)
    value_grade = classify_value_grade(price_min)
    age_groups, suitable_for_5 = parse_age_info(age_str)
    region = map_region(base["area"])
    sub_region = extract_subregion(base["area"], base["fcltynm"])
    period = f"{base['prfpdfrom']} ~ {base['prfpdto']}"
    age_detail = f"{age_str}" + (f" · 러닝타임 {runtime}" if runtime else "")
    poster_url = base["poster"]
    if poster_url.startswith("http://"):
        poster_url = "https://" + poster_url[len("http://"):]

    highlights = [f"KOPIS 실시간 등록 ({base['prfstate'] or '공연중'})"]
    if base["genrenm"]:
        highlights.append(f"장르: {base['genrenm']}")
    if dtguidance:
        highlights.append(f"공연시간: {dtguidance[:60]}")

    value_reason = (
        f"최저 {price_min:,}원대(KOPIS 공식 등록)로 즐기는 {region} 아동 {base['genrenm'] or '공연'}"
        if price_min > 0
        else f"무료 관람 가능한 {region} 아동 {base['genrenm'] or '공연'}"
    )

    return {
        "id": f"kopis_{mt20id}",
        "title": base["prfnm"],
        "category": "공연·연극·뮤지컬",
        "region": region,
        "subRegion": sub_region,
        "address": f"{base['area']} {base['fcltynm']}".strip(),
        "priceTier": price_tier,
        "priceMin": price_min,
        "priceText": price_str or "예매처 가격 확인",
        "ageGroups": age_groups,
        "ageDetail": age_detail,
        "suitableFor5": suitable_for_5,
        "parkingType": "유료 주차",
        "parkingDetail": f"{base['fcltynm']} 부설 또는 인근 주차장 이용 (공연장 안내 확인)",
        "environment": "실내",
        "periodOrHours": period,
        "reservation": "사전예약 필수",
        "reservationDetail": "KOPIS 연계 예매처 사전예매",
        "valueGrade": value_grade,
        "valueReason": value_reason,
        "highlights": highlights,
        "posterUrl": poster_url,
        "sourceTitle": "KOPIS 공연예술통합전산망 실시간 연동",
        "sourceUrl": booking_url,
        "updatedAt": today_str,
        "isNew": base["prfstate"] == "공연예정",
        "isLiveApi": True,
    }


def main():
    if not KOPIS_API_KEY:
        print("[ERROR] KOPIS_API_KEY 환경변수가 설정되지 않았습니다.", file=sys.stderr)
        sys.exit(1)

    with open(PLACES_JSON_PATH, "r", encoding="utf-8") as f:
        existing_data = json.load(f)

    # Keep all non-KOPIS curated places (나들이/체험관/축제/신상)
    curated = [p for p in existing_data.get("places", []) if not str(p.get("id", "")).startswith("kopis_")]
    # Also remove old manually entered performances only if KOPIS returns fresh ones
    curated_non_shows = [p for p in curated if p.get("category") != "공연·연극·뮤지컬"]
    curated_shows = [p for p in curated if p.get("category") == "공연·연극·뮤지컬"]

    today_str = datetime.date.today().strftime("%Y-%m-%d")
    print(f"[INFO] Fetching KOPIS nationwide kids performances (kidstate=Y) as of {today_str}...")
    raw_shows = fetch_kopis_show_ids(KOPIS_API_KEY, days_ahead=60, max_shows=240)
    print(f"[INFO] Found {len(raw_shows)} live KOPIS shows. Enriching details...")

    live_shows = []
    if raw_shows:
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
            futures = [ex.submit(enrich_kopis_show, KOPIS_API_KEY, s, today_str) for s in raw_shows]
            for fut in concurrent.futures.as_completed(futures):
                try:
                    live_shows.append(fut.result())
                except Exception as exc:
                    print(f"[WARN] Detail enrich failed: {exc}", file=sys.stderr)

    # Sort live shows by valueGrade then priceMin
    grade_rank = {"S": 3, "A": 2, "B": 1}
    live_shows.sort(key=lambda x: (-grade_rank.get(x["valueGrade"], 0), x["priceMin"], x["title"]))

    if live_shows:
        merged = curated_non_shows + live_shows
    else:
        print("[WARN] No live KOPIS shows returned; keeping existing curated shows.")
        merged = curated_non_shows + curated_shows

    existing_data["places"] = merged
    existing_data["meta"] = {
        "title": "전국 5살 아이 나들이·공연·축제·신상 가이드",
        "lastUpdated": today_str,
        "targetAgeNote": "5세(만 4~5세) 중심 · 전 연령 필터 지원",
        "totalCount": len(merged),
        "liveKopisCount": len(live_shows),
    }

    with open(PLACES_JSON_PATH, "w", encoding="utf-8") as f:
        json.dump(existing_data, f, ensure_ascii=False, indent=2)

    print(f"[OK] Saved {len(merged)} total items ({len(curated_non_shows)} curated + {len(live_shows)} live KOPIS shows).")


if __name__ == "__main__":
    main()
