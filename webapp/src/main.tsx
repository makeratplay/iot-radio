import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

const API = import.meta.env.VITE_API_URL?.replace(/\/$/, '');
const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;
const TOKEN_KEY = 'iot-radio-google-id-token';
type Station = { id: string; name: string; url: string };
type Device = { id: string; state?: unknown };
type Identity = { sub?: string; email?: string; exp?: number };

class AuthError extends Error {}

function decodeJwt(token: string): Identity {
  try {
    const payload = token.split('.')[1];
    if (!payload) return {};
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(padded.padEnd(padded.length + (4 - padded.length % 4) % 4, '='));
    return JSON.parse(json) as Identity;
  } catch {
    return {};
  }
}

function readToken() {
  const token = sessionStorage.getItem(TOKEN_KEY);
  const exp = token ? decodeJwt(token).exp : undefined;
  if (!token || !exp || exp * 1000 < Date.now() + 30_000) {
    sessionStorage.removeItem(TOKEN_KEY);
    return null;
  }
  return token;
}

function loadGoogle() {
  if (window.google?.accounts.id) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-google-signin]');
    const script = existing ?? document.createElement('script');
    script.addEventListener('load', () => resolve(), { once: true });
    script.addEventListener('error', () => reject(new Error('Google Sign-In failed to load')), { once: true });
    if (!existing) {
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.dataset.googleSignin = 'true';
      document.head.appendChild(script);
    }
  });
}

async function request(path: string, method = 'GET', body?: unknown) {
  const token = readToken();
  if (!token) throw new AuthError('Sign in first');
  const res = await fetch(API + path, {
    method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    sessionStorage.removeItem(TOKEN_KEY);
    throw new AuthError('Session expired. Sign in again.');
  }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function App() {
  const [token, setToken] = useState<string | null>(() => readToken());
  const [error, setError] = useState('');
  const [devices, setDevices] = useState<Device[]>([]);
  const [stations, setStations] = useState<Station[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [volume, setVolume] = useState(50);
  const buttonRef = useRef<HTMLDivElement>(null);
  const identity = token ? decodeJwt(token) : null;
  function fail(e: unknown) {
    if (e instanceof AuthError) setToken(null);
    setError(e instanceof Error ? e.message : String(e));
  }
  async function refresh() {
    try {
      const [d, s] = await Promise.all([request('/devices'), request('/stations')]);
      setDevices(d.items); setStations(s.items);
      if (d.items.length) setDeviceId(current => current || d.items[0].id);
    } catch (e) { fail(e); }
  }
  useEffect(() => {
    if (token) return;
    if (!GOOGLE_CLIENT_ID) { setError('Set VITE_GOOGLE_CLIENT_ID'); return; }
    let cancelled = false;
    loadGoogle().then(() => {
      const parent = buttonRef.current;
      if (cancelled || !parent || !window.google) return;
      window.google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: response => {
          sessionStorage.setItem(TOKEN_KEY, response.credential);
          setToken(response.credential);
          setError('');
        }
      });
      parent.replaceChildren();
      window.google.accounts.id.renderButton(parent, { theme: 'filled_blue', size: 'large', text: 'signin_with', width: 280 });
    }).catch(fail);
    return () => { cancelled = true; };
  }, [token]);
  useEffect(() => {
    if (!token) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 10000);
    return () => clearInterval(timer);
  }, [token]);
  async function command(command: string, extra: Record<string, unknown> = {}) {
    if (!deviceId) return;
    try { setError(''); await request('/devices/' + encodeURIComponent(deviceId) + '/commands', 'POST', { command, ...extra }); }
    catch (e) { fail(e); }
  }
  async function addStation(e: React.FormEvent) {
    e.preventDefault();
    try { await request('/stations', 'POST', { name, url }); setName(''); setUrl(''); await refresh(); }
    catch (e) { fail(e); }
  }
  function signOut() {
    if (identity?.email) window.google?.accounts.id.revoke(identity.email, () => {});
    window.google?.accounts.id.disableAutoSelect();
    sessionStorage.removeItem(TOKEN_KEY);
    setToken(null);
  }
  return <main>
    <h1>IoT Radio</h1>
    {error && <p className="error">{error}</p>}
    {!token ? <section><h2>Sign in</h2><div className="google-button" ref={buttonRef}></div></section> :
    <>
      <p className="hint">Signed in{identity?.email ? ` as ${identity.email}` : ''}. Owner id <code>{identity?.sub}</code></p>
      <button onClick={signOut}>Sign out</button>
      <section><h2>Radio</h2><select value={deviceId} onChange={e => setDeviceId(e.target.value)}><option value="">Select device</option>{devices.map(d => <option key={d.id} value={d.id}>{d.id}</option>)}</select>
        <div className="controls"><button disabled={!deviceId} onClick={() => command('play')}>Play</button><button disabled={!deviceId} onClick={() => command('stop')}>Stop</button></div>
        <label>Volume {volume}<input type="range" min="0" max="100" value={volume} disabled={!deviceId} onChange={e => setVolume(Number(e.target.value))} onMouseUp={() => void command('set_volume', { volume })} onTouchEnd={() => void command('set_volume', { volume })}/></label>
        <pre>{JSON.stringify(devices.find(d => d.id === deviceId)?.state ?? {}, null, 2)}</pre>
      </section>
      <section><h2>Stations</h2>{stations.map(s => <div className="station" key={s.id}><span>{s.name}</span><button disabled={!deviceId} onClick={() => command('set_station', { url: s.url })}>Tune</button></div>)}
        <form onSubmit={addStation}><input placeholder="Station name" value={name} onChange={e => setName(e.target.value)} required/><input type="url" placeholder="Direct MP3 stream URL" value={url} onChange={e => setUrl(e.target.value)} required/><button>Add station</button></form>
      </section>
    </>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
