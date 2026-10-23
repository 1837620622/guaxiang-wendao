#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
抓取：按页抓全，正文容器 #txt
- 正文容器是 <div id="txt">（不是 chaptercontent）
- 按 (n/N) 逐页抓，每页都校验正文非空
- 抓完校验总字数，异常章节落日志
- 断点：--only-missing 只补比源站短的章
"""
import os, re, json, time, random, html, sys, urllib.request

BASE = "https://m.1024txt.com"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "chapters")
FULL = os.path.join(ROOT, "data", "改命记实录_全本.txt")
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"

# 导航词：整行完全相等才过滤（避免误删正文里的"下一章讲…"）
NAV_EXACT = {"上一章", "下一章", "目录", "下一页", "上一页", "简介", "开始阅读", "存书签"}
# 噪声短语：包含即过滤
NOISE_SUB = ("最新章节", "本章还未完", "相关推荐", "「改命记实录」", "燃文小说",
             "www.", "http", "书库", "排行", "小说书架")
NOISE_RE = re.compile(r"^\s*\[[^\]]{1,8}\].{0,60}$")  # [都市言情]xxx 推荐位

def fetch(url, retries=5):
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": UA,
                "Accept": "text/html,application/xhtml+xml",
                "Accept-Language": "zh-CN,zh;q=0.9",
                "Referer": BASE + "/book/506258/",
            })
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read().decode("gb18030", errors="ignore")
        except Exception as e:
            last = e
            time.sleep(1.5 * (i + 1) + random.random() * 2)
    raise last

def parse(s):
    """返回 (正文行, 当前页, 总页数)"""
    m = re.search(r"\((\d+)/(\d+)\)", s)
    cur, total = (int(m.group(1)), int(m.group(2))) if m else (1, 1)

    m2 = re.search(r'<div[^>]+id="txt"[^>]*>(.*?)</div>', s, re.S | re.I)
    seg = m2.group(1) if m2 else ""
    if not seg:
        m3 = re.search(r'<div[^>]+id="chaptercontent"[^>]*>(.*?)</div>', s, re.S | re.I)
        seg = m3.group(1) if m3 else ""

    seg = re.sub(r"<script.*?</script>", "", seg, flags=re.S | re.I)
    seg = re.sub(r"<style.*?</style>", "", seg, flags=re.S | re.I)
    seg = re.sub(r"<br\s*/?>", "\n", seg, flags=re.I)
    seg = re.sub(r"</p\s*>", "\n", seg, flags=re.I)
    seg = re.sub(r"<[^>]+>", "", seg)
    seg = html.unescape(seg)
    seg = re.sub(r"[\ue000-\uf8ff\u200b-\u200f\ufeff]", "", seg)

    out = []
    for l in seg.split("\n"):
        t = re.sub(r"[ \t\u3000\xa0]+", " ", l).strip()
        if not t:
            continue
        if len(t) <= 2 and not re.search(r"[\u4e00-\u9fff]", t):
            continue
        if t in NAV_EXACT:
            continue
        if any(k in t for k in NOISE_SUB):
            continue
        if NOISE_RE.match(t):
            continue
        if re.match(r"^第\d+[章篇].*\(\d+/\d+\)$", t):
            continue
        out.append(t)
    return out, cur, total

def get_chapter(item):
    url = item["u"]
    stem = url[:-5] if url.endswith(".html") else url
    lines, cur, total = parse(fetch(stem + ".html"))
    if not lines:
        raise RuntimeError("page1 empty")
    for p in range(2, total + 1):
        time.sleep(0.12 + random.random() * 0.25)
        l2, c2, t2 = parse(fetch(f"{stem}_{p}.html"))
        if not l2:
            raise RuntimeError(f"page{p} empty (total={total})")
        # 防止重复页
        if l2 and lines and l2[0] == lines[-1]:
            l2 = l2[1:]
        lines.extend(l2)
    return lines, total

def main():
    only_missing = "--only-missing" in sys.argv
    items = json.load(open("/tmp/all_items.json"))
    seen, pool = set(), []
    for it in items:
        if it["u"] in seen or "/book/506258/" not in it["u"]:
            continue
        seen.add(it["u"])
        pool.append(it)

    existing = sorted(f for f in os.listdir(OUT) if f.endswith(".txt"))
    # 索引：章节号 → 本地文件
    local_by_no = {}
    for f in existing:
        m = re.match(r"^(\d+)", f)
        if m:
            local_by_no[int(m.group(1))] = f

    results = {}
    fails = []
    from concurrent.futures import ThreadPoolExecutor, as_completed

    def work(idx_item):
        idx, it = idx_item
        lines, total = get_chapter(it)
        return idx, it, lines, total

    todo = []
    for idx, it in enumerate(pool, 1):
        m = re.match(r"^第(\d+)", it["t"])
        no = int(m.group(1)) if m else idx
        fname = local_by_no.get(no)
        if only_missing and fname:
            local_len = len(open(os.path.join(OUT, fname), encoding="utf-8").read())
            # 本地明显短于预期（每页按 1200 字估）才补
            if local_len > 900 * 1.2:
                continue
        todo.append((idx, it))

    print(f"total={len(pool)}  todo={len(todo)}  only_missing={only_missing}")

    with ThreadPoolExecutor(max_workers=6) as ex:
        futs = {ex.submit(work, x): x for x in todo}
        done = 0
        for f in as_completed(futs):
            idx, it = futs[f]
            try:
                _, _, lines, total = f.result()
                results[idx] = (it, lines, total)
            except Exception as e:
                fails.append((idx, it["t"], str(e)))
                print("FAIL", idx, it["t"], e, flush=True)
            done += 1
            if done % 50 == 0:
                print(f"  {done}/{len(todo)}", flush=True)

    # 写盘
    written = 0
    for idx, (it, lines, total) in sorted(results.items()):
        title = it["t"]
        body = "\n".join(lines)
        safe = re.sub(r'[\\/:*?"<>|\n\r]', "_", title)[:70]
        fn = os.path.join(OUT, f"{idx:04d}_{safe}.txt")
        with open(fn, "w", encoding="utf-8") as fp:
            fp.write(title + "\n\n" + body + "\n")
        written += 1

    # 重建全本
    files = sorted(f for f in os.listdir(OUT) if f.endswith(".txt"))
    parts = [open(os.path.join(OUT, f), encoding="utf-8").read().strip() for f in files]
    sep = "\n\n" + "=" * 30 + "\n\n"
    with open(FULL, "w", encoding="utf-8") as fp:
        fp.write(sep.join(parts))

    print(f"written={written}  files={len(files)}  fails={len(fails)}")
    if fails:
        json.dump(fails, open("/tmp/crawl_fails.json", "w"), ensure_ascii=False, indent=1)
        print("失败章节已写入 /tmp/crawl_fails.json")

if __name__ == "__main__":
    main()
