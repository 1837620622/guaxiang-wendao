# 卦象问道 · 《改命记实录》风水问答

拿《改命记实录》（道之光，919 章，约 130 万字）做的一个风水问答站：
问家居、财位、方位、日子，答案从书里找原文，标到**第几章 · 第几段**，能点开核对；书里没写就说没有。

- **问答**：https://guaxiang-wendao.ck-nb.workers.dev
- **读原文**：https://guaxiang-wendao.ck-nb.workers.dev/read
- **PDF**：https://guaxiang-wendao.ck-nb.workers.dev/download/gaibian-jilu.pdf

---

## 怎么做的（很薄）

```
问题
 ├─ 抽关键词（实体词 + 场景同义词）
 ├─ D1 里对 chapters 表做 LIKE 扫描 + SQL 词频预排序  ← 919 行，1.3MB，<10ms
 ├─ 在命中章里挑最相关的段落（引用精确到"第N段"）
 ├─ 拼提示词（原文 + 图识别 + 地理 + 历史）
 └─ Workers AI 出 JSON：结论 / 建议[编号] / 原文摘句 / 书里没写的
      ↓
   后置校验：ref 必须在范围内、quote 必须能逐字命中、建议要有原文支撑
```

**没有倒排索引，没有向量库，没有切块表。** 全书就一张 `chapters` 表（919 行），
一次 LIKE 扫描解决问题——比之前 52 万行的 terms 表省 17MB 存储，代码也短一半。

---

## 目录

```
卦象问道/
├── data/                          # 数据（不进 git）
│   ├── 改命记实录_全本.txt         # 919 章 / 1,297,364 字
│   ├── chapters/                  # 单章 0001–0919
│   ├── audit.json                 # 完整性审计
│   └── quality.json               # 乱码/残缺诊断
├── tools/
│   ├── crawl.py                   # 抓取（按页抓全，#txt 容器）
│   ├── audit.py                   # 完整性
│   ├── quality.py                 # 质量诊断
│   └── make_pdf.py                # 合成 PDF（目录 + 页码）
├── output/改命记实录.pdf           # 3778 页 / 16MB
├── docs/                          # 参考资料
└── cf-agent/                      # Worker 工程
    ├── src/
    │   ├── index.ts               # 路由 + 校验 + 缓存 + 限流
    │   ├── retrieve.ts            # 关键词检索（唯一"检索"文件）
    │   ├── prompt.ts              # 提示词
    │   ├── vision.ts              # 图片识别
    │   ├── geo.ts                 # 城市 / 真太阳时 / 磁偏角
    │   ├── websearch.ts           # 联网兜底
    │   ├── models.ts              # 模型清单
    │   └── types.ts
    ├── public/
    │   ├── index.html             # 问答页
    │   ├── read.html              # 原文阅读器
    │   └── download/gaibian-jilu.pdf
    ├── scripts/build_chapters.py  # 生成 D1 导入 SQL
    ├── data/chapters.sql          # 3.6MB
    ├── tests/test_api.py          # 端到端测试
    └── import.sh
```

---

## 一、数据

| 项 | 数值 |
|---|---|
| 章节 | 919（第 1–919 章 + 3 个番外节点） |
| 总字数 | 1,297,364 |
| 单章 | 最短 999 / 中位 1,157 / 最长 11,071 |
| 乱码 / 截断 / 重复 / 空章 | 0 |

抓取踩过的坑：

1. 正文容器是 `<div id="txt">`，不是常见的 `chaptercontent`
2. 分页 `(1/N)…(N/N)` 必须逐页抓，漏第 2 页每章少 300–500 字
3. 网页图标字体的私有区字符 `U+E620/U+E604` 全库 9,578 个，会显示成乱码块
4. `NOISE` 会把正文「下一章讲。）」误删，要改成「整行等于导航词」才过滤

复检：`python3 tools/audit.py && python3 tools/quality.py`

---

## 二、问答

### 三级证据

| 级别 | 来源 | 标注 | 最高结论 |
|---|---|---|---|
| A | 书内原文 | `[1]` | 有依据 |
| B | 联网搜索（书里查不到时） | `[W1]` | 部分依据 |
| C | 都没有 | — | 无依据，明确说没有 |

### 检索参数

- 实体词表：约 100 个（财位/厨房/灶台/床头/镜子/横梁/文昌…）
- 场景同义词：`厨房|灶 → 灶,炉灶,灶台,厨房,水火冲`
- 章节分 = 最好那段 × 2 + 标题命中 + 关键词覆盖 + 命中段落数
- 每章最多取 2 段，每段带上下段保证语义完整

### 忠实度校验

1. `refs` 必须落在 1..N
2. `quote` 去掉标点后必须能在原文里逐字找到（支持省略号分段匹配）
3. 建议文本要有 ≥50% 的词出现在所引原文里，否则标灰
4. 一条可信引用都没有 → 强制降级「无依据」

### 图片

- 上传：📷 / 拖拽 / 粘贴，前端压到长边 1280、≤3.5MB
- 视觉模型：`@cf/meta/llama-3.2-11b-vision-instruct`（兜底 llava）
- 户型图模式：读房间、相对位置、门、灶/床/马桶、有无指北针
- 照片模式：读场景、物件、位置关系、明显格局
- **只描述图面事实，不给风水结论**；结论仍来自原文
- 同图 7 天缓存

### 地理

内置 100+ 城市坐标，算真太阳时（经度时差 + 均时差）和磁偏角近似值。
只用于判断方位和时辰，不据此编造地方风水。

### 会记上下文

最近 3 轮问答随请求带上，用于指代消解（"那卧室呢"）。带历史的请求不进缓存。

### 模型

16 个 Workers AI 模型，前端下拉框分组：

- **推荐**：Llama 3.3 70B（默认，最快）、Mistral Small 3.1、DeepSeek V4 Flash / V4.1 Flash
- **中文强**：Qwen 3.8 27B、Kimi K2.6、GLM-4.7 Flash、DeepSeek V4 Pro、GLM-5.3 Flash
- **快速**：Llama 4 Scout、GPT-OSS 20B、Nemotron 3 120B
- **推理型**：Qwen3 30B、GPT-OSS 120B、GLM-5.3、Gemma 4 26B（会先思考，慢）

推理型模型思考链也吃 token，预算不够会返回空内容；代码里检测 `finish=length`
后自动翻倍预算重试，而不是直接判失败。整体 65s 预算，超了直接返回原文让用户自己看。

### 缓存 / 限流

| 内容 | 时长 |
|---|---|
| 答案 | 24h（key = 模型 + topK + 城市 + 问题指纹） |
| 联网结果 | 1h |
| 章节原文 | 24h |
| 图片识别 | 7d |
| health | 5min |

限流（按 IP）：问答 12 次/分、60 次/天；搜索 30 次/分。

### API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/ask` | `{question, image?, location?, model?, topK?, history?}` |
| GET | `/api/search?q=&topK=` | 只检索 |
| POST | `/api/vision` | 单图识别 `{image, hint}` |
| GET | `/api/toc` | 目录（919 章） |
| GET | `/api/chapter?no=` | 单章 + 上下章 |
| GET | `/api/geo?q=西安` | 城市地理 |
| GET | `/api/models` | 模型清单 |
| POST | `/api/feedback` | `{question, verdict, vote}` |
| GET | `/api/stats` | 反馈统计 |
| GET | `/api/health` | 库状态 |

---

## 三、前端

**问答页** `/`
- 引用 chip 点击 → 展开对应原文并高亮
- 「原文」链接 → 跳到阅读器对应章节+段落
- 「延伸阅读」→ 本章其他相关章节
- 结论打字机、建议逐条淡入、👍👎 反馈、一键复制
- 语音输入（Web Speech API，不支持的浏览器自动隐藏）

**阅读器** `/read`
- 919 章目录 + 搜索
- 字号 16–24px、深色模式、进度条、键盘 ← →
- `?ch=464&p=12` 直达并高亮第 12 段

---

## 四、部署 / 更新

```bash
cd cf-agent
npm install
wrangler login

# 首次
wrangler d1 create guaxiang          # 把 id 填进 wrangler.toml
wrangler kv namespace create CACHE   # 把 id 填进 wrangler.toml
python3 scripts/build_chapters.py
./import.sh

# 发布
wrangler deploy
```

改了原文数据后：`python3 scripts/build_chapters.py && ./import.sh && wrangler deploy`

---

## 五、实测（2026-10-23）

| 项 | 结果 |
|---|---|
| 检索命中 | 19/20 |
| AI 回答 | 引用逐字核对全部通过 |
| 单次响应 | 缓存 ~1s / 未缓存 3–10s |
| 图片识别 | 4–7s |
| 图 + 文全链路 | 9.5s |
| SQL 注入 / XSS / 异常编码 | 安全 |
| D1 存储 | chapters 919 行 ≈ 3.8MB（原先倒排方案 22MB） |

---

## 六、说明

- 内容来自公开网络连载，仅用于文化研读与民俗资料整理，不构成任何决策建议。
- 书里没有的会明确回答「没有」，不编。
