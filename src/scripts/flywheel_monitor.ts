#!/usr/bin/env npx tsx
// flywheel_monitor.ts — Daily flywheel health report skill.
//
// Queries flywheel dashboard endpoint, composes a structured health report,
// and emails it to the owner via zui_email + Resend.
//
// Usage:
//   npx tsx src/scripts/flywheel_monitor.ts
//   npx tsx src/scripts/flywheel_monitor.ts --email    (send email to owner)
//
// Environment:
//   ZERO_WORKER_URL   — Zero Worker base URL
//   ZERO_API_KEY      — zb_ API key (owner-scoped)
//   RESEND_API_KEY    — Resend API key for email sending
//   ADMIN_EMAIL       — owner email address

import { renderEmailHtml } from "../../src/lib/zui_email";
import { loadEnv } from "../../src/scripts/lib/load_env";

const env = loadEnv();
for (const [k, v] of Object.entries(env)) {
  if (!process.env[k]) process.env[k] = v;
}

const WORKER = (process.env.ZERO_WORKER_URL ?? "https://zmail.bot").replace(/\/+$/, "");
const API_KEY = process.env.ZERO_API_KEY ?? "";
const RESEND_KEY = process.env.RESEND_API_KEY ?? "";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "zhanjun@gmail.com";

interface DashboardData {
  fleet_count: number;
  fleet_online: number;
  active_training_runs: number;
  pending_edges: number;
  last_ota?: { deploy_id: string; model_version: string; completed_at: number };
  recent_strands: Array<{ id: number; ts: number; event_kind: string; summary: string }>;
}

interface EdgeStats { total_pending: number; by_robot: Record<string, number>; avg_uncertainty: number }
interface TrainStats { active_runs: number; completed_today: number; failed_today: number }

async function fetchDashboard(): Promise<DashboardData> {
  const r = await fetch(`${WORKER}/api/v1/flywheel/dashboard`, {
    headers: API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {},
  });
  if (!r.ok) throw new Error(`Dashboard fetch failed: ${r.status}`);
  const json = await r.json() as { ok: boolean; data: DashboardData };
  return json.data;
}

function classifyHealth(d: DashboardData): { status: "healthy" | "warning" | "critical"; messages: string[] } {
  const msgs: string[] = [];

  if (d.fleet_online === 0) msgs.push("No robots online");
  else if (d.fleet_online < d.fleet_count * 0.5) msgs.push(`Only ${d.fleet_online}/${d.fleet_count} robots online`);
  if (d.pending_edges > 100) msgs.push(`${d.pending_edges} pending edge cases require review`);
  if (d.active_training_runs === 0 && d.pending_edges > 20) msgs.push("Edge cases accumulating but no training active");

  const status = msgs.length === 0 ? "healthy" : msgs.length < 3 ? "warning" : "critical";
  return { status, messages: msgs };
}

function buildReportBody(d: DashboardData, health: ReturnType<typeof classifyHealth>): string {
  const statusEmoji = health.status === "healthy" ? "🟢" : health.status === "warning" ? "🟡" : "🔴";
  const lines = [
    `## 数据飞轮日报 ${statusEmoji}`,
    "",
    `| 指标 | 值 |`,
    `|------|-----|`,
    `| 车队在线 | ${d.fleet_online}/${d.fleet_count} |`,
    `| 活跃训练 | ${d.active_training_runs} |`,
    `| 待标注边缘案例 | ${d.pending_edges} |`,
    `| 最近OTA | ${d.last_ota ? `${d.last_ota.model_version} (${new Date(d.last_ota.completed_at).toISOString()})` : "无"} |`,
    "",
  ];

  if (health.messages.length > 0) {
    lines.push("### 需要注意");
    for (const msg of health.messages) {
      lines.push(`- ${msg}`);
    }
    lines.push("");
  }

  if (d.recent_strands.length > 0) {
    lines.push("### 最近事件");
    for (const s of d.recent_strands.slice(0, 10)) {
      const time = new Date(s.ts).toISOString().slice(11, 19);
      lines.push(`- \`${time}\` ${s.event_kind}: ${s.summary.slice(0, 80)}`);
    }
    lines.push("");
  }

  lines.push("---", "Zero 敬上");
  return lines.join("\n");
}

async function sendEmail(subject: string, bodyMd: string): Promise<string> {
  if (!RESEND_KEY) throw new Error("RESEND_API_KEY not configured");

  const html = renderEmailHtml({
    text_md: bodyMd,
    subject,
    footer_kind: "design-memo",
    preheader: subject,
  });

  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "Zero <zero@zmail.bot>",
      to: [ADMIN_EMAIL],
      cc: ["zero@zmail.bot"],
      subject,
      html,
      text: bodyMd,
    }),
  });

  if (!r.ok) throw new Error(`Resend returned ${r.status}: ${await r.text()}`);
  const result = await r.json() as { id: string };
  return result.id;
}

async function main(): Promise<void> {
  const sendEmailFlag = process.argv.includes("--email");

  console.log(`[flywheel-monitor] Fetching dashboard from ${WORKER}...`);
  const dashboard = await fetchDashboard();
  const health = classifyHealth(dashboard);
  const body = buildReportBody(dashboard, health);

  console.log(`[flywheel-monitor] Status: ${health.status}`);
  console.log(`  Fleet: ${dashboard.fleet_online}/${dashboard.fleet_count} online`);
  console.log(`  Training: ${dashboard.active_training_runs} active`);
  console.log(`  Edge cases: ${dashboard.pending_edges} pending`);

  if (sendEmailFlag) {
    const subject = `[zero] 数据飞轮日报 ${health.status === "healthy" ? "✅" : health.status === "warning" ? "⚠️" : "🚨"}`;
    const emailId = await sendEmail(subject, body);
    console.log(`[flywheel-monitor] Email sent: ${emailId}`);
  } else {
    console.log(body);
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
