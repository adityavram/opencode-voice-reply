import { test } from "node:test";
import assert from "node:assert/strict";

test("deterministic backend when OCODE_VOICE_SUMMARIZER=deterministic", async () => {
  process.env.OCODE_VOICE_SUMMARIZER = "deterministic";
  const { summarize } = await import("../src/summarize.ts");
  const out = await summarize("Done. ```code\nx=1\n``` Fixed bug.");
  assert.ok(out.includes("Done"), `deterministic output: ${out}`);
  assert.ok(!out.includes("code"), `expected code stripped: ${out}`);
});

test("llm backend falls back to deterministic on fetch failure", async () => {
  process.env.OCODE_VOICE_SUMMARIZER = "llm";
  process.env.OCODE_VOICE_OLLAMA_URL = "http://127.0.0.1:1";
  process.env.OCODE_VOICE_OLLAMA_TIMEOUT = "200";
  const { summarize } = await import("../src/summarize.ts");
  const out = await summarize("Done. Fixed the bug in auth.");
  assert.ok(out.length > 0, `expected fallback output, got: ${out}`);
});

test("llm backend falls back on timeout (AbortError)", async () => {
  process.env.OCODE_VOICE_SUMMARIZER = "llm";
  process.env.OCODE_VOICE_OLLAMA_URL = "http://127.0.0.1:1";
  process.env.OCODE_VOICE_OLLAMA_TIMEOUT = "10";
  const { summarize } = await import("../src/summarize.ts");
  const out = await summarize("Short reply.");
  assert.ok(out.length > 0);
});

test("unknown backend falls back to deterministic", async () => {
  process.env.OCODE_VOICE_SUMMARIZER = "nonsense";
  const { summarize } = await import("../src/summarize.ts");
  const out = await summarize("Done. Fixed the bug.");
  assert.ok(out.length > 0);
});

test("default backend (no env) is llm, falls back gracefully", async () => {
  delete process.env.OCODE_VOICE_SUMMARIZER;
  process.env.OCODE_VOICE_OLLAMA_URL = "http://127.0.0.1:1";
  process.env.OCODE_VOICE_OLLAMA_TIMEOUT = "50";
  const { summarize } = await import("../src/summarize.ts");
  const out = await summarize("Test reply.");
  assert.ok(out.length > 0);
});