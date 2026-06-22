<script setup lang="ts">
import { ref, onMounted, computed, watch, nextTick } from 'vue';
import { 
  BusFront, MapPin, Search, Navigation2, MessageSquare, Info, 
  Database, RefreshCw, Bookmark, BookmarkCheck, ArrowRightLeft, 
  Map as MapIcon, ChevronRight, Sparkles, Send, Trash2, Clock, Landmark, Check,
  Edit, Tag, X, Compass, Crosshair
} from 'lucide-vue-next';
import { createClient } from '@supabase/supabase-js';
import { BusLine, BusStop, UserBookmark, RoutingResult } from './types';
import { findRoutes } from './utils/routing';

// Reactive YBS Cloud Database State
const BUS_STOPS = ref<BusStop[]>([]);
const BUS_LINES = ref<BusLine[]>([]);

// UI State
const currentTab = ref<'planner' | 'lines' | 'stops' | 'assistant'>('planner');
const activeRouteIndex = ref<number | null>(null);
const searchQuery = ref('');
const selectedLineId = ref<string | null>(null);
const selectedStopId = ref<string | null>(null);

// Route Finder form
const startStop = ref('');
const endStop = ref('');
const computedRoutes = ref<RoutingResult[]>([]);
const searchAttempted = ref(false);
const routeSortBy = ref<'fastest' | 'cheapest' | 'direct'>('fastest');

const sortedRoutes = computed(() => {
  if (!computedRoutes.value) return [];
  const routes = [...computedRoutes.value];
  if (routeSortBy.value === 'fastest') {
    return routes.sort((a, b) => a.totalDuration - b.totalDuration);
  } else if (routeSortBy.value === 'cheapest') {
    return routes.sort((a, b) => a.totalFare - b.totalFare);
  } else if (routeSortBy.value === 'direct') {
    return routes.sort((a, b) => {
      if (a.type === 'direct' && b.type !== 'direct') return -1;
      if (a.type !== 'direct' && b.type === 'direct') return 1;
      return a.totalDuration - b.totalDuration;
    });
  }
  return routes;
});

const sortedStops = computed(() => {
  return [...BUS_STOPS.value].sort((a, b) => a.name.localeCompare(b.name));
});

const selectedStopObject = computed(() => {
  if (!selectedStopId.value) return null;
  return BUS_STOPS.value.find(s => s.id === selectedStopId.value) || null;
});

const filteredStops = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();
  if (!query) return BUS_STOPS.value;
  return BUS_STOPS.value.filter(s => 
    (s.name || '').toLowerCase().includes(query) || 
    (s.nameMy || '').includes(query)
  );
});

const startSearchQuery = ref('');
const endSearchQuery = ref('');
const isStartDropdownOpen = ref(false);
const isEndDropdownOpen = ref(false);

const closeStartDropdown = () => {
  setTimeout(() => {
    isStartDropdownOpen.value = false;
  }, 250);
};

const closeEndDropdown = () => {
  setTimeout(() => {
    isEndDropdownOpen.value = false;
  }, 250);
};

const selectStartStop = (stop: BusStop) => {
  startStop.value = stop.id;
  startSearchQuery.value = stop.name;
  isStartDropdownOpen.value = false;
};

const selectEndStop = (stop: BusStop) => {
  endStop.value = stop.id;
  endSearchQuery.value = stop.name;
  isEndDropdownOpen.value = false;
};

const clearStartStop = () => {
  startStop.value = '';
  startSearchQuery.value = '';
};

const clearEndStop = () => {
  endStop.value = '';
  endSearchQuery.value = '';
};

const startStopSuggestions = computed(() => {
  const query = startSearchQuery.value.toLowerCase().trim();
  if (!query) {
    return sortedStops.value.slice(0, 40);
  }
  return sortedStops.value.filter(s => 
    s.name.toLowerCase().includes(query) ||
    s.id.toLowerCase().includes(query) ||
    s.nameMy.toLowerCase().includes(query)
  ).slice(0, 40);
});

const endStopSuggestions = computed(() => {
  const query = endSearchQuery.value.toLowerCase().trim();
  if (!query) {
    return sortedStops.value.slice(0, 40);
  }
  return sortedStops.value.filter(s => 
    s.name.toLowerCase().includes(query) ||
    s.id.toLowerCase().includes(query) ||
    s.nameMy.toLowerCase().includes(query)
  ).slice(0, 40);
});

watch(startStop, (newVal) => {
  if (newVal) {
    const stop = BUS_STOPS.value.find(s => s.id === newVal);
    if (stop) {
      startSearchQuery.value = stop.name;
    }
  } else {
    if (startSearchQuery.value && BUS_STOPS.value.some(s => s.name === startSearchQuery.value)) {
      startSearchQuery.value = '';
    }
  }
}, { immediate: true });

watch(endStop, (newVal) => {
  if (newVal) {
    const stop = BUS_STOPS.value.find(s => s.id === newVal);
    if (stop) {
      endSearchQuery.value = stop.name;
    }
  } else {
    if (endSearchQuery.value && BUS_STOPS.value.some(s => s.name === endSearchQuery.value)) {
      endSearchQuery.value = '';
    }
  }
}, { immediate: true });

watch(routeSortBy, () => {
  if (sortedRoutes.value.length > 0) {
    selectRoute(0);
  }
});

// Local persistence state
const bookmarks = ref<UserBookmark[]>([]);

const editingBookmarkId = ref<string | null>(null);
const editingBookmarkLabel = ref('');
const editingBookmarkNotes = ref('');

// AI assistant state
const assistantMessages = ref<{ role: 'user' | 'assistant'; text: string }[]>([
  { 
    role: 'assistant', 
    text: 'Mingalabar! ဆူးလေကနေ လှည်းတန်းကို ဘယ်လိုသွားရမလဲ? I am your AI YBS route expert. Tell me where you are and where you want to go in Yangon, and I will recommend the perfect bus itinerary!' 
  }
]);
const userMessage = ref('');
const isAILoading = ref(false);
const chatContainer = ref<HTMLElement | null>(null);

// Map instances
let map: any = null;
let stopsLayerGroup: any = null;
let pathLayerGroup: any = null;
let vehiclesLayerGroup: any = null;
let currentL: any = null;

// Load bookmarks
const loadBookmarks = () => {
  const saved = localStorage.getItem('YBS_BOOKMARKS');
  if (saved) {
    try {
      bookmarks.value = JSON.parse(saved);
    } catch (e) {
      bookmarks.value = [];
    }
  }
};

const saveBookmarks = () => {
  localStorage.setItem('YBS_BOOKMARKS', JSON.stringify(bookmarks.value));
};

const toggleBookmark = (type: 'line' | 'stop' | 'route', itemId: string, title: string) => {
  const index = bookmarks.value.findIndex(b => b.type === type && b.itemId === itemId);
  if (index !== -1) {
    bookmarks.value.splice(index, 1);
  } else {
    bookmarks.value.push({
      id: `${type}-${itemId}-${Date.now()}`,
      type,
      itemId,
      title,
      createdAt: new Date().toISOString()
    });
  }
  saveBookmarks();
};

const startEditBookmark = (bookmark: UserBookmark) => {
  editingBookmarkId.value = bookmark.id;
  editingBookmarkLabel.value = bookmark.customLabel || '';
  editingBookmarkNotes.value = bookmark.notes || '';
};

const cancelEditBookmark = () => {
  editingBookmarkId.value = null;
  editingBookmarkLabel.value = '';
  editingBookmarkNotes.value = '';
};

const submitEditBookmark = () => {
  if (!editingBookmarkId.value) return;
  const index = bookmarks.value.findIndex(b => b.id === editingBookmarkId.value);
  if (index !== -1) {
    bookmarks.value[index].customLabel = editingBookmarkLabel.value.trim() || undefined;
    bookmarks.value[index].notes = editingBookmarkNotes.value.trim() || undefined;
    saveBookmarks();
    cancelEditBookmark();
  }
};

const isBookmarked = (type: 'line' | 'stop' | 'route', itemId: string) => {
  return bookmarks.value.some(b => b.type === type && b.itemId === itemId);
};

// Initialize Map
const initMap = async () => {
  try {
    const L = await import('leaflet');
    currentL = L;
    
    if (map) return; // already initialized
    
    const container = document.getElementById('leaflet-map-element');
    if (!container) return;
    
    map = L.map(container, {
      zoomControl: false
    }).setView([16.82, 96.15], 12); // Center of Yangon
    
    L.control.zoom({
      position: 'bottomright'
    }).addTo(map);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '© OpenStreetMap Map contributors'
    }).addTo(map);

    stopsLayerGroup = L.layerGroup().addTo(map);
    pathLayerGroup = L.layerGroup().addTo(map);

    renderStopsOnMap();

    // Re-render stops dynamically on pan/zoom so we only render visible markers
    map.on('moveend zoomend', () => {
      renderStopsOnMap();
    });
  } catch (error) {
    console.error("Leaflet map initialization error:", error);
  }
};

const renderStopsOnMap = () => {
  if (!map || !stopsLayerGroup || !currentL) return;

  stopsLayerGroup.clearLayers();

  const bounds = map.getBounds();
  const zoom = map.getZoom();
  
  // Only render all stops if zoomed in (>= 13), otherwise only show active or selected stops
  const showAllStopsAtZoom = zoom >= 13;

  const routeStops = activeRouteStops.value;
  const lineStops = activeLineStops.value;
  const isShowingRouteOrLine = routeStops !== null || lineStops !== null;

  BUS_STOPS.value.forEach(stop => {
    const lat = typeof stop.lat === 'number' ? stop.lat : parseFloat(stop.lat as any);
    const lng = typeof stop.lng === 'number' ? stop.lng : parseFloat(stop.lng as any);
    if (isNaN(lat) || !isFinite(lat) || isNaN(lng) || !isFinite(lng)) return;

    // High-performance boundary culling: Only render stop if it is inside map viewport bounds
    const isInsideViewport = bounds && bounds.contains([lat, lng]);
    if (!isInsideViewport) return;

    // When showing/highlighting routes or lines, hide other stops entirely to declutter the map
    if (isShowingRouteOrLine) {
      const isRelevant = (routeStops && routeStops.has(stop.id)) || (lineStops && lineStops.has(stop.id));
      if (!isRelevant) return;
    } else {
      // Zoom-level filtering
      if (!showAllStopsAtZoom) {
        const isSelected = selectedStopId.value === stop.id;
        if (!isSelected) return;
      }
    }

    const circle = currentL.circleMarker([lat, lng], {
      radius: 6,
      fillColor: '#0ea5e9', // Tailwind sky-500
      color: '#ffffff',
      weight: 1.5,
      opacity: 1,
      fillOpacity: 0.9
    });

    circle.bindPopup(`
      <div class="p-1 text-slate-800 text-left">
        <h3 class="font-bold font-sans text-xs">${stop.name}</h3>
        <p class="text-[11px] text-teal-600 font-semibold my-0.5">${stop.nameMy}</p>
        <div class="text-[9px] text-slate-400 mt-1">
          Provides access to ${stop.lines.length} YBS lines
        </div>
      </div>
    `);

    circle.on('click', () => {
      selectedStopId.value = stop.id;
    });

    circle.addTo(stopsLayerGroup);
  });
};

const renderVehiclesOnMap = () => {
  // Focus purely on static transit route networks and lines directories
};

const highlightRouteOnMap = (coordinates: any, color: string, stopIdsToHighlight?: string[]) => {
  if (!map || !pathLayerGroup || !currentL) return;

  pathLayerGroup.clearLayers();

  let coordsToUse: [number, number][] = [];
  let parsed = coordinates;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch (e) {
      parsed = [];
    }
  }

  if (Array.isArray(parsed)) {
    parsed.forEach(c => {
      if (Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number') {
        coordsToUse.push([c[0], c[1]]);
      }
    });
  }

  if (coordsToUse.length === 0) return;

  // Draw dark/black casing/shadow underneath for crisp outline contrast
  currentL.polyline(coordsToUse, {
    color: '#0f172a',
    weight: 10,
    opacity: 0.8
  }).addTo(pathLayerGroup);

  // Draw actual vibrant solid high-contrast Route Polyline
  const routeLine = currentL.polyline(coordsToUse, {
    color,
    weight: 6,
    opacity: 1
  }).addTo(pathLayerGroup);

  // Fit view to route
  try {
    const bounds = routeLine.getBounds();
    if (bounds && bounds.isValid && bounds.isValid()) {
      map.fitBounds(bounds, { padding: [40, 40] });
    }
  } catch (e) {
    console.warn("Could not fit map bounds:", e);
  }

  // Add customized route step dot overlay markers
  coordsToUse.forEach((coord, idx) => {
    currentL.circleMarker(coord, {
      radius: 4,
      fillColor: '#ffffff',
      color: color,
      weight: 1.5,
      opacity: 1,
      fillOpacity: 1
    }).addTo(pathLayerGroup);
  });
};

// Route Finder
const handleSearchRoute = () => {
  if (!startStop.value || !endStop.value) return;
  
  computedRoutes.value = findRoutes(startStop.value, endStop.value, BUS_STOPS.value, BUS_LINES.value);
  activeRouteIndex.value = sortedRoutes.value.length > 0 ? 0 : null;
  searchAttempted.value = true;
  
  if (sortedRoutes.value.length > 0) {
    selectRoute(0);
  }
};

const selectRoute = (index: number) => {
  activeRouteIndex.value = index;
  const route = sortedRoutes.value[index];
  if (!route || !map || !currentL) return;

  // Gather coordinates from the bus stops listed in steps in order
  const coords: [number, number][] = [];
  let routeColor = '#3b82f6';

  route.steps.forEach(step => {
    if (step.lineId) {
      const lineDetails = BUS_LINES.value.find(l => l.id === step.lineId);
      if (lineDetails) {
        routeColor = lineDetails.color || routeColor;
        // Collect coordinates of stops on this line between steps if possible
        let lineCoords = lineDetails.coordinates;
        if (typeof lineCoords === 'string') {
          try {
            lineCoords = JSON.parse(lineCoords);
          } catch (e) {
            lineCoords = [];
          }
        }
        if (Array.isArray(lineCoords)) {
          lineCoords.forEach(coord => {
            if (Array.isArray(coord) && typeof coord[0] === 'number' && typeof coord[1] === 'number') {
              coords.push([coord[0], coord[1]]);
            }
          });
        }
      }
    }
  });

  if (coords.length > 0) {
    highlightRouteOnMap(coords, routeColor);
  }
};

const handleSelectLine = (lineId: string) => {
  selectedLineId.value = lineId;
  const line = BUS_LINES.value.find(l => l.id === lineId);
  if (line && map) {
    highlightRouteOnMap(line.coordinates, line.color);
  }
};

const handleSelectStop = (stopId: string) => {
  selectedStopId.value = stopId;
  const stop = BUS_STOPS.value.find(s => s.id === stopId);
  if (stop && map) {
    map.setView([stop.lat, stop.lng], 15);
  }
};

const buildOptimizedTransitContext = (text: string) => {
  const query = text.toLowerCase();
  
  // 1. Identify which lines or stops are explicitly named or implied
  const relevantLines = BUS_LINES.value.filter(l => {
    const term = l.name.toLowerCase();
    return query.includes(term) || (l.operator && query.includes(l.operator.toLowerCase()));
  });

  const relevantStops = BUS_STOPS.value.filter(s => {
    return query.includes(s.name.toLowerCase()) || (s.nameMy && query.includes(s.nameMy.toLowerCase()));
  });

  // Find lines connected to any relevant stops
  const extraLineNamesOrIds = new Set<string>();
  relevantStops.forEach(s => {
    if (s.lines) {
      s.lines.forEach(lineName => extraLineNamesOrIds.add(lineName.toLowerCase()));
    }
  });

  // Decide if we should show the full stop itinerary for each bus line
  // Prioritize manually referenced lines, lines passing through named stops, or basic samples.
  const linesToDetail = new Set<string>();
  relevantLines.forEach(l => linesToDetail.add(l.id));
  
  BUS_LINES.value.forEach(l => {
    if (extraLineNamesOrIds.has(l.name.toLowerCase()) || extraLineNamesOrIds.has(l.id.toLowerCase())) {
      linesToDetail.add(l.id);
    }
  });

  // If no lines matched, default to detailing the first 4 lines around the network as helpful reference context
  const sampleLimit = Math.min(4, BUS_LINES.value.length);
  for (let i = 0; i < sampleLimit; i++) {
    if (linesToDetail.size < 4) {
      linesToDetail.add(BUS_LINES.value[i].id);
    }
  }

  // Generate lines context
  const linesContext = BUS_LINES.value.map(l => {
    const isFullDetail = linesToDetail.has(l.id);
    const stopNames = l.stops.map((id: string) => BUS_STOPS.value.find(s => s.id === id)?.name || id);
    
    let stopsDescription = "";
    if (isFullDetail && stopNames.length > 0) {
      stopsDescription = stopNames.join(" -> ");
    } else if (stopNames.length > 0) {
      // Condensed itinerary showing start, midpoints, and end to save massive tokens
      const first = stopNames[0];
      const last = stopNames[stopNames.length - 1];
      if (stopNames.length > 3) {
        const mid1 = stopNames[Math.floor(stopNames.length / 3)];
        const mid2 = stopNames[Math.floor((stopNames.length * 2) / 3)];
        stopsDescription = `${first} -> ${mid1} -> ${mid2} -> ${last} [${stopNames.length} stops total]`;
      } else {
        stopsDescription = stopNames.join(" -> ");
      }
    } else {
      stopsDescription = `${l.startStop || 'Start'} -> ${l.endStop || 'End'}`;
    }

    return `- YBS ${l.name} (${l.operator || 'YUPT'}): fare ${l.fare || 400} MMK, hours: ${l.operatingHours || '05:00 AM - 09:00 PM'}. Route stops sequence: ${stopsDescription}`;
  }).join("\n");

  // Keep stops context minimal to save token overhead: Only list interchanges/hubs (connecting 2+ lines) or queried stops
  const filteredStops = BUS_STOPS.value.filter(s => {
    const isHub = s.lines && s.lines.length >= 2;
    const isRelevant = relevantStops.some(rs => rs.id === s.id);
    return isHub || isRelevant;
  });

  const stopsContext = filteredStops.slice(0, 45).map(s => 
    `- Stop: ${s.name} (${s.nameMy || ''}) connects: ${s.lines ? s.lines.join(", ") : ''}`
  ).join("\n");

  return { linesContext, stopsContext };
};

const performClientSideGeminiCall = async (text: string, chatHistory: any[]) => {
  const apiKey = clientGeminiApiKey.value.trim();
  if (!apiKey) {
    throw new Error("No Gemini API key is configured. Since this app is running in client-only mode (e.g. static host like Vercel), you must provide your own Gemini API key inside the configuration panel (Database icon at the top) to fetch direct AI recommendations.");
  }

  // Build the optimized, compressed context
  const { linesContext, stopsContext } = buildOptimizedTransitContext(text);

  const systemInstructionText = `You are "YBS Go Plus AI Assistant", an ultra-intelligent, friendly local Yangon transit expert.
You assist users with Yangon Bus Service (YBS) routing, scheduling, fare calculations, and navigation in Myanmar.

You MUST only provide route find recommendations based on the actual, verified bus directory context provided below.
Do not hallucinate fake bus lines or connections unless you state clearly it is an estimation.

VERIFIED YANGON BUS DIRECTORY DATA:

BUS LINES:
${linesContext}

BUS STOPS (MAIN INTERCHANGES & HUBS):
${stopsContext}

INSTRUCTIONS:
1. Speak in a helpful and conversational tone.
2. If the user asks in Myanmar (Burmese), answer in Myanmar (Burmese). If they ask in English, answer in English. You can mix both if appropriate.
3. Suggest the best bus lines, estimated stops, fares, and transfer advice based ONLY on the provided Bus Lines and Stops.
4. Keep answers clean, readable, and structured. Use bullet points.`;

  const mappedContents = chatHistory.map((ch: any) => ({
    role: ch.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: ch.text }]
  }));
  mappedContents.push({
    role: 'user',
    parts: [{ text: text }]
  });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      contents: mappedContents,
      systemInstruction: {
        parts: [{ text: systemInstructionText }]
      },
      generationConfig: {
        temperature: 0.7
      }
    })
  });

  if (!response.ok) {
    const errorJson = await response.json().catch(() => ({}));
    const extError = errorJson?.error?.message || response.statusText;
    throw new Error(`Google Gemini direct API error: ${extError}`);
  }

  const result = await response.json();
  const textReply = result?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!textReply) {
    throw new Error("Unable to extract reply text from Gemini direct response layout.");
  }
  return textReply;
};

const performClientSideGroqCall = async (text: string, chatHistory: any[]) => {
  const apiKey = clientGroqApiKey.value.trim();
  if (!apiKey) {
    throw new Error("No Groq API key is configured. Since this app is running in client-only mode (e.g. static host like Vercel), you must provide your own Groq API key inside the configuration panel (Database icon at the top) to fetch direct AI recommendations.");
  }

  // Build the optimized, compressed context
  const { linesContext, stopsContext } = buildOptimizedTransitContext(text);

  const systemInstructionText = `You are "YBS Go Plus AI Assistant", an ultra-intelligent, friendly local Yangon transit expert running on Groq (using Llama 3.3).
You assist users with Yangon Bus Service (YBS) routing, scheduling, fare calculations, and navigation in Myanmar.

You MUST only provide route find recommendations based on the actual, verified bus directory context provided below.
Do not hallucinate fake bus lines or connections unless you state clearly it is an estimation.

VERIFIED YANGON BUS DIRECTORY DATA:

BUS LINES:
${linesContext}

BUS STOPS (MAIN INTERCHANGES & HUBS):
${stopsContext}

INSTRUCTIONS:
1. Speak in a helpful and conversational tone.
2. If the user asks in Myanmar (Burmese), answer in Myanmar (Burmese). If they ask in English, answer in English. You can mix both if appropriate.
3. Suggest the best bus lines, estimated stops, fares, and transfer advice based ONLY on the provided Bus Lines and Stops.
4. Keep answers clean, readable, and structured. Use bullet points.`;

  const messages = [
    { role: 'system', content: systemInstructionText }
  ];

  chatHistory.forEach((ch: any) => {
    messages.push({
      role: ch.role === 'assistant' ? 'assistant' : 'user',
      content: ch.text
    });
  });

  messages.push({
    role: 'user',
    content: text
  });

  const url = 'https://api.groq.com/openai/v1/chat/completions';

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages,
      temperature: 0.7
    })
  });

  if (!response.ok) {
    const errorJson = await response.json().catch(() => ({}));
    const extError = errorJson?.error?.message || response.statusText;
    throw new Error(`Groq direct API error: ${extError}`);
  }

  const result = await response.json();
  const textReply = result?.choices?.[0]?.message?.content;
  if (!textReply) {
    throw new Error("Unable to extract reply text from Groq direct response layout.");
  }
  return textReply;
};

const performClientSideOpenRouterCall = async (text: string, chatHistory: any[]) => {
  const apiKey = clientOpenRouterApiKey.value.trim();
  if (!apiKey) {
    throw new Error("No OpenRouter API key is configured. Since this app is running in client-only mode (e.g. static host like Vercel), you must provide your own OpenRouter API key inside the configuration panel (Database icon at the top) to fetch direct AI recommendations.");
  }

  // Build the optimized, compressed context
  const { linesContext, stopsContext } = buildOptimizedTransitContext(text);

  const systemInstructionText = `You are "YBS Go Plus AI Assistant", an ultra-intelligent, friendly local Yangon transit expert running on OpenRouter.
You assist users with Yangon Bus Service (YBS) routing, scheduling, fare calculations, and navigation in Myanmar.

You MUST only provide route find recommendations based on the actual, verified bus directory context provided below.
Do not hallucinate fake bus lines or connections unless you state clearly it is an estimation.

VERIFIED YANGON BUS DIRECTORY DATA:

BUS LINES:
${linesContext}

BUS STOPS (MAIN INTERCHANGES & HUBS):
${stopsContext}

INSTRUCTIONS:
1. Speak in a helpful and conversational tone.
2. If the user asks in Myanmar (Burmese), answer in Myanmar (Burmese). If they ask in English, answer in English. You can mix both if appropriate.
3. Suggest the best bus lines, estimated stops, fares, and transfer advice based ONLY on the provided Bus Lines and Stops.
4. Keep answers clean, readable, and structured. Use bullet points.`;

  const messages = [
    { role: 'system', content: systemInstructionText }
  ];

  chatHistory.forEach((ch: any) => {
    messages.push({
      role: ch.role === 'assistant' ? 'assistant' : 'user',
      content: ch.text
    });
  });

  messages.push({
    role: 'user',
    content: text
  });

  const url = 'https://openrouter.ai/api/v1/chat/completions';

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': window.location.origin,
      'X-Title': 'YBS Go Plus'
    },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash:free",
      messages,
      temperature: 0.7
    })
  });

  if (!response.ok) {
    const errorJson = await response.json().catch(() => ({}));
    const extError = errorJson?.error?.message || response.statusText;
    throw new Error(`OpenRouter direct API error: ${extError}`);
  }

  const result = await response.json();
  const textReply = result?.choices?.[0]?.message?.content;
  if (!textReply) {
    throw new Error("Unable to extract reply text from OpenRouter response layout.");
  }
  return textReply;
};

const performClientSideOpenAICall = async (text: string, chatHistory: any[]) => {
  const apiKey = clientOpenaiApiKey.value.trim();
  if (!apiKey) {
    throw new Error("No OpenAI API key is configured. Since this app is running in client-only mode (e.g. static host like Vercel), you must provide your own OpenAI API key inside the configuration panel (Database icon at the top) to fetch direct AI recommendations.");
  }

  // Build the optimized, compressed context
  const { linesContext, stopsContext } = buildOptimizedTransitContext(text);

  const systemInstructionText = `You are "YBS Go Plus AI Assistant", an ultra-intelligent, friendly local Yangon transit expert running on OpenAI.
You assist users with Yangon Bus Service (YBS) routing, scheduling, fare calculations, and navigation in Myanmar.

You MUST only provide route find recommendations based on the actual, verified bus directory context provided below.
Do not hallucinate fake bus lines or connections unless you state clearly it is an estimation.

VERIFIED YANGON BUS DIRECTORY DATA:

BUS LINES:
${linesContext}

BUS STOPS (MAIN INTERCHANGES & HUBS):
${stopsContext}

INSTRUCTIONS:
1. Speak in a helpful and conversational tone.
2. If the user asks in Myanmar (Burmese), answer in Myanmar (Burmese). If they ask in English, answer in English. You can mix both if appropriate.
3. Suggest the best bus lines, estimated stops, fares, and transfer advice based ONLY on the provided Bus Lines and Stops.
4. Keep answers clean, readable, and structured. Use bullet points.`;

  const messages = [
    { role: 'system', content: systemInstructionText }
  ];

  chatHistory.forEach((ch: any) => {
    messages.push({
      role: ch.role === 'assistant' ? 'assistant' : 'user',
      content: ch.text
    });
  });

  messages.push({
    role: 'user',
    content: text
  });

  const url = 'https://api.openai.com/v1/chat/completions';

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.7
    })
  });

  if (!response.ok) {
    const errorJson = await response.json().catch(() => ({}));
    const extError = errorJson?.error?.message || response.statusText;
    throw new Error(`OpenAI direct API error: ${extError}`);
  }

  const result = await response.json();
  const textReply = result?.choices?.[0]?.message?.content;
  if (!textReply) {
    throw new Error("Unable to extract reply text from OpenAI direct response layout.");
  }
  return textReply;
};

// AI assistant sendMessage proxy
const handleSendAIMessage = async () => {
  if (!userMessage.value.trim() || isAILoading.value) return;

  const text = userMessage.value;
  assistantMessages.value.push({ role: 'user', text });
  userMessage.value = '';
  isAILoading.value = true;

  // Scroll chat UI
  await nextTick();
  if (chatContainer.value) {
    chatContainer.value.scrollTop = chatContainer.value.scrollHeight;
  }

  try {
    const chatHistory = assistantMessages.value.slice(0, -1);
    let replyText = '';
    let usedDirectFallback = false;
    let providerLabel = '';

    if (clientAiProvider.value === 'groq') {
      usedDirectFallback = true;
      providerLabel = "Groq (Llama 3.3)";
      replyText = await performClientSideGroqCall(text, chatHistory);
    } else if (clientAiProvider.value === 'openrouter') {
      usedDirectFallback = true;
      providerLabel = "OpenRouter (Gemini Free)";
      replyText = await performClientSideOpenRouterCall(text, chatHistory);
    } else if (clientAiProvider.value === 'openai') {
      usedDirectFallback = true;
      providerLabel = "OpenAI (GPT-4o-mini)";
      replyText = await performClientSideOpenAICall(text, chatHistory);
    } else if (clientAiProvider.value === 'gemini' && clientGeminiApiKey.value.trim()) {
      usedDirectFallback = true;
      providerLabel = "Gemini Direct";
      replyText = await performClientSideGeminiCall(text, chatHistory);
    } else {
      try {
        const response = await fetch('/api/gemini', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-gemini-key': clientGeminiApiKey.value
          },
          body: JSON.stringify({
            message: text,
            chatHistory
          })
        });

        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("text/html") || !response.ok && response.status === 404) {
          throw new Error("HTML_CONTENT_OR_404_DETECTED");
        }

        const data = await response.json();
        if (response.ok) {
          replyText = data.reply;
        } else {
          throw new Error(data.error || "Server endpoint returned error state.");
        }
      } catch (routeError: any) {
        if (
          routeError.message === "HTML_CONTENT_OR_404_DETECTED" || 
          routeError.message.includes("is not valid JSON") || 
          routeError.message.includes("Unexpected token") ||
          routeError.name === "SyntaxError"
        ) {
          console.warn("Express backend endpoint unaccessible or returning HTML. Switching to client fallback system...");
          usedDirectFallback = true;
          providerLabel = "Gemini Fallback";
          replyText = await performClientSideGeminiCall(text, chatHistory);
        } else {
          throw routeError;
        }
      }
    }

    assistantMessages.value.push({ 
      role: 'assistant', 
      text: replyText + (usedDirectFallback ? `\n\n*(Sent via Direct-to-${providerLabel} Client Fallback Mode)*` : '')
    });
  } catch (error: any) {
    assistantMessages.value.push({ 
      role: 'assistant', 
      text: `Sorry, there was an AI routing error. If this app is deployed as a static page (e.g. Vercel), make sure you've added your active API key in the Database Config modal (top header). \n\nDetails: ${error.message}` 
    });
  } finally {
    isAILoading.value = false;
    await nextTick();
    if (chatContainer.value) {
      chatContainer.value.scrollTop = chatContainer.value.scrollHeight;
    }
  }
};

const handleQuickAsk = (question: string) => {
  userMessage.value = question;
  handleSendAIMessage();
};

const clearChat = () => {
  assistantMessages.value = [
    { 
      role: 'assistant', 
      text: 'Messages cleared. How else can I guide your Yangon travels today?' 
    }
  ];
};

const reverseRouteFinder = () => {
  const temp = startStop.value;
  startStop.value = endStop.value;
  endStop.value = temp;
  if (startStop.value && endStop.value) {
    handleSearchRoute();
  }
};

const getStopLinesDisplay = (stop: any) => {
  if (!stop || !stop.lines) return '';
  return stop.lines.map((lineId: string) => {
    const matches = lineId.match(/^ybs-(\d+[a-zA-Z]*)/i);
    if (matches && matches[1]) {
      return matches[1].toUpperCase();
    }
    return lineId.replace(/^ybs-/i, '').replace(/-/g, ' ').toUpperCase();
  }).slice(0, 4).join(', ') + (stop.lines.length > 4 ? '...' : '');
};

// Computed statistics
const busOperatorsCount = computed(() => {
  const operators = new Set(BUS_LINES.value.map(b => b.operator));
  return operators.size;
});

// Watch tabs to redraw Leaflet if required
watch(currentTab, (newTab) => {
  if (newTab === 'planner' || newTab === 'lines' || newTab === 'stops') {
    nextTick(() => {
      initMap();
      if (map) {
        map.invalidateSize();
      }
    });
  }
});

// Watch selections to refresh stop rendering on map
watch(selectedLineId, () => {
  renderStopsOnMap();
});

watch(selectedStopId, () => {
  renderStopsOnMap();
});

watch(activeRouteIndex, () => {
  renderStopsOnMap();
});

const activeRouteStops = computed(() => {
  if (activeRouteIndex.value === null || !sortedRoutes.value || sortedRoutes.value.length === 0) return null;
  const route = sortedRoutes.value[activeRouteIndex.value];
  if (!route) return null;
  
  const stopIds = new Set<string>();
  route.steps.forEach(step => {
    if (step.stopId) {
      stopIds.add(step.stopId);
    }
    if (step.lineId) {
      const lineObj = BUS_LINES.value.find(l => l.id === step.lineId);
      if (lineObj) {
        lineObj.stops.forEach(sId => stopIds.add(sId));
      }
    }
  });
  return stopIds;
});

const activeLineStops = computed(() => {
  if (!selectedLineId.value) return null;
  const lineObj = BUS_LINES.value.find(l => l.id === selectedLineId.value);
  if (!lineObj) return null;
  return new Set(lineObj.stops);
});

// Watch Selected Stops to highlight connected lines
const stopConnectedLines = computed(() => {
  if (!selectedStopId.value) return [];
  return BUS_LINES.value.filter(line => line.stops.includes(selectedStopId.value!));
});

const handleBookmarkClick = (bookmark: UserBookmark) => {
  if (bookmark.type === 'stop') {
    selectedStopId.value = bookmark.itemId;
    currentTab.value = 'stops';
    
    const stopObj = BUS_STOPS.value.find(s => s.id === bookmark.itemId);
    if (stopObj && map) {
      map.setView([stopObj.lat, stopObj.lng], 14);
      renderStopsOnMap();
    }
  } else if (bookmark.type === 'line') {
    selectedLineId.value = bookmark.itemId;
    currentTab.value = 'lines';
    
    const lineObj = BUS_LINES.value.find(l => l.id === bookmark.itemId);
    if (lineObj) {
      highlightRouteOnMap(lineObj.coordinates, lineObj.color);
    }
  } else if (bookmark.type === 'route') {
    const parts = bookmark.itemId.split('->');
    if (parts.length === 2) {
      startStop.value = parts[0];
      endStop.value = parts[1];
      currentTab.value = 'planner';
      handleSearchRoute();
    }
  }
};

const handleRefreshData = () => {
  if (pathLayerGroup) pathLayerGroup.clearLayers();
  selectedLineId.value = null;
  selectedStopId.value = null;
  activeRouteIndex.value = null;
  renderStopsOnMap();
  if (map) {
    map.setView([16.82, 96.15], 12);
  }
};

// User Current Location Tracking & Route Active Stop Checker
const userLocation = ref<{ lat: number; lng: number; accuracy?: number } | null>(null);
const trackingLocation = ref(false);
let userMarker: any = null;
let userAccuracyCircle: any = null;

const getDistanceInMeters = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
  const R = 6371e3; // Radius of the earth in meters
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; // returns distance in meters
};

const nearestStopOverall = computed(() => {
  if (!userLocation.value || BUS_STOPS.value.length === 0) return null;
  let minDistance = Infinity;
  let closestStop: BusStop | null = null;
  
  BUS_STOPS.value.forEach(stop => {
    const lat = typeof stop.lat === 'number' ? stop.lat : parseFloat(stop.lat as any);
    const lng = typeof stop.lng === 'number' ? stop.lng : parseFloat(stop.lng as any);
    if (isNaN(lat) || !isFinite(lat) || isNaN(lng) || !isFinite(lng)) return;
    
    const d = getDistanceInMeters(userLocation.value!.lat, userLocation.value!.lng, lat, lng);
    if (d < minDistance) {
      minDistance = d;
      closestStop = stop;
    }
  });
  
  return closestStop ? { stop: closestStop, distance: Math.round(minDistance) } : null;
});

const nearestStopOnRoute = computed(() => {
  if (!userLocation.value || activeRouteIndex.value === null || !sortedRoutes.value || sortedRoutes.value.length === 0) return null;
  const stopsSet = activeRouteStops.value;
  if (!stopsSet || stopsSet.size === 0) return null;
  
  let minDistance = Infinity;
  let closestStop: BusStop | null = null;
  
  BUS_STOPS.value.forEach(stop => {
    if (!stopsSet.has(stop.id)) return;
    
    const lat = typeof stop.lat === 'number' ? stop.lat : parseFloat(stop.lat as any);
    const lng = typeof stop.lng === 'number' ? stop.lng : parseFloat(stop.lng as any);
    if (isNaN(lat) || !isFinite(lat) || isNaN(lng) || !isFinite(lng)) return;
    
    const d = getDistanceInMeters(userLocation.value!.lat, userLocation.value!.lng, lat, lng);
    if (d < minDistance) {
      minDistance = d;
      closestStop = stop;
    }
  });
  
  return closestStop ? { stop: closestStop, distance: Math.round(minDistance) } : null;
});

// Update or redraw user pointer
const updateUserMarkerOnMap = () => {
  if (!map || !currentL || !userLocation.value) return;
  
  const { lat, lng, accuracy } = userLocation.value;
  
  if (userMarker) {
    userMarker.setLatLng([lat, lng]);
  } else {
    const userIcon = currentL.divIcon({
      className: 'user-location-marker-container',
      html: `
        <div class="relative flex items-center justify-center w-6 h-6">
          <div class="absolute w-6 h-6 bg-blue-500 rounded-full opacity-35 animate-ping"></div>
          <div class="relative w-3.5 h-3.5 bg-blue-600 rounded-full border-2 border-white shadow-md font-sans"></div>
        </div>
      `,
      iconSize: [24, 24],
      iconAnchor: [12, 12]
    });
    
    userMarker = currentL.marker([lat, lng], { icon: userIcon }).addTo(map);
    userMarker.bindPopup('<span class="text-xs font-bold font-sans">You are here</span>');
  }

  if (accuracy) {
    if (userAccuracyCircle) {
      userAccuracyCircle.setLatLng([lat, lng]);
      userAccuracyCircle.setRadius(accuracy);
    } else {
      userAccuracyCircle = currentL.circle([lat, lng], {
        radius: accuracy,
        color: '#2563eb',
        fillColor: '#3b82f6',
        fillOpacity: 0.1,
        weight: 1
      }).addTo(map);
    }
  }
};

const panToUserLocation = () => {
  if (!userLocation.value || !map) return;
  map.setView([userLocation.value.lat, userLocation.value.lng], 15);
};

const startLocationTracking = () => {
  if (!navigator.geolocation) {
    alert("Geolocation is not supported by your browser.");
    return;
  }
  
  trackingLocation.value = true;
  navigator.geolocation.watchPosition(
    (position) => {
      userLocation.value = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: position.coords.accuracy
      };
      updateUserMarkerOnMap();
    },
    (error) => {
      console.warn("Geolocation access tracking rejected/timeout:", error);
      trackingLocation.value = false;
    },
    {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 0
    }
  );
};

const useNearestStopAsStart = () => {
  const currentNearest = nearestStopOverall.value;
  if (currentNearest && currentNearest.stop) {
    startStop.value = currentNearest.stop.id;
    startSearchQuery.value = currentNearest.stop.name;
    handleSearchRoute();
  }
};

// Supabase Integration, Browser-Level Keys & Cloud Database State
const showCredentialsModal = ref(false);
const clientSupabaseUrl = ref(localStorage.getItem('YBS_SUPABASE_URL') || '');
const clientSupabaseAnonKey = ref(localStorage.getItem('YBS_SUPABASE_ANON_KEY') || '');
const clientGeminiApiKey = ref(localStorage.getItem('YBS_GEMINI_API_KEY') || '');
const clientGroqApiKey = ref(localStorage.getItem('YBS_GROQ_API_KEY') || '');
const clientOpenRouterApiKey = ref(localStorage.getItem('YBS_OPENROUTER_API_KEY') || '');
const clientOpenaiApiKey = ref(localStorage.getItem('YBS_OPENAI_API_KEY') || '');
const clientAiProvider = ref(localStorage.getItem('YBS_AI_PROVIDER') || 'gemini');
const clientSupabaseConnected = ref(false);
const clientSupabaseError = ref('');
const isTestingConnection = ref(false);
const connectionTestSuccess = ref(false);

const supabaseConfigured = ref(false);
const supabaseStatus = ref<'unconfigured' | 'tables_missing' | 'connected' | 'connection_error'>('unconfigured');
const supabaseUrlStr = ref('');
const supabaseStopsCount = ref(0);
const supabaseLinesCount = ref(0);
const supabaseErrorMessage = ref('');
const isSyncingDatabase = ref(false);
const syncFeedback = ref<{ type: 'success' | 'error' | ''; message: string }>({ type: '', message: '' });
const dataSourceLabel = ref('Local Cache');

// Fetch Supabase configuration status from the backend
const checkSupabaseStatus = async () => {
  try {
    const response = await fetch('/api/supabase/status');
    const data = await response.json();
    supabaseConfigured.value = data.configured;
    supabaseStatus.value = data.status;
    supabaseUrlStr.value = data.url;
    supabaseStopsCount.value = data.stopsCount || 0;
    supabaseLinesCount.value = data.linesCount || 0;
    supabaseErrorMessage.value = data.error || '';
  } catch (err) {
    console.error("Failed to fetch Supabase status:", err);
    supabaseStatus.value = 'connection_error';
    supabaseErrorMessage.value = "Failed to communicate with Express server API.";
  }
};

// Test browser direct credentials to Supabase
const testAndSaveClientSupabase = async () => {
  // Save Gemini Key if provided
  if (clientGeminiApiKey.value.trim()) {
    localStorage.setItem('YBS_GEMINI_API_KEY', clientGeminiApiKey.value.trim());
  } else {
    localStorage.removeItem('YBS_GEMINI_API_KEY');
  }

  // Save Groq Key if provided
  if (clientGroqApiKey.value.trim()) {
    localStorage.setItem('YBS_GROQ_API_KEY', clientGroqApiKey.value.trim());
  } else {
    localStorage.removeItem('YBS_GROQ_API_KEY');
  }

  // Save OpenRouter Key if provided
  if (clientOpenRouterApiKey.value.trim()) {
    localStorage.setItem('YBS_OPENROUTER_API_KEY', clientOpenRouterApiKey.value.trim());
  } else {
    localStorage.removeItem('YBS_OPENROUTER_API_KEY');
  }

  // Save OpenAI Key if provided
  if (clientOpenaiApiKey.value.trim()) {
    localStorage.setItem('YBS_OPENAI_API_KEY', clientOpenaiApiKey.value.trim());
  } else {
    localStorage.removeItem('YBS_OPENAI_API_KEY');
  }

  // Save Provider selection
  localStorage.setItem('YBS_AI_PROVIDER', clientAiProvider.value);

  // If Supabase coordinates are empty but they updated the AI Keys, save smoothly and exit
  if (!clientSupabaseUrl.value.trim() && !clientSupabaseAnonKey.value.trim()) {
    connectionTestSuccess.value = true;
    setTimeout(() => {
      showCredentialsModal.value = false;
      connectionTestSuccess.value = false;
    }, 1000);
    return;
  }

  if (!clientSupabaseUrl.value.trim() || !clientSupabaseAnonKey.value.trim()) {
    clientSupabaseError.value = "Please complete both Supabase fields or keep both cleared to store AI keys alone.";
    return;
  }

  isTestingConnection.value = true;
  clientSupabaseError.value = '';
  connectionTestSuccess.value = false;

  try {
    const client = createClient(clientSupabaseUrl.value.trim(), clientSupabaseAnonKey.value.trim());
    
    // Attempt querying the database
    const { data: stopsCheck, error: stopsErr } = await client.from('ybs_stops').select('id').limit(1);
    if (stopsErr) throw stopsErr;

    const { data: linesCheck, error: linesErr } = await client.from('ybs_lines').select('id').limit(1);
    if (linesErr) throw linesErr;

    // Save of verified credentials to browser persistence
    localStorage.setItem('YBS_SUPABASE_URL', clientSupabaseUrl.value.trim());
    localStorage.setItem('YBS_SUPABASE_ANON_KEY', clientSupabaseAnonKey.value.trim());

    clientSupabaseConnected.value = true;
    connectionTestSuccess.value = true;

    // Hydrate tables immediately
    await loadYBSCloudData();

    setTimeout(() => {
      showCredentialsModal.value = false;
      connectionTestSuccess.value = false;
    }, 1500);

  } catch (err: any) {
    console.error("Direct browser connection test failed:", err);
    clientSupabaseConnected.value = false;
    clientSupabaseError.value = err.message || "Failed to query the database. Please verify your Supabase credentials, internet connection, and database tables.";
  } finally {
    isTestingConnection.value = false;
  }
};

const clearClientSupabase = () => {
  localStorage.removeItem('YBS_SUPABASE_URL');
  localStorage.removeItem('YBS_SUPABASE_ANON_KEY');
  localStorage.removeItem('YBS_GEMINI_API_KEY');
  localStorage.removeItem('YBS_GROQ_API_KEY');
  localStorage.removeItem('YBS_OPENROUTER_API_KEY');
  localStorage.removeItem('YBS_OPENAI_API_KEY');
  localStorage.removeItem('YBS_AI_PROVIDER');
  clientSupabaseUrl.value = '';
  clientSupabaseAnonKey.value = '';
  clientGeminiApiKey.value = '';
  clientGroqApiKey.value = '';
  clientOpenRouterApiKey.value = '';
  clientOpenaiApiKey.value = '';
  clientAiProvider.value = 'gemini';
  clientSupabaseConnected.value = false;
  clientSupabaseError.value = '';
  connectionTestSuccess.value = false;
  
  // Reload fallback
  loadYBSCloudData();
};

// Clear & seed current local data over to Supabase in batches
const syncLocalToSupabase = async () => {
  if (isSyncingDatabase.value) return;
  isSyncingDatabase.value = true;
  syncFeedback.value = { type: '', message: '' };

  try {
    const response = await fetch('/api/supabase/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const result = await response.json();
    if (response.ok && result.success) {
      syncFeedback.value = {
        type: 'success',
        message: result.message || 'Database synchronized successfully!'
      };
      await checkSupabaseStatus();
      await loadYBSCloudData();
    } else {
      syncFeedback.value = {
        type: 'error',
        message: result.error || 'Database migration failed.'
      };
    }
  } catch (err: any) {
    syncFeedback.value = {
      type: 'error',
      message: err.message || 'Network communication error.'
    };
  } finally {
    isSyncingDatabase.value = false;
  }
};

// Load dynamic YBS stops and lines if connected to Supabase
const loadYBSCloudData = async () => {
  // 1. Direct browser client-side query (Tops priority for Vercel deployment & direct user customization)
  if (clientSupabaseUrl.value && clientSupabaseAnonKey.value) {
    try {
      console.log("Loading live transit schedules directly from user's Supabase instance with full pagination...");
      const client = createClient(clientSupabaseUrl.value.trim(), clientSupabaseAnonKey.value.trim());

      const fetchAllClientRows = async (tableName: string) => {
        let allRows: any[] = [];
        let page = 0;
        const pageSize = 1000;
        let hasMore = true;
        while (hasMore) {
          const { data, error } = await client
            .from(tableName)
            .select('*')
            .range(page * pageSize, (page + 1) * pageSize - 1);
          
          if (error) throw error;
          if (data && data.length > 0) {
            allRows.push(...data);
            if (data.length < pageSize) {
              hasMore = false;
            } else {
              page++;
            }
          } else {
            hasMore = false;
          }
        }
        return allRows;
      };

      const stopsData = await fetchAllClientRows('ybs_stops');
      const linesData = await fetchAllClientRows('ybs_lines');

      if (stopsData && stopsData.length > 0) {
        BUS_STOPS.value = stopsData.map((d: any) => ({
          id: d.id,
          name: d.name,
          nameMy: d.name_my || d.name,
          lat: d.lat,
          lng: d.lng,
          lines: d.lines || []
        }));
        clientSupabaseConnected.value = true;
        dataSourceLabel.value = "Direct Supabase (Browser Client)";
      }

      if (linesData && linesData.length > 0) {
        BUS_LINES.value = linesData.map((d: any) => ({
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

      // Re-trigger visual map renderer
      nextTick(() => {
        renderStopsOnMap();
      });
      return;
    } catch (err) {
      console.error("Direct browser Supabase query failed, trying fallback API...", err);
    }
  }

  // 2. Server-side API endpoint fallback
  try {
    const stopsResponse = await fetch('/api/stops');
    const stopsJson = await stopsResponse.json();
    if (stopsJson.data && stopsJson.data.length > 0) {
      BUS_STOPS.value = stopsJson.data;
      dataSourceLabel.value = stopsJson.source;
    }

    const linesResponse = await fetch('/api/lines');
    const linesJson = await linesResponse.json();
    if (linesJson.data && linesJson.data.length > 0) {
      BUS_LINES.value = linesJson.data;
    }

    // Render map
    nextTick(() => {
      renderStopsOnMap();
    });
  } catch (err) {
    console.error("Error loading live data from API:", err);
  }
};

onMounted(async () => {
  loadBookmarks();
  initMap();
  await checkSupabaseStatus();
  await loadYBSCloudData();
});
</script>

<template>
  <div class="min-h-screen flex flex-col bg-slate-50 text-slate-800 font-sans selection:bg-blue-600 selection:text-white" id="ybs_root_app_container">
    
    <!-- Top Modern Professional Polish Header -->
    <header class="h-16 bg-slate-900 text-white flex items-center justify-between px-6 shrink-0 shadow-md border-b border-slate-700 sticky top-0 z-[1000]" id="ybs_main_navbar_header">
      <div class="max-w-7xl w-full mx-auto flex items-center justify-between gap-4">
        
        <!-- Brand Identity with Logo -->
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 bg-blue-600 rounded-lg flex items-center justify-center font-bold text-xl tracking-tight text-white shadow-sm shrink-0" id="ybs_logo_badge_div">
            <BusFront class="w-5.5 h-5.5 text-white" />
          </div>
          <div class="text-left">
            <h1 class="text-base font-bold leading-tight uppercase tracking-wider text-white">YBS Pro</h1>
            <p class="text-[9px] text-slate-400 font-mono uppercase tracking-widest leading-none">Next-Gen Transit Management</p>
          </div>
        </div>

        <!-- Navigation Tabs in Header -->
        <nav class="flex overflow-x-auto p-1 bg-slate-800 rounded-lg border border-slate-700 max-w-full [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]" id="ybs_top_tabs_navbar">
          <button 
            id="tab_planner_btn"
            @click="currentTab = 'planner'" 
            :class="[
              'flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-bold whitespace-nowrap transition-all duration-200 cursor-pointer',
              currentTab === 'planner' ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-300 hover:text-white hover:bg-slate-700'
            ]"
          >
            <Navigation2 class="w-3.5 h-3.5" />
            Plan Route
          </button>
          
          <button 
            id="tab_lines_btn"
            @click="currentTab = 'lines'" 
            :class="[
              'flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-bold whitespace-nowrap transition-all duration-200 cursor-pointer',
              currentTab === 'lines' ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-300 hover:text-white hover:bg-slate-700'
            ]"
          >
            <BusFront class="w-3.5 h-3.5" />
            Explore Lines
          </button>

          <button 
            id="tab_stops_btn"
            @click="currentTab = 'stops'" 
            :class="[
              'flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-bold whitespace-nowrap transition-all duration-200 cursor-pointer',
              currentTab === 'stops' ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-300 hover:text-white hover:bg-slate-700'
            ]"
          >
            <MapPin class="w-3.5 h-3.5" />
            Bus Stops
          </button>

          <button 
            id="tab_assistant_btn"
            @click="currentTab = 'assistant'" 
            :class="[
              'flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-bold whitespace-nowrap transition-all duration-200 cursor-pointer',
              currentTab === 'assistant' ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-300 hover:text-white hover:bg-slate-700'
            ]"
          >
            <Sparkles class="w-3.5 h-3.5" />
            AI Assistant
          </button>
        </nav>

        <!-- Status Terminal Indicator Badge -->
        <div class="flex items-center gap-2 md:gap-4 text-right">
          <!-- Supabase Connection Configurator Toggle Button -->
          <button 
            id="configure_supabase_cloud_btn"
            @click="showCredentialsModal = true"
            class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border transition duration-200 cursor-pointer shadow-xs active:scale-95"
            :class="[
              clientSupabaseConnected 
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20' 
                : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700 hover:border-slate-600 hover:text-white'
            ]"
          >
            <Database class="w-3.5 h-3.5" :class="clientSupabaseConnected ? 'text-emerald-400' : 'text-slate-400'" />
            <span class="hidden sm:inline">Supabase DB Config</span>
            <span class="sm:hidden">DB</span>
          </button>

          <div class="hidden md:flex flex-col items-end">
            <span class="text-xs font-semibold text-slate-200">Admin Terminal</span>
            <span class="text-[10px] text-emerald-400 font-mono">System Status: Active</span>
          </div>
          <div class="w-8 h-8 rounded-full bg-slate-700 border border-slate-600 flex items-center justify-center font-bold text-xs text-white">YP</div>
        </div>

      </div>
    </header>

    <!-- Main Workspace Area -->
    <main class="flex-1 max-w-7xl w-full mx-auto p-4 md:p-6 grid grid-cols-1 lg:grid-cols-12 gap-6" id="ybs_main_workspace_grid">
      
      <!-- LEFT HAND COMPRO PANELS (5 cols on lg screens in white shadow frame) -->
      <section class="lg:col-span-5 flex flex-col gap-4 bg-white p-5 rounded-xl border border-slate-200 shadow-sm" id="ybs_left_control_panel">
        


        <!-- Tab 1: Route Planner Controls -->
        <div v-if="currentTab === 'planner'" class="flex-1 flex flex-col gap-4" id="view_route_planner_card">
          <div class="border-b border-slate-100 pb-3 text-left">
            <h2 class="text-base font-bold text-slate-900 flex items-center gap-2">
              <Navigation2 class="w-4 h-4 text-blue-600" />
              Find Best Bus Route
            </h2>
            <p class="text-xs text-slate-500 mt-1">Directly lookup transit options and transfer points across Yangon</p>
          </div>

          <!-- Selector input form block -->
          <div class="grid grid-cols-1 gap-3.5 bg-slate-50 p-4 rounded-lg border border-slate-200/60" id="planner_fields_wrapper">
            <!-- Starting Station Searchable Combobox -->
            <div class="flex flex-col gap-1.5 relative text-left" id="start_stop_container">
              <label class="text-[10px] font-bold tracking-wider text-slate-500 uppercase">Starting Station</label>
              <div class="relative">
                <MapPin class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-emerald-600 z-10" />
                <input 
                  id="start_stop_search_input"
                  type="text" 
                  v-model="startSearchQuery"
                  @focus="isStartDropdownOpen = true"
                  @blur="closeStartDropdown"
                  placeholder="Type to search starting bus stop..."
                  class="w-full bg-white border border-slate-200 rounded-md py-2 pl-9 pr-8 text-xs text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button 
                  v-if="startSearchQuery || startStop"
                  type="button"
                  @click.prevent="clearStartStop"
                  class="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 focus:outline-none p-1 rounded-full cursor-pointer hover:bg-slate-100"
                  title="Clear starting station selection"
                >
                  <X class="w-3.5 h-3.5" />
                </button>
              </div>

              <!-- Start Suggestions drop list -->
              <div 
                v-if="isStartDropdownOpen" 
                class="absolute left-0 right-0 top-full mt-1 max-h-60 overflow-y-auto bg-white border border-slate-200 rounded-md shadow-lg z-[2000] text-xs"
                id="start_suggestions_dropdown"
              >
                <div 
                  v-for="stop in startStopSuggestions" 
                  :key="'start-suggestion-' + stop.id"
                  @mousedown="selectStartStop(stop)"
                  class="px-3 py-2 hover:bg-slate-50 cursor-pointer border-b border-slate-50 last:border-0 text-slate-700 flex flex-col gap-0.5 text-left"
                >
                  <div class="font-bold flex items-center justify-between">
                    <span>{{ stop.name }}</span>
                    <span class="text-[9px] font-mono text-slate-400 bg-slate-100 px-1 py-0.2 rounded">#{{ stop.id }}</span>
                  </div>
                  <div class="text-[10px] text-blue-600 font-medium font-sans">({{ getStopLinesDisplay(stop) }}) • {{ stop.nameMy }}</div>
                </div>
                <div v-if="startStopSuggestions.length === 0" class="p-3 text-slate-400 text-center italic">
                  No matching bus stations found.
                </div>
              </div>
            </div>

            <!-- Swap route fields action -->
            <div class="flex justify-center -my-2 relative z-10">
              <button 
                id="reverse_route_btn"
                type="button"
                @click.prevent="reverseRouteFinder" 
                class="bg-white hover:bg-slate-100 text-slate-600 p-2 rounded-full border border-slate-200 transition shadow-sm cursor-pointer"
                title="Swap origin and destination"
              >
                <ArrowRightLeft class="w-3.5 h-3.5 rotate-90" />
              </button>
            </div>

            <!-- Ending Station Searchable Combobox -->
            <div class="flex flex-col gap-1.5 relative text-left" id="end_stop_container">
              <label class="text-[10px] font-bold tracking-wider text-slate-500 uppercase">End Destination</label>
              <div class="relative">
                <MapPin class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-red-500 z-10" />
                <input 
                  id="end_stop_search_input"
                  type="text" 
                  v-model="endSearchQuery"
                  @focus="isEndDropdownOpen = true"
                  @blur="closeEndDropdown"
                  placeholder="Type to search end destination stop..."
                  class="w-full bg-white border border-slate-200 rounded-md py-2 pl-9 pr-8 text-xs text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button 
                  v-if="endSearchQuery || endStop"
                  type="button"
                  @click.prevent="clearEndStop"
                  class="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 focus:outline-none p-1 rounded-full cursor-pointer hover:bg-slate-100"
                  title="Clear end destination selection"
                >
                  <X class="w-3.5 h-3.5" />
                </button>
              </div>

              <!-- End Suggestions drop list -->
              <div 
                v-if="isEndDropdownOpen" 
                class="absolute left-0 right-0 top-full mt-1 max-h-60 overflow-y-auto bg-white border border-slate-200 rounded-md shadow-lg z-[2000] text-xs"
                id="end_suggestions_dropdown"
              >
                <div 
                  v-for="stop in endStopSuggestions" 
                  :key="'end-suggestion-' + stop.id"
                  @mousedown="selectEndStop(stop)"
                  class="px-3 py-2 hover:bg-slate-50 cursor-pointer border-b border-slate-50 last:border-0 text-slate-700 flex flex-col gap-0.5 text-left"
                >
                  <div class="font-bold flex items-center justify-between">
                    <span>{{ stop.name }}</span>
                    <span class="text-[9px] font-mono text-slate-400 bg-slate-100 px-1 py-0.2 rounded">#{{ stop.id }}</span>
                  </div>
                  <div class="text-[10px] text-blue-600 font-medium font-sans">({{ getStopLinesDisplay(stop) }}) • {{ stop.nameMy }}</div>
                </div>
                <div v-if="endStopSuggestions.length === 0" class="p-3 text-slate-400 text-center italic">
                  No matching bus stations found.
                </div>
              </div>
            </div>

            <button 
              id="search_route_btn"
              @click="handleSearchRoute" 
              class="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs py-2.5 rounded-md transition duration-200 flex items-center justify-center gap-2 mt-2 shadow-sm cursor-pointer"
            >
              <Search class="w-4 h-4 text-white" />
              Search Commute Pathways
            </button>

            <!-- Bookmark search route pair button -->
            <button 
              id="bookmark_search_route_pair_btn"
              v-if="startStop && endStop"
              @click.stop="toggleBookmark('route', `${startStop}->${endStop}`, `${(BUS_STOPS.find(s => s.id === startStop)?.name) || 'Starting Stop'} ➔ ${(BUS_STOPS.find(s => s.id === endStop)?.name) || 'Destination Stop'}`)"
              class="w-full mt-2 text-[10px] bg-white border border-slate-200 font-bold hover:bg-slate-50 text-slate-700 py-1.5 px-3 rounded flex items-center justify-center gap-1.5 transition cursor-pointer"
            >
              <component :is="isBookmarked('route', `${startStop}->${endStop}`) ? BookmarkCheck : Bookmark" class="w-3.5 h-3.5 text-blue-600" />
              {{ isBookmarked('route', `${startStop}->${endStop}`) ? 'Commute Saved in Favorites' : 'Bookmark this Daily Ride' }}
            </button>
          </div>

          <!-- User Real-Time Geolocation Tracking & Route Step Inspector -->
          <div class="p-3.5 rounded-lg border text-xs" :class="[
            trackingLocation 
              ? 'bg-blue-50/50 border-blue-200 text-blue-900' 
              : 'bg-slate-50 border-slate-200 text-slate-700'
          ]" id="geotracker_status_card">
            <div class="flex items-center justify-between mb-3 border-b pb-2" :class="trackingLocation ? 'border-blue-100' : 'border-slate-200'">
              <span class="font-bold uppercase tracking-wider text-[10px] flex items-center gap-1.5" :class="trackingLocation ? 'text-blue-800' : 'text-slate-500'">
                <Compass class="w-4 h-4" :class="trackingLocation ? 'text-blue-600 animate-spin-slow' : 'text-slate-400'" />
                GPS location tracker
              </span>
              <span v-if="trackingLocation" class="flex h-2 w-2 relative">
                <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span class="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
              </span>
              <span v-else class="text-[9px] text-slate-500 font-mono">Offline</span>
            </div>

            <!-- Inactive Tracking State -->
            <div v-if="!trackingLocation" class="space-y-2 text-left">
              <p class="text-[11px] leading-relaxed text-slate-500">
                Turn on your GPS locator tool to detect passenger surroundings, locate nearby stations on the map, and track active route progress.
              </p>
              <button 
                id="enable_geotracker_sidebar_btn"
                @click="startLocationTracking"
                class="w-full bg-slate-800 hover:bg-slate-700 text-white text-[11px] font-bold py-1.5 rounded flex items-center justify-center gap-1.5 transition cursor-pointer"
              >
                📍 Enable GPS Tracker
              </button>
            </div>

            <!-- Active Tracking State -->
            <div v-else class="space-y-3 text-left">
              <!-- Coordinates debug readouts -->
              <div v-if="userLocation" class="flex justify-between text-[10px] text-slate-500 font-mono bg-slate-100/50 p-1 rounded">
                <span>Lat: {{ userLocation.lat.toFixed(5) }}</span>
                <span>Lng: {{ userLocation.lng.toFixed(5) }}</span>
                <span v-if="userLocation.accuracy">±{{ Math.round(userLocation.accuracy) }}m</span>
              </div>

              <!-- Route Specific Active Stop Detector -->
              <div v-if="activeRouteIndex !== null" class="bg-blue-600 text-white rounded-lg p-3 space-y-2 shadow-xs border border-blue-500">
                <div class="flex items-center gap-1.5 border-b border-blue-500 pb-1.5">
                  <Navigation2 class="w-4 h-4 text-white animate-pulse" />
                  <span class="font-extrabold uppercase text-[9px] tracking-wider text-blue-100">Live Route stop tracker</span>
                </div>
                
                <div v-if="nearestStopOnRoute" class="space-y-1">
                  <!-- User is on the stop (within 150m) -->
                  <div v-if="nearestStopOnRoute.distance <= 150" class="flex items-start gap-1.5">
                    <span class="text-[9px] bg-emerald-500 text-white px-1.5 py-0.5 rounded-full font-sans font-extrabold uppercase animate-pulse">On Stop</span>
                    <div class="flex-1">
                      <p class="font-bold text-xs">{{ nearestStopOnRoute.stop.name }}</p>
                      <p class="text-[10px] text-blue-100 font-medium leading-none">{{ nearestStopOnRoute.stop.nameMy }}</p>
                    </div>
                  </div>
                  <!-- User is approaching / nearby -->
                  <div v-else class="space-y-0.5">
                    <p class="text-[10px] text-blue-100">Approaching Stop on your route:</p>
                    <p class="font-extrabold text-xs text-white">{{ nearestStopOnRoute.stop.name }}</p>
                    <p class="text-[10px] text-blue-200 mt-0.5 flex items-center gap-1">
                      <span>🚶 Distance: ~{{ nearestStopOnRoute.distance }} meters</span>
                    </p>
                  </div>
                </div>
                <div v-else class="text-xs text-blue-200 leading-snug">
                  Selected route highlighted. Approach any stop of the route path to trace system positions.
                </div>
              </div>

              <!-- General Nearest Stop Overall Detector -->
              <div v-else-if="nearestStopOverall" class="bg-emerald-50/70 border border-emerald-200 text-emerald-900 rounded-lg p-3 space-y-1.5">
                <div class="flex items-center justify-between">
                  <span class="font-extrabold uppercase text-[9px] tracking-wider text-emerald-800">Nearest Bus Stop</span>
                  <span class="text-[9px] font-mono text-emerald-600 font-bold bg-emerald-100 px-1 py-0.2 rounded">Detected</span>
                </div>
                <div>
                  <p class="font-bold text-slate-800 leading-snug">{{ nearestStopOverall.stop.name }}</p>
                  <p class="text-[10px] text-emerald-700 leading-none mt-0.5">{{ nearestStopOverall.stop.nameMy }}</p>
                </div>
                <div class="flex items-center justify-between text-[10px] text-slate-500 pt-1.5 border-t border-emerald-150">
                  <span>Distance: ~{{ nearestStopOverall.distance }}m</span>
                  <button 
                    id="use_nearest_start_btn"
                    @mousedown="useNearestStopAsStart"
                    class="text-[9px] font-bold text-blue-600 hover:text-blue-700 hover:underline cursor-pointer"
                  >
                    Set as Starting Station
                  </button>
                </div>
              </div>

              <!-- Action triggers -->
              <div class="flex items-center gap-2 pt-1 border-t border-slate-100">
                <button 
                  id="recenter_my_loc_btn"
                  @click="panToUserLocation"
                  class="flex-1 bg-white hover:bg-slate-50 text-[10.5px] font-bold py-1 px-2.5 rounded border border-slate-200 text-slate-700 flex items-center justify-center gap-1.5 cursor-pointer shadow-2xs"
                >
                  <Crosshair class="w-3.5 h-3.5 text-blue-600" />
                  Center to Me
                </button>
              </div>
            </div>
          </div>

          <!-- Bookmarks and saved commutes listing (Secure Browser Storage) -->
          <div id="bookmarks_sidebar_registry" class="mt-2 pt-3 border-t border-slate-100 flex flex-col gap-2.5 text-left">
            <div class="flex items-center justify-between">
              <h3 class="text-xs font-bold text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
                <BookmarkCheck class="w-4 h-4 text-blue-600" />
                Saved Daily Commutes ({{ bookmarks.length }})
              </h3>
              <span class="text-[9px] text-slate-500 font-semibold bg-slate-100 px-1.5 py-0.5 rounded border border-slate-200">
                Hardware Secured
              </span>
            </div>

            <!-- Empty bookmarks case -->
            <div v-if="bookmarks.length === 0" class="text-center py-5 text-slate-400 bg-slate-50/50 rounded-lg p-3.5 border border-dashed border-slate-200 text-xs">
              <Bookmark class="w-6 h-6 text-slate-300 mx-auto mb-1.5 animate-pulse" />
              <p class="font-medium">No saved commutes or stations yet.</p>
              <p class="text-[10px] text-slate-500 mt-1 leading-normal">Highlight stations or routes across city layers, bookmark them, and tag them for quick access!</p>
            </div>

            <!-- Scrollable bookmarks list -->
            <div v-else class="space-y-2 overflow-y-auto max-h-[170px] pr-1 scrollbar-thin">
              <div 
                v-for="b in bookmarks" 
                :key="b.id" 
                class="bg-slate-50 hover:bg-slate-100/70 p-2.5 rounded-lg border border-slate-200 transition text-xs"
              >
                <!-- Edit Dialog / Inline Fields -->
                <div v-if="editingBookmarkId === b.id" class="space-y-2.5 bg-white p-2.5 rounded-md border border-slate-300 shadow-sm">
                  <div class="flex flex-col gap-1">
                    <label class="text-[9px] font-black uppercase text-slate-400 tracking-wider">Custom Label</label>
                    <input 
                      type="text" 
                      v-model="editingBookmarkLabel" 
                      placeholder="e.g. Home, Work, Office, School Stop..."
                      class="bg-slate-50 border border-slate-200 rounded px-2 py-1 text-xs focus:ring-1 focus:ring-blue-500 focus:outline-none text-slate-800"
                    />
                  </div>
                  <div class="flex flex-col gap-1">
                    <label class="text-[9px] font-black uppercase text-slate-400 tracking-wider">Personal Commute Notes</label>
                    <textarea 
                      v-model="editingBookmarkNotes" 
                      placeholder="e.g. Catch the YBS 4 here by 8:15 AM to avoid peak rush..."
                      class="bg-slate-50 border border-slate-200 rounded px-2 py-1 text-xs focus:ring-1 focus:ring-blue-500 focus:outline-none text-slate-800 min-h-[50px] resize-none"
                    ></textarea>
                  </div>
                  <div class="flex justify-end gap-1.5 pt-1 border-t border-slate-100">
                    <button 
                      @click="cancelEditBookmark" 
                      class="text-[10px] font-bold text-slate-500 px-2 py-1 hover:bg-slate-150 rounded transition cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button 
                      @click="submitEditBookmark" 
                      class="bg-blue-600 hover:bg-blue-700 text-white font-bold text-[10px] px-2.5 py-1 rounded shadow-xs transition cursor-pointer"
                    >
                      Save changes
                    </button>
                  </div>
                </div>

                <!-- Display Bookmark -->
                <div v-else class="flex items-start justify-between gap-1.5">
                  <div class="flex-1 min-w-0">
                    <!-- Title/Header of Bookmark -->
                    <div class="flex items-center gap-1.5 flex-wrap">
                      <span 
                        :class="[
                          'text-[8px] font-black uppercase tracking-wider px-1 rounded border',
                          b.type === 'stop' ? 'text-rose-700 bg-rose-50 border-rose-200' :
                          b.type === 'line' ? 'text-blue-700 bg-blue-50 border-blue-200' :
                          'text-emerald-700 bg-emerald-50 border-emerald-200'
                        ]"
                      >
                        {{ b.type === 'stop' ? 'Bus Stop' : b.type === 'line' ? 'Transit Line' : 'Direct Loop' }}
                      </span>
                      
                      <!-- Tag Label -->
                      <span 
                        v-if="b.customLabel" 
                        class="text-[9px] font-extrabold text-blue-650 bg-blue-50 px-1.5 py-0.2 rounded border border-blue-150 inline-flex items-center gap-0.5"
                      >
                        <Tag class="w-2.5 h-2.5 text-blue-500" />
                        {{ b.customLabel }}
                      </span>
                    </div>

                    <!-- Bookmark Subject click query -->
                    <div class="mt-1.5">
                      <button 
                        @click="handleBookmarkClick(b)"
                        class="text-xs font-bold text-slate-855 hover:text-blue-600 hover:underline text-left block leading-tight transition cursor-pointer"
                      >
                        {{ b.title }}
                      </button>
                    </div>

                    <!-- Personal saved notes field -->
                    <p v-if="b.notes" class="text-[10px] text-slate-500 mt-1 italic font-sans break-words bg-white p-1.5 rounded border border-slate-150 leading-relaxed text-left pl-2 border-l-2 border-l-blue-400">
                      {{ b.notes }}
                    </p>
                  </div>

                  <!-- Actions widget buttons -->
                  <div class="flex items-center gap-1 shrink-0">
                    <button 
                      @click="startEditBookmark(b)" 
                      class="p-1 hover:bg-slate-205 rounded text-slate-400 hover:text-slate-705 transition cursor-pointer"
                      title="Edit labels and personal commute notes"
                    >
                      <Edit class="w-3.5 h-3.5 text-slate-500" />
                    </button>
                    <button 
                      @click="toggleBookmark(b.type, b.itemId, b.title)" 
                      class="p-1 hover:bg-red-50 rounded text-slate-400 hover:text-red-655 transition cursor-pointer"
                      title="Delete Bookmark"
                    >
                      <Trash2 class="w-3.5 h-3.5 text-slate-500 hover:text-red-550" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Solutions lists with light themed containers -->
          <div class="flex-1 overflow-y-auto max-h-[350px] space-y-3 pr-1" id="planner_solutions_list">
            <div v-if="sortedRoutes.length === 0 && searchAttempted" class="text-center py-8 bg-slate-50 rounded-lg p-4 border border-dashed border-slate-200">
              <Info class="w-8 h-8 text-slate-400 mx-auto mb-2" />
              <p class="text-xs font-bold text-slate-700">No active transfers available.</p>
              <p class="text-[11px] text-slate-500 mt-1">Try selecting different hubs or asking our AI expert in the next tab.</p>
            </div>

            <div v-else-if="sortedRoutes.length === 0" class="text-center py-10 text-slate-400 flex flex-col items-center justify-center">
              <Navigation2 class="w-8 h-8 text-slate-300 mb-2 animate-bounce" />
              <p class="text-xs text-slate-500 font-semibold">Select travel stations to generate path solutions.</p>
            </div>

            <div v-else class="flex flex-col gap-3">
              <!-- Route Sorting Controls -->
              <div class="flex flex-col gap-2 bg-slate-50 p-2 rounded-lg border border-slate-200" id="route_sorting_panel">
                <div class="flex items-center justify-between px-1">
                  <span class="text-[10px] text-slate-500 font-bold uppercase tracking-wider">Found {{ sortedRoutes.length }} Pathways:</span>
                  <span class="text-[9px] bg-blue-50 text-blue-700 px-2 py-0.5 rounded font-extrabold border border-blue-100">Live Solved</span>
                </div>
                <div class="grid grid-cols-3 gap-1.5">
                  <button 
                    id="sort_fastest_btn"
                    @click="routeSortBy = 'fastest'"
                    :class="[
                      'py-1.5 px-1 rounded font-bold text-[10px] transition duration-150 border',
                      routeSortBy === 'fastest' ? 'bg-blue-600 text-white border-blue-600 shadow-xs' : 'bg-white hover:bg-slate-100 text-slate-600 border-slate-200'
                    ]"
                  >
                    ⏱️ Fastest
                  </button>
                  <button 
                    id="sort_cheapest_btn"
                    @click="routeSortBy = 'cheapest'"
                    :class="[
                      'py-1.5 px-1 rounded font-bold text-[10px] transition duration-150 border',
                      routeSortBy === 'cheapest' ? 'bg-blue-600 text-white border-blue-600 shadow-xs' : 'bg-white hover:bg-slate-100 text-slate-600 border-slate-200'
                    ]"
                  >
                    💵 Cheapest
                  </button>
                  <button 
                    id="sort_direct_btn"
                    @click="routeSortBy = 'direct'"
                    :class="[
                      'py-1.5 px-1 rounded font-bold text-[10px] transition duration-150 border',
                      routeSortBy === 'direct' ? 'bg-blue-600 text-white border-blue-600 shadow-xs' : 'bg-white hover:bg-slate-100 text-slate-600 border-slate-200'
                    ]"
                  >
                    🔄 Direct First
                  </button>
                </div>
              </div>

              <!-- Solution details cards -->
              <div 
                v-for="(route, index) in sortedRoutes" 
                :key="index"
                @click="selectRoute(index)"
                :id="`route_result_card_${index}`"
                :class="[
                  'p-4 rounded-lg border transition cursor-pointer text-left',
                  activeRouteIndex === index 
                    ? 'border-blue-600 border-l-4 rounded-r-md bg-blue-50/30 shadow-xs' 
                    : 'border-slate-200 bg-white hover:bg-slate-50'
                ]"
              >
                <div class="flex justify-between items-start gap-2 mb-2">
                  <div class="flex items-center gap-2">
                    <span 
                      :class="[
                        'text-[9px] font-extrabold px-2 py-0.5 rounded uppercase tracking-wider',
                        route.type === 'direct' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'
                      ]"
                    >
                      {{ route.type === 'direct' ? 'Direct Ride' : '1-Transfer' }}
                    </span>
                    <span class="text-xs font-bold text-slate-750 flex items-center gap-1">
                      <Clock class="w-3.5 h-3.5 text-slate-400" />
                      ~{{ route.totalDuration }} min
                    </span>
                  </div>
                  <span class="text-xs font-mono font-bold text-blue-600">
                    {{ route.totalFare }} MMK
                  </span>
                </div>

                <!-- Steps itinerary roadmap visual -->
                <div class="relative pl-4 border-l border-slate-200 space-y-2 mt-3 text-xs">
                  <div 
                    v-for="(step, sIdx) in route.steps" 
                    :key="sIdx"
                    class="relative text-left"
                  >
                    <!-- Small status pin dots instead of plain items -->
                    <span 
                      :class="[
                        'absolute -left-[20.5px] top-1 w-2.5 h-2.5 rounded-full border border-white',
                        step.type === 'board' ? 'bg-emerald-500' : step.type === 'arrive' ? 'bg-red-500' : 'bg-blue-600'
                      ]"
                    ></span>
                    
                    <p class="text-slate-700 leading-tight">
                      {{ step.description }}
                      <span v-if="step.duration > 0" class="text-[10px] text-slate-400 font-mono italic">
                        ({{ step.duration }}m)
                      </span>
                    </p>
                  </div>
                </div>

                <div class="mt-3 pt-2.5 border-t border-slate-100 flex justify-between items-center text-[10px] text-slate-500">
                  <span>Selected on Interactive Map layer</span>
                  <ChevronRight class="w-3 h-3 text-slate-400" />
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Tab 2: Bus Lines list -->
        <div v-if="currentTab === 'lines'" class="flex-1 flex flex-col gap-3" id="view_lines_directory_card">
          <div class="border-b border-slate-100 pb-3 text-left">
            <h2 class="text-base font-bold text-slate-900 flex items-center gap-2">
              <BusFront class="w-4 h-4 text-blue-600" />
              YBS Bus Lines
            </h2>
            <p class="text-xs text-slate-500 mt-1">Search active loops and operators across Yangon</p>
          </div>

          <!-- Lines Search Entry -->
          <div class="relative" id="lines_search_container">
            <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input 
              id="line_filter_input"
              v-model="searchQuery" 
              type="text" 
              placeholder="Search bus name (e.g. YBS 1 or Operator)..."
              class="w-full bg-white border border-slate-200 rounded-md py-2 pl-9 pr-4 text-xs text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <!-- Cards scrolling deck -->
          <div class="flex-1 overflow-y-auto space-y-2.5 pr-1 max-h-[350px]" id="lines_scrolling_deck">
            <div 
              v-for="line in BUS_LINES.filter(l => l.name.toLowerCase().includes(searchQuery.toLowerCase()) || l.operator.toLowerCase().includes(searchQuery.toLowerCase()))" 
              :key="line.id"
              @click="handleSelectLine(line.id)"
              :id="`line_card_${line.id}`"
              :class="[
                'p-3 rounded-lg border transition text-left cursor-pointer',
                selectedLineId === line.id 
                  ? 'border-blue-600 border-l-4 rounded-r-md bg-blue-50/20 shadow-sm' 
                  : 'border-slate-200 bg-white hover:bg-slate-50'
              ]"
            >
              <div class="flex justify-between items-center mb-1">
                <div class="flex items-center gap-2">
                  <span 
                    class="w-2.5 h-2.5 rounded-full" 
                    :style="{ backgroundColor: line.color }"
                  ></span>
                  <h3 class="text-sm font-bold text-slate-800">{{ line.name }}</h3>
                </div>
                <span class="text-[10px] font-mono font-bold bg-slate-100 px-2 py-0.5 rounded text-blue-700">
                  {{ line.fare }} MMK
                </span>
              </div>

              <p class="text-xs text-slate-500 truncate">{{ line.operator }}</p>

              <!-- Stats bar inside card -->
              <div class="mt-2.5 grid grid-cols-2 gap-2 text-[10px] text-slate-500 bg-slate-50 p-2 rounded">
                <div>Route loop: <span class="text-slate-700 text-[10px] font-semibold block truncate">{{ line.startStop }} ⇄ {{ line.endStop }}</span></div>
                <div>Operational Hours: <span class="text-slate-700 text-[10px] font-semibold block">{{ line.operatingHours }}</span></div>
              </div>

              <!-- Station hub chain when focused -->
              <div v-if="selectedLineId === line.id" class="mt-3 pt-3 border-t border-slate-100">
                <div class="flex items-center justify-between mb-1.5">
                  <span class="text-[9px] font-black uppercase text-slate-400 tracking-wider">Ordered Stations Chain</span>
                  <button 
                    id="bookmark_line_btn"
                    @click.stop="toggleBookmark('line', line.id, line.name)"
                    class="text-[10px] flex items-center gap-1 hover:text-blue-600 text-slate-500 transition"
                  >
                    <component :is="isBookmarked('line', line.id) ? BookmarkCheck : Bookmark" class="w-3.5 h-3.5 text-blue-600" />
                    {{ isBookmarked('line', line.id) ? 'Bookmarked' : 'Add Bookmark' }}
                  </button>
                </div>
                <div class="flex flex-wrap gap-1.5" id="stops_capsule_list">
                  <span 
                    v-for="stopId in line.stops" 
                    :key="stopId"
                    @click.stop="handleSelectStop(stopId)"
                    class="text-[10px] px-2 py-1 rounded bg-slate-100 text-slate-700 border border-slate-200 transition hover:bg-blue-600 hover:text-white hover:border-blue-600 cursor-pointer"
                  >
                    {{ (BUS_STOPS.find(s => s.id === stopId)?.name) || stopId }}
                  </span>
                </div>

                <!-- Route Static Operational Context -->
                <div class="mt-3.5 pt-3 border-t border-slate-100 text-left">
                  <div class="flex items-center justify-between mb-2">
                    <span class="text-[9px] font-black uppercase text-slate-400 tracking-wider">Service Schedule Info</span>
                    <span class="text-[9px] text-blue-600 font-bold bg-blue-50 px-1.5 py-0.2 rounded border border-blue-150">Operator Verified</span>
                  </div>
                  <div class="space-y-1.5 text-[11px] text-slate-600 bg-slate-50 p-2.5 rounded border border-slate-150">
                    <div class="flex justify-between items-center">
                      <span>Standard Fare:</span>
                      <span class="font-extrabold text-slate-800">{{ line.fare }} MMK</span>
                    </div>
                    <div class="flex justify-between items-center">
                      <span>Operational Range:</span>
                      <span class="font-bold text-slate-700 text-[10px]">{{ line.operatingHours }}</span>
                    </div>
                    <div class="flex justify-between items-center">
                      <span>Average Frequency:</span>
                      <span class="font-bold text-slate-700">Every 8 - 12 Mins</span>
                    </div>
                  </div>
                </div>

              </div>
            </div>
          </div>
        </div>

        <!-- Tab 3: Station hubs List directory -->
        <div v-if="currentTab === 'stops'" class="flex-1 flex flex-col gap-3" id="view_stops_hub_card">
          <div class="border-b border-slate-100 pb-3 text-left">
            <h2 class="text-base font-bold text-slate-900 flex items-center gap-2">
              <MapPin class="w-4 h-4 text-blue-600" />
              Bus Station Directory
            </h2>
            <p class="text-xs text-slate-500 mt-1">Locate individual highway hubs and express junctions</p>
          </div>

          <!-- Stops Search entry field -->
          <div class="relative" id="stops_search_container">
            <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input 
              id="stop_filter_input"
              v-model="searchQuery" 
              type="text" 
              placeholder="Search by stop name (e.g. Sule, Hledan, Parami)..."
              class="w-full bg-white border border-slate-200 rounded-md py-2 pl-9 pr-4 text-xs text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <!-- Stations listing scrollboard -->
          <div class="flex-1 overflow-y-auto space-y-2.5 pr-1 max-h-[350px]" id="stops_scrolling_deck">
            <div 
              v-for="stop in filteredStops" 
              :key="stop.id"
              @click="handleSelectStop(stop.id)"
              :id="`stop_card_${stop.id}`"
              :class="[
                'p-3 rounded-lg border text-left transition cursor-pointer',
                selectedStopId === stop.id 
                  ? 'border-blue-600 border-l-4 rounded-r-md bg-blue-50/20 shadow-sm' 
                  : 'border-slate-200 bg-white hover:bg-slate-50'
              ]"
            >
              <div class="flex items-start justify-between gap-1.5">
                <div>
                  <h3 class="text-xs font-bold text-slate-800 flex items-center gap-1.5 flex-wrap">
                    <MapPin class="w-3.5 h-3.5 text-red-500" />
                    {{ stop.name }}
                    <span class="text-[9px] font-mono font-bold bg-slate-100 text-slate-500 px-1 py-0.2 rounded border border-slate-200">#{{ stop.id }}</span>
                  </h3>
                  <p class="text-[11px] text-blue-600 mt-0.5 italic font-semibold">{{ stop.nameMy }}</p>
                </div>

                <span class="text-[9px] font-bold bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded shrink-0 border border-slate-200/50">
                  {{ stop.lines.length }} Connections
                </span>
              </div>

              <!-- Passing routes lists on active focus stop -->
              <div v-if="selectedStopId === stop.id" class="mt-3 pt-2.5 border-t border-slate-100 text-slate-700">
                <div class="flex items-center justify-between mb-2">
                  <span class="text-[9px] font-black uppercase text-slate-400 tracking-wider">Passing Transit Lines</span>
                  <button 
                    id="bookmark_stop_btn"
                    @click.stop="toggleBookmark('stop', stop.id, stop.name)"
                    class="text-[10px] flex items-center gap-1 hover:text-blue-600 text-slate-500 transition"
                  >
                    <component :is="isBookmarked('stop', stop.id) ? BookmarkCheck : Bookmark" class="w-3.5 h-3.5 text-blue-600" />
                    {{ isBookmarked('stop', stop.id) ? 'Bookmarked' : 'Add Bookmark' }}
                  </button>
                </div>
                <div class="flex flex-wrap gap-1.5">
                  <span 
                    v-for="lineId in stop.lines" 
                    :key="lineId"
                    @click.stop="handleSelectLine(lineId)"
                    class="text-[10px] font-bold bg-white text-slate-700 px-2 py-1 rounded inline-flex items-center gap-1.5 hover:bg-slate-50 border border-slate-200 shadow-xs cursor-pointer"
                  >
                    <span 
                      class="w-2 h-2 rounded-full" 
                      :style="{ backgroundColor: BUS_LINES.find(bl => bl.id === lineId)?.color || '#2563eb' }"
                    ></span>
                    {{ BUS_LINES.find(bl => bl.id === lineId)?.name || lineId }}
                  </span>
                </div>

                <!-- Station Geographical Context -->
                <div class="mt-4 pt-3 border-t border-slate-100 text-left">
                  <div class="flex items-center justify-between mb-2">
                    <span class="text-[9px] font-black uppercase text-slate-400 tracking-wider">Station Geographical Info</span>
                    <span class="text-[9px] text-blue-600 font-bold bg-blue-50 px-1.5 py-0.2 rounded border border-blue-150">YBS Database</span>
                  </div>
                  <div class="space-y-1.5 text-[11px] text-slate-600 bg-slate-50 p-2.5 rounded border border-slate-150">
                    <div class="flex justify-between items-center font-mono">
                      <span>Latitude:</span>
                      <span class="font-bold text-slate-805">{{ stop.lat.toFixed(5) }}° N</span>
                    </div>
                    <div class="flex justify-between items-center font-mono">
                      <span>Longitude:</span>
                      <span class="font-bold text-slate-805">{{ stop.lng.toFixed(5) }}° E</span>
                    </div>
                    <div class="flex justify-between items-center text-slate-500">
                      <span>Station Type:</span>
                      <span class="font-semibold text-slate-800">Physical Bus Stop (Standard)</span>
                    </div>
                  </div>
                </div>

              </div>
            </div>
          </div>
        </div>

        <!-- Tab 4: AI Intelligent assistant dialog hub -->
        <div v-if="currentTab === 'assistant'" class="flex-1 flex flex-col gap-3" id="view_ai_assistant_card">
          <div class="border-b border-slate-100 pb-3 flex justify-between items-center text-left">
            <div>
              <h2 class="text-base font-bold text-slate-900 flex items-center gap-1.5">
                <Sparkles class="w-4 h-4 text-purple-600" />
                AI Commute Navigator
              </h2>
              <p class="text-[11px] text-slate-500 mt-0.5 font-sans">Secure directions proxy engine powered by Gemini AI</p>
            </div>
            <button 
              id="clear_chat_btn"
              @click="clearChat" 
              class="p-1 px-2 text-[10px] bg-slate-100 hover:bg-slate-200 text-slate-600 rounded border border-slate-200 flex items-center gap-1 transition"
              title="Clear talk archives"
            >
              <Trash2 class="w-3.5 h-3.5 text-slate-500" />
              Reset logs
            </button>
          </div>

          <!-- Message chat viewport -->
          <div 
            ref="chatContainer"
            class="flex-1 bg-slate-50 p-4 rounded-lg border border-slate-200/80 overflow-y-auto space-y-3.5 min-h-[220px] max-h-[300px]"
            id="ai_chat_scroller"
          >
            <div 
              v-for="(msg, mIdx) in assistantMessages" 
              :key="mIdx"
              :class="[
                'flex flex-col max-w-[85%] rounded-lg p-3 text-xs text-left shadow-xs transition-all',
                msg.role === 'user' 
                  ? 'bg-blue-600 text-white self-end ml-auto' 
                  : 'bg-white border border-slate-200 text-slate-800 self-start'
              ]"
            >
              <span 
                :class="[
                  'text-[9px] font-black uppercase tracking-wider mb-1.5',
                  msg.role === 'user' ? 'text-blue-100' : 'text-slate-400'
                ]"
              >
                {{ msg.role === 'user' ? 'Commuter Request' : 'YBS Intelligent Agent' }}
              </span>
              <p class="leading-relaxed whitespace-pre-wrap">{{ msg.text }}</p>
            </div>

            <!-- Wave Loader Spinner -->
            <div v-if="isAILoading" class="flex flex-col max-w-[80%] rounded-lg p-3 bg-white border border-slate-200 text-slate-800 self-start" id="ai_loader_card">
              <span class="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1.5 flex items-center gap-1">
                <Sparkles class="w-3 h-3 text-purple-600 animate-spin" />
                Querying transit matrices...
              </span>
              <div class="flex items-center gap-1.5 py-1">
                <div class="w-2 h-2 bg-blue-500 rounded-full animate-bounce"></div>
                <div class="w-2 h-2 bg-blue-500 rounded-full animate-bounce [animation-delay:0.2s]"></div>
                <div class="w-2 h-2 bg-blue-500 rounded-full animate-bounce [animation-delay:0.4s]"></div>
              </div>
            </div>
          </div>

          <!-- Suggested instant queries list -->
          <div class="space-y-1.5 text-left">
            <p class="text-[9px] font-black tracking-wider text-slate-400 uppercase px-1">Suggested Commutes</p>
            <div class="flex flex-wrap gap-1.5">
              <button 
                id="preset_ask_1"
                @click="handleQuickAsk('Sule ကနေ Shwe Pyi Thar ကို ဘယ် YBS ကတ်တွေ သွားလဲ?')"
                class="text-[10px] px-2.5 py-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200 transition text-left"
              >
                Sule to Shwe Pyi Thar?
              </button>
              <button 
                id="preset_ask_2"
                @click="handleQuickAsk('Where does YBS 21 go and what is the fare?')"
                class="text-[10px] px-2.5 py-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200 transition text-left"
              >
                YBS 21 route map?
              </button>
              <button 
                id="preset_ask_3"
                @click="handleQuickAsk('How to transfer from South Dagon to Hledan?')"
                class="text-[10px] px-2.5 py-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200 transition text-left"
              >
                South Dagon transfer?
              </button>
            </div>
          </div>

          <!-- Submit chat layout -->
          <form @submit.prevent="handleSendAIMessage" class="flex gap-2 bg-slate-50 p-1.5 rounded-lg border border-slate-200" id="ai_chat_form">
            <input 
              id="ai_chat_input_text"
              v-model="userMessage" 
              type="text" 
              placeholder="Ask transit questions in English or Burmese My..."
              class="flex-1 bg-transparent text-xs text-slate-800 px-2 focus:outline-none"
              :disabled="isAILoading"
            />
            <button 
              id="submit_ai_message_btn"
              type="submit" 
              class="p-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-md transition duration-200 disabled:opacity-50"
              :disabled="!userMessage.trim() || isAILoading"
            >
              <Send class="w-3.5 h-3.5" />
            </button>
          </form>
        </div>


      </section>

      <!-- RIGHT HAND INTERACTIVE STAGE (7 cols on lg screens in white shadow frame) -->
      <section class="lg:col-span-7 flex flex-col gap-4 bg-white p-5 rounded-xl border border-slate-200 shadow-sm h-[420px] lg:h-[650px]" id="ybs_right_stage_panel">
        
        <!-- Header Controls for live Map layer -->
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-50 p-3 rounded-lg border border-slate-200/60" id="map_stage_header">
          <div class="text-left">
            <h2 class="text-xs font-black tracking-widest text-slate-900 uppercase flex items-center gap-1.5">
              <MapIcon class="w-4 h-4 text-blue-600" />
              Live Commute Map Layer
            </h2>
            <p class="text-[11px] text-slate-500 mt-0.5 font-sans">Interact with stations on map and analyze routes</p>
          </div>

          <!-- Location Controls and center actions -->
          <div class="flex flex-wrap gap-1.5 justify-start sm:justify-end items-center">
            <!-- Locate user button -->
            <button 
              id="locate_user_btn_header"
              @click="startLocationTracking"
              :class="[
                'text-[10px] px-2.5 py-1.5 rounded border flex items-center gap-1.5 font-bold transition shadow-xs cursor-pointer',
                trackingLocation 
                  ? 'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100/60 font-sans' 
                  : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50 font-sans'
              ]"
            >
              <Compass class="w-3.5 h-3.5" :class="trackingLocation ? 'text-blue-600 animate-spin-slow' : 'text-slate-400'" />
              {{ trackingLocation ? 'GPS Tracking Active' : 'Start GPS' }}
            </button>

            <!-- Recenter pointer -->
            <button 
              id="recenter_to_user_btn_header"
              v-if="userLocation"
              @click="panToUserLocation"
              class="text-[10px] bg-white text-slate-700 border border-slate-200 p-1.5 rounded-md hover:bg-slate-50 transition cursor-pointer"
              title="Pan Map to My Location"
            >
              <Crosshair class="w-3.5 h-3.5 text-blue-600 font-sans" />
            </button>

            <button 
              id="center_map_btn"
              v-if="map"
              @click="map.setView([16.82, 96.155], 12)"
              class="text-[10px] bg-white px-2.5 py-1.5 rounded border border-slate-200 hover:bg-slate-50 text-slate-700 flex items-center gap-1.5 font-bold transition shadow-xs cursor-pointer"
            >
              <Navigation2 class="w-3.5 h-3.5 text-blue-600" />
              Center City View
            </button>
          </div>
        </div>

        <!-- LEAFLET MAP WORKSPACE STAGE wrapper container -->
        <div class="flex-1 bg-slate-100 rounded-lg overflow-hidden border border-slate-200 relative shadow-inner z-10" id="leaflet_wrapper_stage">
          <div id="leaflet-map-element" class="w-full h-full"></div>
          
          <!-- Sync loading overlay map placeholder -->
          <div v-if="!currentL" class="absolute inset-0 bg-slate-50/90 flex flex-col items-center justify-center text-slate-500 gap-3">
            <RefreshCw class="w-8 h-8 text-blue-600 animate-spin" />
            <p class="text-xs font-bold">Compiling high-performance routing layouts...</p>
          </div>
        </div>

        <!-- Selected Stop Inspector panel at bottom map -->
        <div class="flex flex-col sm:flex-row gap-3 bg-slate-50 p-3 rounded-lg border border-slate-200" id="map_stage_footer">
          <div class="flex-1 text-left">
            <span class="text-[9px] font-black text-slate-400 uppercase tracking-widest">Selected Station Inspector</span>
            <h3 v-if="selectedStopObject" class="text-xs font-bold text-blue-600 mt-1.5 flex items-center gap-1">
              <MapPin class="w-3.5 h-3.5 text-red-500" />
              {{ selectedStopObject.name }}
              <span class="text-[10px] text-slate-500">({{ selectedStopObject.nameMy }})</span>
            </h3>
            <p v-else class="text-xs text-slate-500 mt-1.5 font-medium">Click on any station pin above to perform diagnostic inspections.</p>
          </div>

          <!-- Stop summary details passives -->
          <div v-if="selectedStopObject" class="flex flex-col text-left justify-center sm:border-l sm:border-slate-200 sm:pl-3.5 min-w-[130px]">
            <span class="text-[9px] font-black text-slate-400 uppercase tracking-widest">Loop Connections</span>
            <div class="flex flex-wrap gap-1 mt-1.5">
              <span 
                v-for="l in selectedStopObject.lines" 
                :key="l"
                class="text-[9px] bg-white px-2 py-0.5 rounded text-slate-700 border border-slate-200 uppercase font-mono font-bold shadow-xs"
              >
                {{ BUS_LINES.find(bl => bl.id === l)?.name }}
              </span>
            </div>
          </div>
        </div>

      </section>

    </main>

    <!-- Professional metrics telemetry footer bar overlay -->
    <div class="bg-white border-t border-slate-200 py-3 px-6 shrink-0 shadow-xs mt-auto text-xs" id="ybs_applet_footer">
      <div class="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
        
        <!-- Transit metrics panel -->
        <div class="flex flex-wrap items-center gap-6 md:gap-10 w-full md:w-auto justify-between md:justify-start">
          <div class="flex flex-col text-left">
            <span class="text-[9px] text-slate-400 uppercase font-extrabold tracking-wider">Total Bus Lines</span>
            <span class="text-sm font-extrabold text-slate-900 flex items-center gap-1.5 mt-0.5">
              {{ BUS_LINES.length }} loops
              <span class="text-[10px] font-bold text-blue-600 bg-blue-50 px-1.5 py-0.2 rounded border border-blue-200">Enriched</span>
            </span>
          </div>
          <div class="w-px h-8 bg-slate-200 hidden sm:block"></div>
          <div class="flex flex-col text-left">
            <span class="text-[9px] text-slate-400 uppercase font-extrabold tracking-wider">Transit Station Hubs</span>
            <span class="text-sm font-extrabold text-slate-900 mt-0.5">{{ BUS_STOPS.length }} connections</span>
          </div>
          <div class="w-px h-8 bg-slate-200 hidden sm:block"></div>
          <div class="flex flex-col text-left">
            <span class="text-[9px] text-slate-400 uppercase font-extrabold tracking-wider">Fare Range</span>
            <span class="text-sm font-extrabold text-teal-600 flex items-center gap-1.5 mt-0.5">
              400 - 500 MMK
            </span>
          </div>
        </div>

        <!-- Utility refresh triggers -->
        <div class="flex flex-col sm:flex-row items-center gap-3 w-full md:w-auto justify-between md:justify-end border-t md:border-t-0 border-slate-100 pt-3 md:pt-0">
          <span class="text-[10px] font-mono text-slate-400 italic text-center sm:text-left">
            Powered by Secure Supabase Cloud DB Engine
          </span>
          <button 
            id="refresh_telemetry_footer_btn"
            @click="handleRefreshData"
            class="bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold px-4 py-1.5 rounded-lg shadow-sm transition-all flex items-center gap-1.5 w-full sm:w-auto justify-center cursor-pointer"
          >
            <RefreshCw class="w-3.5 h-3.5" />
            RESET VIEWS
          </button>
        </div>

      </div>
    </div>

    <!-- Beautiful Supabase Credentials Configurator Modal Overlay -->
    <div 
      v-if="showCredentialsModal" 
      class="fixed inset-0 z-[10000] flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4" 
      id="supabase_credentials_modal_backdrop"
    >
      <div 
        class="bg-white rounded-xl shadow-2xl border border-slate-200 max-w-md w-full overflow-hidden animate-in fade-in zoom-in-95 duration-150 text-left"
        id="supabase_credentials_modal_panel"
      >
        <!-- Modal Header -->
        <div class="bg-slate-900 text-white px-5 py-4 flex items-center justify-between">
          <div class="flex items-center gap-2.5">
            <Database class="w-5 h-5 text-blue-400" />
            <div>
              <h3 class="text-sm font-bold tracking-wide">Supabase Database Config</h3>
              <p class="text-[10px] text-slate-400 font-mono">Connect live cloud datasets dynamically</p>
            </div>
          </div>
          <button 
            @click="showCredentialsModal = false" 
            class="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-850 transition cursor-pointer"
            id="close_supabase_modal_btn"
          >
            <X class="w-4 h-4" />
          </button>
        </div>

        <!-- Modal Body Content -->
        <div class="p-5 space-y-4">
          
          <!-- Connection Status Card -->
          <div class="rounded-lg p-3.5 flex items-start gap-3 border text-xs" :class="[
            clientSupabaseConnected 
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800' 
              : 'bg-amber-50 border-amber-200 text-amber-800'
          ]">
            <MapPin class="w-5 h-5 shrink-0 mt-0.5" :class="clientSupabaseConnected ? 'text-emerald-650' : 'text-amber-600'" />
            <div class="space-y-0.5">
              <p class="font-bold">
                Status: {{ clientSupabaseConnected ? 'Active Cloud Connection' : 'Bypassed / Not Connected' }}
              </p>
              <p class="text-[11px] leading-relaxed opacity-90">
                {{ clientSupabaseConnected 
                  ? `Your browser is query-connected directly to your Supabase tables. Loaded ${BUS_STOPS.length} stops and ${BUS_LINES.length} line rules.`
                  : 'Currently relying on default server caches. Provide your Supabase URL and public anon key below to populate your application live.'
                }}
              </p>
            </div>
          </div>

          <!-- Form Fields -->
          <div class="space-y-3">
            <div class="flex flex-col gap-1 text-left">
              <label class="text-[10px] font-black uppercase text-slate-400 tracking-wider">Supabase API URL</label>
              <input 
                id="input_supabase_url"
                type="text" 
                v-model="clientSupabaseUrl"
                placeholder="https://your-project-id.supabase.co"
                class="w-full bg-slate-50 border border-slate-200 rounded-md py-2 px-3 text-xs text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
              />
            </div>
            
            <div class="flex flex-col gap-1 text-left">
              <label class="text-[10px] font-black uppercase text-slate-400 tracking-wider">Supabase Public Anon Key</label>
              <input 
                id="input_supabase_key"
                type="password" 
                v-model="clientSupabaseAnonKey"
                placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
                class="w-full bg-slate-50 border border-slate-200 rounded-md py-2 px-3 text-xs text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
              />
            </div>

            <!-- Divider Line -->
            <div class="border-t border-slate-100 my-2 pt-3 flex flex-col gap-2.5 text-left">
              <label class="text-[10px] font-black uppercase text-slate-400 tracking-wider flex items-center gap-1">
                <Sparkles class="w-3 h-3 text-blue-500 animate-pulse" />
                AI Assistant Core Settings
              </label>

              <!-- Choice selector toggle -->
              <div class="grid grid-cols-2 gap-1 bg-slate-100 p-0.5 rounded-md border border-slate-200/50">
                <button 
                  type="button"
                  @click="clientAiProvider = 'gemini'"
                  :class="[
                    'py-1 text-[10px] font-bold text-center rounded transition-all duration-150 cursor-pointer',
                    clientAiProvider === 'gemini' 
                      ? 'bg-white text-blue-680 shadow-xs border border-slate-200/50 font-extrabold' 
                      : 'text-slate-500 hover:text-slate-800'
                  ]"
                >
                  Google Gemini
                </button>
                <button 
                  type="button"
                  @click="clientAiProvider = 'groq'"
                  :class="[
                    'py-1 text-[10px] font-bold text-center rounded transition-all duration-150 cursor-pointer',
                    clientAiProvider === 'groq' 
                      ? 'bg-white text-violet-680 shadow-xs border border-slate-200/50 font-extrabold' 
                      : 'text-slate-500 hover:text-slate-800'
                  ]"
                >
                  Groq AI
                </button>
                <button 
                  type="button"
                  @click="clientAiProvider = 'openrouter'"
                  :class="[
                    'py-1 text-[10px] font-bold text-center rounded transition-all duration-150 cursor-pointer',
                    clientAiProvider === 'openrouter' 
                      ? 'bg-white text-orange-680 shadow-xs border border-slate-200/50 font-extrabold' 
                      : 'text-slate-500 hover:text-slate-800'
                  ]"
                >
                  OpenRouter
                </button>
                <button 
                  type="button"
                  @click="clientAiProvider = 'openai'"
                  :class="[
                    'py-1 text-[10px] font-bold text-center rounded transition-all duration-150 cursor-pointer',
                    clientAiProvider === 'openai' 
                      ? 'bg-white text-emerald-680 shadow-xs border border-slate-200/50 font-extrabold' 
                      : 'text-slate-500 hover:text-slate-800'
                  ]"
                >
                  OpenAI
                </button>
              </div>

              <!-- Gemini Settings -->
              <div v-if="clientAiProvider === 'gemini'" class="space-y-1.5 animate-in fade-in duration-100">
                <label class="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Gemini API Key</label>
                <input 
                  id="input_gemini_key"
                  type="password" 
                  v-model="clientGeminiApiKey"
                  placeholder="AIzaSy..."
                  class="w-full bg-slate-50 border border-slate-200 rounded-md py-2 px-3 text-xs text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                />
                <p class="text-[9px] text-slate-400 leading-normal">
                  Saved securely in your browser's local namespace. Overrides the backend proxy to allow direct AI travel recommendations. Get a free API key from the <a href="https://aistudio.google.com/app/apikey" target="_blank" class="text-blue-650 hover:text-blue-700 underline font-extrabold">Google AI Studio Console</a>.
                </p>
              </div>

              <!-- Groq Settings -->
              <div v-else-if="clientAiProvider === 'groq'" class="space-y-1.5 animate-in fade-in duration-100">
                <label class="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Groq API Key</label>
                <input 
                  id="input_groq_key"
                  type="password" 
                  v-model="clientGroqApiKey"
                  placeholder="gsk_..."
                  class="w-full bg-slate-50 border border-slate-200 rounded-md py-2 px-3 text-xs text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500 font-mono"
                />
                <p class="text-[9px] text-slate-400 leading-normal">
                  Execute supercharged reasoning via Llama-3.3-70b-versatile directly. Get a free Groq key from the <a href="https://console.groq.com/keys" target="_blank" class="text-violet-650 hover:text-violet-700 underline font-extrabold">Groq Console</a>.
                </p>
              </div>

              <!-- OpenRouter Settings -->
              <div v-else-if="clientAiProvider === 'openrouter'" class="space-y-1.5 animate-in fade-in duration-100">
                <label class="text-[10px] font-bold text-slate-400 uppercase tracking-wider">OpenRouter API Key</label>
                <input 
                  id="input_openrouter_key"
                  type="password" 
                  v-model="clientOpenRouterApiKey"
                  placeholder="sk-or-v1-..."
                  class="w-full bg-slate-50 border border-slate-200 rounded-md py-2 px-3 text-xs text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-orange-500 font-mono"
                />
                <p class="text-[9px] text-slate-400 leading-normal">
                  Connect to free server endpoints such as <strong class="text-slate-600 font-extrabold">google/gemini-2.5-flash:free</strong>. Create an account and get a free key from the <a href="https://openrouter.ai/keys" target="_blank" class="text-orange-655 hover:text-orange-700 underline font-extrabold">OpenRouter Console</a>.
                </p>
              </div>

              <!-- OpenAI Settings -->
              <div v-else class="space-y-1.5 animate-in fade-in duration-100">
                <label class="text-[10px] font-bold text-slate-400 uppercase tracking-wider">OpenAI API Key</label>
                <input 
                  id="input_openai_key"
                  type="password" 
                  v-model="clientOpenaiApiKey"
                  placeholder="sk-proj-..."
                  class="w-full bg-slate-50 border border-slate-200 rounded-md py-2 px-3 text-xs text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500 font-mono"
                />
                <p class="text-[9px] text-slate-400 leading-normal">
                  Direct routing queries through standard <strong class="text-slate-600 font-extrabold">gpt-4o-mini</strong>. Get a developer key from your <a href="https://platform.openai.com/api-keys" target="_blank" class="text-emerald-650 hover:text-emerald-700 underline font-extrabold">OpenAI Developer Console</a>.
                </p>
              </div>
            </div>
          </div>

          <!-- Error Alert Banner -->
          <div v-if="clientSupabaseError" class="bg-red-50 border border-red-200 rounded-lg p-3 text-xs text-red-800 space-y-1.5 leading-snug">
            <div class="font-bold flex items-center gap-1.5">
              <Info class="w-4 h-4 shrink-0" />
              Connection Failed
            </div>
            <p class="text-[11px] opacity-90 font-mono">{{ clientSupabaseError }}</p>
          </div>

          <!-- Information Help Notes -->
          <div class="bg-slate-50 border border-slate-150 rounded-lg p-3 text-[11px] text-slate-500 leading-relaxed space-y-1">
            <p class="font-bold text-slate-705">Requirements for Database Schema:</p>
            <ul class="list-disc pl-4 space-y-0.5">
              <li>Must contain table <code class="font-mono bg-slate-100 text-slate-700 px-1 py-0.2 rounded border">ybs_stops</code></li>
              <li>Must contain table <code class="font-mono bg-slate-100 text-slate-700 px-1 py-0.2 rounded border">ybs_lines</code></li>
            </ul>
          </div>

        </div>

        <!-- Modal Footer Actions -->
        <div class="bg-slate-50 px-5 py-4 border-t border-slate-100 flex items-center justify-between gap-3">
          <button 
            type="button"
            id="clear_supabase_creds_btn"
            @click="clearClientSupabase"
            class="px-3.5 py-2 text-xs font-bold text-slate-600 hover:text-red-650 bg-white hover:bg-slate-100 border border-slate-200 rounded-md transition cursor-pointer"
            :disabled="!clientSupabaseUrl && !clientSupabaseAnonKey"
          >
            Disconnect Credentials
          </button>
          
          <div class="flex items-center gap-2">
            <button 
              type="button" 
              id="cancel_supabase_modal_btn"
              @click="showCredentialsModal = false"
              class="px-3.5 py-2 text-xs font-bold text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-md transition cursor-pointer"
            >
              Cancel
            </button>
            
            <button 
              type="button"
              id="save_supabase_creds_btn"
              @click="testAndSaveClientSupabase"
              class="px-4 py-2 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-md shadow-xs transition flex items-center gap-1.5 cursor-pointer"
              :disabled="isTestingConnection"
            >
              <RefreshCw v-if="isTestingConnection" class="w-3.5 h-3.5 animate-spin" />
              <Check v-else-if="connectionTestSuccess" class="w-3.5 h-3.5 text-emerald-355" />
              {{ isTestingConnection ? 'Verifying...' : (connectionTestSuccess ? 'Connected!' : 'Test & Save') }}
            </button>
          </div>
        </div>

      </div>
    </div>

  </div>
</template>

<style>
/* Leaflet popup customization to match Professional Polish aesthetic specs */
.leaflet-popup-content-wrapper {
  background: #ffffff !important; 
  color: #0f172a !important; 
  border: 1px solid #e2e8f0 !important; 
  border-radius: 8px !important;
  box-shadow: 0 4px 12px rgba(15, 23, 42, 0.08) !important;
}
.leaflet-popup-tip {
  background: #ffffff !important;
}
.leaflet-popup-content {
  margin: 10px 14px !important;
}
</style>
