const path = require('path');

module.exports = {
  mode: 'production',
  entry: {
    index: './src/index.ts',
  },
  module: {
    rules: [
      {
        test: /\.ts?$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
  resolve: {
    extensions: ['.ts', '.js'],
    symlinks: false,
    fallback: {
      net: false,
    },
  },
  target: 'electron-renderer',
  output: {
    filename: '[name].js',
    path: path.resolve(__dirname, 'lib'),
    library: 'lsp-codemirror',
    libraryTarget: 'umd',
  },
  externals: {
    codemirror: {
      commonjs: 'codemirror',
      commonjs2: 'codemirror',
      amd: 'codemirror',
      root: 'CodeMirror',
    },
  },
};
