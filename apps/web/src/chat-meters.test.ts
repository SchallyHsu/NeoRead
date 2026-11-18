import { expect, it } from "vitest";
import type { Message } from "@neoread/core";
import { contextFill, meterLevel, quotaSummary } from "./ChatMeters";
import { readingAgent, selectReadingAgent } from "./NativeAgentSettings";
it("uses the tightest unexpired quota window and the original warning thresholds", () => {
  const value = quotaSummary(
    {
      account: {
        status: "available",
        checkedAt: 1,
        windows: [
          { id: "expired", label: "expired", usedPercent: 100, resetsAt: 1 },
          { id: "short", label: "short", usedPercent: 80 },
          { id: "long", label: "long", usedPercent: 90 },
        ],
      },
    },
    2,
  );
  expect(value.tight?.id).toBe("long");
  expect(value.left).toBe(10);
  expect([31, 30, 10].map((x) => meterLevel("quota", x))).toEqual([
    "",
    "warm",
    "high",
  ]);
  expect([69, 70, 85].map((x) => meterLevel("context", x))).toEqual([
    "",
    "warm",
    "high",
  ]);
});
it("retains reported context only for the backend of the open conversation", () => {
  const m = {
    role: "assistant",
    usage: { provider: "native:codex", contextUsed: 700, contextSize: 1000 },
  } as Message;
  expect(contextFill([m], "native:codex")?.pct).toBe(70);
  expect(contextFill([m], "api")).toBeUndefined();
});
it("selects exactly one reading connection and preserves its project after switching back", () => {
  const cfg = {
    primary: "api",
    nativeAgent: {
      provider: "",
      executables: {},
      directory: "",
      projectName: "My project",
    },
  } as Parameters<typeof selectReadingAgent>[0];
  const local = selectReadingAgent(cfg, "native:codex");
  expect(readingAgent(local)).toBe("native:codex");
  expect(local.primary).toBe("api");
  const builtin = selectReadingAgent(local, "claude");
  expect(readingAgent(builtin)).toBe("claude");
  expect(builtin.nativeAgent?.projectName).toBe("My project");
});
