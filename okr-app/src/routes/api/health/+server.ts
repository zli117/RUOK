/**
 * Liveness probe (FR-012 / T012).
 *
 * Returns the process liveness status. Independent of authentication and of
 * database readiness: it simply confirms the server process is alive. Never
 * returns credentials, connection strings or other secrets.
 */
import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'

export const GET: RequestHandler = async () => {
	return json({ status: 'ok', uptime: process.uptime() })
}