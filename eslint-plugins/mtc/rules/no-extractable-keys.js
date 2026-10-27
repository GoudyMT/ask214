/**
 * Forbids creating an extractable key. A key made with `extractable: true` can be read out as raw bytes by any code
 * running in the page, so app code asks for non-extractable keys only.
 *
 * Checks `<anything>.generateKey / importKey / deriveKey / unwrapKey(...)` (including `subtle['importKey']`) and reads
 * the `extractable` argument by its position. Only the literal `false` passes: `true` is refused, and so is anything
 * the rule cannot see through (a variable, an expression, a missing argument, a spread), so `true` cannot be passed
 * through a variable. An unrelated `.generateKey(...)` with another shape is reported on purpose; a call that is not
 * about keys should not carry that method name in app code.
 */

// The rotation to a new PIN makes the new keys extractable for an instant, wraps them under the PIN key at once and
// keeps only non-extractable copies. It is the one place an extractable key is made.
const ALLOWED_FUNCTION = 'rotateToPin';
const ALLOWED_FILE = 'src/lib/keystore/rotate.ts';

// The index of the `extractable` argument in each method.
const EXTRACTABLE_INDEX = {
	generateKey: 1,
	importKey: 3,
	deriveKey: 3,
	unwrapKey: 5
};

function methodName(callee) {
	if (callee.type !== 'MemberExpression') return null;
	const { property } = callee;
	if (!callee.computed && property.type === 'Identifier') return property.name;
	if (callee.computed && property.type === 'Literal' && typeof property.value === 'string') {
		return property.value;
	}
	return null;
}

function isFunctionNode(node) {
	return (
		node.type === 'FunctionDeclaration' ||
		node.type === 'FunctionExpression' ||
		node.type === 'ArrowFunctionExpression'
	);
}

function insideAllowedFunction(ancestors) {
	return ancestors.some(
		(node) =>
			(node.type === 'FunctionDeclaration' && node.id?.name === ALLOWED_FUNCTION) ||
			(node.type === 'VariableDeclarator' &&
				node.id.type === 'Identifier' &&
				node.id.name === ALLOWED_FUNCTION &&
				node.init !== null &&
				isFunctionNode(node.init))
	);
}

export default {
	meta: {
		type: 'problem',
		docs: {
			description: 'Forbid creating extractable keys outside the PIN rotation'
		},
		messages: {
			extractableTrue:
				'Do not create an extractable key: any code in the page could read its bytes. Pass false.',
			extractableUnproven:
				'The extractable argument must be the literal false so it can be checked; a variable or a missing value could be true.'
		},
		schema: []
	},
	create(context) {
		const { sourceCode } = context;
		const inAllowedFile = context.filename.replaceAll('\\', '/').endsWith(ALLOWED_FILE);

		return {
			CallExpression(node) {
				const name = methodName(node.callee);
				if (name === null || !Object.hasOwn(EXTRACTABLE_INDEX, name)) return;
				if (inAllowedFile && insideAllowedFunction(sourceCode.getAncestors(node))) return;

				const index = EXTRACTABLE_INDEX[name];
				const spread = node.arguments.slice(0, index + 1).some((a) => a.type === 'SpreadElement');
				const arg = node.arguments[index];
				if (spread || arg === undefined) {
					context.report({ node, messageId: 'extractableUnproven' });
				} else if (arg.type === 'Literal' && arg.value === true) {
					context.report({ node: arg, messageId: 'extractableTrue' });
				} else if (!(arg.type === 'Literal' && arg.value === false)) {
					context.report({ node: arg, messageId: 'extractableUnproven' });
				}
			}
		};
	}
};
