import { test } from "node:test";
import assert from "node:assert/strict";
import { placeCall, getTwilioConfig, isTwilioConfigured, getCallStatus } from "../src/ping/twilio.ts";

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

const validConfig = {
  accountSid: "ACtest123",
  authToken: "token456",
  fromNumber: "+15551234567",
  toNumber: "+15557654321",
  timeoutMs: 5000,
};

test("getTwilioConfig returns null when env vars are missing", () => {
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_FROM_NUMBER;
  delete process.env.TWILIO_TO_NUMBER;
  assert.equal(getTwilioConfig(), null);
});

test("getTwilioConfig returns config when all env vars are set", () => {
  process.env.TWILIO_ACCOUNT_SID = "ACtest";
  process.env.TWILIO_AUTH_TOKEN = "tok";
  process.env.TWILIO_FROM_NUMBER = "+15550000000";
  process.env.TWILIO_TO_NUMBER = "+15551111111";
  const cfg = getTwilioConfig();
  assert.ok(cfg);
  assert.equal(cfg!.accountSid, "ACtest");
  assert.equal(cfg!.authToken, "tok");
  assert.equal(cfg!.fromNumber, "+15550000000");
  assert.equal(cfg!.toNumber, "+15551111111");
});

test("isTwilioConfigured returns false when env vars are missing", () => {
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_FROM_NUMBER;
  delete process.env.TWILIO_TO_NUMBER;
  assert.equal(isTwilioConfigured(), false);
});

test("isTwilioConfigured returns true when all env vars are set", () => {
  process.env.TWILIO_ACCOUNT_SID = "ACtest";
  process.env.TWILIO_AUTH_TOKEN = "tok";
  process.env.TWILIO_FROM_NUMBER = "+15550000000";
  process.env.TWILIO_TO_NUMBER = "+15551111111";
  assert.equal(isTwilioConfigured(), true);
});

test("placeCall returns sid and status on success", async () => {
  await withFetch(async () =>
    jsonRes({ sid: "CA123456", status: "queued" }),
  async () => {
    const result = await placeCall("https://example.com/twiml", validConfig);
    assert.equal(result.sid, "CA123456");
    assert.equal(result.status, "queued");
  });
});

test("placeCall sends correct URL and body", async () => {
  let capturedUrl: string | undefined;
  let capturedBody: string | undefined;
  await withFetch(async (url, init) => {
    capturedUrl = url.toString();
    capturedBody = (init as RequestInit).body as string;
    return jsonRes({ sid: "CA123", status: "queued" });
  }, async () => {
    await placeCall("https://my-ngrok.app/twiml", validConfig);
    assert.ok(capturedUrl!.includes("/Accounts/ACtest123/Calls.json"));
    const params = new URLSearchParams(capturedBody!);
    assert.equal(params.get("To"), "+15557654321");
    assert.equal(params.get("From"), "+15551234567");
    assert.equal(params.get("Url"), "https://my-ngrok.app/twiml");
  });
});

test("placeCall sends Basic auth header", async () => {
  let capturedHeaders: Headers | undefined;
  await withFetch(async (_url, init) => {
    capturedHeaders = new Headers((init as RequestInit).headers);
    return jsonRes({ sid: "CA123", status: "queued" });
  }, async () => {
    await placeCall("https://example.com/twiml", validConfig);
    const expected = `Basic ${btoa("ACtest123:token456")}`;
    assert.equal(capturedHeaders!.get("Authorization"), expected);
  });
});

test("placeCall throws on non-2xx response", async () => {
  await withFetch(async () => jsonRes({ error: "bad number" }, 400), async () => {
    await assert.rejects(
      () => placeCall("https://example.com/twiml", validConfig),
      /Twilio responded 400/,
    );
  });
});

test("placeCall throws on missing sid in response", async () => {
  await withFetch(async () => jsonRes({ status: "queued" }), async () => {
    await assert.rejects(
      () => placeCall("https://example.com/twiml", validConfig),
      /missing call SID/,
    );
  });
});

test("placeCall throws on timeout", async () => {
  await withFetch(async (_url, init) => {
    const signal = (init as RequestInit & { signal?: AbortSignal }).signal;
    if (signal) {
      return new Promise<Response>((_resolve, reject) => {
        if (signal.aborted) reject(new DOMException("aborted", "AbortError"));
        signal.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    }
    return jsonRes({ sid: "CA123" });
  }, async () => {
    await assert.rejects(
      () => placeCall("https://example.com/twiml", { ...validConfig, timeoutMs: 50 }),
      (err: unknown) => err instanceof Error && /timed out after 50ms/.test(err.message),
    );
  });
});

test("placeCall throws when config is null and no env vars set", async () => {
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_FROM_NUMBER;
  delete process.env.TWILIO_TO_NUMBER;
  await assert.rejects(
    () => placeCall("https://example.com/twiml"),
    /Twilio is not configured/,
  );
});

test("getCallStatus returns status on success", async () => {
  await withFetch(async () => jsonRes({ status: "in-progress" }), async () => {
    const status = await getCallStatus("CA123", validConfig);
    assert.equal(status, "in-progress");
  });
});

test("getCallStatus returns null on error", async () => {
  await withFetch(async () => jsonRes({ error: "not found" }, 404), async () => {
    const status = await getCallStatus("CA123", validConfig);
    assert.equal(status, null);
  });
});

test("getCallStatus returns null when config is null", async () => {
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_FROM_NUMBER;
  delete process.env.TWILIO_TO_NUMBER;
  const status = await getCallStatus("CA123");
  assert.equal(status, null);
});

test("placeCall clears timeout after success (no unhandled rejection)", async () => {
  await withFetch(async () => jsonRes({ sid: "CA123", status: "queued" }), async () => {
    await placeCall("https://example.com/twiml", validConfig);
    await new Promise((r) => setTimeout(r, validConfig.timeoutMs + 100));
  });
});