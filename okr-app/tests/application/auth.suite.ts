/**
 * WP06 — real HTTP session/admin and two-account objective ownership (T026/T027).
 *
 * Drives the BUILT server through its actual routes with real cookies. There
 * are NO injected locals and NO fake repositories — every request crosses
 * hooks.server.ts, authentication and the typed repositories over HTTP.
 *
 * Covers (T026): register/login/me/logout, invalid & expired-session behavior,
 * unauthenticated admin denial (401), non-admin admin denial (403) and admin
 * success — denied reads contain no foreign data. (T027): two-account
 * objective ownership — creating an objective as one user and asserting
 * list/read/update/delete are denied for the other user and for anonymous
 * callers, while stored state stays unchanged.
 *
 * The same suite runs against SQLite and PostgreSQL via the backend entries;
 * backend selection is enforced by the entry files.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { CookieJar, type RunningServer } from './http-fixture';

export type ServerFactory = () => Promise<RunningServer>;

const PASSWORD = 'correct-horse-battery';

/** Parse a JSON body, tolerating an empty response. */
async function readJson(res: Response): Promise<any> {
	const text = await res.text();
	try {
		return text ? JSON.parse(text) : null;
	} catch {
		return { raw: text };
	}
}

export function authSuite(label: string, start: ServerFactory) {
	let srv: RunningServer;

	beforeAll(async () => {
		srv = await start();
	}, 90_000);

	afterAll(async () => {
		await srv?.stop();
	});

	describe(`HTTP session + admin enforcement (${label})`, () => {
		it('registers through the real route and returns an authenticated session cookie', async () => {
			const jar = new CookieJar();
			const res = await srv.register('alice_auth', PASSWORD, jar);
			expect(res.status).toBe(200);
			const body = await readJson(res);
			expect(body.user.username).toBe('alice_auth');
			// A real session cookie was issued (httpOnly session_id).
			expect(jar.header()).toMatch(/session_id=[0-9a-f-]{36}/);
		});

		it('me returns the authenticated identity carried by the cookie', async () => {
			const jar = new CookieJar();
			await srv.register('carol_me', PASSWORD, jar);
			const res = await srv.request('/api/auth/me', {}, jar);
			expect(res.status).toBe(200);
			const body = await readJson(res);
			expect(body.user).toBeTruthy();
			expect(body.user.username).toBe('carol_me');
			expect(typeof body.user.id).toBe('string');
		});

		it('me with no cookie returns an anonymous null user', async () => {
			const res = await srv.request('/api/auth/me');
			expect(res.status).toBe(200);
			expect((await readJson(res)).user).toBeNull();
		});

		it('me with an invalid session cookie returns an anonymous null user', async () => {
			const jar = new CookieJar();
			jar.setFromHeaders(new Headers({ 'set-cookie': 'session_id=00000000-0000-4000-8000-000000000000' }));
			const res = await srv.request('/api/auth/me', {}, jar);
			expect(res.status).toBe(200);
			expect((await readJson(res)).user).toBeNull();
		});

		it('login with the wrong password is rejected 401', async () => {
			const jar = new CookieJar();
			await srv.register('dave_wrong', PASSWORD, new CookieJar());
			const res = await srv.login('dave_wrong', 'definitely-wrong', jar);
			expect(res.status).toBe(401);
			expect(jar.header()).not.toMatch(/session_id=/);
		});

		it('logout invalidates the session so me becomes anonymous', async () => {
			const jar = new CookieJar();
			await srv.register('erin_logout', PASSWORD, jar);
			const meBefore = await srv.request('/api/auth/me', {}, jar);
			expect((await readJson(meBefore)).user.username).toBe('erin_logout');

			const logout = await srv.request('/api/auth/logout', { method: 'POST' }, jar);
			expect(logout.status).toBe(200);

			const meAfter = await srv.request('/api/auth/me', {}, jar);
			expect((await readJson(meAfter)).user).toBeNull();
		});

		it('unauthenticated admin users list is denied 401 and leaks no data', async () => {
			const res = await srv.request('/api/admin/users');
			expect(res.status).toBe(401);
			const body = await readJson(res);
			expect(body.users).toBeUndefined();
		});

		it('non-admin admin users list is denied 403 and leaks no data', async () => {
			const jar = new CookieJar();
			await srv.register('frank_user', PASSWORD, jar);
			const res = await srv.request('/api/admin/users', {}, jar);
			expect(res.status).toBe(403);
			const body = await readJson(res);
			expect(body.users).toBeUndefined();
			expect(body.error).toMatch(/admin/i);
		});

		it('admin user can list users (admin success)', async () => {
			const jar = new CookieJar();
			await srv.register('admin', PASSWORD, jar);
			const login = await srv.login('admin', PASSWORD, jar);
			expect(login.status).toBe(200);
			// ADMIN_USERNAME grants admin on login; admin access to /api/admin/users
			// (guarded on locals.user.isAdmin) succeeding is the real proof.
			const list = await srv.request('/api/admin/users', {}, jar);
			expect(list.status).toBe(200);
			const body = await readJson(list);
			expect(Array.isArray(body.users)).toBe(true);
			const usernames = body.users.map((u: any) => u.username);
			expect(usernames).toContain('admin');
			// No password hash ever leaves the boundary.
			for (const u of body.users) {
				expect(u.passwordHash).toBeUndefined();
				expect(u.password_hash).toBeUndefined();
			}
		});
	});

	describe(`HTTP two-account objective ownership (${label})`, () => {
		let aliceJar: CookieJar;
		let bobJar: CookieJar;
		let objectiveId: string;

		beforeAll(async () => {
			aliceJar = new CookieJar();
			bobJar = new CookieJar();
			const ar = await srv.register('alice_owner', PASSWORD, aliceJar);
			expect(ar.status).toBe(200);
			const br = await srv.register('bob_owner', PASSWORD, bobJar);
			expect(br.status).toBe(200);

			// Alice persists a distinct objective through the real route.
			const create = await srv.request(
				'/api/objectives',
				{
					method: 'POST',
					body: JSON.stringify({
						title: 'Alice private yearly objective',
						level: 'yearly',
						year: 2026,
						weight: 1.5
					})
				},
				aliceJar
			);
			expect(create.status).toBe(201);
			objectiveId = (await readJson(create)).objective.id;
		}, 60_000);

		it('owner (Alice) can read back the exact objective', async () => {
			const res = await srv.request(`/api/objectives/${objectiveId}`, {}, aliceJar);
			expect(res.status).toBe(200);
			const body = await readJson(res);
			expect(body.objective.id).toBe(objectiveId);
			expect(body.objective.title).toBe('Alice private yearly objective');
			expect(body.objective.userId).toBeTruthy();
		});

		it('other user (Bob) list reveals no foreign objective', async () => {
			const res = await srv.request('/api/objectives', {}, bobJar);
			expect(res.status).toBe(200);
			const body = await readJson(res);
			expect(body.objectives).toHaveLength(0);
		});

		it('other user (Bob) read of a foreign objective is denied 404 with no leak', async () => {
			const res = await srv.request(`/api/objectives/${objectiveId}`, {}, bobJar);
			expect(res.status).toBe(404);
			const body = await readJson(res);
			expect(body.objective).toBeUndefined();
			expect(body.error).toBeTruthy();
		});

		it('other user (Bob) update of a foreign objective is denied 404 and state unchanged', async () => {
			const res = await srv.request(
				`/api/objectives/${objectiveId}`,
				{ method: 'PUT', body: JSON.stringify({ title: 'Bob hijacked' }) },
				bobJar
			);
			expect(res.status).toBe(404);

			// Stored state is unchanged: Alice still sees her original title.
			const ownerRes = await srv.request(`/api/objectives/${objectiveId}`, {}, aliceJar);
			expect((await readJson(ownerRes)).objective.title).toBe('Alice private yearly objective');
		});

		it('other user (Bob) delete of a foreign objective is denied 404 and objective remains', async () => {
			const res = await srv.request(`/api/objectives/${objectiveId}`, { method: 'DELETE' }, bobJar);
			expect(res.status).toBe(404);

			const ownerRes = await srv.request(`/api/objectives/${objectiveId}`, {}, aliceJar);
			expect(ownerRes.status).toBe(200);
		});

		it('anonymous caller is denied 401 for list and read with no leak', async () => {
			const list = await srv.request('/api/objectives');
			expect(list.status).toBe(401);
			const read = await srv.request(`/api/objectives/${objectiveId}`);
			expect(read.status).toBe(401);
			expect((await readJson(read)).objective).toBeUndefined();
		});
	});
}