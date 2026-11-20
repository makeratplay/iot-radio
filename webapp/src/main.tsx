import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Amplify } from 'aws-amplify';
import { signIn, signOut, fetchAuthSession, getCurrentUser } from '@aws-amplify/auth';
import './style.css';

Amplify.configure({ Auth: { Cognito: {
  userPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID,
  userPoolClientId: import.meta.env.VITE_COGNITO_CLIENT_ID
} } });

const API = import.meta.env.VITE_API_URL?.replace(/\/$/, '');
type Station = { id: string; name: string; url: string };
type Device = { id: string; state?: unknown };

async function request(path: string, method = 'GET', body?: unknown) {
  const session = await fetchAuthSession();
  const token = session.tokens?.accessToken?.toString();
  if (!token) throw new Error('Sign in first');
  const res = await fetch(API + path, {
    method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function App() {
  const [user, setUser] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [devices, setDevices] = useState<Device[]>([]);
  const [stations, setStations] = useState<Station[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [volume, setVolume] = useState(50);
  async function refresh() {
    try {
      const [d, s] = await Promise.all([request('/devices'), request('/stations')]);
      setDevices(d.items); setStations(s.items);
      if (!deviceId && d.items.length) setDeviceId(d.items[0].id);
    } catch (e) { setError(String(e)); }
  }
  useEffect(() => { getCurrentUser().then(() => setUser(true)).catch(() => {}); }, []);
  useEffect(() => {
    if (!user) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 10000);
    return () => clearInterval(timer);
  }, [user]);
  async function login(e: React.FormEvent) {
    e.preventDefault(); setError('');
    try {
      const result = await signIn({ username: email, password });
      if (!result.isSignedIn) throw new Error('Additional Cognito challenge required; complete initial password setup in AWS first.');
      setUser(true);
    } catch (e) { setError(String(e)); }
  }
  async function command(command: string, extra: Record<string, unknown> = {}) {
    try { setError(''); await request('/devices/' + encodeURIComponent(deviceId) + '/commands', 'POST', { command, ...extra }); }
    catch (e) { setError(String(e)); }
  }
  async function addStation(e: React.FormEvent) {
    e.preventDefault();
    try { await request('/stations', 'POST', { name, url }); setName(''); setUrl(''); await refresh(); }
    catch (e) { setError(String(e)); }
  }
  return <main>
    <h1>IoT Radio</h1>
    {error && <p className="error">{error}</p>}
    {!user ? <form onSubmit={login}><h2>Sign in</h2><input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} required/><input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} required/><button>Sign in</button></form> :
    <>
      <button onClick={() => signOut().then(() => setUser(false))}>Sign out</button>
      <section><h2>Radio</h2><select value={deviceId} onChange={e => setDeviceId(e.target.value)}><option value="">Select device</option>{devices.map(d => <option key={d.id} value={d.id}>{d.id}</option>)}</select>
        <div className="controls"><button disabled={!deviceId} onClick={() => command('play')}>Play</button><button disabled={!deviceId} onClick={() => command('stop')}>Stop</button></div>
        <label>Volume {volume}<input type="range" min="0" max="100" value={volume} onChange={e => setVolume(Number(e.target.value))} onMouseUp={() => void command('set_volume', { volume })} onTouchEnd={() => void command('set_volume', { volume })}/></label>
        <pre>{JSON.stringify(devices.find(d => d.id === deviceId)?.state ?? {}, null, 2)}</pre>
      </section>
      <section><h2>Stations</h2>{stations.map(s => <div className="station" key={s.id}><span>{s.name}</span><button disabled={!deviceId} onClick={() => command('set_station', { url: s.url })}>Tune</button></div>)}
        <form onSubmit={addStation}><input placeholder="Station name" value={name} onChange={e => setName(e.target.value)} required/><input type="url" placeholder="Direct MP3 stream URL" value={url} onChange={e => setUrl(e.target.value)} required/><button>Add station</button></form>
      </section>
    </>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
