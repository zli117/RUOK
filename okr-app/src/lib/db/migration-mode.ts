/**
 * Shared migration-mode contract (FR-003 / DRIFT-3 / T010).
 *
 * One side-effect-free parser for the `MIGRATION_MODE` value used by BOTH the
 * standalone CLI (`scripts/db-migrate.ts`) and the application lifecycle
 * (consumed in WP04). Absent mode retains the historical default of `migrate`;
 * any invalid value fails with a redacted, actionable error. Importing this
 * module performs no I/O and has no side effects.
 *
 * WP04 consumes {@link parseMigrationMode} to resolve the runtime startup mode
 * so the CLI and the application can never drift on what `verify` means.
 */

/** Supported migration modes. */
export type MigrationMode = 'migrate' | 'verify'

/**
 * Parse a raw `MIGRATION_MODE` value into a canonical {@link MigrationMode}.
 *
 * - absent / empty (incl. whitespace) -> `migrate` (preserves the original startup behavior)
 * - `migrate`      -> `migrate`
 * - `verify`       -> `verify` (read-only, no-DDL schema verification)
 * - anything else  -> throws a redacted, actionable error
 *
 * Values are trimmed and lower-cased so `Verify`, ` VERIFY ` etc. are accepted
 * deterministically (matching the previous CLI behavior).
 */
export function parseMigrationMode(raw: string | undefined): MigrationMode {
	const mode = (raw ?? '').trim().toLowerCase();
	if (mode === '' || mode === 'migrate') return 'migrate';
	if (mode === 'verify') return 'verify';
	throw new Error(
		`Invalid MIGRATION_MODE '${raw}'. Expected 'migrate' or 'verify' (absent means migrate).`
	);
}