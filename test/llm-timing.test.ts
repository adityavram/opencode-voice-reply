import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeWithLLM } from "../src/summarize-llm.ts";

const BASE_URL = process.env.OCODE_VOICE_OLLAMA_URL ?? "https://api.ollama.com";
const MODEL = process.env.OCODE_VOICE_OLLAMA_MODEL ?? "mistral-large-3:675b";
const TOKEN = process.env.OCODE_VOICE_OLLAMA_TOKEN;

const TIMEOUT_MS = Number(process.env.OCODE_VOICE_OLLAMA_TIMEOUT) || 10000;

const FIXTURES = [
  { label: "tiny", text: "Done." },
  { label: "short", text: "I added speech interruption so hitting Enter stops the voice reply." },
  { label: "medium", text: "I refactored the auth module to use async/await instead of callbacks. The new code is in src/auth.ts and tests pass. Also fixed a small typo in README." },
  {
    label: "long",
    text: "I updated package.json to add the dependency on lodash, then I imported it in src/index.ts, and added a new function that uses lodash.debounce to wrap the search input handler. The tests in test/search.test.ts are passing now. I also fixed a small typo in the README. The debounce is set to 300ms and I added a cleanup call in the unmount path.",
  },
  {
    label: "huge",
    text: Array.from({ length: 60 }, (_, i) =>
      `Task ${i + 1}: I worked on module number ${i + 1} and verified it compiles.`
    ).join(" "),
  },
];

type TimingResult = {
  label: string
  ok: boolean
  ms: number
  tokens: number
  summary: string
  error?: string
};

async function runOnce(
  label: string,
  text: string,
  timeoutMs: number,
): Promise<TimingResult> {
  const start = performance.now();
  try {
    const out = await summarizeWithLLM(text, {
      baseUrl: BASE_URL,
      model: MODEL,
      token: TOKEN,
      timeoutMs,
    });
    const ms = Math.round(performance.now() - start);
    const words = out.trim().split(/\s+/).length;
    return { label, ok: true, ms, tokens: words, summary: out };
  } catch (err) {
    const ms = Math.round(performance.now() - start);
    return {
      label,
      ok: false,
      ms,
      tokens: 0,
      summary: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

const RUNS = 3;
const allResults: TimingResult[] = [];

for (const fixture of FIXTURES) {
  for (let i = 1; i <= RUNS; i++) {
    test(`timing: ${fixture.label} run ${i}`, { timeout: 45000 }, async () => {
      const result = await runOnce(`${fixture.label}#${i}`, fixture.text, TIMEOUT_MS);
      allResults.push(result);
      assert.ok(result.ok, `expected success within ${TIMEOUT_MS}ms, got: ${result.error}`);
      assert.ok(result.tokens > 0, `expected non-empty summary, got empty`);
      assert.ok(
        result.tokens <= 60,
        `expected summary within token cap, got ${result.tokens} tokens: ${result.summary}`,
      );
    });
  }
}

test("timing summary report", { timeout: 60000 }, async () => {
  while (allResults.length < FIXTURES.length * RUNS) {
    await new Promise((r) => setTimeout(r, 500));
  }
  const byLabel = new Map<string, TimingResult[]>();
  for (const r of allResults) {
    const key = r.label.split("#")[0];
    if (!byLabel.has(key)) byLabel.set(key, []);
    byLabel.get(key)!.push(r);
  }

  const reportLines: string[] = [
    "",
    "=== Ollama LLM summarizer timing report ===",
    `Timeout: ${TIMEOUT_MS}ms | Model: ${MODEL}`,
    "label     | p50      | p95      | max      | min      | fails | sample output",
    "--------- | -------- | -------- | -------- | -------- | ----- | -------------",
  ];

  let totalFails = 0;
  for (const [label, results] of byLabel) {
    const times = results.filter((r) => r.ok).map((r) => r.ms).sort((a, b) => a - b);
    const fails = results.filter((r) => !r.ok).length;
    totalFails += fails;
    const sample = results.find((r) => r.ok)?.summary ?? "(all failed)";
    reportLines.push(
      [
        label.padEnd(9),
        `${percentile(times, 50)}ms`.padStart(8),
        `${percentile(times, 95)}ms`.padStart(8),
        `${Math.max(...times, 0)}ms`.padStart(8),
        `${Math.min(...times, Infinity)}ms`.padStart(8),
        String(fails).padStart(5),
        sample.slice(0, 50),
      ].join(" | "),
    );
  }
  reportLines.push("--------- | -------- | -------- | -------- | -------- | ----- | -------------");
  const allTimes = allResults.filter((r) => r.ok).map((r) => r.ms).sort((a, b) => a - b);
  reportLines.push(
    [
      "ALL".padEnd(9),
      `${percentile(allTimes, 50)}ms`.padStart(8),
      `${percentile(allTimes, 95)}ms`.padStart(8),
      `${Math.max(...allTimes, 0)}ms`.padStart(8),
      `${Math.min(...allTimes, Infinity)}ms`.padStart(8),
      String(totalFails).padStart(5),
      "",
    ].join(" | "),
  );

  console.log(reportLines.join("\n"));

  const maxObserved = Math.max(...allTimes, 0);
  const aborted = allResults.filter((r) => !r.ok);
  const abortedTimes = aborted.map((r) => r.ms);
  const maxAborted = abortedTimes.length > 0 ? Math.max(...abortedTimes) : 0;
  const ceiling = Math.max(maxObserved, maxAborted);
  const recommended = Math.max(10000, Math.ceil(ceiling * 1.5));
  const verdict = aborted.length > 0
    ? `IS TOO LOW (${aborted.length} aborts, max attempt ${maxAborted}ms)`
    : maxObserved > TIMEOUT_MS * 0.8
      ? `IS RISKY (max observed ${maxObserved}ms is >80% of timeout)`
      : "is adequate";
  console.log(
    `\nRecommendation: set OCODE_VOICE_OLLAMA_TIMEOUT=${recommended} ` +
    `(ceiling ${ceiling}ms × 1.5 safety). ` +
    `Current ${TIMEOUT_MS}ms ${verdict}.`,
  );
});