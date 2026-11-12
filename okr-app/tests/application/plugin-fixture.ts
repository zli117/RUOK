/**
 * WP07 — deterministic data-import plugin fixture (T030).
 *
 * A real `DataImportPlugin` (same interface the built-in fitbit/oura plugins
 * implement) that returns fixed, predictable records for any requested date
 * range. It never calls an external provider; it lets the scheduler →
 * manager → repository chain be driven through the real internal seam with
 * exact, reproducible values on both SQLite and PostgreSQL.
 *
 * The plugin is registered into the in-process plugin registry by the suite
 * before invoking the scheduler callback; it is never added to the built HTTP
 * server (so no test-only surface leaks into production).
 */
import type { DataImportPlugin, OAuthCredentials } from '../../src/lib/server/plugins/types';

/** Deterministic values produced for every imported day. */
export const FIXTURE_RECORD = {
	steps: 12345,
	sleepLength: '7h30m',
	restingHeartRate: 58,
	wakeUpTime: '06:15'
};

export const FIXTURE_PLUGIN_ID = 'testimport';
export const FIXTURE_PLUGIN_NAME = 'Deterministic Test Import';

export const testImportPlugin: DataImportPlugin = {
	id: FIXTURE_PLUGIN_ID,
	name: FIXTURE_PLUGIN_NAME,
	description: 'WP07 deterministic provider used only by the integration suite',
	icon: 'test',

	getAdminConfigFields() {
		return [];
	},

	getSetupInfo() {
		return [{ label: 'Fixture', value: 'static' }];
	},

	async isConfigured() {
		return true;
	},

	async getOAuthConfig() {
		return {
			clientId: 'fixture',
			authorizationUrl: 'https://example.test/oauth/authorize',
			tokenUrl: 'https://example.test/oauth/token',
			scopes: ['read'],
			redirectUri: 'https://example.test/callback',
			usePKCE: false
		};
	},

	getAvailableFields() {
		return [
			{ id: 'steps', name: 'Steps', description: 'Step count', type: 'number', unit: 'count' },
			{ id: 'sleepLength', name: 'Sleep length', description: 'Total sleep', type: 'text' },
			{
				id: 'restingHeartRate',
				name: 'Resting heart rate',
				description: 'RHR in bpm',
				type: 'number',
				unit: 'bpm'
			},
			{ id: 'wakeUpTime', name: 'Wake-up time', description: 'Wake time', type: 'time' }
		];
	},

	async validateCredentials(_credentials: OAuthCredentials) {
		// Fixture credentials are always valid; deterministic by design.
		return true;
	},

	async refreshTokens(credentials: OAuthCredentials) {
		// No real expiry handling for the fixture; return the same credentials.
		return credentials;
	},

	async fetchData(
		_credentials: OAuthCredentials,
		_startDate: string,
		endDate: string,
		_fields: string[]
	) {
		// Return one deterministic record for the last day of the requested range.
		return [{ date: endDate, fields: { ...FIXTURE_RECORD } }];
	}
};