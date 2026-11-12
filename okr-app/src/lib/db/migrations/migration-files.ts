/**
 * Canonical migration-folder reader (FR-004 / T009).
 *
 * Parses a Drizzle migration folder's journal + files into checked
 * {@link MigrationMeta} entries. The hash is sha256 of the file body —
 * identical to Drizzle's own migrator — so journal facts recorded here are
 * byte-compatible with records Drizzle would write. This is shared canonical
 * logic; it performs I/O only when explicitly invoked (never at import).
 */
import { createHash } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { MigrationFolder, MigrationMeta } from './contracts'

/**
 * Read and validate a migration folder (requires `meta/_journal.json` and every
 * referenced `*.sql` file). Throws if the folder is missing or inconsistent.
 */
export function readMigrationFolder(folder: string): MigrationFolder {
	const journalPath = join(folder, 'meta', '_journal.json')
	if (!existsSync(journalPath)) {
		throw new Error(`Can't find meta/_journal.json in migration folder '${folder}'`)
	}
	let journal: { entries: Array<{ idx: number; tag: string; when: number; breakpoints?: boolean }> }
	try {
		journal = JSON.parse(readFileSync(journalPath, 'utf8'))
	} catch (err) {
		throw new Error(`Failed to parse migration journal '${journalPath}': ${(err as Error).message}`)
	}

	const migrations: MigrationMeta[] = []
	for (const entry of journal.entries) {
		const filePath = join(folder, `${entry.tag}.sql`)
		if (!existsSync(filePath)) {
			throw new Error(`No migration file '${filePath}' referenced by the journal`)
		}
		const body = readFileSync(filePath, 'utf8')
		migrations.push({
			tag: entry.tag,
			when: entry.when,
			hash: createHash('sha256').update(body).digest('hex'),
			sql: body.split('--> statement-breakpoint'),
			breakpoints: entry.breakpoints ?? true
		})
	}
	return { folder, migrations }
}