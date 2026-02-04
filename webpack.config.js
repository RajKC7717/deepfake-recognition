const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = {
  mode: 'development', // Change to 'production' when publishing
  devtool: 'inline-source-map', // Helps debugging
  
  entry: {
    // Each entry point becomes a separate JS file
    'background': './src/background/service-worker.ts',
    'content-script': './src/content/content-script.ts',
    'popup': './src/popup/popup.tsx',
    'offscreen': './src/offscreen/offscreen.ts'
  },
  
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js', // Creates background.js, popup.js, etc.
    clean: true // Cleans dist folder before each build
  },
  
  module: {
    rules: [
      {
        test: /\.tsx?$/, // Process .ts and .tsx files
        use: 'ts-loader',
        exclude: /node_modules/
      }
    ]
  },
  
  resolve: {
    extensions: ['.tsx', '.ts', '.js']
  },
  
  plugins: [
    new CopyPlugin({
      patterns: [
        { from: 'public', to: '.' }, // Copy everything from public to dist
        { from: 'src/popup/popup.html', to: 'popup.html' },
        { from: 'src/offscreen/offscreen.html', to: 'offscreen.html' }
      ]
    })
  ]
};