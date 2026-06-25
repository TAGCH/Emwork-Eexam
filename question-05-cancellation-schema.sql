-- Question 5: Cancellation Log Schema + Dynamic Incentive Tables
-- MySQL / MS SQL compatible style

-- =============================================================================
-- 1. ZONE (พื้นที่สำหรับ Incentive รายโซน)
-- =============================================================================
CREATE TABLE zones (
    zone_id         INT PRIMARY KEY AUTO_INCREMENT,
    zone_name       VARCHAR(100) NOT NULL,
    polygon_geojson JSON NOT NULL,          -- ขอบเขตพื้นที่ (lat/lng polygon)
    is_active       BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- =============================================================================
-- 2. CANCELLATION LOG — หัวใจ Fraud Detection
-- =============================================================================
CREATE TABLE cancellation_logs (
    log_id              BIGINT PRIMARY KEY AUTO_INCREMENT,
    order_id            BIGINT NOT NULL,
    rider_id            INT NULL,               -- NULL ถ้ายกเลิกก่อน assign rider
    customer_id         INT NOT NULL,
    restaurant_id       INT NOT NULL,
    zone_id             INT NOT NULL,

    -- ใครเป็นคนยกเลิก
    cancelled_by        ENUM('rider', 'customer', 'restaurant', 'system') NOT NULL,
    cancel_reason_code  VARCHAR(50) NOT NULL,   -- e.g. 'rider_too_far', 'rider_no_show'
    cancel_reason_text  TEXT NULL,              -- ข้อความเพิ่มเติม

    -- เวลา & บริบท (สำคัญสำหรับ Fraud)
    order_created_at    TIMESTAMP NOT NULL,
    rider_assigned_at   TIMESTAMP NULL,
    cancelled_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    seconds_after_assign INT NULL,             -- ยกเลิกหลังรับงานกี่วินาที (pattern: รับแล้วยกเลิกเร็ว)

    -- พิกัด ณ เวลายกเลิก (เทียบกับร้าน/ลูกค้า)
    rider_lat           DECIMAL(10, 7) NULL,
    rider_lng           DECIMAL(10, 7) NULL,
    restaurant_lat      DECIMAL(10, 7) NOT NULL,
    restaurant_lng      DECIMAL(10, 7) NOT NULL,

    -- Order context
    order_value         DECIMAL(10, 2) NOT NULL,
    delivery_fee        DECIMAL(10, 2) NOT NULL,
    is_rush_hour        BOOLEAN NOT NULL DEFAULT FALSE,

    -- Fraud signals (denormalized สำหรับ query เร็ว)
    is_suspected_fraud  BOOLEAN DEFAULT FALSE,
    fraud_score         DECIMAL(5, 2) NULL,     -- 0–100 จาก ML rule engine

    -- Audit
    device_id           VARCHAR(100) NULL,
    ip_address          VARCHAR(45) NULL,

    INDEX idx_zone_cancelled_at (zone_id, cancelled_at),
    INDEX idx_rider_cancelled_at (rider_id, cancelled_at),
    INDEX idx_cancelled_by_reason (cancelled_by, cancel_reason_code),
    INDEX idx_fraud (is_suspected_fraud, fraud_score),
    FOREIGN KEY (zone_id) REFERENCES zones(zone_id)
);

-- =============================================================================
-- 3. ZONE METRICS (aggregate สำหรับ trigger incentive)
-- =============================================================================
CREATE TABLE zone_hourly_metrics (
    metric_id           BIGINT PRIMARY KEY AUTO_INCREMENT,
    zone_id             INT NOT NULL,
    metric_hour         TIMESTAMP NOT NULL,     -- ปัดเป็นชั่วโมง

    total_orders        INT DEFAULT 0,
    rider_cancellations INT DEFAULT 0,
    cancellation_rate   DECIMAL(5, 4) NULL,     -- 0.2500 = 25%
    active_riders       INT DEFAULT 0,
    pending_orders      INT DEFAULT 0,
    demand_supply_ratio DECIMAL(6, 2) NULL,     -- pending / active_riders

    UNIQUE KEY uk_zone_hour (zone_id, metric_hour),
    FOREIGN KEY (zone_id) REFERENCES zones(zone_id)
);

-- =============================================================================
-- 4. DYNAMIC INCENTIVE RULES
-- =============================================================================
CREATE TABLE incentive_rules (
    rule_id             INT PRIMARY KEY AUTO_INCREMENT,
    rule_name           VARCHAR(100) NOT NULL,
    zone_id             INT NULL,               -- NULL = ทุกโซน

    -- Trigger conditions
    min_cancellation_rate DECIMAL(5, 4) NOT NULL,  -- e.g. 0.20 = 20%
    min_demand_supply_ratio DECIMAL(6, 2) NULL,
    rush_hour_only      BOOLEAN DEFAULT TRUE,
    valid_from_hour     TIME NULL,              -- e.g. 11:00
    valid_to_hour       TIME NULL,              -- e.g. 14:00

    -- Bonus config
    bonus_type          ENUM('flat', 'percentage', 'per_km') NOT NULL,
    bonus_amount        DECIMAL(10, 2) NOT NULL, -- บาท หรือ % ตาม type
    max_bonus_cap       DECIMAL(10, 2) NULL,
    duration_minutes    INT DEFAULT 30,         -- incentive มีผลกี่นาที

    is_active           BOOLEAN DEFAULT TRUE,
    priority            INT DEFAULT 0,            -- rule สูงกว่า = ใช้ก่อน
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (zone_id) REFERENCES zones(zone_id)
);

-- =============================================================================
-- 5. ACTIVE INCENTIVES (snapshot ที่กำลังมีผลอยู่)
-- =============================================================================
CREATE TABLE active_incentives (
    active_id           BIGINT PRIMARY KEY AUTO_INCREMENT,
    zone_id             INT NOT NULL,
    rule_id             INT NOT NULL,

    bonus_type          ENUM('flat', 'percentage', 'per_km') NOT NULL,
    bonus_amount        DECIMAL(10, 2) NOT NULL,
    max_bonus_cap       DECIMAL(10, 2) NULL,

    triggered_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at          TIMESTAMP NOT NULL,
    trigger_cancellation_rate DECIMAL(5, 4) NOT NULL,
    trigger_pending_orders INT NOT NULL,

    is_active           BOOLEAN DEFAULT TRUE,

    INDEX idx_zone_active (zone_id, is_active, expires_at),
    FOREIGN KEY (zone_id) REFERENCES zones(zone_id),
    FOREIGN KEY (rule_id) REFERENCES incentive_rules(rule_id)
);

-- =============================================================================
-- 6. INCENTIVE PAYOUTS (จ่ายโบนัสจริงให้ Rider)
-- =============================================================================
CREATE TABLE incentive_payouts (
    payout_id           BIGINT PRIMARY KEY AUTO_INCREMENT,
    active_incentive_id BIGINT NOT NULL,
    rider_id            INT NOT NULL,
    order_id            BIGINT NOT NULL,
    zone_id             INT NOT NULL,

    base_delivery_fee   DECIMAL(10, 2) NOT NULL,
    bonus_amount        DECIMAL(10, 2) NOT NULL,
    paid_at             TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (active_incentive_id) REFERENCES active_incentives(active_id)
);

-- =============================================================================
-- FRAUD DETECTION — ตัวอย่าง Query
-- =============================================================================

-- Rider ยกเลิกบ่อยหลังรับงาน < 60 วินาที (สงสัยทุจริต)
/*
SELECT rider_id,
       COUNT(*) AS quick_cancels,
       AVG(seconds_after_assign) AS avg_seconds
FROM cancellation_logs
WHERE cancelled_by = 'rider'
  AND seconds_after_assign < 60
  AND cancelled_at >= NOW() - INTERVAL 7 DAY
GROUP BY rider_id
HAVING quick_cancels >= 5
ORDER BY quick_cancels DESC;
*/

-- Cancellation rate ต่อโซน ช่วง Rush Hour
/*
SELECT z.zone_name,
       COUNT(*) AS total_cancels,
       SUM(CASE WHEN cl.cancelled_by = 'rider' THEN 1 ELSE 0 END) AS rider_cancels
FROM cancellation_logs cl
JOIN zones z ON z.zone_id = cl.zone_id
WHERE cl.is_rush_hour = TRUE
  AND cl.cancelled_at >= CURDATE()
GROUP BY z.zone_id, z.zone_name;
*/
