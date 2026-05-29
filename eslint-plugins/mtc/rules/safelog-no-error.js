/**
 * Forbids passing Error objects or properties (.message, .stack, .name) into
 * safeLog argument positions. Tests cannot leak via toString or property
 * access; only opaque error codes + scalar/boolean/code-enum fields allowed.
 *
 * Source: Phase 2 spec section 11 "No PII in logs"; ADR-004 amendment
 * "error sanitization with opaque codes".
 */
export default {
	meta: {
		type: 'problem',
		docs: {
			description: 'Forbid Error objects / properties as arguments to safeLog (PII leak risk)'
		},
		messages: {
			noErrorArg: 'safeLog must not be called with an Error or unknown argument',
			noErrorInFields: 'safeLog fields must not contain identifiers that may resolve to Error',
			noErrorMessageInFields:
				'safeLog fields must not include Error properties (.message/.stack/.name)',
			noErrorPropertyInCode:
				'safeLog code field must be a literal ErrorCode, not a dynamic property access'
		},
		schema: []
	},
	create(context) {
		const ERROR_LIKE_NAMES = /^(error|err|e|exception|ex|cause)$/i;
		const ERROR_PROP_NAMES = new Set(['message', 'stack', 'name', 'cause']);

		function isMemberFromErrorLike(node) {
			return (
				node.type === 'MemberExpression' &&
				node.object.type === 'Identifier' &&
				ERROR_LIKE_NAMES.test(node.object.name) &&
				node.property.type === 'Identifier' &&
				ERROR_PROP_NAMES.has(node.property.name)
			);
		}

		function checkObjectExpression(objExpr) {
			for (const prop of objExpr.properties) {
				if (prop.type !== 'Property') continue;
				const key = prop.key.type === 'Identifier' ? prop.key.name : prop.key.value;

				if (key === 'code') {
					if (prop.value.type === 'MemberExpression') {
						context.report({ node: prop, messageId: 'noErrorPropertyInCode' });
					}
				}

				if (key === 'fields' && prop.value.type === 'ObjectExpression') {
					for (const fieldProp of prop.value.properties) {
						if (fieldProp.type !== 'Property') continue;
						const v = fieldProp.value;
						if (isMemberFromErrorLike(v)) {
							context.report({
								node: fieldProp,
								messageId: 'noErrorMessageInFields'
							});
							continue;
						}
						if (v.type === 'Identifier' && ERROR_LIKE_NAMES.test(v.name)) {
							context.report({
								node: fieldProp,
								messageId: 'noErrorInFields'
							});
						}
					}
				}
			}
		}

		return {
			CallExpression(node) {
				if (node.callee.type !== 'Identifier' || node.callee.name !== 'safeLog') {
					return;
				}
				const arg = node.arguments[0];
				if (!arg) return;
				if (arg.type === 'Identifier' && ERROR_LIKE_NAMES.test(arg.name)) {
					context.report({ node, messageId: 'noErrorArg' });
					return;
				}
				if (arg.type === 'ObjectExpression') {
					checkObjectExpression(arg);
				}
			}
		};
	}
};
