/**
 * Forbids direct `db.table('<encrypted-store>').put|add(...)` outside the
 * sanctioned ProfileStore path. Direct writes bypass the single encryption
 * boundary documented in Phase 2 spec section 4.
 *
 * Heuristic: any CallExpression whose callee chain is
 *   db.table('<name>').{put|add}(...)
 * with <name> in the ENCRYPTED_STORES registry flags as a violation, unless the
 * call is statically inside the sanctioned ProfileStore path (disable there).
 *
 * Source: Phase 2 spec section 4 (invariant 7); ADR-009 amended (manifest
 * invariant).
 */
const ENCRYPTED_STORES_LITERAL = new Set(['profile']);
const FORBIDDEN_WRITE_METHODS = new Set(['put', 'add', 'bulkPut', 'bulkAdd']);

export default {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Forbid direct writes to encrypted IDB stores outside the sanctioned ProfileStore path'
		},
		messages: {
			writeUnsanctioned:
				'Direct write to encrypted store bypasses ProfileStore.encrypt; use withWriteLocks + ProfileStore.save() instead'
		},
		schema: []
	},
	create(context) {
		return {
			CallExpression(node) {
				// Look for chain: <obj>.table('<name>').{put|add|...}(...)
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
					inner.callee.property.name !== 'table'
				) {
					return;
				}
				const tableArg = inner.arguments[0];
				if (!tableArg || tableArg.type !== 'Literal') return;
				if (typeof tableArg.value !== 'string') return;
				if (!ENCRYPTED_STORES_LITERAL.has(tableArg.value)) return;

				context.report({ node, messageId: 'writeUnsanctioned' });
			}
		};
	}
};
