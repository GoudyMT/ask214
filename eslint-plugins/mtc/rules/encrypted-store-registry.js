/**
 * Forbids direct raw-IndexedDB writes to encrypted stores -
 * `<tx>.objectStore('<encrypted>').{put|add}(...)` - outside the sanctioned
 * store path. Direct writes bypass the single encryption boundary (Phase 2 spec
 * section 4, invariant 7): only the sanctioned store paths (ProfileStore.save /
 * TimelineStateStore) may write ciphertext, each carrying an inline eslint-disable
 * at its one call site. Test files that stage fixtures are exempted in
 * eslint.config.js.
 *
 * Heuristic: a CallExpression `X.objectStore('<name>').{put|add}(...)` with
 * <name> in the ENCRYPTED_STORES registry flags as a violation.
 */
const ENCRYPTED_STORES_LITERAL = new Set(['profile', 'timeline-state']);
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
