import { RoutingResult, RouteStep, BusStop, BusLine } from '../types';

const BUS_STOPS: BusStop[] = [];
const BUS_LINES: BusLine[] = [];

// Helper to check if a stop is before another in a line's route
function getIndex(stops: string[], stopId: string): number {
  return stops.indexOf(stopId);
}

export function findRoutes(
  startStopId: string, 
  endStopId: string, 
  customStops?: BusStop[], 
  customLines?: BusLine[]
): RoutingResult[] {
  if (!startStopId || !endStopId || startStopId === endStopId) {
    return [];
  }

  const activeStops = customStops || BUS_STOPS;
  const activeLines = customLines || BUS_LINES;

  // Build high-speed Map for O(1) stop lookups
  const stopsMap = new Map<string, BusStop>();
  activeStops.forEach(s => {
    if (s && s.id) {
      stopsMap.set(s.id, s);
    }
  });

  function getStopName(id: string): string {
    const stop = stopsMap.get(id);
    return stop ? stop.name : id;
  }

  const results: RoutingResult[] = [];

  // 1. Direct Routes Search
  for (const line of activeLines) {
    if (!line || !Array.isArray(line.stops)) continue;
    
    const startIndex = getIndex(line.stops, startStopId);
    const endIndex = getIndex(line.stops, endStopId);

    if (startIndex !== -1 && endIndex !== -1 && startIndex !== endIndex) {
      // Calculate stops traveled
      const stopsTraveled = Math.abs(endIndex - startIndex);
      const duration = stopsTraveled * 5; // Roughly 5 minutes per stop (optimized)

      const steps: RouteStep[] = [
        {
          type: 'board',
          description: `Board ${line.name} heading ${startIndex < endIndex ? 'towards ' + getStopName(line.stops[line.stops.length-1]) : 'towards ' + getStopName(line.stops[0])} at ${getStopName(startStopId)}`,
          lineId: line.id,
          stopId: startStopId,
          duration: 2
        },
        {
          type: 'transfer',
          description: `Ride ${line.name} for ${stopsTraveled} stops`,
          lineId: line.id,
          duration
        },
        {
          type: 'arrive',
          description: `Arrive at ${getStopName(endStopId)}`,
          stopId: endStopId,
          duration: 0
        }
      ];

      results.push({
        type: 'direct',
        steps,
        totalDuration: duration + 2,
        totalFare: line.fare
      });
    }
  }

  // Helper to find same/connected stations in Line B stops
  function findMatchingStopInLine(
    stopIdA: string,
    lineBStops: string[],
    lineBStopsSet: Set<string>
  ): { stopIdB: string; distanceWalkMetres: number } | null {
    if (!lineBStops || !Array.isArray(lineBStops)) return null;

    // 1. Direct exact ID match (highest priority, no walk distance, O(1) lookup)
    if (lineBStopsSet.has(stopIdA)) {
      return { stopIdB: stopIdA, distanceWalkMetres: 0 };
    }

    // 2. Name-based or proximity match
    const stopA = stopsMap.get(stopIdA);
    if (!stopA) return null;

    const nameA = (stopA.name || '').trim().toLowerCase();
    const latA = typeof stopA.lat === 'number' ? stopA.lat : parseFloat(stopA.lat as any);
    const lngA = typeof stopA.lng === 'number' ? stopA.lng : parseFloat(stopA.lng as any);
    const hasCoordsA = !isNaN(latA) && !isNaN(lngA);

    for (const stopIdB of lineBStops) {
      if (stopIdB === stopIdA) continue;
      const stopB = stopsMap.get(stopIdB);
      if (!stopB) continue;

      // Check for exact identical name (case-insensitive, non-empty)
      const nameB = (stopB.name || '').trim().toLowerCase();
      if (nameA === nameB && nameA !== '') {
        return { stopIdB, distanceWalkMetres: 40 }; // 40m nominal walk space
      }

      // Check proximity via coordinates (very small Euclidean distance)
      if (hasCoordsA) {
        const latB = typeof stopB.lat === 'number' ? stopB.lat : parseFloat(stopB.lat as any);
        const lngB = typeof stopB.lng === 'number' ? stopB.lng : parseFloat(stopB.lng as any);

        if (!isNaN(latB) && !isNaN(lngB)) {
          const dx = latA - latB;
          const dy = lngA - lngB;
          const distanceSq = dx * dx + dy * dy;
          
          // 0.003 degrees is ~300 meters
          if (distanceSq < 0.000009) {
            const distanceMetres = Math.round(Math.sqrt(distanceSq) * 111000);
            return { stopIdB, distanceWalkMetres: distanceMetres };
          }
        }
      }
    }

    return null;
  }

  // 2. One-Transfer Routes Search
  const startingLines = activeLines.filter(l => l.stops && l.stops.includes(startStopId));
  const endingLines = activeLines.filter(l => l.stops && l.stops.includes(endStopId));

  for (const lineA of startingLines) {
    const startIndexA = getIndex(lineA.stops, startStopId);

    for (const lineB of endingLines) {
      if (lineA.id === lineB.id) continue; // Direct already handled

      const endIndexB = getIndex(lineB.stops, endStopId);
      const lineBStopsSet = new Set(lineB.stops);

      // Find intersection stops
      for (const transferStopId of lineA.stops) {
        // Skip start or end stop
        if (transferStopId === startStopId || transferStopId === endStopId) continue;

        const match = findMatchingStopInLine(transferStopId, lineB.stops, lineBStopsSet);
        if (!match) continue;

        const { stopIdB, distanceWalkMetres } = match;
        const transferIndexA = getIndex(lineA.stops, transferStopId);
        const transferIndexB = getIndex(lineB.stops, stopIdB);

        if (
          transferIndexA !== -1 && 
          transferIndexB !== -1 &&
          startIndexA !== transferIndexA &&
          transferIndexB !== endIndexB
        ) {
          // Valid transfer route!
          const stopsA = Math.abs(transferIndexA - startIndexA);
          const stopsB = Math.abs(endIndexB - transferIndexB);
          const durationA = stopsA * 5;
          const durationB = stopsB * 5;
          const transferWait = 6; // Wait time for high-frequency YBS lines

          const steps: RouteStep[] = [
            {
              type: 'board',
              description: `Board ${lineA.name} heading ${startIndexA < transferIndexA ? 'towards ' + getStopName(lineA.stops[lineA.stops.length-1]) : 'towards ' + getStopName(lineA.stops[0])} at ${getStopName(startStopId)}`,
              lineId: lineA.id,
              stopId: startStopId,
              duration: 2
            },
            {
              type: 'walk',
              description: `Ride ${lineA.name} for ${stopsA} stops to transfer hub`,
              lineId: lineA.id,
              duration: durationA
            },
            {
              type: 'transfer',
              description: distanceWalkMetres > 0 
                ? `De-board at ${getStopName(transferStopId)} and walk ${distanceWalkMetres}m to connected ${getStopName(stopIdB)} for transfer`
                : `De-board at ${getStopName(transferStopId)} and wait for ${lineB.name}`,
              stopId: transferStopId,
              duration: transferWait + Math.round(distanceWalkMetres / 80)
            },
            {
              type: 'board',
              description: `Board ${lineB.name} heading ${transferIndexB < endIndexB ? 'towards ' + getStopName(lineB.stops[lineB.stops.length-1]) : 'towards ' + getStopName(lineB.stops[0])} at ${getStopName(stopIdB)}`,
              lineId: lineB.id,
              stopId: stopIdB,
              duration: 2
            },
            {
              type: 'walk',
              description: `Ride ${lineB.name} for ${stopsB} stops to destination`,
              lineId: lineB.id,
              duration: durationB
            },
            {
              type: 'arrive',
              description: `Arrive at destination ${getStopName(endStopId)}`,
              stopId: endStopId,
              duration: 0
            }
          ];

          results.push({
            type: 'one-transfer',
            steps,
            totalDuration: durationA + durationB + transferWait + 4 + Math.round(distanceWalkMetres / 80),
            totalFare: lineA.fare + lineB.fare,
            transferStopId
          });
        }
      }
    }
  }

  // Sort results: Direct first, then by total duration
  return results.sort((a, b) => {
    if (a.type === 'direct' && b.type !== 'direct') return -1;
    if (a.type !== 'direct' && b.type === 'direct') return 1;
    return a.totalDuration - b.totalDuration;
  });
}
