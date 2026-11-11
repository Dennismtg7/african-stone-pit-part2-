import { randomUUID } from 'node:crypto';
import { db } from './db.js';

const products = new Map([
  ['sc-sm', { amount: 500, price: 50 }],
  ['sc-bg', { amount: 1200, price: 100 }],
  ['sc-xl', { amount: 3000, price: 200 }]
]);
const phonePattern = /^2547\d{8}$/;
const payments = db.collection('payments');

export function installPaymentRoutes(app) {
  app.post('/api/payments', async (req, res, next) => {
    let paymentRef;
    try {
      const item = products.get(req.body.itemId);
      const phone = String(req.body.phone || '').replace(/\s/g, '');
      if (!item || !phonePattern.test(phone)) return res.status(400).json({ error: 'Select a valid coin pack and Kenyan mobile number' });
      if (!process.env.INTASEND_SECRET_KEY) return res.status(503).json({ error: 'Mobile money payments are not configured on this server' });

      paymentRef = payments.doc(randomUUID());
      await paymentRef.create({
        userId: req.userId,
        itemId: req.body.itemId,
        status: 'pending',
        providerInvoiceId: null,
        createdAt: new Date(),
        completedAt: null
      });
      const response = await fetch(`${process.env.INTASEND_API_URL || 'https://sandbox.intasend.com'}/api/v1/payment/mpesa-stk-push/`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.INTASEND_SECRET_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          amount: item.price,
          currency: 'KES',
          email: req.userEmail,
          phone_number: phone,
          narrative: 'Stone Pit coin purchase'
        })
      });
      const result = await response.json();
      if (!response.ok || !(result.id || result.invoice?.id)) {
        await paymentRef.update({ status: 'failed' });
        return res.status(502).json({ error: result.message || 'Payment provider rejected the request' });
      }
      await paymentRef.update({ providerInvoiceId: String(result.id || result.invoice.id) });
      res.status(201).json({ paymentId: paymentRef.id, status: 'pending' });
    } catch (error) {
      if (paymentRef) await paymentRef.update({ status: 'failed' }).catch(updateError => console.error('Could not mark payment failed:', updateError));
      next(error);
    }
  });

  app.get('/api/payments/:id', async (req, res, next) => {
    try {
      const paymentRef = payments.doc(req.params.id);
      const paymentSnapshot = await paymentRef.get();
      if (!paymentSnapshot.exists || paymentSnapshot.data().userId !== req.userId) {
        return res.status(404).json({ error: 'Payment not found' });
      }
      const payment = paymentSnapshot.data();
      if (payment.status !== 'pending') return res.json({ status: payment.status });
      if (!process.env.INTASEND_SECRET_KEY || !payment.providerInvoiceId) {
        return res.status(503).json({ error: 'Payment status is not available yet' });
      }
      const response = await fetch(`${process.env.INTASEND_API_URL || 'https://sandbox.intasend.com'}/api/v1/payment/${encodeURIComponent(payment.providerInvoiceId)}/status/`, {
        headers: { Authorization: `Bearer ${process.env.INTASEND_SECRET_KEY}` }
      });
      const result = await response.json();
      if (!response.ok) return res.status(502).json({ error: result.message || 'Could not check payment status' });
      const completed = result.state === 'completed';
      const failed = result.state === 'failed';
      if (!completed && !failed) return res.json({ status: 'pending' });

      await db.runTransaction(async transaction => {
        const latest = await transaction.get(paymentRef);
        if (!latest.exists || latest.data().status !== 'pending') return;
        const userRef = db.collection('users').doc(req.userId);
        if (completed) {
          const item = products.get(latest.data().itemId);
          const userSnapshot = await transaction.get(userRef);
          transaction.update(paymentRef, { status: 'completed', completedAt: new Date() });
          transaction.set(userRef, { coins: (userSnapshot.data()?.coins ?? 120) + item.amount }, { merge: true });
        } else {
          transaction.update(paymentRef, { status: 'failed' });
        }
      });
      return res.json({ status: completed ? 'completed' : 'failed' });
    } catch (error) {
      next(error);
    }
  });
}
