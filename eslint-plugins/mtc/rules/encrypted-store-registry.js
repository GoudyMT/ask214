/**
 * Forbids direct raw-IndexedDB writes to encrypted stores -
 * `<tx>.objectStore('<encrypted>').{put|add}(...)` - outside the sanctioned
 * store path. Direct writes bypass the single encryption boundary: only the
 * sanctioned store paths (the profile, timeline-state, and calendar-sync stores)
 * may write ciphertext, each carrying an inline eslint-disable at its one call
 * site. Test files that stage fixtures are exempted in eslint.config.js.
 *
 * Heuristic: a CallExpression `X.objectStore('<name>').{put|add}(...)` with
 * <name> in the set below flags as a violation.
 *
 * The set duplicates `src/lib/db/registry.ts` because an ESLint plugin is plain JS
 * and cannot import the TypeScript registry - and the registry cannot move to JS
 * without collapsing its EncryptedStoreName literal union to `string`. A store
 * added there but not here would silently lose its guard, so the duplication is
 * pinned by a parity test in this rule's own test file; that test is what keeps
 * this list honest. Exported for it.
 */
export const ENCRYPTED_STORES_LITERAL = new Set([
	'profile',
	'timeline-state',
	'calendar-sync',
	'byok'
]);
const FORBIDDEN_WRITE_METHODS = new Set(['put', 'add']);

export default {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Forbid direct writes to encrypted IDB stores outside the sanctioned ProfileStore path'
		},
		messages: {
			writeUnsanctioned:
				'Direct write to an encrypted IDB store bypasses the encryption boundary; route through the sanctioned store path (withWriteLocks + encryptRecord)'
		},
		schema: []
	},
	create(context) {
		return {
			CallExpression(node) {
				// Match chain: <obj>.objectStore('<name>').{put|add}(...)
				if (
					node.callee.type !== 'MemberExpression' ||
					node.callee.property.type !== 'Identifier' ||
					!FORBIDDEN_WRITE_METHODS.has(node.callee.property.name)
				) {
					return;
				}
				const inner = node.callee.object;
				if (
					inner.type !== 'CallExpression' ||
					inner.callee.type !== 'MemberExpression' ||
					inner.callee.property.type !== 'Identifier' ||
					inner.callee.property.name !== 'objectStore'
				) {
					return;
				}
				const storeArg = inner.arguments[0];
				if (!storeArg || storeArg.type !== 'Literal') return;
				if (typeof storeArg.value !== 'string') return;
				if (!ENCRYPTED_STORES_LITERAL.has(storeArg.value)) return;

				context.report({ node, messageId: 'writeUnsanctioned' });
			}
		};
	}
};
