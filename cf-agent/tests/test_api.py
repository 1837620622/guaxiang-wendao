#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""智能体接口测试

用法：python3 tests/test_api.py [BASE_URL] [contract|quality|all]

- contract：接口契约，断言状态码、字段、拒绝规则和安全头。不调用大模型，
  失败时退出码为 1。本地可以先 `npx wrangler dev`，再建一张空表：
  `npx wrangler d1 execute guaxiang --local --command "CREATE TABLE IF NOT EXISTS chapters(ord INTEGER PRIMARY KEY, no INTEGER, title TEXT, body TEXT);"`
  然后运行 `python3 tests/test_api.py http://127.0.0.1:8787 contract`。
- quality：检索命中、AI 回答、模型可用性、识图。依赖线上数据和模型密钥。
  命中率只打印，不计入失败；接口报错（非 200）才计入失败。

问答每分钟 12 次（见 wrangler.toml 的 RL_ASK），超限时等待 retryAfter 秒再试一次。
"""
import base64
import json
import os
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "https://guaxiang-wendao.ck-si.workers.dev"
MODE = sys.argv[2] if len(sys.argv) > 2 else "all"

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"

CHECKS = 0
FAILED = []


def check(name, ok, detail=""):
    global CHECKS
    CHECKS += 1
    print(f"{'✓' if ok else '✗'} {name}" + (f"  [{detail}]" if detail and not ok else ""))
    if not ok:
        FAILED.append(name)


def read_body(raw, headers):
    if "json" in (headers.get("Content-Type") or ""):
        return json.loads(raw)
    return raw.decode("utf-8", "replace")


def call(method, path, json_body=None, raw=None, headers=None, timeout=60):
    """返回 (状态码, 响应头, 正文)。HTTP 错误也不抛异常，方便断言。"""
    data = raw
    h = {"User-Agent": UA, "Accept": "application/json"}
    if json_body is not None:
        data = json.dumps(json_body).encode()
        h["Content-Type"] = "application/json"
    h.update(headers or {})
    req = urllib.request.Request(BASE + path, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.headers, read_body(r.read(), r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.headers, read_body(e.read(), e.headers)


def retry(fn, times=3, wait=1.5):
    """本机可能有 TUN/代理干扰，SSL 抖动重试一下"""
    last = None
    for i in range(times):
        try:
            return fn()
        except Exception as e:
            last = e
            if not any(k in str(e) for k in ("SSL", "EOF", "timed out")):
                raise
            time.sleep(wait * (i + 1))
    raise last


def ask(payload, timeout=120):
    s, _, b = call("POST", "/api/ask", json_body=payload, timeout=timeout)
    if s == 429:
        time.sleep(min(int(b.get("retryAfter", 60)), 70) + 1)
        s, _, b = call("POST", "/api/ask", json_body=payload, timeout=timeout)
    if s != 200:
        raise RuntimeError(f"HTTP {s} {b}")
    return b


# ---------------------------------------------------------------- 契约

def test_contract():
    print("\n" + "=" * 60)
    print("契约（不调用大模型）")
    print("=" * 60)

    s, _, b = call("POST", "/api/ask", raw=b"{}", headers={"Content-Type": "text/plain"})
    check("问答：非 JSON 请求体返回 415", s == 415, f"status {s}")

    s, _, b = call("POST", "/api/ask", json_body={"question": "财位"}, headers={"Origin": "https://evil.example"})
    check("问答：别的站点来的 Origin 返回 403", s == 403, f"status {s}")

    s, _, b = call("POST", "/api/ask", json_body={})
    check("问答：没有问题返回 400 question_required", s == 400 and b.get("error") == "question_required", f"status {s} {b}")

    s, _, b = call("POST", "/api/ask", json_body={"question": "财"})
    check("问答：单个汉字返回 400 question_too_short", s == 400 and b.get("error") == "question_too_short", f"status {s} {b}")

    s, _, b = call("POST", "/api/ask", json_body={"question": "财" * 401})
    check("问答：超过 400 字返回 400 question_too_long", s == 400 and b.get("error") == "question_too_long", f"status {s} {b}")

    s, _, b = call("POST", "/api/vision", json_body={"image": ""})
    check("识图：没有图片返回 400 image_required", s == 400 and b.get("error") == "image_required", f"status {s} {b}")

    s, _, b = call("POST", "/api/vision", json_body={"image": "data:image/svg+xml;base64,PHN2Zz4="})
    check("识图：SVG 等非位图返回 400 bad_image", s == 400 and b.get("error") == "bad_image", f"status {s} {b}")

    for name, q in [("SQL 注入写法", "' OR 1=1 --"), ("脚本载荷", "<script>alert(1)</script>"), ("emoji", "😀💀🔥")]:
        s, _, b = call("GET", "/api/search?q=" + urllib.parse.quote(q) + "&topK=3")
        ok = s == 200 and isinstance(b, dict) and isinstance(b.get("citations"), list)
        check(f"检索：{name} 不报错", ok, f"status {s}")

    s, _, b = call("GET", "/api/search?q=" + urllib.parse.quote("财") + "&topK=-5")
    check("检索：topK 为负数时钳到下限，仍返回 200", s == 200, f"status {s}")

    s, _, b = call("GET", "/api/search?q=" + urllib.parse.quote("财") + "&topK=9999")
    check("检索：topK 超大时钳到上限 8", s == 200 and len(b.get("citations", [])) <= 8, f"status {s}")

    s, _, b = call("GET", "/api/search")
    check("检索：没有 q 返回 400", s == 400, f"status {s}")

    s, _, b = call("GET", "/api/chapter?no=1.5")
    check("章节：章号不是整数返回 400", s == 400, f"status {s}")

    s, _, b = call("GET", "/api/chapter?no=99999")
    check("章节：不存在的章号返回 404", s == 404 and b.get("error") == "chapter_not_found", f"status {s} {b}")

    s, _, b = call("GET", "/api/chapter?no=100001")
    check("章节：超出 100000 的章号返回 400 bad_param", s == 400 and b.get("error") == "bad_param", f"status {s} {b}")

    s, _, b = call("GET", "/api/toc")
    check("目录：200 且返回 chapters 数组", s == 200 and isinstance(b.get("chapters"), list), f"status {s}")

    s, _, b = call("GET", "/api/geo?q=toString")
    check("地理：原型链上的名字返回 404，不是 500", s == 404 and b.get("error") == "city_not_found", f"status {s} {b}")

    s, h, b = call("GET", "/api/models")
    check("模型清单：200，允许缓存十分钟", s == 200 and h.get("Cache-Control") == "public, max-age=600" and len(b.get("models", [])) > 0, f"status {s}")

    s, h, b = call("GET", "/")
    csp = h.get("Content-Security-Policy", "")
    script_src = next((d.strip() for d in csp.split(";") if d.strip().startswith("script-src")), "")
    check("页面：脚本只允许同源（script-src 'self'，没有 unsafe-inline）", s == 200 and script_src == "script-src 'self'", f"{script_src!r}")
    check("页面：每个响应都带 X-Request-Id", bool(h.get("X-Request-Id")), "no header")


# ---------------------------------------------------------------- 质量

def test_retrieval():
    print("\n" + "=" * 60)
    print("检索测试")
    print("=" * 60)
    cases = [
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
    hits = 0
    for q, kws in cases:
        try:
            s, _, d = retry(lambda: call("GET", "/api/search?q=" + urllib.parse.quote(q) + "&topK=6"))
            if s != 200:
                raise RuntimeError(f"HTTP {s}")
            cites = d.get("citations", [])
            hit = any(any(k in (c.get("excerpt", "") + c.get("title", "")) for k in kws) for c in cites)
            top = cites[0]["excerpt"][:40].replace("\n", " ") if cites else "—"
            print(f"{'✓' if hit else '✗'} {q:20s} {len(cites)}条  首条: {top}")
            hits += 1 if hit else 0
        except Exception as e:
            print(f"✗ {q:20s} ERROR {e}")
            FAILED.append(f"检索 {q}")
    print(f"\n检索命中: {hits}/{len(cases)}（只作指标，不计入失败）")


def test_ai():
    print("\n" + "=" * 60)
    print("AI 回答测试（忠实度）")
    print("=" * 60)
    cases = [
        "家里的财位在哪，怎么摆才能来财",
        "厨房怎么布置",
        "卧室床头怎么摆",
        "家里风水有什么禁忌",
        "今天风水要注意什么",
        "鱼缸放哪里好",
        "大门对厕所怎么办",
    ]
    times = []
    for q in cases:
        try:
            t0 = time.time()
            d = retry(lambda: ask({"question": q}))
            dt = (time.time() - t0) * 1000
            times.append(dt)
            qs = d.get("quotes", [])
            verified = sum(1 for x in qs if x.get("verified"))
            print(f"[{d.get('verdict')}] {q}")
            print(f"   结论: {d.get('conclusion', '')[:50]}")
            print(f"   建议 {len(d.get('points', []))} 条 | 引用 {len(qs)} 条（核对通过 {verified}） | {dt:.0f}ms")
            if any(not p.get("verified") for p in d.get("points", [])):
                print("   ⚠ 存在无引用建议")
        except Exception as e:
            print(f"✗ {q} ERROR {e}")
            FAILED.append(f"问答 {q}")
    if times:
        print(f"\n平均耗时: {statistics.mean(times):.0f}ms  最慢: {max(times):.0f}ms")


def test_models():
    print("\n" + "=" * 60)
    print("模型可用性")
    print("=" * 60)
    _, _, lite = call("GET", "/api/models")
    for m in lite.get("models", []):
        try:
            t0 = time.time()
            d = ask({"question": "厨房怎么布置", "model": m["id"]}, timeout=90)
            dt = (time.time() - t0) * 1000
            v = d.get("verdict")
            flag = "✓" if v in ("有依据", "部分依据") else ("△" if v == "无依据" else "✗")
            print(f"{flag} {m['label']:22s} {v:6s} {dt:6.0f}ms  used={d.get('model')}")
        except Exception as e:
            print(f"✗ {m['label']:22s} ERROR {str(e)[:60]}")
            FAILED.append(f"模型 {m['label']}")


def test_vision():
    print("\n" + "=" * 60)
    print("图片识别")
    print("=" * 60)
    for path in ["/tmp/floorplan.png", "/tmp/bedmirror.png"]:
        if not os.path.exists(path):
            continue
        b64 = base64.b64encode(open(path, "rb").read()).decode()
        try:
            t0 = time.time()
            s, _, d = call("POST", "/api/vision", json_body={"image": "data:image/png;base64," + b64, "hint": "户型图"}, timeout=120)
            dt = (time.time() - t0) * 1000
            if s != 200:
                raise RuntimeError(f"HTTP {s} {d}")
            print(f"{'✓' if d.get('ok') else '✗'} {os.path.basename(path):18s} {dt:6.0f}ms  {d.get('model', '')[:40]}")
            print("   ", (d.get("text") or "")[:100].replace("\n", " "))
        except Exception as e:
            print(f"✗ {os.path.basename(path)} ERROR {e}")
            FAILED.append(f"识图 {os.path.basename(path)}")


if __name__ == "__main__":
    if MODE in ("contract", "all"):
        test_contract()
    if MODE in ("quality", "all"):
        test_retrieval()
        test_ai()
        test_models()
        test_vision()

    print("\n" + "=" * 60)
    if FAILED:
        print(f"失败 {len(FAILED)} 项：" + "；".join(FAILED))
        sys.exit(1)
    print(f"全部通过（契约断言 {CHECKS} 项）" if CHECKS else "质量测试没有接口错误")
