process.env.CHROME_BIN = require('puppeteer').executablePath();
const path = require('path');
const NodePolyfillPlugin = require('node-polyfill-webpack-plugin');

module.exports = function (config) {
  config.set({
    basePath: '',

    files: [{ pattern: 'test/**/*.test.ts', watched: false }],

    browsers: ['ChromeHeadless'],

    mime: {
      'text/x-typescript': ['ts', 'tsx'],
    },

    module: 'commonjs',

    singleRun: true,
    autoWatch: false,
    colors: true,

    frameworks: ['mocha', 'webpack'],

    reporters: ['mocha'],

    preprocessors: {
      '**/*!(.d).ts': ['webpack'],
    },

    plugins: [
      'karma-mocha',
      'karma-chrome-launcher',
      'karma-webpack',
      'karma-mocha-reporter',
    ],

    webpack: {
      mode: 'development',
      optimization: {
        splitChunks: false,
        runtimeChunk: false,
      },
      module: {
        rules: [
          {
            test: /\.ts$/,
            use: [
              {
                loader: 'ts-loader',
                options: {
                  transpileOnly: true,
                  configFile: 'tsconfig-test.json',
                },
              },
            ],
            exclude: /node_modules/,
          },
          {
            test: /\.css$/,
            use: [{ loader: 'style-loader' }, { loader: 'css-loader' }],
          },
          {
            test: /\.(woff(2)?|ttf|eot|png|jpe?g|svg)(\?v=\d+\.\d+\.\d+)?$/,
            include: path.resolve(__dirname, 'src'),
            use: [
              {
                loader: 'file-loader',
                options: {
                  name: '[name].[ext]',
                  outputPath: 'icons/',
                },
              },
              {
                loader: 'image-webpack-loader',
                options: {
                  disable: true,
                },
              },
            ],
          },
        ],
      },
      plugins: [new NodePolyfillPlugin()],

      resolve: {
        extensions: ['.tsx', '.ts', '.js', '.json'],
        symlinks: false,
        fallback: {
          net: false,
        },
      },
      target: 'web',
    },
  });
};
