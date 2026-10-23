#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""智能体端到端测试：检索质量 / AI 忠实度 / 边界 / 模型可用性"""
import json, sys, time, urllib.request, urllib.parse, statistics

BASE = sys.argv[1] if len(sys.argv) > 1 else "https://guaxiang-wendao.ck-si.workers.dev"

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"

def retry(fn, times=3, wait=1.5):
    """本机可能有 TUN/代理干扰，SSL 抖动重试一下"""
    last = None
    for i in range(times):
        try:
            return fn()
        except Exception as e:
            last = e
            if "SSL" not in str(e) and "EOF" not in str(e) and "timed out" not in str(e):
                raise
            time.sleep(wait * (i + 1))
    raise last


def post(path, payload, timeout=120):
    req = urllib.request.Request(BASE + path, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json", "User-Agent": UA, "Accept": "application/json"},
                                 method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())

def get(path, timeout=60):
    req = urllib.request.Request(BASE + path, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())

RETRIEVAL_CASES = [
    ("财位", ["财位", "聚财", "招财", "不聚财"]),
    ("家里怎么布置来财", ["财", "聚财", "招财"]),
    ("厨房怎么布置", ["灶", "厨房"]),
    ("卧室床头怎么摆", ["床", "睡"]),
    ("大门风水", ["大门", "门"]),
    ("卫生间在房子中间", ["厕", "卫", "中宫"]),
    ("文昌位", ["文昌"]),
    ("今天适合做什么", ["吉日", "择日", "日", "吉", "日子"]),
    ("办公室座位朝向", ["办公", "座位", "位"]),
    ("家里风水有什么禁忌", ["禁忌", "不聚财", "破财", "主凶", "不可"]),
    ("买房子怎么看风水", ["房", "风水"]),
    ("鱼缸放哪里", ["鱼缸", "水"]),
    ("镜子怎么摆", ["镜"]),
    ("横梁压顶怎么办", ["横梁", "压"]),
    ("孩子学习不好怎么调", ["文昌", "学"]),
    ("婚姻不顺怎么化解", ["婚", "姻缘"]),
    ("破财怎么办", ["财", "破"]),
    ("煞气是什么", ["煞"]),
    ("罗盘准不准", ["罗盘"]),
    ("九宫飞星", ["九宫", "飞星", "宫"]),
]

AI_CASES = [
    "家里的财位在哪，怎么摆才能来财",
    "厨房怎么布置",
    "卧室床头怎么摆",
    "家里风水有什么禁忌",
    "今天风水要注意什么",
    "鱼缸放哪里好",
    "大门对厕所怎么办",
]

def test_retrieval():
    print("\n" + "=" * 60)
    print("检索测试")
    print("=" * 60)
    ok = 0
    for q, kws in RETRIEVAL_CASES:
        try:
            d = retry(lambda: get("/api/search?q=" + urllib.parse.quote(q) + "&topK=6"))
            cites = d.get("citations", [])
            hit = any(any(k in (c.get("excerpt", "") + c.get("title", "")) for k in kws) for c in cites)
            top = cites[0]["excerpt"][:40].replace("\n", " ") if cites else "—"
            print(f"{'✓' if hit else '✗'} {q:20s} {len(cites)}条  首条: {top}")
            ok += 1 if hit else 0
        except Exception as e:
            print(f"✗ {q:20s} ERROR {e}")
    print(f"\n检索命中: {ok}/{len(RETRIEVAL_CASES)}")

def test_ai():
    print("\n" + "=" * 60)
    print("AI 回答测试（忠实度）")
    print("=" * 60)
    times = []
    for q in AI_CASES:
        try:
            t0 = time.time()
            d = retry(lambda: post("/api/ask", {"question": q}))
            dt = (time.time() - t0) * 1000
            times.append(dt)
            v = d.get("verdict")
            pts = d.get("points", [])
            qs = d.get("quotes", [])
            verified = sum(1 for x in qs if x.get("verified"))
            bad_ref = any(not p.get("verified") for p in pts)
            print(f"[{v}] {q}")
            print(f"   结论: {d.get('conclusion','')[:50]}")
            print(f"   建议 {len(pts)} 条 | 引用 {len(qs)} 条（核对通过 {verified}） | {dt:.0f}ms")
            if bad_ref:
                print("   ⚠ 存在无引用建议")
        except Exception as e:
            print(f"✗ {q} ERROR {e}")
    if times:
        print(f"\n平均耗时: {statistics.mean(times):.0f}ms  最慢: {max(times):.0f}ms")

def test_models():
    print("\n" + "=" * 60)
    print("模型可用性")
    print("=" * 60)
    lite = get("/api/models")
    for m in lite.get("models", []):
        try:
            t0 = time.time()
            d = post("/api/ask", {"question": "厨房怎么布置", "model": m["id"]}, timeout=90)
            dt = (time.time() - t0) * 1000
            v = d.get("verdict")
            used = d.get("model")
            flag = "✓" if v in ("有依据", "部分依据") else ("△" if v == "无依据" else "✗")
            print(f"{flag} {m['label']:22s} {v:6s} {dt:6.0f}ms  used={used}")
        except Exception as e:
            print(f"✗ {m['label']:22s} ERROR {str(e)[:60]}")

def test_edge():
    print("\n" + "=" * 60)
    print("边界 / 安全")
    print("=" * 60)
    cases = [
        ("空问题", lambda: post("/api/ask", {"question": ""})),
        ("超长", lambda: post("/api/ask", {"question": "财" * 500})),
        ("SQL注入", lambda: get("/api/search?q=" + urllib.parse.quote("' OR 1=1 --") + "&topK=3")),
        ("XSS载荷", lambda: get("/api/search?q=" + urllib.parse.quote("<script>alert(1)</script>") + "&topK=3")),
        ("奇怪编码", lambda: get("/api/search?q=" + urllib.parse.quote("😀💀🔥") + "&topK=3")),
        ("负数topK", lambda: get("/api/search?q=财&topK=-5")),
        ("超大topK", lambda: get("/api/search?q=财&topK=9999")),
    ]
    for name, fn in cases:
        try:
            r = fn()
            print(f"✓ {name:10s} -> {str(r)[:110]}")
        except Exception as e:
            msg = str(e)
            print(f"△ {name:10s} -> {msg[:110]}")

def test_vision():
    print("\n" + "=" * 60)
    print("图片识别")
    print("=" * 60)
    import base64, os
    candidates = ["/tmp/floorplan.png", "/tmp/bedmirror.png"]
    for path in candidates:
        if not os.path.exists(path):
            continue
        b = base64.b64encode(open(path, "rb").read()).decode()
        try:
            t0 = time.time()
            d = post("/api/vision", {"image": "data:image/png;base64," + b, "hint": "户型图"}, timeout=120)
            dt = (time.time() - t0) * 1000
            print(f"{'✓' if d.get('ok') else '✗'} {os.path.basename(path):18s} {dt:6.0f}ms  {d.get('model','')[:40]}")
            print("   ", (d.get("text") or "")[:100].replace("\n", " "))
        except Exception as e:
            print(f"✗ {os.path.basename(path)} ERROR {e}")

    print("\n边界：")
    for name, img in [("非法类型", "data:image/svg+xml;base64,PHN2Zz4="), ("空", "")]:
        try:
            post("/api/vision", {"image": img}, timeout=30)
            print(f"△ {name} 未拦截")
        except Exception as e:
            print(f"✓ {name} 已拦截 ({str(e)[:40]})")

if __name__ == "__main__":
    which = sys.argv[2] if len(sys.argv) > 2 else "all"
    if which in ("all", "r"): test_retrieval()
    if which in ("all", "a"): test_ai()
    if which in ("all", "m"): test_models()
    if which in ("all", "e"): test_edge()
    if which in ("all", "v"): test_vision()
