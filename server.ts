import express, { Request, Response } from "express";
import path from "path";
import { GoogleGenAI } from "@google/genai";
import { BUS_STOPS, BUS_LINES } from "./src/data/ybsData";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json({ limit: '10mb' })); // ensure bulk sync uploads fit

const PORT = 3000;

// Initialize Supabase Client dynamically
const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || "";
const supabase = (supabaseUrl && supabaseAnonKey) ? createClient(supabaseUrl, supabaseAnonKey) : null;

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
  if (!supabase) {
    res.status(400).json({ error: "Supabase client is not initialized. Please configure credentials." });
    return;
  }

  try {
    console.log("Starting full sync of local bus database to Supabase...");
    
    // Check if tables are missing
    const stats = await getTableStats();
    if (stats.status === "tables_missing") {
      res.status(400).json({
        error: "Database tables 'ybs_stops' and/or 'ybs_lines' do not exist in your Supabase schema yet. Please run the SQL schema first."
      });
      return;
    }

    // 1. Sync Stops: mapping keys from camelCase to snake_case
    const stopRows = BUS_STOPS.map(s => ({
      id: s.id,
      name: s.name,
      name_my: s.nameMy || s.name,
      lat: s.lat,
      lng: s.lng,
      lines: s.lines
    }));

    // Clear existing stops to avoid key collisions or outdated definitions
    await supabase.from('ybs_stops').delete().neq('id', '___non_existent_placeholder___');

    // Batch insert stops
    const stopChunks = chunkArray(stopRows, 200);
    for (let i = 0; i < stopChunks.length; i++) {
      const { error } = await supabase.from('ybs_stops').insert(stopChunks[i]);
      if (error) {
        throw new Error(`Stop insert chunk ${i} failed: ${error.message}`);
      }
    }

    // 2. Sync Lines: mapping keys from camelCase to snake_case
    const lineRows = BUS_LINES.map(l => ({
      id: l.id,
      name: l.name,
      operator: l.operator,
      start_stop: l.startStop,
      end_stop: l.endStop,
      stops: l.stops,
      fare: l.fare,
      operating_hours: l.operatingHours,
      color: l.color,
      coordinates: l.coordinates
    }));

    // Clear existing lines
    await supabase.from('ybs_lines').delete().neq('id', '___non_existent_placeholder___');

    // Batch insert lines
    const lineChunks = chunkArray(lineRows, 50);
    for (let i = 0; i < lineChunks.length; i++) {
      const { error } = await supabase.from('ybs_lines').insert(lineChunks[i]);
      if (error) {
        throw new Error(`Line insert chunk ${i} failed: ${error.message}`);
      }
    }

    res.json({
      success: true,
      message: `Database synchronized successfully! Seeded ${stopRows.length} stops and ${lineRows.length} bus lines.`
    });
  } catch (err: any) {
    console.error("Sync Error:", err);
    res.status(500).json({ error: err.message || "An error occurred during database migration." });
  }
});

// 3. Proxy endpoints that load from Supabase if connected, otherwise fallback to local dataset
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
        res.json({ source: "Supabase Cloud Database", count: mapped.length, data: mapped });
        return;
      }
    } catch (e) {
      console.error("Supabase load stops failed, falling back to local pre-bundled data:", e);
    }
  }
  res.json({ source: "Local Verified File Cache", count: BUS_STOPS.length, data: BUS_STOPS });
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
        res.json({ source: "Supabase Cloud Database", count: mapped.length, data: mapped });
        return;
      }
    } catch (e) {
      console.error("Supabase load lines failed, falling back to local pre-bundled data:", e);
    }
  }
  res.json({ source: "Local Verified File Cache", count: BUS_LINES.length, data: BUS_LINES });
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

    // Build rich transit-specific context
    const stopsContext = BUS_STOPS.map(s => `- ${s.name} (${s.nameMy}): connects ${s.lines.join(", ")}`).join("\n");
    const linesContext = BUS_LINES.map(l => `- ${l.name} (run by ${l.operator}): fares ${l.fare} MMK, hours: ${l.operatingHours}. Stops in order: ${l.stops.map(id => BUS_STOPS.find(s => s.id === id)?.name || id).join(" -> ")}`).join("\n");

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
