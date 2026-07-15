import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Clapper Script Mode backend. Takes an email + extracted script text, runs a
// hardened breakdown through Groq (Llama 3.3 70B), stores the email as a lead,
// and returns a Clapper script pack the PWA imports directly. No API key ever
// touches the browser.

const ALLOWED_ORIGINS = [
  "https://kirtan-00.github.io",
  "http://localhost:5173",
  "http://localhost:4173",
];

function cors(origin: string | null): Record<string, string> {
  const allow = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
    "Vary": "Origin",
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_COVERAGE = ["WIDE", "MID", "CU", "OTS", "INSERT"];

const SYSTEM = [
  "You break a film/ad script into filmable SCENES for an on-set shot logger.",
  "A SCENE is one location+time setup (a slugline). Split the script into those.",
  "Return ONLY valid JSON, no prose, shape:",
  '{"scenes":[{"name":"SC n - INT/EXT. PLACE - TIME","summary":"one plain sentence","coverageTags":["WIDE","MID","CU","OTS","INSERT"],"keyMomentTags":["beat"]}]}',
  "RULES for keyMomentTags (the most important part):",
  "- Each must be a PHYSICAL, VISIBLE action or a spoken line that happens at ONE moment you could TAP on set.",
  "- Good: 'door slams', 'she raises voice', 'phone buzzes', 'walks into sunset', quote a distinctive line in quotes.",
  "- BANNED: abstract themes / emotions / summaries like 'belonging','emotional','friendship','nostalgia','introduction','conversation','narration'. Never output those.",
  "- Max 6 per scene. Keep each chip short (aim under 22 chars). Order them as they happen.",
  "coverageTags: pick the sensible subset of WIDE/MID/CU/OTS/INSERT for that scene (drop OTS from solo scenes, add INSERT only when there is an insert).",
].join("\n");

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const headers = { ...cors(origin), "Content-Type": "application/json" };

  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers });

  let payload: { email?: string; text?: string; docName?: string };
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Bad JSON" }), { status: 400, headers });
  }

  const email = (payload.email ?? "").trim().toLowerCase();
  const text = (payload.text ?? "").trim();
  const docName = (payload.docName ?? "").slice(0, 200);

  if (!EMAIL_RE.test(email)) return new Response(JSON.stringify({ error: "Enter a valid email" }), { status: 400, headers });
  if (text.length < 40) return new Response(JSON.stringify({ error: "Script text is too short or the PDF had no readable text" }), { status: 400, headers });

  const groqKey = Deno.env.get("GROQ_API_KEY");
  if (!groqKey) return new Response(JSON.stringify({ error: "Server not configured (GROQ_API_KEY missing)" }), { status: 500, headers });

  // Break down via Groq.
  let scenes: any[] = [];
  try {
    const gr = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${groqKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        temperature: 0.2,
        max_tokens: 3000,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: text.slice(0, 12000) },
        ],
      }),
    });
    if (!gr.ok) {
      const errTxt = await gr.text();
      return new Response(JSON.stringify({ error: "Breakdown service error", detail: errTxt.slice(0, 300) }), { status: 502, headers });
    }
    const gjson = await gr.json();
    const content = gjson.choices?.[0]?.message?.content ?? "{}";
    scenes = JSON.parse(content).scenes ?? [];
  } catch (e) {
    return new Response(JSON.stringify({ error: "Could not parse the breakdown", detail: String(e).slice(0, 200) }), { status: 502, headers });
  }

  // Normalize into a Clapper script pack.
  const packScenes = scenes.slice(0, 40).map((s: any, i: number) => ({
    scriptRef: `S${i + 1}`,
    name: typeof s.name === "string" && s.name.trim() ? s.name.trim() : `SC ${i + 1}`,
    summary: typeof s.summary === "string" ? s.summary.trim() : "",
    order: i + 1,
    coverageTags: Array.isArray(s.coverageTags) && s.coverageTags.length ? s.coverageTags.slice(0, 5) : DEFAULT_COVERAGE,
    keyMomentTags: Array.isArray(s.keyMomentTags) ? s.keyMomentTags.slice(0, 6).map((t: any) => String(t).slice(0, 40)) : [],
  }));

  const projectName = docName ? docName.replace(/\.pdf$/i, "") : "Imported script";
  const pack = { clapperScriptPack: 1, project: { name: projectName, coverageTags: DEFAULT_COVERAGE }, scenes: packScenes };

  // Store the lead (best-effort, never blocks the response).
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    await admin.from("leads").insert({
      email,
      scenes_count: packScenes.length,
      doc_name: docName || null,
      user_agent: (req.headers.get("user-agent") ?? "").slice(0, 300),
    });
  } catch (_) { /* lead capture is non-fatal */ }

  return new Response(JSON.stringify(pack), { headers });
});
