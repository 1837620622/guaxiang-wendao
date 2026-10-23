# cf-agent 安全与逻辑审计（reviewer 子代理产出，2026-10-23）

审计范围：`src/index.ts`、`src/retrieve.ts`、`src/tokenize.ts`、`src/prompt.ts`、`src/types.ts`、`src/models.ts`、`public/index.html`

## 高

| 级别 | 位置 | 问题 | 状态 |
|---|---|---|---|
| 高 | index.ts CORS/RateLimit | 无限流、无鉴权、CORS 全开，公网裸露付费 Workers AI | 待修 |
| 高 | index.ts 缓存 key | KV key 不含模型，切模型命中旧答案，可缓存投毒 | 待修 |
| 高 | prompt.ts / index.ts | 提示词注入 + conclusion/points/missing 零校验 | 待修 |
| 高 | index.ts verifyQuote | 首尾 12 字匹配，中间可编造仍判 verified | 待修 |

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
