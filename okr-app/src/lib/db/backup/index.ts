/**
 * Canonical backup/restore orchestration (FR-008 / WP06).
 *
 * Dialect-independent snapshot → document conversion and document → command
 * plan validation/remapping. The concrete adapters implement the reads
 * (`exportSnapshot`) and the atomic execution (`restore`) of the produced
 * plan; all ownership, validation and reference remapping stays here.
 */
export * from './types';
export * from './export';
export * from './validate';