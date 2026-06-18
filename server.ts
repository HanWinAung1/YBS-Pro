import express, { Request, Response } from "express";
import path from "path";
import { GoogleGenAI } from "@google/genai";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json({ limit: '10mb' })); // ensure bulk sync uploads fit

const PORT = 3000;

// Initialize Supabase Client dynamically
const supabaseUrl = process.env.SUPABASE_URL || "https://kttfczzhzpqehjlsktmx.supabase.co";
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt0dGZjenpoenBxZWhqbHNrdG14Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5NzA5MjEsImV4cCI6MjA5NjU0NjkyMX0.ARIIgP3yD4fG_8AXJwwY7XuIA8j94_-5fUXSoaRAfT4";
const supabase = (supabaseUrl && supabaseAnonKey) ? createClient(supabaseUrl, supabaseAnonKey) : null;

// Dynamic In-Memory Cache
let cachedStops: any[] = [];
let cachedLines: any[] = [];

async function ensureCachedData() {
  if (supabase && (cachedStops.length === 0 || cachedLines.length === 0)) {
    try {
      console.log("Lazy hydrating local server cache from Supabase Cloud...");
      const { data: stopsData, error: stopsError } = await supabase.from('ybs_stops').select('*');
      const { data: linesData, error: linesError } = await supabase.from('ybs_lines').select('*');
      
      if (!stopsError && stopsData) {
        cachedStops = stopsData.map((d: any) => ({
          id: d.id,
          name: d.name,
          nameMy: d.name_my,
          lat: d.lat,
          lng: d.lng,
          lines: d.lines || []
        }));
      }
      if (!linesError && linesData) {
        cachedLines = linesData.map((d: any) => ({
          id: d.id,
          name: d.name,
          operator: d.operator,
          startStop: d.start_stop,
          endStop: d.end_stop,
          stops: d.stops || [],
          fare: d.fare || 400,
          operatingHours: d.operating_hours || "05:00 AM - 09:00 PM",
          color: d.color,
          coordinates: d.coordinates || []
        }));
      }
    } catch (e) {
      console.error("Failed to load and warm up dynamic Supabase records:", e);
    }
  }
}

// Helper to check if tables exist and count records
async function getTableStats() {
  if (!supabase) return { error: "Supabase not configured in .env" };
  try {
    const stopsQuery = await supabase.from('ybs_stops').select('id', { count: 'exact', head: true });
    const linesQuery = await supabase.from('ybs_lines').select('id', { count: 'exact', head: true });

    if (stopsQuery.error && (stopsQuery.error.code === '42P01' || stopsQuery.error.message?.includes('does not exist'))) {
      return { status: "tables_missing" };
    }
    if (linesQuery.error && (linesQuery.error.code === '42P01' || linesQuery.error.message?.includes('does not exist'))) {
      return { status: "tables_missing" };
    }

    if (stopsQuery.error) throw stopsQuery.error;
    if (linesQuery.error) throw linesQuery.error;

    return {
      status: "connected",
      stopsCount: stopsQuery.count || 0,
      linesCount: linesQuery.count || 0
    };
  } catch (err: any) {
    return {
      status: "connection_error",
      error: err.message || JSON.stringify(err)
    };
  }
}

// 1. Supabase Connection Status Endpoint
app.get("/api/supabase/status", async (req: Request, res: Response) => {
  if (!supabaseUrl || !supabaseAnonKey) {
    res.json({
      configured: false,
      status: "unconfigured",
      url: ""
    });
    return;
  }

  const dbStats = await getTableStats();
  res.json({
    configured: true,
    url: supabaseUrl,
    ...dbStats
  });
});

// Helper for batch chunking
const chunkArray = (arr: any[], size: number) => {
  return Array.from({ length: Math.ceil(arr.length / size) }, (v, i) =>
    arr.slice(i * size, i * size + size)
  );
};

// 2. Clear & Seed/Sync Local Data to Supabase Cloud Database (One-Click Setup)
app.post("/api/supabase/sync", async (req: Request, res: Response) => {
  res.json({
    success: true,
    message: "Static database files bypassed. Running in full Cloud Database mode powered by Supabase."
  });
});

// 3. Proxy endpoints that load from Supabase if connected
app.get("/api/stops", async (req: Request, res: Response) => {
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('ybs_stops')
        .select('*');
      
      if (!error && data && data.length > 0) {
        const mapped = data.map((d: any) => ({
          id: d.id,
          name: d.name,
          nameMy: d.name_my,
          lat: d.lat,
          lng: d.lng,
          lines: d.lines || []
        }));
        cachedStops = mapped;
        res.json({ source: "Supabase Cloud Database", count: mapped.length, data: mapped });
        return;
      }
    } catch (e) {
      console.error("Supabase load stops failed, falling back to local memory cache:", e);
    }
  }
  await ensureCachedData();
  res.json({ source: "Supabase Cache Store", count: cachedStops.length, data: cachedStops });
});

app.get("/api/lines", async (req: Request, res: Response) => {
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('ybs_lines')
        .select('*');
      
      if (!error && data && data.length > 0) {
        const mapped = data.map((d: any) => ({
          id: d.id,
          name: d.name,
          operator: d.operator,
          startStop: d.start_stop,
          endStop: d.end_stop,
          stops: d.stops || [],
          fare: d.fare || 400,
          operatingHours: d.operating_hours || "05:00 AM - 09:00 PM",
          color: d.color,
          coordinates: d.coordinates || []
        }));
        cachedLines = mapped;
        res.json({ source: "Supabase Cloud Database", count: mapped.length, data: mapped });
        return;
      }
    } catch (e) {
      console.error("Supabase load lines failed, falling back to local memory cache:", e);
    }
  }
  await ensureCachedData();
  res.json({ source: "Supabase Cache Store", count: cachedLines.length, data: cachedLines });
});

// Initialize Gemini Client

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    }
  }
});

// AI Transit Router Endpoint
app.post("/api/gemini", async (req: Request, res: Response) => {
  try {
    const { message, chatHistory } = req.body;
    if (!message) {
      res.status(400).json({ error: "Message is required." });
      return;
    }

    // Warm up dynamic cache if empty
    await ensureCachedData();

    // Build rich transit-specific context
    const stopsContext = cachedStops.map(s => `- ${s.name} (${s.nameMy}): connects ${s.lines.join(", ")}`).join("\n");
    const linesContext = cachedLines.map(l => `- ${l.name} (run by ${l.operator}): fares ${l.fare} MMK, hours: ${l.operatingHours}. Stops in order: ${l.stops.map((id: string) => cachedStops.find(s => s.id === id)?.name || id).join(" -> ")}`).join("\n");

    const systemInstruction = `You are "YBS Go Plus AI Assistant", an ultra-intelligent, friendly local Yangon transit expert.
You assist users with Yangon Bus Service (YBS) routing, scheduling, fare calculations, and navigation in Myanmar.

You MUST only provide route find recommendations based on the actual, verified bus directory context provided below.
Do not hallucinate fake bus lines or connections unless you state clearly it is an estimation.

VERIFIED YANGON BUS DIRECTORY DATA:

BUS LINES:
${linesContext}

BUS STOPS:
${stopsContext}

INSTRUCTIONS:
1. Speak in a helpful and conversational tone.
2. If the user asks in Myanmar (Burmese), answer in Myanmar (Burmese). If they ask in English, answer in English. You can mix both if appropriate.
3. Suggest the best bus lines, estimated stops, fares, and transfer advice based ONLY on the provided Bus Lines and Stops.
4. Keep answers clean, readable, and structured. Use bullet points.`;

    const contents = [
      ...(chatHistory || []).map((ch: any) => ({
        role: ch.role || "user",
        parts: [{ text: ch.text }]
      })),
      {
        role: "user",
        parts: [{ text: message }]
      }
    ];

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents,
      config: {
        systemInstruction,
        temperature: 0.7,
      },
    });

    res.json({ reply: response.text || "Sorry, I couldn't formulate a suggestion. Let me recalculate." });
  } catch (error: any) {
    console.error("Gemini API Error:", error);
    res.status(500).json({ error: error.message || "An AI routing error occurred." });
  }
});

// Vite Middleware registration / Static Assets serving
async function registerMiddleware() {
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*all', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`YBS Go Plus Server live on http://localhost:${PORT}`);
  });
}

registerMiddleware();
