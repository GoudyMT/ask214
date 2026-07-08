/**
 * Forbids echoing dynamic / user input into thrown Error messages. Error message
 * strings surface in logs, dev tools, and crash reports; interpolating user input
 * (e.g. an EAOS string) risks leaking PII. Throw a static message or an opaque
 * ErrorCode and keep dynamic context out of the message position.
 *
 * Flags `throw new <X>Error(<msg>)` (constructor name matching /Error$/) when
 * <msg> is a template literal with interpolation, a bare identifier, or a '+'
 * concatenation involving a non-literal.
 */
export default {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Forbid interpolating dynamic/user input into thrown Error messages (PII leak risk)'
		},
		messages: {
			noInterpolatedInput:
				'Do not interpolate dynamic input into a thrown Error message; use a static message or opaque code',
			noRawIdentifierInput:
				'Do not pass a variable directly as a thrown Error message; use a static message or opaque code',
			noConcatInput:
				'Do not concatenate dynamic input into a thrown Error message; use a static message or opaque code'
		},
		schema: []
	},
	create(context) {
		function isErrorConstructor(callee) {
			return callee.type === 'Identifier' && /Error$/.test(callee.name);
		}

		function hasNonLiteral(node) {
			if (node.type === 'BinaryExpression' && node.operator === '+') {
				return hasNonLiteral(node.left) || hasNonLiteral(node.right);
			}
			return node.type !== 'Literal';
		}

		return {
			ThrowStatement(node) {
				const arg = node.argument;
				if (!arg || arg.type !== 'NewExpression') return;
				if (!isErrorConstructor(arg.callee)) return;
				const msg = arg.arguments[0];
				if (!msg) return;

				if (msg.type === 'TemplateLiteral') {
					if (msg.expressions.length > 0) {
						context.report({ node: msg, messageId: 'noInterpolatedInput' });
					}
					return;
				}
				if (msg.type === 'Identifier') {
					context.report({ node: msg, messageId: 'noRawIdentifierInput' });
					return;
				}
				if (msg.type === 'BinaryExpression' && msg.operator === '+' && hasNonLiteral(msg)) {
					context.report({ node: msg, messageId: 'noConcatInput' });
				}
			}
		};
	}
};
