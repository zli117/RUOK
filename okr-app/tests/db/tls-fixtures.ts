/**
 * TLS fixtures for WP01 (FR-001 / DRIFT-1).
 *
 * Two kinds of helper:
 *   1. {@link generateTestTls} — create a disposable self-signed CA and a
 *      server certificate/key signed by it, using the `openssl` CLI. Private
 *      keys and CA material live only in a temporary directory created here
 *      and are removed by the caller; nothing is committed.
 *   2. {@link startTlsPostgres} — start a real, TLS-enabled PostgreSQL 18
 *      container (Docker) configured with a given server certificate so the
 *      effective pg Client/Pool builders can be exercised against a real
 *      trusted / untrusted-CA / hostname-mismatch endpoint.
 *
 * These helpers REQUIRE `openssl` and a running Docker daemon. If a required
 * tool or image is missing they throw a descriptive "missing prerequisite"
 * error so the calling test fails as a missing prerequisite rather than
 * silently passing (NFR-001 / C-007). Live runs are opt-in via
 * `RUOK_TEST_LIVE_TLS=1` (see tls.test.ts).
 */
import { execFileSync } from 'child_process';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { createConnection } from 'net';
import { randomUUID } from 'crypto';

export interface TlsMaterial {
	/** Disposable working directory (caller removes it). */
	dir: string;
	/** Path to the PEM CA certificate. */
	caCertPath: string;
	/** PEM body of the CA certificate (no private key). */
	caCertBody: string;
	/** Path to the signed server certificate. */
	serverCertPath: string;
	/** Path to the server private key (chmod 600). */
	serverKeyPath: string;
}

function run(
	tool: string,
	args: string[],
	hint: string
): { stdout: string; stderr: string } {
	try {
		const res = execFileSync(tool, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		return { stdout: res.toString(), stderr: '' };
	} catch (err) {
		const e = err as { stderr?: Buffer; message?: string };
		const detail = e.stderr ? e.stderr.toString() : e.message ?? '';
		throw new Error(`Missing prerequisite for live TLS: ${hint} (${tool}). ${detail}`);
	}
}

export function opensslAvailable(): boolean {
	try {
		run('openssl', ['version'], 'openssl must be on PATH');
		return true;
	} catch {
		return false;
	}
}

export function dockerAvailable(): boolean {
	try {
		execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
}

/**
 * Generate a disposable CA and a server certificate signed by it.
 *
 * `sanEntries` controls the Subject Alternative Names on the server cert, e.g.
 * `['DNS:localhost', 'IP:127.0.0.1']`. Omit `IP:127.0.0.1` to force a
 * hostname-mismatch when connecting to 127.0.0.1.
 */
export function generateTestTls(sanEntries: string[] = ['DNS:localhost', 'IP:127.0.0.1']): TlsMaterial {
	if (!opensslAvailable()) {
		throw new Error('Missing prerequisite for live TLS: openssl is not available on PATH.');
	}
	const dir = mkdtempSync(join(tmpdir(), `ruok-tls-${randomUUID()}-`));
	const caKey = join(dir, 'ca.key');
	const caCert = join(dir, 'ca.crt');
	const serverKey = join(dir, 'server.key');
	const serverCsr = join(dir, 'server.csr');
	const serverCert = join(dir, 'server.crt');
	const extFile = join(dir, 'san.ext');

	try {
		run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', caKey, '-out', caCert, '-days', '1', '-subj', '/CN=RUOK Test CA'], 'openssl CA generation');
		run('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', serverKey, '-out', serverCsr, '-subj', '/CN=localhost'], 'openssl server key/CSR generation');
		writeFileSync(extFile, `subjectAltName=${sanEntries.join(',')}\n`);
		run('openssl', ['x509', '-req', '-in', serverCsr, '-CA', caCert, '-CAkey', caKey, '-CAcreateserial', '-out', serverCert, '-days', '1', '-extfile', extFile], 'openssl server cert signing');
		// Postgres refuses to start if the server key is group/world readable.
		chmodSync(serverKey, 0o600);
		return {
			dir,
			caCertPath: caCert,
			caCertBody: readFileSync(caCert, 'utf8'),
			serverCertPath: serverCert,
			serverKeyPath: serverKey
		};
	} catch (err) {
		rmSync(dir, { recursive: true, force: true });
		throw err;
	}
}

export function disposeTls(material: TlsMaterial | undefined): void {
	if (!material) return;
	rmSync(material.dir, { recursive: true, force: true });
}

export interface TlsPostgres {
	/** Connection URL to the TLS-enabled PostgreSQL (user=postgres, db=postgres). */
	url: string;
	host: string;
	port: number;
	/** PEM CA certificate that signed this server's certificate. */
	caCertBody: string;
	/** Stop and remove the container. */
	stop(): Promise<void>;
}

function waitForPort(host: string, port: number, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolve, reject) => {
		const attempt = () => {
			const socket = createConnection({ host, port });
			const done = (err?: Error) => {
				socket.removeAllListeners();
				socket.destroy();
				if (err) {
					if (Date.now() >= deadline) return reject(err);
					setTimeout(attempt, 300);
				} else {
					resolve();
				}
			};
			socket.once('connect', () => done());
			socket.once('error', (e) => done(e));
		};
		attempt();
	});
}

/**
 * Start a TLS-enabled PostgreSQL 18 container using `material`'s server
 * certificate. Returns a {@link TlsPostgres} once the port accepts TCP
 * connections. The caller must call `stop()` to remove the container.
 *
 * The image reference is pinned to a registry-qualified image already present
 * locally (`docker-proxy.artifactory.tcsbank.ru/postgres:18`) so the
 * stopped-on-download-failure rule (C-007) reports a stable identity and live
 * runs need no pull. It is overridable via `RUOK_TEST_PG_IMAGE`. A failed
 * start throws here and the calling test fails as a missing prerequisite /
 * blocked check.
 */
export function resolveTlsPgImage(): string {
	return process.env.RUOK_TEST_PG_IMAGE ?? 'docker-proxy.artifactory.tcsbank.ru/postgres:18';
}

export async function startTlsPostgres(material: TlsMaterial): Promise<TlsPostgres> {
	if (!dockerAvailable()) {
		throw new Error('Missing prerequisite for live TLS: Docker daemon is not reachable.');
	}
	const name = `ruok-tls-${randomUUID()}`;
	const image = resolveTlsPgImage();

	// Stage the server cert/key into a directory the Docker VM actually shares.
	// On macOS under colima only the home directory is mounted into the VM, so
	// bind-mounts sourced from os.tmpdir() (/var/folders) or /tmp surface files
	// as empty directories and Postgres fails with "no start line". A home-based
	// staging dir is created here and removed by stop() / every error path.
	const stagingDir = mkdtempSync(join(homedir(), '.ruok-tls-'));
	const stagedCert = join(stagingDir, 'server.crt');
	const stagedKey = join(stagingDir, 'server.key');
	try {
		copyFileSync(material.serverCertPath, stagedCert);
		copyFileSync(material.serverKeyPath, stagedKey);
		chmodSync(stagedKey, 0o600);
	} catch (err) {
		rmSync(stagingDir, { recursive: true, force: true });
		throw err;
	}

	// Start the container with the server cert/key and ssl=on.
	const args = [
		'run', '-d', '--name', name,
		'-p', '127.0.0.1::5432',
		'-e', 'POSTGRES_PASSWORD=postgres',
		'-e', 'POSTGRES_USER=postgres',
		'-e', 'POSTGRES_DB=postgres',
		'-v', `${stagingDir}:/var/lib/postgresql/certs`,
		image,
		'-c', 'ssl=on',
		'-c', 'ssl_cert_file=/var/lib/postgresql/certs/server.crt',
		'-c', 'ssl_key_file=/var/lib/postgresql/certs/server.key'
	];
	try {
		execFileSync('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
	} catch (err) {
		rmSync(stagingDir, { recursive: true, force: true });
		const e = err as { stderr?: Buffer; message?: string };
		const detail = e.stderr ? e.stderr.toString() : e.message ?? '';
		throw new Error(
			`Blocked: could not start TLS PostgreSQL image '${image}'. ` +
				`Command: docker ${args.slice(0, 4).join(' ')} ... (redacted). ${detail}`
		);
	}

	// Postgres needs the key readable by the postgres user; fix perms in-container.
	try {
		execFileSync('docker', ['exec', name, 'sh', '-c', 'chmod 600 /var/lib/postgresql/certs/server.key && chown postgres:postgres /var/lib/postgresql/certs/server.key /var/lib/postgresql/certs/server.crt'], { stdio: ['ignore', 'pipe', 'pipe'] });
	} catch {
		// If chown is not permitted the container will fail to start; the port
		// wait below will time out and surface it.
	}

	const host = '127.0.0.1';
	let port = 0;
	try {
		const out = execFileSync('docker', ['port', name, '5432/tcp'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
		const match = /:(\d+)/.exec(out.trim());
		port = match ? Number(match[1]) : 0;
		if (!port) throw new Error(`Could not parse docker port mapping from '${out.trim()}'`);
	} catch (err) {
		await stopContainer(name);
		rmSync(stagingDir, { recursive: true, force: true });
		throw err instanceof Error ? err : new Error(String(err));
	}

	try {
		// PostgreSQL 18 listens on the port but may still be starting up; wait a
		// bounded time for a TCP connection so tests do not race initialization.
		await waitForPort(host, port, 30_000);
	} catch (err) {
		await stopContainer(name);
		rmSync(stagingDir, { recursive: true, force: true });
		throw new Error(`TLS PostgreSQL did not accept connections within 30s: ${(err as Error).message}`);
	}

	const url = `postgresql://postgres:postgres@${host}:${port}/postgres`;
	const stop = async (): Promise<void> => {
		await stopContainer(name);
		rmSync(stagingDir, { recursive: true, force: true });
	};
	return { url, host, port, caCertBody: material.caCertBody, stop };
}

async function stopContainer(name: string): Promise<void> {
	try {
		execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
	} catch {
		// Already gone.
	}
}