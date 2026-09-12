import { test } from "node:test";
import assert from "node:assert/strict";

type FetchImpl = typeof fetch;
const realFetch = globalThis.fetch;

function withFetch(mock: FetchImpl, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  return fn().finally(() => {
    globalThis.fetch = original as FetchImpl;
  });
}

function passthroughLocalhost(mock: FetchImpl): FetchImpl {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("localhost") || url.includes("127.0.0.1")) {
      return realFetch(input as any, init as any);
    }
    return mock(input as any, init as any);
  };
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function audioRes(): Response {
  return new Response(Buffer.from("fake-audio"), {
    status: 200,
    headers: { "Content-Type": "audio/mpeg" },
  });
}

function twilioCallRes(): Response {
  return jsonRes({ sid: "CA123", status: "queued" });
}

const twilioEnv = {
  TWILIO_ACCOUNT_SID: "ACtest",
  TWILIO_AUTH_TOKEN: "tok",
  TWILIO_FROM_NUMBER: "+15550000000",
  TWILIO_TO_NUMBER: "+15551111111",
};

const elevenLabsEnv = {
  ELEVENLABS_API_KEY: "test-key",
};

function setEnv(vars: Record<string, string>) {
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
}

function deleteEnv(vars: Record<string, string>) {
  for (const k of Object.keys(vars)) delete process.env[k];
}

function setupPingEnv(port: string) {
  process.env.OCODE_VOICE_NGROK_URL = "https://test.ngrok.app";
  setEnv({ ...twilioEnv, ...elevenLabsEnv });
  process.env.ELEVENLABS_TIMEOUT = "5000";
  process.env.TWILIO_TIMEOUT = "5000";
  process.env.OCODE_VOICE_PING_PORT = port;
  process.env.OCODE_VOICE_PING_LIFETIME_MS = "10000";
}

function teardownPingEnv() {
  delete process.env.OCODE_VOICE_NGROK_URL;
  delete process.env.ELEVENLABS_TIMEOUT;
  delete process.env.TWILIO_TIMEOUT;
  delete process.env.OCODE_VOICE_PING_PORT;
  delete process.env.OCODE_VOICE_PING_LIFETIME_MS;
  deleteEnv({ ...twilioEnv, ...elevenLabsEnv });
}

async function postGather(port: string, speechResult: string): Promise<void> {
  await realFetch(`http://localhost:${port}/gather`, {
    method: "POST",
    body: new URLSearchParams({ SpeechResult: speechResult }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
}

function mockExternalFetch(extraHandlers?: (url: string) => Response | undefined): FetchImpl {
  return async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("localhost") || url.includes("127.0.0.1")) {
      return realFetch(input as any);
    }
    if (url.includes("elevenlabs.io")) return audioRes();
    if (url.includes("Calls.json")) return twilioCallRes();
    const extra = extraHandlers?.(url);
    if (extra) return extra;
    return jsonRes({});
  };
}

test("pingPhone throws when ngrok URL is not set", async () => {
  delete process.env.OCODE_VOICE_NGROK_URL;
  setEnv({ ...twilioEnv, ...elevenLabsEnv });
  const { pingPhone } = await import("../src/ping/index.ts");
  await assert.rejects(() => pingPhone({ text: "test" }), /OCODE_VOICE_NGROK_URL/);
  deleteEnv({ ...twilioEnv, ...elevenLabsEnv });
});

test("pingPhone throws when Twilio is not configured", async () => {
  process.env.OCODE_VOICE_NGROK_URL = "https://test.ngrok.app";
  delete process.env.TWILIO_ACCOUNT_SID;
  setEnv(elevenLabsEnv);
  const { pingPhone } = await import("../src/ping/index.ts");
  await assert.rejects(() => pingPhone({ text: "test" }), /Twilio is not configured/);
  delete process.env.OCODE_VOICE_NGROK_URL;
  deleteEnv(elevenLabsEnv);
});

test("pingPhone throws when text is empty", async () => {
  process.env.OCODE_VOICE_NGROK_URL = "https://test.ngrok.app";
  setEnv({ ...twilioEnv, ...elevenLabsEnv });
  const { pingPhone } = await import("../src/ping/index.ts");
  await assert.rejects(() => pingPhone({ text: "   " }), /empty/);
  delete process.env.OCODE_VOICE_NGROK_URL;
  deleteEnv({ ...twilioEnv, ...elevenLabsEnv });
});

test("pingPhone prefixes text with opencode needs attention", async () => {
  setupPingEnv("18010");
  const { pingPhone } = await import("../src/ping/index.ts");

  let callPlaced = false;
  const mock = async (input: any) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("localhost") || url.includes("127.0.0.1")) {
      return realFetch(input);
    }
    if (url.includes("elevenlabs.io")) return audioRes();
    if (url.includes("Calls.json")) {
      callPlaced = true;
      return twilioCallRes();
    }
    return jsonRes({});
  };

  await withFetch(mock, async () => {
    const pingPromise = pingPhone({ text: "permission needed for bash command" });

    await new Promise((r) => setTimeout(r, 300));
    await postGather("18010", "yes approve it");

    const result = await pingPromise;
    assert.ok(callPlaced);
    assert.ok(result.spokenText.startsWith("opencode needs your attention."));
    assert.ok(result.spokenText.includes("permission needed for bash command"));
    assert.equal(result.userResponse, "yes approve it");
  });

  teardownPingEnv();
});

test("pingPhone does not prefix text that already starts with opencode needs", async () => {
  setupPingEnv("18011");
  const { pingPhone } = await import("../src/ping/index.ts");

  await withFetch(mockExternalFetch(), async () => {
    const pingPromise = pingPhone({ text: "opencode needs your attention. Run the command." });

    await new Promise((r) => setTimeout(r, 300));
    await postGather("18011", "ok");

    const result = await pingPromise;
    assert.equal(result.spokenText, "opencode needs your attention. Run the command.");
  });

  teardownPingEnv();
});

test("pingPhone injects user response into session via promptAsync", async () => {
  setupPingEnv("18012");
  const { pingPhone } = await import("../src/ping/index.ts");

  let promptAsyncCalled = false;
  let capturedPromptBody: unknown;

  const mockClient = {
    session: {
      promptAsync: async (options: any) => {
        promptAsyncCalled = true;
        capturedPromptBody = options;
        return {};
      },
    },
    app: { log: async () => {} },
    tui: { showToast: async () => {} },
  };

  await withFetch(mockExternalFetch(), async () => {
    const pingPromise = pingPhone({
      text: "need permission for bash",
      sessionId: "sess-123",
      client: mockClient as any,
    });

    await new Promise((r) => setTimeout(r, 300));
    await postGather("18012", "yes, run it");

    const result = await pingPromise;
    assert.equal(result.userResponse, "yes, run it");
    assert.ok(promptAsyncCalled);
    const opts = capturedPromptBody as any;
    assert.equal(opts.path.id, "sess-123");
    assert.equal(opts.body.parts[0].type, "text");
    assert.equal(opts.body.parts[0].text, "yes, run it");
    assert.equal(opts.body.parts[0].synthetic, true);
  });

  teardownPingEnv();
});