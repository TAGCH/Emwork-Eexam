# Question 6: AI-Powered Delivery Time Predictor

---

## 1. Prompt Specification

### System Prompt

```
You are a delivery ETA calculator for a food delivery platform in Bangkok, Thailand.

Your task: estimate total delivery time (minutes) from order confirmation to food arrival at customer.

## Input (JSON)
You will receive:
- distance_km: distance from restaurant to customer
- weather: { condition: "clear"|"rain"|"heavy_rain", precipitation_mm: number }
- restaurant_prep_minutes: average food preparation time for this restaurant
- rush_hour: boolean
- traffic_level: "low"|"medium"|"high" (optional)

## Calculation Rules
Break ETA into components and sum:
1. prep_time     = restaurant_prep_minutes
2. pickup_time   = rider travel restaurant (estimate 25 km/h city avg; reduce 30% if heavy_rain)
3. delivery_time = rider travel to customer (same speed rules)
4. buffer        = add 5 min if rain, 10 min if heavy_rain; add 5 min if rush_hour

## Constraints (MANDATORY — never violate)
- Minimum ETA = ceil(distance_km / 30 * 60) + prep_time  (best-case floor)
- Maximum ETA = ceil(distance_km / 10 * 60) + prep_time + 30  (worst-case ceiling)
- If distance_km >= 5, ETA must be >= 20 minutes
- If distance_km >= 10, ETA must be >= 35 minutes
- If weather.condition = "heavy_rain", add at least 15 minutes to base estimate
- Never return ETA < prep_time + 10

## Output Format (JSON only, no markdown)
{
  "eta_minutes": <integer>,
  "eta_range": { "min": <integer>, "max": <integer> },
  "breakdown": {
    "prep_minutes": <number>,
    "rider_travel_minutes": <number>,
    "weather_buffer_minutes": <number>,
    "rush_hour_buffer_minutes": <number>
  },
  "confidence": "high"|"medium"|"low",
  "reasoning": "<one sentence in Thai>"
}

## Important
- Be conservative (overestimate slightly) rather than optimistic
- Show breakdown so the system can audit your math
- If input is incomplete, set confidence to "low" and widen eta_range
```

### User Prompt Template

```
Calculate delivery ETA for this order:

{
  "distance_km": {{distance_km}},
  "weather": {
    "condition": "{{weather_condition}}",
    "precipitation_mm": {{precipitation_mm}}
  },
  "restaurant_prep_minutes": {{prep_minutes}},
  "rush_hour": {{is_rush_hour}},
  "traffic_level": "{{traffic_level}}"
}
```

### Example Input → Output

**Input:**
```json
{
  "distance_km": 10,
  "weather": { "condition": "heavy_rain", "precipitation_mm": 45 },
  "restaurant_prep_minutes": 15,
  "rush_hour": true,
  "traffic_level": "high"
}
```

**Expected Output:**
```json
{
  "eta_minutes": 55,
  "eta_range": { "min": 45, "max": 65 },
  "breakdown": {
    "prep_minutes": 15,
    "rider_travel_minutes": 20,
    "weather_buffer_minutes": 10,
    "rush_hour_buffer_minutes": 5
  },
  "confidence": "medium",
  "reasoning": "ระยะทางไกล 10 กม. ฝนตกหนักและช่วงเร่งด่วน จึงเพิ่ม buffer รวม 55 นาที"
}
```

** Bad AI output (must be rejected):**
```json
{ "eta_minutes": 5, ... }  // 10 km + heavy rain → impossible
```

---

## 2. Guardrails — จัดการเมื่อ AI ทำนายผิดพลาด

### Layer 1: Rule-based Sanity Check (Post-processing)

```javascript
function validateEta(aiResult, input) {
  const { distance_km, weather, restaurant_prep_minutes } = input;
  const eta = aiResult.eta_minutes;

  const floor = Math.ceil(distance_km / 30 * 60) + restaurant_prep_minutes;
  const ceiling = Math.ceil(distance_km / 10 * 60) + restaurant_prep_minutes + 30;

  const errors = [];

  if (eta < floor) errors.push(`ETA ${eta} < floor ${floor}`);
  if (eta > ceiling) errors.push(`ETA ${eta} > ceiling ${ceiling}`);
  if (distance_km >= 10 && eta < 35) errors.push('10km+ must be >= 35 min');
  if (weather.condition === 'heavy_rain' && eta < floor + 15)
    errors.push('heavy_rain requires +15 min buffer');

  return { valid: errors.length === 0, errors, floor, ceiling };
}
```

### Layer 2: Fallback เมื่อ Validation ล้มเหลว

```
AI response → validateEta()
  ├── valid   → ใช้ AI result แสดง eta_range ให้ลูกค้า
  └── invalid → Fallback ไป Rule-based formula (ไม่พึ่ง AI)
                + log incident สำหรับ review
                + แสดง range กว้างขึ้น (min-max ±20%)
```

**Rule-based Fallback Formula:**
```
eta = prep_time
    + (distance_km / avg_speed * 60)   // avg_speed: 25 km/h clear, 15 heavy_rain
    + weather_buffer                    // rain: +5, heavy_rain: +15
    + rush_hour_buffer                  // +5
```

### Layer 3: แสดงผลแบบ Range ไม่ใช่ตัวเลขเดียว

| แทนที่จะบอก | ให้บอก |
|-------------|--------|
| "ถึงใน 5 นาที" | "ประมาณ 45–65 นาที" |

- ลดความผิดหวังเมื่อ AI คลาดเคลื่อน
- `eta_range.min` – `eta_range.max` จาก prompt

### Layer 4: Confidence-based Behavior

| confidence | การทำงาน |
|------------|----------|
| `high` | แสดง ETA ตาม AI |
| `medium` | แสดง range กว้างขึ้น 10% |
| `low` | ใช้ Fallback formula ทันที, ไม่แสดง AI result |

### Layer 5: Monitoring & Circuit Breaker

```
ถ้า AI validation fail > 10% ใน 1 ชม.
  → ปิด AI path ชั่วคราว
  → ใช้ Rule-based 100% จนกว่า team จะ review prompt
  → Alert ทีม AI/Backend
```

---

## 3. End-to-End Flow

```
Order placed
    ↓
Collect: distance, weather API, restaurant prep avg
    ↓
Call LLM with System + User Prompt
    ↓
Parse JSON output
    ↓
validateEta() ──fail──► Rule-based Fallback + log
    │ pass
    ▼
confidence check ──low──► Fallback
    │ medium/high
    ▼
Show customer: "ประมาณ {min}–{max} นาที"
    ↓
After delivery: compare actual vs predicted → feed back to improve prep_time avg
```

---

## 4. Scenario จากโจทย์ — 10 km + ฝนตกหนัก + AI บอก 5 นาที

| Step | Action |
|------|--------|
| AI returns | `eta_minutes: 5` |
| validateEta | `5 < floor(35)` → **invalid** |
| Fallback | `15 prep + 40 travel + 15 rain + 5 rush = ~55 min` |
| Customer sees | "ประมาณ 45–65 นาที" |
| Log | `{ order_id, ai_eta: 5, fallback_eta: 55, reason: "below_floor" }` |
| Alert | ถ้าเกิดซ้ำ → review prompt / ปิด AI path |
