import { createApp } from "./app.ts";

const envUrl = process.env.MAKEFUN_ENV_URL;
const token = process.env.MAKEFUN_SHOP_TOKEN ?? "";

if (!envUrl) {
  console.error("MAKEFUN_ENV_URL is not set");
  process.exit(1);
}

const headers: Record<string, string> = {
  "content-type": "application/json",
};
if (token) {
  headers.authorization = `Bearer ${token}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function register(port: number): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${envUrl}/register`, {
        method: "POST",
        headers,
        body: JSON.stringify({ port }),
      });
      if (res.ok) return;
      console.error(`register attempt ${attempt} failed: HTTP ${res.status}`);
    } catch (err) {
      console.error(`register attempt ${attempt} failed:`, err);
    }
    if (attempt >= 10) {
      console.error("register failed after 10 attempts");
      process.exit(1);
    }
    await sleep(500);
  }
}

async function waitForDone(): Promise<void> {
  for (;;) {
    try {
      const res = await fetch(`${envUrl}/done`, { headers });
      if (res.ok) {
        const body = (await res.json()) as { done?: boolean };
        if (body.done === true) return;
      } else {
        console.error(`done poll answered HTTP ${res.status}`);
      }
    } catch (err) {
      console.error("done poll failed:", err);
    }
    await sleep(500);
  }
}

const server = createApp();
server.listen(0, () => {
  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  if (!port) {
    console.error("server has no port after listen");
    process.exit(1);
  }
  console.log(`forge listening on port ${port}`);
  register(port)
    .then(() => waitForDone())
    .then(() => {
      server.close();
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
});
