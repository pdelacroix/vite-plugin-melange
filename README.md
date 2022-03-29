# vite-plugin-melange

A Vite plugin for Melange.

## Usage

```bash
npm install --save-dev vite-plugin-melange
```

`vite.config.js`:
```javascript
import melangePlugin from 'vite-plugin-melange'

export default {
  plugins: [
        melangePlugin(),
    ]
}
```

## Build

```bash
npm install
npx rollup -c
```
