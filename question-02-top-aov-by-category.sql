-- Question 2: Revenue Attribution & Ranking
-- Top 3 restaurants by AOV per category (delivered orders, current month only)
-- Target: MySQL 8+ / MS SQL Server (window functions)

/*
  Assumed schema:
    categories   (category_id, category_name)
    restaurants  (restaurant_id, restaurant_name, category_id)
    orders       (order_id, restaurant_id, total_amount, status, order_date)
*/

WITH monthly_delivered AS (
    -- Step 1: Aggregate delivered orders in current month per restaurant
    SELECT
        o.restaurant_id,
        SUM(o.total_amount) AS total_revenue,
        COUNT(o.order_id)   AS order_count
    FROM orders o
    WHERE o.status = 'delivered'
      AND o.order_date >= DATE_FORMAT(CURDATE(), '%Y-%m-01')              -- first day of month
      AND o.order_date <  DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH)
    GROUP BY o.restaurant_id
),

restaurant_aov AS (
    -- Step 2: LEFT JOIN — include all restaurants (even with zero orders)
    SELECT
        c.category_id,
        c.category_name,
        r.restaurant_id,
        r.restaurant_name,
        COALESCE(md.order_count, 0) AS order_count,
        CASE
            WHEN md.order_count IS NULL OR md.order_count = 0 THEN NULL
            ELSE md.total_revenue / md.order_count
        END AS aov
    FROM restaurants r
    INNER JOIN categories c ON c.category_id = r.category_id
    LEFT JOIN monthly_delivered md ON md.restaurant_id = r.restaurant_id
),

ranked AS (
    -- Step 3: Window Function — rank within each category by AOV
    SELECT
        category_id,
        category_name,
        restaurant_id,
        restaurant_name,
        order_count,
        aov,
        ROW_NUMBER() OVER (
            PARTITION BY category_id
            ORDER BY
                CASE WHEN aov IS NULL THEN 0 ELSE 1 END DESC,  -- no-order shops rank last
                aov DESC,
                restaurant_name ASC                               -- tie-breaker
        ) AS rank_in_category
    FROM restaurant_aov
)

SELECT
    category_name,
    restaurant_name,
    ROUND(aov, 2) AS aov,
    order_count,
    rank_in_category
FROM ranked
WHERE rank_in_category <= 3
  AND aov IS NOT NULL
ORDER BY category_name, rank_in_category;
