/**
 * WP06 — isolated production HTTP fixture (T025).
 *
 * Starts the BUILT adapter-node server (`node build`) on an isolated port with
 * private, disposable database storage and checked migrations, then drives it
 * with real HTTP requests. This proves that real HTTP reaches the hooks,
 * authentication and repositories (no injected locals, no fake repositories,
 * no test-control endpoint is exported to production).
 *
 * Ownership (WP06 boundary):
 *  - This helper and the backend entry points (`sqlite.test.ts` /
 *    `postgres.test.ts`) are owned by WP06. Each entry imports `auth.suite.ts`
 *    and `probes.suite.ts` ONLY.
 *  - WP07 later supplies `integrations.sqlite.test.ts` /
 *    `integrations.postgres.test.ts` and imports this helper; no forward
 *    imports, dynamic optional discovery or edits to WP06 files are needed.
 *
 * The fixture owns process exit/readiness deadlines, cookie jars and complete
 * teardown (success, exception and timeout). It never writes to the primary
 * checkout's real database and never touches CI/CD.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// Repository-relative: okr-app/build (adapter-node output).
export const OKR_APP_DIR = join(here, '..', '..');
export const BUILD_DIR = join(OKR_APP_DIR, 'build');

/** Return a URL that safely describes a child process for logging (redacted). */
function safeProcessLabel(backend: 'sqlite' | 'postgres'): string {
	return `built-server-${backend}`;
}

/** Wait until `build/index.js` exists; trigger a build if the app was never built. */
export async function ensureBuildBuilt(): Promise<string> {
	const { existsSync } = await import('node:fs');
	if (existsSync(BUILD_DIR)) return BUILD_DIR;
	const { execSync } = await import('node:child_process');
	execSync('npm run build', { cwd: OKR_APP_DIR, stdio: 'inherit' });
	return BUILD_DIR;
}

/** Open a random ephemeral TCP port and return its number (then close it). */
export async function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.unref();
		srv.on('error', reject);
		srv.listen(0, '127.0.0.1', () => {
			const addr = srv.address();
			if (addr && typeof addr === 'object') {
				const port = addr.port;
				srv.close(() => resolve(port));
			} else {
				srv.close(() => reject(new Error('unable to allocate ephemeral port')));
			}
		});
	});
}

/** A minimal in-memory cookie jar for real session cookies across requests. */
export class CookieJar {
	private cookies = new Map<string, string>();

	setFromHeaders(headers: Headers): void {
		const raw = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
		for (const line of raw) {
			const [pair] = line.split(';');
			const eq = pair.indexOf('=');
			if (eq < 0) continue;
			const name = pair.slice(0, eq).trim();
			const value = pair.slice(eq + 1).trim();
			if (value === '' || value.toLowerCase() === 'deleted') {
				this.cookies.delete(name);
			} else {
				this.cookies.set(name, value);
			}
		}
	}

	header(): string {
		return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
	}
}

/** A running built server process with a convenience HTTP client. */
export interface RunningServer {
	/** Base URL, e.g. `http://127.0.0.1:PORT`. */
	baseUrl: string;
	port: number;
	/** The server process PID (unchanged across outage/recovery in probe tests). */
	pid: number;
	/** Disposable data directory (removed on teardown). */
	dataDir: string;
	/** Backend this server was started with. */
	backend: 'sqlite' | 'postgres';
	/** Issue a request, applying an optional cookie jar and capturing new cookies. */
	request(
		path: string,
		init?: RequestInit,
		jar?: CookieJar
	): Promise<Response>;
	/** Register a user through the real route and return the response + jar. */
	register(username: string, password: string, jar?: CookieJar): Promise<Response>;
	/** Log a user in through the real route and return the response + jar. */
	login(username: string, password: string, jar?: CookieJar): Promise<Response>;
	/** Poll `/api/ready` until 200 or the deadline passes. */
	waitReady(deadlineMs?: number): Promise<boolean>;
	/** Stop the process and remove disposable storage. Idempotent. */
	stop(): Promise<void>;
}

export interface StartOptions {
	backend: 'sqlite' | 'postgres';
	/** Extra environment for the server process. */
	env?: Record<string, string>;
	/** How long to wait for readiness before the server is considered failed. */
	readyDeadlineMs?: number;
	/**
	 * Reuse an existing disposable data directory instead of creating a fresh
	 * one (the caller owns its contents and can pre-arrange storage faults).
	 */
	dataDir?: string;
	/**
	 * When true (default) startup waits until `/api/ready` returns 200.
	 * When false it waits only until the process is listening (`/api/health`
	 * responds), so storage-unavailable startup can be inspected (health 200,
	 * readiness 503).
	 */
	requireReady?: boolean;
}

const READY_DEADLINE_MS = 20_000;

/**
 * Start the built server on an isolated port with disposable storage.
 *
 * SQLite: fresh temp `DATABASE_PATH`, `MIGRATION_MODE` unset (checked
 * migration runs on first readiness). PostgreSQL: a fresh disposable database
 * created via `RUOK_TEST_PG_ADMIN_URL` (admin URL is REQUIRED for postgres).
 */
export async function startServer(opts: StartOptions): Promise<RunningServer> {
	const { backend } = opts;
	await ensureBuildBuilt();

	const port = await findFreePort();
	const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), `ruok-http-${backend}-`));
	const baseUrl = `http://127.0.0.1:${port}`;
	const serverEnv: Record<string, string> = {
		...process.env,
		NODE_ENV: 'production',
		HOST: '127.0.0.1',
		PORT: String(port),
		...opts.env
	};

	// Resolve DATABASE_TYPE/path or DATABASE_URL for the chosen backend.
	if (backend === 'sqlite') {
		serverEnv.DATABASE_TYPE = 'sqlite';
		serverEnv.DATABASE_PATH = serverEnv.DATABASE_PATH ?? join(dataDir, 'data', 'okr.db');
		delete serverEnv.DATABASE_URL;
	} else {
		if (!serverEnv.DATABASE_URL) {
			const adminUrl = process.env.RUOK_TEST_PG_ADMIN_URL;
			if (!adminUrl) {
				throw new Error(
					'startServer(backend=postgres) requires RUOK_TEST_PG_ADMIN_URL ' +
						'(postgres://... with CREATEDB) to create a disposable database'
				);
			}
			const { Client } = await import('pg');
			const dbName = `ruok_http_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
			const admin = new Client({ connectionString: adminUrl });
			await admin.connect();
			try {
				await admin.query(`CREATE DATABASE "${dbName}"`);
			} finally {
				await admin.end();
			}
			const appUrl = new URL(adminUrl);
			appUrl.pathname = `/${dbName}`;
			serverEnv.DATABASE_URL = appUrl.toString();
		}
		serverEnv.DATABASE_TYPE = 'postgres';
		// Disposable DB names are not secrets; keep TLS explicit and safe.
		serverEnv.DATABASE_SSL_MODE = serverEnv.DATABASE_SSL_MODE ?? 'disable';
		delete serverEnv.DATABASE_PATH;
	}

	const child: ChildProcess = spawn(process.execPath, ['build'], {
		cwd: OKR_APP_DIR,
		env: serverEnv,
		stdio: ['ignore', 'pipe', 'pipe']
	});

	let stdout = '';
	let stderr = '';
	child.stdout?.on('data', (d) => (stdout += String(d)));
	child.stderr?.on('data', (d) => (stderr += String(d)));

	const jar = new CookieJar();

	const server: RunningServer = {
		baseUrl,
		port,
		pid: child.pid ?? -1,
		dataDir,
		backend,
		async request(path, init = {}, cookieJar = jar) {
			const headers = new Headers(init.headers);
			if (!headers.has('content-type') && init.body) {
				headers.set('content-type', 'application/json');
			}
			const cookieHeader = cookieJar.header();
			if (cookieHeader) headers.set('cookie', cookieHeader);
			const res = await fetch(`${baseUrl}${path}`, { ...init, headers });
			cookieJar.setFromHeaders(res.headers);
			return res;
		},
		async register(username, password, cookieJar = new CookieJar()) {
			return server.request(
				'/api/auth/register',
				{ method: 'POST', body: JSON.stringify({ username, password }) },
				cookieJar
			);
		},
		async login(username, password, cookieJar = new CookieJar()) {
			return server.request(
				'/api/auth/login',
				{ method: 'POST', body: JSON.stringify({ username, password }) },
				cookieJar
			);
		},
		async waitReady(deadlineMs = READY_DEADLINE_MS) {
			const deadline = Date.now() + deadlineMs;
			while (Date.now() < deadline) {
				if (child.exitCode !== null) {
					// The child exited before becoming ready — surface a bounded error.
					throw new Error(
						`${safeProcessLabel(backend)} exited (code ${child.exitCode}) before ready. ` +
							`stderr:\n${stderr.slice(-2000)}`
					);
				}
				try {
					const res = await fetch(`${baseUrl}/api/ready`);
					if (res.status === 200) return true;
				} catch {
					// not listening yet
				}
				await sleep(250);
			}
			return false;
		},
		async stop() {
			if (child.exitCode !== null) return;
			const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
			child.kill('SIGTERM');
			const timedOut = await Promise.race([
				exited.then(() => false),
				sleep(3000).then(() => true)
			]);
			if (timedOut) {
				child.kill('SIGKILL');
				await exited.catch(() => undefined);
			}
			rmSync(dataDir, { recursive: true, force: true });
		}
	};

	try {
		const requireReady = opts.requireReady ?? true;
		if (requireReady) {
			const ok = await server.waitReady(opts.readyDeadlineMs ?? READY_DEADLINE_MS);
			if (!ok) {
				throw new Error(
					`${safeProcessLabel(backend)} did not become ready within deadline. ` +
						`stdout:\n${stdout.slice(-2000)}\nstderr:\n${stderr.slice(-2000)}`
				);
			}
		} else {
			// Wait only for the process to be listening (health responds), so an
			// unavailable-storage startup can be observed (health 200, ready 503).
			await waitForListening(child, baseUrl, backend, stderr);
		}
		return server;
	} catch (err) {
		// Teardown on failure: ensure the process and disposable storage are gone.
		await server.stop().catch(() => undefined);
		throw err;
	}
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait until the child process responds to `/api/health` (i.e. is listening). */
async function waitForListening(
	child: ChildProcess,
	baseUrl: string,
	backend: 'sqlite' | 'postgres',
	stderr: string
): Promise<void> {
	const deadline = Date.now() + READY_DEADLINE_MS;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			throw new Error(
				`${safeProcessLabel(backend)} exited (code ${child.exitCode}) before listening. ` +
					`stderr:\n${stderr.slice(-2000)}`
			);
		}
		try {
			const res = await fetch(`${baseUrl}/api/health`);
			if (res.status === 200) return;
		} catch {
			// not listening yet
		}
		await sleep(250);
	}
	throw new Error(`${safeProcessLabel(backend)} did not begin listening within deadline.`);
}