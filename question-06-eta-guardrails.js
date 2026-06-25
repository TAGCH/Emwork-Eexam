/** Question 6: ETA Validation Guardrails (Code) */

/**
 * Post-processing guardrails when AI ETA prediction fails sanity checks.
 */

const WEATHER_SPEED_KMH = {
  clear: 25,
  rain: 20,
  heavy_rain: 15,
};

function ruleBasedEta(input) {
  const { distance_km, weather, restaurant_prep_minutes, rush_hour } = input;
  const speed = WEATHER_SPEED_KMH[weather.condition] ?? 20;
  const travelMinutes = Math.ceil((distance_km / speed) * 60);
  const weatherBuffer = weather.condition === 'heavy_rain' ? 15 : weather.condition === 'rain' ? 5 : 0;
  const rushBuffer = rush_hour ? 5 : 0;

  const eta = restaurant_prep_minutes + travelMinutes + weatherBuffer + rushBuffer;
  const margin = Math.ceil(eta * 0.15);

  return {
    eta_minutes: eta,
    eta_range: { min: eta - margin, max: eta + margin },
    source: 'rule_based_fallback',
  };
}

function validateEta(aiResult, input) {
  const { distance_km, weather, restaurant_prep_minutes } = input;
  const eta = aiResult.eta_minutes;

  const floor = Math.ceil((distance_km / 30) * 60) + restaurant_prep_minutes;
  const ceiling = Math.ceil((distance_km / 10) * 60) + restaurant_prep_minutes + 30;

  const errors = [];
  if (eta < floor) errors.push(`ETA ${eta} below floor ${floor}`);
  if (eta > ceiling) errors.push(`ETA ${eta} above ceiling ${ceiling}`);
  if (distance_km >= 10 && eta < 35) errors.push('10km+ requires ETA >= 35');
  if (weather.condition === 'heavy_rain' && eta < floor + 15) {
    errors.push('heavy_rain requires +15 min buffer');
  }

  return { valid: errors.length === 0, errors, floor, ceiling };
}

function getDeliveryEta(input, aiResult) {
  const validation = validateEta(aiResult, input);

  if (!validation.valid || aiResult.confidence === 'low') {
    const fallback = ruleBasedEta(input);
    return {
      ...fallback,
      guardrail_triggered: true,
      validation_errors: validation.errors,
      rejected_ai_eta: aiResult.eta_minutes,
    };
  }

  return {
    eta_minutes: aiResult.eta_minutes,
    eta_range: aiResult.eta_range,
    source: 'ai',
    guardrail_triggered: false,
  };
}

module.exports = { validateEta, ruleBasedEta, getDeliveryEta };
