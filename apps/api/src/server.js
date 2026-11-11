import './config.js';
import http from 'node:http';
import cors from 'cors';
import express from 'express';
import { getAuth } from 'firebase-admin/auth';
import { Server } from 'socket.io';
import { requireAuth } from './auth.js';
import { db, firebaseConfigured } from './db.js';
import { installGameRoutes, installGameSockets } from './game-service.js';
import { installPaymentRoutes } from './payments.js';

const allowedAvatars = new Set(['🦁', '🐘', '🦅', '🐆', '🦓', '🌍', '⚡', '🔥', '🐊', '🦈', '🦊', '🐉']);
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: process.env.WEB_ORIGIN || 'http://localhost:5173' } });

app.use(cors({ origin: process.env.WEB_ORIGIN || 'http://localhost:5173' }));
app.use(express.json({ limit: '32kb' }));
app.get('/api/health', async (_req, res) => {
  if (!firebaseConfigured) {
    return res.status(503).json({ status: 'error', database: 'unavailable' });
  }
  try {
    await db.collection('users').limit(1).get();
    res.json({ status: 'ok', database: 'firestore' });
  } catch (error) {
    console.error('Health check could not reach Firestore:', error);
    res.status(503).json({ status: 'error', database: 'unavailable' });
  }
});

app.get('/api/me', requireAuth, async (req, res, next) => {
  try {
    const snapshot = await db.collection('users').doc(req.userId).get();
    if (!snapshot.exists) return res.status(404).json({ error: 'Player profile is not set up' });
    res.json({ user: { id: snapshot.id, email: req.userEmail, ...snapshot.data() } });
  } catch (error) {
    next(error);
  }
});
app.post('/api/me/sync', requireAuth, async (req, res, next) => {
  try {
    const name = String(req.body.name || req.userName || '').trim();
    const avatar = String(req.body.avatar || '🦁');
    if (name.length < 1 || name.length > 18) return res.status(400).json({ error: 'Name must be 1–18 characters' });
    if (!allowedAvatars.has(avatar)) return res.status(400).json({ error: 'Choose a supported avatar' });

    const userRef = db.collection('users').doc(req.userId);
    await db.runTransaction(async transaction => {
      const current = await transaction.get(userRef);
      if (!current.exists) {
        transaction.create(userRef, {
          email: req.userEmail,
          name,
          avatar,
          coins: 120,
          wins: 0,
          games: 0,
          captures: 0,
          streak: 0,
          xp: 0,
          createdAt: new Date()
        });
      } else {
        transaction.set(userRef, {
          email: req.userEmail,
          name: current.data().name || name,
          avatar: current.data().avatar || avatar
        }, { merge: true });
      }
    });
    const profile = await userRef.get();
    res.status(200).json({ user: { id: profile.id, email: req.userEmail, ...profile.data() } });
  } catch (error) {
    next(error);
  }
});
app.patch('/api/me', requireAuth, async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    const avatar = String(req.body.avatar || '');
    if (name.length < 1 || name.length > 18) return res.status(400).json({ error: 'Name must be 1–18 characters' });
    if (!allowedAvatars.has(avatar)) return res.status(400).json({ error: 'Choose a supported avatar' });
    const userRef = db.collection('users').doc(req.userId);
    const updated = await userRef.update({ name, avatar });
    if (!updated.writeTime) return res.status(404).json({ error: 'Player profile is not set up' });
    const profile = await userRef.get();
    res.json({ user: { id: profile.id, email: req.userEmail, ...profile.data() } });
  } catch (error) {
    next(error);
  }
});
app.get('/api/leaderboard', requireAuth, async (_req, res, next) => {
  try {
    const snapshot = await db.collection('users').orderBy('wins', 'desc').limit(100).get();
    const players = snapshot.docs
      .map(document => {
        const user = document.data();
        return {
          name: user.name,
          avatar: user.avatar,
          wins: user.wins || 0,
          games: user.games || 0,
          captures: user.captures || 0,
          points: (user.wins || 0) * 100 + (user.captures || 0)
        };
      })
      .sort((a, b) => b.points - a.points || b.wins - a.wins)
      .slice(0, 50);
    res.json({ players });
  } catch (error) {
    next(error);
  }
});
app.use('/api/games', requireAuth);
app.use('/api/payments', requireAuth);
installGameRoutes(app);
installPaymentRoutes(app);
app.use((error, _req, res, _next) => {
  if (error.status === 400 && error.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Request body must be valid JSON' });
  }
  console.error(error);
  res.status(500).json({ error: 'An unexpected server error occurred' });
});

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication required'));
    const identity = await getAuth().verifyIdToken(token);
    socket.data.userId = identity.uid;
    next();
  } catch {
    next(new Error('Invalid or expired session'));
  }
});
installGameSockets(io);

const port = Number(process.env.PORT || 3001);
server.listen(port, () => console.log(`Stone Pit API listening on port ${port}`));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    server.close(() => process.exit(0));
  });
}
