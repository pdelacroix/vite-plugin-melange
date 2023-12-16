import pkg from './package.json';

export default {
  input: 'src/index.js',
  external: Object.keys(pkg.dependencies),
  output: [
    { format: 'cjs', file: pkg.exports.require, exports: 'auto' },
    { format: 'esm', file: pkg.exports.import }
  ]
};
