import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDatabase } from '$lib/server/database';
import { executeQuery } from '$lib/server/query/executor';

// POST /api/objectives/kr-progress - Execute progress queries for multiple KRs
export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	try {
		const { krIds } = await request.json();

		if (!Array.isArray(krIds) || krIds.length === 0) {
			return json({ error: 'krIds must be a non-empty array' }, { status: 400 });
		}

		const db = await getDatabase();
		const results: Record<string, { score: number | null; scoreLabel?: string; error?: string }> = {};

		// Process all KRs in parallel
		await Promise.all(
			krIds.map(async (krId: string) => {
				// Get the KR
				const kr = await db.keyResults.findById(krId);

				if (!kr) {
					results[krId] = { score: null, error: 'Key result not found' };
					return;
				}

				// Verify the KR belongs to user's objective
				const objective = await db.objectives.findById(kr.objectiveId);

				if (!objective || objective.userId !== locals.user!.id) {
					results[krId] = { score: null, error: 'Unauthorized' };
					return;
				}

				// Only process custom_query measurement type
				if (kr.measurementType !== 'custom_query') {
					results[krId] = { score: kr.score };
					return;
				}

				// Get the code to execute
				const code = kr.progressQueryCode;
				if (!code) {
					results[krId] = { score: kr.score, error: 'No query code defined' };
					return;
				}

				// Execute the query
				const queryResult = await executeQuery(code, locals.user!.id);

				if (queryResult.error) {
					results[krId] = { score: null, error: queryResult.error };
					return;
				}

				// Check if progress.set() was called
				if (queryResult.progressValue === undefined) {
					results[krId] = { score: null, error: 'Query must call progress.set(numerator, denominator)' };
					return;
				}

				// progressValue is already clamped to 0-1 by the executor
				const clampedScore = queryResult.progressValue;
				const scoreLabel = queryResult.progressLabel || null;

				// Update the KR score in database
				await db.keyResults.update(krId, {
					score: clampedScore,
					scoreLabel,
					updatedAt: new Date()
				});

				results[krId] = { score: clampedScore, scoreLabel: scoreLabel || undefined };
			})
		);

		return json({ results });
	} catch (error) {
		console.error('Error executing KR progress queries:', error);
		return json({ error: 'Failed to execute queries' }, { status: 500 });
	}
};