import { getDatabase } from '$lib/server/database';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import type { Cookies } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

const SALT_ROUNDS = 12;
const SESSION_COOKIE_NAME = 'session_id';
const SESSION_DURATION_DAYS = 30;

export interface AuthUser {
	id: string;
	username: string;
	weekStartDay: 'sunday' | 'monday';
	timezone: string;
	bgColor: string | null;
	isAdmin: boolean;
}

/**
 * Hash a password using bcrypt
 */
export async function hashPassword(password: string): Promise<string> {
	return bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * Verify a password against a hash
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
	return bcrypt.compare(password, hash);
}

/**
 * Create a new user
 */
export async function createUser(username: string, password: string): Promise<AuthUser> {
	const db = await getDatabase();
	const existingUser = await db.users.findByUsername(username);

	if (existingUser) {
		throw new Error('Username already exists');
	}

	const id = uuidv4();
	const passwordHash = await hashPassword(password);

	await db.users.create({
		id,
		username,
		passwordHash
	});

	return { id, username, weekStartDay: 'monday', timezone: 'UTC', bgColor: null, isAdmin: false };
}

/**
 * Authenticate a user with username and password
 */
export async function authenticateUser(
	username: string,
	password: string
): Promise<AuthUser | null> {
	const db = await getDatabase();
	const user = await db.users.findByUsername(username);

	if (!user) {
		return null;
	}

	// Check if user is disabled
	if (user.isDisabled) {
		return null;
	}

	const valid = await verifyPassword(password, user.passwordHash);
	if (!valid) {
		return null;
	}

	// Check if this user should be granted admin via env var
	let isAdmin = user.isAdmin || false;
	const adminUsername = env.ADMIN_USERNAME;
	if (adminUsername && user.username === adminUsername && !user.isAdmin) {
		await db.users.update(user.id, { isAdmin: true });
		isAdmin = true;
	}

	return {
		id: user.id,
		username: user.username,
		weekStartDay: user.weekStartDay || 'monday',
		timezone: user.timezone || 'UTC',
		bgColor: user.bgColor || null,
		isAdmin
	};
}

/**
 * Create a new session for a user
 */
export async function createSession(userId: string): Promise<string> {
	const db = await getDatabase();
	const sessionId = uuidv4();
	const expiresAt = new Date(Date.now() + SESSION_DURATION_DAYS * 24 * 60 * 60 * 1000);

	await db.sessions.create({
		id: sessionId,
		userId,
		expiresAt
	});

	return sessionId;
}

/**
 * Get user from session ID
 */
export async function getUserFromSession(sessionId: string): Promise<AuthUser | null> {
	const db = await getDatabase();
	const session = await db.sessions.findById(sessionId);

	if (!session) {
		return null;
	}

	// Check if session is expired
	if (session.expiresAt < new Date()) {
		await db.sessions.delete(sessionId);
		return null;
	}

	const user = await db.users.findById(session.userId);

	if (!user) {
		return null;
	}

	// Check if user is disabled
	if (user.isDisabled) {
		await db.sessions.delete(sessionId);
		return null;
	}

	return {
		id: user.id,
		username: user.username,
		weekStartDay: user.weekStartDay || 'monday',
		timezone: user.timezone || 'UTC',
		bgColor: user.bgColor || null,
		isAdmin: user.isAdmin || false
	};
}

/**
 * Delete a session
 */
export async function deleteSession(sessionId: string): Promise<void> {
	const db = await getDatabase();
	await db.sessions.delete(sessionId);
}

/**
 * Set session cookie
 */
export function setSessionCookie(cookies: Cookies, sessionId: string): void {
	cookies.set(SESSION_COOKIE_NAME, sessionId, {
		path: '/',
		httpOnly: true,
		secure: process.env.NODE_ENV === 'production',
		sameSite: 'lax',
		maxAge: SESSION_DURATION_DAYS * 24 * 60 * 60
	});
}

/**
 * Get session ID from cookies
 */
export function getSessionIdFromCookies(cookies: Cookies): string | undefined {
	return cookies.get(SESSION_COOKIE_NAME);
}

/**
 * Clear session cookie
 */
export function clearSessionCookie(cookies: Cookies): void {
	cookies.delete(SESSION_COOKIE_NAME, { path: '/' });
}

/**
 * Clean up expired sessions (call periodically)
 */
export async function cleanupExpiredSessions(): Promise<number> {
	const db = await getDatabase();
	return db.sessions.deleteExpired(new Date());
}