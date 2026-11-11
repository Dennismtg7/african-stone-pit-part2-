import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseAiMove, createGame, getCaptureColumn, playMove, playMoveWithFrames } from './index.js';

test('new game starts with three stones in every pit', () => {
  const state = createGame();
  assert.equal(state.pits.length, 16);
  assert.ok(state.pits.every(pit => pit.count === 3));
  assert.equal(state.currentPlayer, 1);
});

test('a valid sow transfers stones and changes turns', () => {
  const state = createGame();
  const next = playMove(state, 12);
  assert.equal(state.pits.reduce((sum, pit) => sum + pit.count, 0), 48);
  assert.equal(next.pits.reduce((sum, pit) => sum + pit.count, 0), 48);
  assert.equal(next.currentPlayer, 2);
});

test('animated sow frames resolve to the same state as a regular move', () => {
  const state = createGame();
  const animated = playMoveWithFrames(state, 12);
  assert.deepEqual(animated.state, playMove(state, 12));
  assert.equal(animated.frames[0].type, 'pick');
  assert.deepEqual(animated.frames.filter(frame => frame.type === 'sow').slice(0, 3).map(frame => frame.pit), [13, 14, 15]);
  assert.ok(animated.frames.some(frame => frame.type === 'chain'));
  assert.equal(animated.frames.at(-1).type, 'turn');
});

test('rejects empty pits and pits owned by the other player', () => {
  const state = createGame();
  assert.throws(() => playMove(state, 0), { code: 'INVALID_MOVE' });
  state.pits[12].count = 0;
  assert.throws(() => playMove(state, 12), { code: 'INVALID_MOVE' });
});

test('maps matching inner and outer capture pits', () => {
  assert.deepEqual(getCaptureColumn(8), { inner: 4, outer: 0 });
  assert.deepEqual(getCaptureColumn(4), { inner: 8, outer: 12 });
  assert.equal(getCaptureColumn(0), null);
});

test('captures the matching opponent column when the last stone lands in an empty inner pit', () => {
  const state = createGame();
  for (const index of [0, 4, 8, 12]) state.pits[index].count = 0;
  state.pits[12].count = 7;
  state.pits[0].count = 2;
  state.pits[4].count = 3;
  const next = playMove(state, 12);
  assert.equal(next.pits[0].count, 0);
  assert.equal(next.pits[4].count, 0);
  assert.equal(next.scores[1], 5);
  assert.equal(next.captured[1], 5);
});

test('ends the game and sweeps remaining stones when a side is empty', () => {
  const state = createGame();
  for (let index = 0; index < 8; index++) state.pits[index].count = 0;
  for (let index = 8; index < 16; index++) state.pits[index].count = 0;
  state.pits[4].count = 1;
  state.pits[0].count = 1;
  state.pits[12].count = 7;
  const next = playMove(state, 12);
  assert.equal(next.status, 'finished');
  assert.equal(next.pits.reduce((sum, pit) => sum + pit.count, 0), 0);
});

test('hard AI looks ahead to avoid a strong opponent capture', () => {
  const state = createGame();
  const counts = [3, 3, 0, 3, 3, 3, 0, 3, 4, 4, 1, 5, 4, 0, 1, 5];
  state.pits.forEach((pit, index) => { pit.count = counts[index]; });
  state.scores[1] = 6;
  state.currentPlayer = 2;

  assert.equal(chooseAiMove(state, 'hard'), 7);
});
