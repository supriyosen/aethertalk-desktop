# AetherTalk Desktop

Desktop build and packaging repo for `AetherTalk`.

The app name remains `AetherTalk`.

This repo contains:
- the Electron desktop shell
- the React UI
- the local Express backend
- the first-run setup flow for Codex readiness

Chats are saved only on the device running the app.

## Run the desktop app in development

```bash
npm run desktop:dev
```

## Build the Mac desktop app

```bash
npm install
npm run build:icons
npx electron-builder --mac dir
```

Output:

`dist/mac-arm64/AetherTalk.app`

## What the setup flow checks

- Codex installed
- Codex signed in
- local chat storage ready

## Browser-only local launch

This repo still contains the browser/local development path because the desktop app is built on top of the same frontend/backend.

If you need the browser flow during development:

```bash
npm run launch
```

## Local-only storage

Chats are saved locally in:

`data/chats.json`

There is no cloud database in this project.
