import { test } from "node:test";
import assert from "node:assert/strict";
import { startAudioServer, getNgrokUrl } from "../src/ping/audio-server.ts";

const TEST_AUDIO = Buffer.from("fake-audio-data");

test("getNgrokUrl returns null when env not set", () => {
  delete process.env.OCODE_VOICE_NGROK_URL;
  assert.equal(getNgrokUrl(), null);
});

test("getNgrokUrl returns trimmed URL without trailing slash", () => {
  process.env.OCODE_VOICE_NGROK_URL = "https://abc.ngrok.app/";
  assert.equal(getNgrokUrl(), "https://abc.ngrok.app");
  delete process.env.OCODE_VOICE_NGROK_URL;
});

test("audio server serves TwiML at /twiml", async () => {
  const server = await startAudioServer({
    ngrokUrl: "https://test.ngrok.app",
    audioBuffer: TEST_AUDIO,
    port: 18001,
    lifetimeMs: 5000,
  });

  try {
    const res = await fetch("http://localhost:18001/twiml");
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.ok(text.includes("<Response>"));
    assert.ok(text.includes("<Gather"));
    assert.ok(text.includes('action="https://test.ngrok.app/gather"'));
    assert.ok(text.includes("<Play"));
    assert.ok(text.includes("https://test.ngrok.app/audio.mp3"));
  } finally {
    await server.close();
  }
});

test("audio server serves audio at /audio.mp3", async () => {
  const server = await startAudioServer({
    ngrokUrl: "https://test.ngrok.app",
    audioBuffer: TEST_AUDIO,
    port: 18002,
    lifetimeMs: 5000,
  });

  try {
    const res = await fetch("http://localhost:18002/audio.mp3");
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "audio/mpeg");
    assert.deepEqual(buf, TEST_AUDIO);
  } finally {
    await server.close();
  }
});

test("audio server returns 404 for unknown paths", async () => {
  const server = await startAudioServer({
    ngrokUrl: "https://test.ngrok.app",
    audioBuffer: TEST_AUDIO,
    port: 18003,
    lifetimeMs: 5000,
  });

  try {
    const res = await fetch("http://localhost:18003/unknown");
    assert.equal(res.status, 404);
  } finally {
    await server.close();
  }
});

test("audio server POST /gather resolves responsePromise with SpeechResult", async () => {
  const server = await startAudioServer({
    ngrokUrl: "https://test.ngrok.app",
    audioBuffer: TEST_AUDIO,
    port: 18004,
    lifetimeMs: 10000,
  });

  try {
    const body = new URLSearchParams({
      SpeechResult: "yes, go ahead and run the command",
      Confidence: "0.95",
    });

    const res = await fetch("http://localhost:18004/gather", {
      method: "POST",
      body: body.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });

    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes("<Hangup"));

    const response = await server.responsePromise;
    assert.equal(response, "yes, go ahead and run the command");
  } finally {
    await server.close();
  }
});

test("audio server POST /gather with no SpeechResult resolves null", async () => {
  const server = await startAudioServer({
    ngrokUrl: "https://test.ngrok.app",
    audioBuffer: TEST_AUDIO,
    port: 18005,
    lifetimeMs: 10000,
  });

  try {
    const body = new URLSearchParams({
      UnresolvedSpeech: "true",
    });

    const res = await fetch("http://localhost:18005/gather", {
      method: "POST",
      body: body.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });

    assert.equal(res.status, 200);

    const response = await server.responsePromise;
    assert.equal(response, null);
  } finally {
    await server.close();
  }
});

test("audio server closes cleanly", async () => {
  const server = await startAudioServer({
    ngrokUrl: "https://test.ngrok.app",
    audioBuffer: TEST_AUDIO,
    port: 18006,
    lifetimeMs: 5000,
  });

  await server.close();
  assert.equal(server.server.listening, false);
});

test("audio server twimlUrl uses ngrokUrl", async () => {
  const server = await startAudioServer({
    ngrokUrl: "https://my-ngrok.ngrok.app",
    audioBuffer: TEST_AUDIO,
    port: 18007,
    lifetimeMs: 5000,
  });

  try {
    assert.equal(server.twimlUrl, "https://my-ngrok.ngrok.app/twiml");
  } finally {
    await server.close();
  }
});