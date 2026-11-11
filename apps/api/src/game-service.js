import { randomUUID } from 'node:crypto';
import { chooseAiMove, createGame, playMove } from '@stonepit/game';
import { db } from './db.js';

const games = db.collection('games');
const users = db.collection('users');

function publicGame(id, data) {
  return { id, mode: data.mode, status: data.status, roomCode: data.roomCode || null, state: data.state };
}

async function awardFinishedGame(transaction, game, state) {
  const participants = game.mode === 'ai'
    ? [[1, game.player1Id]]
    : [[1, game.player1Id], [2, game.player2Id]];

  const snapshots = await Promise.all(participants.map(([, userId]) => transaction.get(users.doc(userId))));
  for (const [player, userId] of participants) {
    const userRef = users.doc(userId);
    const current = snapshots[participants.findIndex(([, id]) => id === userId)].data() || {};
    const won = state.scores[player] > state.scores[player === 1 ? 2 : 1];
    transaction.set(userRef, {
      games: (current.games || 0) + (game.mode === 'online' ? 1 : 0),
      wins: (current.wins || 0) + (won ? 1 : 0),
      captures: (current.captures || 0) + state.captured[player],
      streak: won ? (current.streak || 0) + 1 : 0,
      xp: (current.xp || 0) + (won ? 50 : 10),
      coins: (current.coins ?? 120) + state.captured[player] + (won ? 30 : 0)
    }, { merge: true });
  }
}

export function installGameRoutes(app) {
  app.post('/api/games', async (req, res, next) => {
    try {
      const difficulty = ['easy', 'medium', 'hard'].includes(req.body.difficulty) ? req.body.difficulty : 'easy';
      const gameRef = games.doc(randomUUID());
      const game = {
        mode: 'ai',
        status: 'active',
        difficulty,
        player1Id: req.userId,
        player2Id: null,
        roomCode: null,
        state: createGame(),
        createdAt: new Date(),
        updatedAt: new Date()
      };
      await db.runTransaction(async transaction => {
        const userSnapshot = await transaction.get(users.doc(req.userId));
        transaction.create(gameRef, game);
        transaction.set(users.doc(req.userId), {
          games: (userSnapshot.data()?.games || 0) + 1
        }, { merge: true });
      });
      res.status(201).json({ game: publicGame(gameRef.id, game) });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/games/:id/moves', async (req, res, next) => {
    try {
      if (!Number.isInteger(req.body.pit)) return res.status(400).json({ error: 'Select a valid pit' });
      const gameRef = games.doc(req.params.id);
      const result = await db.runTransaction(async transaction => {
        const snapshot = await transaction.get(gameRef);
        if (!snapshot.exists) throw Object.assign(new Error('Game not found'), { status: 404 });
        const game = snapshot.data();
        if (game.mode !== 'ai' || game.player1Id !== req.userId) throw Object.assign(new Error('Game not found'), { status: 404 });
        if (game.status !== 'active') throw Object.assign(new Error('This game has already ended'), { status: 409 });

        const moves = [{ pit: req.body.pit, player: 1 }];
        let state = playMove(game.state, req.body.pit, 1);
        if (state.status !== 'finished') {
          const aiPit = chooseAiMove(state, game.difficulty || 'easy');
          if (aiPit !== null) {
            moves.push({ pit: aiPit, player: 2 });
            state = playMove(state, aiPit, 2);
          }
        }
        const status = state.status === 'finished' ? 'finished' : 'active';
        const nextGame = { ...game, state, status, updatedAt: new Date() };
        if (status === 'finished') await awardFinishedGame(transaction, game, state);
        transaction.update(gameRef, { state, status, updatedAt: nextGame.updatedAt });
        return { game: publicGame(gameRef.id, nextGame), moves };
      });
      res.json(result);
    } catch (error) {
      if (error.code === 'INVALID_MOVE' || error.code === 'CHAIN_LIMIT') {
        return res.status(400).json({ error: error.message });
      }
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });
}

export function installGameSockets(io) {
  io.on('connection', socket => {
    const userId = socket.data.userId;

    socket.on('room:create', async (ack = () => {}) => {
      try {
        const gameRef = games.doc(randomUUID());
        const roomCode = randomUUID().replaceAll('-', '').slice(0, 6).toUpperCase();
        const game = {
          mode: 'online',
          status: 'waiting',
          difficulty: null,
          player1Id: userId,
          player2Id: null,
          roomCode,
          state: createGame(),
          createdAt: new Date(),
          updatedAt: new Date()
        };
        await gameRef.create(game);
        socket.join(gameRef.id);
        ack({ game: publicGame(gameRef.id, game), player: 1 });
      } catch (error) {
        console.error('Could not create multiplayer room:', error);
        ack({ error: 'Could not create a game room' });
      }
    });

    socket.on('room:join', async ({ code } = {}, ack = () => {}) => {
      try {
        const matching = await games.where('roomCode', '==', String(code || '').trim().toUpperCase()).limit(1).get();
        if (matching.empty) return ack({ error: 'Room is unavailable' });
        const gameRef = matching.docs[0].ref;
        const game = await db.runTransaction(async transaction => {
          const snapshot = await transaction.get(gameRef);
          if (!snapshot.exists) throw new Error('Room is unavailable');
          const current = snapshot.data();
          if (current.status !== 'waiting' || current.player1Id === userId) throw new Error('Room is unavailable');
          const next = { ...current, player2Id: userId, status: 'active', updatedAt: new Date() };
          transaction.update(gameRef, { player2Id: userId, status: 'active', updatedAt: next.updatedAt });
          return next;
        });
        socket.join(gameRef.id);
        ack({ game: publicGame(gameRef.id, game), player: 2 });
        io.to(gameRef.id).emit('game:state', { game: publicGame(gameRef.id, game) });
      } catch (error) {
        ack({ error: error.message || 'Could not join that room' });
      }
    });

    socket.on('game:move', async ({ gameId, pit } = {}, ack = () => {}) => {
      try {
        if (!Number.isInteger(pit)) return ack({ error: 'Select a valid pit' });
        const gameRef = games.doc(String(gameId || ''));
        const game = await db.runTransaction(async transaction => {
          const snapshot = await transaction.get(gameRef);
          if (!snapshot.exists) throw new Error('Game is unavailable');
          const current = snapshot.data();
          if (current.mode !== 'online' || current.status !== 'active') throw new Error('Game is unavailable');
          const expectedPlayerId = current.state.currentPlayer === 1 ? current.player1Id : current.player2Id;
          if (expectedPlayerId !== userId) throw new Error('It is not your turn');
          const player = current.state.currentPlayer;
          const previousState = current.state;
          const state = playMove(previousState, pit, player);
          const status = state.status === 'finished' ? 'finished' : 'active';
          const next = { ...current, state, status, updatedAt: new Date() };
          if (status === 'finished') await awardFinishedGame(transaction, current, state);
          transaction.update(gameRef, { state, status, updatedAt: next.updatedAt });
          return { game: next, move: { pit, player, state: previousState } };
        });
        const payload = {
          game: publicGame(gameRef.id, game.game),
          move: { ...game.move, state: game.move.state }
        };
        io.to(gameRef.id).emit('game:state', payload);
        ack({ ok: true, ...payload });
      } catch (error) {
        ack({ error: error.code === 'INVALID_MOVE' ? error.message : (error.message || 'Move failed') });
      }
    });
  });
}
