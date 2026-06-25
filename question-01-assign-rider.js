/**
 * Question 1: Smart & Stale Rider Assignment
 * Fullstack Developer — Food Delivery Platform
 */

const STALE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes
const TIE_BREAKER_METERS = 500;
const INITIAL_RADIUS_KM = 5;
const EXPANSION_RADII_KM = [7.5, 10, 15]; // progressive fallback radii
const MAX_RADIUS_KM = 15;

const EARTH_RADIUS_KM = 6371;

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

/**
 * Haversine formula — distance in kilometers between two lat/lng points.
 */
function haversineDistanceKm(lat1, lng1, lat2, lng2) {
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLng / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

function isStaleRider(rider, now = Date.now()) {
  const lastUpdate = new Date(rider.lastLocationUpdate).getTime();
  return now - lastUpdate > STALE_THRESHOLD_MS;
}

function enrichRiderWithDistance(rider, restaurant) {
  const distanceKm = haversineDistanceKm(
    rider.location.lat,
    rider.location.lng,
    restaurant.lat,
    restaurant.lng
  );
  return { rider, distanceKm };
}

function filterByRadius(candidates, radiusKm) {
  return candidates.filter((c) => c.distanceKm <= radiusKm);
}

/**
 * Tie-breaker: among riders within 500m of the closest one, pick highest rating.
 */
function selectBestCandidate(candidates) {
  const minDistanceKm = Math.min(...candidates.map((c) => c.distanceKm));
  const tieThresholdKm = minDistanceKm + TIE_BREAKER_METERS / 1000;

  const tiedCandidates = candidates.filter(
    (c) => c.distanceKm <= tieThresholdKm
  );

  tiedCandidates.sort((a, b) => {
    if (b.rider.rating !== a.rider.rating) {
      return b.rider.rating - a.rider.rating;
    }
    return a.distanceKm - b.distanceKm; // secondary tie-break: closer wins
  });

  return tiedCandidates[0];
}

/**
 * Radius expansion when no rider is found within 5 km.
 * Returns { candidates, searchRadiusKm, expanded }.
 */
function findCandidatesWithExpansion(candidatesWithDistance) {
  let searchRadiusKm = INITIAL_RADIUS_KM;
  let candidates = filterByRadius(candidatesWithDistance, searchRadiusKm);

  if (candidates.length > 0) {
    return { candidates, searchRadiusKm, expanded: false };
  }

  for (const radiusKm of EXPANSION_RADII_KM) {
    candidates = filterByRadius(candidatesWithDistance, radiusKm);
    if (candidates.length > 0) {
      return { candidates, searchRadiusKm: radiusKm, expanded: true };
    }
    searchRadiusKm = radiusKm;
  }

  return { candidates: [], searchRadiusKm: MAX_RADIUS_KM, expanded: true };
}

/**
 * Assign the best available rider to an order.
 *
 * @param {object} order - { restaurant: { lat, lng }, ... }
 * @param {object[]} riders - [{ id, location: { lat, lng }, rating, lastLocationUpdate }, ...]
 * @param {object} [options] - { now?: number }
 * @returns {object} assignment result
 */
function assignRider(order, riders, options = {}) {
  const now = options.now ?? Date.now();
  const restaurant = order.restaurant;

  const activeRiders = riders.filter((rider) => !isStaleRider(rider, now));

  if (activeRiders.length === 0) {
    return {
      rider: null,
      status: 'FALLBACK',
      reason: 'ALL_RIDERS_STALE',
      message:
        'No rider with fresh GPS data. Queue order and retry assignment every 30s.',
    };
  }

  const candidatesWithDistance = activeRiders.map((rider) =>
    enrichRiderWithDistance(rider, restaurant)
  );

  const { candidates, searchRadiusKm, expanded } =
    findCandidatesWithExpansion(candidatesWithDistance);

  if (candidates.length === 0) {
    return {
      rider: null,
      status: 'FALLBACK',
      reason: 'NO_RIDER_IN_MAX_RADIUS',
      searchRadiusKm: MAX_RADIUS_KM,
      message:
        'No rider within 15 km. Fallback: notify customer of delay, offer cancel/reschedule, or escalate to manual dispatch.',
    };
  }

  const best = selectBestCandidate(candidates);

  return {
    rider: best.rider,
    distanceKm: Number(best.distanceKm.toFixed(3)),
    searchRadiusKm,
    expanded,
    status: expanded ? 'ASSIGNED_EXPANDED_RADIUS' : 'ASSIGNED',
  };
}

module.exports = {
  assignRider,
  haversineDistanceKm,
  isStaleRider,
  STALE_THRESHOLD_MS,
  TIE_BREAKER_METERS,
  INITIAL_RADIUS_KM,
};
