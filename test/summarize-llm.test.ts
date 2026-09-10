import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeWithLLM } from "../src/summarize-llm.ts";

type FetchImpl = typeof fetch;

function withFetch(mock: FetchImpl, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  return fn().finally(() => {
    globalThis.fetch = original as FetchImpl;
  });
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const baseOpts = {
  baseUrl: "http://localhost:11434",
  model: "llama3.2:latest",
  timeoutMs: 5000,
};

test("returns trimmed content on success", async () => {
  await withFetch(async () =>
    jsonRes({ message: { content: "  Done. Fixed the bug.  " } }),
  async () => {
    const out = await summarizeWithLLM("any", baseOpts);
    assert.equal(out, "Done. Fixed the bug.");
  });
});

test("extracts summary from thinking field when content is empty (reasoning model)", async () => {
  await withFetch(
    async () =>
      jsonRes({
        message: {
          content: "",
          thinking: 'The summary is: "Done. I added speech interruption so hitting Enter stops the voice reply."',
        },
        done_reason: "length",
      }),
    async () => {
      const out = await summarizeWithLLM("any", baseOpts);
      assert.equal(out, "Done. I added speech interruption so hitting Enter stops the voice reply.");
    },
  );
});

test("extracts summary from thinking via quoted pattern", async () => {
  await withFetch(
    async () =>
      jsonRes({
        message: {
          content: "",
          thinking: 'Let me think. The answer is "I refactored auth to async/await." That works.',
        },
      }),
    async () => {
      const out = await summarizeWithLLM("any", baseOpts);
      assert.equal(out, "I refactored auth to async/await.");
    },
  );
});

test("throws with helpful message when thinking has no extractable summary", async () => {
  await withFetch(
    async () =>
      jsonRes({
        message: { content: "", thinking: "..." },
        done_reason: "length",
      }),
    async () => {
      await assert.rejects(
        () => summarizeWithLLM("x", baseOpts),
        /could not be extracted.*done_reason: length/,
      );
    },
  );
});

test("throws on non-2xx response", async () => {
  await withFetch(async () =>
    jsonRes({ error: "model not found" }, 404),
  async () => {
    await assert.rejects(
      () => summarizeWithLLM("x", baseOpts),
      /Ollama responded 404/,
    );
  });
});

test("throws on empty content field", async () => {
  await withFetch(async () => jsonRes({ message: { content: "" } }), async () => {
    await assert.rejects(
      () => summarizeWithLLM("x", baseOpts),
      /empty response/i,
    );
  });
});

test("throws on missing message field", async () => {
  await withFetch(async () => jsonRes({}), async () => {
    await assert.rejects(
      () => summarizeWithLLM("x", baseOpts),
      /empty response/i,
    );
  });
});

test("throws on whitespace-only content", async () => {
  await withFetch(async () => jsonRes({ message: { content: "   \n  " } }), async () => {
    await assert.rejects(
      () => summarizeWithLLM("x", baseOpts),
      /empty response/i,
    );
  });
});

test("throws AbortError when timeout fires", async () => {
  await withFetch(
    async (_url, init) => {
      const signal = (init as RequestInit & { signal?: AbortSignal }).signal;
      if (signal) {
        return new Promise<Response>((_resolve, reject) => {
          if (signal.aborted) reject(new DOMException("aborted", "AbortError"));
          signal.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        });
      }
      return jsonRes({ message: { content: "should never reach" } });
    },
    async () => {
      await assert.rejects(
        () => summarizeWithLLM("x", { ...baseOpts, timeoutMs: 50 }),
        (err: unknown) =>
          err instanceof Error && /timed out after 50ms/.test(err.message),
      );
    },
  );
});

test("passes Authorization header when token provided", async () => {
  let capturedHeaders: Headers | undefined;
  await withFetch(async (_url, init) => {
    capturedHeaders = new Headers((init as RequestInit).headers);
    return jsonRes({ message: { content: "ok" } });
  }, async () => {
    await summarizeWithLLM("x", { ...baseOpts, token: "secret123" });
    assert.equal(capturedHeaders?.get("Authorization"), "Bearer secret123");
  });
});

test("omits Authorization header when no token", async () => {
  let capturedHeaders: Headers | undefined;
  await withFetch(async (_url, init) => {
    capturedHeaders = new Headers((init as RequestInit).headers);
    return jsonRes({ message: { content: "ok" } });
  }, async () => {
    await summarizeWithLLM("x", { ...baseOpts, token: undefined });
    assert.equal(capturedHeaders?.get("Authorization"), null);
  });
});

test("sends expected body shape to /api/chat", async () => {
  let capturedBody: unknown;
  let capturedUrl: string | undefined;
  await withFetch(async (url, init) => {
    capturedUrl = url.toString();
    capturedBody = JSON.parse((init as RequestInit).body as string);
    return jsonRes({ message: { content: "ok" } });
  }, async () => {
    await summarizeWithLLM("hello world", baseOpts);
    assert.equal(capturedUrl, "http://localhost:11434/api/chat");
    assert.equal(capturedBody.model, "llama3.2:latest");
    assert.equal(capturedBody.stream, false);
    assert.equal(capturedBody.options.temperature, 0.3);
    assert.equal(capturedBody.options.num_predict, 200);
    assert.equal(capturedBody.messages.length, 2);
    assert.equal(capturedBody.messages[0].role, "system");
    assert.equal(capturedBody.messages[1].role, "user");
    assert.equal(capturedBody.messages[1].content, "hello world");
  });
});

test("handles non-JSON 200 response by throwing", async () => {
  await withFetch(async () => new Response("<html>not json</html>", {
    status: 200,
    headers: { "Content-Type": "text/html" },
  }), async () => {
    await assert.rejects(() => summarizeWithLLM("x", baseOpts));
  });
});

test("clears timeout after success (no unhandled rejection)", async () => {
  await withFetch(async () => jsonRes({ message: { content: "ok" } }), async () => {
    await summarizeWithLLM("x", baseOpts);
    await new Promise((r) => setTimeout(r, baseOpts.timeoutMs + 100));
  });
});

test("clears timeout after failure (no unhandled rejection)", async () => {
  await withFetch(async () => jsonRes({}, 500), async () => {
    try { await summarizeWithLLM("x", baseOpts); } catch {}
    await new Promise((r) => setTimeout(r, baseOpts.timeoutMs + 100));
  });
});