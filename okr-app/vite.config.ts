/// <reference types="vitest" />
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';
import { buildAllWorkers } from './scripts/build-database-workers';

export default defineConfig({
	plugins: [
		sveltekit(),
		{
			// WP10 / T047: emit SQLite worker entry assets into build/workers/ via
			// the existing Vite build. `apply: 'build'` keeps dev server and Vitest
			// from triggering emission (tests bundle workers on demand instead).
			name: 'sqlite-workers',
			apply: 'build',
			async closeBundle() {
				await buildAllWorkers('build/workers');
			}
		}
	],
	server: {
		port: 5180
	},
	test: {
		include: ['tests/**/*.test.ts'],
		environment: 'node',
		passWithNoTests: false
	}
});