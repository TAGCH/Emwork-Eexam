/**
 * Question 3: Code Review — Inventory Race Condition
 * Fixed: Transaction + Atomic Update (recommended) + Pessimistic Locking (alternative)
 */

// =============================================================================
// ORIGINAL CODE — PROBLEMS
// =============================================================================
/*
async function placeOrder(orderId, items) {
    for (const item of items) {
        const product = await db.query(
            `SELECT stock FROM menu WHERE id = ${item.id}`),   // SQL Injection
        if (product.stock >= item.qty) {                       // Race Condition: read-then-write gap
            await db.query(
                `UPDATE menu SET stock = stock - ${item.qty} WHERE id = ${item.id}`),
        }                                                      // No check if UPDATE actually succeeded
    }                                                          // N+1: 2 queries × N items
    await Order.create({ id: orderId, status: 'confirmed' });   // No Transaction — partial failure possible
}
*/

// =============================================================================
// SOLUTION A: Transaction + Atomic Update (Recommended)
// =============================================================================
// Single UPDATE with WHERE stock >= qty is atomic at DB level.
// If affectedRows = 0 → stock was insufficient or row missing → rollback.

async function placeOrder(orderId, items) {
  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    for (const item of items) {
      const [result] = await connection.query(
        `UPDATE menu
         SET stock = stock - ?
         WHERE id = ? AND stock >= ?`,
        [item.qty, item.id, item.qty]
      );

      if (result.affectedRows === 0) {
        throw new InsufficientStockError(item.id);
      }
    }

    await Order.create(
      { id: orderId, status: 'confirmed' },
      { transaction: connection }
    );

    await connection.commit();
    return { orderId, status: 'confirmed' };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

// =============================================================================
// SOLUTION B: Transaction + Pessimistic Locking (SELECT FOR UPDATE)
// =============================================================================
// Locks rows until commit — prevents concurrent reads/writes on same product.

async function placeOrderWithLock(orderId, items) {
  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    // Reduce N+1: lock all products in one query
    const ids = items.map((i) => i.id);
    const [products] = await connection.query(
      `SELECT id, stock FROM menu WHERE id IN (?) FOR UPDATE`,
      [ids]
    );

    const stockMap = new Map(products.map((p) => [p.id, p.stock]));

    for (const item of items) {
      const currentStock = stockMap.get(item.id);
      if (currentStock === undefined || currentStock < item.qty) {
        throw new InsufficientStockError(item.id);
      }
    }

    for (const item of items) {
      await connection.query(
        `UPDATE menu SET stock = stock - ? WHERE id = ?`,
        [item.qty, item.id]
      );
    }

    await Order.create(
      { id: orderId, status: 'confirmed' },
      { transaction: connection }
    );

    await connection.commit();
    return { orderId, status: 'confirmed' };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

class InsufficientStockError extends Error {
  constructor(productId) {
    super(`Insufficient stock for product ${productId}`);
    this.name = 'InsufficientStockError';
    this.productId = productId;
  }
}

module.exports = { placeOrder, placeOrderWithLock, InsufficientStockError };
