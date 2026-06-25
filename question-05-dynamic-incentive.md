# Question 5: Rush Hour Cancellation Crisis

**Problem:** Rider cancellation 25% ช่วง Rush Hour → ลูกค้ารอนาน, ร้านเสียรายได้

---

## 1. Dynamic Incentive — Feature Design

### Concept
เมื่อ cancellation rate ในโซนเกิน threshold ช่วง Rush Hour → เปิด **โบนัสพิเศษรายพื้นที่** อัตโนมัติ เพื่อดึง Rider เข้าโซน

### Flow

```
┌──────────────┐    ทุก 5 นาที     ┌─────────────────┐
│ zone_hourly  │ ────────────────► │ Incentive Engine │
│ _metrics     │   cancellation    │                  │
│ (25% > 20%)  │   rate check      └────────┬─────────┘
└──────────────┘                            │
                                            ▼
                                   ┌─────────────────┐
                                   │ active_incentives│  +30 บาท/ออเดอร์
                                   │ zone: สีลม       │  มีผล 30 นาที
                                   └────────┬─────────┘
                                            │
                    ┌───────────────────────┼───────────────────────┐
                    ▼                       ▼                       ▼
              Rider App              Push notification          Map heatmap
              แสดงโบนัสโซน            "โซนสีลม +30฿"            สีแดง = โบนัสสูง
```

### Trigger Logic

| เงื่อนไข | ค่า |
|----------|-----|
| `cancellation_rate` | ≥ 20% (threshold) |
| `rush_hour_only` | 11:00–14:00, 17:00–20:00 |
| `demand_supply_ratio` | pending_orders / active_riders > 2 |
| Auto-expire | 30 นาที หรือจนกว่า rate ลดต่ำกว่า 15% |

### Bonus Types

| Type | ตัวอย่าง | เหมาะกับ |
|------|----------|----------|
| `flat` | +30 บาท/ออเดอร์ | ดึง Rider เข้าโซนเร็ว |
| `percentage` | +20% ค่าจัดส่ง | ออเดอร์มูลค่าสูง |
| `per_km` | +5 บาท/km | ระยะทางไกล |

### Rider Experience
1. เปิดแอป → เห็น **Heatmap โบนัส** บนแผนที่
2. เข้าโซนที่มี incentive → รับออเดอร์ได้โบนัสเพิ่มอัตโนมัติ
3. `incentive_payouts` บันทึกโบนัสจริงต่อ order

### Anti-abuse
- โบนัสจ่ายเมื่อ **delivered** เท่านั้น (ไม่จ่ายถ้ายกเลิก)
- Rider ที่ `fraud_score` สูง → ไม่ได้รับ incentive
- Cap สูงสุดต่อวัน (เช่น 500 บาท/rider)

---

## 2. Cancellation Log — Fraud Detection

### ทำไมต้องออกแบบ Schema ดี?

| Fraud Pattern | Field ที่ใช้วิเคราะห์ |
|---------------|----------------------|
| รับงานแล้วยกเลิกเร็ว (< 60 วิ) | `seconds_after_assign` |
| ยกเลิกซ้ำในโซนเดียวกัน | `zone_id` + `rider_id` + time window |
| GPS ไม่ตรงร้านตอนยกเลิก | `rider_lat/lng` vs `restaurant_lat/lng` |
| จงใจรับแล้วปล่อย (cherry-pick) | `cancel_reason_code` pattern |
| สมรู้ร่วมคิดกับลูกค้า | `rider_id` + `customer_id` pair frequency |
| ยกเลิกเฉพาะออเดอร์มูลค่าต่ำ | `order_value` distribution |

### Key Fields ใน `cancellation_logs`

```
ใครยกเลิก     → cancelled_by, cancel_reason_code
เมื่อไหร่      → cancelled_at, seconds_after_assign
อยู่ที่ไหน     → zone_id, rider_lat/lng, restaurant_lat/lng
บริบทออเดอร์  → order_value, is_rush_hour
Fraud signal  → is_suspected_fraud, fraud_score
Audit         → device_id, ip_address
```

### Fraud Score (Rule-based หรือ ML)

```
fraud_score =
  + 30  if seconds_after_assign < 60
  + 25  if cancel_rate_7d > 15%
  + 20  if distance_to_restaurant > 2km at cancel
  + 15  if same_customer_pair > 3 times
  + 10  if cancel only low-value orders
```

---

## 3. ความเชื่อมโยง 2 ส่วน

```
cancellation_logs  →  feed  →  zone_hourly_metrics
                                      ↓
                              incentive_rules (trigger)
                                      ↓
                              active_incentives
                                      ↓
                              incentive_payouts (เมื่อ delivered)

cancellation_logs  →  feed  →  fraud detection engine
                                      ↓
                              flag rider → ระงับ incentive
```

---

## 4. KPI วัดผล

| Metric | เป้า |
|--------|------|
| Rider cancellation rate | 25% → < 12% |
| Avg wait time ช่วง rush | ลด 30% |
| Rider supply ใน hot zone | เพิ่ม 40% ภายใน 15 นาทีหลังเปิด incentive |
| Fraud false positive | < 5% |
