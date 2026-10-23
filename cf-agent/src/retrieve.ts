import type { Env, Citation, SearchHit } from "./types";

/**
 * 轻量检索：直接在 chapters 表上做关键词匹配
 *
 * 为什么不用倒排索引：
 *  - 全书 919 章、1.3MB，全表 LIKE 扫描 < 10ms
 *  - 少一张 52 万行的 terms 表，省 17MB 存储，代码也更短
 *
 * 排序逻辑：按「本章最好那一段」打分，而不是整章词频，
 * 否则"厨房"这种词会在闲聊章节里出现几十次，压过真正讲灶台的那一章。
 */

/** 疑问词/泛用词 */
const STOP = new Set(
  `怎么 么办 怎么办 怎样 如何 什么 哪里 哪些 哪个 为什么 可以 应该 需要
   注意 是不 不是 有没 没有 一下 这个 那个 我们 你们 他们 自己 时候 现在
   请问 告诉 如果 但是 而且 然后 所以 因为 就是 还是 或者 以及 今天 今日
   今年 最近 目前 适合 做点 一点 一个 一些 这样 那样 知道 觉得`
    .split(/\s+/)
    .filter(Boolean)
);

/** 领域实体词（问题里出现才算） */
const ENTITY = [
  "财位", "招财", "聚财", "破财", "漏财", "财运", "财气", "发财", "求财",
  "厨房", "灶台", "炉灶", "卧室", "床头", "床位", "大门", "门口", "玄关",
  "卫生间", "厕所", "马桶", "客厅", "厅堂", "阳台", "书房", "院子", "院内", "中宫",
  "镜子", "横梁", "鱼缸", "挂钟", "画像", "照片", "神像", "菩萨", "佛像", "财神",
  "貔貅", "水晶", "绿植", "植物", "楼梯", "罗盘", "五帝钱", "葫芦",
  "风水", "方位", "布局", "摆放", "煞气", "化煞", "文昌位", "吉日", "择日",
  "太岁", "九宫", "飞星", "八卦", "五行", "阴阳", "八字", "命宫", "太极",
  "婚姻", "姻缘", "离婚", "孩子", "学习", "考试", "事业", "升职", "健康",
  "装修", "搬家", "买房", "禁忌", "忌讳", "常见问题",
];

/** 场景同义词：问法 ≠ 书里的说法时做扩展 */
const SYNONYM: [RegExp, string[]][] = [
  [/厨房|灶/, ["灶", "炉灶", "灶台", "厨房", "水火冲"]],
  [/卧室|睡房|床/, ["床", "床头", "卧室", "卧房", "睡觉"]],
  [/卫生|厕/, ["厕所", "卫生间", "马桶", "污秽"]],
  [/大门|门口|入户|玄关/, ["大门", "门口", "门向"]],
  [/客厅|厅堂/, ["客厅", "厅堂", "明堂", "沙发"]],
  [/财|钱|富/, ["财", "招财", "聚财", "财运", "财气", "破财", "漏财", "财库"]],
  [/镜子|反光/, ["镜子", "反光", "镜"]],
  [/横梁|压顶/, ["横梁", "压顶", "横梁煞"]],
  [/文昌|考试|学习/, ["文昌", "文昌位", "考运"]],
  [/择日|吉日|日子/, ["择日", "吉日", "日子", "黄历"]],
  [/方位|朝向|坐向/, ["方位", "朝向", "坐向", "九宫", "宫位"]],
  [/煞/, ["煞", "煞气", "化煞", "形煞"]],
  [/禁忌|忌讳|注意什么|有啥讲究/, ["禁忌", "不宜", "不可", "主凶", "大凶", "破财"]],
  [/装修|搬家|买房/, ["装修", "搬家", "买房", "选房"]],
];

/** 从问题抽检索词 */
export function extractKeywords(question: string): string[] {
  const out: string[] = [];

  // 1) 命中的实体词
  for (const w of ENTITY) if (question.includes(w)) out.push(w);

  // 2) 场景同义词扩展
  for (const [re, words] of SYNONYM) {
    if (re.test(question)) out.push(...words);
  }

  // 3) 问题里的 2 字以上中文片段（兜底）
  for (const seg of question.match(/[\u4e00-\u9fff]{2,}/g) || []) {
    if (seg.length <= 4 && !STOP.has(seg)) out.push(seg);
    else {
      for (let i = 0; i + 2 <= seg.length; i++) {
        const g = seg.slice(i, i + 2);
        if (!STOP.has(g)) out.push(g);
      }
    }
  }

  // 长词优先，去重
  const uniq = [...new Set(out)];
  uniq.sort((a, b) => b.length - a.length);
  return uniq.slice(0, 16);
}

interface ChapterRow {
  ord: number;
  no: number;
  title: string;
  body: string;
}

const paragraphs = (body: string) =>
  body.split("\n").map((s) => s.trim()).filter(Boolean);

function countOcc(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) {
    n++;
    i += needle.length;
  }
  return n;
}

export async function retrieve(env: Env, question: string, topK = 6): Promise<SearchHit[]> {
  const kws = extractKeywords(question);
  if (kws.length === 0) return [];

  // === 第一阶段：SQL 里做词频预排序（避免 LIMIT 截断把真正相关的章漏掉）===
  const whereSql = kws.map(() => "body LIKE ?").join(" OR ");
  const whereParams = kws.map((k) => `%${k}%`);

  // 用 LENGTH 差值算每章各词出现次数，加权求和后排序
  const scoreExpr = kws
    .map((k, i) => `(LENGTH(body) - LENGTH(REPLACE(body, ?, ''))) * ${(1 / Math.max(k.length, 1)).toFixed(3)} * ${(1 + i * 0.05).toFixed(2)}`)
    .join(" + ");
  const scoreParams = kws;

  let rows: ChapterRow[] = [];
  try {
    const { results } = await env.DB.prepare(
      `SELECT ord, no, title, body, (${scoreExpr}) AS pre
       FROM chapters
       WHERE ${whereSql}
       ORDER BY pre DESC
       LIMIT 40`
    )
      .bind(...scoreParams, ...whereParams)
      .all<ChapterRow>();
    rows = results ?? [];
  } catch (e) {
    console.error("chapter query failed", e);
    throw new Error("retrieval_unavailable");
  }
  if (rows.length === 0) return [];

  // === 段落打分 → 章节分取段落最高分 ===
  type Ranked = {
    row: ChapterRow;
    paras: string[];
    bestIdx: number;
    bestScore: number;
    titleHit: number;
    cover: number;
    hitParas: number;
  };

  const ranked: Ranked[] = rows.map((r) => {
    const paras = paragraphs(r.body);
    let bestIdx = 0, bestScore = 0;

    for (let i = 0; i < paras.length; i++) {
      const p = paras[i];
      let s = 0;
      for (const k of kws) {
        const n = countOcc(p, k);
        if (n > 0) {
          s += 1 + Math.min(n, 4) * 0.5;
          if (k.length >= 2 && ENTITY.includes(k)) s += 0.6;
        }
      }
      if (s > bestScore) {
        bestScore = s;
        bestIdx = i;
      }
    }

    let titleHit = 0;
    for (const k of kws) if (r.title.includes(k)) titleHit += 6;

    const cover = kws.filter((k) => r.body.includes(k)).length;

    // 命中段落数：清单型章节（一条条列禁忌）应该被抬起来
    let hitParas = 0;
    for (const p of paras) {
      for (const k of kws) {
        if (p.includes(k)) { hitParas++; break; }
      }
    }

    return { row: r, paras, bestIdx, bestScore, titleHit, cover, hitParas };
  });

  const total = (x: (typeof ranked)[number]) =>
    x.bestScore * 2 + x.titleHit + x.cover * 1.5 + Math.min(x.hitParas, 25) * 0.9;

  ranked.sort((a, b) => total(b) - total(a));

  // === 取前几章里最好的段落（含下一段，保持语义完整）===
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  const perChapter = new Map<number, number>();

  for (const r of ranked) {
    if (hits.length >= topK * 2) break;
    if ((perChapter.get(r.row.no) ?? 0) >= 2) continue;

    // 本章按段落分排序，取前 2
    const order = r.paras
      .map((text, idx) => {
        let s = 0;
        for (const k of kws) {
          const n = countOcc(text, k);
          if (n > 0) s += 1 + Math.min(n, 4) * 0.5;
        }
        return { idx, text, s };
      })
      .filter((p) => p.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 2);

    for (const p of order) {
      if (hits.length >= topK * 2) break;
      const key = `${r.row.no}:${p.idx}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const nextPara = r.paras[p.idx + 1];
      const join = nextPara && nextPara.length < 100;
      const text = join ? `${p.text}\n${nextPara}` : p.text;
      if (text.length < 10) continue;

      hits.push({
        id: r.row.no * 1000 + p.idx,
        ord: r.row.ord,
        ch: r.row.no,
        title: r.row.title,
        p0: p.idx + 1,
        p1: join ? p.idx + 2 : p.idx + 1,
        text,
        score: r.bestScore * 2 + p.s,
      });
      perChapter.set(r.row.no, (perChapter.get(r.row.no) ?? 0) + 1);
    }
  }

  return hits.slice(0, topK * 2);
}

export function toCitations(hits: SearchHit[]): Citation[] {
  return hits.map((h, i) => ({
    n: i + 1,
    ch: h.ch,
    title: h.title,
    p0: h.p0,
    p1: h.p1,
    excerpt: h.text.length > 300 ? h.text.slice(0, 300) + "…" : h.text,
    full: h.text,
  }));
}
