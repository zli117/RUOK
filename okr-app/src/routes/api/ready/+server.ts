/**
 * Readiness probe (FR-012 / T012 / D-05).
 *
 * Reports whether the selected backend is open AND migrated/verified at the
 * expected schema version AND answers a bounded live availability query. It
 * triggers one asynchronous opening attempt without awaiting a long migration:
 * while the backend is still opening/failed/unavailable it returns 503 without
 * waiting for migration to finish; once open it awaits the selected service's
 * bounded live check (at most 3s). No cached-success shortcut.
 *
 * Independent of authentication; requires no login. Output is deliberately
 * redacted: dialect, open flag and schema version only — never credentials,
 * paths or connection strings.
 */
import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { getReadiness } from '$lib/db'

export const GET: RequestHandler = async () => {
	const readiness = await getReadiness()
	if (!readiness.ready) {
		return json(
			{
				ready: false,
				dialect: readiness.dialect ?? null,
				open: readiness.open,
				schemaVersion: readiness.schemaVersion ?? null
			},
			{ status: 503 }
		)
	}
	return json({
		ready: true,
		dialect: readiness.dialect,
		open: readiness.open,
		schemaVersion: readiness.schemaVersion
	})
}