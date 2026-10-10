/**
 * Forbids direct raw-IndexedDB writes to encrypted stores -
 * `<tx>.objectStore('<encrypted>').{put|add}(...)` - outside the sanctioned
 * store path. Direct writes bypass the single encryption boundary: only the
 * sanctioned store paths (the profile, timeline-state, calendar-sync and BYO-key stores)
 * may write ciphertext, each carrying an inline eslint-disable at its one call
 * site. Test files that stage fixtures are exempted in eslint.config.js.
 *
 * Heuristic: a CallExpression `<store>.{put|add}(...)` flags as a violation when <store> is an
 * `X.objectStore(<name>)` call with <name> in the set below. The same write is caught in the
 * shapes that would otherwise slip past a literal chain match: the store held in a variable
 * (`const s = tx.objectStore('profile'); s.put(x)`), a computed member (`store['put'](x)`), and
 * the name held in a variable declared once from a string (`const S = 'profile'`). A store name
 * known only at run time (a parameter, a reassigned variable) cannot be judged and is allowed.
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
const MAX_ALIAS_HOPS = 4;

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
		const sourceCode = context.sourceCode;

		/** The expression under any TypeScript-only wrapper (`as`, `satisfies`, `!`, `<T>`). */
		function unwrap(node) {
			let current = node;
			while (
				current.type === 'TSAsExpression' ||
				current.type === 'TSSatisfiesExpression' ||
				current.type === 'TSNonNullExpression' ||
				current.type === 'TSTypeAssertion'
			) {
				current = current.expression;
			}
			return current;
		}

		/** The string a literal or an expression-free template holds, or null for anything else. */
		function plainString(node) {
			if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
			if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
				return node.quasis[0]?.value.cooked ?? null;
			}
			return null;
		}

		/** The name a member access reads: `.name` or a plain-string `['name']`; null when it is not knowable. */
		function memberName(member) {
			if (member.computed) return plainString(member.property);
			return member.property.type === 'Identifier' ? member.property.name : null;
		}

		/** The initializer of a variable that is declared once and never assigned again, so it still holds that value. */
		function initializerOf(identifier) {
			for (let scope = sourceCode.getScope(identifier); scope; scope = scope.upper) {
				const variable = scope.set.get(identifier.name);
				if (!variable) continue;
				const [definition] = variable.defs;
				const writes = variable.references.filter((reference) => reference.isWrite());
				if (
					variable.defs.length !== 1 ||
					writes.length !== 1 ||
					definition?.type !== 'Variable' ||
					definition.node.id.type !== 'Identifier'
				) {
					return null;
				}
				return definition.node.init;
			}
			return null;
		}

		/** The string an expression holds: a literal, or a variable declared once from one. */
		function resolveString(node) {
			const expression = unwrap(node);
			const direct = plainString(expression);
			if (direct !== null) return direct;
			if (expression.type !== 'Identifier') return null;
			const init = initializerOf(expression);
			return init ? plainString(unwrap(init)) : null;
		}

		/** Whether an expression is `<tx>.objectStore('<encrypted>')`, directly or through a variable declared once. */
		function isEncryptedStore(node, hops = 0) {
			const expression = unwrap(node);
			if (expression.type === 'Identifier') {
				// The hop limit stops a variable that names itself (`const a = a`) from looping.
				const init = hops < MAX_ALIAS_HOPS ? initializerOf(expression) : null;
				return init ? isEncryptedStore(init, hops + 1) : false;
			}
			if (
				expression.type !== 'CallExpression' ||
				expression.callee.type !== 'MemberExpression' ||
				memberName(expression.callee) !== 'objectStore'
			) {
				return false;
			}
			const storeArg = expression.arguments[0];
			if (!storeArg) return false;
			const name = resolveString(storeArg);
			return name !== null && ENCRYPTED_STORES_LITERAL.has(name);
		}

		return {
			CallExpression(node) {
				const callee = unwrap(node.callee);
				if (callee.type !== 'MemberExpression') return;
				const method = memberName(callee);
				if (method === null || !FORBIDDEN_WRITE_METHODS.has(method)) return;
				if (!isEncryptedStore(callee.object)) return;

				context.report({ node, messageId: 'writeUnsanctioned' });
			}
		};
	}
};
