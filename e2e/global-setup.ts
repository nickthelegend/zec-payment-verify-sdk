// The stack is started separately (./stack.sh) so its PIDs are known and killed by PID afterwards.
// Fail loudly if it isn't up instead of testing nothing.
export const URLS = {
  api: 'http://127.0.0.1:8420',
  apiXcheck: 'http://127.0.0.1:8421',
  paywall: 'http://127.0.0.1:8422',
  replay: 'http://127.0.0.1:8423',
  /** Nothing listens here: the dashboard on 5192 points at it. */
  apiDown: 'http://127.0.0.1:8429',
  dashboard: 'http://127.0.0.1:5190',
  dashboardXcheck: 'http://127.0.0.1:5191',
  dashboardDown: 'http://127.0.0.1:5192',
  /** The GitHub Pages site (scripts/build-pages.sh): landing at /, console at /dashboard/. */
  landing: 'http://127.0.0.1:5193',
};

export default async function globalSetup() {
  const up = [`${URLS.api}/api/health`, `${URLS.apiXcheck}/api/health`, `${URLS.paywall}/api/health`, `${URLS.replay}/api/health`, `${URLS.dashboard}/`, `${URLS.dashboardXcheck}/`, `${URLS.dashboardDown}/`, `${URLS.landing}/`, `${URLS.landing}/dashboard/`];
  for (const u of up) {
    const r = await fetch(u).catch((e) => {
      throw new Error(`Hanko stack not running (${u}: ${e.cause?.code || e.message}). Start it with: npm run stack`);
    });
    if (!r.ok) throw new Error(`${u} answered ${r.status}; restart the stack (npm run stack:stop && npm run stack)`);
  }
  const down = await fetch(`${URLS.apiDown}/api/health`).then(() => true, () => false);
  if (down) throw new Error(`${URLS.apiDown} is answering, but the Setup-required dashboard needs nothing there`);
}
