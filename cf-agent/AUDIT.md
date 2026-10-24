# cf-agent 安全与逻辑审计（reviewer 子代理产出，2026-10-23）

审计范围：`src/index.ts`、`src/retrieve.ts`、`src/tokenize.ts`、`src/prompt.ts`、`src/types.ts`、`src/models.ts`、`public/index.html`

## 高

| 级别 | 位置 | 问题 | 状态 |
|---|---|---|---|
| 高 | index.ts CORS/RateLimit | 无限流、无鉴权、CORS 全开，公网裸露付费 Workers AI | 已修：限流按 IP（前序提交）；本次加同源 JSON 守卫，不回应预检，跨站表单发不出 |
| 高 | index.ts 缓存 key | KV key 不含模型，切模型命中旧答案，可缓存投毒 | 已修：key 含模型与 topK（v30） |
| 高 | prompt.ts / index.ts | 提示词注入 + conclusion/points/missing 零校验 | 部分缓解：自由文本限长并去协议；资料用 <资料> 标签包住；书中条目需 6 字锚点。模型输出的语义内容仍无校验 |
| 高 | index.ts verifyQuote | 首尾 12 字匹配，中间可编造仍判 verified | 已修：只认整段逐字，或按省略号分段按序命中（verify.ts，有单测） |

## 中（摘要）
- point.verified = refs.length > 0，语义错位
- 索引只建 ≥2 字词，查询侧给单字 0.5 权重 → 单字问题 0 命中
- exactPhrases 的 filter 恒真，27 个领域短语无条件参与打分
- 长度归一化压不住长 chunk 词频堆叠
- D1 异常被静默吞掉，无法区分"检索差"与"数据库故障"
- 客户端可指定任意模型 id；内部错误原样回传
- /api/search 无长度限制、excerpt 420 字，可批量重建全书
- /api/health 每次 COUNT(*) 全表扫
- KV key 上限 512 字节，超长问题永不命中
- 前端固定 footer 遮挡最后一条消息
- 请求无超时/无取消
- 无障碍：.ref 是 span、禁止缩放、无 aria-live、对比度不足

## 低（摘要）
- extractJSON 可能解析到模板
- extractText 兜底取 reasoning_content
- quote ref 越界渲染为 "第 ? 章"
- 列表章节扩写超 topK
- 每批 LIMIT 150 跨批截断
- topK 类型校验宽松
- raw 字段泄露思维链
- 无 CSP / nosniff / Referrer-Policy
- 超大 body 直接进内存
- 移动端隐藏"清空"
- package.json db:init 指向不存在文件
- README 与实现漂移
- data/ 与 scripts/data/ 双份
- 测试无断言

## 已核实无问题
- SQL 注入：全部绑定参数
- DOM XSS：esc() 覆盖，模型列表用 textContent
- full 原文不外泄（sanitizeCitations）
- 前端事件监听随节点回收

## 修复记录（2026-10-24）

已修（有单测，或已在本地 wrangler dev 上端到端验证）：

- 联网搜索用 9 秒整体上限一刀切：慢源会让已经到手的结果一起丢掉 → 每源各自 8 秒限时（`websearch.ts`）
- 模型兜底：每个模型各给一次 65 秒，最坏要等好几分钟 → 整次问答共用一个截止时间，key 轮换也受它约束（`index.ts`、`llm.ts`）
- 书中条目校验过松：与原文共享四个字就标「已核对」→ 需共享 6 个连续汉字，标点不计（`verify.ts`）
- `/api/geo?q=toString` 返回 500：普通对象查表拿到了原型链上的函数 → 只认自有属性（`geo.ts`）
- `/api/chapter?no=&ord=5` 查成了 ord=0 → 参数按非空值取，章号必须是正整数，缓存键规范化
- 失败响应回传模型原始输出（可能含思维链）→ 只写日志，不回传
- 静态页面没有安全头，而且 Workers 默认直接返回静态文件、不进 Worker → `run_worker_first = true`，并补 CSP 等头
- 写接口缺少来源与类型校验 → 只接受同源 `application/json`
- 搜狗结果未校验链接协议 → 只保留 http(s)
- 提示词写的是「<资料>」，实际输出的是「【资料】」→ 统一为 `<资料>` 标签
- 首页与应用区样式、字体统一为单色体系，罗盘按需打开，八卦字转停后保持正立
- CSP 允许内联脚本：页面脚本外置为同源文件 `app.js`、`read.js`，`script-src` 只放行 `'self'`；`read.html` 的内联 `onclick` 改为脚本绑定，`make_master.py` 改为把头像写进 `app.js`。
- 限流的 KV 读改写会被并发绕过：每分钟改用 Workers Rate Limiting 绑定（`RL_ASK` / `RL_SEARCH` / `RL_FEEDBACK`），每天的总量仍用 KV。本地 `wrangler dev` 验证：同一 IP 第 13 次问答返回 429 并带 `Retry-After: 60`。
- `tests/test_api.py` 只打印、没有断言：新增契约组（21 条断言，失败退出码为 1，可对本地 `wrangler dev` 跑）；质量组只把接口报错计为失败。

仍未处理（需要数据、部署环境，或更大的改动）：

- 每天的限额仍是 KV 计数，最终一致，突发时会多放过少量请求。限流绑定按数据中心分别计数，跨地区的总量只是近似；要全局精确就需要 Durable Object。
- 检索的 `LIMIT 40` 预排序仍按出现次数，长章有优势。`data/` 不在版本库里，没有 919 章原文，无法验证调整后的效果，所以没动。
- 模型输出的 conclusion、daily 没有语义校验，只有书中条目和引文会被核对。
- 样式仍允许 `'unsafe-inline'`：页面有内联 style 属性，逐个改的收益小。
- 质量组（检索命中、AI 忠实度、模型可用性）依赖线上数据和模型密钥，只能对部署地址跑；命中率没有阈值，只作指标。
- 限流绑定写在 wrangler 3 的 `unsafe` 配置段里，wrangler 标注为实验性；升级 wrangler 时要留意这一段的写法变化。

