/**
 * Question 7: Surge Pricing — Hard-coded Guardrails
 * AI suggests multiplier; Guardrails Engine has final authority.
 */

const POLICY = {
  MAX_SURGE_MULTIPLIER: 2.0,       // G1: ไม่เกิน 2x ค่าส่งปกติ
  MAX_ABSOLUTE_FEE_THB: 150,       // G2: เพดานราคาสูงสุด
  MAX_STEP_INCREASE: 0.3,          // G3: เพิ่มได้ไม่เกิน 0.3x ต่อรอบ
  STEP_WINDOW_MINUTES: 5,
  CONSENT_THRESHOLD: 1.5,          // G7: เกิน 1.5x ต้องให้ลูกค้ายืนยัน
  MIN_RIDERS_FOR_SURGE: 3,           // G4: rider น้อยกว่านี้ไม่ surge
  EMERGENCY_FREEZE: false,           // G5: เปิดเมื่อภัยพิบัติ
};

function applySurgeGuardrails({
  baseFee,
  aiSuggestedMultiplier,
  availableRiders,
  previousMultiplier = 1.0,
  emergencyMode = false,
}) {
  const audit = {
    ai_suggested_multiplier: aiSuggestedMultiplier,
    guardrails_applied: [],
    final_multiplier: aiSuggestedMultiplier,
    final_fee: 0,
    requires_customer_consent: false,
    blocked: false,
    block_reason: null,
  };

  // G5: Emergency freeze
  if (emergencyMode || POLICY.EMERGENCY_FREEZE) {
    audit.final_multiplier = 1.0;
    audit.final_fee = baseFee;
    audit.guardrails_applied.push('G5_emergency_freeze');
    return audit;
  }

  // G4: Insufficient rider data
  if (availableRiders < POLICY.MIN_RIDERS_FOR_SURGE) {
    audit.final_multiplier = 1.0;
    audit.final_fee = baseFee;
    audit.guardrails_applied.push('G4_insufficient_riders');
    audit.block_reason = `Riders ${availableRiders} < min ${POLICY.MIN_RIDERS_FOR_SURGE}`;
    return audit;
  }

  let multiplier = aiSuggestedMultiplier;

  // G1: Max surge cap
  if (multiplier > POLICY.MAX_SURGE_MULTIPLIER) {
    audit.guardrails_applied.push(`G1_capped_${multiplier}_to_${POLICY.MAX_SURGE_MULTIPLIER}`);
    multiplier = POLICY.MAX_SURGE_MULTIPLIER;
  }

  // G3: Gradual increase — prevent price spike
  const maxAllowed = previousMultiplier + POLICY.MAX_STEP_INCREASE;
  if (multiplier > maxAllowed) {
    audit.guardrails_applied.push(`G3_gradual_cap_${multiplier}_to_${maxAllowed}`);
    multiplier = maxAllowed;
  }

  // Minimum floor
  multiplier = Math.max(1.0, multiplier);

  let finalFee = Math.round(baseFee * multiplier * 100) / 100;

  // G2: Absolute fee ceiling
  if (finalFee > POLICY.MAX_ABSOLUTE_FEE_THB) {
    audit.guardrails_applied.push(`G2_fee_capped_${finalFee}_to_${POLICY.MAX_ABSOLUTE_FEE_THB}`);
    finalFee = POLICY.MAX_ABSOLUTE_FEE_THB;
    multiplier = finalFee / baseFee;
  }

  // G7: Consent required
  if (multiplier > POLICY.CONSENT_THRESHOLD) {
    audit.requires_customer_consent = true;
    audit.guardrails_applied.push('G7_consent_required');
  }

  audit.final_multiplier = multiplier;
  audit.final_fee = finalFee;

  return audit;
}

/**
 * Build customer-facing price breakdown (G6: Transparency)
 */
function buildPriceDisplay(baseFee, audit, surgeReason) {
  const surgeAmount = audit.final_fee - baseFee;

  return {
    base_delivery_fee: baseFee,
    surge_multiplier: audit.final_multiplier,
    surge_amount: surgeAmount,
    total_delivery_fee: audit.final_fee,
    surge_reason: surgeReason,
    requires_confirmation: audit.requires_customer_consent,
    display_message:
      audit.final_multiplier > 1.0
        ? `ค่าส่งปกติ ${baseFee} บาท → ค่าส่งช่วงเร่งด่วน ${audit.final_fee} บาท (x${audit.final_multiplier})`
        : `ค่าส่ง ${baseFee} บาท`,
    audit_log: audit,
  };
}

// Example: AI suggests 2.8x on 35 THB base
const result = applySurgeGuardrails({
  baseFee: 35,
  aiSuggestedMultiplier: 2.8,
  availableRiders: 14,
  previousMultiplier: 1.2,
});

const display = buildPriceDisplay(35, result, 'ออเดอร์มาก ไรเดอร์น้อย ฝนตกหนัก');

module.exports = { applySurgeGuardrails, buildPriceDisplay, POLICY };
