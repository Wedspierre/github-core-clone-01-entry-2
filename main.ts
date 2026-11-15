// main.ts — entry point: build the store, bind an ephemeral port, register with the
// trial environment, and stay alive until the environment reports done.

import { Agent as HttpAgent, get as httpGet } from 'node:http';
import { Agent as HttpsAgent, get as httpsGet } from 'node:https';
import { createApp } from './app.ts';
import { Store } from './store.ts';

/** One keep-alive agent per scheme, so the /done poll reuses its socket. */
const httpKeepAlive = new HttpAgent({ keepAlive: true });
const httpsKeepAlive = new HttpsAgent({ keepAlive: true });

const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl === undefined || envUrl === '') {
  console.error('MAKEFUN_ENV_URL is not set');
  process.exit(1);
}

const store = new Store();
const server = createApp(store);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson(url: string, body: unknown): Promise<{ status: number; text: string }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

async function getJson(url: string): Promise<{ status: number; body: unknown }> {
  // Plain node:http(s) on a keep-alive agent, not fetch: waitDone polls /done every
  // 250 ms for the whole trial, and undici's fetch pays proxy-agent resolution and a
  // fresh dispatcher path on every poll — CPU the timed workloads then lose.
  const isHttps = url.startsWith('https:');
  const getter = isHttps ? httpsGet : httpGet;
  return new Promise((resolve, reject) => {
    const req = getter(url, { agent: isHttps ? httpsKeepAlive : httpKeepAlive }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        let body: unknown = null;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          body = null;
        }
        resolve({ status: res.statusCode ?? 0, body });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('poll timed out')));
  });
}

async function register(port: number): Promise<void> {
  let delay = 250;
  for (;;) {
    try {
      const { status } = await postJson(`${envUrl}/register`, { port });
      if (status === 200 || status === 409) return;
      if (status === 400 || status === 405) {
        console.error(`register rejected with ${status}`);
        process.exit(1);
      }
    } catch (err) {
      console.error(`register failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await sleep(delay);
    delay = Math.min(2000, delay * 2);
  }
}

async function waitDone(): Promise<void> {
  for (;;) {
    await sleep(250);
    try {
      const { body } = await getJson(`${envUrl}/done`);
      if (body !== null && typeof body === 'object' && (body as Record<string, unknown>).done === true) return;
    } catch {
      // The environment is not answering yet; keep polling.
    }
  }
}

server.listen(0, '127.0.0.1', async () => {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    console.error('could not determine the bound port');
    process.exit(1);
  }
  const port = address.port;
  console.error(`listening on 127.0.0.1:${port}`);
  await register(port);
  await waitDone();
  server.close(() => process.exit(0));
});

server.on('error', (err) => {
  console.error(`server error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
