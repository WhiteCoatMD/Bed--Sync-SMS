/**
 * Lightweight US ZIP-code geocoding + nearest-store routing.
 *
 * Used by the inbound SMS webhook to route a cold texter (no existing lead,
 * no keyword, no known prospect) to the store nearest them. Turns a ZIP into
 * lat/lng via Zippopotam (free, no API key), then picks the closest active
 * dealer that has coordinates saved in settings.lat / settings.lng.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

/** Pull the first standalone 5-digit group out of a message ("my zip is 34102" -> "34102"). */
export function extractZip(text: string): string | null {
  const m = (text || '').match(/\b(\d{5})\b/);
  return m ? m[1] : null;
}

/** Turn a US ZIP into coordinates. Returns null for invalid/unknown ZIPs. */
export async function geocodeZip(zip: string): Promise<LatLng | null> {
  const clean = (zip || '').trim().slice(0, 5);
  if (!/^\d{5}$/.test(clean)) return null;
  try {
    const res = await fetch(`https://api.zippopotam.us/us/${clean}`);
    if (!res.ok) return null;
    const data = await res.json();
    const place = data?.places?.[0];
    if (!place) return null;
    const lat = parseFloat(place.latitude);
    const lng = parseFloat(place.longitude);
    if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
    return { lat, lng };
  } catch {
    return null;
  }
}

/** Great-circle distance between two points, in miles. */
export function haversineMiles(a: LatLng, b: LatLng): number {
  const R = 3958.8; // Earth radius in miles
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Nearest active dealer to `origin` among those with coordinates in
 * settings.lat / settings.lng. Dealers without coordinates are ignored.
 */
export function nearestDealer<T extends { settings?: any }>(
  origin: LatLng,
  dealers: T[]
): T | null {
  let best: T | null = null;
  let bestDist = Infinity;
  for (const d of dealers) {
    const lat = d.settings?.lat;
    const lng = d.settings?.lng;
    if (typeof lat !== 'number' || typeof lng !== 'number') continue;
    const dist = haversineMiles(origin, { lat, lng });
    if (dist < bestDist) {
      bestDist = dist;
      best = d;
    }
  }
  return best;
}
