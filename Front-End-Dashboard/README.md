# SmartFlow NLEX Dashboard

A dashboard that runs as a localhost website during development and as an external Electron app for desktop use.

## Development

1. Install dependencies.
2. Run `npm run dev`.
3. Open `http://localhost:3000` in your browser if you want the website view.
4. The Electron app also opens automatically once the dev server is ready.

## Desktop build

1. Run `npm run dist` to build the static site and create a Windows installer in `dist/`.
2. Run `npm run start` to open the packaged Electron app after building.
