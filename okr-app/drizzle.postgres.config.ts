import { defineConfig } from 'drizzle-kit';

/**
 * Independent PostgreSQL dialect config (FR-004): separate schema source and
 * migration output directory so SQLite and PostgreSQL keep versioned, dialect
 * migration histories. Uses the application-owned schema/database from
 * DATABASE_URL; no superuser or database creation requirement.
 */
export default defineConfig({
	schema: './src/lib/db/schema/postgres.ts',
	out: './drizzle-postgres',
	dialect: 'postgresql',
	dbCredentials: {
		url: process.env.DATABASE_URL || ''
	}
});