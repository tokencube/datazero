#!/usr/bin/env npx tsx
/**
 * MRO 数据飞轮 P0-P3 完成报告
 * Usage: npx tsx src/scripts/send_flywheel_p0_p3_report.ts
 */
import { renderEmailHtml } from "../../src/lib/zui_email";
import { loadEnv } from "../../src/scripts/lib/load_env";

const env = loadEnv();
for (const [k, v] of Object.entries(env)) {
  if (!process.env[k]) process.env[k] = v;
}

const SUBJECT = "[MRO 数据飞轮] P0-P3 全部完成 + pushed to GitHub · 2026-05-24";

const BODY_MD = `詹君，

MRO 数据飞轮 P0-P3 全部完成并已 push 到 GitHub。

## 已完成

| 阶段 | 内容 | 文件 | 状态 |
|------|------|------|------|
| P0 | 幽灵文件 | training_uncertainty.ts + tddq_loop.ts | pushed |
| P1 | 自我对弈 | selfplay_store.ts + mro_selfplay_daemon.ts + API endpoints | pushed |
| P2 | 自动重训触发 | flywheel_retrain_trigger.ts + quality gate 第6维 | pushed |
| P3 | 仪表盘 + 竞品对标 | datazero_studio.ts Flywheel tab + competitor_benchmark.ts | pushed |

## Push 状态

- tokencube/mro: f5edc7c (selfplay_store + daemon + quality gate)
- tokencube/zero: 6166ab0a2 (8 files, +1047 lines)

## 架构

TWO-agent 自我对弈:
- Generator: 6 种对抗策略 (token_drop, alias_substitution, spelling_error, abbreviation, description_style, cross_language)
- Retriever: hybrid FTS5+FAISS+RRF
- Judge: recall@K 评分 → 失败 case → selfplay_store KV → active_learning_queue

数据飞轮闭环:
selfplay failures → active learning → retrain trigger → JARVIS QLoRA → deploy → recall 提升

## 竞品对标 (competitor_benchmark.ts)

| 维度 | MRO | 最佳竞品 |
|------|-----|---------|
| SKU | 1.99M | 100M (1688) |
| AI 搜索 | hybrid RRF | JD/Grainger/Amazon |
| 跨语言 | CN/EN/DE | MRO = 1 of 2 |
| 交付 | 2.5天 | 1.0天 (Grainger) |

## 质量门 6 维度

1. Availability (reply rate >80%)
2. Latency (p95 <15s)
3. Accuracy (relevance >0.30)
4. Coverage (queries with results >50%)
5. Escalation (<20%)
6. Self-play recall@10 (>40%) — 新增

## 对标 Fultek + L6

fultek.pdf 和 mroL6.pdf 位于 mro/data/，已在之前的对标报告中分析。
Fultek 的核心优势：批量询价(200行Excel)、chip卡参数追问、5级级联放宽搜索、DIN/ISO/GB 标准等效。
这些已纳入后续规划。

tsc --noEmit 两个仓库都通过，零错误。

Claude Code (Opus 4.7)`;

async function main() {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) throw new Error("RESEND_API_KEY not set");

  const html = renderEmailHtml({
    text_md: BODY_MD,
    subject: SUBJECT,
    footer_kind: "design-memo",
    preheader: "MRO 数据飞轮 P0-P3 全部完成，TWO-agent 自我对弈 + 竞品对标 + 质量门第6维",
  });

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "Zero <zero@zmail.bot>",
      to: ["zhanjun@gmail.com"],
      cc: ["zero@zmail.bot"],
      subject: SUBJECT,
      html,
    }),
  });

  const data = await resp.json();
  console.log("Resend response:", JSON.stringify(data, null, 2));
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
