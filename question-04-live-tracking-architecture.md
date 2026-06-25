# Question 4: Real-time Live Tracking Architecture

**Scale:** 2,000 riders publishing GPS | 10,000 customers watching live map  
**Update interval:** every 2 seconds

---

## 1. Data Flow — Protocol Choice

### Recommendation: **MQTT (Rider → Server) + WebSocket (Server → Customer)**

| Protocol | Role | Verdict |
|----------|------|---------|
| **MQTT** | Rider app publishes GPS | Best for mobile uplink |
| **WebSocket** | Server pushes to customer browser/app | Best for live map UI |
| **gRPC** | Internal microservice calls only | Service-to-service, not end-user |

### Why NOT single protocol for everything?

```
┌─────────────┐   MQTT (lightweight)    ┌──────────────────┐
│ Rider App   │ ──────────────────────► │ Ingestion Service │
│ 2,000 conn  │   topic: rider/{id}/gps │                  │
└─────────────┘                         └────────┬─────────┘
                                               │ Redis Pub/Sub
┌─────────────┐   WebSocket (browser-native)  ▼
│ Customer UI │ ◄────────────────────── ┌──────────────────┐
│ 10,000 conn │   room: order/{id}     │ Tracking Gateway  │
└─────────────┘                         └──────────────────┘
                                               ▲
                                        gRPC (internal only)
                                        Order / Rider services
```

### MQTT — Rider uplink
- **Lightweight** header (~2 bytes) — ประหยัด battery & bandwidth บนมือถือ
- **QoS 0** พอสำหรับ GPS (ข้อมูลล่าสุดสำคัญกว่าข้อมูลเก่าที่หาย)
- **Pub/Sub** — Rider publish ไป topic เดียว ไม่ต้องรู้ว่าใคร subscribe
- รองรับ **unstable network** (3G/4G สลับ tower) ดีกว่า HTTP polling

### WebSocket — Customer downlink
- **Browser-native** — ไม่ต้อง plugin, ใช้กับ React/Angular map ได้ตรง
- **Server-push** — ลูกค้าไม่ต้อง poll ทุก 2 วิ (ลด load 10,000 × 0.5 req/s = 5,000 req/s)
- **Room-based** — subscribe เฉพาะ order ของตัวเอง ไม่ได้รับ GPS ทั้ง 2,000 rider

### gRPC — Internal only
- ใช้ระหว่าง `Ingestion Service` ↔ `Order Service` (เช็คสิทธิ์, order status)
- **ไม่ส่งตรงถึง browser** (ต้องใช้ grpc-web + proxy เพิ่ม complexity โดยไม่จำเป็น)

---

## 2. Storage Strategy

### Recommendation: **In-memory (Redis) สำหรับ live position | ไม่เขียน SQL ทุก 2 วิ**

| Layer | Store | เก็บอะไร | เหตุผล |
|-------|-------|----------|--------|
| **Hot (live)** | Redis (Hash / GEO) | ตำแหน่งล่าสุด + timestamp | In-memory, ไม่กระทบ Disk I/O |
| **Warm (trip)** | NoSQL / Time-series | จุด GPS ย้อนหลังของ trip | เขียน batch ทุก 10–30 วิ หรือเมื่อ trip จบ |
| **Cold (metadata)** | SQL (MySQL) | order, rider, status | ACID, relational — ไม่เก็บพิกัด real-time |

### Load calculation — ทำไม SQL ไม่เหมาะ

```
2,000 riders × 1 write / 2 sec = 1,000 writes/sec (continuous)
+ 10,000 customers read (ถ้า poll SQL) = disk I/O saturation ❌
```

Redis in-memory:
```
SET rider:{id}:location  → ~100k ops/sec บน instance เดียว ✅
TTL 5 min                → auto-cleanup stale data
```

### Redis data structure

```redis
HSET rider:1001 lat 13.756 lng 100.501 ts 1719300000
EXPIRE rider:1001 300

# หรือ Redis GEO สำหรับ query rider ใกล้ร้าน
GEOADD riders:live 100.501 13.756 rider:1001
```

### NoSQL / Time-series (optional — trip history)

- **TimescaleDB** หรือ **InfluxDB** — เก็บ trail สำหรับ dispute / analytics
- เขียน **batch** (buffer 10 จุดแล้ว flush) ไม่ใช่ทุก 2 วิ → ลด write 90%

### สรุป Storage

| หลีกเลี่ยง | ใช้ |
|-------------|--------|
| INSERT SQL ทุก 2 วิ | Redis = source of truth สำหรับ live |
| Disk-based สำหรับ hot path | NoSQL/time-series สำหรับ history (batch) |
| เก็บพิกัดใน order row | แยก concern — SQL เก็บ business data |

---

## 3. End-to-End Flow (สรุป)

```
1. Rider app → MQTT publish {lat, lng, ts} ทุก 2 วิ
2. Ingestion Service → validate + write Redis
3. Redis Pub/Sub → notify Tracking Gateway
4. Gateway → WebSocket push ไป room `order:{orderId}` เฉพาะลูกค้าที่ติดตาม
5. Trip จบ → batch flush GPS trail → TimescaleDB (optional)
6. SQL → อัปเดตแค่ order.status, ไม่ใช่พิกัด
```

---

## 4. Scaling Notes (bonus)

| จุด | วิธี scale |
|-----|-----------|
| 10,000 WebSocket | Horizontal gateway nodes + sticky session / Redis adapter |
| 2,000 MQTT | MQTT broker cluster (EMQX / HiveMQ) |
| Redis | Redis Cluster หรือ read replica สำหรับ GEO query |
| Stale GPS | TTL 5 min + ใช้ logic ข้อ 1 (Stale Data Protection) |
