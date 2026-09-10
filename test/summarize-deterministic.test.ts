import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeDeterministic } from "../src/summarize-deterministic.ts";

test("strips fenced code blocks", () => {
  const input = "Here is code:\n```ts\nconst x = 1\n```\nDone.";
  const out = summarizeDeterministic(input);
  assert.ok(!out.includes("const x"), `expected code removed, got: ${out}`);
  assert.ok(out.includes("Done"), `expected prose retained, got: ${out}`);
});

test("strips inline code", () => {
  const input = "I updated `src/foo.ts` and `bar.ts`.";
  const out = summarizeDeterministic(input);
  assert.ok(!out.includes("`"), `expected no backticks, got: ${out}`);
});

test("strips markdown headings and list markers", () => {
  const input = "## Summary\n- did A\n- did B\n1. did C";
  const out = summarizeDeterministic(input);
  assert.ok(!out.includes("##"), `expected no headings, got: ${out}`);
  assert.ok(!/^[-*+]\s/m.test(out), `expected no list markers, got: ${out}`);
});

test("strips markdown links and images", () => {
  const input = "See [docs](https://x.io) and ![img](pic.png). Done.";
  const out = summarizeDeterministic(input);
  assert.ok(!out.includes("docs.io") && !out.includes("pic.png"), `expected links stripped, got: ${out}`);
});

test("strips @-mentions", () => {
  const input = "Noted @alice, fixed the bug.";
  const out = summarizeDeterministic(input);
  assert.ok(!out.includes("@alice"), `expected @-mention stripped, got: ${out}`);
});

test("respects maxChars truncation", () => {
  const long = "Sentence one. Sentence two. Sentence three. Sentence four.";
  const out = summarizeDeterministic(long, 30);
  assert.ok(out.length <= 30, `expected <=30 chars, got ${out.length}: ${out}`);
});

test("truncates at word boundary when no sentence fits", () => {
  const long = "ThisIsOneVeryLongWordWithNoSpacesThatExceedsTheLimit easily.";
  const out = summarizeDeterministic(long, 20);
  assert.ok(out.length <= 20, `expected <=20 chars, got ${out.length}: ${out}`);
});

test("returns first 1-2 sentences up to maxChars", () => {
  const input = "First sentence. Second sentence. Third sentence.";
  const out = summarizeDeterministic(input, 100);
  assert.ok(out.startsWith("First sentence"), `expected to start with first sentence, got: ${out}`);
});

test("handles empty input gracefully", () => {
  assert.equal(summarizeDeterministic(""), "");
  assert.equal(summarizeDeterministic("   "), "");
});

test("handles code-only input", () => {
  const input = "```\nconst x = 1\n```";
  const out = summarizeDeterministic(input);
  assert.equal(out, "");
});