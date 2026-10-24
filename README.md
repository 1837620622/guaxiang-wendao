# 卦象问道 · 《改命记实录》风水智能体

把《改命记实录》（道之光，919 章，约 130 万字）抓全、洗净，做成一个风水问答站：
问家居、财位、方位、日子，答案从书里找原文，标到**第几章 · 第几段**，能点开核对；
书里没写就明说没有，不编。

- **问答**：https://chuankangkk.top
- **读原文**：https://chuankangkk.top/read
- **PDF**：https://chuankangkk.top/download/gaibian-jilu.pdf
- 备用（workers.dev）：https://guaxiang-wendao.ck-nb.workers.dev

---

## 目录

```
卦象问道/
├── README.md
├── data/
│   ├── 改命记实录_全本.txt         # 919 章 / 1,297,364 字
│   ├── chapters/                   # 单章 0001–0919
│   ├── audit.json                  # 完整性审计
│   └── quality.json                # 乱码/残缺诊断
├── tools/
│   ├── crawl.py                    # 抓取
│   ├── audit.py                    # 完整性
│   ├── quality.py                  # 质量诊断
│   └── make_pdf.py                 # 合成 PDF
├── output/改命记实录.pdf            # 3778 页 / 16MB
├── docs/                           # 参考资料
└── cf-agent/                       # Worker 工程（见该目录 README）
```

---

## 一、数据

| 项 | 数值 |
|---|---|
| 章节 | 919 |
| 总字数 | 1,297,364 |
| 单章 | 最短 999 / 中位 1,157 / 最长 11,071 |
| 乱码 / 截断 / 重复 / 空章 | 0 |

修过的坑：容器是 `<div id="txt">` 不是 `chaptercontent`；分页 `(1/N)…(N/N)` 漏抓第 2 页
每章少 300–500 字；网页图标私有区字符 `U+E620/U+E604` 共 9,578 个会显示成乱码；
`NOISE` 规则把正文「下一章讲。）」误删。

```bash
python3 tools/crawl.py      # 重抓
python3 tools/audit.py      # 完整性
python3 tools/quality.py    # 乱码/残缺
python3 tools/make_pdf.py   # 生成 PDF
```

---

## 二、站

见 `cf-agent/README.md`。一句话概括实现：

> 全书 919 章就一张 `chapters` 表（3.8MB），检索直接 LIKE 扫描 + SQL 词频预排序，
> 不建倒排索引、不建向量库，代码短一半，省 17MB 存储。

能力：
- 原文检索 → 答案带「第几章 · 第几段」，点开核对
- 图片识别（户型图 / 房间照片）
- 地理位置（真太阳时、磁偏角）
- 多轮上下文
- 联网兜底（书里没有时）
- 13 个模型可切换（Groq / 通义 / 智谱 / Workers AI）
- 原文阅读器 + PDF

---

## 三、部署

```bash
cd cf-agent
npm install && wrangler login
wrangler d1 create guaxiang          # id 填进 wrangler.toml
wrangler kv namespace create CACHE   # id 填进 wrangler.toml
python3 scripts/build_chapters.py
./import.sh
wrangler deploy
```

---

## 四、说明

- 内容来自公开网络连载，仅用于文化研读与民俗资料整理，不构成任何决策建议。
- 书里没有的会明确回答「没有」。
