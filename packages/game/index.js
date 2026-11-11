export const PLAYER_PITS = {
  1: [12, 13, 14, 15, 11, 10, 9, 8],
  2: [7, 6, 5, 4, 0, 1, 2, 3]
};

const innerPits = new Set([4, 5, 6, 7, 8, 9, 10, 11]);

export function createGame() {
  return {
    pits: Array.from({ length: 16 }, (_, index) => ({ count: 3, color: index % 4 })),
    scores: { 1: 0, 2: 0 },
    captured: { 1: 0, 2: 0 },
    currentPlayer: 1,
    status: 'active'
  };
}

export function getCaptureColumn(pit) {
  if (pit >= 8 && pit <= 11) return { inner: pit - 4, outer: pit - 8 };
  if (pit >= 4 && pit <= 7) return { inner: pit + 4, outer: pit + 8 };
  return null;
}

function finishIfEmpty(state) {
  const side1Empty = PLAYER_PITS[1].every(index => state.pits[index].count === 0);
  const side2Empty = PLAYER_PITS[2].every(index => state.pits[index].count === 0);
  if (!side1Empty && !side2Empty) return false;
  for (const player of [1, 2]) {
    for (const index of PLAYER_PITS[player]) {
      state.scores[player] += state.pits[index].count;
      state.pits[index].count = 0;
    }
  }
  state.status = 'finished';
  return true;
}

function playMoveInternal(current, pit, player, frames) {
  if (current.status !== 'active') throw Object.assign(new Error('This game has already ended'), { code: 'INVALID_MOVE' });
  if (player !== current.currentPlayer || !PLAYER_PITS[player]?.includes(pit) || current.pits[pit]?.count < 1) {
    throw Object.assign(new Error('That pit cannot be played'), { code: 'INVALID_MOVE' });
  }

  const state = structuredClone(current);
  const recordFrame = (index, type) => {
    if (frames) frames.push({ state: structuredClone(state), pit: index, type });
  };
  const order = PLAYER_PITS[player];
  let selected = pit;
  let chains = 0;

  while (true) {
    if (++chains > 256) throw Object.assign(new Error('This move would create an endless chain'), { code: 'CHAIN_LIMIT' });
    const count = state.pits[selected].count;
    if (!count) throw Object.assign(new Error('Chain landed in an empty pit'), { code: 'INVALID_MOVE' });
    state.pits[selected].count = 0;
    recordFrame(selected, 'pick');
    const position = order.indexOf(selected);
    let landing = selected;
    for (let step = 0; step < count; step++) {
      landing = order[(position + step + 1) % order.length];
      state.pits[landing].count++;
      recordFrame(landing, 'sow');
    }

    if (state.pits[landing].count > 1) {
      recordFrame(landing, 'chain');
      selected = landing;
      continue;
    }

    if (innerPits.has(landing)) {
      const column = getCaptureColumn(landing);
      if (column && state.pits[column.inner].count > 0) {
        const amount = state.pits[column.inner].count + state.pits[column.outer].count;
        state.pits[column.inner].count = 0;
        state.pits[column.outer].count = 0;
        state.scores[player] += amount;
        state.captured[player] += amount;
        recordFrame(landing, 'capture');
      }
    }
    break;
  }

  if (!finishIfEmpty(state)) state.currentPlayer = player === 1 ? 2 : 1;
  recordFrame(null, 'turn');
  return state;
}

export function playMove(current, pit, player = current.currentPlayer) {
  return playMoveInternal(current, pit, player, null);
}

export function playMoveWithFrames(current, pit, player = current.currentPlayer) {
  const frames = [];
  const state = playMoveInternal(current, pit, player, frames);
  return { state, frames };
}

export function chooseAiMove(state, difficulty = 'easy') {
  const moves = PLAYER_PITS[2].filter(index => state.pits[index].count > 0);
  if (moves.length === 0) return null;
  let best = moves[0];
  let bestScore = -Infinity;
  for (const move of moves) {
    let score;
    try {
      const result = playMove(state, move, 2);
      score = (result.scores[2] - state.scores[2]) * 10 + (result.status === 'finished' && result.scores[2] > result.scores[1] ? 100 : 0);
      if (difficulty === 'hard' && result.status !== 'finished') {
        let strongestReply = 0;
        for (const response of PLAYER_PITS[1]) {
          if (result.pits[response].count === 0) continue;
          const reply = playMove(result, response, 1);
          const replyGain = reply.scores[1] - result.scores[1];
          const opponentWin = reply.status === 'finished' && reply.scores[1] > reply.scores[2];
          strongestReply = Math.max(strongestReply, replyGain + (opponentWin ? 10 : 0));
        }
        score -= strongestReply * 12;
      }
    } catch {
      score = -1000;
    }
    if (difficulty === 'easy') score += Math.random() * 20 - 10;
    if (difficulty === 'medium') score += Math.random() * 6 - 3;
    if (score > bestScore) {
      bestScore = score;
      best = move;
    }
  }
  return best;
}
