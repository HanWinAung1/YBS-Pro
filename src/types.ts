export interface BusLine {
  id: string;
  name: string;
  operator: string;
  startStop: string;
  endStop: string;
  stops: string[]; // Ordered list of stop IDs
  fare: number;
  operatingHours: string;
  color: string;
  coordinates: [number, number][]; // Route path coordinates
}

export interface BusStop {
  id: string;
  name: string;
  nameMy: string; // Burmese text for authenticity
  lat: number;
  lng: number;
  lines: string[]; // BusLine IDs
}

export interface UserBookmark {
  id: string;
  type: 'line' | 'stop' | 'route';
  itemId: string; // Line ID, Stop ID, or a string key for route e.g. "stopA-stopB"
  title: string;
  createdAt: string;
  customLabel?: string;
  notes?: string;
}

export interface RouteStep {
  type: 'board' | 'transfer' | 'walk' | 'arrive';
  description: string;
  lineId?: string;
  stopId?: string;
  duration: number; // in minutes
}

export interface RoutingResult {
  type: 'direct' | 'one-transfer' | 'walk-only' | 'none';
  steps: RouteStep[];
  totalDuration: number;
  totalFare: number;
  transferStopId?: string;
}

export interface YBSVehicle {
  id: string; // unique identifier
  carNumber: string; // fleet number e.g. "YBS-1-085" or "085"
  licensePlate: string; // actual DMV plate e.g. "YGN 3H-8492"
  lineId: string; // which bus line it belongs to
  lastStopId: string; // last passed stop ID
  nextStopId: string; // next upcoming stop ID
  lat: number;
  lng: number;
  speed: number; // km/h
  passengerLoad: 'Low' | 'Medium' | 'High' | 'Full';
  status: 'On Time' | 'Delayed' | 'Ahead of Schedule';
}

