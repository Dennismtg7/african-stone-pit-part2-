import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  onAuthStateChanged,
  OAuthProvider,
  RecaptchaVerifier,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPhoneNumber,
  signInWithPopup,
  signOut,
  updateProfile
} from '@firebase/auth';
import { createGame, playMoveWithFrames, chooseAiMove, PLAYER_PITS } from '@stonepit/game';
import { api, getToken, socketUrl } from './api.js';
import { musicTracks, playGameSound, startAudio, stopMusic } from './audio.js';
import { auth, firebaseConfigured } from './firebase.js';

const avatars = ['🦁', '🐘', '🦅', '🐆', '🦓', '🌍', '⚡', '🔥'];
const initialForm = { email: '', password: '', name: '', avatar: '🦁' };
const tableSkins = [
  { id: 'wood', label: 'Classic Wood' },
  { id: 'ebony', label: 'Ebony' },
  { id: 'jade', label: 'Jade' },
  { id: 'blue', label: 'Royal Blue' },
  { id: 'crimson', label: 'Crimson' },
  { id: 'sand', label: 'Desert Sand' }
];

export default function App() {
  const [user, setUser] = useState(null);
  const [guestMode, setGuestMode] = useState(false);
  const pendingProfile = useRef(null);
  const [authReady, setAuthReady] = useState(false);
  const [screen, setScreen] = useState('home');
  const [form, setForm] = useState(initialForm);
  const [registering, setRegistering] = useState(false);
  const [authMethod, setAuthMethod] = useState('email');
  const [phone, setPhone] = useState('');
  const [phoneCode, setPhoneCode] = useState('');
  const [phoneConfirmation, setPhoneConfirmation] = useState(null);
  const recaptchaVerifier = useRef(null);
  const animationRun = useRef(0);
  const [game, setGame] = useState(null);
  const [animatedPit, setAnimatedPit] = useState(null);
  const [gameId, setGameId] = useState(null);
  const [player, setPlayer] = useState(1);
  const [gameMode, setGameMode] = useState('local');
  const [difficulty, setDifficulty] = useState('easy');
  const [roomCode, setRoomCode] = useState('');
  const [roomEntry, setRoomEntry] = useState('');
  const [socket, setSocket] = useState(null);
  const [notice, setNotice] = useState('');
  const [leaderboard, setLeaderboard] = useState([]);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('game');
  const [skin, setSkin] = useState(() => localStorage.getItem('stonepit_skin') || 'wood');
  const [musicTrack, setMusicTrack] = useState(() => localStorage.getItem('stonepit_music') || 'savanna');
  const [soundEnabled, setSoundEnabled] = useState(() => localStorage.getItem('stonepit_sound') !== 'false');
  const [paymentPhone, setPaymentPhone] = useState('');
  const [paymentId, setPaymentId] = useState('');
  const [paymentStatus, setPaymentStatus] = useState('');

  const showError = error => setNotice(error?.message || 'Something went wrong');
  async function animateMove(state, pit, movingPlayer) {
    const run = ++animationRun.current;
    const { state: finalState, frames } = playMoveWithFrames(state, pit, movingPlayer);
    for (const [index, frame] of frames.entries()) {
      if (animationRun.current !== run) return finalState;
      setGame(frame.state);
      setAnimatedPit({ pit: frame.pit, type: frame.type });
      playGameSound(frame.type, index);
      const delay = frame.type === 'chain' ? 380 : frame.type === 'capture' ? 600 : frame.type === 'pick' ? 280 : 240;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    if (animationRun.current === run) {
      setGame(finalState);
      setAnimatedPit(null);
      if (finalState.status === 'finished') playGameSound('win');
    }
    return finalState;
  }

  useEffect(() => {
    if (!auth) {
      setAuthReady(true);
      return undefined;
    }
    return onAuthStateChanged(auth, async firebaseUser => {
      if (!firebaseUser) {
        setUser(null);
        setAuthReady(true);
        return;
      }
      try {
        const { user: account } = await api('/api/me/sync', {
          method: 'POST',
          body: JSON.stringify({
            name: pendingProfile.current?.name || firebaseUser.displayName || firebaseUser.email?.split('@')[0] || '',
            avatar: pendingProfile.current?.avatar || '🦁'
          })
        });
        setUser(account);
      } catch (error) {
        showError(error);
      } finally {
        setAuthReady(true);
      }
    });
  }, []);
  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(''), 3500);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => () => socket?.disconnect(), [socket]);
  useEffect(() => {
    if (!paymentId) return undefined;
    let active = true;
    let timer;
    let attempts = 0;
    const poll = async () => {
      try {
        const result = await api(`/api/payments/${encodeURIComponent(paymentId)}`);
        if (!active) return;
        if (result.status === 'completed') {
          setPaymentStatus('Payment confirmed. Coins have been added to your account.');
          const refreshed = await api('/api/me');
          if (active) setUser(refreshed.user);
          return;
        }
        if (result.status === 'failed') {
          setPaymentStatus('Payment was declined. You can try again.');
          return;
        }
        if (++attempts >= 20) {
          setPaymentStatus('Still waiting for confirmation. You can check again later.');
          return;
        }
        timer = setTimeout(poll, 3000);
      } catch (error) {
        if (active) setPaymentStatus(error.message);
      }
    };
    timer = setTimeout(poll, 3000);
    return () => { active = false; clearTimeout(timer); };
  }, [paymentId]);

  async function submitAuth(event) {
    event.preventDefault();
    if (!auth || !firebaseConfigured) {
      showError(new Error('Firebase is not configured. Add the Firebase web settings to apps/web/.env.local.'));
      return;
    }
    if (authMethod === 'phone') {
      await submitPhoneAuth();
      return;
    }
    setBusy(true);
    if (registering) pendingProfile.current = { name: form.name.trim(), avatar: form.avatar };
    try {
      const credential = registering
        ? await createUserWithEmailAndPassword(auth, form.email.trim(), form.password)
        : await signInWithEmailAndPassword(auth, form.email.trim(), form.password);
      if (registering) await updateProfile(credential.user, { displayName: form.name.trim() });
      const { user: account } = await api('/api/me/sync', {
        method: 'POST',
        body: JSON.stringify({
          name: registering ? form.name.trim() : credential.user.displayName || form.name.trim(),
          avatar: form.avatar
        })
      });
      pendingProfile.current = null;
      setGuestMode(false);
      setUser(account);
      setScreen('home');
      setNotice(`Welcome${registering ? '' : ' back'}, ${account.name}!`);
    } catch (error) {
      pendingProfile.current = null;
      showError(new Error(firebaseErrorMessage(error)));
    } finally {
      setBusy(false);
    }
  }

  async function submitPhoneAuth() {
    if (!auth || !firebaseConfigured) {
      showError(new Error('Firebase is not configured. Add the Firebase web settings to apps/web/.env.local.'));
      return;
    }
    if (!phoneConfirmation && !form.name.trim()) {
      showError(new Error('Enter a display name before continuing with phone sign-in.'));
      return;
    }
    setBusy(true);
    try {
      if (!phoneConfirmation) {
        recaptchaVerifier.current?.clear();
        recaptchaVerifier.current = new RecaptchaVerifier(auth, 'recaptcha-container', { size: 'normal' });
        const confirmation = await signInWithPhoneNumber(auth, phone.trim(), recaptchaVerifier.current);
        setPhoneConfirmation(confirmation);
        setNotice('Verification code sent. Check your phone.');
        return;
      }
      pendingProfile.current = { name: form.name.trim(), avatar: form.avatar };
      const credential = await phoneConfirmation.confirm(phoneCode.trim());
      await updateProfile(credential.user, { displayName: form.name.trim() });
      const { user: account } = await api('/api/me/sync', {
        method: 'POST',
        body: JSON.stringify({ name: form.name.trim(), avatar: form.avatar })
      });
      pendingProfile.current = null;
      setGuestMode(false);
      setUser(account);
      setScreen('home');
      setNotice(`Welcome, ${account.name}!`);
    } catch (error) {
      pendingProfile.current = null;
      showError(new Error(firebaseErrorMessage(error)));
      if (error?.code === 'auth/invalid-verification-code' || error?.code === 'auth/code-expired') {
        setPhoneConfirmation(null);
        setPhoneCode('');
      }
    } finally {
      setBusy(false);
    }
  }

  async function signInWithProvider(provider) {
    if (!auth || !firebaseConfigured) {
      showError(new Error('Firebase is not configured. Add the Firebase web settings to apps/web/.env.local.'));
      return;
    }
    setBusy(true);
    try {
      const credential = await signInWithPopup(auth, provider);
      const displayName = credential.user.displayName || credential.user.email?.split('@')[0] || '';
      const { user: account } = await api('/api/me/sync', {
        method: 'POST',
        body: JSON.stringify({ name: displayName || 'Stone Pit Player', avatar: form.avatar })
      });
      setGuestMode(false);
      setUser(account);
      setScreen('home');
      setNotice(`Welcome back, ${account.name}!`);
    } catch (error) {
      showError(new Error(firebaseErrorMessage(error)));
    } finally {
      setBusy(false);
    }
  }

  function signInWithApple() {
    const provider = new OAuthProvider('apple.com');
    provider.addScope('email');
    provider.addScope('name');
    return signInWithProvider(provider);
  }

  async function resetPassword() {
    if (!auth || !firebaseConfigured) {
      showError(new Error('Firebase is not configured. Add the Firebase web settings to apps/web/.env.local.'));
      return;
    }
    const email = form.email.trim();
    if (!email) {
      showError(new Error('Enter your email address first, then choose Forgot password.'));
      return;
    }
    setBusy(true);
    try {
      await sendPasswordResetEmail(auth, email);
      setNotice('If an account exists for that email, password reset instructions have been sent.');
    } catch (error) {
      showError(new Error(firebaseErrorMessage(error)));
    } finally {
      setBusy(false);
    }
  }

  async function startLocal() {
    activateAudio();
    animationRun.current++;
    setAnimatedPit(null);
    setGameMode('local');
    setGame(createGame());
    setGameId(null);
    setPlayer(1);
    setScreen('game');
  }
  async function startAi() {
    activateAudio();
    if (guestMode) {
      animationRun.current++;
      setAnimatedPit(null);
      setGameMode('guest-ai');
      setGame(createGame());
      setGameId(null);
      setPlayer(1);
      setScreen('game');
      return;
    }
    setBusy(true);
    try {
      const { game: newGame } = await api('/api/games', { method: 'POST', body: JSON.stringify({ difficulty }) });
      animationRun.current++;
      setAnimatedPit(null);
      setGame(newGame.state);
      setGameId(newGame.id);
      setGameMode('ai');
      setPlayer(1);
      setScreen('game');
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  }
  async function connectSocket() {
    activateAudio();
    const token = await getToken();
    if (!token) throw new Error('Sign in before starting an online game');
    const connection = io(socketUrl(), { auth: { token } });
    connection.on('connect_error', error => showError(error));
    connection.on('game:state', ({ game: nextGame, move }) => {
      setGameId(nextGame.id);
      if (nextGame.status !== 'waiting') setScreen('game');
      if (move) {
        setBusy(true);
        animateMove(move.state, move.pit, move.player)
          .then(() => setGame(nextGame.state))
          .catch(showError)
          .finally(() => {
            setBusy(false);
            if (nextGame.status === 'finished') {
              api('/api/me').then(({ user: refreshed }) => setUser(refreshed)).catch(showError);
            }
          });
      } else {
        setGame(nextGame.state);
      }
    });
    setSocket(connection);
    return connection;
  }
  async function createOnlineRoom() {
    try {
      const connection = await connectSocket();
      connection.emit('room:create', response => {
        if (response.error) return showError(new Error(response.error));
        setGameId(response.game.id);
        setPlayer(response.player);
        setGameMode('online');
        setGame(response.game.state);
        setRoomCode(response.game.roomCode);
        setScreen('lobby');
      });
    } catch (error) {
      showError(error);
    }
  }
  async function joinOnlineRoom() {
    try {
      const connection = await connectSocket();
      connection.emit('room:join', { code: roomEntry }, response => {
        if (response.error) return showError(new Error(response.error));
        setGameId(response.game.id);
        setPlayer(response.player);
        setGameMode('online');
        setGame(response.game.state);
        setRoomCode(response.game.roomCode);
        setScreen('game');
      });
    } catch (error) {
      showError(error);
    }
  }
  async function makeMove(pit) {
    if (!game || busy || game.status === 'finished') return;
    setBusy(true);
    try {
      if (gameMode === 'guest-ai') {
        let updated = await animateMove(game, pit, 1);
        if (updated.status !== 'finished') {
          await new Promise(resolve => setTimeout(resolve, 450));
          const aiPit = chooseAiMove(updated, difficulty);
          if (aiPit !== null) updated = await animateMove(updated, aiPit, 2);
        }
        setGame(updated);
      } else if (gameMode === 'ai') {
        const { game: updated, moves } = await api(`/api/games/${gameId}/moves`, {
          method: 'POST',
          body: JSON.stringify({ pit })
        });
        let animatedState = game;
        for (const move of moves) {
          animatedState = await animateMove(animatedState, move.pit, move.player);
          if (move.player === 1 && moves.length > 1) {
            await new Promise(resolve => setTimeout(resolve, 450));
          }
        }
        setGame(updated.state);
        if (updated.status === 'finished') {
          const { user: refreshed } = await api('/api/me');
          setUser(refreshed);
        }
      } else if (gameMode === 'online') {
        socket.emit('game:move', { gameId, pit }, response => {
          if (response.error) showError(new Error(response.error));
        });
      } else {
        setGame(await animateMove(game, pit, game.currentPlayer));
      }
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  }
  function playAgain() {
    if (gameMode === 'ai' || gameMode === 'guest-ai') return startAi();
    if (gameMode === 'local') return startLocal();
    setGame(null);
    setScreen('home');
  }
  async function loadLeaderboard() {
    if (guestMode) return requireAccount('the leaderboard');
    try {
      const result = await api('/api/leaderboard');
      setLeaderboard(result.players);
      setTab('ranks');
    } catch (error) {
      showError(error);
    }
  }
  async function buyCoins(itemId) {
    if (guestMode) return requireAccount('the coin shop');
    try {
      setPaymentStatus('');
      const { paymentId: id } = await api('/api/payments', {
        method: 'POST',
        body: JSON.stringify({ itemId, phone: paymentPhone })
      });
      setPaymentId(id);
      setPaymentStatus('Payment request sent. Approve the prompt on your phone.');
    } catch (error) {
      showError(error);
    }
  }
  function logout() {
    socket?.disconnect();
    setSocket(null);
    if (auth) signOut(auth).catch(showError);
    setUser(null);
    setGuestMode(false);
    setGame(null);
    setScreen('home');
    setTab('game');
  }
  function requireAccount(feature) {
    setGuestMode(false);
    setRegistering(true);
    setTab('game');
    setScreen('home');
    setNotice(`Create a free account to access ${feature}.`);
  }
  function chooseSkin(id) {
    setSkin(id);
    localStorage.setItem('stonepit_skin', id);
  }
  function activateAudio(track = musicTrack, enabled = soundEnabled) {
    startAudio(track, enabled).catch(showError);
  }
  function changeAudioSettings(track, enabled) {
    setMusicTrack(track);
    setSoundEnabled(enabled);
    localStorage.setItem('stonepit_music', track);
    localStorage.setItem('stonepit_sound', String(enabled));
    activateAudio(track, enabled);
  }

  if (!authReady && firebaseConfigured) {
    return <main className="auth-page"><div className="brand-mark">🪨</div><p className="muted">Connecting to Firebase…</p></main>;
  }
  if (!user && !guestMode) {
    return <main className={`auth-page theme-${skin}`}>
      <div className="brand-mark">🪨</div>
      <h1>African <span>🪨</span> Stone Pit</h1>
      <p className="eyebrow">CHAIN CAPTURE GAME 🥳 BY MTG7</p>
      <div className="auth-welcome">🪨 Welcome Back</div>
      <p className="muted auth-copy">Chain your moves. Capture the column. Claim the pit.</p>
      <div className="auth-methods" aria-label="Sign-in method">
        <button type="button" className={authMethod === 'email' ? 'selected' : ''} onClick={() => { setAuthMethod('email'); setPhoneConfirmation(null); }}>Email</button>
        <button type="button" className={authMethod === 'phone' ? 'selected' : ''} onClick={() => { setAuthMethod('phone'); setPhoneConfirmation(null); }}>Phone</button>
      </div>
      <form className="panel auth-form" onSubmit={submitAuth}>
        {(registering || authMethod === 'phone') && <>
          <label>Display name<input maxLength="18" required value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></label>
          <div className="avatar-select">{avatars.map(avatar => <button type="button" className={form.avatar === avatar ? 'selected' : ''} key={avatar} onClick={() => setForm({ ...form, avatar })}>{avatar}</button>)}</div>
        </>}
        {authMethod === 'email' ? <>
          <label>Email<input type="email" autoComplete="email" required value={form.email} onChange={event => setForm({ ...form, email: event.target.value })} /></label>
          <label>Password<input type="password" autoComplete={registering ? 'new-password' : 'current-password'} minLength="8" required value={form.password} onChange={event => setForm({ ...form, password: event.target.value })} /></label>
          {!registering && <button type="button" className="text-button auth-forgot" disabled={busy} onClick={resetPassword}>Forgot password?</button>}
          <button className="primary full" disabled={busy}>{busy ? 'Please wait…' : registering ? '▶ Create Account' : '▶ Enter the Game'}</button>
        </> : <>
          <label>Phone number<input type="tel" autoComplete="tel" placeholder="+254 7XX XXX XXX" required value={phone} onChange={event => setPhone(event.target.value)} /></label>
          {phoneConfirmation && <label>SMS verification code<input inputMode="numeric" autoComplete="one-time-code" required value={phoneCode} onChange={event => setPhoneCode(event.target.value)} /></label>}
          <button className="primary full" disabled={busy}>{busy ? 'Please wait…' : phoneConfirmation ? 'Verify and Enter the Game' : 'Send SMS code'}</button>
          <div id="recaptcha-container" />
        </>}
        <p className="auth-note">{firebaseConfigured ? 'Secure Firebase account · stats and progress are saved online' : 'Configure Firebase to enable accounts and online play'}</p>
        {authMethod === 'email' && <button type="button" className="text-button" onClick={() => setRegistering(!registering)}>{registering ? 'Already have an account? Sign in' : 'New here? Create an account'}</button>}
        <div className="auth-divider"><span>OR CONTINUE WITH</span></div>
        <div className="auth-providers">
          <button type="button" className="auth-provider" disabled={busy || !firebaseConfigured} onClick={() => signInWithProvider(new GoogleAuthProvider())}><b className="google-mark">G</b> Google</button>
          <button type="button" className="auth-provider" disabled={busy || !firebaseConfigured} onClick={signInWithApple}><b></b> Apple</button>
        </div>
        <p className="auth-note">Game Center sign-in is available only in a native iOS app, not in this web game.</p>
      </form>
      <button type="button" className="guest-button" onClick={() => { setGuestMode(true); setTab('game'); setScreen('home'); setNotice('Playing as a guest. Create an account to save progress and unlock more features.'); }}>Play as Guest</button>
      {notice && <Toast message={notice} />}
    </main>;
  }

  if (screen === 'game' && game) {
    return <GameScreen game={game} gameMode={gameMode} gameId={gameId} player={player} user={user || { name: 'Guest', avatar: '👤' }} skin={skin} busy={busy} animatedPit={animatedPit} musicTrack={musicTrack} soundEnabled={soundEnabled} onAudioChange={changeAudioSettings} onMove={makeMove} onExit={() => { animationRun.current++; setAnimatedPit(null); stopMusic(); socket?.disconnect(); setSocket(null); setScreen('home'); }} onAgain={playAgain} />;
  }
  if (screen === 'lobby') {
    return <main className="page narrow">
      <button className="back" onClick={() => { socket?.disconnect(); setSocket(null); setScreen('home'); }}>← Back</button>
      <section className="panel lobby-panel">
        <div className="brand-mark">🌐</div><h2>Waiting for a challenger</h2>
        <p className="muted">Share this room code with your friend</p>
        <div className="room-code">{roomCode}</div>
        <button className="secondary" onClick={() => navigator.clipboard.writeText(roomCode).then(() => setNotice('Room code copied'))}>Copy code</button>
        <p className="muted small">Keep this screen open until your friend joins.</p>
      </section>
      {notice && <Toast message={notice} />}
    </main>;
  }

  return <main className={`page theme-${skin}`}>
    <header className="topbar"><a className="brand" href="#" onClick={event => { event.preventDefault(); setScreen('home'); }}>AFRICAN <span>🪨</span> STONE PIT</a><div className="account">{user ? <><span>🪙 {user.coins}</span><button onClick={logout} title="Sign out">{user.avatar}</button></> : <button className="guest-signin" onClick={() => requireAccount('saved progress and account features')}>Create account</button>}</div></header>
    <nav className="tabs"><button className={tab === 'game' ? 'active' : ''} onClick={() => setTab('game')}>Play</button><button className={tab === 'ranks' ? 'active' : ''} onClick={loadLeaderboard}>Leaderboard</button><button className={tab === 'shop' ? 'active' : ''} onClick={() => guestMode ? requireAccount('the coin shop') : setTab('shop')}>Shop</button><button className={tab === 'profile' ? 'active' : ''} onClick={() => guestMode ? requireAccount('your player profile') : setTab('profile')}>Profile</button></nav>
    {tab === 'game' && <section className="home-content">
      <div className="welcome"><div><p className="eyebrow">READY WHEN YOU ARE</p><h1>Welcome, {guestMode ? 'Guest' : user.name}</h1><p className="muted">{guestMode ? 'Play right away. Create a free account to save progress and unlock online features.' : 'Choose a game mode and make your move.'}</p></div><div className="welcome-avatar">{guestMode ? '👤' : user.avatar}</div></div>
      <h2 className="section-title">Choose your game</h2>
      <div className="mode-grid">
        <button className="mode-card" onClick={startLocal}><span>👥</span><strong>Pass & Play</strong><small>Two players, one device</small></button>
        <button className="mode-card" onClick={() => setScreen('difficulty')}><span>🤖</span><strong>Play vs AI</strong><small>Practice against the computer</small></button>
        <button className="mode-card" onClick={() => guestMode ? requireAccount('online multiplayer') : setScreen('online')}><span>🌐</span><strong>Online</strong><small>{guestMode ? 'Create an account to play online' : 'Challenge a friend'}</small></button>
      </div>
      {guestMode ? <section className="panel guest-prompt"><h2>Save your progress</h2><p className="muted">Create a free account to track stats, join online games, view the leaderboard, and use the coin shop.</p><button className="primary" onClick={() => requireAccount('saved progress and account features')}>Create free account</button></section> : <section className="panel stats-panel"><h2>Your progress</h2><div className="stats-grid"><Stat label="Games" value={user.games} /><Stat label="Wins" value={user.wins} /><Stat label="Captures" value={user.captures} /><Stat label="XP" value={user.xp} /></div></section>}
      <section className="skin-picker"><h2>🎨 Game Table Skin</h2><div>{tableSkins.map(option => <button key={option.id} aria-label={option.label} title={option.label} className={`skin-${option.id}${skin === option.id ? ' selected' : ''}`} onClick={() => chooseSkin(option.id)} />)}</div></section>
      <section className="audio-settings"><h2>🎵 Sound & music</h2><AudioControls track={musicTrack} enabled={soundEnabled} onChange={changeAudioSettings} /></section>
    </section>}
    {tab === 'game' && screen === 'difficulty' && <section className="panel choice-panel"><button className="back" onClick={() => setScreen('home')}>← Back</button><p className="eyebrow">SINGLE PLAYER</p><h2>Choose difficulty</h2><div className="difficulty">{['easy', 'medium', 'hard'].map(level => <button className={difficulty === level ? 'selected' : ''} key={level} onClick={() => setDifficulty(level)}>{level}</button>)}</div><button className="primary full" disabled={busy} onClick={startAi}>Start game</button></section>}
    {tab === 'game' && screen === 'online' && <section className="panel choice-panel"><button className="back" onClick={() => setScreen('home')}>← Back</button><p className="eyebrow">REAL-TIME MATCH</p><h2>Play online</h2><button className="primary full" onClick={createOnlineRoom}>Create room</button><div className="separator">OR JOIN A ROOM</div><input className="code-input" aria-label="Room code" placeholder="Enter room code" maxLength="8" value={roomEntry} onChange={event => setRoomEntry(event.target.value.toUpperCase())} /><button className="secondary full" onClick={joinOnlineRoom} disabled={roomEntry.length < 6}>Join room</button></section>}
    {tab === 'ranks' && <section className="home-content"><p className="eyebrow">THE BEST OF THE BEST</p><h1>Leaderboard</h1>{leaderboard.map((entry, index) => <div className="rank-row" key={`${entry.name}-${index}`}><b>#{index + 1}</b><span>{entry.avatar} {entry.name}</span><small>{entry.points} pts · {entry.wins} wins</small></div>)}</section>}
    {tab === 'shop' && <section className="home-content"><p className="eyebrow">SUPPORT THE GAME</p><h1>Coin shop</h1><p className="muted">Payments are verified by the server before coins are credited.</p><div className="mode-grid coin-grid">{[{ id: 'sc-sm', coins: 500, price: 50 }, { id: 'sc-bg', coins: 1200, price: 100 }, { id: 'sc-xl', coins: 3000, price: 200 }].map(pack => <div className="panel coin-pack" key={pack.id}><span>🪙</span><strong>{pack.coins} coins</strong><small>{pack.price} KES</small><button className="secondary" onClick={() => buyCoins(pack.id)}>Pay with M-Pesa</button></div>)}</div><label className="phone-field">M-Pesa number<input inputMode="numeric" placeholder="2547XXXXXXXX" value={paymentPhone} onChange={event => setPaymentPhone(event.target.value)} /></label>{paymentStatus && <p className="muted" role="status">{paymentStatus}</p>}</section>}
    {tab === 'profile' && <Profile user={user} onSave={async details => { try { const result = await api('/api/me', { method: 'PATCH', body: JSON.stringify(details) }); setUser(result.user); setNotice('Profile saved'); } catch (error) { showError(error); } }} />}
    {notice && <Toast message={notice} />}
  </main>;
}

function firebaseErrorMessage(error) {
  const messages = {
    'auth/email-already-in-use': 'An account already exists for this email.',
    'auth/invalid-email': 'Enter a valid email address.',
    'auth/invalid-credential': 'Email or password is incorrect.',
    'auth/user-disabled': 'This account has been disabled.',
    'auth/weak-password': 'Choose a password with at least 6 characters.',
    'auth/network-request-failed': 'Could not reach Firebase. Check your connection.',
    'auth/popup-closed-by-user': 'The sign-in window was closed before completing sign-in.',
    'auth/popup-blocked': 'Your browser blocked the sign-in window. Allow popups and try again.',
    'auth/unauthorized-domain': 'Add this site to Firebase Authentication authorized domains.',
    'auth/operation-not-allowed': 'This sign-in provider is not enabled in Firebase Authentication.',
    'auth/account-exists-with-different-credential': 'An account with this email already uses another sign-in method.',
    'auth/user-not-found': 'If an account exists for that email, password reset instructions have been sent.',
    'auth/invalid-phone-number': 'Enter a phone number in international format, such as +254712345678.',
    'auth/missing-phone-number': 'Enter your phone number, including the country code.',
    'auth/invalid-verification-code': 'That SMS code is incorrect. Check it and try again.',
    'auth/code-expired': 'That SMS code has expired. Request a new code.',
    'auth/captcha-check-failed': 'Phone verification failed. Complete the reCAPTCHA check and try again.',
    'auth/too-many-requests': 'Too many attempts. Wait a little while before trying again.'
  };
  return messages[error?.code] || error?.message || 'Firebase authentication failed.';
}

function Stat({ label, value }) {
  return <div><strong>{value}</strong><small>{label}</small></div>;
}

function Toast({ message }) {
  return <div className="toast" role="status">{message}</div>;
}

function Profile({ user, onSave }) {
  const [name, setName] = useState(user.name);
  const [avatar, setAvatar] = useState(user.avatar);
  return <section className="panel profile-panel"><p className="eyebrow">YOUR ACCOUNT</p><h1>Player profile</h1><form onSubmit={event => { event.preventDefault(); onSave({ name, avatar }); }}><label>Display name<input maxLength="18" required value={name} onChange={event => setName(event.target.value)} /></label><p className="form-label">Choose avatar</p><div className="avatar-select">{avatars.map(option => <button type="button" className={avatar === option ? 'selected' : ''} key={option} onClick={() => setAvatar(option)}>{option}</button>)}</div><button className="primary">Save profile</button></form></section>;
}

function GameScreen({ game, gameMode, player, user, skin, busy, animatedPit, musicTrack, soundEnabled, onAudioChange, onMove, onExit, onAgain }) {
  const currentPlayer = game.currentPlayer;
  const owned = PLAYER_PITS[currentPlayer];
  const isYourTurn = gameMode === 'local' || (gameMode === 'online' ? player === currentPlayer : currentPlayer === 1);
  const player1Name = gameMode === 'online' ? (player === 1 ? user.name : 'Opponent') : gameMode === 'local' ? 'Player 1' : user.name;
  const player2Name = gameMode === 'ai' || gameMode === 'guest-ai' ? 'AI' : gameMode === 'online' ? (player === 2 ? user.name : 'Opponent') : 'Player 2';
  const player1Avatar = gameMode === 'local' || (gameMode === 'online' && player !== 1) ? '👤' : user.avatar;
  const player2Avatar = gameMode === 'ai' || gameMode === 'guest-ai' ? '🤖' : gameMode === 'local' || (gameMode === 'online' && player !== 2) ? '👤' : user.avatar;
  const winnerName = game.scores[1] === game.scores[2] ? null : game.scores[1] > game.scores[2] ? player1Name : player2Name;
  const turnText = game.status === 'finished'
    ? 'Game finished'
    : gameMode === 'local'
      ? `Player ${currentPlayer} — pick a glowing pit`
      : isYourTurn
        ? 'Your turn — pick a glowing pit'
        : 'Opponent’s turn';
  return <main className={`game-page theme-${skin}`}>
    <header className="game-title">
      <h1>AFRICAN <span>🪨</span> STONE PIT</h1>
      <p>CHAIN CAPTURE GAME 🥳 BY MTG7</p>
    </header>
    <div className="turn-bar">
      <div className={`turn-player ${currentPlayer === 1 ? 'turn-active' : ''}`}><i />{player1Name}</div>
      <div className="turn-message" role="status">{turnText}</div>
      <div className={`turn-player turn-player-two ${currentPlayer === 2 ? 'turn-active' : ''}`}><i />{player2Name}</div>
    </div>
    <section className="board" aria-label="Stone Pit game board">
      <div className={`board-side board-top ${currentPlayer === 2 && game.status === 'active' ? 'side-active' : ''}`}><span>▲</span> {player2Name} <small>· 8 HOLES</small></div>
      <PitRow indices={[0, 1, 2, 3]} game={game} playable={gameMode === 'local' ? currentPlayer === 2 : isYourTurn && currentPlayer === 2} owned={owned} busy={busy} animatedPit={animatedPit} onMove={onMove} />
      <PitRow indices={[4, 5, 6, 7]} game={game} playable={gameMode === 'local' ? currentPlayer === 2 : isYourTurn && currentPlayer === 2} owned={owned} busy={busy} animatedPit={animatedPit} onMove={onMove} />
      <div className="board-middle" aria-hidden="true" />
      <PitRow indices={[8, 9, 10, 11]} game={game} playable={isYourTurn && currentPlayer === 1} owned={owned} busy={busy} animatedPit={animatedPit} onMove={onMove} />
      <PitRow indices={[12, 13, 14, 15]} game={game} playable={isYourTurn && currentPlayer === 1} owned={owned} busy={busy} animatedPit={animatedPit} onMove={onMove} />
      <div className={`board-side board-bottom ${currentPlayer === 1 && game.status === 'active' ? 'side-active' : ''}`}><span>▼</span> {player1Name} <small>· 8 HOLES</small></div>
    </section>
    <div className="scoreboard">
      <div className={`score score-two ${currentPlayer === 2 ? 'active-score' : ''}`}><span>{player2Avatar}</span><small>{player2Name}</small><strong>{game.scores[2]}</strong></div>
      <div className={`score score-one ${currentPlayer === 1 ? 'active-score' : ''}`}><span>{player1Avatar}</span><small>{player1Name}</small><strong>{game.scores[1]}</strong></div>
    </div>
    <div className="game-actions"><button className="secondary" onClick={onExit}>◀ MENU</button><button className="primary" onClick={gameMode === 'online' ? onExit : onAgain}>{gameMode === 'online' ? '◀ BACK TO MENU' : '↻ RESTART'}</button></div>
    <AudioControls track={musicTrack} enabled={soundEnabled} onChange={onAudioChange} />
    <div className="rule-hint"><strong>1.</strong> Any row + stones → ⛓ Chain! Keep sowing. <strong>2.</strong> Inner row + empty → if opponent inner pit has stones, capture the column. <strong>3.</strong> Outer row + empty → turn ends.</div>
    {game.status === 'finished' && winnerName && <div className="game-celebration" aria-hidden="true">{Array.from({ length: 32 }, (_, index) => <i key={index} style={{ left: `${(index * 37) % 100}%`, animationDelay: `${(index % 6) * 0.17}s`, '--confetti-duration': `${1.6 + (index % 4) * 0.28}s`, background: ['#ffc94d', '#4fd8c4', '#c8372d', '#1f8a55'][index % 4] }} />)}</div>}
    {game.status === 'finished' && <div className="game-over panel"><h2>{winnerName ? `🏆 ${winnerName} wins!` : '🤝 It’s a draw!'}</h2><p>{player1Name}: {game.scores[1]} points · {player2Name}: {game.scores[2]} points</p><button className="primary" onClick={onAgain}>Play again</button></div>}
  </main>;
}

function PitRow({ indices, game, playable, owned, busy, animatedPit, onMove }) {
  return <div className="pit-row">{indices.map(index => {
    const count = game.pits[index].count;
    const active = playable && owned.includes(index) && count > 0 && game.status === 'active' && !busy;
    const animationType = animatedPit?.pit === index ? animatedPit.type : '';
    return <button key={index} aria-label={`Pit ${index + 1}, ${count} stones`} className={`pit${active ? ' pit-active' : ''}${animationType ? ` pit-sowing pit-${animationType}` : ''}`} onClick={() => active && onMove(index)} disabled={!active}>
      <span className="stones">{Array.from({ length: Math.min(count, 12) }, (_, n) => <i key={n} className={`stone stone-${index % 4}`} />)}{count > 12 && <small>+{count - 12}</small>}</span><b>{count}</b>
    </button>;
  })}</div>;
}

function AudioControls({ track, enabled, onChange }) {
  return <div className="audio-controls">
    <label>Music
      <select aria-label="Music track" value={track} onChange={event => onChange(event.target.value, enabled)}>
        {musicTracks.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
      </select>
    </label>
    <button type="button" className="audio-toggle" aria-pressed={enabled} onClick={() => onChange(track, !enabled)}>
      {enabled ? '🔊 Sound on' : '🔇 Sound off'}
    </button>
  </div>;
}
