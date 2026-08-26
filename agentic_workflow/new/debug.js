/**
 * @file 90_Debug_Gemini.gs — TEMPORARY diagnostic; delete after the error is found.
 * @description
 *   Bisects a failing Gemini call into its four possible layers, cheapest first:
 *     1. Config  — project id / model / location, before any network happens
 *     2. Transport/auth — one tiny structured call (the exact path answerFromCorpus uses)
 *     3. Parsing — one tiny PLAIN call; if this succeeds where (2) returned null,
 *        the API is fine and the problem is JSON parsing inside GeminiLib
 *     4. Size    — the real digest-sized call, opt-in, once 2–3 look healthy
 *
 *   Run debugGeminiRoundtrip from the editor for layers 1–3 (two tiny calls, ~free).
 *   Run debugGeminiRoundtripWithDigest to add layer 4.
 *
 *   Note: this file deliberately reaches into svc.client — a seam violation that's fine
 *   in a throwaway diagnostic and nowhere else; GeminiService stays the only Gemini
 *   touchpoint in real code.
 */

function debugGeminiRoundtrip() { debugGeminiRoundtrip_(false); }
function debugGeminiRoundtripWithDigest() { debugGeminiRoundtrip_(true); }

function debugGeminiRoundtrip_(includeDigest) {
  const say = (label, value) => console.log(`[gemini-debug] ${label}: ${value}`);

  // 1 — config surface
  const v = AppConfig.get().VERTEX;
  say("project id", v.GOOGLE_CLOUD_PROJECT_ID ? `set (${v.GOOGLE_CLOUD_PROJECT_ID})` : "NOT SET — the constructor will throw");
  say("model @ location", `${v.MODEL_ID} @ ${v.LOCATION}`);

  let svc;
  try {
    svc = new GeminiService();
    say("client construction", "ok");
  } catch (e) {
    say("client construction THREW", (e && e.stack) || e);
    return;
  }

  // 2 — tiny structured call (same code path answerFromCorpus uses)
  try {
    const r = svc.client.generateStructured('Return ONLY valid JSON: {"ok": true}', {
      generationConfig: v.GENERATION_CONFIG
    });
    say("tiny generateStructured", r === null
      ? "returned NULL — the API replied but the lib could not parse it; the raw text is visible only inside GeminiLib"
      : `returned ${JSON.stringify(r)}`);
  } catch (e) {
    say("tiny generateStructured THREW", (e && e.stack) || e);
  }

  // 3 — tiny plain call (no JSON parsing involved)
  try {
    const r = svc.client.generateContent("Reply with the single word: pong", {
      generationConfig: v.GENERATION_CONFIG
    });
    say("tiny generateContent", `returned ${JSON.stringify(String(r).slice(0, 200))}`);
  } catch (e) {
    say("tiny generateContent THREW", (e && e.stack) || e);
  }

  // 4 — digest-sized call, opt-in
  if (includeDigest === true) {
    try {
      const digest = CorpusQaService.loadContext_();
      say("digest length", `${digest.length} chars`);
      const r = svc.answerFromCorpus(digest, "Which recipes exist in this estate?");
      say("digest-sized answerFromCorpus", r === null
        ? "returned NULL — parse failure inside the lib on the big reply"
        : `returned ${JSON.stringify(r).slice(0, 500)}…`);
    } catch (e) {
      say("digest-sized call THREW", (e && e.stack) || e);
    }
  } else {
    say("digest-sized call", "skipped — run debugGeminiRoundtripWithDigest once 2–3 look healthy");
  }
}
