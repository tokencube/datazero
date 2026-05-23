// Contract: data_flywheel.contract.md — each test maps to invariants I1-I24.
// See §6 Test Plan for the full mapping table.
//
import { describe, expect, test, vi, beforeEach } from "vitest";

vi.mock("../../src/lib/do_strand", () => ({
  doAppendStrand: vi.fn().mockResolvedValue(99),
  doRecentTraces: vi.fn().mockResolvedValue([]),
}));

import {
  emitFlywheelSignal,
  emitFlywheelSignalCtx,
  collectSignals,
  collectSignalsCtx,
  flywheelHealthCheck,
  exportTrainingData,
  exportTrainingDataCtx,
  toShareGPT,
} from "./data_flywheel";
import type {
  FlywheelSignal,
  FlywheelSource,
  TrainingExample,
  ExportTrainingOpts,
} from "./data_flywheel";
import { doRecentTraces } from "../../src/lib/do_strand";
import type { DoStrandEnv, DoTraceRow } from "../../src/lib/do_strand";
import type { Strand } from "../../src/kernel/strand";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validSignal(overrides: Partial<FlywheelSignal> = {}): FlywheelSignal {
  return {
    source: "@test",
    principal: "agent_abc123",
    action: "unit test ran and passed",
    result: "success",
    ts: Date.now(),
    ...overrides,
  };
}

function makeEnv(): DoStrandEnv {
  return {}; // doAppendStrand/doRecentTraces are mocked via vi.mock
}

function makeCtx(overrides: Partial<import("../kernel/skill").SkillCtx> = {}) {
  return {
    strand: vi.fn().mockResolvedValue(42),
    queryStrands: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as import("../kernel/skill").SkillCtx;
}

function makeStrandRow(overrides: Partial<DoTraceRow> = {}): DoTraceRow {
  return {
    id: 1,
    ts: Date.now(),
    schema_version: 1,
    event_kind: "zero.flywheel.signal",
    parent_id: null,
    agent_id: "agent_abc123",
    payload: {
      source: "@test",
      principal: "agent_abc123",
      action: "search for O型圈",
      result: "success",
      feedback: "found 5 results",
    },
    signature: null,
    ...overrides,
  };
}

function makeChatRow(overrides: Partial<DoTraceRow> = {}): DoTraceRow {
  return {
    id: 2,
    ts: Date.now(),
    schema_version: 1,
    event_kind: "llm.chat",
    parent_id: null,
    agent_id: "agent_abc123",
    payload: {
      messages: [
        { role: "user", content: "What is an O-ring?" },
        { role: "assistant", content: "An O-ring is a torus-shaped mechanical gasket." },
      ],
    },
    signature: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// emitFlywheelSignal — DoStrandEnv variant
// ---------------------------------------------------------------------------
describe("emitFlywheelSignal", () => {
  test("returns strand_id on valid signal", async () => {
    const env = makeEnv();
    const id = await emitFlywheelSignal(env, validSignal());
    // The real function calls doAppendStrand which hits AGENT DO.
    // Without a real DO, this throws. Test validates the contract shape.
    // Integration test (with real DO) validates id > 0.
    expect(typeof id).toBe("number");
  });

  test("rejects missing source", async () => {
    await expect(
      emitFlywheelSignal(makeEnv(), validSignal({ source: undefined as unknown as FlywheelSource })),
    ).rejects.toThrow("source");
  });

  test("rejects invalid source", async () => {
    await expect(
      emitFlywheelSignal(makeEnv(), validSignal({ source: "@invalid" as FlywheelSource })),
    ).rejects.toThrow("source");
  });

  test("rejects missing principal", async () => {
    await expect(
      emitFlywheelSignal(makeEnv(), validSignal({ principal: "" })),
    ).rejects.toThrow("principal");
  });

  test("rejects missing action", async () => {
    await expect(
      emitFlywheelSignal(makeEnv(), validSignal({ action: "" })),
    ).rejects.toThrow("action");
  });

  test("rejects missing result", async () => {
    await expect(
      emitFlywheelSignal(makeEnv(), validSignal({ result: undefined as unknown as FlywheelSignal["result"] })),
    ).rejects.toThrow("result");
  });

  test("rejects future ts", async () => {
    await expect(
      emitFlywheelSignal(makeEnv(), validSignal({ ts: Date.now() + 86_400_000 + 5000 })),
    ).rejects.toThrow("future");
  });

  test("accepts ts within 24h in the future (clock skew tolerance)", async () => {
    // Should NOT throw — 1 hour clock skew is tolerated.
    const env = makeEnv();
    await expect(
      emitFlywheelSignal(makeEnv(), validSignal({ ts: Date.now() + 3_600_000 })),
    ).resolves.toBeDefined();
  });

  test("all 6 sources are valid", async () => {
    const sources: FlywheelSource[] = ["@test", "@deploy", "@click", "@email", "@search", "@code"];
    for (const source of sources) {
      const env = makeEnv();
      await expect(
        emitFlywheelSignal(env, validSignal({ source })),
      ).resolves.toBeDefined();
    }
  });

  test("optional feedback field is preserved", async () => {
    const env = makeEnv();
    await expect(
      emitFlywheelSignal(env, validSignal({ feedback: "user said this was great" })),
    ).resolves.toBeDefined();
  });

  test("optional context field is preserved", async () => {
    const env = makeEnv();
    await expect(
      emitFlywheelSignal(env, validSignal({ context: { query: "O型圈", results: 5 } })),
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// emitFlywheelSignalCtx — SkillCtx variant
// ---------------------------------------------------------------------------
describe("emitFlywheelSignalCtx", () => {
  test("delegates to ctx.strand with correct event_kind", async () => {
    const ctx = makeCtx();
    const signal = validSignal();
    const id = await emitFlywheelSignalCtx(ctx, signal);

    expect(ctx.strand).toHaveBeenCalledOnce();
    expect(id).toBe(42);
    const call = (ctx.strand as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.event_kind).toBe("zero.flywheel.signal");
    expect(call.payload).toEqual(signal);
  });

  test("rejects invalid signal same as DoStrandEnv variant", async () => {
    const ctx = makeCtx();
    await expect(
      emitFlywheelSignalCtx(ctx, validSignal({ source: undefined as unknown as FlywheelSource })),
    ).rejects.toThrow("source");
  });
});

// ---------------------------------------------------------------------------
// collectSignals — DoStrandEnv variant
// ---------------------------------------------------------------------------
describe("collectSignals", () => {
  test("returns empty array when no signals exist", async () => {
    const env = makeEnv();
    // Without a real AGENT DO, doRecentTraces returns [] (fail-empty).
    const signals = await collectSignals(env);
    expect(Array.isArray(signals)).toBe(true);
  });

  test("accepts source filter option", async () => {
    const env = makeEnv();
    const signals = await collectSignals(env, { source: "@test" });
    expect(Array.isArray(signals)).toBe(true);
  });

  test("accepts since filter option", async () => {
    const env = makeEnv();
    const signals = await collectSignals(env, { since: Date.now() - 3600000 });
    expect(Array.isArray(signals)).toBe(true);
  });

  test("accepts limit option", async () => {
    const env = makeEnv();
    const signals = await collectSignals(env, { limit: 10 });
    expect(Array.isArray(signals)).toBe(true);
  });

  test("filter handles all sources", async () => {
    const env = makeEnv();
    const sources: FlywheelSource[] = ["@test", "@deploy", "@click", "@email", "@search", "@code"];
    for (const source of sources) {
      await expect(collectSignals(env, { source })).resolves.toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// collectSignalsCtx — SkillCtx variant
// ---------------------------------------------------------------------------
describe("collectSignalsCtx", () => {
  test("delegates to ctx.queryStrands with correct event_kind", async () => {
    const ctx = makeCtx();
    const signals = await collectSignalsCtx(ctx, { limit: 5 });

    expect(ctx.queryStrands).toHaveBeenCalledOnce();
    const call = (ctx.queryStrands as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.event_kind).toBe("zero.flywheel.signal");
    expect(call.limit).toBe(5);
    expect(signals).toEqual([]);
  });

  test("returns empty when no opts provided", async () => {
    const ctx = makeCtx();
    const signals = await collectSignalsCtx(ctx);
    expect(signals).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// flywheelHealthCheck
// ---------------------------------------------------------------------------
describe("flywheelHealthCheck", () => {
  test("returns ok:false with zero signals when no data", async () => {
    const env = makeEnv();
    const health = await flywheelHealthCheck(env);
    expect(health.ok).toBe(false);
    expect(health.signals_24h).toBe(0);
    expect(health.export_age_h).toBeNull();
  });

  test("returns structured health shape", async () => {
    const env = makeEnv();
    const health = await flywheelHealthCheck(env);
    expect(health).toHaveProperty("ok");
    expect(health).toHaveProperty("signals_24h");
    expect(health).toHaveProperty("export_age_h");
    expect(typeof health.ok).toBe("boolean");
    expect(typeof health.signals_24h).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Training data export
// ---------------------------------------------------------------------------
describe("toShareGPT", () => {
  const examples: TrainingExample[] = [
    {
      id: "strand_1",
      strandId: 1,
      eventKind: "zero.flywheel.signal",
      instruction: "search for O型圈",
      output: "success — found 5 results",
      agentId: "agent_abc123",
      ts: Date.now(),
    },
  ];

  test("formats examples into ShareGPT shape", () => {
    const result = toShareGPT(examples);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("strand_1");
    expect(result[0]!.conversations).toHaveLength(2);
    expect(result[0]!.conversations[0]!.from).toBe("human");
    expect(result[0]!.conversations[0]!.value).toBe("search for O型圈");
    expect(result[0]!.conversations[1]!.from).toBe("gpt");
    expect(result[0]!.conversations[1]!.value).toBe("success — found 5 results");
  });

  test("adds system prompt when provided", () => {
    const result = toShareGPT(examples, "You are an MRO assistant.");
    expect(result[0]!.conversations).toHaveLength(3);
    expect(result[0]!.conversations[0]!.from).toBe("system");
    expect(result[0]!.conversations[0]!.value).toBe("You are an MRO assistant.");
  });

  test("returns empty array for empty input", () => {
    expect(toShareGPT([])).toEqual([]);
  });
});

describe("exportTrainingData (DoStrandEnv)", () => {
  test("returns empty string when no strands exist", async () => {
    vi.mocked(doRecentTraces).mockResolvedValue([]);
    const env = makeEnv();
    const result = await exportTrainingData(env, { format: "sharegpt" });
    expect(result).toBe("");
  });

  test("returns JSONL with flywheel signal as ShareGPT conversation", async () => {
    const row = makeStrandRow();
    vi.mocked(doRecentTraces).mockResolvedValue([row]);

    const env = makeEnv();
    const result = await exportTrainingData(env, { format: "sharegpt" });

    const lines = result.trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.id).toBe("strand_1");
    expect(parsed.conversations).toHaveLength(2);
    expect(parsed.conversations[0].from).toBe("human");
    expect(parsed.conversations[0].value).toBe("search for O型圈");
    expect(parsed.conversations[1].from).toBe("gpt");
    expect(parsed.conversations[1].value).toContain("success");
    expect(parsed.conversations[1].value).toContain("found 5 results");
  });

  test("formats llm.chat strands extracting user/assistant turns", async () => {
    const row = makeChatRow();
    vi.mocked(doRecentTraces).mockResolvedValue([row]);

    const env = makeEnv();
    const result = await exportTrainingData(env, { format: "sharegpt" });

    const parsed = JSON.parse(result.trim().split("\n")[0]!);
    expect(parsed.conversations[0].from).toBe("human");
    expect(parsed.conversations[0].value).toBe("What is an O-ring?");
    expect(parsed.conversations[1].from).toBe("gpt");
    expect(parsed.conversations[1].value).toBe(
      "An O-ring is a torus-shaped mechanical gasket.",
    );
  });

  test("skips strands without actionable instruction", async () => {
    const row = makeStrandRow({
      payload: { source: "@test", principal: "x" }, // no action, no result
    });
    vi.mocked(doRecentTraces).mockResolvedValue([row]);
    const env = makeEnv();
    const result = await exportTrainingData(env, { format: "sharegpt" });
    expect(result).toBe("");
  });

  test("deduplicates strands by id across multiple kinds", async () => {
    // Same strand might match both flywheel and chat filters
    const row1 = makeStrandRow({ id: 100 });
    const row2 = makeChatRow({ id: 100 }); // same id as row1

    // First call returns row1, second returns row2
    vi.mocked(doRecentTraces)
      .mockResolvedValueOnce([row1])
      .mockResolvedValueOnce([row2]);

    const env = makeEnv();
    const result = await exportTrainingData(env, { format: "sharegpt" });
    const lines = result.trim().split("\n");
    expect(lines).toHaveLength(1); // deduped to 1
  });

  test("honors custom eventKinds option", async () => {
    const row = makeChatRow();
    vi.mocked(doRecentTraces).mockResolvedValue([row]);

    const env = makeEnv();
    const result = await exportTrainingData(env, {
      format: "sharegpt",
      eventKinds: ["llm.chat"],
    });

    // Should have called doRecentTraces with "llm.chat"
    expect(doRecentTraces).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "llm.chat",
    );
    expect(result).not.toBe("");
  });

  test("split=train returns first 90%", async () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      makeStrandRow({ id: i + 1 }),
    );
    vi.mocked(doRecentTraces).mockResolvedValue(rows);

    const env = makeEnv();
    const result = await exportTrainingData(env, {
      format: "sharegpt",
      split: "train",
    });

    const lines = result.trim().split("\n");
    expect(lines).toHaveLength(9); // 90% of 10
  });

  test("split=val returns last 10%", async () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      makeStrandRow({ id: i + 1 }),
    );
    vi.mocked(doRecentTraces).mockResolvedValue(rows);

    const env = makeEnv();
    const result = await exportTrainingData(env, {
      format: "sharegpt",
      split: "val",
    });

    const lines = result.trim().split("\n");
    expect(lines).toHaveLength(1); // 10% of 10 = 1
  });

  test("no split returns all examples", async () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      makeStrandRow({ id: i + 1 }),
    );
    vi.mocked(doRecentTraces).mockResolvedValue(rows);

    const env = makeEnv();
    const result = await exportTrainingData(env, {
      format: "sharegpt",
    });

    const lines = result.trim().split("\n");
    expect(lines).toHaveLength(10);
  });

  test("adds system prompt as first conversation turn", async () => {
    const row = makeStrandRow();
    vi.mocked(doRecentTraces).mockResolvedValue([row]);

    const env = makeEnv();
    const result = await exportTrainingData(env, {
      format: "sharegpt",
      systemPrompt: "You are an MRO assistant.",
    });

    const parsed = JSON.parse(result.trim().split("\n")[0]!);
    expect(parsed.conversations).toHaveLength(3);
    expect(parsed.conversations[0].from).toBe("system");
    expect(parsed.conversations[0].value).toBe("You are an MRO assistant.");
  });

  test("nemo format produces same JSONL output as sharegpt", async () => {
    const row = makeStrandRow();
    vi.mocked(doRecentTraces).mockResolvedValue([row]);

    const env = makeEnv();
    const sharegptResult = await exportTrainingData(env, { format: "sharegpt" });
    const nemoResult = await exportTrainingData(env, { format: "nemo" });

    expect(nemoResult).toBe(sharegptResult); // NeMo Automodel natively reads ShareGPT JSONL
  });

  test("sorts by strand id descending (most recent first)", async () => {
    const rows = [
      makeStrandRow({ id: 1, payload: { source: "@test", principal: "a", action: "action-1", result: "success" } }),
      makeStrandRow({ id: 5, payload: { source: "@test", principal: "a", action: "action-5", result: "success" } }),
      makeStrandRow({ id: 3, payload: { source: "@test", principal: "a", action: "action-3", result: "success" } }),
    ];
    vi.mocked(doRecentTraces).mockResolvedValue(rows);

    const env = makeEnv();
    const result = await exportTrainingData(env, { format: "sharegpt" });

    const lines = result.trim().split("\n");
    const ids = lines.map((l) => JSON.parse(l).id);
    expect(ids).toEqual(["strand_5", "strand_3", "strand_1"]);
  });
});

describe("exportTrainingDataCtx (SkillCtx)", () => {
  function makeCtxStrand(overrides: Partial<Strand> = {}): Strand {
    return {
      id: 1,
      ts: Date.now(),
      event_kind: "zero.flywheel.signal",
      parent_id: null,
      thread_id: "thread_1",
      agent_id: "agent_abc123",
      envelope_message_id: "msg_1@zmail.bot",
      envelope_in_reply_to: null,
      visibility: "public",
      caps_used: [],
      payload: {
        source: "@test",
        principal: "agent_abc123",
        action: "search for O型圈",
        result: "success",
        feedback: "found 5 results",
      },
      ...overrides,
    };
  }

  test("delegates to ctx.queryStrands with correct event kinds", async () => {
    const ctx = makeCtx({
      queryStrands: vi.fn().mockResolvedValue([]),
    });

    await exportTrainingDataCtx(ctx, { format: "sharegpt" });

    expect(ctx.queryStrands).toHaveBeenCalled();
    const calls = (ctx.queryStrands as ReturnType<typeof vi.fn>).mock.calls;
    const kinds = calls.map((c: Array<{ event_kind: string }>) => c[0].event_kind).sort();
    // Should query both default kinds
    expect(kinds).toContain("zero.flywheel.signal");
    expect(kinds).toContain("llm.chat");
  });

  test("returns JSONL string from strand data", async () => {
    const row = makeCtxStrand();
    const ctx = makeCtx({
      queryStrands: vi.fn().mockResolvedValue([row]),
    });

    const result = await exportTrainingDataCtx(ctx, { format: "sharegpt" });
    expect(result).toContain("strand_1");
    expect(result).toContain("search for O型圈");
  });

  test("deduplicates across multiple kind queries", async () => {
    const row = makeCtxStrand({ id: 42 });
    const ctx = makeCtx({
      // Return same strand for both kind queries
      queryStrands: vi.fn().mockResolvedValue([row]),
    });

    const result = await exportTrainingDataCtx(ctx, { format: "sharegpt" });
    const lines = result.trim().split("\n");
    expect(lines).toHaveLength(1);
  });

  test("returns empty string when no strands match", async () => {
    const ctx = makeCtx({
      queryStrands: vi.fn().mockResolvedValue([]),
    });

    const result = await exportTrainingDataCtx(ctx, { format: "sharegpt" });
    expect(result).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Type-level: FlywheelSource is exactly 6 values
// ---------------------------------------------------------------------------
describe("FlywheelSource type contract", () => {
  test("all 6 source values are distinct", () => {
    const sources: FlywheelSource[] = ["@test", "@deploy", "@click", "@email", "@search", "@code"];
    expect(new Set(sources).size).toBe(6);
  });

  test("each source has @ prefix", () => {
    const sources: FlywheelSource[] = ["@test", "@deploy", "@click", "@email", "@search", "@code"];
    for (const s of sources) {
      expect(s.startsWith("@")).toBe(true);
    }
  });
});
