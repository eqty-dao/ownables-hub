import { smart } from '@babel/template';
import type { PluginObj, NodePath } from '@babel/core';
import type { Statement, MemberExpression } from '@babel/types';

export interface PluginOptions {
  module?: 'CommonJS' | undefined;
}

/**
 * @see https://github.com/javiertury/babel-plugin-transform-import-meta
 *
 * Custom version to run in the vm sandbox.
 * Assumes that `pathToFileURL()` exists in the global scope, rather than doing
 * `require(url).pathToFileURL()`.
 *
 * Rewrites known `import.meta`[1] properties into equivalent non-module node.js
 * expressions. In order to maintain compatibility with plugins transforming
 * non-standard properties, this plugin transforms only known properties and
 * does not touch expressions with unknown or without member property access.
 * Properties known to this plugin:
 *
 * - `url`[2]
 *
 * [1]: https://github.com/tc39/proposal-import-meta
 * [2]: https://html.spec.whatwg.org/#hostgetimportmetaproperties
 */
export default function (): PluginObj {
  return {
    name: 'transform-import-meta',

    visitor: {
      Program(path, state) {
        const { module: target = 'CommonJS' } = (state.opts as PluginOptions | undefined) ?? {};
        if (target !== 'CommonJS') {
          throw new Error('Invalid target, must be "CommonJS"');
        }
        const metas: Array<NodePath<MemberExpression>> = [];
        const identifiers = new Set<string>();

        path.traverse({
          MemberExpression(memberExpPath) {
            const { node } = memberExpPath;

            if (
              node.object.type === 'MetaProperty' &&
              node.object.meta.name === 'import' &&
              node.object.property.name === 'meta' &&
              node.property.type === 'Identifier' &&
              node.property.name === 'url'
            ) {
              metas.push(memberExpPath);
              for (const name of Object.keys(memberExpPath.scope.getAllBindings())) {
                identifiers.add(name);
              }
            }
          },
        });

        if (metas.length === 0) {
          return;
        }

        const metaUrlReplacement = smart.ast`pathToFileURL(__filename).toString()` as Statement;

        for (const meta of metas) {
          meta.replaceWith(metaUrlReplacement);
        }
      },
    },
  };
}
